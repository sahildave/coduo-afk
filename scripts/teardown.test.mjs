import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearWorkerPid, recordWorkerPid } from "./scheduler.mjs";
import { run, runAsync } from "./lib.mjs";
import { teardownRecordedLanes } from "./teardown.mjs";
import { teardownWorktree } from "./worktree.mjs";

// The pids whose command line carries `tag`. Run directly, not through `sh -c`:
// that wrapper's own argv carries the tag, and while BSD pgrep (macOS) leaves out
// its ancestors by default, procps pgrep (Linux) leaves out only itself, so a
// wrapped call counted its own shell as a survivor.
const pgrep = (tag) => String(spawnSync("pgrep", ["-f", tag], { encoding: "utf8" }).stdout ?? "");

test("a lane pid is present while it runs and cleared when it ends", () => {
  const state = { tasks: { 58: { lifecycle: "running" } }, activeWorkers: { 58: { taskId: "58", pid: null } } };
  recordWorkerPid(state, "58", 4242);
  assert.equal(state.tasks[58].pid, 4242);
  assert.equal(state.activeWorkers[58].pid, 4242);
  clearWorkerPid(state, "58");
  assert.equal("pid" in state.tasks[58], false);
  assert.equal("58" in state.activeWorkers, false);
});

test("shutdown signals every recorded lane pid, builders and integrator alike", () => {
  // What this can honestly check is WHICH pids get signalled. The fate strings
  // it used to assert came out of its own `alive` stub and were true of
  // nothing; they are checked against real processes in the two tests below.
  const signalled = [];
  const state = {
    activeWorkers: { 58: { taskId: "58", pid: 4101 }, 59: { taskId: "59", pid: 4102 } },
    activeIntegrator: { taskId: "57", pid: 4103 },
  };
  const fates = teardownRecordedLanes(state, {
    signalPid: (pid) => { signalled.push(pid); throw new Error("kill ESRCH"); },
    settleMs: 0,
  });
  assert.deepEqual(signalled, [4101, 4102, 4103]);
  assert.deepEqual(fates.map((row) => row.role), ["builder", "builder", "integrator"]);
  // A signal that raised is reported as one, and outranks any liveness probe:
  // a stop this never made must never read as one it did.
  assert.deepEqual(fates.map((row) => row.fate), [
    "signal failed: kill ESRCH",
    "signal failed: kill ESRCH",
    "signal failed: kill ESRCH",
  ]);
});

test("a lane that honours SIGTERM is reported stopped, not still running", async () => {
  // THE INVERSION, against a real process. A lane is this process's own child,
  // so killing it leaves a ZOMBIE until the event loop reaps it — and
  // `kill(pid, 0)` cannot tell a zombie from a runner, while `auto.mjs`'s
  // shutdown handler calls `process.exit` before the loop ever gets that turn.
  // Every lane the runner killed correctly was therefore reported "still
  // running after SIGTERM", which is the report that sends a human hunting for
  // processes that are already gone.
  const tag = `afk-teardown-stopped-${process.pid}`;
  let pid = null;
  // `exec`, as the runner's own agent launch does (lib.mjs `launchPrefix`): the
  // recorded pid must BE the lane. bash execs a lone command implicitly; dash,
  // Linux's /bin/sh, forks it and leaves `sh` as the recorded pid.
  const call = runAsync(`exec node -e 'setTimeout(()=>{},60000)' ${tag}`, {
    onSpawn: (child) => { pid = child.pid; },
  });
  await new Promise((done) => setTimeout(done, 750));

  const fates = teardownRecordedLanes({ activeWorkers: { "01": { taskId: "task-01", pid } } });
  const survivors = pgrep(tag).trim().split("\n").filter(Boolean);
  run(`pkill -9 -f ${tag} || true`);
  assert.deepEqual(survivors, [], "fixture precondition: the lane really was stopped");
  assert.deepEqual(fates.map((row) => row.fate), ["stopped after SIGTERM"]);
  await call;
});

test("a lane that ignores SIGTERM is still reported as running", async () => {
  // The control on the test above: the settle must not turn every fate into
  // "stopped". This lane traps SIGTERM and carries on, which is the case the
  // string exists for and the one a human has to go and find by hand.
  const tag = `afk-teardown-deaf-${process.pid}`;
  let pid = null;
  const call = runAsync(
    `exec node -e 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)' ${tag}`,
    { onSpawn: (child) => { pid = child.pid; } },
  );
  await new Promise((done) => setTimeout(done, 750));

  const fates = teardownRecordedLanes({ activeWorkers: { "01": { taskId: "task-01", pid } } });
  run(`pkill -9 -f ${tag} || true`);
  assert.deepEqual(fates.map((row) => row.fate), ["still running after SIGTERM"]);
  await call;
});

