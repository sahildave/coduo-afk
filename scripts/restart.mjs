// Opt-in auto-restart after an orchestrator fatal (#146).
//
// Four epics in #144 died on a mid-run throw and every one resumed cleanly the
// moment someone typed `afk epic <n>` again. `autoRestart: N` in
// `.afk-setup/config.yaml` types it for them, at most N times per launch.
//
// A restart is a NEW PROCESS running the same argv, never a second `runAuto` in
// this one: `runAuto` installs signal and exit handlers on every call, so a
// second call would stack a second set and the first set's `process.exit(130)`
// would still fire (#146, "Where it has to live").
//
// The old process is the hazard, not the new one (#136). After a fatal it has
// already released its lock, but it can stay alive ~15 minutes, held open by
// the dashboard child and herdr output. So the two never overlap: `runAuto`
// takes its signal handlers off on a fatal, the old process spawns its
// successor and exits within `EXIT_GRACE_MS` (`exitAfterFatal`), and the
// successor waits for the old pid to be gone before it does anything at all
// (`awaitPredecessor`).
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWrite, flushNotifications, notify } from "./lib.mjs";

/**
 * Set on a restarted process, and only on it: the attempt number (1-based), the
 * pid it replaces, and the directory its `.afk/` lives in (the epic worktree
 * under `--worktree`). `takeRestartEnv` removes all three before anything else
 * runs, so no check, builder or hook the restarted run spawns inherits them.
 */
export const ATTEMPT_ENV = "AFK_RESTART_ATTEMPT";
export const PREDECESSOR_ENV = "AFK_RESTART_OF";
export const ROOT_ENV = "AFK_RESTART_ROOT";

/** How long a process that died on a fatal has left before it exits. */
export const EXIT_GRACE_MS = 2_000;
/** How long a restart waits for the process it replaces to exit. */
export const PREDECESSOR_WAIT_MS = 60_000;

/**
 * `autoRestart` from config: absent is 0 (off). Anything that is not a
 * non-negative integer throws, so `afk epic` refuses before it creates
 * anything — a typo must not silently switch the guard off, or on.
 */
export const restartBudget = (config) => {
  const value = config?.autoRestart;
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`autoRestart must be a non-negative integer (the most restarts after a fatal), got ${JSON.stringify(value)}.`);
  return value;
};

/**
 * A fatal's message with everything that differs between two runs of the same
 * failure taken out, so "the same wall" compares equal: absolute and `~/`
 * paths, UUIDs, hex of seven characters or more with a digit in it (a commit
 * sha, a sha256), and then every run of digits —
 * timestamps, pids, ports, durations, positions, attempt numbers, temp-file
 * suffixes, task ids. What is left is the wording, error codes and config keys.
 *
 * Deliberately coarse. Two faults that differ only in a number (task 401 vs
 * task 402) compare EQUAL, which stops the chain one restart early; the other
 * way round, a volatile number the list missed would let a repeating wall burn
 * the whole budget. Stopping early costs a relaunch by hand, which is the
 * direction this guard fails in.
 */
export const normalizeFatal = (message) =>
  String(message ?? "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/(^|[\s'"`(\[=:])~?\/[^\s'"`)\],]*/g, "$1<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .trim();

/**
 * Whether to restart after `fatal`, as `{ restart: true }` or
 * `{ restart: false, reason }`. `attempt` is how many restarts this launch has
 * already made; `previous` is the fatal that caused the last one.
 */
export const restartDecision = ({ budget, attempt, fatal, previous }) => {
  if (!budget) return { restart: false, reason: null };
  if (attempt >= budget) return { restart: false, reason: `the auto-restart budget is spent (${attempt} of ${budget})` };
  if (previous && normalizeFatal(previous.message) === normalizeFatal(fatal.message))
    return { restart: false, reason: `the fatal repeated the one the last restart was for, so another restart would hit it again: ${fatal.message}` };
  return { restart: true, reason: null };
};

/**
 * What `afk status` says about restarts. While a fatal is on record, the
 * count; once a restarted run has got past its baseline (the fatal is
 * cleared), when it happened — "restarted after fatal (1 of 2)" with no fatal
 * under it read as a run still dead.
 */
