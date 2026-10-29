import { resolve } from 'node:path';
import { lifecycleOf } from './lib.mjs';
import { epicCloseSummary } from './scheduler.mjs';

export const parseWorktrees = (porcelain, projectRoot) => porcelain.trim().split(/\n\n+/)
  .map((block) => Object.fromEntries(block.split('\n').filter(Boolean).map((line) => {
    const [key, ...value] = line.split(' ');
    return [key, value.join(' ') || true];
  })))
  .filter((entry) => entry.worktree && resolve(entry.worktree) !== resolve(projectRoot))
  // A `role-cwd-*` directory is the throwaway checkout a read-only role runs in
  // (scripts/worktree.mjs `roleCwd`). It is not a lane, it lives for one agent,
  // and listing it would show the closeout review as a leftover worktree.
  .filter((entry) => !String(entry.worktree).split('/').filter(Boolean).at(-1).startsWith('role-cwd-'))
  .map((entry) => {
    const branch = String(entry.branch ?? '').replace('refs/heads/', '');
    return {
      path: entry.worktree,
      name: entry.worktree.split('/').filter(Boolean).at(-1),
      branch: branch || null,
      taskId: branch.match(/^afk\/task-(.+)$/)?.[1] ?? null,
    };
  });

/**
 * Is `pid` a process we can still signal? ESRCH means it is gone; EPERM means it
 * exists but belongs to another user, which still counts as alive.
 */
export const pidAlive = (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * The recorded fatal, if the orchestrator that wrote it is really gone (#144).
 * One rule for `afk status` and the dashboard: a live orchestrator pid outranks
 * any record, so the two views cannot disagree about whether a run is dead.
 */
export const orchestratorFatal = (state, alive = pidAlive) =>
  !state?.fatal || alive(state.orchestratorPid) ? null : state.fatal;

const LIVE_LIFECYCLES = ['running', 'integrating'];

// The five stages a ticket walks, drawn as pips so "how far along is this
// ticket" has an answer that is not a made-up percentage: queued, building,
// review, integrating, passed — each one a lifecycle the runner records.
// `passed`, not "done": CONTEXT.md reserves done for a runtime-level hint that
// an agent stopped working.
const STAGE_OF = {
  pending: 0,
  blocked: 0,
  awaiting_acceptance: 2,
  running: 1,
  failed: 1,
  infra_failed: 1,
  stale: 1,
  ready_to_integrate: 2,
  integrating: 3,
  integration_failed: 3,
  passed: 4,
  // A supervisor can rule a task a no-op. `renderCloseout` marks it ✅ beside
  // passed, so the graph must not leave it sitting at the starting line.
  'no-op': 4,
};

/** The lifecycles that mean this task is finished work, not work in flight. */
export const COMPLETE_LIFECYCLES = new Set(['passed', 'no-op']);

/**
 * A merged task's phase, the one the dashboard's bar is coloured by. Copied
 * from `getPhase` in dashboard.html, keep the two in step. `ready` and
 * `blocked` are both `waiting` here: the bar and the hub draw them alike.
 */
export const phaseOf = (task) => {
  if (COMPLETE_LIFECYCLES.has(task.status)) return 'done';
  if (task.status === 'stale') return 'stale';
  if (LIVE_LIFECYCLES.includes(task.status)) return 'active';
  if (['failed', 'integration_failed', 'infra_failed'].includes(task.status)) return 'failed';
  if (task.status === 'awaiting_acceptance') return 'gate';
  if (task.status === 'ready_to_integrate' || task.review) return 'review';
  return 'waiting';
};

/** `{done, active, review, gate, failed, stale, waiting}` over merged tasks (#244). */
export const phaseCounts = (tasks) => {
  const counts = { done: 0, active: 0, review: 0, gate: 0, failed: 0, stale: 0, waiting: 0 };
  for (const task of tasks) counts[phaseOf(task)] += 1;
  return counts;
};

/** How far along the five stages a lifecycle sits. Unknown lifecycles read as queued. */
export const stageOf = (status) => STAGE_OF[status] ?? 0;

/**
 * A lane's gate results, reduced to what fits on a card. Null when the lane has
 * no verification record yet — which is NOT the same as "no checks passed", and
 * the dashboard must not render it as a zero.
 */
export const checkSummary = (verification) => {
  const checks = verification?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const failing = checks.filter((check) => check.code !== 0).map((check) => check.command);
  return { total: checks.length, passed: checks.length - failing.length, failing };
};

/**
 * Longest dependency chain from a root to each task — the graph column a ticket
 * is drawn in. `epic-spec.mjs` already refuses a cyclic epic, but a dashboard
 * that hangs on a malformed state file is worse than one that draws it flat, so
 * a cycle resolves to depth 0 rather than recursing forever.
 */
export const depthsOf = (tasks) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = (byId.get(id)?.dependsOn ?? []).filter((parent) => byId.has(parent));
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(depth)) + 1;
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const task of tasks) depth(task.id);
  return depths;
};