test("the leader is signalled before its group, so a successful kill is never reported as a failure", async () => {
  // The leader is IN the group it leads. Signalling the group first could stop
  // it before the unguarded `process.kill(pid)` ran, and the ESRCH that raised
  // there meant the kill had WORKED — but `signalError` outranks the `alive()`
  // probe in `teardownRecordedLanes`, so a lane stopped correctly came back as
  // `signal failed: kill ESRCH`. That is the false report this function's own
  // comment forbids, in the opposite direction.
  const tag = `afk-teardown-order-${process.pid}`;
  // The lane runs in its worktree, which is the identity the group signal is
  // now gated on (#95): record it and spawn there so the gate reads the pid as
  // still ours and the group is signalled.
  const worktree = mkdtempSync(join(tmpdir(), "afk-teardown-order-"));
  let pid = null;
  const call = runAsync(`node -e 'setTimeout(()=>{},60000)' ${tag} & wait`, {
    cwd: worktree,
    onSpawn: (child) => { pid = child.pid; },
  });
  const settle = () => new Promise((done) => setTimeout(done, 1_000));
  await settle();

  // Signal 0 excluded: that is `pidAlive`'s liveness probe, not a teardown.
  const signalled = [];
  const real = process.kill;
  process.kill = function spy(target, signal) {
    if (signal !== 0) signalled.push(target);
    return real.call(process, target, signal);
  };
  let fates;
  try {
    fates = teardownRecordedLanes({ activeWorkers: { "01": { taskId: "task-01", pid, worktree } } });
  } finally {
    process.kill = real;
  }

  assert.deepEqual(
    signalled,
    [pid, -pid],
    "the group was signalled before the leader that lives inside it",
  );
  assert.equal(fates[0].fate.startsWith("signal failed"), false, fates[0].fate);
  run(`pkill -9 -f ${tag} || true`);
  rmSync(worktree, { recursive: true, force: true });
  await call;
});

// A REAL lane, forked, so this fails against a bare `process.kill(pid)`. The
// mock above cannot catch it: it asserts which pid was signalled, and the
// defect is about which processes that signal reaches. quillnote had to find
// these survivors afterwards by cwd with `lsof`, because nothing records them.
test("tearing down a lane reaps the grandchildren it forked, not just its leader", async () => {
  const tag = `afk-teardown-test-${process.pid}`;
  // The recorded worktree is the cwd the group signal is gated on (#95); run
  // the lane there so the gate reads the pid as still ours.
  const worktree = mkdtempSync(join(tmpdir(), "afk-teardown-reap-"));
  let pid = null;
  // `& wait` makes sh fork rather than exec, so the node below is a distinct
  // pid in the lane's group — the shape of any project test runner or MCP server.
  const call = runAsync(`node -e 'setTimeout(()=>{},60000)' ${tag} & wait`, {
    cwd: worktree,
    onSpawn: (child) => { pid = child.pid; },
  });
  const settle = () => new Promise((done) => setTimeout(done, 1_500));
  // The lane's own `sh` carries the tag in its command line too, so subtract it:
  // this test is about the processes BELOW the pid teardown was handed.
  const survivors = () =>
    pgrep(tag)
      .trim().split("\n").filter(Boolean)
      .filter((row) => Number(row) !== pid);

  await settle();
  assert.equal(survivors().length, 1, "the forked grandchild should be running before teardown");

  teardownRecordedLanes({ activeWorkers: { "01": { taskId: "task-01", pid, worktree } } });
  await settle();

  const left = survivors();
  // Reap before asserting: a failure here must not leak a 60s node into the
  // rest of the suite, where it would poison the next test's pgrep.
  if (left.length) run(`pkill -9 -f ${tag} || true`);
  rmSync(worktree, { recursive: true, force: true });
  assert.deepEqual(left, [], `the lane's grandchildren outlived its teardown: ${left.join(", ")}`);
  await call;
});

