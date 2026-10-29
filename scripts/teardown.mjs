import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { pidAlive } from "./dashboard-data.mjs";
import { shellQuote } from "./lib.mjs";

export const recordedLanePids = (state) => {
  const rows = Object.values(state?.activeWorkers ?? {})
    .filter((lane) => Number(lane?.pid) > 0)
    .map((lane) => ({ pid: Number(lane.pid), taskId: String(lane.taskId), role: "builder", worktree: lane.worktree ?? null }));
  const integrator = state?.activeIntegrator;
  if (Number(integrator?.pid) > 0)
    rows.push({ pid: Number(integrator.pid), taskId: String(integrator.taskId), role: "integrator", worktree: integrator.worktree ?? null });
  return [...new Map(rows.map((row) => [row.pid, row])).values()];
};

/**
 * Is the process at `pid` STILL the lane we recorded, or a stranger the kernel
 * handed the pid to since?
 *
 * A recorded pid outlives the process it named: run `afk wave stop` hours after
 * a crash and that pid may have been recycled onto something unrelated. A bare
 * SIGTERM to it kills one stranger; a `-pid` group signal kills a stranger's
 * whole process GROUP (#95). The identity that survives the crash is the lane's
 * cwd: `runAsync` starts every builder and integrator with `cwd` set to its
 * worktree (`worker.mjs`), and `state.json` records that worktree. A recycled
 * pid answers with a different cwd, so a live cwd that matches the recorded
 * worktree is the one thing that says "and it is still ours".
 *
 * `lsof -d cwd` is the portable read (macOS has no `/proc`), and it is the same
 * cwd lookup the "find the survivors afterwards" complaint had to do by hand.
 * Path comparison goes through `samePath` for the /var vs /private/var aliasing
 * that makes a temp-dir worktree read as a mismatch otherwise.
 *
 * FAIL DIRECTION: closed. Anything short of a proven cwd match — no recorded
 * worktree, `lsof` absent or unreadable, an unparseable answer — reads as "not
 * provably ours" and withholds the group signal. A leaked grandchild is a
 * nuisance a human finds with `lsof`; SIGTERM to a stranger's group is the
 * destructive error this exists to prevent.
 */
const recordedLaneStillOwns = (pid, worktree) => {
  if (!worktree) return false;
  const result = spawnSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const cwd = String(result.stdout ?? "").split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? samePath(cwd, worktree) : false;
};

/**
 * Signal a recorded lane: the leader itself first, then its process GROUP.
 *
 * `runAsync` spawns every lane `detached`, so the pid recorded here is also a
 * process-group id and the grandchildren a lane forked — a project's own test
 * runner, a per-lane MCP server — are in that group. Signalling the bare pid
 * reaches the leader alone and leaves them running, which is the long-standing
 * "killing the wave driver does not kill its lanes" complaint: nothing records
 * those pids, so they can only be found afterwards by cwd with `lsof`.
 *
 * FAIL DIRECTION: closed on the leader, open on the group. The leader signal is
 * delivered unguarded so that a pid which really is dead still raises, and
 * `teardownRecordedLanes` reports it as `signal failed:` instead of claiming a
 * stop it did not perform. Reporting a kill that did not happen is the worse
 * error here: it is the one that sends a human away believing the machine is
 * idle. The group kill is swallowed because it is best-effort — the group may
 * already be gone (ESRCH), and a stale pid from an earlier runner could name a
 * group that is no longer ours.
 *
 * THE LEADER GOES FIRST BECAUSE IT IS IN THAT GROUP. Signalling the group first
 * stopped the leader before the unguarded line was reached, so the ESRCH raised
 * there meant the kill had WORKED — and a lane torn down correctly was reported
 * `signal failed:`. That is the same false report the paragraph above forbids,
 * running the other way.
 *
 * THE GROUP SIGNAL IS GATED ON IDENTITY (#95). The leader signal stays unguarded
 * — a dead pid must still raise so the fate reads honestly — but a `-pid` group
 * signal is only sent when `recordedLaneStillOwns` proves the pid is the lane we
 * recorded and not a recycled stranger. The identity is read BEFORE the leader
 * signal, so a leader that honours SIGTERM in the same breath cannot turn the
 * check into a false mismatch.
 */
const signalLaneGroup = (pid, worktree, signal = "SIGTERM") => {
  const groupIsOurs = recordedLaneStillOwns(pid, worktree);
  process.kill(pid, signal);
  if (!groupIsOurs) return;
  try { process.kill(-pid, signal); } catch { /* group gone, or never ours */ }
};

