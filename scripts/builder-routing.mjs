// Per-task builder routing (#292). A task's lane runs on Claude or on Codex,
// chosen from `state.builderRouting.assignments[<id>]` in `.afk/state.json`.
// Every other role stays on Claude. This module only decides and describes;
// `auto.mjs` dispatches, and `worker.mjs` runs the lane.
//
// An assignment is
//   { preferredBackend: "claude" | "codex", model, reasoningEffort, reason }
// and a task with no assignment builds exactly as it did before routing
// existed: on the backend the executable selected, at the role's own tier.
import { BACKENDS, codexModel, codexReasoningEffort, runAsync } from "./lib.mjs";
import { describeAnswers } from "./tier-router.mjs";

export const QUOTA_TIMEOUT_MS = 20_000;

// What a Codex lane falls back to when its quota read fails, when it reports
// exhaustion, or when its login is gone. Named, not read from the role tier,
// because the fallback is a promise to the operator ("retried on Opus").
export const CLAUDE_FALLBACK_MODEL = "claude-opus-5-5";

// What each tier the router (scripts/tier-router.mjs) decides builds on.
// `critical` is its first entry; `routine` is whichever entry's provider has
// the most `all_models` quota left when the lane starts, list order breaking a
// tie. `.afk-setup/config.yaml` replaces either list under `routing.tiers`.
// Named here, not read from quota-axi's model catalog: at 0.1.67 that still
// lists 4.5-era models.
export const DEFAULT_TIERS = {
  critical: [{ backend: "claude", model: "claude-opus-5-5", reasoningEffort: null }],
  routine: [
    { backend: "claude", model: "claude-sonnet-5-5", reasoningEffort: null },
    { backend: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
  ],
};
export const TIERS = ["critical", "routine"];

// `codex/gpt-6.1-sol@medium`: the one spelling of a tier entry the config's
// YAML subset can carry, since it refuses a mapping inside a list.
const ENTRY_RE = /^([a-z]+)\/([^@\s]+)(?:@([a-z]+))?$/;

const tierEntry = (raw, where) => {
  let entry = raw;
  if (typeof raw === "string") {
    const match = ENTRY_RE.exec(raw.trim());
    if (!match) throw new Error(`${where} must be \`backend/model\` or \`backend/model@effort\`; got ${JSON.stringify(raw)}.`);
    entry = { backend: match[1], model: match[2], reasoningEffort: match[3] ?? null };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(`${where} must be a mapping of backend, model and reasoningEffort; got ${JSON.stringify(raw)}.`);
  const unknown = Object.keys(entry).filter((key) => !["backend", "model", "reasoningEffort"].includes(key));
  if (unknown.length) throw new Error(`${where} has unknown key(s) ${unknown.join(", ")} (allowed: backend, model, reasoningEffort).`);
  if (!BACKENDS.includes(entry.backend))
    throw new Error(`${where}.backend must be one of ${BACKENDS.join(", ")}; got ${JSON.stringify(entry.backend)}.`);
  if (typeof entry.model !== "string" || entry.model.trim() === "")
    throw new Error(`${where}.model must be a model name; got ${JSON.stringify(entry.model)}.`);
  const effort = entry.reasoningEffort ?? null;
  if (entry.backend === "codex") {
    codexModel(entry.model, `${where}.model`);
    if (effort !== null) codexReasoningEffort(effort, `${where}.reasoningEffort`);
  } else if (effort !== null && typeof effort !== "string") {
    throw new Error(`${where}.reasoningEffort must be a string; got ${JSON.stringify(effort)}.`);
  }
  return { backend: entry.backend, model: entry.model, reasoningEffort: effort };
};

/**
 * The tiers in force: `routing.tiers` from the config over `DEFAULT_TIERS`,
 * tier by tier. An absent key means the defaults. A malformed one throws,
 * naming the entry, because a typo read as "use the defaults" would quietly
 * route a whole epic to models the operator turned off.
 */
export const routingTiers = (config = {}) => {
  const routing = config?.routing;
  if (routing === undefined || routing === null) return DEFAULT_TIERS;
  const where = ".afk-setup/config.yaml `routing`";
  if (typeof routing !== "object" || Array.isArray(routing)) throw new Error(`${where} must be a mapping.`);
  const unknown = Object.keys(routing).filter((key) => key !== "tiers");
  if (unknown.length) throw new Error(`${where} has unknown key(s) ${unknown.join(", ")} (allowed: tiers).`);
  const tiers = routing.tiers;
  if (tiers === undefined || tiers === null) return DEFAULT_TIERS;
  if (typeof tiers !== "object" || Array.isArray(tiers)) throw new Error(`${where}.tiers must be a mapping of ${TIERS.join(", ")}.`);
  const extra = Object.keys(tiers).filter((key) => !TIERS.includes(key));
  if (extra.length) throw new Error(`${where}.tiers has unknown tier(s) ${extra.join(", ")} (allowed: ${TIERS.join(", ")}).`);
  const out = { ...DEFAULT_TIERS };
  for (const tier of TIERS) {
    if (tiers[tier] === undefined) continue;
    if (!Array.isArray(tiers[tier]) || !tiers[tier].length)
      throw new Error(`${where}.tiers.${tier} must be a non-empty list of entries.`);
    out[tier] = tiers[tier].map((entry, index) => tierEntry(entry, `${where}.tiers.${tier}[${index}]`));
  }
  return out;
};

const fromEntry = (tier, entry, reason) => ({
  tier,
  preferredBackend: entry.backend,
  model: entry.model,
  reasoningEffort: entry.reasoningEffort ?? null,
  reason,
});

/**
 * The concrete assignment for one dispatch of a tiered task. `quota` is the
 * per-provider read (`checkProviderQuotas`), needed only for `routine`.
 * `escalate` names why this dispatch runs on `critical` whatever the tier: a
 * routine task's retry always does, never the other way.
 */
export const tierDispatch = (tier, tiers = DEFAULT_TIERS, { quota = null, escalate = null } = {}) => {
  const critical = tiers.critical[0];
  if (tier !== "routine") return fromEntry("critical", critical, "critical tier");
  if (escalate) return fromEntry("critical", critical, escalate);
  let best = null;
  for (const entry of tiers.routine) {
    const read = quota?.[entry.backend];
    if (!read?.allowed) continue;
    if (!best || read.percent > best.percent) best = { entry, percent: read.percent };
  }
  if (!best) {
    const why = [...new Set(tiers.routine.map((entry) => entry.backend))]
      .map((backend) => `${backend}: ${quota?.[backend]?.reason ?? "not read"}`).join("; ");
    return fromEntry("critical", critical, `routine, but no provider has quota (${why}); ran on critical`);
  }
  return fromEntry("routine", best.entry, `routine: ${best.entry.backend} has the most quota (${best.percent}%)`);
};

/**
 * The route for ONE builder dispatch, or null when the task has no assignment
 * (the caller then launches exactly as on main).
 *
 * `fallbackReason` is why this dispatch may not use Codex: a failed quota read
 * (this dispatch only) or a Codex lane failure recorded on the task
 * (`taskRuntime.codexFallbackReason`, this task only). Neither is run-wide.
 */
export const builderRoute = (assignment, { fallbackReason = null } = {}) => {
  if (!assignment) return null;
  if (assignment.preferredBackend === "codex" && fallbackReason)
    return { backend: "claude", model: CLAUDE_FALLBACK_MODEL, reasoningEffort: null, reason: fallbackReason, fallback: true };
  return {
    backend: assignment.preferredBackend === "codex" ? "codex" : "claude",
    model: assignment.model ?? null,
    reasoningEffort: assignment.reasoningEffort ?? null,
    reason: assignment.reason ?? null,
    fallback: false,
  };
};

/**
 * One `afk status` row: what the task was routed to, what its latest builder
 * attempt actually ran on, and why. `builderRuns` is the per-attempt record
 * `auto.mjs` keeps; an attempt still running has no outcome yet but is listed.
 */
export const builderRoutingRow = (id, assignment, runtime = {}, { skipped = null } = {}) => {
  const last = (runtime.builderRuns ?? []).at(-1) ?? null;
  // A tiered assignment names no backend until its lane starts; before that
  // its preferred column is the tier itself.
  const preferred = !assignment ? "-"
    : assignment.preferredBackend ? `${assignment.preferredBackend}/${assignment.model ?? "default"}`
    : `${assignment.tier ?? "claude"} tier`;
  const routerSkipped = assignment?.routerSkipped ?? (!assignment && skipped ? skipped : null);
  return {
    task: id,
    preferred,
    actual: last ? `${last.backend ?? "?"}/${last.model ?? "unknown"}` : "-",
    reason: last?.reason ?? assignment?.reason ?? "-",
    // A run with no key wrote no assignment; its lanes ran as `critical` does.
    tier: assignment?.tier ?? (skipped ? "critical" : null),
    answers: assignment?.jev ? describeAnswers(assignment.jev.answers, assignment.jev.deciding) : null,
    jevModel: assignment?.jev?.model ?? null,
    routerSkipped,
  };
};

export const builderRoutingRows = (state = {}) => {
  const assignments = state.builderRouting?.assignments ?? {};
  const skipped = state.builderRouting?.skipped?.reason ?? null;
  const ids = [...new Set([...Object.keys(state.tasks ?? {}), ...Object.keys(assignments)])];
  return ids
    .filter((id) => assignments[id] || state.tasks?.[id]?.builderRuns?.length)
    .map((id) => builderRoutingRow(id, assignments[id] ?? null, state.tasks?.[id] ?? {}, { skipped }));
};

const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" };

/**
 * One provider's verdict out of a quota-axi payload. A read that is stale,
 * has unknown semantics or no numeric `all_models` percent is no quota.
 */
export const providerQuotaDecision = (text, name) => {
  const label = PROVIDER_LABEL[name] ?? name;
  let payload;
  try { payload = JSON.parse(String(text ?? "")); }
  catch { return { allowed: false, reason: "quota-axi returned malformed JSON" }; }
  if (payload?.schemaVersion !== 5)
    return { allowed: false, reason: `quota-axi schema ${payload?.schemaVersion ?? "missing"} is unsupported` };
  const provider = payload.providers?.find?.((entry) => entry?.provider === name);
  if (!provider) return { allowed: false, reason: `quota-axi returned no ${label} provider` };
  if (provider.state?.status !== "fresh" || provider.state?.stale !== false)
    return { allowed: false, reason: `${label} quota state is stale or not fresh` };
  if (provider.quotaSemantics?.status !== "known")
    return { allowed: false, reason: `${label} quota semantics are unknown` };
  const availability = provider.quotaSemantics?.effectiveAvailability
    ?.find?.((entry) => entry?.scope === "all_models");
  if (!availability) return { allowed: false, reason: `${label} all_models quota scope is missing` };
  if (availability.status !== "known")
    return { allowed: false, reason: `${label} all_models availability is unknown` };
  if (!Number.isFinite(availability.effectivePercentRemaining))
    return { allowed: false, reason: `${label} effectivePercentRemaining is not numeric` };
  if (availability.effectivePercentRemaining <= 0)
    return { allowed: false, reason: `${label} quota is exhausted` };
  return {
    allowed: true,
    percent: availability.effectivePercentRemaining,
    reason: `${label} quota is fresh with ${availability.effectivePercentRemaining}% effective availability`,
  };
};

export const codexQuotaDecision = (text) => providerQuotaDecision(text, "codex");

/**
 * One bounded, asynchronous quota read. FAIL DIRECTION: toward Claude, for the
 * one dispatch that asked. A read that cannot run, times out or is malformed
 * says nothing about the next lane, which reads again.
 */
export const checkCodexQuota = async ({ exec = runAsync } = {}) => {
  let result;
  try {
    result = await exec("quota-axi --provider codex --json --no-credential-refresh", {
      timeout: QUOTA_TIMEOUT_MS,
    });
  } catch (error) {
    return { allowed: false, reason: `quota-axi could not run: ${error.message}` };
  }
  if (result?.timedOut) return { allowed: false, reason: "quota-axi timed out after 20 seconds" };
  if (result?.status !== 0)
    return { allowed: false, reason: `quota-axi exited ${result?.status ?? "without a status"}` };
  return codexQuotaDecision(result.stdout);
};

export const PROVIDER_QUOTA_COMMAND = "quota-axi --provider claude,codex --json --no-credential-refresh";

/**
 * Both providers' quota in one bounded read, for a `routine` lane choosing
 * between them. FAIL DIRECTION: a read that cannot run, times out or is
 * malformed is no quota for either, and the lane runs on `critical`.
 */
export const checkProviderQuotas = async ({ exec = runAsync } = {}) => {
  const both = (reason) => ({ claude: { allowed: false, reason }, codex: { allowed: false, reason } });
  let result;
  try {
    result = await exec(PROVIDER_QUOTA_COMMAND, { timeout: QUOTA_TIMEOUT_MS });
  } catch (error) {
    return both(`quota-axi could not run: ${error.message}`);
  }
  if (result?.timedOut) return both("quota-axi timed out after 20 seconds");
  if (result?.status !== 0) return both(`quota-axi exited ${result?.status ?? "without a status"}`);
  return {
    claude: providerQuotaDecision(result.stdout, "claude"),
    codex: providerQuotaDecision(result.stdout, "codex"),
  };
};