export const restartLines = (state) => {
  const record = state?.restart;
  const stopped = record?.stopped ? [`auto-restart stopped: ${record.stopped.reason}`] : [];
  if (!record?.attempt) return stopped;
  if (state.fatal) return [`restarted after fatal (${record.attempt} of ${record.budget})`, ...stopped];
  const at = record.history?.at(-1)?.at ?? record.last?.at ?? "an unknown time";
  const times = record.attempt === 1 ? "once after a fatal" : `${record.attempt} times after fatals, the last`;
  return [`restarted ${times} at ${at}, then ran on`, ...stopped];
};

const log = (root, message) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.error(line);
  try {
    appendFileSync(resolve(root, ".afk", "agent-auto.log"), `${line}\n`);
  } catch {}
};

const statePath = (root) => resolve(root, ".afk", "state.json");

/**
 * Record why the restart chain stopped: `state.restart.stopped`, a log line,
 * and, when `notifyFatal`, the `orchestrator_fatal` notification — for a stop
 * nothing else has announced (a restarted run that refused to start).
 * Never throws; returns whether the record reached state.
 */
export const recordStop = (root, reason, { notifyFatal = false, state = null, restart = undefined } = {}) => {
  const at = new Date().toISOString();
  log(root, `AUTO: not restarting after the fatal — ${reason}.`);
  if (notifyFatal) {
    try {
      notify({ title: "AFK runner", subtitle: "orchestrator exited", message: `${at}: auto-restart stopped — ${reason}`, level: "error", group: "afk-orchestrator-fatal", kind: "orchestrator_fatal" });
      flushNotifications();
    } catch {}
  }
  try {
    const current = state ?? JSON.parse(readFileSync(statePath(root), "utf8"));
    // `restart`, when given, replaces the record first: a restart that never
    // ran must not be counted as one.
    current.restart = { ...((restart === undefined ? current.restart : restart) ?? {}), stopped: { at, reason } };
    atomicWrite(statePath(root), `${JSON.stringify(current, null, 2)}\n`);
    return true;
  } catch (error) {
    log(root, `AUTO: could not record the auto-restart stop — ${error.message}`);
    return false;
  }
};

/**
 * Called by `afk epic` when `runAuto` threw a scheduler fatal (`error.fatal`).
 * Decides, records the decision in `.afk/state.json`, and on a restart spawns
 * the same argv detached. Returns the successor, or null.
 *
 * The successor's stdin is closed and its stdout and stderr go to
 * `.afk/restart-<k>.log`, never to this process's: this process is about to
 * exit, and a pipe or terminal whose reader goes with it would kill the
 * successor with EPIPE or EIO on its first write, before it could log a line.
 *
 * Fail direction: closed. Anything that makes the restart unsafe to reason
 * about — the lock still present, state unreadable or unwritable (a full disk
 * fails here) — is logged and the run stays stopped. The fatal has already
 * notified; one run too few is a relaunch by hand, one too many is two
 * orchestrators on one checkout.
 */
