// scripts/measure.mjs — a durable record of every epic, in docs/measure (#181).
//
// Three public jobs, and the runner's call sites hold no logic of their own:
//
//   recordGate      one structured event per gate run, appended to
//                   `.afk/runs/gate-events.jsonl` when the gate finishes
//   appendLaunchRow one `type: "launch"` row per start and relaunch
//   appendCloseRow  one `type: "close"` row, computed from files on disk only
//
// Rows live in ONE JSON-lines file per project, in one container — the
// reflection layout (scripts/reflect.mjs), for the same reason:
//
//   <runner>/docs/measure/<project>.jsonl
//
// `AFK_MEASURE_ROOT` overrides the root, as `AFK_REFLECTIONS_ROOT` does for
// reflections; the tests depend on it. The runner appends and never commits.
//
// Gate events sit under `.afk/runs/` because that directory is already one of
// the things `afk archive` moves (archive.mjs `ARCHIVED`): the events travel
// with the run they describe, and nothing about what is archived changes.
//
// FAIL DIRECTION: OPEN, everywhere. A measurement is never worth a run. A
// failed write, a missing input or a corrupt one is logged and the caller
// carries on; a field that cannot be computed is `null`, never a guess.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import {
  ensureDir, isMainModule, normalizeId, parseArgv, run, runnerRoot,
} from "./lib.mjs";
import { depthsOf } from "./dashboard-data.mjs";
import { buildForecast, declaredGates } from "./forecast.mjs";

export const MEASURE_SCHEMA = 1;

export const measureRoot = () => (process.env.AFK_MEASURE_ROOT
  ? resolve(process.env.AFK_MEASURE_ROOT)
  : resolve(runnerRoot, "docs", "measure"));

export const measurePath = (project) => resolve(measureRoot(), `${project}.jsonl`);

export const gateEventsPath = (afkDir) => resolve(afkDir, "runs", "gate-events.jsonl");

// Appended (one JSON line per close) beside the gate events once a close row
// is written, so `afk
// archive` and the wave driver do not append a second row for a close the
// runner already recorded.
const closeMarkerPath = (afkDir) => resolve(afkDir, "runs", "measure-close.json");

/**
 * The project name, from the GitHub `origin` URL, or null.
 *
 * Local git only — `projectName` in reflect.mjs asks `gh`, which is a network
 * call, and the close row is computed without one. A checkout with no GitHub
 * remote cannot have run an epic, and a test fixture never has one: null, so
 * no test can write into the real docs/measure by accident.
 */
export const measureProject = (root) => {
  const url = run("git remote get-url origin", { cwd: root });
  if (url.status !== 0) return null;
  const match = /github\.com[:/][^/]+\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.stdout.trim());
  return match?.[1] ?? null;
};

const say0 = (message) => console.log(message);

/** A JSON file, or null when it is missing or unparseable. */
const readJson = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * A JSON-lines file as rows, or null when it is missing or ANY line is
 * corrupt. A partial event log would undercount silently; null says so.
 */
const readJsonl = (path) => {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
};

