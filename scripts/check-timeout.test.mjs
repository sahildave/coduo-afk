// scripts/check-timeout.test.mjs — the bound on a check command.
//
// `runAsync` has taken a `timeout` since it was written and the check call sites
// — the builder's in worker.mjs and the post-merge gate's in integrate.mjs, and
// now the closeout fix gate's in fixer.mjs — passed `cwd` and `env` and nothing
// else, so every check inherited the 0 default, which arms no timer at all.
// There are THREE of them, and the third one arrived with the same defect the
// other two were repaired for. That is the quillnote v1
// six-hour stall: a closeout-authored test ran NSAppleScript under `swift
// test`, macOS raised a TCC consent dialog, and the suite sat behind a GUI
// prompt nobody was awake to click.
//
// worker.test.mjs drives the builder end to end. This file covers the resolver,
// the record and the reason string the sites share, the post-merge gate — where
// an unbounded check holds the whole epic, because integration is serial — and
// the closeout fix gate, where the bound fires but the record threw away the
// fact and printed the failure as a red check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdGateLock, writeConfig } from "./test-helpers.mjs";
import { runIntegration } from "./integrate.mjs";
import { runBaselineChecks } from "./auto.mjs";
import { runCloseoutGate } from "./fixer.mjs";
import { renderCloseoutGateLine } from "./wave-driver.mjs";
import {
  CHECK_TIMEOUT_EXIT_CODE,
  checkFailed,
  checkFailureReason,
  checkResult,
  checkTimeoutMs,
  DEFAULT_CHECK_TIMEOUT_MS,
  KILL_ESCALATION_MS,
  runAsync,
} from "./lib.mjs";

test("a config with no checkTimeoutMs gets the documented default", () => {
  // Every config that predates the key, which is all of them.
  assert.equal(checkTimeoutMs({}), DEFAULT_CHECK_TIMEOUT_MS);
  assert.equal(checkTimeoutMs(), DEFAULT_CHECK_TIMEOUT_MS);
  assert.equal(checkTimeoutMs({ defaultChecks: ["npm test"] }), DEFAULT_CHECK_TIMEOUT_MS);
  // 30 minutes, matching agent.timeoutMs. A cold xcodebuild lane pays for a
  // full Swift compile before the first test runs, so 10 would kill honest work.
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 1_800_000);
});

test("a project's own checkTimeoutMs is used, and nonsense falls back rather than through", () => {
  assert.equal(checkTimeoutMs({ checkTimeoutMs: 5_000 }), 5_000);
  // Fail SAFE toward a bound. `runAsync` reads 0 as "no timer", so passing any
  // of these through is the hang this whole file is about.
  for (const value of [0, -1, null, "1800000", NaN, Infinity, {}, undefined])
    assert.equal(checkTimeoutMs({ checkTimeoutMs: value }), DEFAULT_CHECK_TIMEOUT_MS,
      `checkTimeoutMs: ${JSON.stringify(value)} was passed through`);
});

test("a timed-out check is a failure to every reader, and a timeout to one that looks", async () => {
  // `sleep 99999` was the command here, and it is the one shape where every
  // defect this file covers is invisible: `sh` execs it, so there is no
  // grandchild, nothing holds the stdout pipe, and the whole test passed
  // verbatim against the `runAsync` that predates this work. A real check forks.
  const marker = `afk-reason-probe-${process.pid}-${Date.now()}`;
  const command = `"${process.execPath}" -e "setTimeout(()=>{}, 60000)" ${marker} & wait`;
  let giveUp;
  const result = await Promise.race([
    runAsync(command, { timeout: 500 }),
    // A revert must go RED here, not hang: `runAsync` resolving on `close`
    // never settles while the grandchild holds the pipe, and a test that stops
    // finishing is a test nobody can read the result of.
    new Promise((settle) => { giveUp = setTimeout(() => settle("never resolved"), 20_000); }),
  ]);
  clearTimeout(giveUp);
  spawnSync("pkill", ["-f", marker]);
  assert.notEqual(result, "never resolved", "the bound fired but the promise never settled");
  assert.equal(result.timedOut, true, "fixture precondition: runAsync reaped it");
  assert.equal(result.status, null, "a killed process has no exit status of its own");

  const check = checkResult("sleep 99999", result, 500);
  // `null !== 0` is true, so `checkFailed` would have caught this anyway — but
  // supervisor.mjs's own failed-check scan excludes a null code to skip a
  // skipped check, and would have reported this attempt as having no failing
  // check at all. 124 is what `timeout(1)` reports; the runner is the wrapper.
  assert.equal(check.code, CHECK_TIMEOUT_EXIT_CODE);
  assert.equal(check.code, 124);
  assert.equal(checkFailed(check), true);
  assert.equal(check.timedOut, true);
  assert.equal(check.timeoutMs, 500);

  // The reason string a human, a retry lane and the closeout read.
  assert.equal(checkFailureReason(check), "check timed out after 1s: sleep 99999");
});