export const restartAfterFatal = ({ root, config, fatal, attempt = 0, env = process.env, spawnChild = spawn }) => {
  const budget = restartBudget(config);
  if (!budget) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(statePath(root), "utf8"));
  } catch (error) {
    log(root, `AUTO: not restarting after the fatal — cannot read state (${error.message}).`);
    return null;
  }
  state.restart = { ...(state.restart ?? {}), budget, attempt };
  const decision = restartDecision({ budget, attempt, fatal, previous: state.restart.last ?? null });
  // `runAuto`'s `finally` releases the lock before the throw reaches here, so
  // a lock that is still present belongs to something else.
  const stop = !decision.restart
    ? decision.reason
    : existsSync(resolve(root, ".afk", "orchestrator.lock")) ? "the orchestrator lock is still held" : null;
  if (stop) {
    recordStop(root, stop, { state });
    return null;
  }
  // From here until this process exits, a human's SIGINT/SIGTERM/SIGHUP means
  // "stop", and the successor runs in its own process group where a terminal's
  // Ctrl-C cannot reach it. So the signal is passed on, and the stop recorded.
  // Armed before anything is written or spawned: `runAuto` took its own
  // handlers off on the fatal, and the restart line below is the cue a human
  // (or a test) acts on.
  let child = null;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      if (child)
        try {
          process.kill(child.pid, signal);
        } catch {}
      recordStop(root, child
        ? `stopped by ${signal} during the restart; the restarted process (pid ${child.pid}) was stopped with it`
        : `stopped by ${signal} before the restart started`);
      process.exit(130);
    });
  const next = attempt + 1;
  const outputPath = resolve(root, ".afk", `restart-${next}.log`);
  // What the record goes back to if the successor never runs.
  const before = state.restart;
  const spawnFailed = (error) => {
    recordStop(root, `the restart could not be spawned: ${error?.message ?? error}`, { restart: before });
    return null;
  };
  state.restart = {
    ...state.restart,
    attempt: next,
    last: { at: fatal.at, message: fatal.message },
    history: [...(state.restart.history ?? []), { at: new Date().toISOString(), fatal: fatal.message, fromPid: process.pid, output: outputPath }],
  };
  delete state.restart.stopped;
  try {
    atomicWrite(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    log(root, `AUTO: not restarting after the fatal — cannot write state (${error.message}).`);
    return null;
  }
  // Fresh per restart: `a` would append a later launch's restart to an
  // earlier one's under the same name. Archived with the epic (archive.mjs).
  let output;
  try {
    output = openSync(outputPath, "w");
    child = spawnChild(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...env, [ATTEMPT_ENV]: String(next), [PREDECESSOR_ENV]: String(process.pid), [ROOT_ENV]: root },
    });
  } catch (error) {
    child = null;
    return spawnFailed(error);
  } finally {
    if (output !== undefined) closeSync(output);
  }
  // A spawn that fails asynchronously (ENOENT, EAGAIN) returns a child with no
  // pid and reports on `error` a tick later. There is no pid to log.
  if (!child.pid) {
    child.on("error", spawnFailed);
    child = null;
    return null;
  }
  child.on("error", () => {});
  child.unref();
  log(root, `AUTO: restarting after the fatal (${next} of ${budget}) as pid ${child.pid}, output in ${outputPath}; this process (pid ${process.pid}) exits now.`);
  return child;
};

/**
 * After any scheduler fatal, restart or not: exit within `EXIT_GRACE_MS`.
 *
 * `process.exit()` here breaks the rule in epic.mjs and auto.mjs
 * (`process.exitCode`, never `process.exit()`, so a pipe is not truncated),
 * deliberately. Without it the process lingers ~15 minutes after a fatal (#136),
 * held open by the dashboard child and herdr output. What the rule protects is
 * safe by now: `agent-auto.log` is written with `appendFileSync`, so it is
 * complete, and a successor's output goes to a file, not this process's pipe.
 * The timer is unref'd, so a process with nothing holding it exits sooner.
 */
export const exitAfterFatal = () => {
  setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
};

/**
 * The restart context this process was started with, or null for a start a
 * human typed — and the variables removed from `env`, so nothing this run
 * spawns inherits them. A check that runs the runner's own tests would
 * otherwise run them as "a restarted run".
 */
export const takeRestartEnv = (env = process.env) => {
  const attempt = Number(env[ATTEMPT_ENV]);
  const context = Number.isInteger(attempt) && attempt > 0
    ? { attempt, predecessor: Number(env[PREDECESSOR_ENV]) || null, root: env[ROOT_ENV] || process.cwd() }
    : null;
  delete env[ATTEMPT_ENV];
  delete env[PREDECESSOR_ENV];
  delete env[ROOT_ENV];
  return context;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * On a restarted process, wait for the one it replaces to exit before doing
 * anything. Resolves null when it is gone, or a refusal message when it is
 * still alive after `waitMs`. Fail direction: closed — a successor that starts
 * beside a live predecessor can race it for state.json and the checkout.
 */
export const awaitPredecessor = async ({ pid, waitMs = PREDECESSOR_WAIT_MS }) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const deadline = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() >= deadline)
      return `the orchestrator this restart replaces (pid ${pid}) is still alive after ${Math.round(waitMs / 1000)}s; not starting a second one beside it`;
    await new Promise((done) => setTimeout(done, 100));
  }
  return null;
};
