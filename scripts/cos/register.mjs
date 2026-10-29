// scripts/cos/register.mjs — the process register (#227).
//
// `afk cos run` is the only way the chief of staff starts a poller or timer,
// so every one of them is in the store as a `process` event: pid, the pid's
// start time read back from `ps`, owner, purpose, TTL, command and log file.
// `afk cos stop` kills each one and checks it is gone.
//
// The register covers operating-system processes only. A session stops its
// own Monitors and sub-agents before it calls `afk cos stop`.
//
// Fail direction: a pid whose start time no longer matches the recorded one
// (gate-lock.mjs's reuse check) is NOT killed. Killing an unrelated process
// that inherited the pid is worse than leaving an orphan, which the summary
// names.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { processStartedMs } from "../gate-lock.mjs";
import { nowMs } from "./store.mjs";

// `ps` reports start time to the second (gate-lock.mjs START_TOLERANCE_MS).
const START_TOLERANCE_MS = 3_000;
const KILL_WAIT_MS = 5_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `kill -0` says alive, and a zombie (killed, not yet reaped by a pid 1 that
 * does not reap) is not.
 */
export const alive = (pid) => {
  if (spawnSync("kill", ["-0", String(pid)]).status !== 0) return false;
  const stat = String(spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
  return stat !== "" && !stat.startsWith("Z");
};

/** Start `cmd` detached, in its own process group, and describe it for the store. */
export const startProcess = ({ cmd, dir, ttlMin, purpose, owner, env = process.env }) => {
  mkdirSync(join(dir, "processes"), { recursive: true });
  const log = join(dir, "processes", `${nowMs(env)}-${process.pid}.log`);
  const out = openSync(log, "a");
  const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ["ignore", out, out], env });
  if (!child.pid) throw new Error(`could not start ${cmd[0]}`);
  child.unref();
  const started = processStartedMs(child.pid);
  return {
    pid: child.pid,
    startedAt: started === null ? null : new Date(started).toISOString(),
    owner,
    purpose,
    ttlMin,
    cmd,
    log,
  };
};

/**
 * The live members of process group `pgid` that started no earlier than
 * `sinceMs` (less the `ps` tolerance): `[{ pid, startedMs }]`. The time filter
 * is what keeps a reused pgid's unrelated processes out.
 */
export const groupMembers = (pgid, sinceMs) => {
  const out = String(spawnSync("ps", ["-eo", "pid=,pgid=,stat=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "");
  return out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean)
    .map(([, pid, group, stat, lstart]) => ({ pid: Number(pid), pgid: Number(group), stat, startedMs: Date.parse(lstart) }))
    .filter((p) => p.pgid === Number(pgid) && !p.stat.startsWith("Z") && Number.isFinite(p.startedMs) && p.startedMs >= sinceMs - START_TOLERANCE_MS)
    .map(({ pid, startedMs }) => ({ pid, startedMs }));
};

/**
 * Stop every registered process and every member of its process group (it
 * was started detached, so its pid is the group id). A leader that exited
 * can leave children running in the group; they are found and killed too.
 * Returns `{ killed, gone, refused, survived }` as lists of
 * `{ pid, purpose, members?, reason? }`.
 */
export const stopProcesses = (registered) => {
  const result = { killed: [], gone: [], refused: [], survived: [] };
  for (const entry of registered) {
    const { pid, purpose } = entry;
    const recorded = Date.parse(entry.startedAt ?? "");
    if (alive(pid)) {
      const actual = processStartedMs(pid);
      if (!Number.isFinite(recorded) || actual === null || Math.abs(actual - recorded) > START_TOLERANCE_MS) {
        result.refused.push({ pid, purpose, reason: Number.isFinite(recorded) && actual !== null ? "start time changed" : "start time unknown" });
        continue;
      }
    } else if (!Number.isFinite(recorded)) {
      // A dead leader with no start time: its group's members cannot be told
      // from a reused pgid's, so none are touched.
      result.gone.push({ pid, purpose });
      continue;
    }
    // Members only, each by its own pid: a signal to the whole group could
    // reach a process that joined a reused pgid.
    const targets = () => groupMembers(pid, recorded).map((member) => member.pid);
    const first = targets();
    if (first.length === 0) { result.gone.push({ pid, purpose }); continue; }
    const signal = (name) => { for (const member of targets()) { try { process.kill(member, name); } catch { /* gone */ } } };
    signal("SIGTERM");
    const deadline = Date.now() + KILL_WAIT_MS;
    while (targets().some(alive) && Date.now() < deadline) sleepSync(50);
    if (targets().some(alive)) { signal("SIGKILL"); sleepSync(200); }
    const left = targets().filter(alive);
    (left.length ? result.survived : result.killed).push({ pid, purpose, members: first.length, left });
  }
  return result;
};
