// scripts/lanes.mjs — lane efficiency: context and tool calls per AFK lane,
// read from the Claude Code session transcripts (the same files as usage.mjs).
//
// One row per top-level session transcript: laneMetrics (context added and tool
// calls before the first edit, code-map read) and efficiency (turns, tools) from
// agent-stats.mjs, plus peak context, model, cost and timing. Cached per file by
// size + mtime, so only a transcript that moved is read again.
//
// `compareLanes` reproduces ~/code/projects/codemap-lanes.mjs: same folders
// (atlas-workspace), same window (file mtime), same filter (lanes that edited),
// same median (upper middle).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { threadId } from "node:worker_threads";
import { CONTEXT_LIMIT, efficiency, laneMetrics } from "./agent-stats.mjs";
import { afkSessionFiles, costOf, normaliseProject, placeOfSession, roleOf, transcriptsRoot } from "./usage.mjs";

const DAY_MS = 86_400_000;
const LIVE_MS = 5 * 60_000;

// Only these lines feed the metrics; user lines (tool results) are most of the
// bytes and are skipped before JSON.parse. A user line that happens to contain
// one of these strings is parsed and then ignored by type, so this is safe.
const KEEP = /"assistant"|"result"|turn\.completed|item\.started/;

const userText = (e) => {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
};

// Rows persist to disk so a restarted dashboard does not re-read every
// transcript (~7s cold on 2,268 files). Bump CACHE_VERSION when a row's shape
// or meaning changes. `AFK_LANES_CACHE` moves the file; the tests set it.
export const CACHE_VERSION = 2;
const cachePath = () => process.env.AFK_LANES_CACHE || join(homedir(), ".cache", "afk", "lanes-cache.json");
let cache = null;
let dirty = false;
const loadCache = () => {
  if (cache) return cache;
  cache = new Map();
  try {
    const disk = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (disk.version === CACHE_VERSION) cache = new Map(Object.entries(disk.rows));
  } catch { /* no cache yet, or unreadable: start empty */ }
  return cache;
};
// Written beside the cache and renamed over it: the dashboard's warm-up worker
// and every /lanes worker (dashboard or hub) each hold their own cache and write
// the same file, and an in-place write let a reader parse half of one and start empty.
// The temp name is per writer (pid and thread), so two writers never share one.
const saveCache = () => {
  if (!dirty) return;
  const tmp = `${cachePath()}.${process.pid}.${threadId}.tmp`;
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, rows: Object.fromEntries(cache) }));
    renameSync(tmp, cachePath());
    dirty = false;
  } catch {
    // A read-only home only costs the next cold start.
    try { rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
  }
};

/** One lane row for a transcript path; null when unreadable. Cached by size + mtime. */
export const laneOf = (path, folder = null) => {
  let stat;
  try { stat = statSync(path); } catch { return null; }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = loadCache().get(path);
  if (hit?.key === key) return hit.row;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  let first = null, cwd = null, firstAt = null, lastAt = null, lastTool = null, peak = 0, costUsd = 0, unpriced = false;
  const models = new Map();
  const seen = new Set();
  const kept = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const head = first == null || cwd == null || firstAt == null;
    if (!head && !KEEP.test(line)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    cwd ??= e.cwd ?? null;
    if (e.timestamp) { firstAt ??= e.timestamp; lastAt = e.timestamp; }
    if (e.type === "user" && first == null && !e.isMeta && userText(e).trim()) first = userText(e);
    if (e.type !== "assistant") { if (KEEP.test(line)) kept.push(line); continue; }
    kept.push(line);
    const m = e.message ?? {};
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_use") lastTool = b.name;
    const u = m.usage;
    if (!u || m.model === "<synthetic>" || e.isSidechain || seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    const write = u.cache_creation_input_tokens ?? 0;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    peak = Math.max(peak, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + write);
    models.set(m.model, (models.get(m.model) ?? 0) + 1);
    const c = costOf(m.model, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite1h: write1h, cacheWrite5m: Math.max(0, write - write1h) });
    if (c == null) unpriced = true; else costUsd += c;
  }
  // The last timestamp in the file, which may sit on a skipped line. Copied
  // through Date: a regex match is a slice that would keep the whole file alive.
  const tail = [...text.slice(-65536).matchAll(/"timestamp":"([^"]+)"/g)].pop();
  if (tail) lastAt = new Date(tail[1]).toISOString();
  const body = kept.join("\n");
  const lm = laneMetrics(body);
  const ef = efficiency(body);
  const role = roleOf(first);
  const place = placeOfSession(cwd, first, role.promptRoot);
  const b = lm.beforeFirstEdit;
  const row = {
    file: path,
    folder: folder ? basename(folder) : null,
    project: normaliseProject(place.project ?? "unknown"),
    epicId: place.epicId ?? "unknown",
    role: role.role,
    taskId: role.taskId,
    attempt: role.attempt,
    model: [...models].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "unknown",
    firstAt,
    lastAt: lastAt ?? new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    edited: lm.edited,
    readCodeMap: lm.readCodeMap,
    beforeFirstEdit: {
      contextGrowth: b.contextGrowth, tokens: b.tokens, toolCalls: b.toolCalls,
      explore: b.explore.toolCalls, graphify: b.graphify.toolCalls, other: b.other.toolCalls,
    },
    outputTokens: lm.outputTokens,
    turns: ef.turns,
    toolCalls: ef.toolCalls,
    tools: ef.tools,
    peakContext: peak,
    peakShare: peak / CONTEXT_LIMIT,
    lastTool,
    costUsd: unpriced && !costUsd ? null : costUsd,
  };
  cache.set(path, { key, row });
  dirty = true;
  return row;
};

