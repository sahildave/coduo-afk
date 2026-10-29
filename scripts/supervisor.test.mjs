// scripts/supervisor.test.mjs — judgment at the events, and none of the loop.
//
// **No test in this file reaches a model, `gh`, or `herdr`.** Four layers:
//
//   1. the pure functions (evidence, prior, parsing, merge, action rendering)
//      take plain objects and return values, and touch no process at all;
//   2. `runSupervisor` takes its agent spawn as an injected `runAgent`, so every
//      test here supplies its own and the real `claude` is never built into a
//      command line, let alone executed;
//   3. the tests that must NOT spawn assert it by handing in a `runAgent` that
//      fails the test if it is ever called;
//   4. one end-to-end test puts a fake `claude` on PATH ahead of anything real,
//      in a throwaway directory, and a `gh` and a `herdr` that exit non-zero, so
//      any call to either would fail the test loudly rather than reach a network.
//
// The two properties most worth holding are the authority split — it proposes
// `afk` commands and cannot express a lifecycle transition — and the fallback:
// a supervisor that is down, slow or unauthenticated costs the run nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, roleFor, settingsArg, skillDenyRules } from "./roles.mjs";
import { CHECK_TIMEOUT_EXIT_CODE } from "./lib.mjs";
import {
  CLASSIFICATIONS,
  RECOMMENDATIONS,
  SUPERVISOR_ACTIONS,
  SUPERVISOR_DECISION_VERSION,
  SUPERVISOR_EVENTS,
  eventSignature,
  lastJsonBlock,
  mergeDecision,
  normalizeDecision,
  onEpicEnded,
  onGateReached,
  onHumanAsked,
  onIntegrationFailed,
  onLaneBlocked,
  onLaneFailed,
  parseSupervisorOutput,
  renderSupervisorOutcome,
  runSupervisor,
  shouldConsult,
  supervisorAgent,
  supervisorCommands,
  supervisorEvidence,
  supervisorNotification,
  supervisorPrior,
} from "./supervisor.mjs";

// A worker verification.json for a lane that failed a check after real work.
// The shape is copied from scripts/worker.mjs, not imagined.
const VERIFICATION = {
  taskId: "207",
  attempt: 2,
  agentExitCode: 1,
  timedOut: false,
  durationMs: 412_000,
  rateLimited: false,
  producedFiles: ["src/checkout.ts", "src/checkout.test.ts"],
  keptOutsideDeclaredPaths: [],
  checks: [
    { command: "npm run lint:check", code: 0, output: "ok" },
    { command: "npm test", code: 1, output: "x".repeat(50_000) },
    { command: "npm run typecheck", code: 0, output: "ok" },
  ],
};

const laneContext = (over = {}) => ({
  taskId: "207",
  task: { id: "207", title: "Checkout resolves Price by lookup_key" },
  attempt: 2,
  verification: VERIFICATION,
  recentFailures: [{ taskId: "207", durationMs: 412_000 }],
  ...over,
});

const agentText = (block, prose = "Here is what I think.") =>
  `${prose}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

// A stream file in the shape agent-stats.parseStream reads.
const streamWith = (text) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`
  + `${JSON.stringify({ type: "result", subtype: "success", result: text })}\n`;

const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-supervisor-"));
  mkdirSync(join(dir, ".afk"), { recursive: true });
  return dir;
};

// A spawn seam that fails the test if it is ever reached.
const neverSpawn = () => {
  throw new Error("the supervisor started a session it should not have");
};

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

test("every event has a classification set and a recommendation set", () => {
  for (const event of SUPERVISOR_EVENTS) {
    assert.ok(CLASSIFICATIONS[event]?.length, `${event} has classifications`);
    assert.ok(RECOMMENDATIONS[event]?.length, `${event} has recommendations`);
  }
});

test("no recommendation anywhere is a lifecycle transition", () => {
  // The specification's "does not own": the ready queue, slot accounting,
  // integration serialization, and the passed/failed transitions. If any of
  // these words becomes expressible, the split has quietly moved.
  const forbidden = /^(pass|passed|fail|failed|integrate|schedule|start|queue|close)$/;
  for (const list of Object.values(RECOMMENDATIONS)) {
    for (const value of list) assert.doesNotMatch(value, forbidden);
  }
});

