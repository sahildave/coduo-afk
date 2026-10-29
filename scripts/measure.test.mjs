// scripts/measure.test.mjs — the docs/measure rows (#181).
//
// Every test points AFK_MEASURE_ROOT at its own temp directory: a test that
// wrote into the runner's real docs/measure would be committed by whoever ran
// the suite next. The fixture repos carry a GitHub-shaped `origin` URL so the
// project name resolves; nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCloseRow, appendLaunchRow, buildLaunchRow, buildMergeRow, builderMeasures, gateEventsPath, measurePath, recordGate,
} from "./measure.mjs";
import { runBaselineChecks } from "./auto.mjs";

const AFK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "afk.mjs");
const PROJECT = "fixture";
const quiet = () => {};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A repo with one commit, a GitHub origin, and a private measure root. */
const fixture = (t) => {
  const base = mkdtempSync(join(tmpdir(), "afk-measure-"));
  const root = join(base, "repo");
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "init"]);
  git(root, ["remote", "add", "origin", `https://github.com/acme/${PROJECT}.git`]);
  const before = process.env.AFK_MEASURE_ROOT;
  const beforeTranscripts = process.env.AFK_TRANSCRIPTS_ROOT;
  process.env.AFK_MEASURE_ROOT = join(base, "measure");
  // Never the operator's real ~/.claude/projects.
  process.env.AFK_TRANSCRIPTS_ROOT = join(base, "transcripts");
  t.after(() => {
    if (before === undefined) delete process.env.AFK_MEASURE_ROOT;
    else process.env.AFK_MEASURE_ROOT = before;
    if (beforeTranscripts === undefined) delete process.env.AFK_TRANSCRIPTS_ROOT;
    else process.env.AFK_TRANSCRIPTS_ROOT = beforeTranscripts;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, afk: join(root, ".afk") };
};

const DAG = {
  epic: { id: "9", title: "Fixture" },
  tasks: [
    { id: "1", dependsOn: [] },
    { id: "2", dependsOn: ["1"], humanGated: true },
    { id: "3", dependsOn: ["2"] },
  ],
};

const writeState = (afk, fields = {}) => {
  mkdirSync(afk, { recursive: true });
  writeFileSync(join(afk, "state.json"), JSON.stringify({
    version: 1,
    startedAt: "2000-01-01T00:00:00.000Z",
    epic: { id: "9" },
    tasks: {
      1: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1, taskVerification: { agentExitCode: 0, timedOut: false } },
    },
    epicClose: { lifecycle: "closed", outcome: "completed", closedAt: new Date().toISOString(), acceptances: {} },
    ...fields,
  }));
};

