// scripts/epic-close.test.mjs — `gate: after` and the epic's lifecycle.
//
// docs/epic-schema.md failure mode 5. Two halves, in dependence order:
//
//   1. the pure half — `epicOutcome`, `recordGateAcceptance`, `acceptedGateIds`
//      in scripts/scheduler.mjs. Every terminal state is named here.
//   2. the wired half — `runAuto` actually reaching each of them, with the
//      verifier and the issue comment injected so a close costs no tokens and
//      no GitHub round-trip.
//
// A separate file rather than more of selftest.mjs, for the reason
// scripts/epic-spec.test.mjs is one: `afk selftest` picks up every
// `scripts/*.test.mjs`, and a lane that adds a file cannot conflict with a lane
// that adds another.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, readConfig, writeConfig } from "./test-helpers.mjs";
import {
  acceptedGateIds,
  ensureEpicClose,
  epicCloseSummary,
  epicOutcome,
  outstandingGates,
  recordGateAcceptance,
  supervisorAdvice,
  supervisorRecord,
} from "./scheduler.mjs";
import {
  SUPERVISOR_LOG_MAX,
  appendSupervisorObservation,
  normalizeDag,
  renderCloseout,
  renderStageHeader,
  runAuto,
  salvageLines,
} from "./auto.mjs";
import { freePort } from "./free-port.mjs";

// Each runAuto below installs its own exit/signal handlers.
process.setMaxListeners(60);

const dagOf = (...tasks) => ({
  epic: { id: "203", title: "Stripe subscriptions" },
  branch: "feat/203-stripe",
  tasks,
});
const task = (id, extra = {}) => ({
  id,
  title: `task ${id}`,
  dependsOn: [],
  checks: ["true"],
  allowedPaths: ["**"],
  ...extra,
});
const stateOf = (lifecycles, epicClose = undefined) => ({
  tasks: Object.fromEntries(
    Object.entries(lifecycles).map(([id, lifecycle]) => [id, { lifecycle }]),
  ),
  ...(epicClose ? { epicClose } : {}),
});

// ---------------------------------------------------------------------------
// The pure half: every way an epic ends
// ---------------------------------------------------------------------------

test("an epic with every task passed and no gate is complete", () => {
  const dag = dagOf(task("204"), task("205"));
  assert.equal(epicOutcome(dag, stateOf({ 204: "passed", 205: "passed" })).status, "complete");
});

test("a passed `gate: after` task holds the epic at awaiting_acceptance", () => {
  const dag = dagOf(task("204"), task("211", { gateAfter: true, dependsOn: ["204"] }));
  const state = stateOf({ 204: "passed", 211: "passed" });
  const outcome = epicOutcome(dag, state);
  assert.equal(outcome.status, "awaiting_acceptance");
  assert.deepEqual(outcome.awaiting, ["211"]);
  // The task itself passed like any other. The gate is on the EPIC, not on it.
  assert.deepEqual(outstandingGates(dag, state), ["211"]);
});

test("a human's acceptance releases the gate and the epic completes", () => {
  const dag = dagOf(task("211", { gateAfter: true }));
  const state = stateOf({ 211: "passed" });
  assert.deepEqual(recordGateAcceptance(state, { dag, id: "211" }), { ok: true, already: false });
  assert.equal(epicOutcome(dag, state).status, "complete");
  // Idempotent: releasing twice records one acceptance, not two.
  assert.deepEqual(recordGateAcceptance(state, { dag, id: 211 }), { ok: true, already: true });
  assert.equal(Object.keys(state.epicClose.acceptances).length, 1);
});

test("a terminally failed task ends the epic incomplete, naming what did not pass", () => {
  const dag = dagOf(task("204"), task("205"), task("206"));
  const outcome = epicOutcome(dag, stateOf({ 204: "passed", 205: "failed", 206: "blocked" }));
  assert.equal(outcome.status, "incomplete");
  assert.deepEqual(outcome.failed, ["205", "206"]);
  assert.match(outcome.reason, /205, 206 did not pass/);
});

test("an integration_failed task also ends the epic incomplete", () => {
  const dag = dagOf(task("204"));
  assert.equal(epicOutcome(dag, stateOf({ 204: "integration_failed" })).status, "incomplete");
});

test("an unreleased `gate: before` leaves the epic open, not ended", () => {
  // A gate that sits unreleased forever is not an outcome: the human can still
  // release it, so the epic is in progress and the run exits having done all it
  // may. Same for infra_failed, which a rerun past preflight retries.
  const dag = dagOf(task("204", { humanGated: true }), task("205", { dependsOn: ["204"] }));
  const open = epicOutcome(dag, stateOf({ 204: "pending", 205: "pending" }));
  assert.equal(open.status, "in_progress");
  assert.deepEqual(open.pending, ["204", "205"]);
  assert.equal(epicOutcome(dagOf(task("204")), stateOf({ 204: "infra_failed" })).status, "in_progress");
});

test("work in flight is never judged as an outcome", () => {
  const dag = dagOf(task("204"), task("205"));
  for (const lifecycle of ["running", "ready_to_integrate", "integrating"]) {
    assert.equal(
      epicOutcome(dag, stateOf({ 204: lifecycle, 205: "failed" })).status,
      "in_progress",
      `${lifecycle} must outrank a sibling failure`,
    );
  }
});

// ---------------------------------------------------------------------------
// A gated task cannot self-complete
// ---------------------------------------------------------------------------

test("a gate cannot be accepted before the work it gates has passed", () => {
  const dag = dagOf(task("211", { gateAfter: true }));
  for (const lifecycle of ["pending", "running", "ready_to_integrate", "failed"]) {
    const state = stateOf({ 211: lifecycle });
    const outcome = recordGateAcceptance(state, { dag, id: "211" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /not passed/);
    assert.equal(state.epicClose, undefined, "a refused acceptance writes nothing");
  }
});

test("only a `gate: after` task in this epic can be accepted at all", () => {
  const dag = dagOf(task("204"));
  assert.match(recordGateAcceptance(stateOf({ 204: "passed" }), { dag, id: "204" }).reason, /not `gate: after`/);
  assert.match(recordGateAcceptance(stateOf({ 204: "passed" }), { dag, id: "999" }).reason, /not in this epic/);
});

test("an acceptance that did not come from recordGateAcceptance grants nothing", () => {
  const dag = dagOf(task("211", { gateAfter: true }));
  // Everything an agent could plausibly forge into the state file, each of
  // which is re-checked against the DAG rather than trusted as written.
  const forgeries = [
    { 211: { at: "2026-08-18T00:00:00Z", by: "agent" } },
    { 211: { at: "2026-08-18T00:00:00Z", by: "implementer-211" } },
    { 211: { by: "human" } },
    { 211: true },
    { 204: { at: "2026-08-18T00:00:00Z", by: "human" } },
  ];
  for (const acceptances of forgeries) {
    const state = stateOf({ 211: "passed" }, { acceptances });
    assert.deepEqual(acceptedGateIds(dag, state), [], JSON.stringify(acceptances));
    assert.equal(epicOutcome(dag, state).status, "awaiting_acceptance");
  }
});

test("an acceptance stops counting if the task leaves passed", () => {
  // A reset-and-rerun of accepted work must be re-accepted: the human accepted
  // a diff, not a task id.
  const dag = dagOf(task("211", { gateAfter: true }));
  const state = stateOf({ 211: "passed" });
  recordGateAcceptance(state, { dag, id: "211" });
  state.tasks["211"].lifecycle = "pending";
  assert.deepEqual(acceptedGateIds(dag, state), []);
});

test("`gate: after` survives the DAG boundary and the recorded graph shape", () => {
  const normalized = normalizeDag(
    { tasks: [{ id: 211, gateAfter: true }, { id: 204 }] },
    { defaultChecks: ["true"] },
  );
  assert.equal(normalized.tasks[0].gateAfter, true);
  // Absent, not `false`, on an ungated task: the shape a pre-change state file
  // records is byte-identical for every graph that has no such gate.
  assert.equal("gateAfter" in normalized.tasks[1], false);
});

// ---------------------------------------------------------------------------
// The wired half
// ---------------------------------------------------------------------------


const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-close-bin-"));
  const fake = join(bin, "claude");
  // The auth preflight is the only agent this file ever spawns: every task is
  // pre-seeded passed, so no builder and no merger runs.
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  return bin;
})();

const makeRepo = (tasks, taskState, epicClose = undefined) => {
  // realpath: on macOS $TMPDIR is a symlink, and the dashboard reports its own
  // resolved cwd — an unresolved root fails its identity check and runAuto
  // refuses to start.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-epic-close-")));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(
    repo,
    ({ maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] }),
  );
  writeFileSync(join(repo, "docs", "progress.md"), "# Progress\n");
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(
    join(repo, ".afk", "state.json"),
    JSON.stringify({
      version: 1,
      orchestratorPid: null,
      startedAt: "2026-08-18T00:00:00.000Z",
      activeWorkers: {},
      integrationQueue: [],
      activeIntegrator: null,
      tasks: Object.fromEntries(
        Object.entries(taskState).map(([id, lifecycle]) => [
          id,
          { lifecycle, builderAttempt: 1, integrationAttempt: 1 },
        ]),
      ),
      ...(epicClose ? { epicClose } : {}),
    }),
  );
  return { repo, dag: dagOf(...tasks) };
};

const readState = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));

