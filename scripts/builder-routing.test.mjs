import test from "node:test";
import assert from "node:assert/strict";
import {
  builderRoute,
  builderRoutingRows,
  checkCodexQuota,
  CLAUDE_FALLBACK_MODEL,
  codexQuotaDecision,
  checkProviderQuotas,
  DEFAULT_TIERS,
  routingTiers,
  tierDispatch,
} from "./builder-routing.mjs";
import { renderPrBody } from "./pr.mjs";
import { loadConfig } from "./lib.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = { preferredBackend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", reason: "bounded edit" };
const CLAUDE = { preferredBackend: "claude", model: "claude-opus-5-5", reasoningEffort: null, reason: "default" };

test("no assignment means no route: the lane launches exactly as before routing", () => {
  assert.equal(builderRoute(null), null);
  assert.equal(builderRoute(undefined, { fallbackReason: "anything" }), null);
});

test("a Codex assignment routes to Codex with its model and effort, a Claude one to Claude", () => {
  assert.deepEqual(builderRoute(CODEX), { backend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", reason: "bounded edit", fallback: false });
  assert.deepEqual(builderRoute(CLAUDE), { backend: "claude", model: "claude-opus-5-5", reasoningEffort: null, reason: "default", fallback: false });
});

test("a fallback reason sends a Codex assignment to Claude Opus and says why; a Claude assignment ignores it", () => {
  const route = builderRoute(CODEX, { fallbackReason: "quota-axi timed out" });
  assert.equal(route.backend, "claude");
  assert.equal(route.model, CLAUDE_FALLBACK_MODEL);
  assert.equal(route.reason, "quota-axi timed out");
  assert.equal(route.fallback, true);
  assert.equal(builderRoute(CLAUDE, { fallbackReason: "x" }).fallback, false);
});

test("routing rows cover assigned tasks and tasks with attempts, and report the latest actual model", () => {
  const rows = builderRoutingRows({
    builderRouting: { assignments: { 1: CODEX } },
    tasks: {
      1: { builderRuns: [
        { attempt: 1, backend: "codex", model: "gpt-5.6-luna", reason: "bounded edit", outcome: "rate_limited" },
        { attempt: 2, backend: "claude", model: "claude-opus-5-5", reason: "Codex reported its usage limit exhausted; retried on Claude Opus", outcome: null },
      ] },
      2: { builderRuns: [{ attempt: 1, backend: "claude", model: "claude-opus-5-5", reason: null, outcome: "failed" }] },
      3: { lifecycle: "pending" },
    },
  });
  const untiered = { tier: null, answers: null, jevModel: null, routerSkipped: null };
  assert.deepEqual(rows, [
    { task: "1", preferred: "codex/gpt-5.6-luna", actual: "claude/claude-opus-5-5", reason: "Codex reported its usage limit exhausted; retried on Claude Opus", ...untiered },
    { task: "2", preferred: "-", actual: "claude/claude-opus-5-5", reason: "-", ...untiered },
  ]);
});

const quota = (percent = 42) => JSON.stringify({
  schemaVersion: 5,
  providers: [{
    provider: "codex",
    state: { status: "fresh", stale: false },
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: percent }],
    },
  }],
});

test("Codex quota accepts only fresh schema-5 all-model availability above zero", () => {
  assert.equal(codexQuotaDecision(quota(12)).allowed, true);
  assert.match(codexQuotaDecision(quota(0)).reason, /exhausted/);
  assert.match(codexQuotaDecision("not json").reason, /malformed JSON/);
  const stale = JSON.parse(quota()); stale.providers[0].state.stale = true;
  assert.match(codexQuotaDecision(JSON.stringify(stale)).reason, /stale/);
  const unknown = JSON.parse(quota()); unknown.providers[0].quotaSemantics.status = "unknown";
  assert.match(codexQuotaDecision(JSON.stringify(unknown)).reason, /semantics are unknown/);
  const noProvider = JSON.parse(quota()); noProvider.providers = [];
  assert.match(codexQuotaDecision(JSON.stringify(noProvider)).reason, /no Codex provider/);
  const noScope = JSON.parse(quota()); noScope.providers[0].quotaSemantics.effectiveAvailability = [];
  assert.match(codexQuotaDecision(JSON.stringify(noScope)).reason, /scope is missing/);
  const badSchema = JSON.parse(quota()); badSchema.schemaVersion = 4;
  assert.match(codexQuotaDecision(JSON.stringify(badSchema)).reason, /unsupported/);
  const nonNumeric = JSON.parse(quota()); nonNumeric.providers[0].quotaSemantics.effectiveAvailability[0].effectivePercentRemaining = "12";
  assert.match(codexQuotaDecision(JSON.stringify(nonNumeric)).reason, /not numeric/);
});

