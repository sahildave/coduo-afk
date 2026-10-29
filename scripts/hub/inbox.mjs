// scripts/hub/inbox.mjs — comments and responses sent from the hub (#229).
//
// They live in the store root, under `inbox/` (`<AFK_COS_ROOT>/inbox/events.jsonl`),
// not in a run's directory: a comment queued for an Orchestrator must outlive
// the chief-of-staff run it was sent during, and the hub must take one when no
// run is open at all. The directory has no `run.json`, so `openRun` never
// mistakes it for a run. Appends go through the store's locked `appendEvent`.
//
// Every item is a run of `comment` events sharing one UUID `id`. The first,
// `status: "stored"`, carries the payload and is written before anything else
// happens. Later ones carry only `{id, status}`: `delivered` (the relay
// succeeded), `queued` (the target was cold, absent, or the relay failed),
// `read` (the session acknowledged it). The last status wins.
//
// An item can be left at `stored` if the hub dies mid-relay (#236 H1). It is
// never lost: a hub that starts writes `queued` for every such item
// (`resolveStranded`), and every reader treats one older than the relay
// timeout plus a minute as queued. Either way the note says it may already
// have arrived: a duplicate is the right trade against a silent loss.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, cosRoot, nowMs, readEvents } from "../cos/store.mjs";

/** How long the hub waits on one relay before killing it (AFK_HUB_RELAY_TIMEOUT_MS for tests). */
export const relayTimeoutMs = (env = process.env) => Number(env.AFK_HUB_RELAY_TIMEOUT_MS) || 120_000;
const strandedAfterMs = (env) => relayTimeoutMs(env) + 60_000;
export const STRANDED_NOTE = "the hub stopped mid-relay; may already have arrived";

export const inboxDir = (env = process.env) => join(cosRoot(env), "inbox");

const dir = (env) => {
  const path = inboxDir(env);
  mkdirSync(path, { recursive: true });
  return path;
};

/** Store a new item first. Returns the stored event, `id` included. */
export const storeItem = (fields, env = process.env) =>
  appendEvent(dir(env), "comment", { id: randomUUID(), status: "stored", ...fields }, env);

export const markItem = (id, status, extra = {}, env = process.env) =>
  appendEvent(dir(env), "comment", { id, status, ...extra }, env);

/** Store and queue in one call, for a target that is not warm. */
export const queueComment = (fields, env = process.env) => {
  const item = storeItem(fields, env);
  markItem(item.id, "queued", {}, env);
  return item;
};

/** Every item, folded to `{...stored payload, status, statusAt}`, plus flagged lines. */
export const readItems = (env = process.env) => {
  const { events, flagged } = readEvents(inboxDir(env));
  const items = new Map();
  for (const event of events) {
    if (event.kind !== "comment" || typeof event.id !== "string") continue;
    if (event.status === "stored") items.set(event.id, { ...event, statusAt: event.ts });
    else if (items.has(event.id)) Object.assign(items.get(event.id), { status: event.status, statusAt: event.ts, reason: event.reason });
  }
  const now = nowMs(env);
  for (const item of items.values()) {
    if (item.status === "stored" && now - Date.parse(item.ts) > strandedAfterMs(env)) Object.assign(item, { status: "queued", reason: STRANDED_NOTE });
  }
  return { items: [...items.values()], flagged };
};

/**
 * Queue every item still at `stored`. Only a hub that has just bound its port
 * calls this: no relay of its own is in flight, and it is the only relayer.
 */
export const resolveStranded = (env = process.env) => {
  const stranded = readEvents(inboxDir(env)).events.filter((e) => e.kind === "comment");
  const last = new Map();
  for (const event of stranded) if (typeof event.id === "string") last.set(event.id, event.status);
  const ids = [...last].filter(([, status]) => status === "stored").map(([id]) => id);
  for (const id of ids) markItem(id, "queued", { reason: STRANDED_NOTE }, env);
  return ids;
};

/** The items a target has not acknowledged and was never delivered. */
export const queueFor = (target, env = process.env) =>
  readItems(env).items.filter((item) => item.target === target && item.status === "queued");

/** Mark queued items read. Returns `{ read, unknown }` id lists. */
export const acknowledge = (target, ids, env = process.env) => {
  const queued = new Set(queueFor(target, env).map((item) => item.id));
  const read = [];
  const unknown = [];
  for (const id of ids) {
    if (!queued.has(id)) { unknown.push(id); continue; }
    markItem(id, "read", { by: target }, env);
    read.push(id);
  }
  return { read, unknown };
};

/** `run · field` for a comment's anchor, or `page`. */
export const anchorLabel = (anchor) =>
  (anchor?.run ? `${anchor.run} · ${anchor.field}` : anchor?.field ?? "page");
