// scripts/hub/snapshot.mjs — `afk hub snapshot`: one hub snapshot document,
// the hub artifact's data (#274).
//
//   {at, mode, cosRun, runs, gates, asks, nightLog, usage, lanes, laneCap?, report?}
//
// `runs` to `nightLog` come from `hubView`, the data the local hub page draws.
// Each run also carries what the artifact's Gantt and graphs draw (#273):
// `timeline` (readActuals over its `.afk/agent-auto.log` since the chief of
// staff's run opened), `planned` (that run's `plan` event, via planChart),
// `tasks` (its `.afk/state.json` DAG), `spend` (cumulative USD per 30 min,
// from the same transcript parse as `usage`) and `activity` (a line from its
// task lifecycles). `laneCap` is the sum of the live runs' `maxParallel`,
// omitted when any of them is unknown.
// `usage` and `lanes` stand in for the AFK spending and AFK lanes tabs: the
// same readers the hub's `GET /usage` and `GET /lanes` call, reduced to
// totals and per-project and per-role rows, never one row per transcript.
// Those scans take seconds cold, so the usage parse is cached on disk
// (`AFK_USAGE_CACHE`, beside `AFK_LANES_CACHE`); a warm check-in stays fast.
//
// Read only, and it never talks to claude.ai: the chief of staff passes the
// file to `ArtifactData set` on `snapshots/<doc_id>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phaseOf } from "../dashboard-data.mjs";
import { lanesReport } from "../lanes.mjs";
import { collectUsage, loadUsageCache, monthStart, saveUsageCache, usageReport } from "../usage.mjs";
import { nowMs } from "../cos/store.mjs";
import { hubView } from "./page.mjs";
import { planChart, readActuals } from "./plan.mjs";
import { isLive, openGates } from "./runs.mjs";

export const NIGHT_LOG_KEPT = 50;
export const MAX_BYTES = 256 * 1024;
const LANES_DAYS = 7;
export const SPEND_STEP_MS = 30 * 60_000;
// With no chief of staff run open, a run's timeline and spend start this long before `at`.
const WINDOW_MS = 24 * 3_600_000;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

/** The snapshot's document id: its `at` in compact UTC, `20261019T1430Z`. */
export const docIdOf = (at) => new Date(at).toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";

const usageRow = ({ key, costUsd, messages, unpriced, live }) => ({ key, costUsd, messages, unpriced, live });

/** The AFK spending tab as a summary: `usageReport({ month: true })`. */
export const usageSummary = (report) => ({
  window: report.window,
  budgetUsd: report.budgetUsd,
  spentUsd: report.spentUsd,
  remainingUsd: report.remainingUsd,
  budgetShare: report.budgetShare,
  total: { ...usageRow(report.total), input: report.total.input, output: report.total.output, cacheRead: report.total.cacheRead, cacheWrite5m: report.total.cacheWrite5m, cacheWrite1h: report.total.cacheWrite1h },
  byProject: report.byProject.map(usageRow),
  byRole: report.byRole.map(usageRow),
});

const laneRow = ({ key, lanes, edited, peakShare, turns, toolCalls, contextBeforeEdit, costUsd }) =>
  ({ key, lanes, edited, peakShare, turns, toolCalls, contextBeforeEdit, costUsd });

/** The AFK lanes tab as a summary: `lanesReport({ days: 7 })`. */
export const lanesSummary = (report) => ({
  window: report.window,
  days: report.window.days,
  total: { ...laneRow({ key: "total", ...report.headline }), live: report.live.length },
  byProject: report.byProject.map(laneRow),
  byRole: report.byRole.map(laneRow),
});

const askRow = ({ id, title, why, options, rec, from, ts }) => ({ id, title, why: why ?? "", options: options ?? [], rec: rec ?? null, from: from ?? null, ts });

// A task's lifecycle as the artifact's DAG names it: the dashboard's phase
// (`phaseOf`, one reader of "which phase is this task in"), with building and
// integrating told apart, and an open `gate: before` as a gate (`openGates`).
const TASK_STATUS = { done: "passed", review: "integrating", gate: "gate", failed: "failed", stale: "parked", waiting: "waiting" };
const taskStatus = (lifecycle, gated) => {
  const phase = phaseOf({ status: lifecycle });
  if (phase === "active") return lifecycle === "integrating" ? "integrating" : "building";
  if (phase === "waiting" && gated) return "gate";
  return TASK_STATUS[phase];
};