// `makeRepo` writes the state of a --dag= run, which carries no epic id. The two
// tests below turn on that id, so they set it explicitly rather than by
// widening the helper every other test depends on.
const stateBelongsToEpic = (repo, id) => {
  const path = join(repo, ".afk", "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.epic = { id, title: `Epic ${id}` };
  writeFileSync(path, JSON.stringify(state, null, 2));
};

const report = (extra = {}) => ({
  version: 1,
  status: "ok",
  summary: "It shipped.",
  criteria: [],
  findings: [],
  mustFix: [],
  problems: [],
  ranAt: "2026-08-18T01:00:00.000Z",
  branch: "feat/203-stripe",
  baseBranch: "main",
  artifacts: { report: "/tmp/report.json" },
  ...extra,
});

// The commit a review read, as the real `runVerifier` records it. `--accept`
// needs a review at the branch head (#145), so a fake that omits it can never
// be accepted against.
const headOf = (root) =>
  spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

const close = async ({ repo, dag, ...rest }) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await runAuto({
      config: readConfig(repo),
      dag,
      root: repo,
      interactive: false,
      ...rest,
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

test("a closed epic is archived, not treated as the next epic changing shape", async () => {
  // The state file describes ONE run, and the shape guard compares the graph in
  // it against the graph being started. Across two different epics that
  // comparison is meaningless — every old task reads as removed and every new
  // one as added — so epic #12 was refused with a message about a mid-run
  // change that never happened, and the operator was told to delete the state
  // file by hand. Found by running a second epic in this repo, not by a test.
  const { repo } = makeRepo([task("204")], { 204: "passed" }, {
    lifecycle: "closed",
    outcome: "completed",
    reason: "every task passed",
    closedAt: "2026-08-18T00:00:00.000Z",
    acceptances: {},
  });
  stateBelongsToEpic(repo, "203");
  const next = { ...dagOf(task("301")), epic: { id: "300", title: "The next epic" } };
  const code = await close({
    repo,
    dag: next,
    verify: async () => report(),
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0, "a finished epic must not block the next one");
  // The old run is history, not litter: it holds the closeout and the verifier's
  // recommendation, and deleting it would be the destructive half of the
  // workaround this replaces.
  // One place, and it is the one an operator has been told to type:
  // `.afk/archive/epic-<id>/`. The auto-archive used to write `.afk/epics/<id>/`
  // instead, so the automatic path and the documented one were different
  // directories for the same concept (docs/dx-proposals.md 2.2).
  const archived = JSON.parse(
    readFileSync(join(repo, ".afk", "archive", "epic-203", "state.json"), "utf8"),
  );
  assert.equal(archived.epicClose.outcome, "completed");
  assert.deepEqual(Object.keys(archived.tasks), ["204"]);
  // And the live state is the new epic's alone.
  const state = readState(repo);
  assert.deepEqual(Object.keys(state.tasks), ["301"]);
  assert.equal(state.epic.id, "300");
  rmSync(repo, { recursive: true, force: true });
});

test("an epic still open in the checkout refuses the next one by name", async () => {
  // The other half, and the one that must NOT auto-archive: an unfinished run
  // has lanes, branches and worktrees behind it, and silently filing it away
  // would orphan all three.
  const { repo } = makeRepo([task("204")], { 204: "running" });
  stateBelongsToEpic(repo, "203");
  const code = await close({
    repo,
    dag: { ...dagOf(task("301")), epic: { id: "300", title: "The next epic" } },
    verify: async () => report(),
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 1);
  // Untouched: nothing archived, nothing deleted.
  assert.equal(existsSync(join(repo, ".afk", "epics")), false);
  assert.deepEqual(Object.keys(readState(repo).tasks), ["204"]);
  rmSync(repo, { recursive: true, force: true });
});

test("a run whose gates are unreleased parks at awaiting_acceptance, reviewed before the human accepts", async () => {
  // Reversed deliberately. The review used to be withheld until the epic
  // closed, which meant a human accepting a device gate did so with no review
  // in hand — and the epics that park on a gate are precisely the ones whose
  // acceptance the review exists to inform. It runs first now, and stays
  // advisory: the epic is still `awaiting_acceptance` and still unclosed.
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  stateBelongsToEpic(repo, "203");
  let verifierCalls = 0;
  const code = await close({
    repo,
    dag,
    verify: async () => {
      verifierCalls += 1;
      return report();
    },
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  assert.equal(verifierCalls, 1, "the human must be able to read the review before accepting");
  const state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "awaiting_acceptance");
  assert.equal(state.epicClose.outcome, null, "the review cannot close an epic");
  assert.equal(state.epicClose.verifier.recommendation, "clean");
  assert.deepEqual(state.epicClose.verifier.outstanding, ["211 awaits human acceptance"]);
  assert.match(state.epicClose.reason, /211/);
  assert.equal(existsSync(join(repo, ".afk", "epic-close", "203", "closeout.md")), false);
});

test("--accept releases the gate, closes the epic, and is idempotent on a restart", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  let verifierCalls = 0;
  let comments = 0;
  const hooks = {
    verify: async ({ root }) => {
      verifierCalls += 1;
      return report({ head: headOf(root) });
    },
    commentOnEpic: () => {
      comments += 1;
      return { status: 0 };
    },
  };
  // The park reviews the head; the acceptance is taken against that review.
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  assert.equal(await close({ repo, dag, accept: ["211"], ...hooks }), 0);
  const closed = readState(repo);
  assert.equal(closed.epicClose.lifecycle, "closed");
  assert.equal(closed.epicClose.outcome, "completed");
  assert.equal(closed.epicClose.acceptances["211"].by, "human");
  assert.equal(closed.epicClose.verifier.recommendation, "clean");
  assert.equal(closed.epicClose.closeout.issueCommentedAt !== null, true);
  const closeout = readFileSync(closed.epicClose.closeout.path, "utf8");
  assert.match(closeout, /Outcome: `completed`/);
  assert.match(closeout, /211 accepted/);
  assert.match(closeout, /## Verifier/);
  assert.match(
    readFileSync(join(repo, ".afk", "epic-close", "203", "issue-comment.md"), "utf8"),
    /<!-- afk:closeout:203 -->/,
  );

  // The restart. No further review, no second comment, no re-ask for the gate.
  // Two so far: the park's, and the close's over the acceptance's own commit.
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  assert.equal(verifierCalls, 2);
  assert.equal(comments, 1);
  const again = readState(repo);
  assert.equal(again.epicClose.closedAt, closed.epicClose.closedAt);
  assert.equal(
    readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8").includes("epic already closed"),
    true,
  );
});

// #145, epic #715: legal gate #720 was accepted at 09:42 against a review that
// predated #718's integration. The review that found the redaction leak ran at
// 09:46, and the fixer then edited the document the human had signed.

test("--accept is refused until a closeout review has read the branch head (#145)", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  const commentOnEpic = () => ({ status: 0 });
  // No review at all yet.
  assert.equal(await close({ repo, dag, accept: ["211"], verify: async () => report(), commentOnEpic }), 1);
  assert.equal(readState(repo).epicClose?.acceptances?.["211"], undefined);

  // A review of an older commit: the park stores it, and it is not the head.
  const stale = "0".repeat(40);
  assert.equal(await close({ repo, dag, verify: async () => report({ head: stale }), commentOnEpic }), 0);
  assert.equal(readState(repo).epicClose.verifier.head, stale);
  assert.equal(await close({ repo, dag, accept: ["211"], verify: async () => report({ head: stale }), commentOnEpic }), 1);
  const state = readState(repo);
  assert.equal(state.epicClose.acceptances?.["211"], undefined, "a sign-off over a stale review was recorded");
  assert.equal(state.epicClose.lifecycle, "awaiting_acceptance");
  assert.match(
    readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"),
    /cannot accept 211 — the newest closeout review \(.*\) read 000000000000, and the branch head [0-9a-f]{12} has more than the runner's status commits on top of it\..*add --force/,
  );
});

// A verifier that writes its report where the real `runVerifier` does, so a
// close can read the review back instead of re-running it. Each call is a new
// review: a new `ranAt`, and whatever `make` says it found.
const writingVerifier = (make) => {
  const verify = async ({ root }) => {
    verify.calls += 1;
    const made = report({
      head: headOf(root),
      ranAt: `2026-08-18T0${verify.calls}:00:00.000Z`,
      ...make(verify.calls),
    });
    mkdirSync(join(root, ".afk", "verifier", "203"), { recursive: true });
    writeFileSync(join(root, ".afk", "verifier", "203", "report.json"), JSON.stringify(made));
    return made;
  };
  verify.calls = 0;
  return verify;
};

const mustFixSaying = (...blockers) => () => ({ mustFix: blockers });
const gateSupervisor = (calls) => ({
  onGateReached: async (context) => { calls.push(context); return null; },
});

test("a must-fix review after a forced acceptance puts the gate back and says so (#145)", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  const commentOnEpic = () => ({ status: 0 });
  // The park reviewed an older commit and said clean; the human forces past it.
  assert.equal(await close({ repo, dag, verify: async () => report({ head: "0".repeat(40) }), commentOnEpic }), 0);
  const gates = [];
  const verify = writingVerifier(mustFixSaying("the export still carries raw emails"));
  assert.equal(await close({ repo, dag, accept: ["211"], acceptForce: true, verify, commentOnEpic, supervisor: gateSupervisor(gates) }), 0);
  const state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "awaiting_acceptance", "a must-fix after the sign-off closed the epic");
  assert.equal(state.epicClose.acceptances?.["211"], undefined);
  // The voided sign-off is kept, so the measure row still counts it (#177 minor 8).
  assert.deepEqual(state.epicClose.voidedAcceptances.map((a) => [a.id, a.by]), [["211", "human"]]);
  assert.equal(state.tasks["211"].lifecycle, "awaiting_acceptance");
  assert.equal(existsSync(join(repo, ".afk", "epic-close", "203", "closeout.md")), false);
  assert.match(
    readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"),
    /it is not the review gate\(s\) 211 were accepted over\. They are back to awaiting_acceptance/,
  );
  // The run stopped on a person, and the supervisor is told so.
  assert.deepEqual(gates.map((g) => [g.gate, g.taskIds]), [["after", ["211"]]]);
});

test("accepting over a must-fix review closes with findings when only status commits follow, without a re-review (#145)", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  const commentOnEpic = () => ({ status: 0 });
  const verify = writingVerifier(mustFixSaying("blocker A"));
  assert.equal(await close({ repo, dag, verify, commentOnEpic }), 0);
  const parkedAt = headOf(repo);
  assert.equal(await close({ repo, dag, accept: ["211"], verify, commentOnEpic }), 0);
  assert.notEqual(headOf(repo), parkedAt, "fixture precondition: the acceptance committed its status row");
  assert.equal(verify.calls, 1, "the close re-ran a review only status commits separate from the head");
  const state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "closed");
  assert.equal(state.epicClose.outcome, "completed_with_findings");
  assert.equal(state.epicClose.acceptances["211"].review.ranAt, "2026-08-18T01:00:00.000Z");
  assert.match(readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"), /using it rather than re-running it/);
});

test("a real commit after an acceptance over must-fix, then a new blocker at close, reopens the gate once (#145)", async () => {
  // The hole a recommendation key left: accepted over must-fix(A), the close
  // re-reviewed a moved branch and found must-fix(B), and since the human had
  // "signed over must-fix" the fixer went on to edit what they signed.
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  const commentOnEpic = () => ({ status: 0 });
  const verify = writingVerifier((n) => ({ mustFix: [n === 1 ? "blocker A" : "blocker B"] }));
  assert.equal(await close({ repo, dag, verify, commentOnEpic }), 0);
  // The acceptance of review A is recorded, and the epic is not closed on it
  // yet: that is an acceptance given while other work was still landing.
  const path = join(repo, ".afk", "state.json");
  const seeded = JSON.parse(readFileSync(path, "utf8"));
  const reviewA = seeded.epicClose.verifier;
  seeded.epicClose.acceptances = { 211: {
    at: "2026-08-18T02:00:00.000Z", by: "human", note: null,
    review: { head: reviewA.head, ranAt: reviewA.ranAt, recommendation: "must-fix" },
  } };
  seeded.tasks["211"].lifecycle = "passed";
  writeFileSync(path, JSON.stringify(seeded, null, 2));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "export.js"), "export const rows = [];\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "another lane landed"], { cwd: repo });

  const gates = [];
  assert.equal(await close({ repo, dag, verify, commentOnEpic, supervisor: gateSupervisor(gates) }), 0);
  assert.equal(verify.calls, 2, "a real commit since review A, so the close reviewed again");
  let state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "awaiting_acceptance", "must-fix(B) closed over an acceptance of must-fix(A)");
  assert.equal(state.epicClose.acceptances?.["211"], undefined);
  assert.deepEqual(gates.map((g) => g.taskIds), [["211"]]);

  // No loop: the park keeps review B (only the reopen's status commit since),
  // the human accepts over it, and the close reads the same B back.
  assert.equal(await close({ repo, dag, verify, commentOnEpic }), 0);
  assert.equal(await close({ repo, dag, accept: ["211"], verify, commentOnEpic }), 0);
  assert.equal(verify.calls, 2, "no review after B");
  state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "closed");
  assert.equal(state.epicClose.outcome, "completed_with_findings");
});

