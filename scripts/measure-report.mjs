// scripts/measure-report.mjs — read the docs/measure rows back (#182).
//
//   afk measure dashboard           one static HTML file, docs/measure/dashboard.html,
//                                   inline SVG, no dependency, regenerated every run
//   afk measure report [--days=N]   the last N days against the N before, text or --json
//
// Both read every `<project>.jsonl` under `measureRoot()` (AFK_MEASURE_ROOT
// overrides it, as for scripts/measure.mjs, which writes the rows). One point
// per epic: the newest close row for each project and epic id.
//
// FAIL DIRECTION: OPEN. These commands report; they never gate. A corrupt line
// is skipped, a number a row cannot answer is null, and null is drawn as a gap
// and compared as "not comparable", never as zero. The exit code is 0 unless
// the command itself was mistyped.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDir, isMainModule, parseArgv } from "./lib.mjs";
import { measureRoot } from "./measure.mjs";

export const DASHBOARD_FILE = "dashboard.html";
const DAY_MS = 24 * 60 * 60 * 1000;

const sum = (values) => values.reduce((total, value) => total + value, 0);
const known = (value) => typeof value === "number" && Number.isFinite(value);

// `null` in, `null` out: a sum over parts is only known when every part is.
const allKnown = (...values) => (values.every(known) ? sum(values) : null);

/**
 * Every number the dashboard draws and the report compares, in graph order.
 * `better` says which direction is an improvement. `of(row)` reads one close
 * row and returns a number or null. Gate minutes read the close row's
 * `gateMs`, lane minutes its lanes' `durationMs`; rows written before those
 * fields existed answer null, drawn as a gap.
 */
export const NUMBERS = [
  {
    key: "timesNeeded", label: "times needed", better: "lower", graph: "needed",
    of: (row) => allKnown(row.relaunches, row.gateReleases, row.acceptances),
  },
  {
    key: "hoursParked", label: "hours parked", better: "lower", graph: "needed",
    of: (row) => {
      if (!Array.isArray(row.stops)) return null;
      const parked = row.stops.map((stop) => stop?.parkedMs);
      return parked.every(known) ? sum(parked) / 3_600_000 : null;
    },
  },
  { key: "falseReds", label: "false reds", better: "lower", graph: "reds", of: (row) => (known(row.falseReds) ? row.falseReds : null) },
  { key: "repeats", label: "repeats", better: "lower", graph: "reds", of: (row) => (known(row.repeats) ? row.repeats : null) },
  {
    key: "firstAttemptShare", label: "first-attempt pass share", better: "higher", graph: "first",
    of: (row) => {
      if (!Array.isArray(row.tasks) || !row.tasks.length) return null;
      return row.tasks.filter((task) => task?.lifecycle === "passed" && task?.builderAttempts === 1).length / row.tasks.length;
    },
  },
  {
    key: "gateMinutes", label: "gate minutes", better: "lower", graph: "minutes",
    of: (row) => (known(row.gateMs) ? row.gateMs / 60_000 : null),
  },
  {
    key: "laneMinutes", label: "lane minutes", better: "lower", graph: "minutes",
    of: (row) => {
      if (!Array.isArray(row.lanes)) return null;
      const durations = row.lanes.map((lane) => lane?.durationMs);
      return durations.every(known) ? sum(durations) / 60_000 : null;
    },
  },
  { key: "mustFixFound", label: "must-fix found", better: "lower", graph: "mustFix", of: (row) => (known(row.closeout?.found) ? row.closeout.found : null) },
  {
    // Cleared is fixed plus dropped: everything that no longer stands open.
    key: "mustFixCleared", label: "must-fix cleared", better: "higher", graph: "mustFix",
    of: (row) => allKnown(row.closeout?.fixed, row.closeout?.dropped),
  },
  {
    key: "costUnitsPerLane", label: "cost units per lane", better: "lower", graph: "cost",
    of: (row) => {
      if (!Array.isArray(row.lanes)) return null;
      const costs = row.lanes.map((lane) => lane?.efficiency?.costUnits).filter(known);
      return costs.length ? sum(costs) / costs.length : null;
    },
  },
];