test("a command that FORKS is reaped by the bound, and the call returns", async () => {
  // `sleep 99999` above is the one shape where this bug is invisible: `sh` execs
  // a single simple command, so there is no grandchild and nothing holding the
  // stdout pipe. Everything a real check actually is — a pipeline, a background
  // job, `npm test`, `xcodebuild ... | tee` — forks, and so does the Claude CLI
  // every other `runAsync` call site spawns (it starts per-lane MCP servers).
  // Against those the bound could not fire at all.
  const marker = `afk-fork-probe-${process.pid}-${Date.now()}`;
  const survivors = () => spawnSync("pgrep", ["-f", marker], { encoding: "utf8" })
    .stdout.trim().split("\n").filter(Boolean);
  // A grandchild that outlives its `sh` AND inherits the stdout pipe.
  const command = `"${process.execPath}" -e "setTimeout(()=>{}, 60000)" ${marker} & wait`;
  try {
    const startedAt = Date.now();
    // Cleared below whoever wins: an armed 20s timer holds this file's event
    // loop open long after the assertions are done, and a suite that takes 20s
    // to exit is the next person's mystery.
    let giveUp;
    const result = await Promise.race([
      runAsync(command, { timeout: 1_000 }),
      new Promise((settle) => { giveUp = setTimeout(() => settle("never resolved"), 20_000); }),
    ]);
    clearTimeout(giveUp);
    // The failure that matters. `runAsync` resolved on `close`, which waits for
    // the stdio pipes to shut, and the surviving grandchild held the write end
    // open forever: the timer fired, the `sh` died, and the caller went on
    // awaiting — so the timeout could not unblock a lane for exactly the checks
    // it was written for.
    assert.notEqual(result, "never resolved", "the timer fired but the promise never settled");
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 15_000, "resolved, but nowhere near the bound");
    // The other one: SIGTERM to the `sh` pid alone never reached what `sh`
    // forked, so the thing actually burning the machine survived its own bound.
    assert.deepEqual(survivors(), [], "a grandchild outlived the timeout");
  } finally {
    // Reap whatever survived, or a leaked `node` pollutes every later assertion
    // in this suite — and closing the pipe it holds is also what lets a hung
    // `runAsync` finally settle so this file's process can exit.
    spawnSync("pkill", ["-f", marker]);
  }
});