/**
 * Is `pid` a process that is still RUNNING, as opposed to merely signallable?
 *
 * `pidAlive` asks `kill(pid, 0)`, and a lane is this process's own child: kill
 * it and it becomes a ZOMBIE until the event loop reaps it, and a zombie
 * answers signal 0 exactly as a healthy process does. `auto.mjs`'s shutdown
 * handler calls `process.exit` before the loop ever gets that turn, so the
 * probe below ran against every lane the runner had just killed successfully
 * and reported all of them "still running after SIGTERM" — a deterministic
 * inversion of the one thing this function is for. `ps` is asked for the
 * process state because signal 0 cannot tell a corpse from a runner.
 *
 * FAIL DIRECTION: unchanged, and stated at the guard — anything not PROVEN dead
 * reads as alive. A `ps` that will not run, or a state line we cannot parse,
 * keeps the old answer. Reporting a kill that did not happen is still the worse
 * error: it is the one that sends a human away believing the machine is idle.
 */
const laneRunning = (pid) => {
  if (!pidAlive(pid)) return false;
  const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return !(state.status === 0 && /^\s*Z/.test(String(state.stdout ?? "")));
};

// How long a lane gets to act on SIGTERM before its fate is written down, and
// how often it is asked. `process.kill` returns as soon as the signal is
// QUEUED, so a lane that honours it perfectly is still running for the
// milliseconds it takes to unwind — and probing immediately reported that as
// having ignored the signal. Synchronous, because the only caller is a signal
// handler that calls `process.exit` next and cannot await anything.
const SETTLE_MS = 1_000;
const SETTLE_STEP_MS = 50;
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// `teardown` is the project's `worktreeSetup.teardown` hook, run in each lane's
// worktree AFTER the signal has settled (#109): the resource a lane's check
// created — a booted simulator — outlives the builder whether it exited, died
// or was just killed here, and this is the only path that reaches a lane the
// orchestrator is taking down. It runs for every recorded lane, a dead pid
// included: a builder that died an hour ago left its device booted too. Its
// result rides the fate row as `teardown`; it never changes `fate`.
export const teardownRecordedLanes = (
  state,
  { signalPid = signalLaneGroup, alive = laneRunning, settleMs = SETTLE_MS, teardown = null } = {},
) => recordedLanePids(state).map((lane) => {
  let signalError = null;
  try { signalPid(lane.pid, lane.worktree); } catch (error) { signalError = error; }
  const deadline = Date.now() + settleMs;
  let stillAlive = true;
  for (;;) {
    try { stillAlive = alive(lane.pid); } catch { stillAlive = true; }
    if (!stillAlive || Date.now() >= deadline) break;
    sleepSync(SETTLE_STEP_MS);
  }
  let hooks = [];
  if (teardown) try { hooks = teardown(lane) ?? []; } catch (error) { hooks = [{ command: "teardown", status: null, output: error.message }]; }
  return {
    ...lane,
    fate: signalError
      ? `signal failed: ${signalError.message}`
      : stillAlive ? "still running after SIGTERM" : "stopped after SIGTERM",
    teardown: hooks,
  };
});