// Issue #111: the epic's last integrator pane never exited — one orphan claude
// TUI (and its permission broker) per closed epic under `runtime: herdr`,
// because `closeHerdrLane` reaps lanes at integration and nothing reaped the
// parent workspace hosting the integrator. Two exits must do it: the park at
// `awaiting_acceptance` (the runner leaves, and a human may take days) and the
// close. Neither may do it twice.
test("parking at awaiting_acceptance and closing both reap the integrator pane, once", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed", 211: "passed" },
  );
  const bin = mkdtempSync(join(tmpdir(), "afk-close-herdr-"));
  const log = join(bin, "herdr.log");
  writeFileSync(
    join(bin, "herdr"),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write('{"result":{"type":"ok"}}');
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo, ".afk", "herdr.json"),
    JSON.stringify({ parentWorkspaceId: "wP9", parentPaneId: "wP9:p1", tasks: {} }),
  );
  const hooks = { verify: async ({ root }) => report({ head: headOf(root) }), commentOnEpic: () => ({ status: 0 }) };
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    assert.equal(await close({ repo, dag, ...hooks }), 0);
    assert.equal(readState(repo).epicClose.lifecycle, "awaiting_acceptance");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "agent send-keys wP9:p1 ctrl+c",
      "agent send-keys wP9:p1 ctrl+c",
      "workspace close wP9",
    ]);
    assert.equal(existsSync(join(repo, ".afk", "herdr.json")), false);
    assert.match(
      readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"),
      /herdr: closed 1 pane\(s\), 1 workspace\(s\)/,
    );

    // The acceptance closes the epic. The pane is already gone: no second
    // interrupt, no close of a workspace that does not exist.
    assert.equal(await close({ repo, dag, accept: ["211"], ...hooks }), 0);
    assert.equal(readState(repo).epicClose.lifecycle, "closed");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
  } finally {
    process.env.PATH = previous;
  }
});

test("a must-fix review closes the epic with findings; it can neither complete nor block one", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  const code = await close({
    repo,
    dag,
    verify: async () => report({ mustFix: ["restore the webhook signature check"] }),
    commentOnEpic: () => ({ status: 0 }),
  });
  // Exit 0: the exit code says whether the RUNNER failed. Findings are content.
  assert.equal(code, 0);
  const state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "closed");
  assert.equal(state.epicClose.outcome, "completed_with_findings");
  assert.equal(state.epicClose.verifier.recommendation, "must-fix");
});

test("a reused closeout review does not re-log the model switch its first run already logged", async () => {
  // `runVerifier({ reuse: true })` hands back the report on disk, modelCheck and
  // all. That session ran on an earlier close; logging it again would announce
  // a MODEL SWITCH for an agent that did not run this time.
  const switched = { started: "claude-opus-5-5", observed: { "claude-opus-4-6": 3 }, status: "switched" };
  const logOf = async (extra) => {
    const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
    assert.equal(
      await close({ repo, dag, verify: async () => report({ modelCheck: switched, ...extra }), commentOnEpic: () => ({ status: 0 }) }),
      0,
    );
    return readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
  };
  assert.match(await logOf({}), /MODEL SWITCH — closeout verifier started on claude-opus-5-5, later replies came from claude-opus-4-6 ×3/);
  assert.doesNotMatch(await logOf({ reused: true }), /MODEL SWITCH/);
});

test("an unavailable verifier still closes the epic, and says it did not run", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  assert.equal(
    await close({
      repo,
      dag,
      verify: async () => {
        throw new Error("no claude login");
      },
      commentOnEpic: () => ({ status: 0 }),
    }),
    0,
  );
  const state = readState(repo);
  assert.equal(state.epicClose.outcome, "completed");
  assert.match(state.epicClose.verifier.skipped, /no claude login/);
  assert.match(readFileSync(state.epicClose.closeout.path, "utf8"), /Did not run/);
});

test("a failed task closes the epic incomplete and STILL gets its review", async () => {
  // Reversed deliberately. `verifier did not run — the epic closed incomplete,
  // so there was nothing complete to review` fired on six of six overnight
  // epics, and the runs it silenced shipped a data-loss bug, a bypassable
  // feature gate and a mutex that aborted a live recorder — none catchable by a
  // check suite, all catchable by reading the merged code once. The verifier is
  // the only step that reads the integrated branch against the child issues, so
  // it runs whenever the epic STOPS, labelled with what was outstanding.
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { dependsOn: ["204"] })],
    { 204: "failed", 205: "blocked" },
  );
  stateBelongsToEpic(repo, "203");
  let verifierCalls = 0;
  let sawOutstanding = null;
  assert.equal(
    await close({
      repo,
      dag,
      verify: async ({ outstanding }) => {
        verifierCalls += 1;
        sawOutstanding = outstanding;
        return report({ outstanding });
      },
      commentOnEpic: () => ({ status: 0 }),
    }),
    0,
  );
  assert.equal(verifierCalls, 1);
  assert.deepEqual(sawOutstanding, ["204 did not pass", "205 did not pass"]);
  const state = readState(repo);
  // Advisory to the last: a clean review does not rescue an incomplete epic.
  assert.equal(state.epicClose.outcome, "incomplete");
  assert.equal(state.epicClose.verifier.recommendation, "clean");
  assert.match(state.epicClose.reason, /204, 205 did not pass/);
  assert.match(
    readFileSync(state.epicClose.closeout.path, "utf8"),
    /Reviewed an epic that had stopped short/,
  );
});

test("a failed GitHub comment is a warning, never a halt", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  assert.equal(
    await close({
      repo,
      dag,
      verify: async () => report(),
      commentOnEpic: () => ({ status: 1, stderr: "gh: could not resolve to an Issue" }),
    }),
    0,
  );
  const state = readState(repo);
  assert.equal(state.epicClose.lifecycle, "closed");
  assert.equal(state.epicClose.closeout.issueCommentedAt, null);
  assert.match(state.epicClose.closeout.issueCommentError, /could not resolve/);
});

test("resetting a task reopens a closed epic instead of leaving it terminal", async () => {
  // A close is terminal for the epic, not forever: `afk reset` plus a rerun
  // must be able to reach a close again. 205 is `gate: before` so the reopened
  // run has runnable-by-a-human work and spawns no builder here.
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { humanGated: true })],
    { 204: "passed", 205: "passed" },
  );
  const hooks = { verify: async () => report(), commentOnEpic: () => ({ status: 0 }) };
  await close({ repo, dag, ...hooks });
  const closed = readState(repo);
  assert.equal(closed.epicClose.outcome, "completed");

  const reset = readState(repo);
  reset.tasks["205"].lifecycle = "pending";
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reset));
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  const reopened = readState(repo);
  assert.equal(reopened.epicClose.lifecycle, "open");
  assert.equal(reopened.epicClose.outcome, null);
  assert.equal(reopened.epicClose.history.length, 1);
  assert.equal(reopened.epicClose.history[0].outcome, "completed");
  assert.equal(reopened.epicClose.history[0].closedAt, closed.epicClose.closedAt);
});

