// The DAG is not on disk; the run's graph shape is, in `.afk/state.json`, which
// is also the only thing that knows a lifecycle. So status reads one file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { laneUntracked } from './finish.mjs';
import { orchestratorFatal, pidAlive } from './dashboard-data.mjs';
import { deliveryFailureWords } from './scheduler.mjs';
import { isMainModule, lifecycleOf, ready } from './lib.mjs';
import { restartLines } from './restart.mjs';
import { gateWaitLine } from './gate-lock.mjs';
import { AWAITING_ACCEPTANCE, epicCloseSummary, supervisorAdvice } from './scheduler.mjs';
import { builderRoutingRows } from './builder-routing.mjs';

/**
 * The rows, with the lifecycle `.afk/state.json` owns folded in. Split out of
 * the script body so the table and `gatedReleaseLines` read one list.
 */
const rowsOf = (state) =>
  (state?.dag?.tasks ?? []).map((task) => ({ ...task, status: lifecycleOf(task, state) }));

/**
 * The release command for every `gate: before` task that is gated AND ready.
 *
 * `pending (gated)` used to be the whole message, and the verb that clears it —
 * `afk epic <n> --task=<id>` — sits several screens down in `afk help`. The place
 * a human learns a task is gated is the place least likely to tell them how to
 * ungate it, and the runner holds both numbers, so nothing here is a placeholder:
 * the epic id comes from `state.dag.epic`, a record on a run the epic command
 * wrote and a bare id on older state.
 *
 * Ready, not merely gated: a task whose dependencies have not passed would have
 * the command refused, and a command that does not work is worse than silence.
 */
export const gatedReleaseLines = (state) => {
  const rows = rowsOf(state);
  const epic = state?.dag?.epic?.id ?? state?.dag?.epic;
  const gated = rows.filter((task) => task.humanGated && ready(task, rows));
  if (!gated.length || epic === undefined || epic === null) return [];
  return gated.flatMap((task) => [
    `#${task.id} is human-gated. Release with:`,
    `  afk epic ${epic} --task=${task.id}`,
  ]);
};

/**
 * The orchestrator's death, said first (#144). A fatal used to leave only the
 * last line of `agent-auto.log`, and this command went on printing lanes as
 * `running` with no scheduler behind them — for 2h13m on one epic. `runAuto`
 * records `{ at, message }` in state on the way out and clears it once a
 * restart reaches its scheduler; `orchestratorFatal` is the dashboard's rule.
 */
export const fatalLine = (state, alive = pidAlive) => {
  const fatal = orchestratorFatal(state, alive);
  return fatal ? `orchestrator exited at ${fatal.at}: ${fatal.message}` : null;
};

/**
 * (#292) One builder-routing row per task that has an assignment or a builder
 * attempt: what it was routed to, what its latest attempt actually ran on, and
 * why. Without it a lane quietly retried on Claude reads like a Codex lane.
 */
// (#294) The tier, the Jev answers that decided it and the Jev version follow
// the reason, and a run with no key says once why the router was skipped.
export const routingLines = (state) => {
  const rows = builderRoutingRows(state);
  const skipped = state.builderRouting?.skipped?.reason;
  const head = skipped ? [`tier router skipped: ${skipped}; every task ran as critical.`] : [];
  if (!rows.length) return head;
  const tierPart = (row) => [
    row.tier ? `tier ${row.tier}` : null,
    row.answers,
    row.jevModel ? `jev ${row.jevModel}` : null,
    row.routerSkipped && !skipped && !String(row.reason).includes('router skipped') ? `router skipped: ${row.routerSkipped}` : null,
  ].filter(Boolean).map((part) => ` · ${part}`).join('');
  // An escalated or fallen-back task lists every attempt, so the model the
  // first one ran on is not lost behind the retry's (#295).
  const attemptsPart = (row) => {
    const runs = state.tasks?.[row.task]?.builderRuns ?? [];
    if (runs.length < 2) return '';
    return ` · attempts ${runs.map((run) => `${run.backend ?? '?'}/${run.model ?? 'unknown'}${run.outcome ? ` (${run.outcome})` : ''}`).join(', ')}`;
  };
  return [
    ...head,
    'builder routing (preferred → actual · reason):',
    ...rows.map((row) => `  #${row.task}: ${row.preferred} → ${row.actual} · ${row.reason}${tierPart(row)}${attemptsPart(row)}`),
  ];
};

/**
 * (#179) Each automatic gate rerun, newest last, with the reading that earned
 * it. Without these lines a run that went red and recovered reads exactly like
 * one that never went red, and a misread environment is invisible.
 */