const appendRow = (path, row) => {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(row)}\n`);
};

const shas = (root) => {
  const result = run("git rev-parse HEAD HEAD^{tree}", { cwd: root });
  const [head = null, tree = null] = result.status === 0 ? result.stdout.trim().split("\n") : [];
  return { headSha: head, treeSha: tree };
};

const commandRecord = (check) => ({
  command: check.command,
  startedAt: check.startedAt ?? null,
  durationMs: check.durationMs ?? null,
  code: check.code ?? null,
});

// ---------------------------------------------------------------------------
// Gate events
// ---------------------------------------------------------------------------

/**
 * Record one gate run. Two shapes, one function, so each gate path holds one
 * call:
 *
 *   recordGate(meta, () => runChecks(...))  wraps a chain runner (baseline,
 *       closeout fix gate) and returns its outcome untouched. The load average
 *       is read here, before the chain starts. A runner that throws still
 *       throws: measuring must not change what a gate does.
 *   recordGate({ ..., checks, checkReruns })  records checks that already ran
 *       (integration). Each check carries its own start load from `runAsync`.
 *       A re-run of a single failed command (#176) is its own event, kind
 *       `recheck`, and the integration event keeps that command's FIRST run.
 *
 * Never throws for its own reasons; a failed write is logged.
 */
export const recordGate = async (meta, runner = null) => {
  const startLoad = loadavg()[0];
  const outcome = runner ? await runner() : null;
  try {
    const { root, kind, taskId = null, say = say0 } = meta;
    const afkDir = resolve(root, ".afk");
    const path = gateEventsPath(afkDir);
    const prior = readJsonl(path) ?? [];
    const attempt = meta.attempt ?? prior.filter((event) => event.kind === kind).length + 1;
    const at = new Date().toISOString();
    // (#178) Seconds this gate waited for the machine-wide gate lock; null
    // when the caller did not say. Only on the gate's own event, never on a
    // recheck row, so a sum over events counts each wait once.
    const lockWaitS = meta.lockWaitS ?? null;
    const base = { schema: MEASURE_SCHEMA, taskId: taskId == null ? null : String(taskId), attempt, at, ...shas(root) };
    const events = [];
    if (runner) {
      const ran = Array.isArray(outcome?.ran) ? outcome.ran.map(commandRecord) : null;
      const skipped = Array.isArray(outcome?.skipped) ? outcome.skipped.map((check) => check.command) : [];
      events.push({
        ...base, kind, load1: startLoad, lockWaitS,
        declared: meta.commands ?? ran?.map((check) => check.command) ?? null,
        commands: ran,
        ...(skipped.length ? { skipped } : {}),
      });
    } else {
      const reruns = new Map((meta.checkReruns ?? []).map((rerun) => [rerun.command, rerun]));
      const firstRun = (check) => {
        const rerun = reruns.get(check.command);
        return rerun
          ? { command: check.command, startedAt: rerun.firstStartedAt ?? null, durationMs: rerun.firstDurationMs ?? null, code: rerun.firstCode ?? null }
          : commandRecord(check);
      };
      const checks = meta.checks ?? [];
      const firstLoad = checks[0] && reruns.has(checks[0].command)
        ? reruns.get(checks[0].command).firstLoad1 ?? null
        : checks[0]?.load1 ?? null;
      events.push({
        ...base, kind, load1: firstLoad, lockWaitS,
        declared: meta.commands ?? checks.map((check) => check.command),
        commands: checks.map(firstRun),
      });
      for (const check of checks.filter((entry) => reruns.has(entry.command))) {
        events.push({
          ...base, kind: "recheck", load1: check.load1 ?? null,
          declared: [check.command],
          commands: [commandRecord(check)],
        });
      }
    }
    ensureDir(dirname(path));
    appendFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  } catch (error) {
    (meta?.say ?? say0)(`MEASURE: could not record the ${meta?.kind ?? "gate"} event (${error.message}); the gate itself is unaffected.`);
  }
  return outcome;
};

// ---------------------------------------------------------------------------
// Builder routing numbers (#292)
// ---------------------------------------------------------------------------

const ratio = (part, whole) => (whole ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * Two numbers off the per-attempt record `auto.mjs` keeps in
 * `state.tasks[id].builderRuns`: the share of finished builder attempts that
 * ran on a Claude Opus model, and the share of tasks whose first builder
 * attempt passed its lane checks. Null when there is nothing to divide, and the
 * Opus share is null when any finished attempt's model is unknown: an unknown
 * model is not "not Opus".
 */
export const builderMeasures = (state) => {
  const tasks = Object.values(state?.tasks ?? {});
  const finished = tasks.flatMap((task) => task.builderRuns ?? []).filter((attempt) => attempt.outcome);
  const tried = tasks.filter((task) => (task.builderRuns ?? []).some((attempt) => attempt.attempt === 1 && attempt.outcome));
  const passedFirst = tried.filter((task) => task.builderRuns.some((attempt) => attempt.attempt === 1 && attempt.outcome === "ready_to_integrate"));
  return {
    builderOpusShare: finished.some((attempt) => !attempt.model)
      ? null
      : ratio(finished.filter((attempt) => /^claude-opus-/i.test(attempt.model)).length, finished.length),
    firstAttemptPassRate: ratio(passedFirst.length, tried.length),
  };
};

// ---------------------------------------------------------------------------
// Launch row
// ---------------------------------------------------------------------------

// `forecast` is the stop forecast `afk epic` computed with the epic's `stops:`
// answers. A caller without one (the `--dag=` path) gets it computed from the
// DAG, which has the gates but no answers.
export const buildLaunchRow = ({ project, dag, config = {}, baseSha = null, at = new Date().toISOString(), release = null, forecast = null, state = null }) => {
  const tasks = (dag?.tasks ?? []).map((task) => ({ ...task, id: String(task.id) }));
  const depths = depthsOf(tasks);
  return {
    schema: MEASURE_SCHEMA,
    type: "launch",
    project,
    epicId: normalizeId(dag?.epic?.id ?? null),
    at,
    baseSha,
    // `gate: before` holds the task itself and everything behind it; `gate:
    // after` lets the task run and holds what depends on it, and the close.
    // Computed in scripts/forecast.mjs, the one place that says what a gate blocks.
    humanGates: declaredGates({ tasks }),
    dagDepth: tasks.length ? Math.max(...depths.values()) + 1 : 0,
    rootWidth: tasks.filter((task) => !(task.dependsOn ?? []).length).length,
    laneCap: Math.max(1, Number(config?.maxParallel) || 1),
    // What this launch released, if anything: the `--task=` of a `gate:
    // before`, the `--accept=` of `gate: after`. The close row reads these to
    // say what the stop before this launch was waiting on.
    release: release && (release.task || release.accept?.length)
      ? { task: release.task ?? null, accept: release.accept ?? [] }
      : null,
    forecast: forecast ?? buildForecast({ spec: { tasks }, config }),
    // The run's builder attempts so far: none on a first launch, every earlier
    // launch's on a relaunch.
    ...builderMeasures(state),
  };
};

