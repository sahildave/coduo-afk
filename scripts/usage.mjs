// scripts/usage.mjs — AFK token usage and cost, read from Claude Code session
// transcripts (~/.claude/projects/<cwd-slug>/<session>.jsonl).
//
// Every AFK agent (direct or herdr, every role) is a Claude Code session, and
// Claude Code writes each session's transcript as it runs, so one reader covers
// finished epics (backfill) and in-flight lanes (live). The role comes from the
// session's first user message, which every runner prompt opens the same way;
// a session whose opening matches no prompt is `unknown`, never a guess.
//
//   afk usage [--month] [--json]
//
// `AFK_TRANSCRIPTS_ROOT` moves the transcript root (the tests set it).
// `AFK_USAGE_BUDGET_USD` sets the monthly budget (default 200).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMainModule, parseArgv } from "./lib.mjs";

// USD per million tokens. Cache writes are priced from `input`: 1.25x for the
// 5-minute cache, 2x for the 1-hour cache (transcripts split the two; herdr
// lanes write mostly 1-hour). Source: platform.claude.com/docs/en/about-claude/pricing,
// read 2026-10-09.
export const PRICES = {
  // Opus 5.5 standard price. $8/$40 on the pricing page is its fast-mode price.
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  // Sonnet 5.5: output $10 is an ASSUMPTION from the brief; the pricing page
  // read on 2026-10-09 agrees ($10/MTok).
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5 is tiered by prompt length; this is the up-to-100k tier.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08 },
};

export const DEFAULT_BUDGET_USD = 200;
export const budgetUsd = () => Number(process.env.AFK_USAGE_BUDGET_USD) || DEFAULT_BUDGET_USD;

/** The PRICES row for a model id, ignoring a date or `[1m]` suffix; null if unknown. */
export const priceOf = (model) => {
  const id = String(model ?? "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  if (PRICES[id]) return PRICES[id];
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => id.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
};

/** USD for one bucket of tokens; null when the model has no price. */
export const costOf = (model, t) => {
  const p = priceOf(model);
  if (!p) return null;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead
    + t.cacheWrite5m * p.input * 1.25 + t.cacheWrite1h * p.input * 2) / 1e6;
};

const ROLE_OPENINGS = [
  [/^You are the plan-reviewer/, "plan-review"],
  [/^You are the builder for exactly one/, "builder"],
  [/^You are a fresh merger agent/, "integration"],
  [/^You are the verifier for one/, "verifier"],
  [/^You are the fixer for one/, "fixer"],
  [/^You are the supervisor of one/, "supervisor"],
  [/^You are writing the reflection/, "reflect"],
  [/^Reply with the single word: OK/, "preflight"],
];
const LANE_POINTER = /Read the file (\S*?)\/\.afk\/runs\/([^/\s]+)\/([a-z-]+)-(\d+)\/prompt\.md/;

/** Role (and lane, for a herdr pointer prompt) from a session's first user message. */
export const roleOf = (text) => {
  const body = String(text ?? "").replace(/<\/?pasted_content[^>]*>/g, "").trim();
  const lane = LANE_POINTER.exec(body);
  if (lane) return { role: lane[3], taskId: lane[2], attempt: Number(lane[4]), promptRoot: lane[1] };
  const hit = ROLE_OPENINGS.find(([re]) => re.test(body));
  // A direct (non-herdr) builder or merger prompt names its task on a line of its own.
  const task = hit ? /^Task ID: (\S+)/m.exec(body) : null;
  return { role: hit ? hit[1] : "unknown", taskId: task ? task[1] : null, attempt: null, promptRoot: null };
};

// `<epic-slug>-<repo>`, the epic slug ending in its id (`-841` or `-wave-34`).
const splitEpicRepo = (name) => {
  const match = /^(.*)-(wave-\d+)-(.+)$/.exec(name) ?? /^(.*)-(\d+)-(.+)$/.exec(name);
  return match ? { project: stripHome(match[3]), epicId: match[2] } : null;
};
const stripHome = (repo) => repo.replace(/^Users-[^-]+-code-projects-/, "");