const rows = () => readFileSync(measurePath(PROJECT), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const baseline = (root, commands) => recordGate(
  { root, kind: "baseline", commands, say: quiet },
  () => runBaselineChecks({ commands, cwd: root, say: quiet }),
);

test("a fixture epic that closes clean writes one launch row and one close row, both schema 1", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  const launch = appendLaunchRow({ root, dag: DAG, config: { maxParallel: 3 }, say: quiet });
  await baseline(root, ["true"]);
  const close = await appendCloseRow({ root, say: quiet });
  const written = rows();
  assert.deepEqual(written.map((row) => [row.type, row.schema]), [["launch", 1], ["close", 1]]);
  assert.deepEqual(written[0], launch);
  assert.deepEqual(written[1], close);
  assert.equal(launch.project, PROJECT);
  assert.equal(launch.epicId, "9");
  assert.equal(launch.baseSha, git(root, ["rev-parse", "HEAD"]));
  assert.deepEqual(launch.humanGates, [{ taskId: "2", gate: "before", blocked: ["2", "3"] }]);
  assert.equal(launch.dagDepth, 3);
  assert.equal(launch.rootWidth, 1);
  assert.equal(launch.laneCap, 3);
  assert.equal(close.launches, 1);
  assert.equal(close.relaunches, 0);
  assert.deepEqual(close.gateRuns, { baseline: 1 });
  assert.equal(close.repeats, 0);
  assert.equal(close.falseReds, 0);
  assert.deepEqual(close.tasks, [{ taskId: "1", builderAttempts: 1, integrationAttempts: 1, lifecycle: "passed", agentDied: false }]);
  assert.deepEqual(close.stops, []);
  const [event] = readFileSync(gateEventsPath(afk), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(event.kind, "baseline");
  assert.equal(event.attempt, 1);
  assert.equal(event.headSha, git(root, ["rev-parse", "HEAD"]));
  assert.equal(event.treeSha, git(root, ["rev-parse", "HEAD^{tree}"]));
  assert.equal(typeof event.load1, "number");
  assert.equal(event.commands[0].command, "true");
  assert.equal(event.commands[0].code, 0);
  assert.equal(typeof event.commands[0].durationMs, "number");
  assert.ok(Date.parse(event.commands[0].startedAt));
  // The rows the report quotes.
  if (process.env.AFK_MEASURE_PRINT) for (const row of written) console.log(JSON.stringify(row));
});

test("a launch row carries the stop forecast, with the same stops as its humanGates", (t) => {
  const { root } = fixture(t);
  const launch = appendLaunchRow({ root, dag: DAG, config: { launchStatus: "pre-launch" }, say: quiet });
  assert.deepEqual(launch.humanGates, [{ taskId: "2", gate: "before", blocked: ["2", "3"] }]);
  assert.deepEqual(launch.forecast, {
    launchStatus: { value: "pre-launch", declared: true },
    stops: [{
      task: "2", kind: "gate_before", blocks: ["2", "3"], share: 2 / 3,
      note: "needs two launches: --task=2, then a plain relaunch", answer: null,
    }],
    parked: { tasks: 2, total: 3, share: 2 / 3 },
    unanswered: 1,
  });
  assert.equal(launch.schema, 1);
  // `afk epic` hands over the forecast it built with the epic's `stops:`
  // answers, which the DAG does not carry; the row keeps it verbatim.
  const answered = { ...launch.forecast, stops: [{ ...launch.forecast.stops[0], answer: { kind: "park" } }], unanswered: 0 };
  const relaunch = appendLaunchRow({ root, dag: DAG, config: {}, forecast: answered, say: quiet });
  assert.deepEqual(relaunch.forecast, answered);
  assert.deepEqual(rows().map((row) => row.forecast), [launch.forecast, answered]);
});

test("a red baseline then a green one on the same tree is one false red", async (t) => {
  const { root } = fixture(t);
  writeState(join(root, ".afk"));
  // Untracked, so the tree sha is the same on both runs.
  const commands = ["test -f flag", "true"];
  const red = await baseline(root, commands);
  assert.equal(red.ok, false);
  writeFileSync(join(root, "flag"), "");
  assert.equal((await baseline(root, commands)).ok, true);
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.falseReds, 1);
  assert.deepEqual(close.gateRuns, { baseline: 2 });
  assert.equal(close.reds.length, 1);
  assert.equal(close.reds[0].command, "test -f flag");
  assert.equal(close.reds[0].falseRed, true);
  assert.equal(close.repeats, 0);
});

test("two all-green gate runs on the same tree and command list are one repeat", async (t) => {
  const { root } = fixture(t);
  writeState(join(root, ".afk"));
  await baseline(root, ["true"]);
  await baseline(root, ["true"]);
  // A different command list on the same tree is not a repeat.
  await baseline(root, ["true", "true"]);
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.repeats, 1);
  assert.equal(close.falseReds, 0);
});

test("an integration's re-run of a failed check is its own recheck event, and its pass is a false red", async (t) => {
  const { root } = fixture(t);
  writeState(join(root, ".afk"));
  const at = new Date().toISOString();
  await recordGate({
    root, kind: "integration", taskId: "1", attempt: 1, say: quiet,
    commands: ["npm test", "npm run lint"],
    checks: [
      { command: "npm test", code: 0, startedAt: at, durationMs: 5, load1: 2.5 },
      { command: "npm run lint", code: 0, startedAt: at, durationMs: 3, load1: 1 },
    ],
    checkReruns: [{ command: "npm test", firstCode: 1, firstStartedAt: at, firstDurationMs: 4, firstLoad1: 3.5, passed: true }],
  });
  const events = readFileSync(gateEventsPath(join(root, ".afk")), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.kind), ["integration", "recheck"]);
  assert.deepEqual(events[0].commands.map((check) => check.code), [1, 0], "the integration event keeps the first run");
  assert.equal(events[0].load1, 3.5);
  assert.deepEqual(events[1].commands, [{ command: "npm test", startedAt: at, durationMs: 5, code: 0 }]);
  const close = await appendCloseRow({ root, say: quiet });
  assert.deepEqual(close.gateRuns, { integration: 1, recheck: 1 });
  assert.equal(close.falseReds, 1);
});