/** Every top-level AFK session touched since `since` (ms), one lane row each. */
export const collectLanes = ({ root = transcriptsRoot(), since = 0, match, now = Date.now() } = {}) => {
  const rows = [];
  for (const { folder, path, parent } of afkSessionFiles(root, match, since)) {
    if (parent) continue;
    const row = laneOf(path, folder);
    if (row) rows.push({ ...row, live: now - row.mtimeMs < LIVE_MS });
  }
  saveCache();
  return rows;
};

/** The median codemap-lanes.mjs uses: the upper middle of the sorted values. */
export const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const summary = (rows) => {
  const edited = rows.filter((r) => r.edited);
  const b = (f) => median(edited.map((r) => f(r.beforeFirstEdit)));
  return {
    lanes: rows.length,
    edited: edited.length,
    contextBeforeEdit: b((x) => x.contextGrowth),
    callsBeforeEdit: b((x) => x.toolCalls),
    exploreBeforeEdit: b((x) => x.explore),
    graphifyBeforeEdit: b((x) => x.graphify),
    otherBeforeEdit: b((x) => x.other),
    billedBeforeEdit: b((x) => x.tokens),
    turns: median(rows.map((r) => r.turns)),
    toolCalls: median(rows.map((r) => r.toolCalls)),
    peakShare: median(rows.map((r) => r.peakShare)),
    readCodeMapShare: rows.length ? rows.filter((r) => r.readCodeMap).length / rows.length : null,
    costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  };
};

const groupBy = (rows, keyOf) => {
  const out = new Map();
  for (const r of rows) out.set(keyOf(r), [...(out.get(keyOf(r)) ?? []), r]);
  return [...out].map(([key, g]) => ({ key, ...summary(g) })).sort((a, b) => b.lanes - a.lanes);
};

// Sessions that are not lanes: the one-word preflight ping, and openings no
// runner prompt matches.
const isLane = (r) => r.role !== "preflight" && r.role !== "unknown";

/** What /lanes serves: headline, daily trend, by project, by role, every lane, live lanes. */
export const lanesReport = ({ days = 30, project = null, now = Date.now(), root } = {}) => {
  const since = now - days * DAY_MS;
  const all = collectLanes({ root, since, now }).filter(isLane);
  const rows = all.filter((r) => !project || r.project === project);
  rows.sort((a, b) => b.peakContext - a.peakContext);
  const trend = groupBy(rows, (r) => new Date(r.mtimeMs).toISOString().slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key));
  const projects = [...new Set(all.map((r) => r.project))].sort();
  return {
    window: { days, from: new Date(since).toISOString(), to: new Date(now).toISOString(), project },
    contextLimit: CONTEXT_LIMIT,
    projects,
    headline: summary(rows),
    trend,
    byProject: groupBy(rows, (r) => r.project),
    byRole: groupBy(rows, (r) => r.role),
    lanes: rows.map(({ file, folder, ...r }) => r),
    live: rows.filter((r) => r.live).map(({ file, folder, ...r }) => r),
  };
};

const CODEMAP_FOLDER = /atlas-workspace(-\d+)?$/;

/**
 * The codemap-lanes.mjs table for one window [from, to] (dates, `to`
 * inclusive): edited atlas-workspace lanes, split by whether they read the
 * code map. Window and folder rule are that script's, not this page's.
 */
export const codemapWindow = ({ from, to = "2999-01-01", root } = {}) => {
  const lo = Date.parse(from);
  const hi = Date.parse(to) + DAY_MS;
  const rows = collectLanes({ root, since: lo, match: (name) => CODEMAP_FOLDER.test(name) })
    .filter((r) => r.mtimeMs < hi && r.edited);
  const group = (g) => {
    const s = summary(g);
    return { lanes: g.length, contextBeforeEdit: s.contextBeforeEdit, callsBeforeEdit: s.callsBeforeEdit, exploreBeforeEdit: s.exploreBeforeEdit, graphifyBeforeEdit: s.graphifyBeforeEdit, billedBeforeEdit: s.billedBeforeEdit, outputTokens: median(g.map((r) => r.outputTokens)) };
  };
  return { from, to, lanes: rows.length, readMap: group(rows.filter((r) => r.readCodeMap)), noMap: group(rows.filter((r) => !r.readCodeMap)) };
};

/** Baseline [baselineFrom, baselineTo] against everything since `since`, as the routine compares them. */
export const compareLanes = ({ since = "2026-10-05", baselineFrom = "2026-08-25", baselineTo = "2026-10-03", root } = {}) => ({
  baseline: codemapWindow({ from: baselineFrom, to: baselineTo, root }),
  after: codemapWindow({ from: since, root }),
});