/** `{ project, epicId }` from a session's cwd (or the lane prompt's root); nulls when unreadable. */
export const placeOf = (cwd, promptRoot = null) => {
  for (const path of [promptRoot, cwd]) {
    const epics = /\/\.afk-claude\/epics\/([^/]+)\/([^/]+)/.exec(path ?? "");
    if (epics) return { project: epics[2], epicId: /-(\d+|wave-\d+)$/.exec(epics[1])?.[1] ?? null };
  }
  const wt = /\/\.afk-claude\/worktrees\/([^/]+)/.exec(cwd ?? "");
  return (wt && splitEpicRepo(wt[1])) ?? { project: null, epicId: null };
};

const TEMP_DIR = /^\/(private\/)?(var\/folders|tmp)\//;
// Literal path characters only, so a placeholder such as `epics/<slug>/<repo>` never matches.
const RUNNER_PATH = /\/\.afk-claude\/(?:epics|worktrees)\/[\w.-]+(?:\/[\w.-]+)*/g;

/**
 * `{ project, epicId }` for any AFK session: the runner's epic and worktree
 * paths first (cwd, then any such path quoted in the prompt, which is how a
 * merger in a temp dir names its worktree), then the repo a plain checkout cwd
 * sits in. A temp-dir cwd with nothing in the prompt stays null.
 */
export const placeOfSession = (cwd, first, promptRoot = null) => {
  const place = placeOf(cwd, promptRoot);
  if (place.project) return place;
  for (const [path] of String(first ?? "").matchAll(RUNNER_PATH)) {
    const p = placeOf(path);
    if (p.project) return p;
  }
  if (!cwd || TEMP_DIR.test(cwd) || cwd.includes("/.afk-claude/")) return { project: null, epicId: null };
  return { project: /\/code\/projects\/([^/]+)/.exec(cwd)?.[1] ?? basename(cwd), epicId: null };
};

/** Project and epic from the transcript folder name alone, when no cwd is in the file. */
const placeOfFolder = (folder) => splitEpicRepo(folder.replace(/^-/, "")) ?? { project: null, epicId: null };

const userText = (event) => {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
};

const ZERO = () => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

// Parse cache: path -> { key, parsed }. The dashboard re-reads on every request;
// only a file whose size or mtime moved is parsed again.
const cache = new Map();

// The same cache on disk, for a short-lived process (`afk hub snapshot`) that
// would otherwise parse every transcript of the month cold. Only a caller that
// asks for it loads or saves it, so the dashboard and the tests never touch
// it. `AFK_USAGE_CACHE` moves the file. Bump USAGE_CACHE_VERSION when a parsed
// transcript's shape changes. Entries older than USAGE_CACHE_DAYS are dropped
// on save: a month's scan never reads them.
const USAGE_CACHE_VERSION = 1;
const USAGE_CACHE_DAYS = 62;
export const usageCachePath = () => process.env.AFK_USAGE_CACHE || join(homedir(), ".cache", "afk", "usage-cache.json");
const MESSAGE_KEYS = ["model", "at", "input", "output", "cacheRead", "cacheWrite1h", "cacheWrite5m"];

/** Fill the parse cache from disk. A missing or unreadable file starts empty. */
export const loadUsageCache = (path = usageCachePath()) => {
  try {
    const disk = JSON.parse(readFileSync(path, "utf8"));
    if (disk.version !== USAGE_CACHE_VERSION) return;
    for (const [file, { key, parsed }] of Object.entries(disk.rows)) {
      if (cache.has(file)) continue;
      const messages = new Map(parsed.messages.map(([id, ...values]) => [id, Object.fromEntries(MESSAGE_KEYS.map((k, i) => [k, values[i]]))]));
      cache.set(file, { key, parsed: { ...parsed, messages } });
    }
  } catch { /* no cache yet, or unreadable: start empty */ }
};