test("an integration retry that fails again is recorded with passed: false", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, {
    tasks: { 5: { lifecycle: "failed", builderAttempt: 1, integrationAttempt: 2, taskVerification: { agentExitCode: 1 } } },
  });
  for (const attempt of [1, 2]) {
    const dir = join(afk, "runs", "5", `integration-${attempt}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verification.json"), JSON.stringify({ taskId: "5", attempt, passed: false }));
  }
  const close = await appendCloseRow({ root, say: quiet });
  assert.deepEqual(close.integrationRetries, [{ taskId: "5", attempt: 2, passed: false }]);
  assert.deepEqual(close.tasks, [{ taskId: "5", builderAttempts: 1, integrationAttempts: 2, lifecycle: "failed", agentDied: true }]);
});

test("an epic parked on a human gate and relaunched has two launch rows and one human-gate stop", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  appendLaunchRow({ root, dag: DAG, config: {}, release: { task: null, accept: [] }, say: quiet });
  await sleep(25);
  appendLaunchRow({ root, dag: DAG, config: {}, release: { task: "2", accept: [] }, say: quiet });
  const close = await appendCloseRow({ root, say: quiet });
  const written = rows();
  assert.deepEqual(written.map((row) => row.type), ["launch", "launch", "close"]);
  assert.equal(written[1].release.task, "2");
  assert.equal(close.launches, 2);
  assert.equal(close.relaunches, 1);
  assert.equal(close.gateReleases, 1);
  assert.equal(close.stops.length, 1);
  assert.equal(close.stops[0].kind, "human gate");
  assert.ok(close.stops[0].parkedMs > 0, `parked ${close.stops[0].parkedMs}ms`);
});

test("a closeout with must-fix findings records found, fixed, dropped and left", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  mkdirSync(join(afk, "fixer", "9"), { recursive: true });
  writeFileSync(join(afk, "fixer", "9", "report.json"), JSON.stringify({
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }, { id: "F4" }],
    fixed: [{ id: "F1" }, { id: "F2" }],
    deferred: [
      { id: "F3", reason: "needs a product decision", kind: "needs_human" },
      { id: "F4", reason: "already correct", kind: "no_op" },
    ],
  }));
  const close = await appendCloseRow({ root, say: quiet });
  assert.deepEqual(close.closeout, { found: 4, fixed: 2, dropped: 1, left: 1 });
});

test("closeout counts each bucket: a restated fix is dropped, not fixed (#177 minor 7)", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  mkdirSync(join(afk, "fixer", "9"), { recursive: true });
  writeFileSync(join(afk, "fixer", "9", "report.json"), JSON.stringify({
    status: "ok",
    items: [{ id: "F1" }, { id: "F2" }, { id: "F3" }, { id: "F4" }],
    fixed: [{ id: "F1" }, { id: "F2", duplicateOf: "F1" }],
    deferred: [
      { id: "F3", reason: "needs a product decision", kind: "needs_human" },
      { id: "F4", reason: "already correct", kind: "no_op" },
    ],
  }));
  const close = await appendCloseRow({ root, say: quiet });
  assert.deepEqual(close.closeout, { found: 4, fixed: 1, dropped: 2, left: 1 });
});

test("an acceptance voided by a must-fix reopen still counts (#177 minor 8)", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, { epicClose: {
    lifecycle: "closed", outcome: "completed", closedAt: new Date().toISOString(),
    acceptances: { 1: { by: "human", at: "2000-01-02T00:00:00.000Z" } },
    voidedAcceptances: [{ id: "1", by: "human", at: "2000-01-01T12:00:00.000Z" }],
  } });
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.acceptances, 2);
});

test("a deleted and a corrupted input still write the close row, with those fields null", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  await baseline(root, ["true"]);
  rmSync(gateEventsPath(afk));
  writeFileSync(join(afk, "state.json"), "{ not json");
  const close = await appendCloseRow({ root, say: quiet });
  assert.ok(close, "the row was written");
  assert.equal(rows().at(-1).type, "close");
  for (const field of ["gateRuns", "repeats", "falseReds", "reds", "tasks", "acceptances", "outcome"]) {
    assert.equal(close[field], null, field);
  }
  assert.equal(close.epicId, null);
  assert.equal(close.times.closed, null);
});

test("an unwritable measure root is logged, and the close and the launch return normally", async (t) => {
  const { base, root, afk } = fixture(t);
  writeState(afk);
  // A FILE where the root directory should be: no mkdir under it can succeed.
  const blocked = join(base, "blocked");
  writeFileSync(blocked, "");
  process.env.AFK_MEASURE_ROOT = join(blocked, "measure");
  const said = [];
  const say = (line) => said.push(line);
  assert.equal(appendLaunchRow({ root, dag: DAG, config: {}, say }), null);
  assert.equal(await appendCloseRow({ root, say }), null);
  assert.equal(said.length, 2);
  assert.match(said[0], /^MEASURE: could not write the launch row/);
  assert.match(said[1], /^MEASURE: could not write the close row/);
});

test("an unwritable gate-event file is logged and the gate's own outcome is returned", async (t) => {
  const { root, afk } = fixture(t);
  mkdirSync(join(afk, "runs"), { recursive: true });
  chmodSync(join(afk, "runs"), 0o500);
  // The fixture's own cleanup is registered first and runs first; an empty
  // read-only directory still removes, so this restore may find nothing.
  t.after(() => { try { chmodSync(join(afk, "runs"), 0o700); } catch { /* removed */ } });
  const said = [];
  const outcome = await recordGate({ root, kind: "baseline", say: (line) => said.push(line) }, async () => ({ ok: true, marker: 1 }));
  assert.deepEqual(outcome, { ok: true, marker: 1 });
  assert.match(said[0] ?? "", /^MEASURE: could not record the baseline event/);
});

test("afk measure backfill on a run folder with no gate events writes a close row whose gate fields are null", async (t) => {
  const { base } = fixture(t);
  // An archive-shaped folder outside any git repo: state and lanes, no events.
  const archive = join(base, "archive", "epic-9");
  writeState(archive);
  mkdirSync(join(archive, "runs", "1", "builder-1"), { recursive: true });
  writeFileSync(join(archive, "runs", "1", "builder-1", "phases.jsonl"), `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", phase: "Resolve" })}\n`);
  const result = spawnSync(process.execPath, [AFK, "measure", "backfill", archive, `--project=${PROJECT}`], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [close] = rows();
  assert.equal(close.type, "close");
  assert.equal(close.schema, 1);
  assert.equal(close.epicId, "9");
  for (const field of ["gateRuns", "repeats", "falseReds", "reds"]) assert.equal(close[field], null, field);
  assert.equal(close.launches, null, "no launch rows were ever written for this project");
  assert.equal(close.times.firstLaneStart, "2026-01-01T00:00:00.000Z");
  assert.equal(close.times.prOpened, null);
  assert.ok(!existsSync(join(archive, "runs", "measure-close.json")), "backfill leaves the run folder untouched");
});

test("afk archive writes the close row first for an unfinished epic, and not again for a recorded one", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, { epicClose: { lifecycle: "open", acceptances: {} }, tasks: { 1: { lifecycle: "failed" } } });
  const archived = spawnSync(process.execPath, [AFK, "archive", "--force"], { cwd: root, encoding: "utf8", env: { ...process.env } });
  assert.equal(archived.status, 0, archived.stdout + archived.stderr);
  assert.deepEqual(rows().map((row) => row.type), ["close"]);
  assert.ok(existsSync(join(afk, "archive", "epic-9", "state.json")), "the archive itself is unchanged");
  // A run the runner already closed and recorded is not recorded twice.
  writeState(afk);
  assert.ok(await appendCloseRow({ root, say: quiet }));
  assert.equal(await appendCloseRow({ root, once: true, say: quiet }), null);
  assert.deepEqual(rows().map((row) => row.type), ["close", "close"]);
});