export const appendLaunchRow = ({ root, dag, config, release = null, forecast = null, state = null, say = say0 }) => {
  try {
    const project = measureProject(root);
    if (!project) {
      say("MEASURE: no GitHub origin remote, so no launch row was written.");
      return null;
    }
    const row = buildLaunchRow({ project, dag, config, baseSha: shas(root).headSha, release, forecast, state });
    appendRow(measurePath(project), row);
    return row;
  } catch (error) {
    say(`MEASURE: could not write the launch row (${error.message}); the run continues.`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Merge row
// ---------------------------------------------------------------------------

// One row per PR the merge verb (scripts/merge.mjs) merged. The verb appends it;
// this only shapes it. `probe` is `{ exit: null, ms: null }` when no health
// probe was declared.
// `state` is the run's `.afk/state.json`, for the builder numbers; without it
// they are null.
export const buildMergeRow = ({ project, epic, pr, mergeSha = null, mergedAt = null, delegatedGates = [], guards = [], probe = null, state = null }) => ({
  type: "merge",
  schema: MEASURE_SCHEMA,
  project,
  epic: normalizeId(epic),
  pr: Number(pr),
  mergeSha,
  mergedAt,
  by: "verb",
  delegatedGates,
  guards: guards.map((guard) => ({ name: guard.name, status: guard.status })),
  probe: { exit: probe?.exit ?? null, ms: probe?.ms ?? null },
  ...builderMeasures(state),
});

// ---------------------------------------------------------------------------
// Close row
// ---------------------------------------------------------------------------

const commandsOf = (event) => JSON.stringify(event.declared ?? null);
// Green is judged on the commands that ran: a baseline that skipped its Rust
// checks (#176 W3) and passed the rest is green, and its event lists `skipped`.
const allGreen = (event) => Array.isArray(event.commands) && event.commands.length > 0
  && event.commands.every((check) => check.code === 0);
const red = (event) => Array.isArray(event.commands) && event.commands.some((check) => check.code != null && check.code !== 0);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** Total gate wall time: every recorded command's duration, or null if any is unknown. */
const gateMsOf = (events) => {
  const durations = events.flatMap((event) => (Array.isArray(event.commands) ? event.commands : [null]).map((check) => check?.durationMs));
  return durations.every((value) => typeof value === "number" && Number.isFinite(value))
    ? durations.reduce((total, value) => total + value, 0)
    : null;
};

/**
 * Gate counts from the event log. A repeat is an all-green run whose tree and
 * command list match an earlier all-green run. A false red is a red run later
 * followed by an all-green run with the same command list on the same tree —
 * which includes a #176 recheck of the one failed command passing.
 */
export const gateFields = (events, decisions = []) => {
  if (!events) return { gateRuns: null, gateMs: null, repeats: null, falseReds: null, reds: null };
  const gateRuns = {};
  for (const event of events) gateRuns[event.kind] = (gateRuns[event.kind] ?? 0) + 1;
  let repeats = 0;
  const greens = [];
  for (const event of events) {
    if (!allGreen(event)) continue;
    if (greens.some((g) => g.treeSha && g.treeSha === event.treeSha && commandsOf(g) === commandsOf(event))) repeats += 1;
    greens.push(event);
  }
  let falseReds = 0;
  const reds = [];
  events.forEach((event, index) => {
    if (!red(event)) return;
    const failed = event.commands.find((check) => check.code !== 0 && check.code != null);
    const later = events.slice(index + 1).filter((next) => allGreen(next) && next.treeSha && next.treeSha === event.treeSha);
    const overturned = later.some((next) => commandsOf(next) === commandsOf(event)
      || (next.kind === "recheck" && next.taskId === event.taskId && commandsOf(next) === JSON.stringify([failed.command])));
    if (overturned) falseReds += 1;
    const decision = event.taskId ? decisions.find((entry) => entry.taskId === event.taskId) : null;
    reds.push({
      kind: event.kind, taskId: event.taskId ?? null, attempt: event.attempt ?? null,
      command: failed.command, code: failed.code, falseRed: overturned,
      classification: decision?.classification ?? null,
    });
  });
  return { gateRuns, gateMs: gateMsOf(events), repeats, falseReds, reds };
};

/** The supervisor's decisions on disk, keyed by the task id its folder names. */
const readDecisions = (afkDir) => {
  const dir = resolve(afkDir, "supervisor");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const key of readdirSync(dir)) {
    const decision = readJson(resolve(dir, key, "decision.json"));
    if (decision) out.push({ taskId: key.replace(/-[^-]+$/, ""), classification: decision.classification ?? null });
  }
  return out;
};

const laneDirs = (afkDir) => {
  const runs = resolve(afkDir, "runs");
  if (!existsSync(runs)) return [];
  const out = [];
  for (const id of readdirSync(runs)) {
    let names;
    try {
      if (!statSync(resolve(runs, id)).isDirectory()) continue;
      names = readdirSync(resolve(runs, id));
    } catch { continue; }
    for (const name of names) {
      const match = /^(builder|integration)-(\d+)$/.exec(name);
      if (match) out.push({ taskId: id, kind: match[1], attempt: Number(match[2]), dir: resolve(runs, id, name) });
    }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.kind.localeCompare(b.kind) || a.attempt - b.attempt);
};

const firstPhaseAt = (dir) => {
  const rows = readJsonl(resolve(dir, "phases.jsonl"));
  return rows?.[0]?.at ?? null;
};

// Runs from before lanes wrote phases.jsonl still logged each builder start:
// "[<iso>] AUTO: builder <id> attempt <n> started ...". The first one at or
// after the run's start, for a task in this run's state, is the first lane
// start. The log is append-only across launches, so an unknown start is null.
const firstLoggedLaneStart = (afkDir, since, tasks) => {
  const path = resolve(afkDir, "agent-auto.log");
  if (!Number.isFinite(since) || !existsSync(path)) return null;
  const known = new Set(Object.keys(tasks ?? {}));
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\[([^\]]+)\] AUTO: builder (\S+) attempt \d+ started/.exec(line);
    if (match && known.has(match[2]) && ms(match[1]) >= since) return match[1];
  }
  return null;
};

