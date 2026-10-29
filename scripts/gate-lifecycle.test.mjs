// scripts/gate-lifecycle.test.mjs — the three findings from the overnight epics.
//
// One file, because the three are one story: a `gate: after` task was dispatched
// to a builder, the builder's verdict closed the epic incomplete, and closing
// incomplete suppressed the only holistic review in the pipeline. A stale
// `blocked` reached the same end by a different road.
//
//   Fix 1  a `gate: after` task is never given a lane; it resolves to the
//          task-level lifecycle `awaiting_acceptance`, and only `--accept` moves
//          it. Four epics ran the identical ticket shape and recorded `blocked`,
//          `failed` and `passed` for it, on builder judgment alone.
//   Fix 2  the closeout verifier runs when the epic STOPS, not when it succeeds.
//   Fix 3  `blocked` is derived from dependency lifecycle every scheduler turn,
//          so an edge cannot outlive its cause and halt a run silently.
//
// A separate file, per the note at the top of scripts/epic-close.test.mjs:
// `afk selftest` discovers every `scripts/*.test.mjs`, so a lane adding a file
// cannot conflict with a lane adding another.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import {
  AWAITING_ACCEPTANCE,
  deriveBlocked,
  epicOutcome,
  recordGateAcceptance,
  resolveGateAfterTasks,
  runnableTasks,
} from "./scheduler.mjs";
import { runAuto } from "./auto.mjs";
import { freePort } from "./free-port.mjs";

process.setMaxListeners(60);

const task = (id, extra = {}) => ({
  id,
  title: `task ${id}`,
  dependsOn: [],
  checks: ["true"],
  allowedPaths: ["**"],
  ...extra,
});
const dagOf = (...tasks) => ({
  epic: { id: "203", title: "Stripe subscriptions" },
  branch: "feat/203-stripe",
  tasks,
});
const stateOf = (tasks) => ({
  activeWorkers: {},
  tasks: Object.fromEntries(
    Object.entries(tasks).map(([id, value]) => [
      id,
      typeof value === "string" ? { lifecycle: value } : value,
    ]),
  ),
});

// ---------------------------------------------------------------------------
// Fix 1 — a `gate: after` task is never dispatched to a builder
// ---------------------------------------------------------------------------

test("a `gate: after` leaf is never runnable, even as its own explicit task", () => {
  const dag = dagOf(task("204"), task("211", { gateAfter: true, dependsOn: ["204"] }));
  const state = stateOf({ 204: "passed", 211: "pending" });
  assert.deepEqual(runnableTasks(dag, state).map((t) => t.id), []);
  // Not even by hand. There is nothing an agent can do with a device
  // walkthrough that would be true, so `afk run --task=211` gets no lane either.
  assert.deepEqual(runnableTasks(dag, state, Date.now(), "211").map((t) => t.id), []);
});

test("an admissible `gate: after` task resolves to awaiting_acceptance, not to a lane", () => {
  const dag = dagOf(task("204"), task("211", { gateAfter: true, dependsOn: ["204"] }));
  const state = stateOf({ 204: "pending", 211: "pending" });
  // Not yet: the work it gates has not landed.
  assert.deepEqual(resolveGateAfterTasks(dag, state), []);
  state.tasks["204"].lifecycle = "passed";
  assert.deepEqual(resolveGateAfterTasks(dag, state), ["211"]);
  assert.equal(state.tasks["211"].lifecycle, AWAITING_ACCEPTANCE);
  // Idempotent, and it never reads as done or broken.
  assert.deepEqual(resolveGateAfterTasks(dag, state), []);
  for (const wrong of ["passed", "blocked", "failed"]) {
    assert.notEqual(state.tasks["211"].lifecycle, wrong);
  }
});

test("an awaiting_acceptance task holds the epic open and only a human releases it", () => {
  const dag = dagOf(task("204"), task("211", { gateAfter: true, dependsOn: ["204"] }));
  const state = stateOf({ 204: "passed", 211: "pending" });
  resolveGateAfterTasks(dag, state);
  const outcome = epicOutcome(dag, state);
  assert.equal(outcome.status, "awaiting_acceptance");
  assert.deepEqual(outcome.awaiting, ["211"]);
  // Not counted as never-run and not counted as a failure: it is its own thing.
  assert.deepEqual(outcome.pending, []);
  assert.deepEqual(outcome.failed, []);

  assert.deepEqual(recordGateAcceptance(state, { dag, id: "211" }), { ok: true, already: false });
  // The human's acceptance IS the verdict, so the task leaves the waiting state.
  assert.equal(state.tasks["211"].lifecycle, "passed");
  assert.equal(epicOutcome(dag, state).status, "complete");
});