/** Write the parse cache to disk; a read-only home only costs the next cold start. */
export const saveUsageCache = (path = usageCachePath(), now = Date.now()) => {
  const rows = {};
  for (const [file, { key, parsed }] of cache) {
    if (now - parsed.mtimeMs > USAGE_CACHE_DAYS * 86_400_000) continue;
    rows[file] = { key, parsed: { ...parsed, messages: [...parsed.messages].map(([id, m]) => [id, ...MESSAGE_KEYS.map((k) => m[k])]) } };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: USAGE_CACHE_VERSION, rows }));
  } catch { /* see above */ }
};

/**
 * One transcript: its meta (first user message, cwd, session) and every
 * assistant message's usage keyed by message id. Claude Code writes one line
 * per content block, each repeating the message's usage; the last line wins.
 */
export const parseTranscript = (path) => {
  let stat;
  try { stat = statSync(path); } catch { return null; }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(path);
  if (hit?.key === key) return hit.parsed;
  const parsed = { first: null, cwd: null, sessionId: null, firstAt: null, lastAt: null, mtimeMs: stat.mtimeMs, messages: new Map() };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    parsed.cwd ??= e.cwd ?? null;
    parsed.sessionId ??= e.sessionId ?? e.session_id ?? null;
    if (e.timestamp) { parsed.firstAt ??= e.timestamp; parsed.lastAt = e.timestamp; }
    if (e.type === "user" && parsed.first == null && !e.isMeta) {
      const t = userText(e);
      if (t.trim()) parsed.first = t;
    }
    const usage = e.type === "assistant" ? e.message?.usage : null;
    if (!usage || e.message?.model === "<synthetic>") continue;
    const id = e.message?.id ?? `${path}:${parsed.messages.size}`;
    const split = usage.cache_creation;
    const write = usage.cache_creation_input_tokens ?? 0;
    const write1h = split ? split.ephemeral_1h_input_tokens ?? 0 : 0;
    parsed.messages.set(id, {
      model: e.message?.model ?? "unknown",
      at: e.timestamp ?? null,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite1h: write1h,
      cacheWrite5m: Math.max(0, write - write1h),
    });
  }
  cache.set(path, { key, parsed });
  return parsed;
};

export const transcriptsRoot = () => resolve(process.env.AFK_TRANSCRIPTS_ROOT || join(homedir(), ".claude", "projects"));

/** AFK transcript folders: Claude Code project dirs for runner epic checkouts and worktrees. */
export const afkFolders = (root = transcriptsRoot(), match = () => true) => {
  let names;
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((name) => name.includes("afk-claude-epics") && match(name)).map((name) => join(root, name));
};

// First-user-message cache: path -> head. The opening never changes once
// written, so a found head is kept whatever the file does next.
const heads = new Map();
const HEAD_CHUNK = 65_536;
const HEAD_MAX = 4 * 1024 * 1024;

/**
 * `{ first, cwd }` from the start of a transcript, reading 64 KB chunks only
 * until the first non-meta user message with text (attachments can push it past
 * 100 KB). Classifies a session without parsing the rest of the file.
 */
export const headOf = (path) => {
  const hit = heads.get(path);
  if (hit?.first != null) return hit;
  let fd;
  try { fd = openSync(path, "r"); } catch { return { first: null, cwd: null }; }
  const out = { first: null, cwd: null };
  try {
    let pending = "", pos = 0;
    const buf = Buffer.alloc(HEAD_CHUNK);
    while (pos < HEAD_MAX) {
      const n = readSync(fd, buf, 0, HEAD_CHUNK, pos);
      if (!n) break;
      pos += n;
      const lines = (pending + buf.toString("utf8", 0, n)).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        out.cwd ??= e.cwd ?? null;
        if (e.type === "user" && !e.isMeta && userText(e).trim()) { out.first = userText(e); heads.set(path, out); return out; }
      }
    }
  } finally { closeSync(fd); }
  heads.set(path, out);
  return out;
};

const isAfkFolder = (name) => name.includes("afk-claude-epics");