test("output already in the pipe survives a synchronous block over the drain window", async () => {
  // The drain that bounds `exit` was a bare timer, and timers run BEFORE poll in
  // each turn of the event loop: block synchronously for longer than DRAIN_MS
  // between the `exit` event and the next poll — routine here, where concurrent
  // lanes run `spawnSync` git constantly — and the timer expires with the pipes
  // never read, so `finish` destroys them and the WHOLE output is gone. Not a
  // clipped tail: 24,000 bytes written, 0 captured, and `renderPriorAttempts`
  // then reports "It produced no output" over an attempt that produced plenty.
  const marker = `afk-drain-probe-${process.pid}-${Date.now()}`;
  // A grandchild that outlives its `sh`, so nothing closes the pipe and the
  // drain window is the only thing deciding when the output stops being read.
  const command = `"${process.execPath}" -e "setTimeout(()=>{process.stdout.write('x'.repeat(24000));setTimeout(()=>{},60000)},300)" ${marker} &`;
  const blockSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  try {
    const result = await runAsync(command, {
      // `onSpawn` fires BEFORE `runAsync` registers its own `exit` listener, so
      // this one runs first and the `nextTick` it queues runs after the drain
      // has been armed and before the poll phase delivers anything — the only
      // window where the defect exists. Blocking in the listener body instead
      // lets the drain be armed after the block, and reproduces nothing.
      onSpawn: (child) => { child.on("exit", () => { process.nextTick(() => blockSync(2_500)); }); },
    });
    assert.equal(
      result.stdout.length,
      24_000,
      `the drain discarded output the pipe was holding: captured ${result.stdout.length} of 24000 bytes`,
    );
  } finally {
    // The grandchild sleeps 60s on purpose, so that `close` can never fire and
    // decide this test for the drain. Reap it, or it poisons the next pgrep.
    spawnSync("pkill", ["-f", marker]);
  }
});

test("the SIGKILL escalation never fires at a pid the kernel has already reissued", async () => {
  // The escalation handle was dropped on the floor. On the ordinary path
  // SIGTERM works, `exit` fires, Node reaps the child — and five seconds later
  // `process.kill(-pid, "SIGKILL")` went to whatever process group owns that
  // pid now. Every lane this runner spawns is `detached`, so that group is most
  // likely a healthy sibling lane's, killed silently from inside a reaper. The
  // old `child.kill()` was a harmless no-op after a reap; `process.kill(-pid)`
  // is not.
  const signalled = [];
  const real = process.kill;
  process.kill = function spy(pid, signal) {
    signalled.push([pid, signal]);
    return real.call(process, pid, signal);
  };
  try {
    const result = await runAsync("sleep 99999", { timeout: 300 });
    assert.equal(result.timedOut, true, "fixture precondition: the bound fired");
    assert.ok(
      signalled.some(([pid, signal]) => pid === -result.pid && signal === "SIGTERM"),
      "fixture precondition: SIGTERM went to the group",
    );

    // Past the escalation, with the child long since reaped.
    await new Promise((settle) => setTimeout(settle, KILL_ESCALATION_MS + 750));
    assert.deepEqual(
      signalled.filter(([, signal]) => signal === "SIGKILL"),
      [],
      "a SIGKILL was fired after the child had exited and its pid was free to be reused",
    );
  } finally {
    process.kill = real;
  }
});

test("a grandchild that traps SIGTERM is SIGKILLed when the bound's grace runs out", async () => {
  // The case the escalation was written for, and the one it could not reach.
  // The leader `sh` does not trap SIGTERM, so it dies at once, `exit` fires —
  // and the escalation used to be cleared right there, by the very event that
  // proves the leader is gone. What survived was everything below it: the
  // grandchildren that DO trap the signal, which is the whole "killing the
  // driver does not kill its lanes" complaint. Nothing was ever SIGKILLed.
  const marker = `afk-escalation-probe-${process.pid}-${Date.now()}`;
  const survivors = () => spawnSync("pgrep", ["-f", marker], { encoding: "utf8" })
    .stdout.trim().split("\n").filter(Boolean);
  const command =
    `"${process.execPath}" -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)" ${marker} & wait`;
  try {
    const result = await runAsync(command, { timeout: 500 });
    assert.equal(result.timedOut, true, "fixture precondition: the bound fired");
    assert.equal(survivors().length, 1, "fixture precondition: the grandchild ignored SIGTERM");

    await new Promise((settle) => setTimeout(settle, KILL_ESCALATION_MS + 1_500));
    assert.deepEqual(survivors(), [], "the grandchild outlived the SIGKILL escalation");
  } finally {
    spawnSync("pkill", ["-9", "-f", marker]);
  }
});