test("reopening clears the whole tail of the previous close, not half of it", async () => {
  // Epic #391 was relaunched after a revert. `verifier` and `closeout` were
  // cleared; `fixer` and `reflection` were not — so the reopened run carried a
  // fix report about a commit that had been reverted and a reflection written
  // against the branch before it. Every artifact of a close a human is about to
  // supersede is poison until rewritten.
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { humanGated: true })],
    { 204: "passed", 205: "passed" },
  );
  const hooks = { verify: async () => report(), commentOnEpic: () => ({ status: 0 }) };
  await close({ repo, dag, ...hooks });

  const reset = readState(repo);
  reset.tasks["205"].lifecycle = "pending";
  // Stand in for the previous close's fix pass and reflection, which the
  // stubbed-out close above never produced.
  reset.epicClose.fixer = { status: "ok", fixed: 2, deferred: 11, ranAt: "2026-08-24T08:32:15.534Z" };
  reset.epicClose.reflection = { ok: true, path: "/docs/reflection/x/epic-391.md", bytes: 12687, reused: false };
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reset));

  assert.equal(await close({ repo, dag, ...hooks }), 0);
  const reopened = readState(repo);
  assert.equal(reopened.epicClose.lifecycle, "open");
  assert.equal(reopened.epicClose.verifier, null);
  assert.equal(reopened.epicClose.closeout, null);
  assert.equal(reopened.epicClose.fixer, null, "a fix report describes a tree this run has left behind");
  assert.equal(reopened.epicClose.reflection, null, "so does a reflection");
  // The superseded close is kept, not thrown away — it is the record of what
  // the run was told before the human intervened.
  assert.equal(reopened.epicClose.history[0].fixer.ranAt, "2026-08-24T08:32:15.534Z");
});

test("a closeout that never reached the issue is posted on the next close", async () => {
  // Epic #391's second close rendered its closeout, saved `lifecycle: closed`,
  // and died before the comment — `issueCommentedAt: null`, no "closeout
  // posted" line. The guard on re-entry was `closed`, so the epic was closed
  // forever with its closeout on disk and the issue still carrying run 1's.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  let comments = 0;
  let verifierCalls = 0;
  const verify = async () => { verifierCalls += 1; return report(); };
  assert.equal(
    await close({ repo, dag, verify, commentOnEpic: () => ({ status: 1, stderr: "gh: API rate limit" }) }),
    0,
  );
  const failed = readState(repo);
  assert.equal(failed.epicClose.lifecycle, "closed");
  assert.equal(failed.epicClose.closeout.issueCommentedAt, null);

  // The next run finds a closed epic whose closeout never landed and posts it,
  // without re-reviewing and without moving the close.
  assert.equal(
    await close({ repo, dag, verify, commentOnEpic: () => { comments += 1; return { status: 0 }; } }),
    0,
  );
  const posted = readState(repo);
  assert.equal(comments, 1);
  assert.equal(verifierCalls, 1, "the retry re-posts; it does not re-review");
  assert.equal(posted.epicClose.closedAt, failed.epicClose.closedAt, "the close does not move");
  assert.notEqual(posted.epicClose.closeout.issueCommentedAt, null);
  assert.equal(posted.epicClose.closeout.issueCommentError, undefined);
});

test("the retry refuses to post a closeout the branch has outgrown", async () => {
  // The retry is for a closeout that never landed. If a human commits between
  // the failed post and the next run, the rendered closeout is a confident
  // verdict about an older branch — and with every task still `passed`,
  // `reopenIfWorkResumed` sees no runnable work and never regenerates it. So
  // posting late is the very thing the retry exists to stop, one step along.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  let comments = 0;
  assert.equal(
    await close({ repo, dag, verify: async () => report(), commentOnEpic: () => ({ status: 1, stderr: "no network" }) }),
    0,
  );
  const failed = readState(repo);
  assert.notEqual(failed.epicClose.closeout.head, undefined, "the closeout records the commit it describes");

  // A human lands a fix on the branch.
  writeFileSync(join(repo, "docs", "after.md"), "a human kept working\n");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("add", "-A");
  git("commit", "-m", "a commit the closeout has never seen");

  assert.equal(
    await close({ repo, dag, verify: async () => report(), commentOnEpic: () => { comments += 1; return { status: 0 }; } }),
    0,
  );
  assert.equal(comments, 0, "a stale verdict is worse than a missing one");
  const after = readState(repo);
  assert.equal(after.epicClose.closeout.issueCommentedAt, null);
  const log = readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
  assert.match(log, /the branch has moved since it was written/);
  assert.match(log, /afk verify/, "and it says what to do instead");
});

test("a closed epic whose closeout file is gone re-enters without crashing", async () => {
  // `afk archive` moves `.afk/` away, and a state file can be carried into a
  // checkout that never had the close dir. The retry path exists to be
  // forgiving; reading a file it has not checked for would turn the benign
  // re-entry into a crash on exactly that path.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  assert.equal(
    await close({ repo, dag, verify: async () => report(), commentOnEpic: () => ({ status: 1, stderr: "no network" }) }),
    0,
  );
  const state = readState(repo);
  rmSync(state.epicClose.closeout.path, { force: true });
  assert.equal(await close({ repo, dag, verify: async () => report(), commentOnEpic: () => ({ status: 0 }) }), 0);
  assert.match(
    readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"),
    /epic already closed/,
  );
});

test("a closed epic whose closeout did land is left entirely alone", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  let comments = 0;
  const hooks = {
    verify: async () => report(),
    commentOnEpic: () => { comments += 1; return { status: 0 }; },
  };
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  assert.equal(comments, 1);
  assert.equal(
    readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8").includes("epic already closed"),
    true,
  );
});

test("--accept is refused inside a lane agent's environment", async () => {
  const { repo, dag } = makeRepo([task("211", { gateAfter: true })], { 211: "passed" });
  process.env.RUNNER_TASK_ID = "211";
  try {
    assert.equal(await close({ repo, dag, accept: ["211"] }), 1);
  } finally {
    delete process.env.RUNNER_TASK_ID;
  }
  assert.equal(readState(repo).epicClose, undefined, "a refused acceptance writes nothing");
});

test("a state file written before epicClose existed is read, extended, and not corrupted", async () => {
  // Forward safety. `.afk/state.json` is written by runs that last hours; one
  // started under the previous runner must survive being read by this one.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  const before = readState(repo);
  assert.equal("epicClose" in before, false, "the fixture is a pre-change state file");
  // A key this runner has never heard of stands in for the reverse direction:
  // a state file written by a LATER runner, read by this one.
  before.somethingThisRunnerHasNeverHeardOf = { keep: "me" };
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(before, null, 2));

  assert.equal(
    await close({ repo, dag, verify: async () => report(), commentOnEpic: () => ({ status: 0 }) }),
    0,
  );
  const after = readState(repo);
  assert.deepEqual(after.somethingThisRunnerHasNeverHeardOf, { keep: "me" });
  assert.equal(after.startedAt, before.startedAt);
  assert.deepEqual(after.tasks["204"].lifecycle, "passed");
  assert.equal(after.epicClose.lifecycle, "closed");
});

test("the closeout renders without a verifier report and without gates", () => {
  const dag = dagOf(task("204"));
  const state = {
    ...stateOf({ 204: "passed" }),
    epicClose: {
      lifecycle: "closed",
      outcome: "incomplete",
      reason: "task(s) 204 did not pass",
      closedAt: "2026-08-18T02:00:00.000Z",
      acceptances: {},
      verifier: { skipped: "nothing complete to review" },
    },
  };
  const markdown = renderCloseout(dag, state, null);
  assert.match(markdown, /# Epic closeout — Stripe subscriptions/);
  assert.match(markdown, /nothing complete to review/);
  assert.equal(markdown.includes("Human acceptance"), false);
});

// ---------------------------------------------------------------------------
// The closeout reconciles the fix pass that ran in the same minute
// ---------------------------------------------------------------------------
//
// `renderVerifierMarkdown` renders the PRE-fix review. Real runs posted a
// closeout listing blockers as unticked that the fixer had repaired seconds
// earlier, so the human read a to-do list of work already done.

const closedState = () => ({
  ...stateOf({ 204: "passed" }),
  epicClose: {
    lifecycle: "closed",
    outcome: "completed_with_findings",
    reason: "every task passed and every gate was accepted",
    closedAt: "2026-08-18T02:00:00.000Z",
    acceptances: {},
  },
});
const reviewWith = (...mustFix) => ({
  version: 1,
  status: "ok",
  ranAt: "2026-08-18T01:00:00.000Z",
  branch: "feat/203-stripe",
  baseBranch: "main",
  summary: "reviewed",
  criteria: [],
  findings: [],
  mustFix,
  problems: [],
  prose: "",
});

test("the closeout ticks the must-fix items the fix pass repaired", () => {
  const report = reviewWith("drop the shared config mutation", "narrow the fixer deny list");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }],
    fixed: [
      { id: "F1", title: "drop the shared config mutation", detail: "removed the assignment", files: [] },
      { id: "F2", title: "narrow the fixer deny list", detail: "scoped to scripts/", files: [] },
    ],
    deferred: [],
  };
  const markdown = renderCloseout(dagOf(task("204")), closedState(), report, fixReport);
  assert.equal(markdown.includes("- [ ] "), false, "nothing the fixer repaired renders as outstanding");
  assert.match(markdown, /- \[x\] drop the shared config mutation — fixed in this run/);
  assert.match(markdown, /removed the assignment/);
});

test("a deferred must-fix item still renders as outstanding", () => {
  const report = reviewWith("drop the shared config mutation", "narrow the fixer deny list");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }],
    fixed: [{ id: "F1", title: "drop the shared config mutation", detail: "done", files: [] }],
    // No `kind`: the field is being added by another lane and must not be required.
    deferred: [{ id: "F2", title: "narrow the fixer deny list", reason: "needs a product decision" }],
  };
  const markdown = renderCloseout(dagOf(task("204")), closedState(), report, fixReport);
  assert.match(markdown, /- \[x\] drop the shared config mutation/);
  assert.match(markdown, /- \[ \] narrow the fixer deny list/);
});

test("the closeout is unchanged when no fix report is passed", () => {
  const dag = dagOf(task("204"));
  const report = reviewWith("drop the shared config mutation");
  const three = renderCloseout(dag, closedState(), report);
  assert.match(three, /- \[ \] drop the shared config mutation/);
  // A fix pass that fell over, or one that fixed nothing, reconciles to nothing.
  for (const fixReport of [null, { status: "agent_failed", items: [{ id: "F1" }], fixed: [], deferred: [] }]) {
    assert.equal(renderCloseout(dag, closedState(), report, fixReport).includes("- [ ] drop the shared config mutation"), true);
  }
});