/**
 * Every AFK session under `root`, whatever folder it sits in: a top-level
 * transcript whose first user message is a runner prompt (any role, preflight
 * included), plus anything in a runner epic folder, plus each one's subagents.
 * Interactive sessions are read to their first user message and dropped.
 */
export const afkSessionFiles = (root = transcriptsRoot(), match = () => true, since = null) => {
  const out = [];
  let folders;
  try { folders = readdirSync(root); } catch { return out; }
  for (const name of folders) {
    if (!match(name)) continue;
    const folder = join(root, name);
    let files;
    try { files = readdirSync(folder); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(folder, file);
      if (since != null) {
        try { if (statSync(path).mtimeMs < since) continue; } catch { continue; }
      }
      if (!isAfkFolder(name) && roleOf(headOf(path).first).role === "unknown") continue;
      out.push({ folder, path, parent: null });
      const session = file.slice(0, -6);
      const sub = join(folder, session, "subagents");
      if (existsSync(sub)) {
        for (const child of readdirSync(sub)) if (child.endsWith(".jsonl")) out.push({ folder, path: join(sub, child), parent: session });
      }
    }
  }
  return out;
};

/** Every session file in a folder: `<session>.jsonl` and its `<session>/subagents/*.jsonl`. */
const sessionFiles = (folder) => {
  const out = [];
  let names;
  try { names = readdirSync(folder); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const session = name.slice(0, -6);
    out.push({ path: join(folder, name), parent: null });
    const sub = join(folder, session, "subagents");
    if (existsSync(sub)) {
      for (const child of readdirSync(sub)) if (child.endsWith(".jsonl")) out.push({ path: join(sub, child), parent: session });
    }
  }
  return out;
};

const LIVE_MS = 5 * 60_000;
const TOKEN_KEYS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"];

/**
 * One row per (session file, model): role, lane, project, epic, tokens, cost.
 * `since` (ms) skips files untouched since then and messages before it.
 * Message ids are deduped across files (a resumed session repeats history).
 * With `bucketMs`, each row also carries `buckets`: `{ <bucket start ms>: usd }`,
 * its cost per time bucket by message timestamp; a bucket holding an unpriced
 * message is null (allKnown), never a partial sum.
 */
export const collectUsage = ({ root = transcriptsRoot(), since = null, match, now = Date.now(), bucketMs = null } = {}) => {
  const seen = new Set();
  const rows = [];
  // Parents first, so each subagent inherits its parent's role and place.
  const all = afkSessionFiles(root, match);
  const files = [...all.filter((f) => !f.parent), ...all.filter((f) => f.parent)];
  const metas = new Map();
  for (const { folder, path, parent } of files) {
    if (since != null) {
      try { if (statSync(path).mtimeMs < since) continue; } catch { continue; }
    }
    const t = parseTranscript(path);
    if (!t) continue;
    const own = roleOf(t.first);
    const parentKey = parent && join(folder, parent);
    const meta = parent && metas.get(parentKey)
      ? { ...metas.get(parentKey), subagent: true }
      : (() => {
        const place = placeOfSession(t.cwd, t.first, own.promptRoot);
        const fallback = placeOfFolder(basename(folder));
        return { ...own, project: place.project ?? fallback.project, epicId: place.epicId ?? fallback.epicId, subagent: false };
      })();
    if (!parent) metas.set(join(folder, basename(path, ".jsonl")), meta);
    const byModel = new Map();
    for (const [id, m] of t.messages) {
      if (seen.has(id)) continue;
      if (since != null && m.at && Date.parse(m.at) < since) continue;
      seen.add(id);
      const sum = byModel.get(m.model) ?? { ...ZERO(), messages: 0 };
      for (const k of Object.keys(ZERO())) sum[k] += m[k];
      sum.messages++;
      if (bucketMs && m.at) {
        const bucket = Math.floor(Date.parse(m.at) / bucketMs) * bucketMs;
        if (Number.isFinite(bucket)) {
          const buckets = (sum.buckets ??= {});
          const usd = costOf(m.model, m);
          buckets[bucket] = buckets[bucket] === null || usd == null ? null : (buckets[bucket] ?? 0) + usd;
        }
      }
      byModel.set(m.model, sum);
    }
    for (const [model, sum] of byModel) {
      rows.push({
        file: path,
        sessionId: t.sessionId,
        role: meta.role,
        taskId: meta.taskId,
        attempt: meta.attempt,
        subagent: meta.subagent,
        project: meta.project ?? "unknown",
        epicId: meta.epicId ?? "unknown",
        model,
        firstAt: t.firstAt,
        lastAt: t.lastAt,
        live: now - t.mtimeMs < LIVE_MS,
        ...sum,
        costUsd: costOf(model, sum),
      });
    }
  }
  return rows;
};

