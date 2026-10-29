// scripts/hub/plan.mjs — "Tonight's plan" on the hub: the chief of staff's
// planned rows beside what each epic really did, as one Gantt chart.
//
// The plan is a `plan` event in the open run (`afk cos plan --file=`); the
// newest one wins. Actuals come from each epic checkout's `.afk/agent-auto.log`
// (the Runner's own lines, read only), limited to lines written since the run
// opened, because the log is append-only across nights. The Runner is not
// changed: state.json's tasks carry no timestamps, so the log is the record.
//
// Plan schema (validatePlan refuses anything else, unknown keys included):
//   { "epics": [ { "epic": "143", "project"?: "riverbend", "label": "...",
//       "launch": "<ISO time with zone>", "caption"?: "...",
//       "phases": [ { "kind": "build|gate-human|baseline|closeout|parked",
//         "start": "<ISO time with zone>", "minutes": <n>,
//         "label"?: "...", "caption"?: "..." } ] } ] }
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PHASE_KINDS = ["build", "gate-human", "baseline", "closeout", "parked"];
const EPIC_KEYS = new Set(["epic", "project", "label", "launch", "caption", "phases"]);
const PHASE_KEYS = new Set(["kind", "start", "minutes", "label", "caption"]);
// A zone is required: "00:32" alone does not say which night.
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_MINUTES = 24 * 60;

const text = (value) => typeof value === "string" && value.trim() !== "";
const optionalText = (value) => value === undefined || typeof value === "string";

