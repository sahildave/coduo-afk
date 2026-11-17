// scripts/orchestrator-lag.mjs — how long after a lane finishes, fails or gets
// stuck the Orchestrator tells the owner about it.
//
// Lane events come from the runner's log (`.afk/agent-auto.log`, or
// `.afk/archive/<run>/agent-auto.log`). The Orchestrator is the interactive
// Claude session whose first user message says "You are the Orchestrator for
// this epic"; it mentions a lane when an assistant text block (what the owner
// reads, not a tool call or thinking) names the task at or after the event.
//
//   afk orchestrator-lag --project=<repo-path> [--epic=<id>] [--json]
//
// `AFK_TRANSCRIPTS_ROOT` moves the transcript root (the tests set it).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule, parseArgv } from "./lib.mjs";
import { measurePath, measureProject } from "./measure.mjs";
import { headOf, transcriptsRoot } from "./usage.mjs";

export const MISSED_AFTER_MIN = 15;

// One pattern per lane outcome the owner wants to hear about, taken from the
// runner's `say(` lines in scripts/auto.mjs. Retries ("failed; retrying") and
// rate-limit waits are not here: the lane is still working.
export const LANE_EVENTS = [
  ["committed", /^AUTO: builder (\S+) passed worktree checks and committed/],
  ["merged", /^AUTO: (\S+) integrated and passed post-merge verification/],
  ["failed", /^AUTO: (?:builder|integration) (\S+) failed (?:after|during|— (?!.*retrying))/],
  ["quota", /^AUTO: (?:builder|integration) (\S+): quota exhausted/],
  ["blocked", /^AUTO: (\S+) blocked because dependency/],
  ["blocked", /^AUTO: builder (\S+) produced no source change; marked blocked/],
  ["timed-out", /^AUTO: builder (\S+) hit the \d+ms agent deadline/],
  ["died", /^AUTO: builder (\S+) exited \d+ after \d+ms having spent no tokens/],
  ["gate", /^AUTO: (\S+) is a `gate: after` acceptance gate/],
];

const LOG_LINE = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (AUTO: .*)$/;

/** `{ task, kind, at }` for every lane event in a runner log, in log order. */
export const laneEvents = (text) => {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = LOG_LINE.exec(raw);
    if (!line) continue;
    for (const [kind, re] of LANE_EVENTS) {
      const hit = re.exec(line[2]);
      if (hit) { out.push({ task: hit[1], kind, at: line[1] }); break; }
    }
  }
  return out;
};

const ORCHESTRATOR = /You are the Orchestrator for this epic/;
const EPIC_OF = /\/coduo-afk \w+ #(\d+)/;

/** The epic an Orchestrator's first message names, or null when it is not an Orchestrator. */
export const orchestratorEpic = (first) => {
  const text = String(first ?? "");
  return ORCHESTRATOR.test(text) ? EPIC_OF.exec(text)?.[1] ?? null : null;
};

// A one- or two-digit id ("2", "42") is everywhere in prose, so only `#42` counts for it.
export const mentions = (text, task) => {
  const id = String(task).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = String(task).length >= 3 ? new RegExp(`(?<![\\w])${id}(?![\\w])`) : new RegExp(`#${id}(?![\\w])`);
  return re.test(text);
};

/** Assistant text blocks of a transcript, `{ at, text }`, oldest first. */
export const assistantTexts = (path) => {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant" || e.isSidechain || !e.timestamp || !Array.isArray(e.message?.content)) continue;
    const text = e.message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    if (text) out.push({ at: e.timestamp, text });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
};

/** Orchestrator transcripts of a repo, by epic id: sessions in its Claude Code project folders. */
export const orchestratorTranscripts = (repo, root = transcriptsRoot()) => {
  const slug = resolve(repo).replace(/[^A-Za-z0-9]/g, "-");
  const byEpic = new Map();
  let folders;
  try { folders = readdirSync(root); } catch { return byEpic; }
  for (const name of folders) {
    if (name !== slug && !name.startsWith(`${slug}-`)) continue;
    let files;
    try { files = readdirSync(join(root, name)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(root, name, file);
      const epic = orchestratorEpic(headOf(path).first);
      if (epic) byEpic.set(epic, [...(byEpic.get(epic) ?? []), path]);
    }
  }
  return byEpic;
};

const minutes = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 6000) / 10;

/** One row per event: first mention at or after it, lag in minutes, missed when late or never. */
export const lagRows = (events, texts) => events.map((event) => {
  const hit = texts.find((t) => t.at >= event.at && mentions(t.text, event.task));
  const lagMin = hit ? minutes(event.at, hit.at) : null;
  return { ...event, mentionedAt: hit?.at ?? null, lagMin, missed: lagMin == null || lagMin > MISSED_AFTER_MIN };
});

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