test("a green baseline that skipped a command is green, counts as a repeat, and its event names the skip", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  const outcome = { ok: true, ran: [{ command: "true", code: 0, durationMs: 5 }], skipped: [{ command: "cargo test", skipped: true, code: null }] };
  const meta = { root, kind: "baseline", commands: ["true", "cargo test"], say: quiet };
  await recordGate(meta, async () => outcome);
  await recordGate(meta, async () => outcome);
  const events = readFileSync(gateEventsPath(afk), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events[0].skipped, ["cargo test"]);
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.repeats, 1);
  assert.equal(close.gateMs, 10);
});

test("after two closes of one epic, a late writer still skips the recorded close", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  assert.ok(await appendCloseRow({ root, say: quiet }));
  assert.ok(await appendCloseRow({ root, say: quiet }));
  assert.equal(await appendCloseRow({ root, once: true, say: quiet }), null);
  assert.equal(rows().length, 2);
});

test("the close row carries gate and lane wall time, null when a duration is unknown", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  await recordGate({ root, kind: "baseline", commands: ["true"], say: quiet }, async () => ({ ok: true, ran: [{ command: "true", code: 0, durationMs: 1500 }] }));
  const lane = join(afk, "runs", "1", "builder-1");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "stream.jsonl"), [
    JSON.stringify({ type: "result", duration_ms: 1000, usage: { output_tokens: 1 } }),
    JSON.stringify({ type: "result", duration_ms: 500, usage: { output_tokens: 1 } }),
  ].join("\n"));
  let close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.gateMs, 1500);
  assert.equal(close.lanes[0].durationMs, 1500);
  await recordGate({ root, kind: "baseline", commands: ["true"], say: quiet }, async () => ({ ok: true, ran: [{ command: "true", code: 0 }] }));
  close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.gateMs, null);
});