test("a check that merely fails still reads exactly as it always did", () => {
  // The regression control on the reason string. `check failed: <command>` is
  // what integrate.mjs has always written and what the log and the closeout are
  // read against; only the timeout branch is new.
  const failed = checkResult("npm test", { status: 1, timedOut: false, stdout: "1 failing\n", stderr: "" }, 1_800_000);
  assert.deepEqual(failed, { command: "npm test", code: 1, output: "1 failing\n" });
  assert.equal(checkFailureReason(failed), "check failed: npm test");
  assert.equal("timedOut" in failed, false, "a passing or red check carries no timeout bookkeeping");

  const passed = checkResult("npm test", { status: 0, timedOut: false, stdout: "ok\n", stderr: "" }, 1_800_000);
  assert.equal(checkFailed(passed), false);
  assert.deepEqual(passed, { command: "npm test", code: 0, output: "ok\n" });
});

test("stdout and stderr are both carried, so verification.json keeps the whole record", () => {
  // The clip in worker.mjs is on the PROMPT copy only. This record is the one
  // that rides the task branch, and it is untruncated on purpose.
  const output = "x".repeat(200_000);
  const check = checkResult("npm test", { status: 1, timedOut: false, stdout: output, stderr: "and stderr" }, 1_000);
  assert.equal(check.output, `${output}and stderr`);
  assert.equal(check.output.length, 200_010);
});

// ---------------------------------------------------------------------------
// The post-merge gate, end to end
// ---------------------------------------------------------------------------
//
// Driven through the fast-forward path, which spawns no agent: `main` sits
// exactly where the lane forked from, so `runIntegration` merges with git alone
// and every second the test spends is the check's own.