/**
 * A worktree directory and a `running` lifecycle both outlive the process that
 * created them: when the orchestrator dies mid-run its state file freezes with
 * every in-flight task still marked `running`, and its worktrees stay on disk.
 * Rendering either as "running" makes a dead run indistinguishable from a live
 * one. Liveness therefore comes from the recorded pids and nothing else — a task
 * is `stale` when it claims to be running with no process behind it, and a
 * worktree with neither a live process nor an active lifecycle is a leftover.
 */
export const mergeDashboardState = (dag, state, worktrees, alive = pidAlive, liveStats = {}) => {
  const orchestrator = { pid: state.orchestratorPid ?? null, alive: alive(state.orchestratorPid) };
  // A just-spawned agent is recorded before its pid is known; the orchestrator
  // that is about to fill it in vouches for it.
  const vouched = (entry) => (entry.pid == null ? orchestrator.alive : alive(entry.pid));
  const workers = Object.values(state.activeWorkers ?? {})
    .map((worker) => ({ ...worker, alive: vouched(worker) }));
  const integrator = state.activeIntegrator
    ? { ...state.activeIntegrator, alive: vouched(state.activeIntegrator) }
    : null;
  const backed = new Set([
    ...workers.filter((worker) => worker.alive).map((worker) => worker.taskId),
    ...(integrator?.alive ? [integrator.taskId] : []),
  ]);
  // The orchestrator drives the lifecycle itself, so while it lives a task may
  // legitimately sit between agents with no child process of its own.
  const live = (id) => orchestrator.alive || backed.has(id);

  const depths = depthsOf(dag.tasks);
  for (const task of dag.tasks) {
    const runtime = state.tasks?.[task.id];
    // A DAG task carries no status: the display one comes from runtime state.
    task.status = lifecycleOf(task, state);
    const worktree = worktrees.find((entry) => entry.taskId === task.id || entry.path === runtime?.worktree);
    if (worktree) {
      task.checkout = worktree.name;
      task.hasWorktree = true;
    } else if (runtime?.worktree) {
      task.checkout = runtime.worktree.split('/').filter(Boolean).at(-1);
    }
    if (LIVE_LIFECYCLES.includes(task.status) && !live(task.id)) {
      task.staleFrom = task.status;
      task.status = 'stale';
    }
    task.review = task.status === 'ready_to_integrate';
    // Progress, from what the runner already recorded — no new bookkeeping.
    task.depth = depths.get(task.id) ?? 0;
    task.stage = stageOf(task.status);
    task.builderAttempt = runtime?.builderAttempt ?? 0;
    task.integrationAttempt = runtime?.integrationAttempt ?? 0;
    task.checkSummary = checkSummary(runtime?.taskVerification);
    task.durationMs = runtime?.taskVerification?.durationMs ?? null;
    task.commitSha = runtime?.commitSha ?? null;
    // Live agent stats for the lanes with an agent in flight. A `stale` task's
    // stream file is frozen, not live: printing its last tool call as current
    // activity is the dead-run-looks-live bug one field further in.
    task.live = task.status === 'stale' ? null : liveStats[task.id] ?? null;
  }

  const statusOf = (id) => dag.tasks.find((task) => task.id === id)?.status ?? null;
  for (const worktree of worktrees) {
    const status = statusOf(worktree.taskId);
    worktree.state = LIVE_LIFECYCLES.includes(status) ? 'running' : status === 'stale' ? 'stale' : 'leftover';
  }

  // Epic-level progress. `passed` is finished tasks and nothing else — a run is
  // not 4/6 because two lanes are busy.
  dag.progress = {
    total: dag.tasks.length,
    passed: dag.tasks.filter((task) => COMPLETE_LIFECYCLES.has(task.status)).length,
  };

  dag.runtime = {
    orchestrator,
    activeWorkers: workers,
    liveWorkers: workers.filter((worker) => worker.alive).length,
    integrationQueue: state.integrationQueue ?? [],
    activeIntegrator: integrator,
    worktrees,
    running: worktrees.filter((entry) => entry.state === 'running').length,
    stale: worktrees.filter((entry) => entry.state === 'stale').length,
    staleTasks: dag.tasks.filter((task) => task.status === 'stale').map((task) => task.id),
    dashboard: state.dashboard ?? null,
    // `{ at, message }` when the orchestrator died on a fatal (#144), cleared
    // by the next start. `orchestratorFatal` is the rule `afk status` uses too.
    fatal: orchestratorFatal(state, alive),
    startedAt: state.startedAt ?? null,
    updatedAt: state.updatedAt ?? null,
    // The epic's lifecycle, from the same renderer `afk status` uses — a second
    // one is how the CLI and the web view start disagreeing about whether a run
    // is finished. Null until an epic close record exists.
    epicClose: epicCloseSummary(state, dag),
  };
  return dag;
};