const processCwds = () => {
  const out = String(spawnSync("lsof", ["-d", "cwd", "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "");
  const rows = [];
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) rows.push({ pid, cwd: line.slice(1) });
  }
  return rows;
};

const ancestorsOf = (pid) => {
  const parent = new Map();
  const out = String(spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "");
  for (const line of out.split("\n")) {
    const [child, ppid] = line.trim().split(/\s+/).map(Number);
    if (child) parent.set(child, ppid);
  }
  const chain = new Set([pid]);
  for (let at = parent.get(pid); at && !chain.has(at); at = parent.get(at)) chain.add(at);
  return chain;
};

/**
 * Stop every process whose cwd is inside `dirs`, except this process and its
 * ancestors (the `afk epic` wrapper, the pane shell that launched it).
 *
 * The recorded-pid teardown above only reaches lanes still in
 * `state.activeWorkers`. A herdr lane's `claude` session, with its MCP and
 * permission-broker children, outlives its lane: after the 2026-10-01 runs
 * ended normally, five such sessions sat 5 to 9 hours in lane and epic
 * worktrees. Nothing records their pids and their argv names no lane; the cwd
 * is the only thing tying them to the run, so one `lsof -d cwd` over every
 * process finds them.
 *
 * SIGTERM, a settle of up to `settleMs`, then SIGKILL for survivors — an
 * interactive pane shell ignores SIGTERM. Never throws: `lsof` or `ps` missing
 * reads as "nothing found". Returns the pids signalled.
 */
export const stopProcessesUnder = (dirs, { selfPid = process.pid, settleMs = 3_000 } = {}) => {
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const roots = dirs.filter(Boolean).map(real);
  if (!roots.length) return [];
  const spared = ancestorsOf(selfPid);
  const pids = [...new Set(processCwds()
    .filter(({ pid, cwd }) => !spared.has(pid) && roots.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`)))
    .map(({ pid }) => pid))];
  const send = (pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } };
  for (const pid of pids) send(pid, "SIGTERM");
  const deadline = Date.now() + settleMs;
  let left = pids;
  while (left.length && Date.now() < deadline) {
    sleepSync(SETTLE_STEP_MS);
    left = left.filter(laneRunning);
  }
  for (const pid of left) send(pid, "SIGKILL");
  return pids;
};

/**
 * Every worktree this repository has registered, with the branch each holds.
 *
 * `git worktree list --porcelain` is the only reliable answer: a path can be
 * registered while its directory is gone, which is exactly the state that makes
 * a branch undeletable for no visible reason.
 */
const listWorktrees = (git, root) => {
  const rows = [];
  for (const line of String(git(root, "worktree list --porcelain").stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) rows.push({ path: line.slice("worktree ".length).trim(), branch: null });
    else if (line.startsWith("branch ") && rows.length) rows[rows.length - 1].branch = line.slice("branch ".length).trim();
  }
  return rows;
};

// git prints resolved paths; a caller holds the path it was handed. On macOS
// those differ by /var vs /private/var for anything under the temp directory,
// and comparing them raw reports a removed worktree as still present.
const samePath = (a, b) => {
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(a) === real(b);
};

/**
 * Remove a wave's worktree and then its branch, and VERIFY each removal.
 *
 * The order — worktree, prune, branch — is not cosmetic. `git branch -D
 * wave-NN` fails while any worktree still holds the branch, and its stderr goes
 * to a log nobody reads, so a teardown that reported success left the branch
 * behind at the base it was cut from. The next cut then adopted it, and a wave
 * whose tasks all passed could not be fast-forwarded onto a base that had moved
 * past it (quillnote wave-31, issue #74). Each step is re-read afterwards
 * rather than trusted: `git worktree list` for the worktree, `show-ref` for the
 * branch.
 *
 * FAIL DIRECTION: reports, never throws, and never claims a removal it did not
 * make. Throwing is worse — this runs at the end of a wave that already failed,
 * where taking the night down costs more than a stale ref. Claiming falsely is
 * worse still: the caller reads `branchGone` to decide whether it may cut, and
 * a false "gone" is precisely how the stale branch got adopted.
 *
 * @param {(cwd: string, command: string) => {status: number, stdout: string, stderr: string}} git
 * @param {string|null} branch the branch to delete, or null to remove the worktree only
 */
export const removeWaveRefs = ({ git, root, branch = null, worktree = null, removeWorktree }) => {
  const ref = branch ? `refs/heads/${branch}` : null;
  const targets = new Set(worktree ? [worktree] : []);
  if (ref) for (const row of listWorktrees(git, root)) if (row.branch === ref) targets.add(row.path);

  const notes = [];
  for (const path of targets) {
    try { removeWorktree({ root, worktree: path, id: branch }); }
    catch (error) { notes.push(`could not remove worktree ${path}: ${error.message}`); }
  }
  git(root, "worktree prune");
  const registered = listWorktrees(git, root);
  const held = [...targets].filter((path) => registered.some((row) => samePath(row.path, path)));
  if (held.length) notes.push(`still registered as a worktree: ${held.join(", ")}`);

  let branchGone = true;
  if (branch) {
    const removal = git(root, `branch -D ${shellQuote(branch)}`);
    branchGone = git(root, `show-ref --verify --quiet ${shellQuote(ref)}`).status !== 0;
    if (!branchGone)
      notes.push(`\`git branch -D ${branch}\` did not remove it: ${(removal.stderr || removal.stdout || "").trim() || "it reported no error"}`);
  }
  return { worktreeGone: held.length === 0, branchGone, notes };
};