/**
 * Stops between launches. The kind is read from what the NEXT launch did: a
 * launch that released a gate followed a human-gate stop; otherwise a red
 * baseline as the last gate before it is a red-gate halt; anything else is
 * fatal. The stop is the last gate event before the next launch (or the
 * launch itself when none ran), and the parked interval runs from there.
 * A run still parked at the end gets one more stop with `parkedMs: null`.
 */
const stopsOf = (launches, events, close) => {
  if (!launches) return null;
  const stops = [];
  launches.forEach((launch, index) => {
    const next = launches[index + 1];
    const until = next ? ms(next.at) : Infinity;
    const window = (events ?? []).filter((event) => ms(event.at) >= ms(launch.at) && ms(event.at) < until);
    const last = window.at(-1);
    const stoppedAt = last?.at ?? launch.at;
    if (!next) {
      // `closedAt` before `lifecycle`: the runner writes the row just before it
      // flips the lifecycle (auto.mjs closeEpic).
      if (close?.lifecycle === "closed" || close?.closedAt || !close) return;
      stops.push({ kind: close.lifecycle === "awaiting_acceptance" ? "human gate" : "unknown", at: stoppedAt, parkedMs: null });
      return;
    }
    const kind = next.release ? "human gate"
      : last?.kind === "baseline" && red(last) ? "red gate halt"
        : "fatal";
    stops.push({ kind, at: stoppedAt, parkedMs: Math.max(0, ms(next.at) - ms(stoppedAt)) });
  });
  return stops;
};