/** `[{id, title, status, after}]` from `.afk/state.json`'s DAG. */
export const tasksOf = (state) => {
  const gated = new Set(openGates(state));
  return (state?.dag?.tasks ?? []).map((task) => ({
    id: String(task.id),
    title: task.title ?? "",
    status: taskStatus(state.tasks?.[task.id]?.lifecycle ?? "pending", gated.has(String(task.id))),
    after: (task.dependsOn ?? []).map(String),
  }));
};

const listed = (ids) => (ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

/** A run's line: what its tasks are doing ("building 304 and 306"), else its status. */
export const activityOf = (run, tasks) => {
  if (run.closedAt) return "closed";
  const ids = (status) => tasks.filter((task) => task.status === status).map((task) => task.id);
  const parts = [["building", ids("building")], ["integrating", ids("integrating")], ["parked at gate", ids("gate")]]
    .filter(([, list]) => list.length).map(([verb, list]) => `${verb} ${listed(list)}`);
  return parts.length ? parts.join(" · ") : run.status ?? "";
};

/**
 * `[{at, usd}]`: the run's spend since `since`, cumulative, one point per
 * SPEND_STEP_MS boundary and one at `at`. `rows` is `collectUsage` with
 * `bucketMs: SPEND_STEP_MS`, matched on the run's project and epic. Empty
 * when the run spent nothing in the window. A point is null from the first
 * bucket holding an unpriced message on (allKnown).
 */
export const spendOf = (rows, run, since, at) => {
  const from = Math.floor(since / SPEND_STEP_MS) * SPEND_STEP_MS;
  const buckets = new Map();
  for (const row of rows) {
    if (row.project !== run.project || String(row.epicId) !== String(run.epic)) continue;
    for (const [start, usd] of Object.entries(row.buckets ?? {})) {
      const t = Number(start);
      if (t >= from && t < at) buckets.set(t, buckets.get(t) === null || usd == null ? null : (buckets.get(t) ?? 0) + usd);
    }
  }
  if (!buckets.size) return [];
  const upTo = (t) => [...buckets].reduce((sum, [start, usd]) => (start >= t ? sum : sum === null || usd === null ? null : sum + usd), 0);
  const points = [];
  for (let t = from; t < at; t += SPEND_STEP_MS) points.push({ at: new Date(t).toISOString(), usd: round(upTo(t)) });
  points.push({ at: new Date(at).toISOString(), usd: round(upTo(at)) });
  return points;
};
const round = (usd) => (usd === null ? null : Math.round(usd * 100) / 100);

const runRow = (run, { since, at, chart, usageRows }) => {
  const state = readJson(join(run.root, ".afk", "state.json"));
  const close = state?.epicClose;
  const planned = chart?.rows?.find((row) => row.runId === run.id) ?? null;
  // planChart read this run's log already when the plan names it.
  const actual = planned?.actual ?? readActuals({ root: run.root, since, now: at });
  const closedAt = close?.lifecycle === "closed" ? close.closedAt ?? null : null;
  const tasks = tasksOf(state);
  return {
    id: run.id,
    project: run.project,
    epic: run.epic,
    branch: run.branch ?? null,
    status: run.status ?? null,
    progress: run.progress ?? null,
    counts: run.counts ?? null,
    gates: run.gates ?? [],
    pr: run.pr ?? null,
    deploy: run.deploy ?? null,
    fatal: run.fatal ?? null,
    closedAt,
    activity: activityOf({ ...run, closedAt }, tasks),
    tasks,
    planned: (planned?.planned ?? []).map(({ kind, label, start, end }) => ({ kind, label, start, end })),
    timeline: actual.bars,
    spend: spendOf(usageRows, run, since, at),
    maxParallel: actual.maxParallel ?? null,
  };
};

/** The live runs' caps summed; null when there is none or any is unknown. */
export const laneCapOf = (runs) => {
  const caps = runs.filter(isLive).map((run) => run.maxParallel);
  return caps.length && caps.every((cap) => Number.isInteger(cap)) ? caps.reduce((a, b) => a + b, 0) : null;
};

/** The whole document, before the size check. */
export const buildSnapshot = async (env = process.env) => {
  const view = await hubView(env);
  const atMs = nowMs(env);
  const at = new Date(atMs).toISOString();
  const history = view.cos ?? (view.closedRun ? { id: view.closedRun.id } : null);
  const meta = view.cos?.meta ?? null;
  // One transcript read for the month's spending and each run's spend series.
  loadUsageCache();
  const now = new Date(atMs);
  const usageRows = collectUsage({ since: monthStart(now), now: atMs, bucketMs: SPEND_STEP_MS });
  const usage = usageSummary(usageReport({ month: true, now, rows: usageRows }));
  saveUsageCache();
  const since = Date.parse(meta?.startedAt ?? "") || atMs - WINDOW_MS;
  const chart = planChart({ cos: view.cos, runs: view.runs, now: atMs });
  const rows = view.runs.map((run) => runRow(run, { since, at: atMs, chart, usageRows }));
  const laneCap = laneCapOf(rows);
  const runs = rows.map(({ maxParallel, ...row }) => row);
  // Planned epics with no run yet: the local hub draws them as "not launched", so the artifact does too.
  const unlaunched = (chart?.rows ?? []).filter((row) => !row.runId)
    .map((row) => ({ project: row.project ?? null, epic: String(row.epic), label: row.label ?? null, launch: row.launch ?? null, planned: row.planned.map(({ kind, label, start, end }) => ({ kind, label, start, end })) }));
  const lanes = lanesSummary(lanesReport({ days: LANES_DAYS, now: atMs }));
  return {
    at,
    mode: meta?.mode ?? null,
    cosRun: history ? { id: history.id, mode: meta?.mode ?? null, startedAt: meta?.startedAt ?? null, closed: !view.cos } : null,
    runs,
    ...(unlaunched.length ? { unlaunched } : {}),
    gates: runs.flatMap((run) => run.gates.map((task) => ({ project: run.project, epic: run.epic, task: String(task) }))),
    asks: [...view.questions, ...view.waiting].map(askRow),
    nightLog: view.nightLog.slice(0, NIGHT_LOG_KEPT).map(({ ts, kind, text }) => ({ ts, kind, text: text ?? "" })),
    usage,
    lanes,
    ...(laneCap != null ? { laneCap } : {}),
    ...(view.report ? { report: { id: view.report.id, summary: view.report.summary, sections: view.report.sections.map(({ key, text }) => ({ key, text })) } } : {}),
  };
};

const bytesOf = (doc) => Buffer.byteLength(JSON.stringify(doc));

// What is dropped to fit, in this order, oldest first: the night log (newest
// first, so from its end), then each run's spend points, then each run's
// timeline spans (both oldest first, an open span last), always from the run
// holding the most.
// The page still draws a shorter series; the newest data is what it is for.
const TRIM = [
  { key: "nightLog", what: "night-log entr", plural: ["y", "ies"] },
  { key: "spend", what: "spend point", plural: ["", "s"] },
  { key: "timeline", what: "timeline span", plural: ["", "s"] },
];

// A span still open is a lane held now: drop the oldest closed one first.
const oldestClosed = (list) => Math.max(0, list.findIndex((entry) => !entry.open));

/**
 * `{ doc, dropped }`: the document under MAX_BYTES, with `dropped` counting
 * what TRIM took out (`{nightLog, spend, timeline}`). Throws when it does not
 * fit with all three empty.
 */
export const fitSnapshot = (doc) => {
  const out = { ...doc, nightLog: [...doc.nightLog], runs: (doc.runs ?? []).map((run) => ({ ...run, spend: [...(run.spend ?? [])], timeline: [...(run.timeline ?? [])] })) };
  const dropped = { nightLog: 0, spend: 0, timeline: 0 };
  const lists = (key) => (key === "nightLog" ? [out.nightLog] : out.runs.map((run) => run[key]));
  let over = bytesOf(out) - MAX_BYTES + 1;
  for (const { key } of TRIM) {
    while (over > 0) {
      const list = lists(key).reduce((most, l) => (l.length > (most?.length ?? 0) ? l : most), null);
      if (!list) break;
      // One entry at a time would re-serialise the whole document per entry;
      // drop entries worth the overshoot, then measure again.
      let freed = 0;
      while (list.length && freed < over) {
        freed += Buffer.byteLength(JSON.stringify(key === "nightLog" ? list.pop() : list.splice(oldestClosed(list), 1)[0])) + 1;
        dropped[key] += 1;
      }
      over = bytesOf(out) - MAX_BYTES + 1;
    }
  }
  if (over > 0) throw new Error(`the snapshot is ${bytesOf(out)} bytes with no night log, spend or timeline, over the ${MAX_BYTES}-byte cap`);
  return { doc: out, dropped };
};

/** One stderr line per kind of entry dropped. */
export const droppedLines = (dropped) => TRIM.filter(({ key }) => dropped[key])
  .map(({ key, what, plural }) => `HUB: dropped the ${dropped[key]} oldest ${what}${plural[dropped[key] === 1 ? 0 : 1]} to keep the snapshot under ${MAX_BYTES / 1024} KB.`);