test("afk measure backfill on a run folder with a fixer report exits 0 and writes the closeout", async (t) => {
  // measure.mjs as the main module lazily imports fixer.mjs, which imports
  // measure.mjs back. A top-level `await cli()` deadlocked that cycle: exit 13.
  const { base } = fixture(t);
  const archive = join(base, "archive", "epic-9");
  writeState(archive);
  mkdirSync(join(archive, "fixer", "9"), { recursive: true });
  writeFileSync(join(archive, "fixer", "9", "report.json"), JSON.stringify({
    status: "ok", items: [{ id: "F1" }], fixed: [{ id: "F1" }], deferred: [],
  }));
  const result = spawnSync(process.execPath, [AFK, "measure", "backfill", archive, `--project=${PROJECT}`], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [close] = rows();
  assert.deepEqual(close.closeout, { found: 1, fixed: 1, dropped: 0, left: 0 });
});

test("builderAttempts is null for a passed task the state counts as 0, unless it is gate: after or never started", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, {
    dag: { tasks: [{ id: "1" }, { id: "2", gateAfter: true }, { id: "3" }] },
    tasks: {
      1: { lifecycle: "passed", builderAttempt: 0, integrationAttempt: 0 },
      2: { lifecycle: "passed", builderAttempt: 0, integrationAttempt: 0 },
      3: { lifecycle: "blocked", builderAttempt: 0, integrationAttempt: 0 },
    },
  });
  const close = await appendCloseRow({ root, say: quiet });
  const by = Object.fromEntries(close.tasks.map((task) => [task.taskId, task]));
  assert.equal(by[1].builderAttempts, null);
  assert.equal(by[1].integrationAttempts, null);
  assert.equal(by[2].builderAttempts, 0);
  assert.equal(by[3].builderAttempts, 0);
});

test("firstLaneStart falls back to the first builder start in agent-auto.log when no lane wrote phases", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, { startedAt: "2026-10-04T03:58:09.403Z", tasks: { 1003: { lifecycle: "passed" }, 1018: { lifecycle: "passed" } } });
  writeFileSync(join(afk, "agent-auto.log"), [
    "[2026-10-04T03:59:13.821Z] AUTO: baseline check still running after 31s: npm run lint",
    "[2026-10-04T04:11:30.606Z] AUTO: builder 1003 attempt 1 started at 6c65dbe8 in /tmp/x.",
    "[2026-10-04T04:11:34.566Z] AUTO: builder 1018 attempt 1 started at 6c65dbe8 in /tmp/y.",
  ].join("\n"));
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.times.firstLaneStart, "2026-10-04T04:11:30.606Z");
});