/** The runs of a repo: each archived run's log, plus the live one. */
export const runsOf = (repo) => {
  const afk = join(resolve(repo), ".afk");
  const runs = [];
  let names = [];
  try { names = readdirSync(join(afk, "archive")).sort(); } catch {}
  for (const name of names) {
    const log = join(afk, "archive", name, "agent-auto.log");
    if (existsSync(log)) runs.push({ run: name, epic: /^epic-(\d+)/.exec(name)?.[1] ?? null, log });
  }
  const live = join(afk, "agent-auto.log");
  if (existsSync(live)) {
    let epic = null;
    try { epic = String(JSON.parse(readFileSync(join(afk, "state.json"), "utf8")).epic?.id ?? "") || null; } catch {}
    runs.push({ run: "live", epic, log: live });
  }
  return runs;
};

const launchRuntime = (project, epic) => {
  if (!project) return null;
  let rows = [];
  try { rows = readFileSync(measurePath(project), "utf8").split("\n"); } catch { return null; }
  let runtime = null;
  for (const line of rows) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "launch" && String(row.epicId) === epic) runtime = row.runtime ?? null;
  }
  return runtime;
};

/** The report: per run, its events with lag, and a summary. */
export const lagReport = ({ repo, epic = null, root = transcriptsRoot(), project = measureProject(resolve(repo)) }) => {
  const transcripts = orchestratorTranscripts(repo, root);
  const runs = runsOf(repo).filter((r) => (epic ? r.epic === String(epic) : true));
  return runs.map((r) => {
    const events = laneEvents(readFileSync(r.log, "utf8"));
    const files = r.epic ? transcripts.get(r.epic) ?? [] : [];
    const base = { run: r.run, epic: r.epic, runtime: r.epic ? launchRuntime(project, r.epic) : null, transcripts: files };
    if (!files.length) return { ...base, rows: null, events: events.length, mentioned: null, missed: null, medianLagMin: null };
    const texts = files.flatMap(assistantTexts).sort((a, b) => a.at.localeCompare(b.at));
    const rows = lagRows(events, texts);
    return {
      ...base,
      rows,
      events: rows.length,
      mentioned: rows.filter((x) => !x.missed).length,
      missed: rows.filter((x) => x.missed).length,
      medianLagMin: median(rows.filter((x) => x.lagMin != null).map((x) => x.lagMin)),
    };
  });
};

const hhmm = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

export const formatReport = (runs) => {
  if (!runs.length) return "orchestrator-lag: no runner log found for that project/epic.";
  const lines = [`Times are UTC. missed = not mentioned within ${MISSED_AFTER_MIN} min, or never.`];
  for (const r of runs) {
    const name = `${r.run}${r.epic ? ` (#${r.epic})` : ""}`;
    lines.push("", name);
    if (!r.epic) { lines.push(`  ${r.events} events; no epic id for this run, so no Orchestrator to match.`); continue; }
    if (!r.rows) { lines.push(`  ${r.events} events; no Orchestrator transcript found for #${r.epic}; lag not measured. runtime ${r.runtime ?? "null"}`); continue; }
    lines.push(`  ${"task".padEnd(8)} ${"kind".padEnd(10)} ${"event".padEnd(16)} ${"first mention".padEnd(16)} ${"lag".padStart(7)}`);
    for (const x of r.rows) {
      lines.push(`  ${x.task.padEnd(8)} ${x.kind.padEnd(10)} ${hhmm(x.at).padEnd(16)} ${hhmm(x.mentionedAt).padEnd(16)} ${(x.lagMin == null ? "-" : `${x.lagMin}m`).padStart(7)}${x.missed ? "  missed" : ""}`);
    }
    lines.push(`  ${name}: ${r.events} events, ${r.mentioned} mentioned within ${MISSED_AFTER_MIN} min, ${r.missed} missed, median lag ${r.medianLagMin == null ? "-" : `${r.medianLagMin}m`}, runtime ${r.runtime ?? "null"} (${r.transcripts.length} Orchestrator transcript${r.transcripts.length === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
};

if (isMainModule(import.meta.url)) {
  let parsed;
  try { parsed = parseArgv(process.argv.slice(2), ["project", "epic", "json"], { command: "orchestrator-lag" }); } catch (error) {
    console.log(`afk: ${error.message}`);
    process.exit(1);
  }
  const { project, epic, json } = parsed.flags;
  if (typeof project !== "string" || !existsSync(project)) {
    console.log("usage: afk orchestrator-lag --project=<repo-path> [--epic=<id>] [--json]");
    process.exit(1);
  }
  const report = lagReport({ repo: project, epic: typeof epic === "string" ? epic.replace(/^#/, "") : null });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}
