// scripts/gate-lock.mjs — one full gate at a time across every epic on the machine (#178).
//
// A baseline, an integration's post-merge checks and a closeout fix gate are
// each a whole-machine load spike, and two epics ran them at the same time by
// construction: harbour #489's e2e went red at host load 12 and passed 248/248
// on a quiet host. This is a lock, not a scheduler — it reads no load and asks
// no model. Lane checks (`defaultChecks` inside a lane) never take it.
//
// The lock is one file, `~/.afk-claude/gate.lock`, holding the holder's pid,
// project, epic, gate kind and start time. It is created with `link(2)` from a
// fully written temp file, so it either exists complete or not at all. A holder
// whose pid is dead (crashed, SIGKILLed), or whose pid now belongs to a process
// that started later (a reused pid), is taken over by the next waiter.
//
// Fail direction: OPEN. A gate that cannot take the lock for a reason other
// than another live holder (an unwritable home, say) runs anyway, which is the
// pre-#178 behaviour: an overlapping gate is slow, a gate that never runs stops
// the epic.
import {
  linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pidAlive } from './dashboard-data.mjs';

// The baseline's heartbeat interval (`BASELINE_HEARTBEAT_MS` in auto.mjs is
// this value). A waiting gate speaks at the same cadence as a running one.
export const GATE_HEARTBEAT_MS = 30_000;
export const GATE_LOCK_POLL_MS = 1_000;

/** Where the lock lives: the runner's home, shared by every epic and repo. */
export const gateLockDir = () => (process.env.AFK_GATE_LOCK_DIR
  ? resolve(process.env.AFK_GATE_LOCK_DIR)
  : resolve(homedir(), '.afk-claude'));
export const gateLockPath = (dir = gateLockDir()) => resolve(dir, 'gate.lock');

/** `gateLock: false` in `.afk-setup/config.yaml` turns the lock off. Default on. */
export const gateLockEnabled = (config) => config?.gateLock !== false;

/** The project's marker that it is waiting, read by `afk status`. */
export const gateWaitPath = (root) => resolve(root, '.afk', 'gate-wait.json');

/** When `pid` started, in ms, from `ps`; null when it cannot be read. */
export const processStartedMs = (pid) => {
  // `lstart` follows the locale, and Date.parse reads only the C one.
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const started = Date.parse(String(result.stdout ?? '').trim());
  return Number.isFinite(started) ? started : null;
};

// `ps` reports a start time to the second; the holder's own estimate is ms.
const START_TOLERANCE_MS = 3_000;

/**
 * Is the live `pid` a different process from the one that wrote the lock? A
 * crashed holder's pid can be reused by an unrelated process, and a pid check
 * alone would then wait behind it forever. Unknown either way reads as the
 * same process: the wait goes on, as before.
 */
const pidReused = (holder, startedAt) => {
  const recorded = Date.parse(holder?.pidStartedAt ?? '');
  if (!Number.isFinite(recorded)) return false;
  const actual = startedAt(holder.pid);
  return actual !== null && Math.abs(actual - recorded) > START_TOLERANCE_MS;
};

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

export const readGateHolder = (path = gateLockPath()) => readJson(path);

/** "<project> #<epic> (<kind>, since <iso>)" — who a waiter is waiting on. */
export const describeHolder = (holder) => {
  if (!holder) return 'an unknown holder';
  const epic = holder.epic == null ? '' : ` #${holder.epic}`;
  return `${holder.project ?? 'an unknown project'}${epic} (${holder.kind ?? 'gate'}, pid ${holder.pid}, since ${holder.since ?? 'unknown'})`;
};