test("quota execution is asynchronous, bounded and fails toward Claude", async () => {
  let command;
  let options;
  const positive = await checkCodexQuota({ exec: async (cmd, opts) => {
    command = cmd; options = opts; return { status: 0, stdout: quota(8) };
  } });
  assert.equal(positive.allowed, true);
  assert.equal(command, "quota-axi --provider codex --json --no-credential-refresh");
  assert.equal(options.timeout, 20_000);
  assert.match((await checkCodexQuota({ exec: async () => ({ status: null, timedOut: true }) })).reason, /timed out/);
  assert.match((await checkCodexQuota({ exec: async () => ({ status: 127, stdout: "" }) })).reason, /exited 127/);
});

// --- #294: tiers ------------------------------------------------------------

test("no routing.tiers means the defaults: Opus for critical, Sonnet or Codex gpt-6.1-sol at medium for routine", () => {
  assert.equal(routingTiers({}), DEFAULT_TIERS);
  assert.equal(routingTiers({ routing: {} }), DEFAULT_TIERS);
  assert.deepEqual(DEFAULT_TIERS.critical, [{ backend: "claude", model: "claude-opus-5-5", reasoningEffort: null }]);
  assert.deepEqual(DEFAULT_TIERS.routine, [
    { backend: "claude", model: "claude-sonnet-5-5", reasoningEffort: null },
    { backend: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
  ]);
});

test("routing.tiers overrides one tier and keeps the other; YAML's string spelling and a mapping both load", () => {
  const tiers = routingTiers({ routing: { tiers: { routine: ["codex/gpt-6.2-sol@high", { backend: "claude", model: "claude-haiku-5-5" }] } } });
  assert.deepEqual(tiers.routine, [
    { backend: "codex", model: "gpt-6.2-sol", reasoningEffort: "high" },
    { backend: "claude", model: "claude-haiku-5-5", reasoningEffort: null },
  ]);
  assert.equal(tiers.critical, DEFAULT_TIERS.critical);
});

test("a malformed routing.tiers is refused, naming the entry", () => {
  assert.throws(() => routingTiers({ routing: { tiers: { fast: [] } } }), /unknown tier\(s\) fast/);
  assert.throws(() => routingTiers({ routing: { tiers: { routine: [] } } }), /non-empty list/);
  assert.throws(() => routingTiers({ routing: { tiers: { routine: ["gemini/x"] } } }), /routine\[0\]\.backend/);
  assert.throws(() => routingTiers({ routing: { tiers: { routine: ["codex/claude-opus-5-5"] } } }), /Codex model name/);
  assert.throws(() => routingTiers({ routing: { tier: {} } }), /unknown key\(s\) tier/);
});

const read = (claude, codex) => ({
  claude: claude === null ? { allowed: false, reason: "Claude quota is exhausted" } : { allowed: true, percent: claude },
  codex: codex === null ? { allowed: false, reason: "Codex quota state is stale or not fresh" } : { allowed: true, percent: codex },
});

test("a routine dispatch takes the provider with more quota; neither available runs on critical", () => {
  assert.deepEqual(tierDispatch("routine", DEFAULT_TIERS, { quota: read(30, 70) }), {
    tier: "routine", preferredBackend: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium", reason: "routine: codex has the most quota (70%)",
  });
  assert.equal(tierDispatch("routine", DEFAULT_TIERS, { quota: read(80, 70) }).model, "claude-sonnet-5-5");
  assert.equal(tierDispatch("routine", DEFAULT_TIERS, { quota: read(50, 50) }).model, "claude-sonnet-5-5", "a tie goes to list order");
  assert.equal(tierDispatch("routine", DEFAULT_TIERS, { quota: read(null, 10) }).model, "gpt-6.1-sol");
  const none = tierDispatch("routine", DEFAULT_TIERS, { quota: read(null, null) });
  assert.equal(none.tier, "critical");
  assert.equal(none.model, "claude-opus-5-5");
  assert.match(none.reason, /no provider has quota .*claude: Claude quota is exhausted.*codex: Codex quota state is stale/);
  assert.equal(tierDispatch("routine", DEFAULT_TIERS, { quota: read(90, 90), escalate: "retry" }).model, "claude-opus-5-5");
  assert.equal(tierDispatch("critical", DEFAULT_TIERS, { quota: read(90, 90) }).model, "claude-opus-5-5");
});

const both = (claude, codex) => JSON.stringify({
  schemaVersion: 5,
  providers: [["claude", claude], ["codex", codex]].map(([provider, percent]) => ({
    provider,
    state: { status: "fresh", stale: percent === "stale" },
    quotaSemantics: {
      status: percent === "unknown" ? "unknown" : "known",
      effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: typeof percent === "number" ? percent : 50 }],
    },
  })),
});

