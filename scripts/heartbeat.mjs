// scripts/heartbeat.mjs — is the AFK runner still working on THIS project?
// Notifies (macOS notification + terminal bell) when the orchestrator dies,
// stalls, or reaches a human gate, so an AFK run does not sit idle unnoticed.
//
//   afk heartbeat                     one check, prints + exits
//   afk heartbeat --watch             check every 5 min until stopped
//   afk heartbeat --watch --interval=120 --stall=30
//
// Exit code: 0 healthy, 1 needs attention (single-check mode only).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { configPath, lifecycleOf, notify as baseNotify } from './lib.mjs';
import { parseYamlSubset } from './epic-spec.mjs';

const root = process.cwd();
const afkDir = resolve(root, '.afk');
const lockPath = resolve(afkDir, 'orchestrator.lock');
const statePath = resolve(afkDir, 'state.json');
const logPath = resolve(afkDir, 'agent-auto.log');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const INTERVAL_S = arg('interval', 300);
// A builder writes nothing to agent-auto.log while it works, so the stall
// threshold must clear .afk-setup/config.yaml's agent.timeoutMs plus slack. Read the
// config rather than hard-coding it: projects set very different budgets.
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

const alive = (pid) =>
  Number.isInteger(pid) && pid > 0 && spawnSync('kill', ['-0', String(pid)]).status === 0;

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};

// Not `loadConfig`: the heartbeat must survive a missing or malformed config
// rather than throw, so it keeps its own tolerant read.
const config = () => {
  try { return parseYamlSubset(readFileSync(configPath(root), 'utf8')) ?? {}; } catch { return {}; }
};
const state = () => readJson(statePath, null);

const stallMinutes = () => {
  const explicit = arg('stall', null);
  if (explicit) return explicit;
  const timeoutMs = config().agent?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Math.round(timeoutMs / 60_000) + 10;
};

/**
 * The pid of the orchestrator serving THIS project, or null.
 *
 * One central afk-claude checkout drives many projects, so a healthy run in
 * another repo must never read as this project being healthy. `.afk/state.json`
 * is per-project and records the pid, which settles it without guessing; the
 * pgrep fallback covers a run whose state file has not landed yet, and filters
 * on the process's own cwd for the same reason.
 */
