// scripts/cos/store.mjs — the chief of staff's central store (#227).
//
// One directory per run under `~/.afk-claude/cos/<run>/` (root overridable by
// AFK_COS_ROOT): `run.json`, written once when the run opens, and
// `events.jsonl`, append-only. `afk cos` is the only writer. A run is open from
// its `run.json` until its first `stop` event.
//
// Appends take a per-run lock in the style of gate-lock.mjs: the lock file is
// published with link(2) from a fully written temp file, and a holder whose
// pid is dead is removed through gate-lock's breaker (`takeOver`), so a
// crashed writer never wedges the store.
//
// Fail direction: CLOSED for writes (an append that cannot take the lock in
// 10 s throws; a lost event is worse than a failed command) and LOUD for reads
// (a hand-edited line is returned in `flagged` and printed by every reader,
// never skipped silently).
import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pidAlive } from "../dashboard-data.mjs";
import { processStartedMs, takeOver } from "../gate-lock.mjs";

export const EVENT_KINDS = ["note", "decision", "grant", "comment", "checkin", "handoff", "process", "stop", "owner_intervention", "ask", "answer", "report", "plan"];
// The kinds a person or a session may write with `afk cos log`. The rest are
// written by the verb that owns them.
export const LOG_KINDS = ["note", "decision", "grant", "comment", "owner_intervention"];

export const cosRoot = (env = process.env) =>
  (env.AFK_COS_ROOT ? resolve(env.AFK_COS_ROOT) : join(homedir(), ".afk-claude", "cos"));

/** The clock. AFK_COS_NOW (an ISO time) is the tests' fake. */
export const nowMs = (env = process.env) => {
  const fixed = Date.parse(env.AFK_COS_NOW ?? "");
  return Number.isFinite(fixed) ? fixed : Date.now();
};

const eventsPath = (dir) => join(dir, "events.jsonl");

const LOCK_WAIT_MS = 10_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

// gate-lock.mjs's reuse check: `ps` reports start time to the second. A holder
// with no recorded start time reads as the same process, so it is waited on.
const START_TOLERANCE_MS = 3_000;
const holderGone = (holder) => {
  if (!holder || !pidAlive(holder.pid)) return true;
  const recorded = Date.parse(holder.pidStartedAt ?? "");
  if (!Number.isFinite(recorded)) return false;
  const actual = processStartedMs(holder.pid);
  return actual !== null && Math.abs(actual - recorded) > START_TOLERANCE_MS;
};

const withLock = (dir, write) => {
  const path = join(dir, "events.lock");
  const token = randomUUID();
  const temporary = `${path}.${process.pid}.${token}.tmp`;
  const pidStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, pidStartedAt, token })}\n`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(temporary, path);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = readJson(path);
      if (holderGone(holder)) takeOver(path, holder ?? {});
      if (Date.now() > deadline) throw new Error(`store: could not take ${path} in ${LOCK_WAIT_MS / 1000}s (held by pid ${holder?.pid ?? "unknown"})`);
      sleepSync(5);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  try {
    return write();
  } finally {
    if (readJson(path)?.token === token) rmSync(path, { force: true });
  }
};

/**
 * Append one event, stamped by this process's clock. Returns the event, or
 * null when `unless(events)`, read under the lock, says not to append: the
 * one way a writer can act on the store as it is at the moment of writing.
 * `fields` may be a function of those same events.
 */
export const appendEvent = (dir, kind, fields = {}, env = process.env, { unless = null } = {}) => {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`store: unknown kind "${kind}"`);
  return withLock(dir, () => {
    const { events } = readEvents(dir);
    if (unless?.(events)) return null;
    const event = { ts: new Date(nowMs(env)).toISOString(), kind, ...(typeof fields === "function" ? fields(events) : fields) };
    appendFileSync(eventsPath(dir), `${JSON.stringify(event)}\n`);
    return event;
  });
};

/** Why a parsed line is not an event, or null when it is one. */
const invalid = (event) => {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "not an object";
  if (typeof event.ts !== "string" || !Number.isFinite(Date.parse(event.ts))) return "missing ts";
  if (typeof event.kind !== "string") return "missing kind";
  if (!EVENT_KINDS.includes(event.kind)) return `unknown kind ${JSON.stringify(event.kind)}`;
  return null;
};

/**
 * Every event of a run, plus every line that is not one. A bad line stays in
 * the file and in `flagged`; callers print `flagLines(flagged)`.
 */
export const readEvents = (dir) => {
  const path = eventsPath(dir);
  const events = [];
  const flagged = [];
  if (!existsSync(path)) return { events, flagged };
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let event;
    try { event = JSON.parse(line); } catch {
      flagged.push({ path, line: index + 1, reason: "not JSON" });
      return;
    }
    const reason = invalid(event);
    if (reason) flagged.push({ path, line: index + 1, reason });
    else events.push(event);
  });
  return { events, flagged };
};

export const flagLines = (flagged) =>
  flagged.map(({ path, line, reason }) => `STORE: flagged line ${line} of ${path}: ${reason}. Left in place; fix it by hand or ignore it knowingly.`);

export const runDirs = (root) =>
  (existsSync(root) ? readdirSync(root).filter((name) => existsSync(join(root, name, "run.json"))).sort() : []);

/**
 * The open run: the newest run with no `stop` event. Returns
 * `{ id, dir, meta, events, flagged }` or null.
 */
export const openRun = ({ root = cosRoot() } = {}) => {
  for (const id of runDirs(root).reverse()) {
    const dir = join(root, id);
    const { events, flagged } = readEvents(dir);
    if (events.some((event) => event.kind === "stop")) continue;
    return { id, dir, meta: readJson(join(dir, "run.json")), events, flagged };
  }
  return null;
};

/**
 * The newest run, open or closed: `{ id, dir, meta, events, flagged }` or
 * null. `afk cos report` writes here when no run is open, because the report
 * is also appended to after `afk cos stop`.
 */
export const newestRun = ({ root = cosRoot() } = {}) => {
  const id = runDirs(root).at(-1);
  if (!id) return null;
  const dir = join(root, id);
  return { id, dir, meta: readJson(join(dir, "run.json")), ...readEvents(dir) };
};

/** Open a new run. `run.json` is written once and never rewritten. */
export const createRun = ({ root = cosRoot(), mode, epics = [], adopted = [], env = process.env }) => {
  const at = new Date(nowMs(env));
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  let id = `${stamp}-${mode}`;
  for (let n = 2; existsSync(join(root, id)); n += 1) id = `${stamp}-${mode}-${n}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const meta = { id, mode, epics: epics.map(String), adopted, startedAt: at.toISOString() };
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { id, dir, meta };
};