test("ensureEpicClose is idempotent and never overwrites an existing record", () => {
  const state = { epicClose: { lifecycle: "closed", acceptances: { 211: { by: "human", at: "x" } } } };
  assert.equal(ensureEpicClose(state).lifecycle, "closed");
  assert.equal(ensureEpicClose({}).lifecycle, "open");
});

// ---------------------------------------------------------------------------
// The supervisor, wired — advisory, off the critical path, never fatal
// ---------------------------------------------------------------------------
//
// The seam is `runAuto({ supervisor, notify })`: the module is injected, so
// these cost no session. What is being pinned is the authority split — the
// supervisor observes and proposes, and the runner prints. Nothing here may
// ever spawn a proposed command.

const autoLog = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");

const fakeSupervisor = (calls, decision = {}) => ({
  onEpicEnded: async (context) => {
    calls.push(["onEpicEnded", context]);
    return {
      classification: "epic_done",
      confidence: "high",
      recommendation: "notify_human",
      answer: null,
      actions: [{ command: "status", why: "see the tally" }],
      ...decision,
    };
  },
  supervisorNotification: () => ({ title: "AFK", message: "epic finished" }),
  supervisorCommands: (_decision, { dagPath }) => ({
    commands: [{ argv: ["status"], why: dagPath ? `dag ${dagPath}` : null }],
    refused: [],
  }),
});

test("the supervisor observes the epic ending and its commands are printed, not run", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  const calls = [];
  const notes = [];
  const code = await close({
    repo,
    dag,
    supervisor: fakeSupervisor(calls),
    notify: (title, message) => notes.push([title, message]),
    dagPath: "dag.json",
    verify: async () => report(),
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "onEpicEnded");
  assert.equal(calls[0][1].consult, "auto");
  assert.equal(calls[0][1].tally.status, "complete");
  assert.deepEqual(notes, [["AFK", "epic finished"]]);
  const log = autoLog(repo);
  assert.match(log, /supervisor \(onEpicEnded\) — `epic_done`/);
  assert.match(log, /proposes `afk status` — dag dag\.json \(advisory; not run\)/);
});

test("AFK_SUPERVISOR=off consults nothing at all", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  const calls = [];
  const previous = process.env.AFK_SUPERVISOR;
  process.env.AFK_SUPERVISOR = "off";
  try {
    await close({
      repo,
      dag,
      supervisor: fakeSupervisor(calls),
      notify: () => {},
      verify: async () => report(),
      commentOnEpic: () => ({ status: 0 }),
    });
  } finally {
    if (previous === undefined) delete process.env.AFK_SUPERVISOR;
    else process.env.AFK_SUPERVISOR = previous;
  }
  assert.equal(calls.length, 0);
});

test("a supervisor that throws costs the run one log line and nothing else", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  const code = await close({
    repo,
    dag,
    supervisor: {
      onEpicEnded: async () => {
        throw new Error("no session left");
      },
    },
    notify: () => {},
    verify: async () => report(),
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  assert.match(autoLog(repo), /supervisor \(onEpicEnded\) failed; ignored — no session left/);
  assert.equal(readState(repo).epicClose.lifecycle, "closed");
});

// ---------------------------------------------------------------------------
// The lifecycle, rendered — `afk status` and the dashboard
// ---------------------------------------------------------------------------
//
// One renderer for both. Two would drift, and the state they would drift about
// is "is this run finished", which is the one an operator acts on.

test("epicCloseSummary names the ids awaiting acceptance and the command to release them", () => {
  const dag = dagOf(task("204"), task("211", { gateAfter: true, dependsOn: ["204"] }));
  const state = {
    tasks: { 204: { lifecycle: "passed" }, 211: { lifecycle: "passed" } },
    epicClose: { lifecycle: "awaiting_acceptance", outcome: null, reason: "211 awaits a human", acceptances: {} },
  };
  const summary = epicCloseSummary(state, dag);
  assert.equal(summary.lifecycle, "awaiting_acceptance");
  assert.deepEqual(summary.outstanding, ["211"]);
  assert.match(summary.summary, /--accept=211/);
  assert.match(summary.summary, /211 awaits a human/);
});

test("epicCloseSummary reports a closed epic with its outcome and the review's verdict", () => {
  const dag = dagOf(task("204"));
  const state = {
    tasks: { 204: { lifecycle: "passed" } },
    epicClose: {
      lifecycle: "closed",
      outcome: "completed_with_findings",
      reason: null,
      acceptances: {},
      verifier: { skipped: false, recommendation: "must-fix", blocking: ["a", "b"] },
    },
  };
  const summary = epicCloseSummary(state, dag);
  assert.match(summary.summary, /epic: closed \(completed_with_findings\)/);
  assert.match(summary.summary, /closeout review: must-fix \(2 must-fix\)/);
});

test("epicCloseSummary is null before an epic close record exists", () => {
  // A --dag= run that never opened an epic must render nothing, not "epic: open".
  assert.equal(epicCloseSummary({}, dagOf(task("204"))), null);
  assert.equal(epicCloseSummary({ tasks: {} }), null);
});

test("epicCloseSummary counts an acceptance only where acceptedGateIds does", () => {
  // It reuses the same derivation, so a hand-edited state file that grants an
  // acceptance the scheduler would refuse cannot make the display say accepted.
  const dag = dagOf(task("211", { gateAfter: true }));
  const forged = {
    tasks: { 211: { lifecycle: "failed" } },
    epicClose: { lifecycle: "open", outcome: null, acceptances: { 211: { by: "human", at: "2026-08-18T00:00:00Z" } } },
  };
  assert.deepEqual(epicCloseSummary(forged, dag).accepted, [], "a task that is not passed has no acceptance");
  assert.deepEqual(epicCloseSummary(forged, dag).outstanding, ["211"]);
});

// ---------------------------------------------------------------------------
// The tick survives dedup — end to end, the way a real report reaches it
// ---------------------------------------------------------------------------
//
// A defect raised BOTH as a must-fix line and as a finding is the common shape,
// and it is exactly what `dedupeItems` merges. The merged item has to keep the
// must-fix title, because that is the string `renderVerifierMarkdown` renders
// verbatim into the `- [ ]` line this reconciles against.

test("a must-fix merged with a finding still ticks in the closeout", async () => {
  const { fixerItems, normalizeFixerReport } = await import("./fixer.mjs");
  const target = "scripts/roles.mjs:479";
  const mustFix = `${target} — roleFor mutates the shared config object`;
  const report = {
    ...reviewWith(mustFix),
    findings: [{
      axis: "spec", severity: "major", title: "roleFor mutates the shared config object",
      detail: "the role object is shared across lanes", file: target,
    }],
  };
  const items = fixerItems(report);
  assert.equal(items.length, 1, "the must-fix and the finding are one defect");
  const fixReport = {
    ...normalizeFixerReport({ fixed: [{ id: "F1", detail: "cloned the config", files: [] }] }, items),
    status: "ok",
    items,
    problems: [],
  };
  // The same line verifier.mjs renders: `- [ ] ` + the must-fix string, verbatim.
  const markdown = renderCloseout(dagOf(task("204")), closedState(), report, fixReport);
  assert.equal(markdown.includes(`- [ ] ${mustFix}`), false, "the repaired blocker must not read as outstanding");
  assert.ok(markdown.includes(`- [x] ${mustFix} — fixed in this run: cloned the config`), markdown);
});

test("the closeout's 'left for you' count excludes no-op deferrals", () => {
  const report = reviewWith("one", "two", "three");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }],
    fixed: [{ id: "F1", title: "one", detail: "d", files: [] }],
    deferred: [
      { id: "F2", title: "two", reason: "already met on the branch", kind: "no_op" },
      // No `kind`: a report written before the field existed must still count right.
      { id: "F3", title: "three", reason: "needs a product decision" },
    ],
  };
  const markdown = renderCloseout(dagOf(task("204")), closedState(), report, fixReport);
  assert.match(markdown, /1 of 3 item\(s\) fixed in this run; 1 left for you/);
});

// ---------------------------------------------------------------------------
// The fix-pass line and `renderFixerOutcome` count the same run
// ---------------------------------------------------------------------------
//
// Both are rendered from ONE report, minutes apart, onto the epic issue and the
// log. `report.fixed.length` counts restatements as separate fixes and
// `report.notQueued` findings as nothing at all, so the two disagreed.

/** The `_Fix pass: …_` line of a rendered closeout, or "" when none. */
const fixPassLine = (markdown) =>
  markdown.split("\n").find((line) => line.startsWith("_Fix pass:")) ?? "";
const numbersOf = (line) => (line.match(/\d+/g) ?? []).map(Number);

test("declared duplicates on the fixed path count once, not once each", () => {
  const report = reviewWith("one", "two", "three");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }],
    fixed: [
      { id: "F1", title: "one", detail: "d", files: [] },
      { id: "F2", title: "two", detail: "d", files: [] },
      // The same defect as F1, said twice by the verifier.
      { id: "F3", title: "three", detail: "d", files: [], duplicateOf: "F1" },
    ],
    deferred: [],
  };
  const line = fixPassLine(renderCloseout(dagOf(task("204")), closedState(), report, fixReport));
  assert.match(line, /2 of 3 item\(s\) fixed in this run; 0 left for you \(1 restating another item\)/);
  assert.equal(line.includes("3 of 3"), false, line);
});

test("findings the severity filter never queued are not reported as nothing outstanding", () => {
  const report = reviewWith("one");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }],
    fixed: [{ id: "F1", title: "one", detail: "d", files: [] }],
    deferred: [],
    notQueued: 6,
  };
  const line = fixPassLine(renderCloseout(dagOf(task("204")), closedState(), report, fixReport));
  assert.match(line, /6 minor finding\(s\) never queued and still open/);
});