const orchestratorPid = () => {
  const recorded = Number(state()?.orchestratorPid);
  if (alive(recorded)) return recorded;
  if (existsSync(lockPath)) {
    const locked = Number(readFileSync(lockPath, 'utf8').trim());
    if (alive(locked)) return locked;
  }
  const out = spawnSync('pgrep', ['-f', 'afk.mjs auto'], { encoding: 'utf8' }).stdout ?? '';
  for (const line of out.trim().split('\n')) {
    const pid = Number(line);
    if (!alive(pid)) continue;
    // `pgrep -f` also matches the wrapping shell whose argv merely contains the
    // command, and matches sibling runs in other checkouts.
    const argv = (spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    if (!/\bafk\.mjs\b.*\bauto\b|\bauto\.mjs\b/.test(argv)) continue;
    const cwd = (spawnSync('sh', ['-c', `lsof -p ${pid} 2>/dev/null | awk '$4=="cwd"{print $NF}'`], { encoding: 'utf8' }).stdout ?? '').trim();
    if (cwd && cwd !== root) continue;
    return pid;
  }
  return null;
};

const minutesSince = (path) => {
  try { return (Date.now() - statSync(path).mtimeMs) / 60000; } catch { return Infinity; }
};

const ready = (task, tasks, runtime) => lifecycleOf(task, runtime) === 'pending'
  && task.dependsOn.every((id) => {
    const dependency = tasks.find((candidate) => candidate.id === id);
    return dependency && lifecycleOf(dependency, runtime) === 'passed';
  });

/**
 * Freshest sign of life from any in-flight agent.
 *
 * Builders stream JSONL into `.afk/runs/<id>/builder-<n>/stream.jsonl` and
 * mergers into `integration-<n>/`, and both keep writing throughout a run —
 * a much finer signal than agent-auto.log, which only moves between tasks.
 */
const agentQuietMinutes = (runtime) => {
  const streams = [];
  for (const [id, task] of Object.entries(runtime?.tasks ?? {})) {
    if (task.builderAttempt)
      streams.push(resolve(afkDir, 'runs', id, `builder-${task.builderAttempt}`, 'stream.jsonl'));
    if (task.integrationAttempt)
      streams.push(resolve(afkDir, 'runs', id, `integration-${task.integrationAttempt}`, 'stream.jsonl'));
    // Herdr lanes have no stream.jsonl; the agent's report file is the
    // freshness signal instead (scripts/report.mjs updates it per phase).
    if (task.worktree) streams.push(resolve(task.worktree, '.afk-report.json'));
  }
  return streams.length ? Math.min(...streams.map(minutesSince)) : Infinity;
};

/** @returns {{ok: boolean, title: string, detail: string}} */
function check() {
  const runtime = state();
  // The graph shape of the current run, recorded by the orchestrator. No run in
  // this directory means no tasks to report on.
  const tasks = runtime?.dag?.tasks ?? [];
  const counts = tasks.reduce((a, t) => ((a[lifecycleOf(t, runtime)] = (a[lifecycleOf(t, runtime)] || 0) + 1), a), {});
  const tally = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ');
  const pid = orchestratorPid();

  // No plan here at all. "All tasks done" would read as success for a directory
  // that was never a runner project — usually a heartbeat started in the wrong one.
  if (!tasks.length)
    return { ok: false, title: 'No plan in this directory', detail: `${root} has no run recorded in .afk/state.json.` };

  if (!pid) {
    // Mirror the scheduler's own selection: a gate only stops the plan when no
    // ungated task is runnable, otherwise the runner would just carry on.
    const runnable = tasks.filter((t) => ready(t, tasks, runtime) && !t.humanGated);
    const gated = tasks.filter((t) => ready(t, tasks, runtime) && t.humanGated).map((t) => t.id);
    const left = tasks.filter((t) => lifecycleOf(t, runtime) === 'pending').length;
    if (runnable.length)
      return { ok: false, title: 'Runner is NOT running', detail: `${runnable.length} task(s) ready (next ${runnable[0].id}). Start: afk auto` };
    if (gated.length)
      return { ok: false, title: 'Runner stopped at a human gate', detail: `Task(s) ${gated.join(', ')} need you. ${tally}` };
    // A `gate: after` task sits in `awaiting_acceptance`, which is not `pending`
    // — so without this line an epic parked on a human's device walkthrough read
    // as "Runner finished — All tasks done", which is the one thing it is not.
    const awaiting = tasks.filter((t) => lifecycleOf(t, runtime) === 'awaiting_acceptance').map((t) => t.id);
    if (awaiting.length)
      return { ok: false, title: 'Runner stopped at a human gate', detail: `Task(s) ${awaiting.join(', ')} await your acceptance: afk auto --accept=${awaiting.join(',')}. ${tally}` };
    if (!left) return { ok: true, title: 'Runner finished', detail: `All tasks done. ${tally}` };
    return { ok: false, title: 'Runner is NOT running', detail: `${left} task(s) blocked. Check: afk status` };
  }

  const inFlight = [
    ...Object.keys(runtime?.activeWorkers ?? {}),
    ...(runtime?.activeIntegrator ? [`merge ${runtime.activeIntegrator.taskId}`] : []),
  ];
  const quiet = Math.min(minutesSince(logPath), agentQuietMinutes(runtime));
  const stall = stallMinutes();
  if (quiet > stall) {
    return {
      ok: false,
      title: 'Runner looks stalled',
      detail: `pid ${pid} alive but no output for ${Math.round(quiet)} min${inFlight.length ? ` (${inFlight.join(', ')})` : ''}.`,
    };
  }

  return {
    ok: true,
    title: 'Runner healthy',
    detail: `pid ${pid}${inFlight.length ? `, in flight: ${inFlight.join(', ')}` : ', idle'}. ${tally}`,
  };
}

// The stall/health alert. No `-execute`: the heartbeat watches the run from
// outside and has no lane in hand, so there is no single pane a click should
// land in — unlike scripts/runtime-herdr.mjs, which knows exactly which lane is
// asking. An inert notification is the honest one here.
function notify(title, detail) {
  // A stall or a dead runner is `error`; a gate is `warn`. Both pierce Do Not
  // Disturb — an unattended run that has stopped is the whole reason this
  // watcher exists — but they sound different, so "it wants you" and "it is
  // broken" are distinguishable without reading the banner.
  const level = /stalled|NOT running/i.test(title) ? 'error' : 'warn';
  // The event name the notification policy filters on. A gate is the run
  // waiting on this human; a stall or a dead runner is the run being broken.
  // Only the gate is in the default allow-list — see NOTIFY_ONLY in lib.mjs.
  const kind = level === 'error' ? 'runner_stalled' : 'gate_reached';
  baseNotify({
    kind,
    title: `AFK runner — ${root.split('/').pop()}`,
    subtitle: title,
    message: detail,
    level,
    // One heartbeat alert at a time: the watcher re-checks every INTERVAL_S and
    // would otherwise leave a column of identical banners overnight.
    group: 'afk-heartbeat',
  });
}

const stamp = () => new Date().toISOString().slice(11, 19);

if (process.argv.includes('--watch')) {
  console.log(`heartbeat: ${root} — every ${INTERVAL_S}s, stall threshold ${stallMinutes()}m. Ctrl-C to stop.`);
  let lastAlert = '';
  for (;;) {
    const r = check();
    console.log(`[${stamp()}] ${r.ok ? 'OK ' : 'ALERT'} ${r.title} — ${r.detail}`);
    // Notify on every transition into trouble, and re-notify only when the
    // reason changes — an hourly repeat of the same alert is just noise.
    if (!r.ok && r.title !== lastAlert) notify(r.title, r.detail);
    lastAlert = r.ok ? '' : r.title;
    spawnSync('sh', ['-c', `sleep ${INTERVAL_S}`]);
  }
} else {
  const r = check();
  console.log(`${r.ok ? 'OK' : 'ALERT'}: ${r.title} — ${r.detail}`);
  if (!r.ok) notify(r.title, r.detail);
  process.exit(r.ok ? 0 : 1);
}