/** `{ plan, errors }`: the plan normalised (epic ids as strings), or every problem found. */
export const validatePlan = (raw) => {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { plan: null, errors: ["the plan must be an object with an epics array"] };
  for (const key of Object.keys(raw)) if (key !== "epics") errors.push(`unknown top-level key ${key}`);
  if (!Array.isArray(raw.epics) || raw.epics.length === 0) return { plan: null, errors: [...errors, "epics must be a non-empty array"] };
  const seen = new Set();
  const epics = raw.epics.map((row, i) => {
    const at = `epics[${i}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) { errors.push(`${at} must be an object`); return null; }
    for (const key of Object.keys(row)) if (!EPIC_KEYS.has(key)) errors.push(`${at} has unknown key ${key}`);
    const epic = typeof row.epic === "number" ? String(row.epic) : row.epic;
    if (!text(epic)) errors.push(`${at}.epic must be the epic number`);
    else if (seen.has(epic)) errors.push(`${at}.epic ${epic} is planned twice`);
    else seen.add(epic);
    if (!text(row.label)) errors.push(`${at}.label must be a non-empty string`);
    if (!(typeof row.launch === "string" && ISO_ZONED.test(row.launch) && Number.isFinite(Date.parse(row.launch)))) errors.push(`${at}.launch must be an ISO time with a zone, e.g. 2026-10-16T00:32+05:30`);
    if (!optionalText(row.project)) errors.push(`${at}.project must be a string`);
    if (!optionalText(row.caption)) errors.push(`${at}.caption must be a string`);
    if (!Array.isArray(row.phases)) { errors.push(`${at}.phases must be an array`); return null; }
    const phases = row.phases.map((phase, j) => {
      const pat = `${at}.phases[${j}]`;
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) { errors.push(`${pat} must be an object`); return null; }
      for (const key of Object.keys(phase)) if (!PHASE_KEYS.has(key)) errors.push(`${pat} has unknown key ${key}`);
      if (!PHASE_KINDS.includes(phase.kind)) errors.push(`${pat}.kind must be one of ${PHASE_KINDS.join(", ")}`);
      if (!(typeof phase.start === "string" && ISO_ZONED.test(phase.start) && Number.isFinite(Date.parse(phase.start)))) errors.push(`${pat}.start must be an ISO time with a zone`);
      if (!(typeof phase.minutes === "number" && phase.minutes > 0 && phase.minutes <= MAX_MINUTES)) errors.push(`${pat}.minutes must be a positive number of minutes, at most ${MAX_MINUTES}`);
      if (!optionalText(phase.label)) errors.push(`${pat}.label must be a string`);
      if (!optionalText(phase.caption)) errors.push(`${pat}.caption must be a string`);
      return { ...phase };
    });
    return { ...row, epic, phases };
  });
  return errors.length ? { plan: null, errors } : { plan: { epics }, errors: [] };
};

/**
 * The newest stored plan that still passes `validatePlan`, as `{ ts, epics }`,
 * or null. The store checks only `ts` and `kind`, so a hand-edited or
 * truncated `plan` line is skipped here rather than thrown on while drawing.
 */
export const latestPlan = (events) => {
  for (const event of events.filter((e) => e.kind === "plan").reverse()) {
    const { plan } = validatePlan({ epics: event.epics });
    if (plan) return { ts: event.ts, epics: plan.epics };
  }
  return null;
};

// The Runner's lines this chart reads (scripts/auto.mjs). Every other line is
// ignored: retries keep a task's bar open from its first start, and an
// integration's own re-check stays inside the task's build-to-merge span.
const LINE = /^\[([^\]]+)\] AUTO: (.*)$/;
// The launch line: auto.mjs prints it on every start, right before the
// baseline gate. A log with none in the window was adopted mid-epic. A run
// whose dashboard failed to start prints the warning in its place (#277).
const LAUNCH = /^(dashboard (started|ready) at |warning: the dashboard did not start; carrying on without it)/;
// "baseline check skipped —" is the whole gate; "baseline check skipped:" is
// one command inside a running baseline and closes nothing.
const BASELINE_CLOSE = /^(continuous scheduler started|baseline check skipped —|baseline check failed before scheduling)/;
const GATE_OPEN = /^(\S+) is a `gate: after` acceptance gate/;
const GATE_CLOSE = /^gate (\S+) accepted/;
const BUILD_OPEN = /^builder (\S+) attempt \d+ started/;
const MERGED = /^(\S+) integrated and passed post-merge verification/;
const PARKED = [
  /^builder (\S+) failed after/,
  /^builder (\S+) produced no source change/,
  /^builder (\S+) WROTE OUTSIDE ITS LANE/,
  /^builder (\S+) had .* reverted/,
  /^integration (\S+) failed after/,
  /^integration (\S+) failed.*(a timed-out check is not retried|again after it re-ran)/,
  /^integration (\S+) exceeded the 12h rate-limit wait cap/,
];
const CLOSEOUT_OPEN = /^(the epic stopped with |every task passed and every gate is accepted)/;
const CLOSEOUT_CLOSE = /^epic closed — /;
// The cap the scheduler runs under, printed on every start (auto.mjs).
const SCHEDULER = /^continuous scheduler started \(maxParallel=(\d+)/;

/**
 * What one epic did since `since`: `{ launch, bars, maxParallel, error? }`.
 * `launch` is the first launch line in the window (null when the run was
 * adopted mid-epic); each bar is `{ kind, label, start, end, open }` in ISO
 * time, `open` bars ending at `now`. `maxParallel` is the cap on the newest
 * scheduler start in the whole log, before the window too (null when none):
 * a run adopted mid-epic still runs under it. An unreadable log gives no bars
 * and `error`, its code.
 */
export const readActuals = ({ root, since, now }) => {
  const path = join(root, ".afk", "agent-auto.log");
  if (!existsSync(path)) return { launch: null, bars: [], maxParallel: null };
  let log;
  try { log = readFileSync(path, "utf8"); } catch (error) { return { launch: null, bars: [], maxParallel: null, error: error.code ?? error.message }; }
  const bars = [];
  const open = new Map(); // key -> bar
  const begin = (key, kind, label, ts) => {
    if (open.has(key)) return;
    const bar = { kind, label, start: ts, end: null, open: true };
    open.set(key, bar);
    bars.push(bar);
  };
  const finish = (key, ts, kind) => {
    const bar = open.get(key);
    if (!bar) return;
    bar.end = ts;
    bar.open = false;
    if (kind) bar.kind = kind;
    open.delete(key);
  };
  let launch = null;
  let maxParallel = null;
  for (const line of log.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, ts, said] = match;
    let m;
    if ((m = SCHEDULER.exec(said))) maxParallel = Number(m[1]);
    const at = Date.parse(ts);
    if (!Number.isFinite(at) || at < since) continue;
    if (LAUNCH.test(said)) { launch ??= ts; begin("baseline", "baseline", "baseline", ts); }
    else if (BASELINE_CLOSE.test(said)) finish("baseline", ts);
    else if ((m = GATE_OPEN.exec(said))) begin(`gate:${m[1]}`, "gate-human", m[1], ts);
    else if ((m = GATE_CLOSE.exec(said))) finish(`gate:${m[1]}`, ts);
    else if ((m = BUILD_OPEN.exec(said))) begin(`task:${m[1]}`, "build", m[1], ts);
    else if ((m = MERGED.exec(said))) finish(`task:${m[1]}`, ts);
    else if (CLOSEOUT_OPEN.test(said)) begin("closeout", "closeout", "closeout", ts);
    else if (CLOSEOUT_CLOSE.test(said)) finish("closeout", ts);
    else {
      const parked = PARKED.map((re) => re.exec(said)).find(Boolean);
      if (parked) finish(`task:${parked[1]}`, ts, "parked");
    }
  }
  const end = new Date(now).toISOString();
  for (const bar of bars) if (bar.open) bar.end = end;
  return { launch, maxParallel, bars: bars.map((bar, i) => ({ ...bar, i })).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.i - b.i).map(({ i, ...bar }) => bar) };
};

// The machine's offset, read from Date, which follows TZ; Intl caches its zone.
const zoneOf = (ms) => {
  const offset = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(offset);
  return `UTC${offset < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

/**
 * The chart's data for the open run: null when no plan is stored. `runs` is
 * the hub's run list (`listRuns`); an epic's checkout is the run whose epic
 * id (and project, when the plan names one) matches.
 */
export const planChart = (args) => {
  try { return buildChart(args); } catch (error) { return { error: error.message }; }
};

const buildChart = ({ cos, runs, now }) => {
  const stored = cos ? latestPlan(cos.events) : null;
  if (!stored) return null;
  const since = Date.parse(cos.meta?.startedAt ?? "") || Date.parse(stored.ts);
  const rows = stored.epics.map((row) => {
    const run = runs.find((candidate) => String(candidate.epic) === String(row.epic) && (!row.project || candidate.project === row.project));
    const actual = run?.root ? readActuals({ root: run.root, since, now }) : null;
    return {
      ...row,
      planned: row.phases.map((phase) => ({
        kind: phase.kind,
        label: phase.label ?? phase.kind,
        caption: phase.caption ?? null,
        start: new Date(Date.parse(phase.start)).toISOString(),
        end: new Date(Date.parse(phase.start) + phase.minutes * 60_000).toISOString(),
      })),
      runId: run?.id ?? null,
      actual,
    };
  });
  const times = [now];
  for (const row of rows) {
    times.push(Date.parse(row.launch));
    for (const bar of [...row.planned, ...(row.actual?.bars ?? [])]) times.push(Date.parse(bar.start), Date.parse(bar.end));
  }
  const first = new Date(Math.min(...times));
  first.setMinutes(0, 0, 0);
  const lastMs = Math.max(...times);
  const last = new Date(lastMs);
  last.setMinutes(0, 0, 0);
  if (last.getTime() < lastMs) last.setHours(last.getHours() + 1);
  const hours = Math.max(1, Math.round((last.getTime() - first.getTime()) / 3_600_000));
  return { planTs: stored.ts, from: first.getTime(), hours, now, rows, zone: zoneOf(now) };
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const round = (n) => Math.round(n * 100) / 100;

// Greedy tracks: each bar goes in the first track whose last bar has ended.
const pack = (bars) => {
  const ends = [];
  return bars.map((bar) => {
    const start = Date.parse(bar.start);
    let track = ends.findIndex((end) => end <= start);
    if (track === -1) track = ends.length;
    ends[track] = Date.parse(bar.end);
    return { ...bar, track };
  });
};

const KIND_WORD = { build: "build and merge", "gate-human": "waits for a person", baseline: "baseline gate", closeout: "closeout", parked: "parked" };

const sectionOpen = (cosId) => `
  <section class="hub-sec night-plan" data-run="${esc(cosId)}" data-field="night-plan">
    <h2>Tonight's plan</h2>`;

/**
 * The section's HTML, or "" when there is no chart. A chart that failed to
 * build, or throws while drawn, is one line; the rest of the page still renders.
 */
export const renderPlan = (chart, cosId) => {
  if (!chart) return "";
  const unavailable = (reason) => `${sectionOpen(cosId)}
    <p class="gx-none">plan unavailable: ${esc(reason)}</p>
  </section>`;
  if (chart.error) return unavailable(chart.error);
  try { return drawPlan(chart, cosId); } catch (error) { return unavailable(error.message); }
};

const drawPlan = (chart, cosId) => {
  const span = chart.hours * 3_600_000;
  const pct = (ms) => round(Math.min(100, Math.max(0, ((ms - chart.from) / span) * 100)));
  const nowLine = `<span class="gx-now" style="left:${pct(chart.now)}%" title="now ${hhmm(chart.now)}"></span>`;
  const bar = (b, cls) => {
    const left = pct(Date.parse(b.start));
    const width = Math.max(0.4, round(pct(Date.parse(b.end)) - left));
    const label = b.kind === "gate-human" ? `✋ ${b.label}` : b.label;
    const title = `${label}: ${KIND_WORD[b.kind]}, ${hhmm(Date.parse(b.start))}–${b.open ? "now" : hhmm(Date.parse(b.end))}`;
    return `<span class="gx-bar ${cls} k-${esc(b.kind)}${b.open ? " gx-open" : ""}" style="left:${left}%;width:${width}%;--track:${b.track}" title="${esc(title)}">${esc(label)}</span>`;
  };
  const lane = (bars, cls) => {
    const packed = pack(bars);
    const tracks = Math.max(1, ...packed.map((b) => b.track + 1));
    return `<div class="gx-lane" style="--tracks:${tracks}">${packed.map((b) => bar(b, cls)).join("")}</div>`;
  };
  const hours = Array.from({ length: chart.hours + 1 }, (_, h) => chart.from + h * 3_600_000);
  const rows = chart.rows.map((row) => {
    const launched = row.actual?.launch ? hhmm(Date.parse(row.actual.launch)) : null;
    const captions = row.planned.filter((p) => p.caption)
      .map((p) => `<span class="gx-cap" style="margin-left:${pct(Date.parse(p.start))}%">${esc(p.caption)}</span>`);
    return `
    <div class="gx-row" data-run="${esc(cosId)}" data-field="plan:${esc(row.epic)}">
      <div class="gx-name"><b>#${esc(row.epic)}</b> ${esc(row.label)}<small>planned ${hhmm(Date.parse(row.launch))} · ${launched ? `launched ${launched}` : row.actual ? "adopted" : "not launched"}</small></div>
      <div class="gx-time">
        <span class="gx-launch" style="left:${pct(Date.parse(row.launch))}%" title="planned launch ${hhmm(Date.parse(row.launch))}"></span>
        ${lane(row.planned, "gx-plan")}
        ${captions.join("")}${row.caption ? `<span class="gx-cap">${esc(row.caption)}</span>` : ""}
        ${row.actual?.bars.length ? lane(row.actual.bars, "gx-actual") : `<span class="gx-none">${row.actual?.error ? `log unreadable (${esc(row.actual.error)})` : row.runId ? "nothing logged since the run opened" : "not launched"}</span>`}
        ${nowLine}
      </div>
    </div><!-- /row -->`;
  }).join("");
  return `${sectionOpen(cosId)}
    <p class="ve-label">Local time (${esc(chart.zone)}). Hatched bars are the plan, stored ${esc(hhmm(Date.parse(chart.planTs)))}; solid bars are what happened, from each epic's <code>.afk/agent-auto.log</code>. ✋ waits for a person, grey is a baseline gate, red is parked.</p>
    <div class="gx" style="--hours:${chart.hours}">
      <div class="gx-row gx-axis"><div class="gx-name"></div><div class="gx-time">${hours.map((ms) => `<span class="gx-hour" style="left:${pct(ms)}%">${hhmm(ms)}</span>`).join("")}<span class="gx-now-label" style="left:${pct(chart.now)}%">now</span></div></div>${rows}
    </div>
  </section>`;
};