test("firstLaneStart is null when state has no startedAt, not the first builder start in an append-only log", async (t) => {
  const { root, afk } = fixture(t);
  mkdirSync(afk, { recursive: true });
  writeFileSync(join(afk, "state.json"), JSON.stringify({ tasks: {} }));
  writeFileSync(join(afk, "agent-auto.log"), "[2026-01-01T00:00:00.000Z] AUTO: builder 9 attempt 1 started at abc in /tmp/x.\n");
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.times.firstLaneStart, null);
});

test("firstLaneStart skips a logged builder start whose task is not in this run's state", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk, { startedAt: "2026-10-04T03:58:09.403Z", tasks: { 1018: { lifecycle: "passed" } } });
  writeFileSync(join(afk, "agent-auto.log"), [
    "[2026-10-04T04:11:30.606Z] AUTO: builder 777 attempt 1 started at 6c65dbe8 in /tmp/x.",
    "[2026-10-04T04:11:34.566Z] AUTO: builder 1018 attempt 1 started at 6c65dbe8 in /tmp/y.",
  ].join("\n"));
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.times.firstLaneStart, "2026-10-04T04:11:34.566Z");
});

test("a lane stream the efficiency parser cannot read (a codex log) has efficiency null, not zeros", async (t) => {
  const { root, afk } = fixture(t);
  writeState(afk);
  const lane = join(afk, "runs", "1", "builder-1");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "stream.jsonl"), "Reading prompt from stdin...\n2026-10-02T02:38:08Z  WARN codex: something\n");
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.lanes[0].efficiency, null);
});