test("a fix report with neither duplicateOf nor notQueued renders exactly as it did", () => {
  const report = reviewWith("one", "two", "three");
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }],
    fixed: [{ id: "F1", title: "one", detail: "d", files: [] }],
    deferred: [
      { id: "F2", title: "two", reason: "already met on the branch", kind: "no_op" },
      { id: "F3", title: "three", reason: "needs a product decision" },
    ],
  };
  const line = fixPassLine(renderCloseout(dagOf(task("204")), closedState(), report, fixReport));
  // Byte-identical to the line this code shipped before duplicates and
  // never-queued findings existed — no-ops stay uncounted and unmentioned.
  assert.equal(line, "_Fix pass: 1 of 3 item(s) fixed in this run; 1 left for you._");
});

test("the fix-pass line counts the rule and standard lessons of distinct fixes (#153)", () => {
  const report = reviewWith("one", "two", "three", "four");
  const rule = { class: "rule", id: "r", file: "f", redOn: "red.ts" };
  const fixReport = {
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }, { id: "F4" }],
    fixed: [
      { id: "F1", title: "one", detail: "d", files: [], lesson: rule },
      { id: "F2", title: "two", detail: "d", files: [], lesson: { class: "standard", line: "l" } },
      { id: "F3", title: "three", detail: "d", files: [], lesson: { class: "none", reason: "r" } },
      // A restatement shows its primary's rule; it is not a second lesson.
      { id: "F4", title: "four", detail: "d", files: [], duplicateOf: "F1", lesson: rule },
    ],
    deferred: [],
  };
  const line = fixPassLine(renderCloseout(dagOf(task("204")), closedState(), report, fixReport));
  assert.match(line, /; lessons: 1 rule, 1 standard/, line);
});

test("the real epic 56 report renders the same numbers in the closeout and the log", async () => {
  const { renderFixerOutcome } = await import("./fixer.mjs");
  // The REAL fixer report from epic 56 on gitproj-demo, committed under
  // scripts/fixtures/ with its provenance — see that directory's README.
  const artifact = fixture("epic-56/fixer/56/report.json");
  const live = JSON.parse(readFileSync(artifact, "utf8"));
  // The run as it should have been recorded: the model wrote the restatements
  // in its prose ("Same README change as F1") with nowhere in the schema to say
  // so, and the severity filter dropped six minor findings.
  const declared = { F3: "F1", F4: "F2", F5: "F2" };
  const fixReport = {
    ...live,
    fixed: live.fixed.map((entry) => ({
      ...entry,
      ...(declared[entry.id] ? { duplicateOf: declared[entry.id] } : {}),
    })),
    notQueued: 6,
  };
  const report = reviewWith(...live.fixed.map((entry) => entry.title));
  const line = fixPassLine(renderCloseout(dagOf(task("204")), closedState(), report, fixReport));
  assert.match(line, /2 of 5 item\(s\) fixed in this run; 0 left for you \(3 restating another item\); 6 minor finding\(s\) never queued and still open\./);
  // Every number in the epic comment, in order, is a number the log line says.
  assert.deepEqual(numbersOf(line), numbersOf(renderFixerOutcome(fixReport)));
  assert.deepEqual(numbersOf(line), [2, 5, 0, 3, 6]);
});

// ---------------------------------------------------------------------------
// The circuit breaker halts on ANY mix of failures
// ---------------------------------------------------------------------------
//
// A lane that never reached the API is a harness fault, not a bad ticket, so it
// must not charge the ticket streak. But `looksLikeInfra` needs EVERY recent
// failure to be infra-shaped, so counting infra deaths nowhere left a run that
// began with one real failure burning every remaining lane with no halt.

test("one real failure beside one infra death does not halt the run", async () => {
  const { breakerVerdict } = await import("./auto.mjs");
  assert.equal(breakerVerdict({
    recentFailures: [{ taskId: "204", durationMs: 400_000 }, { taskId: "205", neverReachedApi: true }],
    consecutiveFailures: 1,
    infraFailures: 1,
  }), null);
});

test("no mix of failures runs unbounded", async () => {
  const { breakerVerdict } = await import("./auto.mjs");
  // Every ordering of up to four failures halts within four.
  for (const width of [1, 2, 3, 4]) {
    for (let mask = 0; mask < 2 ** width; mask += 1) {
      const recentFailures = [];
      let consecutiveFailures = 0;
      let infraFailures = 0;
      let halted = null;
      for (let i = 0; i < width && !halted; i += 1) {
        const infra = Boolean(mask & (1 << i));
        recentFailures.push({ taskId: `2${i}`, durationMs: 400_000, ...(infra ? { neverReachedApi: true } : {}) });
        if (infra) infraFailures += 1;
        else consecutiveFailures += 1;
        halted = breakerVerdict({ recentFailures, consecutiveFailures, infraFailures });
      }
      if (width < 3) continue;
      assert.ok(halted, `mask ${mask} of width ${width} never halted`);
    }
  }
  // The killer sequence from the review: one real failure, then nothing but
  // dead lanes. It must halt, and it must halt blaming the harness.
  assert.deepEqual(breakerVerdict({
    recentFailures: [
      { taskId: "204", durationMs: 400_000 },
      { taskId: "205", neverReachedApi: true },
      { taskId: "206", neverReachedApi: true },
    ],
    consecutiveFailures: 1,
    infraFailures: 2,
  }), { verdict: "infra", kind: "harness" });
});

// ---------------------------------------------------------------------------
// The supervisor's observations survive the run, and a `salvage` verdict names
// work a human can find.
//
// Epic 62 on the gitproj-demo playground produced two `salvage` verdicts — one
// per deliberately-ungateable lane — and then an `epic_ended` verdict. All
// three were written to `state.supervisor`, a single object, so the two that
// pointed at finished work on disk were gone before anyone read them. The
// worktrees survived (only a `passed` integration calls `removeTaskWorktree`)
// and nothing anywhere said so.
//
// The fixtures below are the REAL decision records from that run, committed
// under scripts/fixtures/ with their provenance — an invented fixture agrees
// with whoever invented it, and reading them out of the playground meant they
// vanished the moment it was archived.

const decisionOf = (dir) =>
  JSON.parse(readFileSync(fixture(`epic-62/supervisor/${dir}/decision.json`), "utf8"));

test("every supervisor observation survives the run (epic 62's two salvage verdicts)", () => {
  const decisions = ["59-5e90cfff9f1a", "60-4aa81fd1c1be", "62-44b8a1b264dc"]
    .map(decisionOf);
  assert.equal(decisions.length, 3, "expected epic 62's three supervisor decisions");
  let log;
  let latest = null;
  for (const decision of decisions) {
    const record = supervisorRecord(decision, [], { at: decision.at ?? "2026-08-24T02:59:31.394Z" });
    const appended = appendSupervisorObservation(log, record);
    assert.equal(appended.dropped, 0);
    log = appended.list;
    latest = record ?? latest;
  }
  // The bug: a single object kept only the last of the three.
  assert.equal(log.length, 3);
  assert.deepEqual(
    log.filter((entry) => entry.recommendation === "salvage").map((entry) => entry.taskId),
    ["59", "60"],
  );
  // And the backward-compatible read stays the latest record as an object, so
  // `supervisorAdvice` in scripts/scheduler.mjs keeps working unchanged.
  assert.equal(latest.event, "epic_ended");
  assert.deepEqual(supervisorAdvice({ supervisor: latest, tasks: {} }).length > 0, true);
});

test("the supervisor log is bounded, and says how many it dropped", () => {
  const record = (n) => ({ at: `t${n}`, event: "lane_failed", taskId: String(n), recommendation: "salvage", proposals: [] });
  let list;
  let dropped = 0;
  for (let n = 0; n < 5; n += 1) {
    const appended = appendSupervisorObservation(list, record(n), 3);
    list = appended.list;
    dropped += appended.dropped;
  }
  assert.equal(list.length, 3);
  // The OLDEST go, and the count is returned rather than swallowed — the caller
  // prints it. Silent loss is the bug this whole test file section exists for.
  assert.deepEqual(list.map((entry) => entry.taskId), ["2", "3", "4"]);
  assert.equal(dropped, 2);
  // A null record (an `idle` judgment) is not an observation and changes nothing.
  assert.deepEqual(appendSupervisorObservation(list, null, 3), { list, dropped: 0 });
  assert.equal(SUPERVISOR_LOG_MAX > 0, true);
});