/** Wall time of a transcript: first to last timestamp. */
export const transcriptDurationMs = (path) => {
  const t = parseTranscript(path);
  const ms = t && Date.parse(t.lastAt) - Date.parse(t.firstAt);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The transcripts of one lane (a herdr lane writes no stream.jsonl): sessions
 * whose first message points at `.afk/runs/<task>/<kind>-<attempt>/prompt.md`
 * for this project and epic. Oldest first.
 */
export const laneTranscripts = ({ project, epicId, taskId, kind, attempt, root = transcriptsRoot() }) => {
  const epic = String(epicId ?? "");
  const out = [];
  for (const folder of afkFolders(root, (name) => !epic || name.includes(epic))) {
    for (const { path, parent } of sessionFiles(folder)) {
      if (parent) continue;
      const t = parseTranscript(path);
      const role = roleOf(t?.first);
      if (role.taskId !== String(taskId) || role.role !== kind || role.attempt !== attempt) continue;
      const place = placeOf(t.cwd, role.promptRoot);
      if (project && place.project && place.project !== project) continue;
      if (epic && place.epicId && place.epicId !== epic) continue;
      out.push({ path, firstAt: t.firstAt });
    }
  }
  return out.sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt))).map((x) => x.path);
};

const group = (rows, keyOf) => {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const g = out.get(key) ?? { key, ...ZERO(), messages: 0, costUsd: 0, unpriced: 0, live: false };
    for (const k of TOKEN_KEYS) g[k] += row[k];
    g.messages += row.messages;
    if (row.costUsd == null) g.unpriced += row.messages; else g.costUsd += row.costUsd;
    g.live ||= row.live;
    out.set(key, g);
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd);
};

export const monthStart = (now = new Date()) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

/**
 * The aggregates `afk usage` prints and the dashboard's /usage serves. `rows`
 * is a `collectUsage` result over the same window, when the caller already has
 * one (the hub snapshot), so the transcripts are read once.
 */
export const usageReport = ({ month = true, now = new Date(), root, rows: given = null } = {}) => {
  const since = month ? monthStart(now) : null;
  const rows = given ?? collectUsage({ root, since, now: now.getTime() });
  const total = group(rows, () => "total")[0] ?? { key: "total", ...ZERO(), messages: 0, costUsd: 0, unpriced: 0 };
  const budget = budgetUsd();
  return {
    window: month ? { from: new Date(since).toISOString(), to: now.toISOString() } : { from: null, to: now.toISOString() },
    budgetUsd: budget,
    spentUsd: total.costUsd,
    remainingUsd: budget - total.costUsd,
    budgetShare: total.costUsd / budget,
    total,
    byRole: group(rows, (r) => r.role),
    byEpic: group(rows, (r) => `${r.project} #${r.epicId}`),
    byProject: group(rows, (r) => r.project),
    byModel: group(rows, (r) => r.model),
    byLane: group(rows.filter((r) => r.taskId), (r) => `${r.project} #${r.epicId} ${r.role} ${r.taskId}-${r.attempt}`),
    live: group(rows.filter((r) => r.live), (r) => `${r.project} #${r.epicId} ${r.role}${r.taskId ? ` ${r.taskId}-${r.attempt}` : ""}`),
  };
};