/** Create the lock file atomically, or return false if one is already there. */
const tryCreate = (path, record) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${record.token}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`);
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
};

// A breaker is held for one read and one unlink. One older than this was left
// by a process that died holding it. Removing a stale breaker is a stat then
// an rm, so this bound assumes no pause of 10 s between the two.
const BREAKER_STALE_MS = 10_000;

/**
 * Remove a lock whose holder is dead. Only the process holding the breaker
 * (`<lock>.break`, created exclusively) may remove the lock, and it removes it
 * only while it still carries the dead holder's token. Nothing else ever
 * removes a lock but its own holder, so between that read and the unlink the
 * file cannot be replaced: a live lock that replaced the dead one is never
 * moved or deleted, whoever else is creating or taking over at the time.
 * `between` is a test seam, run between the read and the unlink. Returns
 * whether this call held the breaker; false means another taker holds it.
 */
export const takeOver = (path, dead, between = () => {}) => {
  const breaker = `${path}.break`;
  try {
    writeFileSync(breaker, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(breaker).mtimeMs > BREAKER_STALE_MS) rmSync(breaker, { force: true });
    } catch { /* gone already */ }
    return false;
  }
  try {
    const record = readJson(path);
    between();
    if ((record?.token ?? null) === (dead.token ?? null)) rmSync(path, { force: true });
  } finally {
    rmSync(breaker, { force: true });
  }
  return true;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Wait for the gate lock, then take it. Resolves to `{ release, waitedMs }`.
 *
 * `onWait(holder)` is called once on entry when the lock is held and then every
 * `heartbeatMs`, with the current holder. A holder with this process's own pid
 * is not waited on: the orchestrator never nests two gates, so that would be a
 * deadlock, and running is the open direction.
 */
export const acquireGateLock = async ({
  path = gateLockPath(),
  holder = {},
  alive = pidAlive,
  startedAt = processStartedMs,
  pollMs = GATE_LOCK_POLL_MS,
  heartbeatMs = GATE_HEARTBEAT_MS,
  onWait = () => {},
  now = Date.now,
} = {}) => {
  const started = now();
  const token = randomUUID();
  const record = {
    pid: process.pid, pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), ...holder, since: null, token,
  };
  let lastSpoke = null;
  // A holder's start time never changes, so each holder is read by `ps` once.
  let checkedToken = null;
  // A takeover blocked by another's breaker yields before retrying, or the
  // waiter spins (and runs `ps` every pass) until that breaker is freed.
  const retry = async (dead) => { if (!takeOver(path, dead)) await sleep(Math.min(pollMs, 50)); };
  for (;;) {
    record.since = new Date(now()).toISOString();
    if (tryCreate(path, record)) break;
    const current = readGateHolder(path);
    // Gone (released between our link and our read) or unreadable. `link`
    // only ever publishes a complete file, so unreadable means corrupt.
    if (!current) { await retry({}); continue; }
    if (Number(current.pid) === process.pid) return { release: () => {}, waitedMs: now() - started, reentrant: current };
    if (!alive(current.pid)) {
      await retry(current);
      continue;
    }
    if (current.token !== checkedToken) {
      if (pidReused(current, startedAt)) { await retry(current); continue; }
      checkedToken = current.token;
    }
    if (lastSpoke === null || now() - lastSpoke >= heartbeatMs) {
      lastSpoke = now();
      onWait(current);
    }
    await sleep(pollMs);
  }
  const waitedMs = now() - started;
  // A normal exit or an uncaught throw still releases. A SIGKILL cannot run
  // this; the next waiter's pid check covers that.
  const onExit = () => release();
  process.once('exit', onExit);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    // Only ever our own lock: a holder that was taken over (we were presumed
    // dead) must not delete its successor's file.
    if (readGateHolder(path)?.token === token) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  };
  return { release, waitedMs };
};

/**
 * Run `gate({ lockWaitS })` holding the machine-wide gate lock.
 *
 * The gate's own time bounds are armed inside `gate`, so the wait is never
 * counted against them. The lock is released however `gate` ends, including a
 * throw and a per-command timeout kill. While waiting, `.afk/gate-wait.json`
 * names the holder for `afk status`.
 */
export const withGateLock = async ({
  root,
  config,
  epic = null,
  kind,
  say = console.log,
  path = gateLockPath(),
  ...options
}, gate) => {
  if (!gateLockEnabled(config)) return gate({ lockWaitS: 0 });
  const project = basename(resolve(root));
  const waitPath = gateWaitPath(root);
  let lock = null;
  try {
    lock = await acquireGateLock({
      path,
      holder: { project, root: resolve(root), epic: epic == null ? null : String(epic), kind },
      onWait: (holder) => {
        say(`AUTO: ${kind} gate waiting for the gate lock held by ${describeHolder(holder)}. One full gate runs at a time on this machine; set \`gateLock: false\` to turn this off.`);
        try {
          mkdirSync(dirname(waitPath), { recursive: true });
          writeFileSync(waitPath, `${JSON.stringify({ pid: process.pid, kind, holder })}\n`);
        } catch { /* the status line is a convenience; the wait itself goes on */ }
      },
      ...options,
    });
  } catch (error) {
    say(`AUTO: could not take the gate lock (${error.message}); running the ${kind} gate without it.`);
  } finally {
    rmSync(waitPath, { force: true });
  }
  const lockWaitS = lock ? Math.round(lock.waitedMs / 1000) : 0;
  if (lock && lock.waitedMs >= 1000) say(`AUTO: ${kind} gate took the gate lock after waiting ${lockWaitS}s.`);
  try {
    return await gate({ lockWaitS });
  } finally {
    lock?.release();
  }
};