// The wrong-process kill (#95). A recorded pid outlives the lane it named; run
// hours after a crash it may be recycled onto an unrelated process. Before the
// identity gate, `-pid` SIGTERM'd that stranger's whole process GROUP. Here the
// "recycled" pid is a REAL detached group leader with a bystander grandchild, in
// a cwd that is NOT the recorded worktree — so the gate must withhold the group
// signal and the bystander must survive.
test("a recorded pid recycled onto a stranger's group is not group-signalled (#95)", async () => {
  const tag = `afk-teardown-stranger-${process.pid}`;
  // The stranger runs somewhere the lane never did; the lane's recorded
  // worktree is a DIFFERENT directory the recycled pid has no connection to.
  const strangerCwd = mkdtempSync(join(tmpdir(), "afk-teardown-stranger-"));
  const recordedWorktree = mkdtempSync(join(tmpdir(), "afk-teardown-lane-"));
  let pid = null;
  // A detached group leader (`& wait` forks) with a grandchild in its group —
  // the shape a recycled pid landing on any real process group would have. Its
  // pgid equals its pid, so a pgid==pid identity check would wave it through;
  // only the cwd tells it apart from our lane.
  const call = runAsync(`node -e 'setTimeout(()=>{},60000)' ${tag} & wait`, {
    cwd: strangerCwd,
    onSpawn: (child) => { pid = child.pid; },
  });
  const settle = () => new Promise((done) => setTimeout(done, 1_500));
  const bystanders = () =>
    pgrep(tag)
      .trim().split("\n").filter(Boolean)
      .filter((row) => Number(row) !== pid);

  await settle();
  assert.equal(bystanders().length, 1, "the stranger's grandchild should be running before teardown");

  // The recorded lane points at this pid but names a worktree that is not the
  // stranger's cwd: the pid is no longer ours, so its group must be spared.
  teardownRecordedLanes({ activeWorkers: { "01": { taskId: "task-01", pid, worktree: recordedWorktree } } });
  await settle();

  const left = bystanders();
  // Reap everything before asserting so neither branch leaks a 60s node.
  run(`pkill -9 -f ${tag} || true`);
  rmSync(strangerCwd, { recursive: true, force: true });
  rmSync(recordedWorktree, { recursive: true, force: true });
  // The group signal must have been WITHHELD, so the stranger's grandchild is
  // still running. On HEAD the ungated `-pid` killed it and this is empty.
  assert.equal(left.length, 1, "a recycled-pid group signal reached and killed a stranger's process group member");
  await call;
});

test("a lane whose builder is killed still runs the project's teardown hook, in its worktree (#109)", async () => {
  // The simulator a lane's check booted does not know the builder is dead. The
  // hook is the only thing that reaches it on this path, so it has to run
  // after the kill, in the lane's own worktree, and it must not be able to
  // change the fate the kill earned.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "afk-teardown-hook-")));
  const log = join(worktree, "hook.log");
  const setup = { teardown: [`printf '%s' "$PWD" > hook.log; exit 3`] };
  const tag = `afk-teardown-hook-${process.pid}`;
  let pid = null;
  // `exec`, as the runner's own agent launch does (lib.mjs `launchPrefix`): the
  // recorded pid must BE the lane. bash execs a lone command implicitly; dash,
  // Linux's /bin/sh, forks it and leaves `sh` as the recorded pid.
  const call = runAsync(`exec node -e 'setTimeout(()=>{},60000)' ${tag}`, {
    onSpawn: (child) => { pid = child.pid; },
  });
  await new Promise((done) => setTimeout(done, 750));

  try {
    const fates = teardownRecordedLanes(
      { activeWorkers: { "01": { taskId: "task-01", pid, worktree } } },
      { teardown: (lane) => teardownWorktree({ worktree: lane.worktree, setup }) },
    );
    run(`pkill -9 -f ${tag} || true`);
    assert.equal(readFileSync(log, "utf8"), worktree, "the hook ran with the lane as $PWD");
    assert.deepEqual(fates.map((row) => row.fate), ["stopped after SIGTERM"]);
    // A hook that exits non-zero is reported on the row and decides nothing.
    assert.deepEqual(fates[0].teardown.map((hook) => hook.status), [3]);
  } finally {
    run(`pkill -9 -f ${tag} || true`);
    rmSync(worktree, { recursive: true, force: true });
    await call;
  }
});

test("a lane with no teardown hook configured is torn down exactly as before", () => {
  const fates = teardownRecordedLanes(
    { activeWorkers: { "01": { taskId: "task-01", pid: 4101 } } },
    { signalPid: () => { throw new Error("kill ESRCH"); }, settleMs: 0 },
  );
  assert.deepEqual(fates[0].teardown, []);
});