const closeoutFields = async (afkDir, epicId) => {
  const report = readJson(resolve(afkDir, "fixer", String(epicId ?? "epic"), "report.json"));
  if (!report) return null;
  const { partitionDeferred, partitionFixed } = await import("./fixer.mjs");
  const found = report.items?.length ?? (report.fixed?.length ?? 0) + (report.deferred?.length ?? 0);
  // Each bucket counted, not `dropped` as a remainder: a restatement (fixed
  // or deferred) and a no-op are dropped; only distinct fixes are fixed.
  const fixedParts = partitionFixed(report);
  const deferredParts = partitionDeferred(report);
  const dropped = fixedParts.duplicates.length + deferredParts.noOp.length + deferredParts.duplicates.length;
  return { found, fixed: fixedParts.distinct.length, dropped, left: deferredParts.open.length };
};

// A lane's wall time: the sum of its stream's `result.duration_ms`, one per
// turn. A stream with no result event (a transcript, a lane that died) is null.
const streamDurationMs = (text) => {
  let total = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && Number.isFinite(event.duration_ms)) total = (total ?? 0) + event.duration_ms;
    } catch { /* a torn line is not a turn */ }
  }
  return total;
};

// The model a stream or transcript names on its first assistant message.
const modelOf = (text) => /"model":"(claude-[^"]+)"/.exec(text)?.[1] ?? null;

// A lane's usage. A direct lane has `stream.jsonl`; a herdr lane writes none,
// and its usage lives only in the Claude Code session transcript(s) whose first
// message points at this lane's prompt.md (usage.mjs laneTranscripts). Before
// that fallback every herdr lane's efficiency and wall time were null.
const laneFields = async (lanes, { project, epicId }) => {
  const { efficiency } = await import("./agent-stats.mjs");
  const { laneTranscripts, transcriptDurationMs } = await import("./usage.mjs");
  return lanes.map(({ taskId, kind, attempt, dir }) => {
    const empty = { taskId, kind, attempt, model: null, efficiency: null, durationMs: null };
    const path = resolve(dir, "stream.jsonl");
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        // A lane that ran had at least one turn. Zero turns means the parser
        // understood nothing in the file (a codex log, say): unknown, not zero.
        const stats = efficiency(text);
        return { ...empty, model: modelOf(text), efficiency: stats?.turns > 0 ? stats : null, durationMs: streamDurationMs(text) };
      }
      const files = laneTranscripts({ project, epicId, taskId, kind, attempt });
      if (!files.length) return empty;
      const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
      const stats = efficiency(text);
      const durations = files.map(transcriptDurationMs);
      return {
        ...empty,
        model: modelOf(text),
        efficiency: stats?.turns > 0 ? stats : null,
        durationMs: durations.every(Number.isFinite) ? durations.reduce((a, b) => a + b, 0) : null,
      };
    } catch {
      return empty;
    }
  });
};