// ---------------------------------------------------------------------------
// A quiet host before a baseline (#223)
// ---------------------------------------------------------------------------
//
// The lock above stops two full gates overlapping; it cannot stop another
// epic's lanes. harbour #545's relaunch baseline ran while atlas #1184's lane
// vitest pushed the 1-minute load from 4.5 to 24, and went red on timeouts that
// passed alone. So a baseline, and the one rerun an environment red earns,
// waits for the load to fall under a threshold after it holds the lock.

export const QUIET_HOST_LOAD = 20;
export const QUIET_HOST_POLL_MS = 5_000;
// A bound on the wait, not on the gate: past it the gate runs anyway.
export const QUIET_HOST_MAX_WAIT_MS = 30 * 60_000;

/**
 * The 1-minute load a baseline waits under, or null for no wait.
 * `AFK_QUIET_HOST_LOAD` (a number, or `off`) wins over `quietHostLoad` in
 * `.afk-setup/config.yaml` (a number, or `false`); the default is 20. `afk
 * selftest` sets it `off`: the suite's own parallel files are the load.
 */
export const quietHostLoad = (config, env = process.env) => {
  const raw = env.AFK_QUIET_HOST_LOAD ?? config?.quietHostLoad;
  if (raw === undefined || raw === null || raw === '') return QUIET_HOST_LOAD;
  if (raw === false || /^(?:off|false|0)$/i.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : QUIET_HOST_LOAD;
};

/**
 * Wait until the 1-minute load is under `threshold`. Resolves to the seconds
 * waited. Says so once on entry and every `heartbeatMs` while it waits.
 *
 * Fail direction: OPEN. A host that never quiets runs the gate after
 * `maxWaitMs`, and a load that cannot be read counts as quiet: a slow gate is
 * the pre-#223 behaviour, a gate that never runs stops the epic.
 */
export const waitForQuietHost = async ({
  threshold,
  kind,
  say = console.log,
  load = () => loadavg()[0],
  pollMs = QUIET_HOST_POLL_MS,
  heartbeatMs = GATE_HEARTBEAT_MS,
  maxWaitMs = QUIET_HOST_MAX_WAIT_MS,
  now = Date.now,
} = {}) => {
  if (threshold == null) return 0;
  const started = now();
  let lastSpoke = null;
  for (;;) {
    const current = Number(load());
    const waitedS = Math.round((now() - started) / 1000);
    if (!Number.isFinite(current) || current < threshold) {
      if (lastSpoke !== null) say(`AUTO: ${kind} gate: the host is quiet (load ${current.toFixed(1)}) after ${waitedS}s.`);
      return waitedS;
    }
    if (now() - started >= maxWaitMs) {
      say(`AUTO: ${kind} gate: the host is still busy (load ${current.toFixed(1)}, threshold ${threshold}) after ${waitedS}s; running anyway.`);
      return waitedS;
    }
    if (lastSpoke === null || now() - lastSpoke >= heartbeatMs) {
      lastSpoke = now();
      say(`AUTO: ${kind} gate waiting for a quiet host: load ${current.toFixed(1)}, threshold ${threshold}. Set \`quietHostLoad: false\` to turn this off.`);
    }
    await sleep(pollMs);
  }
};

/** The `afk status` line for a project waiting on another's gate, or null. */
export const gateWaitLine = (root, alive = pidAlive) => {
  const wait = readJson(gateWaitPath(root));
  if (!wait || !alive(wait.pid)) return null;
  const holder = wait.holder ?? {};
  const epic = holder.epic == null ? '' : ` #${holder.epic}`;
  return `waiting for gate lock held by ${holder.project ?? 'an unknown project'}${epic} (${holder.kind ?? 'gate'} gate, since ${holder.since ?? 'unknown'})`;
};