const repoWithFirstLane = (config) => {
  const root = mkdtempSync(join(tmpdir(), "afk-check-timeout-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(root, ".gitignore"), ".afk/\n");
  writeConfig(root, config);
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("checkout", "-b", "task/300");
  writeFileSync(join(root, "roulette.js"), "export const spin = () => 4;\n");
  git("add", ".");
  git("commit", "-m", "task 300: daily challenge roulette");
  git("checkout", "main");
  return { root, git, base };
};

// A FORKING check, not `sleep 99999`. `sh` execs a simple command, so that one
// has no grandchild and nothing holding the stdout pipe — the shape where every
// defect in this file is invisible, and the shape no real check has.
const GATE_MARKER = `afk-gate-probe-${process.pid}-${Date.now()}`;
const GATE_CHECK = `"${process.execPath}" -e "setTimeout(()=>{}, 60000)" ${GATE_MARKER} & wait`;
const TASK = { id: "300", title: "Daily challenge roulette", body: "spin the wheel", checks: [GATE_CHECK] };

test("a post-merge check that never returns rolls the integration back instead of holding the epic", async () => {
  // Integration is serial, so this one is worse than a stuck lane: nothing else
  // merges behind it.
  const config = { maxParallel: 1, defaultChecks: [GATE_CHECK], checkTimeoutMs: 2_000 };
  const { root } = repoWithFirstLane(config);
  let giveUp;
  try {
    const startedAt = Date.now();
    // RACED, so a revert is a RED and not a hang. Drop `timeout:` from
    // integrate.mjs's check call, or resolve on `close` again, and this used to
    // stop finishing — a test whose failure signal is that the suite never ends
    // reports nothing to the person reading the run.
    const result = await Promise.race([
      runIntegration({
        root, config, task: TASK, branch: "task/300", baseSha: null, attempt: 1, taskVerification: {},
      }),
      new Promise((settle) => { giveUp = setTimeout(() => settle("never returned"), 30_000); }),
    ]);
    clearTimeout(giveUp);
    assert.notEqual(result, "never returned", "the bound fired but the integration never came back");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 25_000, `the check was reaped after ${elapsed}ms, so nothing bounded it`);
    assert.notEqual(result.outcome, "passed");
    // The grandchild the check forked is what was actually burning the machine;
    // a bound that only reaches the `sh` above it has not bounded anything.
    assert.deepEqual(
      spawnSync("pgrep", ["-f", GATE_MARKER], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean),
      [],
      "the check's grandchild outlived the integration's bound",
    );

    // Distinguishable from a red check in the reason the orchestrator log
    // prints and in the record, rather than the flat `check failed: …` that
    // sends a reader looking for a broken assertion.
    assert.equal(result.verification.failureReason, `check timed out after 2s: ${GATE_CHECK}`);
    assert.equal(result.verification.checks[0].timedOut, true);
    assert.equal(result.verification.checks[0].code, CHECK_TIMEOUT_EXIT_CODE);
  } finally {
    clearTimeout(giveUp);
    spawnSync("pkill", ["-f", GATE_MARKER]);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The closeout fix gate, the third call site
// ---------------------------------------------------------------------------

test("a closeout gate check that hits its bound reads as timed out, not as a red check", async (t) => {
  // The gate hands `runBaselineChecks`'s outcome back into a record and used to
  // drop `timedOut` on the way through, so a `baselineTimeoutMs` kill was
  // rendered "and it FAILED — `swift test` exited non-zero". That sentence is
  // verbatim the misdiagnosis ccae24b removed from the other two call sites,
  // reintroduced in a third that the same change added: it sends a human to
  // look for a broken assertion, when what happened is that nothing checked the
  // tip at all.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(root, ".gitignore"), ".afk/\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const headBefore = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(root, "repair.txt"), "the closeout's repair\n");
  git("add", ".");
  git("commit", "-qm", "fix: closeout findings");
  const head = git("rev-parse", "HEAD").stdout.trim();

  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["sleep 99999"] },
    epicId: "203",
    headBefore,
    reuse: false,
    runChecks: ({ commands, cwd }) => runBaselineChecks({ commands, cwd, timeoutMs: 1_000, say: () => {} }),
  });

  assert.equal(gate.fixSha, head, "fixture precondition: the gate had a commit to run over");
  assert.equal(gate.status, "failed", "a bound that fired is still not a pass");
  assert.equal(gate.timedOut, true, "the record threw away the one fact that distinguishes this");
  assert.equal(gate.failingCode, CHECK_TIMEOUT_EXIT_CODE);

  // The sentence a human reads in the morning digest.
  const line = renderCloseoutGateLine(gate);
  assert.match(line, /TIMED OUT/);
  assert.match(line, /unverified rather than known broken/);
  assert.doesNotMatch(line, /exited non-zero/);
});

test("the post-merge gate waits for another epic's gate lock, and its bound starts once it holds it (#178)", async () => {
  // A 1s bound on a 0.5s check, behind a holder that keeps the lock ~1.2s.
  // Counted from the gate's entry, the bound would fire before the check ran.
  const config = { maxParallel: 1, defaultChecks: ["sleep 0.5"], checkTimeoutMs: 1_000 };
  const { root } = repoWithFirstLane(config);
  const lockDir = mkdtempSync(join(tmpdir(), "afk-gate-lock-integration-"));
  const previous = process.env.AFK_GATE_LOCK_DIR;
  process.env.AFK_GATE_LOCK_DIR = lockDir;
  let holder = null;
  try {
    holder = holdGateLock(join(lockDir, "gate.lock"), { ms: 1_200 });
    await holder.held;
    const lines = [];
    const result = await runIntegration({
      root, config, epic: "183", say: (line) => lines.push(line),
      task: { ...TASK, checks: ["sleep 0.5"] }, branch: "task/300", baseSha: null, attempt: 1, taskVerification: {},
    });
    assert.equal(result.outcome, "passed", result.failureReason);
    assert.match(lines.join("\n"), /integration gate waiting for the gate lock held by other-repo #928 \(baseline/);
    const event = JSON.parse(readFileSync(join(root, ".afk", "runs", "gate-events.jsonl"), "utf8").trim().split("\n").at(-1));
    assert.equal(event.kind, "integration");
    assert.ok(event.lockWaitS >= 1, `the gate event did not carry the wait: ${JSON.stringify(event)}`);
  } finally {
    await holder?.stop();
    if (previous === undefined) delete process.env.AFK_GATE_LOCK_DIR;
    else process.env.AFK_GATE_LOCK_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});