test("a salvage lane is named, with its worktree and its uncommitted files", () => {
  const state = {
    salvage: {
      60: {
        at: "2026-08-24T02:57:00.000Z",
        worktree: "/tmp/worktrees/gitproj-demo/60",
        branch: "afk/task-60",
        paths: ["docs/changelog.md"],
        why: "the required check `node -e \"process.exit(1)\"` can never pass",
      },
    },
  };
  const lines = salvageLines(state);
  assert.match(lines[0], /supervisor recommends keeping 1 failed lane/);
  // Nothing is merged for the human, and the block says so where they read it.
  assert.match(lines[1], /Nothing was committed, merged or opened as a PR/);
  assert.equal(lines.some((line) => line.includes("/tmp/worktrees/gitproj-demo/60")), true);
  assert.equal(lines.some((line) => line.includes("uncommitted: docs/changelog.md")), true);
  assert.equal(salvageLines({}).length, 0);
  assert.equal(salvageLines({ salvage: {} }).length, 0);
  // And it reaches the closeout, not only the halt line.
  const markdown = renderCloseout(dagOf(task("204")), { ...state, ...closedState() }, null);
  assert.match(markdown, /## Salvageable work/);
  assert.match(markdown, /\/tmp\/worktrees\/gitproj-demo\/60/);
  assert.equal(renderCloseout(dagOf(task("204")), closedState(), null).includes("Salvageable work"), false);
});

// ---------------------------------------------------------------------------
// The three-stage header — oversight, not a verdict
// ---------------------------------------------------------------------------
//
// Epic #671 (2026-09-18) closed `completed` on a branch nothing had reviewed:
// the verifier returned `unparseable`, so `fixerItems` produced an empty work
// list and the fixer never ran, so the fix gate had no commit to gate. All
// three facts were in the document and none was above the fold — it opened
// with "every task passed and every gate was accepted". These tests pin the
// header that says so first, and they are written against that run's shape.

const unusableReview = {
  version: 1,
  status: "unparseable",
  ranAt: "2026-09-18T19:18:35.623Z",
  branch: "feat/671-agents-folderless-dirs",
  baseBranch: "staging",
  summary: "",
  criteria: [],
  findings: [],
  mustFix: [],
  problems: ["the verifier produced no fenced `json` report block"],
  prose: "a prose review nobody can parse",
  skipped: [],
};

test("a verifier that returned no usable report says so in the first table", () => {
  const header = renderStageHeader({ fixGate: { status: "no_commit" } }, unusableReview, null);
  assert.match(header, /1\. Verifier \| ❌ \*\*no usable report\*\* \(`unparseable`\)/);
  assert.match(header, /nothing below was reviewed/);
});

test("a fixer that never ran is distinguished from one that found nothing", () => {
  const never = renderStageHeader({}, unusableReview, null);
  assert.match(never, /2\. Fixer \| ⛔ \*\*did not run\*\*/);
  assert.match(never, /the review was unusable, so no fix list could be built/);

  const nothing = renderStageHeader({}, reviewWith(), { status: "nothing_to_do", items: [] });
  const fixerRow = nothing.split("\n").find((line) => line.startsWith("| 2. Fixer"));
  assert.match(fixerRow, /➖ nothing to fix/);
  assert.doesNotMatch(fixerRow, /did not run/);
});

test("the header never claims the epic is good, only what executed", () => {
  const header = renderStageHeader({ fixGate: { status: "no_commit" } }, unusableReview, null);
  assert.match(header, /All three are advisory/);
  assert.match(header, /None of them can mark a task passed/);
});

test("a no-commit fix gate reads as 'nothing to gate', not as a pass", () => {
  const header = renderStageHeader({ fixGate: { status: "no_commit" } }, reviewWith(), null);
  assert.match(header, /3\. Fix gate \| ➖ no commit to gate/);
  assert.doesNotMatch(header, /3\. Fix gate \| ✅/);
});

test("a red fix gate is reported as red and as advisory", () => {
  const header = renderStageHeader(
    { fixGate: { status: "failed", failingCommand: "npm run typecheck", checks: ["npm run typecheck"] } },
    reviewWith(),
    null,
  );
  assert.match(header, /3\. Fix gate \| ❌ \*\*failed\*\*/);
  assert.match(header, /npm run typecheck/);
  assert.match(header, /the branch tip is unverified/);
});

test("the verifier row carries the skipped-gate count, so a sandboxed green cannot read as green", () => {
  const sandboxed = { ...reviewWith(), skipped: [{ tool: "tests", reason: "no node_modules" }, { tool: "build", reason: "network denied" }] };
  const header = renderStageHeader({}, sandboxed, null);
  assert.match(header, /⚠️/);
  assert.match(header, /2 gate\(s\) did not run in the review sandbox/);
});

test("the closeout leads with the stages, before anything it concluded", () => {
  const markdown = renderCloseout(dagOf(task("204")), closedState(), unusableReview, null);
  assert.ok(
    markdown.indexOf("## Closeout stages") < markdown.indexOf("## Tasks"),
    "the stage table comes before the task list",
  );
  assert.ok(
    markdown.indexOf("## Closeout stages") < markdown.indexOf("## Verifier"),
    "the stage table comes before the review",
  );
});

// ---------------------------------------------------------------------------
// #145 — what the fix pass leaves out still reaches a human
// ---------------------------------------------------------------------------

test("never-queued minors are posted once, as an uncollapsed checklist on the epic issue", async () => {
  // #782 closed with five minors whose only home was a collapsed <details> on a
  // PR that gets merged and forgotten.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const posted = [];
  assert.equal(
    await close({
      repo,
      dag,
      verify: async () => report({
        findings: [
          { axis: "spec", severity: "minor", title: "stale link status after unlink", detail: null, file: "src/link.ts" },
          { axis: "standards", severity: "minor", title: "unmemoized detectPlatform", detail: null, file: null },
        ],
      }),
      commentOnEpic: ({ body }) => {
        posted.push(body);
        return { status: 0 };
      },
    }),
    0,
  );
  const minors = posted.filter((body) => /never queued/.test(body) && body.startsWith("### "));
  assert.equal(minors.length, 1, "one comment, not one per finding");
  assert.match(minors[0], /^- \[ \] \*\*stale link status after unlink\*\* \(`src\/link\.ts`\) — spec$/m);
  assert.match(minors[0], /^- \[ \] \*\*unmemoized detectPlatform\*\* — standards$/m);
  assert.doesNotMatch(minors[0], /<details>/);
  assert.ok(readState(repo).epicClose.minorsComment.postedAt);
});

test("a close with no minors posts no minors comment", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const posted = [];
  await close({ repo, dag, verify: async () => report(), commentOnEpic: ({ body }) => { posted.push(body); return { status: 0 }; } });
  assert.equal(posted.length, 1, "the closeout, and nothing else");
  assert.equal(readState(repo).epicClose.minorsComment ?? null, null);
});

test("a failed task's criteria never reach the fixer, and the closeout names its retained branch and checks", async () => {
  // #803: the fixer rebuilt a failed lane's whole feature on the run branch.
  const { repo, dag } = makeRepo([task("204"), task("205")], { 204: "passed", 205: "failed" });
  const runDir = join(repo, ".afk", "runs", "205", "builder-2");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "verification.json"), JSON.stringify({
    branch: "afk/task-205",
    checks: [{ command: "npm run lint", code: 0 }, { command: "npm test", code: 1 }],
  }));
  let fixerCalls = 0;
  assert.equal(
    await close({
      repo,
      dag,
      verify: async () => report({
        criteria: [{ id: "205.1", taskId: "205", source: "task", text: "the drawer opens", verdict: "unmet", evidence: null }],
      }),
      fixAgent: async () => { fixerCalls += 1; return { status: 0 }; },
      commentOnEpic: () => ({ status: 0 }),
    }),
    0,
  );
  assert.equal(fixerCalls, 0, "205's criterion was the only item, and 205 never passed");
  const fix = JSON.parse(readFileSync(join(repo, ".afk", "fixer", "203", "report.json"), "utf8"));
  assert.equal(fix.status, "nothing_to_do");
  const state = readState(repo);
  const closeout = readFileSync(state.epicClose.closeout.path, "utf8");
  assert.match(closeout, /## Tasks that did not pass/);
  assert.match(closeout, /\*\*205\*\* `failed` — branch `afk\/task-205`, builder attempt 2: ✅ `npm run lint` · ❌ `npm test` \(exit 1\)/);
});

test("an unparseable review still gets a fix pass over what its prose recovered", async () => {
  // #865: seven numbered findings in prose, and the fixer skipped: "the review
  // was unusable, so no fix list could be built".
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  let handed = null;
  await close({
    repo,
    dag,
    verify: async () => report({
      status: "unparseable",
      findings: [{ axis: "standards", severity: "unknown", title: "a bare catch hides the network error", detail: null, file: null, recovered: "prose" }],
    }),
    fixAgent: async ({ promptPath, streamPath }) => {
      handed = readFileSync(promptPath, "utf8");
      writeFileSync(streamPath, '```json\n{"summary":"s","fixed":[],"deferred":[{"id":"F1","reason":"needs a decision"}]}\n```\n');
      return { status: 0 };
    },
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.match(handed ?? "", /a bare catch hides the network error/);
  assert.equal(readState(repo).epicClose.fixer.items, 1);
});

test("the closeout's fixer row counts the unknown criteria the pass was never handed", () => {
  // #143: `run.log:85` counted the 9 minors #760 never queued and said nothing
  // about its 4 unchecked criteria.
  const nothing = renderStageHeader({}, reviewWith(), { status: "nothing_to_do", items: [], notQueued: 9, unknownNotQueued: 4 });
  assert.match(nothing, /9 minor finding\(s\) never queued and still open; 4 unknown criteria never queued/);
  const ran = renderStageHeader({}, reviewWith(), { status: "ok", items: [{ id: "F1" }], fixed: [], deferred: [], unknownNotQueued: 4 });
  assert.match(ran, /\(4 unknown criteria never queued\)/);
});

// ---------------------------------------------------------------------------
// #149 review follow-up — the minors comment survives a failed post, a crash
// and a reopen; the closeout does not contradict itself
// ---------------------------------------------------------------------------

const minorFindings = [
  { axis: "spec", severity: "minor", title: "stale link status after unlink", detail: null, file: "src/link.ts" },
];
const isMinors = (body) => /^### \d+ minor finding/.test(body);

test("a minors comment that failed to post is retried when the closed epic is re-entered", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const verify = async () => report({ findings: minorFindings });
  await close({ repo, dag, verify, commentOnEpic: ({ body }) => (isMinors(body) ? { status: 1, stderr: "HTTP 502" } : { status: 0 }) });
  assert.equal(readState(repo).epicClose.minorsComment.postedAt, null);
  const posted = [];
  await close({ repo, dag, verify, commentOnEpic: ({ body }) => { posted.push(body); return { status: 0 }; } });
  assert.equal(posted.filter(isMinors).length, 1, "the minors are retried");
  assert.equal(posted.length, 1, "and the closeout, which did land, is not posted again");
  assert.ok(readState(repo).epicClose.minorsComment.postedAt);
});

test("a minors comment the close never reached is still posted on re-entry", async () => {
  // A crash between the closeout's post and the minors' post: the minors are
  // recorded as owed before either is posted.
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const verify = async () => report({ findings: minorFindings });
  await close({ repo, dag, verify, commentOnEpic: () => ({ status: 0 }) });
  const state = readState(repo);
  const owed = state.epicClose.minorsComment;
  assert.ok(owed.path && existsSync(owed.path), "the checklist is on disk before it is posted");
  state.epicClose.minorsComment = { ...owed, postedAt: null };
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(state));
  const posted = [];
  await close({ repo, dag, verify, commentOnEpic: ({ body }) => { posted.push(body); return { status: 0 }; } });
  assert.equal(posted.filter(isMinors).length, 1);
});