// A herdr lane writes no stream.jsonl: its usage lives only in the Claude Code
// session transcript, found by the pointer prompt its first message carries.
const writeHerdrTranscript = (base, { task = "1", kind = "builder", attempt = 1, role = null, model = "claude-opus-5-5" } = {}) => {
  const epicRoot = `/Users/x/.afk-claude/epics/Users-x-code-projects-${PROJECT}-9/${PROJECT}`;
  const folder = join(base, "transcripts", `-Users-x--afk-claude-worktrees-Users-x-afk-claude-epics-Users-x-code-projects-${PROJECT}-9-${PROJECT}-${task}-${PROJECT}`);
  mkdirSync(folder, { recursive: true });
  const cwd = `/Users/x/.afk-claude/worktrees/Users-x-afk-claude-epics-Users-x-code-projects-${PROJECT}-9-${PROJECT}/${task}/${PROJECT}`;
  const first = role ?? `<pasted_content id="a1">\nRead the file ${epicRoot}/.afk/runs/${task}/${kind}-${attempt}/prompt.md and execute its instructions in the current directory.\n</pasted_content>`;
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 } };
  writeFileSync(join(folder, `${role ? "r" : "s"}-${task}-${kind}.jsonl`), [
    { type: "user", cwd, sessionId: "s", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: first } },
    { type: "assistant", cwd, timestamp: "2026-10-01T00:00:30.000Z", message: { id: `m1-${task}-${kind}`, model, usage, content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
    { type: "assistant", cwd, timestamp: "2026-10-01T00:01:00.000Z", message: { id: `m1-${task}-${kind}`, model, usage, content: [{ type: "text", text: "done" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
};

test("a herdr lane (no stream.jsonl) takes efficiency and wall time from its session transcript", async (t) => {
  const { base, root, afk } = fixture(t);
  writeState(afk);
  mkdirSync(join(afk, "runs", "1", "builder-1"), { recursive: true });
  writeFileSync(join(afk, "runs", "1", "builder-1", "prompt.md"), "task\n");
  writeHerdrTranscript(base);
  const close = await appendCloseRow({ root, say: quiet });
  assert.equal(close.lanes.length, 1);
  assert.notEqual(close.lanes[0].efficiency, null);
  assert.equal(close.lanes[0].efficiency.turns, 1);
  assert.equal(close.lanes[0].durationMs, 60_000);
  assert.equal(close.lanes[0].model, "claude-opus-5-5");
});

test("the close row records every role's model and tokens, an unrecognised opening as unknown", async (t) => {
  const { base, root, afk } = fixture(t);
  writeState(afk);
  writeHerdrTranscript(base);
  writeHerdrTranscript(base, { task: "verify", role: "You are the verifier for one completed AFK epic." });
  writeHerdrTranscript(base, { task: "odd", role: "Something no runner prompt says.", model: "claude-sonnet-5-5" });
  const close = await appendCloseRow({ root, say: quiet });
  const byRole = Object.fromEntries(close.usage.map((u) => [u.role, u]));
  assert.deepEqual(Object.keys(byRole).sort(), ["builder", "unknown", "verifier"]);
  assert.equal(byRole.builder.taskId, "1");
  assert.equal(byRole.builder.model, "claude-opus-5-5");
  assert.deepEqual(byRole.builder.tokens, { input: 10, output: 100, cacheWrite5m: 0, cacheWrite1h: 200, cacheRead: 1000 });
  // $4 in, $20 out, $0.20 read, 1h write at 2x input: 40 + 2000 + 200 + 1600 per million.
  assert.equal(Math.round(byRole.builder.costUsd * 1e6), 3840);
  assert.equal(byRole.unknown.model, "claude-sonnet-5-5");
});

test("a merge row carries the merge, the guardrail statuses without evidence, and the probe", () => {
  const row = buildMergeRow({
    project: "afk-claude", epic: 186, pr: "201", mergeSha: "abc", mergedAt: "2026-10-06T01:00:00Z",
    delegatedGates: [{ id: "190", condition: "tests green" }],
    guards: [{ name: "ci-green", status: "pass", evidence: "test: success" }],
    probe: null,
  });
  assert.deepEqual(row, {
    type: "merge", schema: 1, project: "afk-claude", epic: "186", pr: 201, mergeSha: "abc",
    mergedAt: "2026-10-06T01:00:00Z", by: "verb", delegatedGates: [{ id: "190", condition: "tests green" }],
    guards: [{ name: "ci-green", status: "pass" }], probe: { exit: null, ms: null },
    builderOpusShare: null, firstAttemptPassRate: null,
  });
});

// #292: two attempts on 401 (Codex exhausted, then Opus passed), one Opus pass
// on 402, one Opus failure on 403. Three of four attempts ran on Opus; one of
// three tasks passed on its first attempt.
const ROUTED_STATE = {
  tasks: {
    401: { builderRuns: [
      { attempt: 1, dispatch: 1, backend: "codex", model: "gpt-5.6-luna", outcome: "rate_limited" },
      { attempt: 2, dispatch: 2, backend: "claude", model: "claude-opus-5-5", outcome: "ready_to_integrate" },
    ] },
    402: { builderRuns: [{ attempt: 1, dispatch: 1, backend: "claude", model: "claude-opus-5-5", outcome: "ready_to_integrate" }] },
    403: { builderRuns: [{ attempt: 1, dispatch: 1, backend: "claude", model: "claude-opus-5-5", outcome: "failed" }] },
  },
};

test("the merge row carries the Opus share of builder attempts and the first-attempt pass rate (#292)", () => {
  const row = buildMergeRow({ project: "afk-claude", epic: 292, pr: 1, state: ROUTED_STATE });
  assert.equal(row.builderOpusShare, 0.75);
  assert.equal(row.firstAttemptPassRate, 0.3333);
});

test("the launch row carries the same builder numbers, and an unknown model leaves the share unknown (#292)", () => {
  const row = buildLaunchRow({ project: "afk-claude", dag: { tasks: [] }, state: ROUTED_STATE });
  assert.equal(row.builderOpusShare, 0.75);
  assert.equal(row.firstAttemptPassRate, 0.3333);
  const unknown = structuredClone(ROUTED_STATE);
  unknown.tasks[403].builderRuns[0].model = null;
  assert.equal(builderMeasures(unknown).builderOpusShare, null, "unknown is not zero and not Opus");
  assert.deepEqual(builderMeasures({ tasks: {} }), { builderOpusShare: null, firstAttemptPassRate: null });
});