// ---- "What fits in the budget" insights -----------------------------------

const DAY_MS = 86_400_000;
export const INSIGHT_WINDOW_DAYS = 30;
export const WEEK_DAYS = 7;

/**
 * UI or not, per project. Non-UI work is what an Agent SDK lane can run without
 * a screen, so only it is packed into the API budget. A project in neither list
 * is "unclassified" and never packed.
 */
export const PROJECT_KINDS = {
  ui: ["atlas-workspace", "Lumina", "quillnote", "harbour", "atlas-central", "riverbend", "voice-studio", "fitnessapp", "coduo-swiftui-factory", "brightpath"],
  nonUi: ["afk-claude", "coduo-billing-infra"],
};
export const kindOf = (project) =>
  PROJECT_KINDS.ui.includes(project) ? "ui" : PROJECT_KINDS.nonUi.includes(project) ? "non-ui" : "unclassified";

export const SMALL_ROLES = ["plan-review", "preflight", "integration", "reflect", "fixer", "supervisor", "verifier"];

/** Fold Lumina folders into Lumina and junk keys (ids, numbers, scratch runs) into "other". */
export const normaliseProject = (name) => {
  const p = String(name ?? "");
  if (p.includes("Lumina")) return "Lumina";
  if (/^[0-9a-f]{8,}$/.test(p) || /^\d+$/.test(p) || /^role-cwd-verify-/.test(p)
    || [".afk", "unknown", "wave-throwaway", "wave-fail", ""].includes(p)) return "other";
  return p;
};

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};

/** Lane cost per (project, epic, role, task, attempt), summed across models. */
const laneCosts = (rows, role) => {
  const lanes = new Map();
  for (const r of rows) {
    if (r.role !== role || !r.taskId) continue;
    const project = normaliseProject(r.project);
    const key = `${project}|${r.epicId}|${r.taskId}|${r.attempt}`;
    const lane = lanes.get(key) ?? { project, costUsd: 0 };
    lane.costUsd += r.costUsd ?? 0;
    lanes.set(key, lane);
  }
  return [...lanes.values()];
};

const laneStats = (lanes, budget) => {
  const byProject = new Map();
  for (const l of lanes) byProject.set(l.project, [...(byProject.get(l.project) ?? []), l.costUsd]);
  return [...byProject].map(([project, costs]) => {
    const sorted = costs.sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    return { project, lanes: sorted.length, medianUsd: median, p90Usd: quantile(sorted, 0.9), lanesPerBudget: median > 0 ? Math.floor(budget / median) : null };
  }).sort((a, b) => b.lanes - a.lanes);
};

const sumCost = (rows, pred) => rows.reduce((s, r) => s + (pred(r) ? r.costUsd ?? 0 : 0), 0);

/** The packable items (small roles, non-UI projects' builders) with their cost over `rows`. */
const workItems = (rows) => [
  ...SMALL_ROLES.map((role) => ({ id: `role:${role}`, label: `${role} (all projects)`, kind: "role", costUsd: sumCost(rows, (r) => r.role === role) })),
  ...PROJECT_KINDS.nonUi.map((project) => ({ id: `builders:${project}`, label: `${project} builders`, kind: "builders", costUsd: sumCost(rows, (r) => r.role === "builder" && normaliseProject(r.project) === project) })),
];

export const verdictOf = (share) => (share <= 1 ? "fits" : share <= 1.3 ? "borderline" : "does-not-fit");

/**
 * What the monthly API budget buys, from the trailing `INSIGHT_WINDOW_DAYS`
 * of AFK rows. `weekRows` (the last 7 days of AFK rows) and `week` (Claude Code
 * usage over the same 7 days, see claudeCodeWeek) turn each item into a share
 * of last week's Claude Code usage; both are optional.
 */