test("a reopen archives the minors comment, and the next close edits it in place", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { humanGated: true })],
    { 204: "passed", 205: "passed" },
  );
  stateBelongsToEpic(repo, "203");
  const url = "https://github.com/o/r/issues/203#issuecomment-555";
  const verify = async () => report({ findings: minorFindings });
  const calls = [];
  const commentOnEpic = (args) => {
    calls.push(args);
    return { status: 0, stdout: isMinors(args.body) && !args.editUrl ? `${url}\n` : "" };
  };
  await close({ repo, dag, verify, commentOnEpic });
  assert.equal(readState(repo).epicClose.minorsComment.url, url);

  const reset = readState(repo);
  reset.tasks["205"].lifecycle = "pending";
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reset));
  await close({ repo, dag, verify, commentOnEpic });
  const reopened = readState(repo);
  assert.equal(reopened.epicClose.minorsComment, null);
  assert.equal(reopened.epicClose.history.at(-1).minorsComment.url, url, "archived, not dropped");

  reopened.tasks["205"].lifecycle = "passed";
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reopened));
  calls.length = 0;
  await close({ repo, dag, verify, commentOnEpic });
  const minors = calls.filter((args) => isMinors(args.body));
  assert.equal(minors.length, 1);
  assert.equal(minors[0].editUrl, url, "the recorded comment is edited, not joined by a second checklist");
});

test("an unparseable review whose prose was recovered does not claim nothing below was reviewed", () => {
  const recovered = {
    ...unusableReview,
    findings: [{ axis: "spec", severity: "unknown", title: "t", detail: null, file: null, recovered: "prose" }],
  };
  const header = renderStageHeader({}, recovered, { status: "ok", items: [{ id: "F1" }], fixed: [], deferred: [] });
  assert.doesNotMatch(header, /nothing below was reviewed/);
  assert.match(header, /1\. Verifier \| ❌ \*\*no usable report\*\* \(`unparseable`\) \| .* — no structured review; 1 finding\(s\) below were recovered from its prose/);
});

test("a check-only criterion the fixer found met renders as met in the closeout, with its output", () => {
  const dag = dagOf(task("818"));
  const state = stateOf({ 818: "passed" }, { outcome: "completed", lifecycle: "closed" });
  const review = report({
    criteria: [{ id: "818.3", taskId: "818", source: "task", text: "break the hint, watch it fail", verdict: "unknown", evidence: "mutation denied in this session" }],
  });
  const fix = {
    status: "ok",
    items: [{ id: "F1", title: "break the hint, watch it fail", checkOnly: true, criterionId: "818.3" }],
    fixed: [],
    deferred: [{ id: "F1", title: "break the hint, watch it fail", reason: "already met — `npm test -- hint` failed 1 with the span removed", kind: "no_op" }],
  };
  const markdown = renderCloseout(dag, state, review, fix);
  assert.match(markdown, /\| ✅ \| break the hint, watch it fail \| #818 \| met by the closeout fix pass, not re-reviewed: `npm test -- hint` failed 1/);
});

test("the stage header counts a check-only criterion the fixer found met, as the body does", () => {
  const dag = dagOf(task("818"));
  const state = stateOf({ 818: "passed" }, { outcome: "completed", lifecycle: "closed" });
  const review = report({
    criteria: [{ id: "818.3", taskId: "818", source: "task", text: "break the hint", verdict: "unknown", evidence: "mutation denied in this session" }],
  });
  const fix = {
    status: "ok",
    items: [{ id: "F1", title: "break the hint", checkOnly: true, criterionId: "818.3" }],
    fixed: [],
    deferred: [{ id: "F1", title: "break the hint", reason: "already met — `npm test` failed 1 with it broken", kind: "no_op" }],
  };
  const markdown = renderCloseout(dag, state, review, fix);
  assert.match(markdown, /1\. Verifier .* 1\/1 criteria met/);
  assert.doesNotMatch(markdown, /0\/1 criteria met/);
});

test("a minors checklist the moved branch keeps from being retried is logged as still owed", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const verify = async () => report({ findings: minorFindings });
  await close({ repo, dag, verify, commentOnEpic: ({ body }) => (isMinors(body) ? { status: 1, stderr: "HTTP 502" } : { status: 0 }) });
  spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "moved"], { cwd: repo });
  const posted = [];
  await close({ repo, dag, verify, commentOnEpic: ({ body }) => { posted.push(body); return { status: 0 }; } });
  assert.equal(posted.length, 0);
  assert.match(readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"), /minor findings checklist is still owed/);
});

test("an edit of a deleted minors comment posts a new one", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { humanGated: true })],
    { 204: "passed", 205: "passed" },
  );
  stateBelongsToEpic(repo, "203");
  const verify = async () => report({ findings: minorFindings });
  const first = "https://github.com/o/r/issues/203#issuecomment-555";
  const second = "https://github.com/o/r/issues/203#issuecomment-777";
  const calls = [];
  let fresh = first;
  const commentOnEpic = (args) => {
    calls.push(args);
    if (!isMinors(args.body)) return { status: 0 };
    if (args.editUrl) return { status: 1, stderr: "gh: Not Found (HTTP 404)" };
    return { status: 0, stdout: `${fresh}\n` };
  };
  await close({ repo, dag, verify, commentOnEpic });
  const reset = readState(repo);
  reset.tasks["205"].lifecycle = "pending";
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reset));
  await close({ repo, dag, verify, commentOnEpic });
  const reopened = readState(repo);
  reopened.tasks["205"].lifecycle = "passed";
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify(reopened));
  calls.length = 0;
  fresh = second;
  await close({ repo, dag, verify, commentOnEpic });
  const minors = calls.filter((args) => isMinors(args.body));
  assert.deepEqual(minors.map((args) => args.editUrl ?? null), [first, null], "tried the edit, then posted anew");
  const recorded = readState(repo).epicClose.minorsComment;
  assert.ok(recorded.postedAt);
  assert.equal(recorded.url, second);
});

// ---------------------------------------------------------------------------
// `afk close --redo` (#213)
// ---------------------------------------------------------------------------

test("close --redo reviews the head a later commit moved, so review-at-head passes, and keeps the earlier review", async () => {
  const { reviewIsCurrentAt } = await import("./lib.mjs");
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  let calls = 0;
  const hooks = {
    verify: async ({ root }) => { calls += 1; return report({ head: headOf(root), ranAt: new Date().toISOString() }); },
    commentOnEpic: () => ({ status: 0 }),
    gateHolder: null,
  };
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  const first = readState(repo).epicClose;
  assert.equal(first.lifecycle, "closed");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "later.txt"), "a commit after the close\n");
  git("add", "later.txt");
  git("commit", "-m", "later work");
  const head = headOf(repo);
  assert.equal(reviewIsCurrentAt(repo, first.verifier, head), false, "the precondition: the stored review is stale");

  // A plain relaunch leaves it stale.
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  assert.equal(readState(repo).epicClose.verifier.head, first.verifier.head);

  assert.equal(await close({ repo, dag, redoClose: true, ...hooks }), 0);
  const redone = readState(repo).epicClose;
  assert.equal(redone.lifecycle, "closed");
  assert.equal(redone.verifier.head, head);
  assert.equal(reviewIsCurrentAt(repo, redone.verifier, headOf(repo)), true);
  assert.equal(redone.redos.length, 1);
  assert.equal(redone.redos[0].verifier.head, first.verifier.head, "the earlier review is kept, not overwritten");
  assert.equal(calls, 2);
  assert.match(readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"), /closeout redone/);
});

test("close --redo refuses while a lane or a gate runs, or before the epic closed", async () => {
  const { redoCloseRefusal } = await import("./auto.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-redo-")));
  const closed = { epicClose: { lifecycle: "closed" }, tasks: { 204: { lifecycle: "passed" } } };
  assert.equal(redoCloseRefusal({ root, state: closed, gateHolder: null }), null);
  assert.match(redoCloseRefusal({ root, state: { ...closed, epicClose: { lifecycle: "open" } }, gateHolder: null }), /not closed/);
  assert.match(redoCloseRefusal({ root, state: { tasks: {} }, gateHolder: null }), /not closed/);
  assert.match(
    redoCloseRefusal({ root, state: { ...closed, tasks: { 204: { lifecycle: "passed" }, 205: { lifecycle: "integrating" } } }, gateHolder: null }),
    /205 are still in flight/,
  );
  const holder = { pid: process.pid, project: root, kind: "closeout fix gate" };
  assert.match(redoCloseRefusal({ root, state: closed, gateHolder: holder, alive: () => true }), /gate lock/);
  // Another project's gate is not this epic's, and a dead holder holds nothing.
  assert.equal(redoCloseRefusal({ root, state: closed, gateHolder: { ...holder, project: "/elsewhere" }, alive: () => true }), null);
  assert.equal(redoCloseRefusal({ root, state: closed, gateHolder: holder, alive: () => false }), null);
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "gate-wait.json"), "{}");
  assert.match(redoCloseRefusal({ root, state: closed, gateHolder: null }), /waiting for the gate lock/);
  rmSync(join(root, ".afk", "gate-wait.json"));
  writeFileSync(join(root, ".afk", "orchestrator.lock"), "1");
  assert.match(redoCloseRefusal({ root, state: closed, gateHolder: null }), /orchestrator\.lock/);
  rmSync(root, { recursive: true, force: true });
});

test("runAuto with redoClose refuses a lane in flight and changes nothing", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "passed" });
  stateBelongsToEpic(repo, "203");
  const hooks = { verify: async ({ root }) => report({ head: headOf(root) }), commentOnEpic: () => ({ status: 0 }), gateHolder: null };
  assert.equal(await close({ repo, dag, ...hooks }), 0);
  const path = join(repo, ".afk", "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.tasks["204"].lifecycle = "running";
  writeFileSync(path, JSON.stringify(state, null, 2));
  const before = readFileSync(path, "utf8");
  assert.equal(await close({ repo, dag, redoClose: true, ...hooks }), 1);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.match(readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"), /cannot redo the closeout: lane\(s\) 204/);
});