test("one quota read covers both providers; a stale or unknown provider is no quota", async () => {
  let command;
  const quota = await checkProviderQuotas({ exec: async (cmd) => { command = cmd; return { status: 0, stdout: both(20, 60) }; } });
  assert.equal(command, "quota-axi --provider claude,codex --json --no-credential-refresh");
  assert.deepEqual([quota.claude.percent, quota.codex.percent], [20, 60]);
  const stale = await checkProviderQuotas({ exec: async () => ({ status: 0, stdout: both("stale", "unknown") }) });
  assert.match(stale.claude.reason, /Claude quota state is stale/);
  assert.match(stale.codex.reason, /Codex quota semantics are unknown/);
  const failed = await checkProviderQuotas({ exec: async () => { throw new Error("ENOENT"); } });
  assert.equal(failed.claude.allowed || failed.codex.allowed, false);
});

test("the epic PR body's task table shows tier, actual model, the deciding Jev answers and Score confidence", () => {
  const answers = { sensitive: 0.92, format: 0.1, shared_interface: 0.1, unknown_cause: 0.1, pattern_named: 0.9, concrete_criteria: 0.9, scope: 1, scopeConfidence: 0.81 };
  const body = renderPrBody({
    epic: { id: "500", title: "Routing" },
    dag: { tasks: [
      { id: "501", title: "risky", dependsOn: [] },
      { id: "502", title: "easy", dependsOn: [] },
      { id: "503", title: "unrouted", dependsOn: [] },
    ] },
    state: {
      builderRouting: { assignments: {
        501: { tier: "critical", reason: "critical: …", routerSkipped: null, jev: { model: "jev-1.14.2", answers, deciding: ["sensitive"] } },
        502: { tier: "routine", reason: "routine: …", routerSkipped: null, jev: { model: "jev-1.14.2", answers: { ...answers, sensitive: 0.1 }, deciding: ["pattern_named", "concrete_criteria"] } },
        503: { tier: "critical", reason: "router skipped: Jev answered 429 (rate limited)", routerSkipped: "Jev answered 429 (rate limited)", jev: null },
      } },
      tasks: {
        501: { lifecycle: "passed", builderRuns: [{ attempt: 1, backend: "claude", model: "claude-opus-5-5", tier: "critical", outcome: "ready_to_integrate" }] },
        502: { lifecycle: "passed", builderRuns: [{ attempt: 1, backend: "codex", model: "gpt-6.1-sol", tier: "routine", outcome: "ready_to_integrate" }] },
      },
    },
    renderedAt: "2026-10-26T00:00:00Z",
  });
  assert.match(body, /\| ID \| Task \| Status \| Dependencies \| Tier \| Model \| Jev answers \|/);
  assert.match(body, /\| 501 \| risky \| passed \| - \| critical \| claude\/claude-opus-5-5 \| sensitive 0\.92, scope 1 \(confidence 0\.81\) \|/);
  assert.match(body, /\| 502 \| easy \| passed \| - \| routine \| codex\/gpt-6\.1-sol \| pattern_named 0\.90, concrete_criteria 0\.90, scope 1 \(confidence 0\.81\) \|/);
  assert.match(body, /\| 503 \| unrouted \| pending \| - \| critical \| - \| router skipped: Jev answered 429 \(rate limited\) \|/);
});

test("a run the router never touched keeps the four-column table", () => {
  const body = renderPrBody({ dag: { tasks: [{ id: "1", title: "t", dependsOn: [] }] }, state: { tasks: {} }, renderedAt: "x" });
  assert.match(body, /\| ID \| Task \| Status \| Dependencies \|\n/);
  assert.doesNotMatch(body, /Jev answers/);
});

test("the config loader accepts routing.tiers in .afk-setup/config.yaml", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-routing-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".afk-setup"));
  writeFileSync(join(dir, ".afk-setup", "config.yaml"), [
    "defaultChecks:",
    "  - npm test",
    "routing:",
    "  tiers:",
    "    routine:",
    "      - codex/gpt-6.1-sol@low",
    "",
  ].join("\n"));
  const tiers = routingTiers(loadConfig(dir));
  assert.deepEqual(tiers.routine, [{ backend: "codex", model: "gpt-6.1-sol", reasoningEffort: "low" }]);
  assert.equal(tiers.critical, DEFAULT_TIERS.critical);
});