test("the action allowlist contains no command that moves a task", () => {
  assert.deepEqual(
    Object.keys(SUPERVISOR_ACTIONS).sort(),
    ["ledger", "reset", "run", "stats", "status"],
  );
  // `reset` and `run` are the two that touch a task at all, and both are
  // literally what a human types: `afk reset 207`, `afk run --task=204`.
  assert.deepEqual(SUPERVISOR_ACTIONS.reset({ taskIds: ["207"] }), ["reset", "207"]);
  assert.deepEqual(
    SUPERVISOR_ACTIONS.run({ taskId: "204", dagPath: "/tmp/dag.json" }),
    ["run", "--task=204", "--dag=/tmp/dag.json"],
  );
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("evidence carries only the first failing check, tail-clipped", () => {
  const evidence = supervisorEvidence("lane_failed", laneContext());
  assert.equal(evidence.failedCheck.command, "npm test");
  assert.equal(evidence.failedCheck.code, 1);
  assert.ok(
    evidence.failedCheck.output.length < 3_000,
    "a 50KB check output must not reach a prompt — AGENTS.md failure mode 5",
  );
  assert.match(evidence.failedCheck.output, /more chars/);
  assert.equal(evidence.checksRun, 3);
  assert.equal(evidence.producedFiles, 2, "a count, not the file list");
});

// The test above passed for as long as the clip was head-ONLY: a uniform
// "x".repeat(50_000) fixture cannot tell the two ends apart, and `/more chars/`
// matches either. So this one marks both ends. A test runner prints the
// assertion, the diff and the summary LAST; losing the tail loses the finding.
test("a clipped check output keeps its tail, where the assertion is", () => {
  const output = `FIRST-DIAGNOSTIC\n${"x".repeat(50_000)}\nAssertionError: expected 3 to equal 4`;
  const verification = { ...VERIFICATION, checks: [{ command: "npm test", code: 1, output }] };
  const evidence = supervisorEvidence("lane_failed", laneContext({ verification }));

  assert.match(evidence.failedCheck.output, /AssertionError: expected 3 to equal 4/);
  assert.match(evidence.failedCheck.output, /FIRST-DIAGNOSTIC/, "the head still carries tsc/eslint's first line");
  assert.ok(evidence.failedCheck.output.length < 3_000, "still bounded");
});

test("evidence never carries the check outputs that passed", () => {
  const evidence = JSON.stringify(supervisorEvidence("lane_failed", laneContext()));
  assert.doesNotMatch(evidence, /"ok"/);
});

test("a question's evidence is the question and the run snapshot, nothing else", () => {
  const evidence = supervisorEvidence("question", {
    question: "why has 207 been running 40 minutes",
    run: { tasks: { 207: { lifecycle: "running" } } },
  });
  assert.equal(evidence.question, "why has 207 been running 40 minutes");
  assert.ok(evidence.run);
  assert.equal(evidence.failedCheck, undefined);
});

// ---------------------------------------------------------------------------
// The deterministic prior — what the runner concludes before any model runs
// ---------------------------------------------------------------------------

test("an observed expired login is infra, locked, and halts", () => {
  const prior = supervisorPrior(
    supervisorEvidence("lane_failed", laneContext({ verification: { ...VERIFICATION, authFailure: true } })),
  );
  assert.equal(prior.classification, "infra");
  assert.equal(prior.recommendation, "halt");
  assert.equal(prior.confidence, "high");
  assert.equal(prior.locked, true, "an observed fact is not a judgment call");
});

test("a lane that never reached the API gets a locked infra prior", () => {
  // scheduler.neverReachedApi, imported rather than restated: counters that
  // exist and are all zero, and nothing written. A builder that spent nothing
  // and produced nothing never got as far as the ticket, so the ticket cannot
  // be what failed.
  const prior = supervisorPrior(
    supervisorEvidence(
      "lane_failed",
      laneContext({
        verification: {
          ...VERIFICATION,
          durationMs: 114_456,
          producedFiles: [],
          tokens: { input: 0, output: 0, cacheRead: 0 },
        },
      }),
    ),
  );
  assert.equal(prior.classification, "infra");
  assert.equal(prior.confidence, "high");
  assert.equal(prior.locked, true, "an all-zero meter with no files is observed, not inferred");
  const why = prior.why.join(" ");
  assert.match(why, /zero tokens/);
  assert.match(why, /no produced files/);
});

test("the never-reached-API prior outranks the auth-failure prior", () => {
  // Both conditions hold at once. The order matters because the two reasons are
  // different halts: an expired login says every later lane dies the same way,
  // and a dead harness says this one never started. The specific fact wins.
  const prior = supervisorPrior(
    supervisorEvidence(
      "lane_failed",
      laneContext({
        verification: {
          ...VERIFICATION,
          authFailure: true,
          producedFiles: [],
          tokens: { input: 0, output: 0, cacheRead: 0 },
        },
      }),
    ),
  );
  const why = prior.why.join(" ");
  assert.match(why, /zero tokens/);
  assert.doesNotMatch(why, /login expired/);
});

test("a cluster of near-instant failures across unrelated tasks is infra, locked", () => {
  // Exactly the breaker's own reading (scheduler.looksLikeInfra), reused rather
  // than reimplemented — a second opinion here would be a second source of truth.
  const prior = supervisorPrior(
    supervisorEvidence(
      "lane_failed",
      laneContext({
        verification: { ...VERIFICATION, durationMs: 900 },
        recentFailures: [
          { taskId: "205", durationMs: 800 },
          { taskId: "207", durationMs: 900 },
        ],
      }),
    ),
  );
  assert.equal(prior.classification, "infra");
  assert.equal(prior.locked, true);
});

test("a usage limit is `quota` and is deliberately NOT locked", () => {
  // AGENTS.md failure mode 4, the one still OPEN. The runner can see that a
  // limit was hit; it cannot see whether the reset is in five minutes or six
  // days, because the provider says so in prose. That sentence is the judgment.
  const prior = supervisorPrior(
    supervisorEvidence(
      "lane_failed",
      laneContext({
        verification: { ...VERIFICATION, rateLimited: true },
        tail: "You've hit your usage limit. Try again at Aug 16th.",
      }),
    ),
  );
  assert.equal(prior.classification, "quota");
  assert.equal(prior.locked, false);
  assert.equal(shouldConsult(prior), true, "this is the case the model exists for");
});

test("one near-instant failure is unclear — the breaker needs two, this needs judgment", () => {
  const prior = supervisorPrior(
    supervisorEvidence(
      "lane_failed",
      laneContext({
        verification: { ...VERIFICATION, durationMs: 700, checks: [] },
        recentFailures: [{ taskId: "207", durationMs: 700 }],
      }),
    ),
  );
  assert.equal(prior.classification, "unclear");
  assert.equal(prior.confidence, "low");
  assert.equal(prior.locked, false);
  assert.match(prior.why.join(" "), /one task is not a cluster/);
});

test("a failing check is unclear, and the prior says why it cannot be decided", () => {
  const prior = supervisorPrior(supervisorEvidence("lane_failed", laneContext()));
  assert.equal(prior.classification, "unclear");
  assert.match(prior.why.join(" "), /bad ticket, a broken baseline or a flake/);
});

test("a check killed at its bound is not diagnosed as a failing one", () => {
  // #70's criterion. `swift test` exited 124 — read as "a bad ticket, a broken
  // baseline or a flake" — is the misdiagnosis: the check never returned and
  // was killed, so the causes are a different set, and 124 is the runner's own
  // code rather than anything the command reported.
  const timedOut = supervisorEvidence("lane_failed", laneContext({
    verification: {
      ...VERIFICATION,
      checks: [
        { command: "npm run lint:check", code: 0, output: "ok" },
        { command: "swift test", code: CHECK_TIMEOUT_EXIT_CODE, timedOut: true, timeoutMs: 1_800_000, output: "" },
      ],
    },
  }));
  assert.equal(timedOut.failedCheck.timedOut, true, "the evidence dropped the one fact that distinguishes them");
  const prior = supervisorPrior(timedOut);
  assert.equal(prior.classification, "unclear");
  assert.match(prior.why.join(" "), /never returned inside its bound/);
  assert.equal(
    prior.why.join(" ").includes("bad ticket, a broken baseline or a flake"),
    false,
    "a timed-out check was still read as a red one",
  );

  // The red check is untouched, and still says nothing about a bound.
  const red = supervisorPrior(supervisorEvidence("lane_failed", laneContext()));
  assert.match(red.why.join(" "), /bad ticket, a broken baseline or a flake/);
});

test("a gate is locked to the human and needs no session", () => {
  const prior = supervisorPrior(supervisorEvidence("gate_reached", { taskIds: ["204"], gate: "before" }));
  assert.equal(prior.recommendation, "wake-human");
  assert.equal(prior.locked, true);
  assert.equal(shouldConsult(prior), false, "paying tokens to be told a gate is a gate");
});

test("`shouldConsult` is the cost gate, and it is overridable in both directions", () => {
  const locked = supervisorPrior(supervisorEvidence("gate_reached", { taskIds: ["204"] }));
  const open = supervisorPrior(supervisorEvidence("lane_failed", laneContext()));
  assert.equal(shouldConsult(locked, "auto"), false);
  assert.equal(shouldConsult(locked, "always"), true);
  assert.equal(shouldConsult(open, "auto"), true);
  assert.equal(shouldConsult(open, "never"), false);
});

// ---------------------------------------------------------------------------
// Parsing and merging
// ---------------------------------------------------------------------------

const parsed = (over = {}) => {
  const evidence = supervisorEvidence("lane_failed", laneContext());
  return parseSupervisorOutput({
    event: "lane_failed",
    prior: supervisorPrior(evidence),
    text: agentText({
      classification: "bad-ticket",
      confidence: "medium",
      recommendation: "salvage",
      reasoning: "the test asserts an API the ticket never specified",
      answer: "207 wrote the wrong API. Its branch is worth reading before you retry it.",
      wake: false,
      actions: [{ command: "ledger", args: { type: "api", source: "207", text: "Price is resolved by lookup_key" }, why: "so 210 does not repeat it" }],
    }),
    meta: { evidence },
    ...over,
  });
};

test("the LAST fenced json block wins, so prose may quote json", () => {
  const text = "See:\n```json\n{\"classification\": \"infra\"}\n```\nBut really:\n"
    + "```json\n{\"classification\": \"bad-ticket\"}\n```\n";
  assert.equal(lastJsonBlock(text).classification, "bad-ticket");
});

test("an off-schema value is clamped, not trusted", () => {
  const decision = normalizeDecision(
    {
      classification: "definitely-the-network",
      confidence: "certain",
      recommendation: "mark it passed",
      resetsAt: "some time next week",
      wake: "yes",
      extra: "ignored",
    },
    "lane_failed",
  );
  assert.equal(decision.classification, "unclear");
  assert.equal(decision.confidence, "low");
  assert.equal(decision.recommendation, "leave");
  assert.equal(decision.wake, false, "only a real boolean wakes anyone");
  assert.equal(decision.resetsAt, null, "an unparseable date is null, not a guessed one");
  assert.ok(!("extra" in decision));
});

test("an invented classification falls back to the runner's reading, not to a constant", () => {
  // "unclear" is not a legal answer to "how did the epic end", so a constant
  // fallback would emit a value outside the event's own enum.
  const decision = normalizeDecision(
    { classification: "unclear", recommendation: "retry-clean" },
    "epic_ended",
    { classification: "halted", recommendation: "wake-human" },
  );
  assert.equal(decision.classification, "halted");
  assert.equal(decision.recommendation, "wake-human");
});

test("a real ISO timestamp survives, because that is what the quota case needs", () => {
  assert.equal(
    normalizeDecision({ resetsAt: "2026-08-16T00:00:00Z" }, "lane_failed").resetsAt,
    "2026-08-16T00:00:00.000Z",
  );
});

test("a good answer parses into a decision the runner can act on", () => {
  const decision = parsed();
  assert.equal(decision.status, "ok");
  assert.equal(decision.classification, "bad-ticket");
  assert.equal(decision.recommendation, "salvage");
  assert.equal(decision.version, SUPERVISOR_DECISION_VERSION);
  assert.match(decision.reasoning, /bad ticket, a broken baseline or a flake/, "the prior's reading is kept");
  assert.match(decision.reasoning, /never specified/, "and the model's is appended");
});

test("a locked prior cannot be overturned, and the disagreement is recorded", () => {
  const evidence = supervisorEvidence(
    "lane_failed",
    laneContext({ verification: { ...VERIFICATION, authFailure: true } }),
  );
  const decision = parseSupervisorOutput({
    event: "lane_failed",
    prior: supervisorPrior(evidence),
    text: agentText({ classification: "bad-ticket", recommendation: "salvage", confidence: "high" }),
    meta: { evidence },
  });
  assert.equal(decision.classification, "infra", "an observed login death is not arguable");
  assert.equal(decision.recommendation, "halt");
  assert.equal(decision.source, "runner");
  assert.match(decision.problems.join(" "), /the observation stands/);
});

test("an unlocked prior IS overturned — that is what the session is for", () => {
  const decision = parsed();
  assert.equal(decision.prior.classification, "unclear");
  assert.equal(decision.classification, "bad-ticket");
  assert.equal(decision.source, "supervisor");
});

test("no session, a dead agent, a timeout and an expired login all fall back to the prior", () => {
  const evidence = supervisorEvidence("lane_failed", laneContext());
  const prior = supervisorPrior(evidence);
  const cases = [
    [{ skipped: true }, "skipped"],
    [{ agentStatus: 1 }, "agent_failed"],
    [{ agentStatus: 0, timedOut: true }, "agent_failed"],
    [{ raw: "authentication_error" }, "auth_failed"],
    [{ text: "I have no idea and no json." }, "unparseable"],
  ];
  for (const [over, status] of cases) {
    const decision = parseSupervisorOutput({ event: "lane_failed", prior, meta: { evidence }, ...over });
    assert.equal(decision.status, status);
    assert.equal(decision.classification, prior.classification, `${status} keeps the runner's reading`);
    assert.equal(decision.recommendation, prior.recommendation);
  }
});

test("auth death names the same fix the rest of the runner names", () => {
  const evidence = supervisorEvidence("lane_failed", laneContext());
  const decision = parseSupervisorOutput({
    event: "lane_failed",
    prior: supervisorPrior(evidence),
    raw: "OAuth session expired",
    meta: { evidence },
  });
  assert.match(decision.problems.join(" "), /claude auth login/);
});

// ---------------------------------------------------------------------------
// Actions — "the same `afk` commands a human would"
// ---------------------------------------------------------------------------

test("allowlisted actions render to afk argv", () => {
  const { commands, refused } = supervisorCommands(
    {
      actions: [
        { command: "reset", args: { taskIds: ["207", "209"] }, why: "retry clean" },
        { command: "status", args: {} },
        { command: "ledger", args: { type: "api", source: "205", text: "use lookup_key", appliesTo: ["209", "210"] } },
      ],
    },
    { dagPath: "/tmp/dag.json" },
  );
  assert.equal(refused.length, 0);
  assert.deepEqual(commands[0].argv, ["reset", "207", "209"]);
  assert.deepEqual(commands[1].argv, ["status"]);
  assert.deepEqual(commands[2].argv, [
    "ledger", "add", "--type=api", "--source=205", "--text=use lookup_key", "--applies-to=209,210",
  ]);
});

test("a proposed lifecycle transition is refused, by name", () => {
  const { commands, refused } = supervisorCommands({
    actions: [
      { command: "pass", args: { taskId: "207" } },
      { command: "fail", args: { taskId: "207" } },
      { command: "integrate", args: { taskId: "207" } },
      { command: "schedule", args: {} },
    ],
  });
  assert.equal(commands.length, 0, "not one of them reaches a shell");
  assert.equal(refused.length, 4);
  for (const entry of refused) assert.match(entry.why, /lifecycle transition|does not own/);
});

test("an invented command is refused rather than run", () => {
  const { commands, refused } = supervisorCommands({
    actions: [{ command: "rm -rf /", args: {} }, { command: "afk", args: {} }],
  });
  assert.equal(commands.length, 0);
  assert.equal(refused.length, 2);
});

test("task ids are sanitised before they reach argv", () => {
  const { commands } = supervisorCommands({
    actions: [{ command: "reset", args: { taskIds: ["207", "; rm -rf ~", "$(whoami)", "209"] } }],
  });
  assert.deepEqual(commands[0].argv, ["reset", "207", "209"]);
});

test("`run --task` is refused without the dag path a human would also supply", () => {
  const { commands, refused } = supervisorCommands({ actions: [{ command: "run", args: { taskId: "204" } }] });
  assert.equal(commands.length, 0);
  assert.match(refused[0].why, /without the arguments it needs/);
});

// ---------------------------------------------------------------------------
// Structural: it cannot mutate state and it does not own the queue
// ---------------------------------------------------------------------------

test("the module contains no state mutation and no queue ownership", () => {
  // The technique is Lane H's, in scripts/verifier.test.mjs. The list is longer
  // here because this role is the one with a plausible reason to reach for them.
  // Comment lines are stripped first: this file argues about state at length and
  // the assertion is about what it DOES, not what it says.
  const source = readFileSync(fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(source, /saveState|queueStatus|lifecycle\s*=/);
  assert.doesNotMatch(source, /enqueueIntegration|dequeueIntegration|nextBuilderTasks|freeBuilderSlots|canStartIntegration/);
  // It is handed a run snapshot by the caller; it never opens `.afk/state.json`.
  assert.doesNotMatch(source, /state\.json/);
  // No timer, no polling — docs/build-prompt.md states this as a requirement of
  // the design, not a preference.
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  // And it never spawns an `afk` command itself: it renders argv, the runner runs it.
  assert.doesNotMatch(source, /spawnSync|execFile/);
});

test("the supervisor's own artifacts live under .afk/supervisor and nowhere else", () => {
  const source = readFileSync(fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), "utf8");
  const writes = [...source.matchAll(/atomicWrite\(\s*([^,]+)/g)].map((match) => match[1]);
  assert.ok(writes.length >= 3);
  for (const target of writes) {
    assert.match(target, /promptPath|budgetPath|resolve\(\s*(dir|supervisorDir)/);
  }
});

// ---------------------------------------------------------------------------
// The role record
// ---------------------------------------------------------------------------

test("the supervisor is the ONE role that keeps the herdr skill", () => {
  // docs/notifications-and-agent-scope.md, roles table: implementer no,
  // integrator no, plan-reviewer no, verifier no, supervisor YES — "Reading
  // panes is how it answers 'what is 207 doing'".
  for (const [name, role] of Object.entries(ROLES)) {
    const denied = skillDenyRules(role).includes("Skill(herdr)");
    assert.equal(denied, name !== "supervisor", `${name}: herdr deny should be ${name !== "supervisor"}`);
  }
  const settings = JSON.parse(settingsArg(roleFor("supervisor")));
  assert.ok(!settings.permissions.deny.includes("Skill(herdr)"));
  assert.ok(!settings.permissions.deny.includes("Skill(herdr *)"));
});

test("the supervisor is denied the mutating herdr verbs and every afk command", () => {
  const deny = roleFor("supervisor").permissions.deny;
  // It may read a pane. It may not start an agent in one, or close a workspace —
  // that would be scheduling, which it does not own.
  assert.ok(deny.includes("Bash(herdr agent:*)"));
  assert.ok(deny.includes("Bash(herdr workspace close:*)"));
  // And it may not run the commands it proposes. The runner runs them.
  assert.ok(deny.includes("Bash(afk:*)"));
  assert.ok(deny.includes("Bash(node afk.mjs:*)"));
});

test("the supervisor is read-only and never gets bypass mode", () => {
  const role = roleFor("supervisor");
  assert.equal(role.permissions.bypassPermissions, false);
  assert.equal(supervisorAgent(role, {}).bypassPermissions, false);
  const settings = JSON.parse(settingsArg(role));
  // A sandbox naming no cwd renders the whole profile onto the invocation —
  // roles.mjs `settingsArg`. Not re-rendered here; that workaround is retired.
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/tmp", "/private/tmp", "/var/tmp"]);
  assert.ok(settings.permissions.deny.includes("Write"));
  assert.ok(settings.permissions.deny.includes("Edit"));
});

test("the supervisor's timeout is short, because a run waits behind it", () => {
  assert.equal(roleFor("supervisor").timeoutMs, 180_000);
});

// ---------------------------------------------------------------------------
// Running it — always with an injected spawn
// ---------------------------------------------------------------------------

test("a locked prior spends no session at all", async () => {
  const root = tempRoot();
  const decision = await onGateReached({
    root,
    config: {},
    taskIds: ["204"],
    gate: "before",
    runAgent: neverSpawn,
  });
  assert.equal(decision.status, "skipped");
  assert.equal(decision.consulted, false);
  assert.equal(decision.recommendation, "wake-human");
  assert.equal(decision.wake, true);
  rmSync(root, { recursive: true, force: true });
});

test("an ambiguous failure spends one, and the decision lands on disk", async () => {
  const root = tempRoot();
  let calls = 0;
  const decision = await onLaneFailed({
    root,
    config: {},
    ...laneContext(),
    runAgent: async ({ streamPath }) => {
      calls += 1;
      writeFileSync(
        streamPath,
        streamWith(
          agentText({
            classification: "bad-ticket",
            confidence: "medium",
            recommendation: "salvage",
            reasoning: "the ticket never named the API the test asserts",
            answer: "207 built the wrong thing; read its branch before retrying.",
            wake: true,
          }),
        ),
      );
      return { status: 0, timedOut: false };
    },
  });
  assert.equal(calls, 1);
  assert.equal(decision.status, "ok");
  assert.equal(decision.classification, "bad-ticket");
  assert.ok(existsSync(decision.artifacts.decision));
  assert.equal(
    JSON.parse(readFileSync(decision.artifacts.decision, "utf8")).classification,
    "bad-ticket",
  );
  const note = supervisorNotification(decision);
  assert.match(note.title, /#207 failed — bad-ticket/);
  assert.match(note.message, /read its branch/);
  rmSync(root, { recursive: true, force: true });
});

test("a high-confidence no-op-ticket verdict turns a blocked lane into terminal no-op", async () => {
  const root = tempRoot();
  const decision = await onLaneBlocked({
    root,
    config: {},
    taskId: "209",
    lifecycle: "blocked",
    verification: {},
    runAgent: async ({ streamPath }) => {
      writeFileSync(
        streamPath,
        streamWith(
          agentText({
            classification: "no-op-ticket",
            confidence: "high",
            recommendation: "leave",
            reasoning: "the requested change is already present on the branch",
            answer: "No retry is needed.",
          }),
        ),
      );
      return { status: 0, timedOut: false };
    },
  });
  assert.equal(decision.lifecycle, "no-op");
  rmSync(root, { recursive: true, force: true });
});

test("a second end of one epic with a different failed task is judged afresh, not replayed (#179)", async () => {
  // #489's end-of-epic text still said "flaky email test" after that task
  // passed: the tally's counts matched an earlier end, so its judgment replayed.
  const root = tempRoot();
  let calls = 0;
  const runAgent = async ({ streamPath }) => {
    calls += 1;
    writeFileSync(streamPath, streamWith(agentText({ classification: "partial", recommendation: "wake-human" })));
    return { status: 0, timedOut: false };
  };
  const end = (tasks, failed) => onEpicEnded({
    root, config: {}, consult: "always", runAgent, epic: { id: "489" }, halted: null,
    tally: { status: "incomplete", reason: "tasks failed", passed: ["1"], failed },
    run: { tasks },
  });
  await end({ 1: "passed", 2: "failed", 3: "pending" }, ["2"]);
  const second = await end({ 1: "passed", 2: "pending", 3: "failed" }, ["3"]);
  assert.equal(calls, 2, "a different failed task is a different question");
  assert.equal(second.reused ?? false, false);
  await end({ 1: "passed", 2: "pending", 3: "failed" }, ["3"]);
  assert.equal(calls, 2, "the identical end is still one session");
  rmSync(root, { recursive: true, force: true });
});

test("the same failure twice costs one session — a flaky suite cannot run up a bill", async () => {
  const root = tempRoot();
  let calls = 0;
  const runAgent = async ({ streamPath }) => {
    calls += 1;
    writeFileSync(streamPath, streamWith(agentText({ classification: "flaky", recommendation: "retry-clean" })));
    return { status: 0, timedOut: false };
  };
  const first = await onLaneFailed({ root, config: {}, ...laneContext(), runAgent });
  const second = await onLaneFailed({ root, config: {}, ...laneContext(), runAgent });
  assert.equal(calls, 1, "an identical event is an identical question");
  assert.equal(second.reused, true);
  assert.equal(second.classification, first.classification);

  // A materially different failure is a different question and is paid for.
  await onLaneFailed({
    root,
    config: {},
    ...laneContext({ verification: { ...VERIFICATION, checks: [{ command: "npm run typecheck", code: 2, output: "boom" }] } }),
    runAgent,
  });
  assert.equal(calls, 2);
  rmSync(root, { recursive: true, force: true });
});

test("the per-run session budget degrades to the prior instead of erroring", async () => {
  const root = tempRoot();
  const previous = process.env.AFK_SUPERVISOR_MAX_CALLS;
  process.env.AFK_SUPERVISOR_MAX_CALLS = "0";
  try {
    const decision = await onLaneFailed({ root, config: {}, ...laneContext(), runAgent: neverSpawn });
    assert.equal(decision.status, "skipped");
    assert.equal(decision.classification, "unclear", "the runner's own reading stands");
    assert.match(decision.problems.join(" "), /budget for this run is spent/);
  } finally {
    if (previous === undefined) delete process.env.AFK_SUPERVISOR_MAX_CALLS;
    else process.env.AFK_SUPERVISOR_MAX_CALLS = previous;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a spawn that throws costs the run nothing", async () => {
  const root = tempRoot();
  const decision = await onIntegrationFailed({
    root,
    config: {},
    taskId: "208",
    failureReason: "merge left the tree dirty",
    verification: {},
    runAgent: async () => {
      throw new Error("claude is not installed");
    },
  });
  assert.equal(decision.status, "agent_failed");
  assert.equal(decision.recommendation, supervisorPrior(supervisorEvidence("integration_failed", { taskId: "208", verification: {} })).recommendation);
  rmSync(root, { recursive: true, force: true });
});

test("every entry point returns a decision naming its own event", async () => {
  const root = tempRoot();
  const runAgent = async ({ streamPath }) => {
    writeFileSync(streamPath, streamWith(agentText({ classification: "unclear", answer: "ok" })));
    return { status: 0, timedOut: false };
  };
  const calls = [
    [onLaneFailed, { ...laneContext() }, "lane_failed"],
    [onIntegrationFailed, { taskId: "208", verification: {}, failureReason: "dirty" }, "integration_failed"],
    [onLaneBlocked, { taskId: "209", verification: {} }, "lane_blocked"],
    [onGateReached, { taskIds: ["204"] }, "gate_reached"],
    [onEpicEnded, { epic: { id: "203" }, tally: { passed: 6, failed: 1 } }, "epic_ended"],
    [onHumanAsked, { question: "why has 207 been running 40 minutes" }, "question"],
  ];
  for (const [fn, context, event] of calls) {
    const decision = await fn({ root, config: {}, ...context, runAgent });
    assert.equal(decision.event, event);
    assert.ok(RECOMMENDATIONS[event].includes(decision.recommendation));
    assert.ok(CLASSIFICATIONS[event].includes(decision.classification));
  }
  rmSync(root, { recursive: true, force: true });
});

test("an unknown event is a programming error, not a silent no-op", async () => {
  await assert.rejects(
    () => runSupervisor({ root: tmpdir(), event: "lane_exploded", context: {} }),
    /Unknown supervisor event/,
  );
});

test("the printed outcome says it changed nothing", () => {
  const line = renderSupervisorOutcome(parsed());
  assert.match(line, /SUPERVISE: lane_failed — `bad-ticket`/);
  assert.match(line, /proposes `afk ledger add/);
  assert.match(line, /Nothing here changed run state/);
});

test("two different events never collide in the artifact directory", () => {
  const a = eventSignature(supervisorEvidence("lane_failed", laneContext()));
  const b = eventSignature(supervisorEvidence("lane_blocked", laneContext()));
  assert.notEqual(a, b);
});

test("an epic that ended well is a different question from one that ended badly", () => {
  // The signature is a CACHE KEY: an identical one replays the earlier decision
  // verbatim instead of paying for a session. `onEpicEnded` carries no taskId,
  // no failed check and no timeout, so the outcome is the only thing telling the
  // two apart. Without it the first live epic's successful close replayed the
  // failed run's decision and announced "the epic closed with nothing merged"
  // over a run that merged everything.
  const ended = (tally) => eventSignature({ event: "onEpicEnded", tally });
  const bad = ended({ status: "incomplete", reason: "task(s) 4 did not pass", passed: [] });
  const good = ended({ status: "completed", reason: "every task passed", passed: ["4", "5", "6"] });
  assert.notEqual(bad, good);
  // Same outcome twice IS the same question, which is what the cache is for.
  assert.equal(good, ended({ status: "completed", reason: "every task passed", passed: ["4", "5", "6"] }));
});

test("two epics that ended the same way are still two questions", () => {
  // The fix above made two OUTCOMES of one epic distinct and left two EPICS
  // with one outcome identical, which is the same bug one level up. Epic #12
  // closed with #7's exact shape — three tasks passed, nothing failed, same
  // reason — replayed #7's cached decision, and the runner announced "Epic 7 is
  // genuinely done" at the close of #12. Measured on a live run, not imagined.
  const tally = { status: "completed", reason: "every task passed", passed: ["4", "5", "6"] };
  const ended = (id) => eventSignature({ event: "onEpicEnded", tally, epic: { id } });
  assert.notEqual(ended("7"), ended("12"));
  assert.equal(ended("7"), ended("7"));
  // A --dag= run carries no epic, and two of those still cache against each
  // other exactly as before.
  assert.equal(
    eventSignature({ event: "onEpicEnded", tally }),
    eventSignature({ event: "onEpicEnded", tally, epic: null }),
  );
});

// ---------------------------------------------------------------------------
// End to end, offline
// ---------------------------------------------------------------------------

test("end to end against a fake claude: the read-only profile reaches the process", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-supervisor-e2e-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });

  const seen = join(dir, "argv.txt");
  const seenCwd = join(dir, "cwd.txt");
  const canned = join(dir, "answer.jsonl");
  writeFileSync(
    canned,
    streamWith(
      agentText({
        classification: "quota",
        confidence: "high",
        recommendation: "halt",
        reasoning: "the message names a reset six days out, which is a hard quota, not a rate limit",
        answer: "This is a hard quota until 16 Aug. Retrying it on a 5-minute loop will never succeed.",
        resetsAt: "2026-08-16T00:00:00Z",
        wake: true,
      }),
    ),
  );
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > ${JSON.stringify(seen)}`,
      `pwd > ${JSON.stringify(seenCwd)}`,
      "cat > /dev/null",
      `cat ${JSON.stringify(canned)}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  // A `gh` and a `herdr` that fail loudly. This test drives runSupervisor
  // directly and neither should be reached; if one is, the run fails here rather
  // than in a place where it might have reached a network.
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });

  const context = {
    taskId: "207",
    verification: { rateLimited: true, agentExitCode: 1, durationMs: 3_000, checks: [] },
    tail: "You've hit your usage limit for Claude Opus. Try again at Aug 16th.",
  };
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const m = await import(${JSON.stringify(fileURLToPath(new URL("./supervisor.mjs", import.meta.url)))});`,
        `const decision = await m.onLaneFailed({ root: ${JSON.stringify(repo)}, config: {}, ...${JSON.stringify(context)} });`,
        "console.log(m.renderSupervisorOutcome(decision));",
        "console.log('RESETS=' + decision.resetsAt);",
        "console.log('WAKE=' + JSON.stringify(m.supervisorNotification(decision)));",
      ].join("\n"),
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        AFK_BACKEND: "claude",
        PATH: `${bin}:${process.env.PATH}`,
        AFK_WORKTREE_ROOT: join(dir, "worktrees"),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  // The judgment a regex could not make: prose "Aug 16th" became a timestamp,
  // and a soft-looking rate limit was called a hard quota. AGENTS.md failure
  // mode 4.
  assert.match(result.stdout, /SUPERVISE: lane_failed — `quota`/);
  assert.match(result.stdout, /RESETS=2026-08-16/);
  assert.match(result.stdout, /WAKE=\{"title"/);
  assert.match(result.stdout, /Nothing here changed run state/);

  const argv = readFileSync(seen, "utf8").trim();
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  assert.match(argv, /--permission-mode default/);
  const settings = JSON.parse(/--settings (\{.*\}) --append-system-prompt A rule from the runner/.exec(argv)?.[1] ?? "{}");
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/tmp", "/private/tmp", "/var/tmp"]);
  assert.ok(settings.permissions.deny.includes("Bash(afk:*)"));
  assert.ok(!settings.permissions.deny.some((rule) => /Skill\(herdr/.test(rule)), "herdr stays");

  // Where it ran is the cap that matters. `allowWrite` only widens, so it cannot
  // take back Claude Code's default grant of the agent's own cwd — a supervisor
  // at the project root writes the run it is advising on, through a Bash
  // redirect no deny rule can name (docs/findings.md 3.2). So it runs in a
  // scratch directory, and that directory does not outlive the session.
  const agentCwd = readFileSync(seenCwd, "utf8").trim();
  assert.notEqual(agentCwd, realpathSync(repo));
  assert.match(agentCwd, /role-cwd-supervise-/);
  assert.equal(existsSync(agentCwd), false);
  // ... and it was told where the project is, since its cwd is no longer there.
  const supervisorRuns = spawnSync("ls", [resolve(repo, ".afk", "supervisor")], { encoding: "utf8" })
    .stdout.trim().split("\n").filter((name) => name.startsWith("207-"));
  assert.equal(supervisorRuns.length, 1, "one judged event, one directory");
  const prompt = readFileSync(resolve(repo, ".afk", "supervisor", supervisorRuns[0], "prompt.md"), "utf8");
  assert.match(prompt, /scratch directory, NOT the project/);
  assert.ok(prompt.includes(repo), "the prompt names the project root it must read by absolute path");

  // Nothing outside .afk/ was created in the project it supervised.
  assert.deepEqual(spawnSync("ls", ["-A", repo], { encoding: "utf8" }).stdout.trim().split("\n"), [".afk"]);
  assert.ok(existsSync(resolve(repo, ".afk", "supervisor", "budget.json")));
  rmSync(dir, { recursive: true, force: true });
});