export const gateRerunLines = (state, limit = 5) =>
  (state?.gateReruns ?? []).slice(-limit).map((rerun) => {
    const where = rerun.kind === 'baseline' ? 'baseline' : `post-merge #${rerun.taskId}`;
    const outcome = rerun.passed === true ? 'passed on rerun' : rerun.passed === false ? 'red again' : 'rerunning';
    return `gate rerun · ${where} · \`${rerun.command}\` exited ${rerun.firstExitCode ?? '?'} · ${rerun.classification ?? 'unread'} (${rerun.confidence ?? '?'}) · ${outcome}${rerun.evidence?.length ? ` — ${rerun.evidence.join('; ')}` : ''}`;
  });

/**
 * (#179) A refused push or failed PR step that the epic summary does not
 * already carry: mid-run, before the epic has closed.
 */
export const deliveryLine = (state) => {
  const delivery = state?.prDelivery;
  if (delivery?.status !== 'failed' || state?.epicClose?.lifecycle === 'closed') return null;
  return `PR not delivered · ${deliveryFailureWords(delivery)} at ${delivery.at}: ${delivery.message || 'no message'}`;
};

/** A lifecycle as this command prints it: an in-flight one under a dead orchestrator is not running. */
const shownStatus = (status, state) =>
  orchestratorFatal(state) && (status === 'running' || status === 'integrating') ? `${status} (orchestrator exited)` : status;

const main = () => {
  let state = null;
  try { state = JSON.parse(readFileSync('.afk/state.json', 'utf8')); } catch {}
  if (!state) {
    console.log('No run in this project yet (.afk/state.json is missing). Start one with `afk auto`.');
    return;
  }
  const tasks = rowsOf(state);
  if (state.dag?.epic) console.log(`epic ${state.dag.epic.id ?? state.dag.epic}${state.dag.branch ? ` · ${state.dag.branch}` : ''}`);
  const fatal = fatalLine(state);
  if (fatal) console.log(fatal);
  // "restarted after fatal (k of N)", and why the chain stopped (#146).
  for (const line of restartLines(state)) console.log(line);
  console.table(tasks.map(({ id, title, status, dependsOn, humanGated }) => ({
    id,
    status: humanGated && ready({ status, dependsOn }, tasks) ? `${status} (gated)` : shownStatus(status, state),
    title,
    dependsOn: dependsOn.join(',') || '-',
  })));
  const counts = tasks.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] || 0) + 1 }), {});
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ·  '));
  console.log(`workers: ${Object.keys(state.activeWorkers ?? {}).join(', ') || '-'}  ·  integrating: ${state.activeIntegrator?.taskId ?? '-'}  ·  queue: ${state.integrationQueue?.join(', ') || '-'}`);
  // (#178) A full gate parked behind another epic's on this machine. Without
  // this an epic waiting on the gate lock reads as a hung baseline.
  const gateWait = gateWaitLine(process.cwd());
  if (gateWait) console.log(gateWait);
  // The epic's own lifecycle. Without this line an operator cannot tell an epic
  // that is still running from one waiting on their acceptance without reading
  // .afk/state.json by hand.
  const close = epicCloseSummary(state);
  if (close) console.log(close.summary);
  const delivery = deliveryLine(state);
  if (delivery) console.log(delivery);
  for (const line of gateRerunLines(state)) console.log(line);
  for (const line of routingLines(state)) console.log(line);
  // The release command for each gated row, under the table that shows it.
  for (const line of gatedReleaseLines(state)) console.log(line);
  // A `gate: after` task is never dispatched to a builder; it resolves to
  // `awaiting_acceptance` and only a human's `--accept` moves it. Name the ids and
  // the command here too, because `epicCloseSummary` only speaks once the epic
  // itself has parked — the tasks reach this state first.
  const awaiting = tasks.filter((task) => task.status === AWAITING_ACCEPTANCE).map((task) => task.id);
  if (awaiting.length && !close?.outstanding?.length)
    console.log(`awaiting your acceptance: ${awaiting.join(', ')} — release with \`afk auto --accept=${awaiting.join(',')}\``);
  // The supervisor's last live diagnosis, and the command it would run if it
  // could. Advisory by design; this is the surface where that advice reaches
  // someone in time to use it.
  for (const line of supervisorAdvice(state)) console.log(line);
  // Untracked files in a retained lane. `afk finish` blocks on these, but it is
  // the command that DELETES them, so by the time it speaks the operator is
  // already at the point of loss. One run's most valuable artifact — a 138-line
  // device-acceptance checklist — survived only because a supervisor happened to
  // mention it. Absolute paths, because the reader's next move is to open one.
  for (const lane of laneUntracked(process.cwd())) {
    console.log(`lane ${lane.taskId} holds ${lane.files.length} untracked file(s) that \`afk finish\` would delete:`);
    for (const file of lane.files) console.log(`  ${resolve(lane.worktree, file)}`);
  }
};

// Importing this module must run nothing: the release-command extraction has a
// test only because the script body no longer fires at import time.
if (isMainModule(import.meta.url)) main();