export const usageInsights = ({ rows, weekRows = [], week = null, budget = budgetUsd(), now = new Date() }) => {
  const share = (cost) => (week && week.costUsd > 0 ? cost / week.costUsd : null);
  const weekItems = new Map(workItems(weekRows).map((i) => [i.id, i.costUsd]));
  const projects = new Map();
  for (const r of rows) {
    const p = normaliseProject(r.project);
    projects.set(p, (projects.get(p) ?? 0) + (r.costUsd ?? 0));
  }
  const weekProject = (p) => sumCost(weekRows, (r) => normaliseProject(r.project) === p);
  const byProject = [...projects].map(([project, costUsd]) => ({
    project, kind: project === "other" ? "other" : kindOf(project), costUsd,
    budgetShare: costUsd / budget, verdict: verdictOf(costUsd / budget),
    weekCostUsd: weekProject(project), weekShare: share(weekProject(project)),
  })).sort((a, b) => b.costUsd - a.costUsd);

  const items = workItems(rows).map((i) => ({ ...i, weekCostUsd: weekItems.get(i.id) ?? 0, weekShare: share(weekItems.get(i.id) ?? 0) }));
  const roles = items.filter((i) => i.kind === "role");
  const smallRoles = roles.reduce((s, i) => s + i.costUsd, 0);
  const smallRolesWeek = roles.reduce((s, i) => s + i.weekCostUsd, 0);

  // Cheapest first: roles, then non-UI builders, each group ascending.
  const order = [...roles.sort((a, b) => a.costUsd - b.costUsd), ...items.filter((i) => i.kind === "builders").sort((a, b) => a.costUsd - b.costUsd)];
  const packed = [];
  const skipped = [];
  let used = 0;
  for (const item of order) {
    if (item.costUsd <= 0) continue;
    if (used + item.costUsd <= budget) { packed.push(item); used += item.costUsd; } else skipped.push(item);
  }
  const packedWeek = packed.reduce((s, i) => s + i.weekCostUsd, 0);
  return {
    window: { days: INSIGHT_WINDOW_DAYS, from: new Date(now.getTime() - INSIGHT_WINDOW_DAYS * DAY_MS).toISOString(), to: now.toISOString() },
    budgetUsd: budget,
    builderLanes: laneStats(laneCosts(rows, "builder"), budget),
    integrationLanes: laneStats(laneCosts(rows, "integration"), budget),
    byProject,
    nonUi: { items, smallRoles: { costUsd: smallRoles, weekCostUsd: smallRolesWeek, weekShare: share(smallRolesWeek) } },
    recommendation: { packed, skipped, usedUsd: used, leftUsd: budget - used, weekCostUsd: packedWeek, weekShare: share(packedWeek) },
    week,
  };
};

// ---- Claude Code usage over the last week, every transcript on the machine --

/** Root of the all-transcripts scan. Falls back to AFK_TRANSCRIPTS_ROOT so a pinned test never reads real data. */
export const allTranscriptsRoot = () => resolve(process.env.AFK_ALL_TRANSCRIPTS_ROOT || process.env.AFK_TRANSCRIPTS_ROOT || join(homedir(), ".claude", "projects"));

// Lean per-file cache for the week scan: only assistant usage lines are parsed.
const weekCache = new Map();
const usageLines = (path, stat) => {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = weekCache.get(path);
  if (hit?.key === key) return hit.messages;
  const messages = [];
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return messages; }
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const usage = e.type === "assistant" ? e.message?.usage : null;
    if (!usage || e.message?.model === "<synthetic>") continue;
    const write = usage.cache_creation_input_tokens ?? 0;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    messages.push({
      id: e.message?.id ?? `${path}:${messages.length}`, model: e.message?.model ?? "unknown", at: Date.parse(e.timestamp ?? "") || 0,
      input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite1h: write1h, cacheWrite5m: Math.max(0, write - write1h),
    });
  }
  weekCache.set(path, { key, messages });
  return messages;
};

/**
 * Every Claude Code session on this machine (all project folders, subagents
 * too) over the last `days`, deduped by message id and cost-weighted at API
 * prices. Cost is the proxy for plan-limit consumption across token types;
 * Anthropic publishes no weekly limit in tokens, so this is a share of actual
 * use, never of the limit.
 */