// Every agent session of this epic, any role, from the transcripts: one entry
// per (role, task, attempt, model). A role the opening message does not name
// is `unknown`. Null when no transcript for this epic exists.
const usageFields = async ({ project, epicId }) => {
  if (epicId == null) return null;
  const { collectUsage } = await import("./usage.mjs");
  const rows = collectUsage({ match: (name) => name.includes(String(epicId)) })
    .filter((row) => row.epicId === String(epicId) && (!project || row.project === project));
  if (!rows.length) return null;
  const out = new Map();
  for (const row of rows) {
    const key = [row.role, row.taskId, row.attempt, row.model].join("|");
    const entry = out.get(key) ?? {
      role: row.role, taskId: row.taskId, attempt: row.attempt, model: row.model,
      tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, costUsd: 0,
    };
    for (const k of Object.keys(entry.tokens)) entry.tokens[k] += row[k];
    entry.costUsd = row.costUsd == null || entry.costUsd == null ? null : entry.costUsd + row.costUsd;
    out.set(key, entry);
  }
  return [...out.values()];
};

/**
 * Build the close row from a run's `.afk/` folder (or its archive) and the
 * launch rows already in the measure file. No agent, no network.
 */
export const buildCloseRow = async ({ afkDir, project, epicId = null, launchRows = null, at = new Date().toISOString() }) => {
  const state = readJson(resolve(afkDir, "state.json"));
  const id = normalizeId(epicId ?? state?.epic?.id ?? state?.epic ?? null);
  const events = readJsonl(gateEventsPath(afkDir));
  const close = state?.epicClose ?? null;
  const since = ms(state?.startedAt);
  const launches = launchRows
    ? launchRows.filter((row) => row.type === "launch" && row.epicId === id && !(ms(row.at) < since))
    : null;
  const lanes = laneDirs(afkDir);
  const integrationRetries = lanes.length || state
    ? lanes.filter((lane) => lane.kind === "integration" && lane.attempt > 1).map((lane) => ({
      taskId: lane.taskId,
      attempt: lane.attempt,
      passed: readJson(resolve(lane.dir, "verification.json"))?.passed ?? null,
    }))
    : null;
  const gates = new Set((state?.dag?.tasks ?? []).filter((task) => task.gateAfter || task.gate === "after").map((task) => String(task.id)));
  const starts = lanes.filter((lane) => lane.kind === "builder").map((lane) => firstPhaseAt(lane.dir)).filter(Boolean).sort();
  return {
    schema: MEASURE_SCHEMA,
    type: "close",
    project,
    epicId: id,
    at,
    outcome: close?.outcome ?? null,
    launches: launches ? launches.length : null,
    relaunches: launches ? Math.max(0, launches.length - 1) : null,
    gateReleases: launches ? launches.filter((row) => row.release?.task).length : null,
    acceptances: close ? Object.keys(close.acceptances ?? {}).length + (close.voidedAcceptances?.length ?? 0) : null,
    stops: stopsOf(launches, events, close),
    ...gateFields(events, readDecisions(afkDir)),
    integrationRetries,
    tasks: state?.tasks
      ? Object.entries(state.tasks).map(([taskId, task]) => {
        const verification = task.taskVerification ?? null;
        // The runner seeds both counters at 0 and resets them on a relaunch or
        // an infra failure, so a 0 is a count only when nothing ran: a `gate:
        // after` task (scheduler.mjs runnableTasks never gives it a lane) or
        // one still pending or blocked. Any other 0 is unknown.
        const noLane = gates.has(taskId) || ["pending", "blocked"].includes(task.lifecycle);
        const count = (value) => (value === 0 && !noLane ? null : value ?? null);
        return {
          taskId,
          builderAttempts: count(task.builderAttempt),
          integrationAttempts: count(task.integrationAttempt),
          lifecycle: task.lifecycle ?? null,
          agentDied: verification && verification.agentExitCode !== undefined
            ? verification.agentExitCode !== 0 || verification.timedOut === true
            : null,
        };
      })
      : null,
    closeout: await closeoutFields(afkDir, id),
    times: {
      launch: launches?.[0]?.at ?? state?.startedAt ?? null,
      firstLaneStart: starts[0] ?? firstLoggedLaneStart(afkDir, since, state?.tasks),
      // Nothing on disk records when the draft PR opened, and this row may not
      // ask GitHub. Null until the runner writes it down.
      prOpened: null,
      closed: close?.closedAt ?? null,
    },
    lanes: await laneFields(lanes, { project, epicId: id }),
    usage: await usageFields({ project, epicId: id }),
  };
};