export const GRAPHS = [
  { id: "needed", title: "Times needed and hours parked" },
  { id: "reds", title: "False reds and repeats per epic" },
  { id: "first", title: "Share of tasks that passed on the first builder attempt" },
  { id: "minutes", title: "Gate minutes against lane minutes" },
  { id: "mustFix", title: "Must-fix found against cleared" },
  { id: "cost", title: "Cost units per lane" },
];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Every row in every `<project>.jsonl` under `root`. A corrupt line is skipped. */
export const readRows = (root = measureRoot()) => {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith(".jsonl")).sort().flatMap((name) =>
    readFileSync(resolve(root, name), "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const row = JSON.parse(line);
        return row && typeof row === "object" ? [row] : [];
      } catch {
        return [];
      }
    }));
};

/**
 * One entry per epic: its newest close row, read into the numbers above.
 * Sorted by close time. A close row with no parseable `at` is dropped — it
 * cannot sit on a time axis or in a window.
 */
export const epicPoints = (rows, { project = null } = {}) => {
  const latest = new Map();
  for (const row of rows) {
    if (row?.type !== "close" || !Number.isFinite(Date.parse(row.at))) continue;
    if (project && row.project !== project) continue;
    const key = `${row.project}\u0000${row.epicId}`;
    const prior = latest.get(key);
    if (!prior || Date.parse(row.at) >= Date.parse(prior.at)) latest.set(key, row);
  }
  return [...latest.values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((row) => ({
      project: row.project ?? null,
      epicId: row.epicId ?? null,
      at: row.at,
      values: Object.fromEntries(NUMBERS.map((number) => [number.key, number.of(row)])),
    }));
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const mean = (values) => (values.length ? sum(values) / values.length : null);
const round = (value) => (value == null ? null : Math.round(value * 1000) / 1000);

const directionOf = (number, previous, current) => {
  if (!known(previous) || !known(current)) return "not comparable";
  if (current === previous) return "unchanged";
  return (current < previous) === (number.better === "lower") ? "improvement" : "degradation";
};

/**
 * The last `days` days, (now - days, now], against the `days` before them.
 * A window's value for a number is the mean over its epics that have one.
 * A window with no epics compares nothing: every change is null and `note`
 * says which window was empty.
 */
export const buildReport = (rows, { days = 7, now = Date.now(), project = null } = {}) => {
  const points = epicPoints(rows, { project });
  const end = now;
  const middle = now - days * DAY_MS;
  const start = now - 2 * days * DAY_MS;
  const inWindow = (from, to) => points.filter((point) => Date.parse(point.at) > from && Date.parse(point.at) <= to);
  const current = inWindow(middle, end);
  const previous = inWindow(start, middle);
  const empty = [previous.length ? null : "earlier", current.length ? null : "latest"].filter(Boolean);
  const comparable = empty.length === 0;
  const valueOf = (points, number) => round(mean(points.map((point) => point.values[number.key]).filter(known)));
  return {
    days,
    project,
    windows: {
      previous: { from: new Date(start).toISOString(), to: new Date(middle).toISOString(), epics: previous.map((point) => point.epicId) },
      current: { from: new Date(middle).toISOString(), to: new Date(end).toISOString(), epics: current.map((point) => point.epicId) },
    },
    comparable,
    note: comparable ? null : `the ${empty.join(" and ")} window has no close rows, so there is nothing to compare`,
    numbers: NUMBERS.map((number) => {
      const before = valueOf(previous, number);
      const after = valueOf(current, number);
      return {
        key: number.key,
        label: number.label,
        better: number.better,
        previous: before,
        current: after,
        change: comparable && known(before) && known(after) ? round(after - before) : null,
        direction: comparable ? directionOf(number, before, after) : "not comparable",
        ...(number.missing ? { missing: number.missing } : {}),
      };
    }),
  };
};

const show = (value) => (value == null ? "—" : String(value));
const signed = (value) => (value == null ? "—" : value > 0 ? `+${value}` : String(value));

export const formatReport = (report) => {
  const { windows } = report;
  const lines = [
    `afk measure report: last ${report.days} day(s) against the ${report.days} before${report.project ? `, project ${report.project}` : ""}`,
    `  earlier: ${windows.previous.from.slice(0, 10)} to ${windows.previous.to.slice(0, 10)}, ${windows.previous.epics.length} epic(s)${windows.previous.epics.length ? ` (#${windows.previous.epics.join(", #")})` : ""}`,
    `  latest:  ${windows.current.from.slice(0, 10)} to ${windows.current.to.slice(0, 10)}, ${windows.current.epics.length} epic(s)${windows.current.epics.length ? ` (#${windows.current.epics.join(", #")})` : ""}`,
  ];
  if (!report.comparable) {
    lines.push("", `Nothing to compare: ${report.note}.`);
    return lines.join("\n");
  }
  const rows = report.numbers.map((number) => [
    number.label, `${number.better} is better`, show(number.previous), show(number.current), signed(number.change),
    number.missing ? `not in the rows: ${number.missing}` : number.direction,
  ]);
  const header = ["number", "better", "earlier", "latest", "change", "verdict"];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const pad = (cells) => `  ${cells.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`.trimEnd();
  lines.push("", pad(header), ...rows.map(pad));
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const COLORS = ["#2563eb", "#dc2626"];
const DASHES = ["", "6 4", "2 3", "10 3 2 3"];
const WIDTH = 720;
const HEIGHT = 220;
const PAD = { left: 48, right: 16, top: 16, bottom: 40 };

const formatValue = (value) => (Math.abs(value) >= 100 ? Math.round(value).toLocaleString("en-US") : String(round(value)));

/**
 * One graph as inline SVG. X is close time, Y is shared by the graph's
 * numbers. Each project draws its own series (a `<g data-project>`, which the
 * filter hides), each number its own colour. A null value has no point, and
 * the line breaks there: a gap, never a zero.
 */
const graphSvg = (graph, points, projects) => {
  const numbers = NUMBERS.filter((number) => number.graph === graph.id);
  const values = points.flatMap((point) => numbers.map((number) => point.values[number.key])).filter(known);
  const times = points.map((point) => Date.parse(point.at));
  const [tMin, tMax] = [Math.min(...times), Math.max(...times)];
  const yMax = Math.max(1, ...values);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (at) => PAD.left + (tMax === tMin ? plotW / 2 : ((Date.parse(at) - tMin) / (tMax - tMin)) * plotW);
  const y = (value) => PAD.top + plotH - (value / yMax) * plotH;
  const parts = [
    `<svg id="graph-${graph.id}" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeHtml(graph.title)}">`,
    `<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${WIDTH - PAD.right}" y2="${PAD.top + plotH}" stroke="#999"/>`,
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + plotH}" stroke="#999"/>`,
    `<text x="${PAD.left - 6}" y="${PAD.top + 4}" text-anchor="end" font-size="11">${formatValue(yMax)}</text>`,
    `<text x="${PAD.left - 6}" y="${PAD.top + plotH}" text-anchor="end" font-size="11">0</text>`,
  ];
  if (!values.length) {
    const why = numbers.map((number) => number.missing).filter(Boolean);
    parts.push(`<text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" font-size="13" fill="#666">${escapeHtml(why.length ? `Not in the rows: ${why.join("; ")}.` : "No values yet.")}</text>`);
  }
  projects.forEach((project, projectIndex) => {
    const mine = points.filter((point) => point.project === project);
    parts.push(`<g data-project="${escapeHtml(project)}">`);
    for (const point of mine) {
      parts.push(`<text x="${x(point.at)}" y="${HEIGHT - 22}" text-anchor="middle" font-size="10">#${escapeHtml(point.epicId)}</text>`);
    }
    numbers.forEach((number, numberIndex) => {
      // Split the series at every null so the line has a gap where the value
      // is unknown, and draw a point only where it is known.
      const runs = [[]];
      for (const point of mine) {
        const value = point.values[number.key];
        if (known(value)) runs.at(-1).push(`${x(point.at).toFixed(1)},${y(value).toFixed(1)}`);
        else if (runs.at(-1).length) runs.push([]);
      }
      const style = `stroke="${COLORS[numberIndex % COLORS.length]}" stroke-dasharray="${DASHES[projectIndex % DASHES.length]}"`;
      for (const run of runs.filter((run) => run.length > 1)) {
        parts.push(`<polyline fill="none" stroke-width="2" ${style} points="${run.join(" ")}"/>`);
      }
      for (const point of mine.filter((point) => known(point.values[number.key]))) {
        const value = point.values[number.key];
        parts.push(`<circle cx="${x(point.at).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3.5" fill="${COLORS[numberIndex % COLORS.length]}"><title>${escapeHtml(`${project} #${point.epicId} ${point.at.slice(0, 10)}: ${number.label} ${formatValue(value)}`)}</title></circle>`);
      }
    });
    parts.push("</g>");
  });
  numbers.forEach((number, index) => {
    parts.push(`<text x="${PAD.left + index * 220}" y="${HEIGHT - 6}" font-size="11" fill="${COLORS[index % COLORS.length]}">● ${escapeHtml(number.label)} (${number.better} is better)</text>`);
  });
  parts.push("</svg>");
  return parts.join("\n");
};

export const buildDashboard = (rows, { generatedAt = new Date().toISOString() } = {}) => {
  const points = epicPoints(rows);
  const projects = [...new Set(points.map((point) => point.project))].sort();
  const options = [`<option value="">all projects</option>`, ...projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)];
  const sections = GRAPHS.map((graph) => `<section>\n<h2>${escapeHtml(graph.title)}</h2>\n${graphSvg(graph, points, projects)}\n</section>`);
  const epics = points.map((point) => `<li data-project="${escapeHtml(point.project)}">${escapeHtml(point.project)} #${escapeHtml(point.epicId)}, closed ${escapeHtml(point.at.slice(0, 10))}</li>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AFK measure dashboard</title>
<!-- Generated by \`afk measure dashboard\` from docs/measure/*.jsonl. Do not edit: the next run overwrites it. -->
<style>
body { font: 14px system-ui, sans-serif; margin: 24px; color: #222; }
h1 { font-size: 20px; } h2 { font-size: 15px; margin: 24px 0 6px; }
.meta { color: #666; } svg { background: #fafafa; border: 1px solid #e5e5e5; }
</style>
</head>
<body>
<h1>AFK measure dashboard</h1>
<p class="meta">One point per epic, by close time. A missing value is a gap, not zero. Generated ${escapeHtml(generatedAt)} from ${points.length} epic(s).</p>
<label>Project <select id="project">${options.join("")}</select></label>
${sections.join("\n")}
<h2>Epics</h2>
<ul>
${epics.join("\n")}
</ul>
<script>
document.getElementById("project").addEventListener("change", (event) => {
  for (const node of document.querySelectorAll("[data-project]")) {
    node.style.display = !event.target.value || node.dataset.project === event.target.value ? "" : "none";
  }
});
</script>
</body>
</html>
`;
};

export const writeDashboard = (root = measureRoot()) => {
  ensureDir(root);
  const path = resolve(root, DASHBOARD_FILE);
  writeFileSync(path, buildDashboard(readRows(root)));
  return path;
};

// ---------------------------------------------------------------------------
// CLI: `afk measure dashboard` | `afk measure report [--days=N] [--json]`
// ---------------------------------------------------------------------------

const USAGE = "usage: afk measure dashboard | afk measure report [--days=N] [--json] [--project=<name>]";

export const cli = (argv = process.argv.slice(2)) => {
  const { flags, positional } = parseArgv(argv, ["days", "json", "project"], { command: "measure" });
  const [verb] = positional;
  if (verb === "dashboard") {
    const root = measureRoot();
    const path = writeDashboard(root);
    console.log(`MEASURE: dashboard of ${epicPoints(readRows(root)).length} epic(s) written to ${path}`);
    return 0;
  }
  if (verb === "report") {
    const days = flags.days === undefined ? 7 : Number(flags.days);
    if (!Number.isInteger(days) || days < 1) {
      console.log(`MEASURE: --days takes a whole number of days of 1 or more, not "${flags.days}".`);
      return 1;
    }
    const report = buildReport(readRows(), { days, project: typeof flags.project === "string" ? flags.project : null });
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  }
  console.log(USAGE);
  return 1;
};

if (isMainModule(import.meta.url)) process.exitCode = cli();