export const claudeCodeWeek = ({ root = allTranscriptsRoot(), now = Date.now(), days = WEEK_DAYS } = {}) => {
  const since = now - days * DAY_MS;
  const seen = new Map();
  let folders;
  try { folders = readdirSync(root); } catch { folders = []; }
  let files = 0;
  for (const folder of folders) {
    for (const { path } of sessionFiles(join(root, folder))) {
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.mtimeMs < since) continue;
      files++;
      for (const m of usageLines(path, stat)) if (m.at >= since && m.at <= now) seen.set(m.id, m);
    }
  }
  const tokens = ZERO();
  let costUsd = 0;
  let unpriced = 0;
  for (const m of seen.values()) {
    for (const k of TOKEN_KEYS) tokens[k] += m[k];
    const c = costOf(m.model, m);
    if (c == null) unpriced++; else costUsd += c;
  }
  return { days, from: new Date(since).toISOString(), to: new Date(now).toISOString(), files, messages: seen.size, unpriced, costUsd, tokens };
};

/** Insights over live data: trailing 30 days of AFK rows plus last week's Claude Code usage. */
export const insightsReport = ({ now = new Date(), root, allRoot } = {}) => {
  const rows = collectUsage({ root, since: now.getTime() - INSIGHT_WINDOW_DAYS * DAY_MS, now: now.getTime() });
  const weekSince = now.getTime() - WEEK_DAYS * DAY_MS;
  const weekRows = collectUsage({ root, since: weekSince, now: now.getTime() });
  const week = claudeCodeWeek({ root: allRoot, now: now.getTime() });
  return usageInsights({ rows, weekRows, week, now });
};

const usd = (n) => `$${n.toFixed(2)}`;
const mtok = (n) => `${(n / 1e6).toFixed(2)}M`;

export const formatReport = (r) => {
  const lines = [];
  const scope = r.window.from ? `month to date (${r.window.from.slice(0, 10)} to ${r.window.to.slice(0, 10)})` : "all time";
  lines.push(`AFK usage, ${scope}, at API prices`);
  lines.push(`Spent ${usd(r.spentUsd)} of ${usd(r.budgetUsd)} budget (${(r.budgetShare * 100).toFixed(1)}%), ${usd(r.remainingUsd)} left`);
  const table = (title, groups, limit = 15) => {
    lines.push("", title);
    lines.push(`  ${"name".padEnd(44)} ${"cost".padStart(10)} ${"in".padStart(8)} ${"out".padStart(8)} ${"c.write".padStart(8)} ${"c.read".padStart(9)}`);
    for (const g of groups.slice(0, limit)) {
      lines.push(`  ${(String(g.key) + (g.live ? " *" : "")).slice(0, 44).padEnd(44)} ${usd(g.costUsd).padStart(10)} ${mtok(g.input).padStart(8)} ${mtok(g.output).padStart(8)} ${mtok(g.cacheWrite5m + g.cacheWrite1h).padStart(8)} ${mtok(g.cacheRead).padStart(9)}${g.unpriced ? `  (${g.unpriced} msgs unpriced)` : ""}`);
    }
    if (groups.length > limit) lines.push(`  ... ${groups.length - limit} more (--json for all)`);
  };
  table("By role", r.byRole);
  table("By model", r.byModel);
  table("By project", r.byProject);
  table("By epic", r.byEpic);
  table("By lane (one row per attempt, most expensive first)", r.byLane, 25);
  table("Live now (* = transcript written in the last 5 min)", r.live);
  return lines.join("\n");
};

if (isMainModule(import.meta.url)) {
  let parsed;
  try { parsed = parseArgv(process.argv.slice(2), ["month", "json"], { command: "usage" }); } catch (error) {
    console.log(`afk: ${error.message}`);
    process.exit(1);
  }
  const report = usageReport({ month: Boolean(parsed.flags.month) });
  console.log(parsed.flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
}