test("a `gate: after` leaf gets no worktree and no builder from a real run", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("211", { gateAfter: true, dependsOn: ["204"] })],
    { 204: "passed" },
  );
  const code = await runIt({
    repo,
    dag,
    verify: async () => verifierReport(),
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  const state = readState(repo);
  assert.equal(state.tasks["211"].lifecycle, AWAITING_ACCEPTANCE);
  assert.equal(state.tasks["211"].builderAttempt ?? 0, 0, "a gate must cost no lane");
  assert.equal(state.tasks["211"].worktree ?? null, null, "a gate must cost no worktree");
  assert.equal(state.epicClose.lifecycle, "awaiting_acceptance");
  // And the honesty requirement: the committed progress table says the true
  // thing, not `passed` and not `blocked`.
  //
  // Read from the PER-EPIC path, which is where `flushStatuses` stages it
  // (#122) — one file per epic, so two epics' merges cannot collide on it. This
  // assertion is the path's end-to-end proof: it comes from a real run's commit,
  // not from a helper asked what it would have done.
  const staged = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim().split("\n");
  assert.ok(staged.includes("docs/progress/203.md"), `staged: ${staged.join(", ")}`);
  assert.match(
    readFileSync(join(repo, "docs", "progress", "203.md"), "utf8"),
    /\|\s*211\s*\|[^|]*\|\s*awaiting_acceptance\s*\|/,
  );
  assert.equal(
    readFileSync(join(repo, "docs", "progress.md"), "utf8"),
    "# Progress\n",
    "and the project's existing shared file is not touched",
  );
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix 2 — the review runs when the epic stops
// ---------------------------------------------------------------------------

test("the closeout verifier runs on an incomplete stop, labelled with what was outstanding", async () => {
  const { repo, dag } = makeRepo(
    [task("204"), task("205", { dependsOn: ["204"] }), task("206")],
    { 204: "failed", 205: "blocked", 206: "passed" },
  );
  stateBelongsToEpic(repo, "203");
  let calls = 0;
  let outstanding = null;
  const code = await runIt({
    repo,
    dag,
    verify: async (args) => {
      calls += 1;
      outstanding = args.outstanding;
      return verifierReport({ mustFix: ["kv.remove() deletes a completed session"] });
    },
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  assert.equal(calls, 1, "the runs that most need a review are the ones that stop short");
  assert.deepEqual(outstanding, ["204 did not pass", "205 did not pass"]);
  const state = readState(repo);
  assert.equal(state.epicClose.verifier.recommendation, "must-fix");
  // Advisory: a must-fix review cannot halt the runner (exit 0 above) and
  // cannot change what the DAG says the epic was.
  assert.equal(state.epicClose.outcome, "incomplete");
  rmSync(repo, { recursive: true, force: true });
});

test("a verifier that throws on an incomplete stop is recorded, never fatal", async () => {
  const { repo, dag } = makeRepo([task("204")], { 204: "failed" });
  stateBelongsToEpic(repo, "203");
  const code = await runIt({
    repo,
    dag,
    verify: async () => {
      throw new Error("no claude login");
    },
    commentOnEpic: () => ({ status: 0 }),
  });
  assert.equal(code, 0);
  const state = readState(repo);
  assert.equal(state.epicClose.outcome, "incomplete");
  assert.match(state.epicClose.verifier.skipped, /no claude login/);
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix 3 — `blocked` is derived, not stored
// ---------------------------------------------------------------------------

test("a stale stored `blocked` re-derives to pending once its dependency passes", () => {
  const dag = dagOf(task("35"), task("40", { dependsOn: ["35"] }));
  // Exactly the record epic #5 halted on: #35 merged and went `passed`, #40's
  // entry still named it as the blocker, and nothing ever re-read the edge.
  const state = stateOf({ 35: "passed", 40: { lifecycle: "blocked", blockedBy: "35" } });
  assert.deepEqual(deriveBlocked(dag, state), [
    { id: "40", lifecycle: "pending", blocker: null },
  ]);
  assert.equal(state.tasks["40"].lifecycle, "pending");
  assert.equal("blockedBy" in state.tasks["40"], false);
  // And the run does not stop with work left: #40 is schedulable again.
  assert.deepEqual(runnableTasks(dag, state).map((t) => t.id), ["40"]);
});

test("a live block is still derived, and transitively", () => {
  const dag = dagOf(task("35"), task("40", { dependsOn: ["35"] }), task("41", { dependsOn: ["40"] }));
  const state = stateOf({ 35: "failed", 40: "pending", 41: "pending" });
  assert.deepEqual(deriveBlocked(dag, state).map((move) => move.id), ["40", "41"]);
  assert.equal(state.tasks["40"].blockedBy, "35");
  assert.equal(state.tasks["41"].blockedBy, "40");
});

test("a builder's `blocked` verdict is not a dependency edge and is never re-derived", () => {
  // The other `blocked`: a lane that produced no source change. It carries no
  // `blockedBy`, and un-blocking it would put it straight back into a lane.
  const dag = dagOf(task("204"));
  const state = stateOf({ 204: { lifecycle: "blocked", builderAttempt: 2 } });
  assert.deepEqual(deriveBlocked(dag, state), []);
  assert.equal(state.tasks["204"].lifecycle, "blocked");
});

// ---------------------------------------------------------------------------
// Fixture plumbing. Mirrors scripts/epic-close.test.mjs: a real git repo, a fake
// `claude` on PATH for the auth preflight, and injected closeout seams so a run
// costs no tokens and no GitHub round-trip.
// ---------------------------------------------------------------------------


const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-gate-bin-"));
  const fake = join(bin, "claude");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  return bin;
})();

function makeRepo(tasks, taskState) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-lifecycle-")));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
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
    }),
  );
  return { repo, dag: dagOf(...tasks) };
}

const readState = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));

const stateBelongsToEpic = (repo, id) => {
  const path = join(repo, ".afk", "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.epic = { id, title: `Epic ${id}` };
  writeFileSync(path, JSON.stringify(state, null, 2));
};

const verifierReport = (extra = {}) => ({
  version: 1,
  status: "ok",
  summary: "Reviewed.",
  criteria: [],
  findings: [],
  mustFix: [],
  problems: [],
  outstanding: [],
  ranAt: "2026-08-18T01:00:00.000Z",
  branch: "feat/203-stripe",
  baseBranch: "main",
  artifacts: { report: "/tmp/report.json" },
  ...extra,
});

async function runIt({ repo, dag, ...rest }) {
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
}

assert.ok(existsSync(fakeClaude));