/**
 * Append the close row. `once` is for the late writers (`afk archive`, the
 * wave driver): they skip a close the runner already recorded. `mark: false`
 * leaves the run folder untouched — backfill reads a run, it does not edit it.
 */
export const appendCloseRow = async ({ root, afkDir = resolve(root, ".afk"), epicId = null, project = undefined, once = false, mark = true, say = say0 }) => {
  try {
    const name = project === undefined ? measureProject(root) : project;
    if (!name) {
      say("MEASURE: no GitHub origin remote, so no close row was written.");
      return null;
    }
    const closedAt = readJson(resolve(afkDir, "state.json"))?.epicClose?.closedAt ?? null;
    if (once && (readJsonl(closeMarkerPath(afkDir)) ?? []).some((marker) => marker.closedAt === closedAt)) return null;
    const path = measurePath(name);
    const launchRows = existsSync(path)
      ? readFileSync(path, "utf8").split("\n").flatMap((line) => {
        try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
      })
      : null;
    const row = await buildCloseRow({ afkDir, project: name, epicId, launchRows });
    appendRow(path, row);
    if (mark) {
      try {
        appendRow(closeMarkerPath(afkDir), { closedAt });
      } catch { /* the marker only prevents a duplicate row */ }
    }
    return row;
  } catch (error) {
    say(`MEASURE: could not write the close row (${error.message}); the close continues.`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// `afk measure backfill <path>`
// ---------------------------------------------------------------------------

const cli = async () => {
  const parsed = parseArgv(process.argv.slice(2), ["project"], { command: "measure" });
  const [verb, path] = parsed.positional;
  if (verb !== "backfill" || !path) {
    console.log("usage: afk measure backfill <.afk folder or .afk/archive/epic-<id>> [--project=<name>]");
    return 1;
  }
  const afkDir = resolve(path);
  if (!existsSync(afkDir)) {
    console.log(`MEASURE: ${afkDir} does not exist.`);
    return 1;
  }
  const top = run("git rev-parse --show-toplevel", { cwd: afkDir });
  const project = parsed.flags.project || (top.status === 0 ? measureProject(top.stdout.trim()) : null);
  if (!project) {
    console.log("MEASURE: cannot tell which project this run belongs to; pass --project=<name>.");
    return 1;
  }
  const row = await appendCloseRow({ root: afkDir, afkDir, project, mark: false });
  if (!row) return 1;
  console.log(`MEASURE: close row for epic #${row.epicId ?? "?"} appended to ${measurePath(project)}`);
  return 0;
};

// Not a top-level await: cli() lazily imports fixer.mjs, which imports this
// module back, and that import waits for this module to finish evaluating.
if (isMainModule(import.meta.url)) cli().then((code) => { process.exitCode = code; });
