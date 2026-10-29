import { lifecycleOf, ownScope, ownsOverlap, shellQuote } from './lib.mjs';
import { USES_INFISICAL_RUN } from './infisical.mjs';

// `awaiting_acceptance` is a TASK lifecycle, not only an epic one. A
// `gate: after` task is a human acceptance gate — by definition it has no
// automatable work — so it is never given a lane, and the state it resolves to
// on admission must read as neither done nor broken. Three epics recorded three
// different answers (`blocked`, `failed`, `passed`) for the identical ticket
// shape purely on builder judgment; this is the fourth and only honest one.
export const AWAITING_ACCEPTANCE = 'awaiting_acceptance';

export const LIFECYCLE = new Set([
  'pending', 'running', 'ready_to_integrate', 'integrating', 'passed',
  'failed', 'integration_failed', 'infra_failed', 'blocked', 'no-op',
  AWAITING_ACCEPTANCE,
]);

// Both outcomes satisfy a task and its dependants. `no-op` remains distinct so
// release reporting can say that no code change was needed and require a real
// `passed` task before moving a wave branch.
export const TASK_SUCCESS = new Set(['passed', 'no-op']);

export const isNoOpDecision = (decision) => decision?.event === 'lane_blocked'
  && decision?.classification === 'no-op-ticket'
  && decision?.confidence === 'high'
  && decision?.recommendation === 'leave';

// Preflight (fix for the infra-vs-ticket breaker gap). An expired `claude`
// login makes every builder exit non-zero in under two seconds, which the
// breaker then reads as two bad tickets and halts — after poisoning good work.
// Catch a dead login or a missing required secret before the first builder is
// spawned. `checkAuth` is injected (the orchestrator runs a real probe; tests
// fake it), mirroring reconcileStaleState's injected `isAlive`.
//
// The host probes (#180) ride the same call: the project's own `preflight.probes`
// commands, the herdr server under the herdr runtime, and the ports the epic
// checkout's gates bind. Each seam is optional, so a caller that injects none
// gets exactly the auth/env preflight it had before. Every probe reports and
// stops; none of them fixes or kills anything.
export const preflightBlockers = ({
  config,
  env = process.env,
  checkAuth,
  // (#210) Returns the Infisical login line, or null when the session answers
  // or no check runs `infisical run` (`infisicalBlocker`). Optional.
  checkInfisical = null,
  root = null,
  runCommand = null,
  herdrStatus = null,
  portHolders = null,
  tasks = [],
  // Tasks whose checks run this run but get no lane (awaiting integration):
  // they need Infisical, never the screen. Defaults to `tasks`.
  checkTasks = tasks,
  infisicalProbe = null,
  macAutomationProbe = null,
  ghAuthProbe = null,
  platform = process.platform,
  // Optional sink for non-blocking findings from the probes above.
  warnings = null,
}) => {
  const blockers = [];
  // `checkAuth` returns true, false (no login) or the blocker text itself.
  const auth = checkAuth();
  if (auth !== true) blockers.push(typeof auth === 'string' ? auth : 'not authenticated');
  const infisical = checkInfisical?.();
  if (infisical) blockers.push(infisical);
  for (const name of config.requiredEnv ?? [])
    if (!env?.[name]) blockers.push(`missing env ${name}`);
  // `afk validate` refuses a malformed block first; this is the backstop for
  // `afk auto` run directly, so a typo'd key never reads as "no probes".
  const configErrors = preflightConfigErrors(config);
  if (configErrors.length) return [...blockers, ...configErrors];
  const block = config.preflight ?? {};
  if (runCommand) {
    for (const [label, command] of Object.entries(block.probes ?? {})) {
      const result = runCommand(command);
      if (result.status !== 0)
        blockers.push(`preflight "${label}" failed (exit ${result.status ?? 'none'}): \`${command}\`${tailOf(result)}`);
    }
  }
  if (herdrStatus && config.agent?.runtime === 'herdr') {
    const status = herdrStatus();
    if (!(status.status === 0 && /^status:\s*running\b/m.test(status.stdout ?? '')))
      blockers.push(`herdr server is not running — start it with \`herdr\`, then rerun${tailOf(status)}`);
  }
  if (runCommand && portHolders && block.ports) blockers.push(...portBlockers({ command: block.ports, root, runCommand, portHolders }));
  // Owner checks (#210): logins a gate or a lane needs that only the owner can
  // grant. Automatic, keyed on what the config and the tickets actually use.
  // The runner reads issues and opens PRs through gh.
  if (ghAuthProbe) {
    const result = ghAuthProbe();
    if (result.status !== 0) blockers.push(`${GH_AUTH_LINE}${tailOf(result)}`);
  }
  if (infisicalProbe && usesInfisical(config, checkTasks)) {
    const result = infisicalProbe();
    if (result.status !== 0) blockers.push(`${INFISICAL_LOGIN_LINE}${tailOf(result)}`);
  }
  if (macAutomationProbe && platform === 'darwin' && block.macAutomation !== false && uiTasks(tasks).length) {
    const result = macAutomationProbe();
    // A device another session holds says nothing about the grant, and that
    // session may be a parallel epic's live lane: warn, never block (#214).
    if (result.deviceInUse) warnings?.push(`${DEVICE_IN_USE_LINE}${tailOf(result)}`);
    else if (!result.ok) blockers.push(`${MAC_AUTOMATION_LINE}${tailOf(result)}`);
  }
  return blockers;
};

export const GH_AUTH_LINE = 'gh is not logged in: run `gh auth login`, then rerun.';
export const INFISICAL_LOGIN_LINE = 'Infisical login expired or missing: a gate runs `infisical run`. Run `infisical login`, then rerun.';
export const DEVICE_IN_USE_LINE = 'macOS automation not checked: the device is DEVICE_IN_USE, claimed by another agent-device session. If no lane or epic is using it, a stale daemon holds it: find it with `pgrep -fl agent-device` and stop it, then rerun `afk preflight`.';
export const MAC_AUTOMATION_LINE = 'macOS automation not granted: approve the Accessibility/Screen Recording prompt, then rerun';

// Every gate command the config and the tasks name: any `*Checks` list in the
// config (defaultChecks, baselineChecks, ...) plus each task's resolved checks.
export const gateCommands = (config, tasks = []) => {
  const lists = Object.entries(config ?? {})
    .filter(([key, value]) => /Checks$/.test(key) && Array.isArray(value))
    .map(([, value]) => value);
  for (const task of tasks ?? []) if (Array.isArray(task?.checks)) lists.push(task.checks);
  return lists.flat().filter((command) => typeof command === 'string');
};

export const usesInfisical = (config, tasks = []) => gateCommands(config, tasks).some((command) => USES_INFISICAL_RUN.test(command));

// A task drives the screen when its ticket names the tools that do it.
const UI_TICKET_RE = /agent-device|XCUITest|xcodebuild\s+test/;
export const uiTasks = (tasks = []) => (tasks ?? []).filter((task) => UI_TICKET_RE.test(String(task?.body ?? '')));

/** Warnings, never blockers: the Keychain prompt a UI lane's dev app may raise. */
// `npm install foo @scope/bar` / `npm i -D foo` in a ticket body: the packages
// it names. Flags are skipped; a version suffix (`foo@2`) is stripped.
const NPM_INSTALL_RE = /\bnpm\s+(?:install|i|add)\b([^\n`;&|]*)/g;
export const npmPackagesNamed = (body) => {
  const names = new Set();
  for (const match of String(body ?? '').matchAll(NPM_INSTALL_RE))
    for (const token of match[1].trim().split(/\s+/))
      if (token && !token.startsWith('-')) names.add(token.replace(/(.)@[^/]*$/, '$1'));
  return [...names];
};

/** Packages a ticket says to install that the base's package.json lacks. */
export const missingPackageWarnings = ({ tasks = [], packageJson = null } = {}) => {
  if (!packageJson) return [];
  const have = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((key) => Object.keys(packageJson[key] ?? {})));
  return (tasks ?? []).flatMap((task) => {
    const missing = npmPackagesNamed(task?.body).filter((name) => !have.has(name));
    return missing.length ? [`task ${task.id} names npm package(s) ${missing.join(', ')} missing from the base's package.json; lanes cannot install packages, so add them on the base first.`] : [];
  });
};

export const preflightWarnings = ({ tasks = [], packageJson = null } = {}) => {
  const warnings = missingPackageWarnings({ tasks, packageJson });
  const ui = uiTasks(tasks);
  if (!ui.length) return warnings;
  return [...warnings, `task(s) ${ui.map((task) => task.id).join(', ')} drive the screen: a lane's dev app under a temporary bundle id may raise a Keychain prompt nobody is there to answer. Tickets that need signed-in screenshots should carry a fallback.`];
};

// The keys `preflight:` accepts. Closed, like every other block: an unknown
// key is a typo, and a typo'd `probe:` would otherwise run no probe at all.
export const PREFLIGHT_KEYS = ['probes', 'ports', 'macAutomation'];

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every way `config.preflight` is malformed, as refusal lines; [] when fine or absent. */
export const preflightConfigErrors = (config) => {
  const block = config?.preflight;
  if (block === undefined || block === null) return [];
  const where = '.afk-setup/config.yaml `preflight:`';
  if (!isMapping(block)) return [`${where} must be a mapping with \`probes:\` and/or \`ports:\``];
  const errors = [];
  const unknown = Object.keys(block).filter((key) => !PREFLIGHT_KEYS.includes(key));
  if (unknown.length) errors.push(`${where} has unknown key(s) ${unknown.join(', ')} (allowed: ${PREFLIGHT_KEYS.join(', ')})`);
  if (block.probes !== undefined) {
    if (!isMapping(block.probes)) errors.push(`${where} \`probes:\` must be a mapping of one-line label → command`);
    else for (const [label, command] of Object.entries(block.probes))
      if (typeof command !== 'string' || !command.trim()) errors.push(`${where} probe "${label}" must be a non-empty command string`);
  }
  if (block.ports !== undefined && (typeof block.ports !== 'string' || !block.ports.trim()))
    errors.push(`${where} \`ports:\` must be one command that prints the ports a checkout's gates bind`);
  if (block.macAutomation !== undefined && typeof block.macAutomation !== 'boolean')
    errors.push(`${where} \`macAutomation:\` must be true or false`);
  return errors;
};

// The last lines of a probe's output, indented under its blocker line. Bounded
// so a probe that dumps a build log cannot bury the label above it.
const TAIL_LINES = 10;
const tailOf = (result) => {
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  return lines.length ? `\n${lines.slice(-TAIL_LINES).map((line) => `    ${line}`).join('\n')}` : '';
};

/**
 * The port probe. The project's command is given the checkout path as its last
 * argument — Harbour derives its ports from a hash of the path, so a fixed list
 * would be wrong — and prints the ports, separated by whitespace or commas.
 * Fail direction: CLOSED. A command that fails or prints something that is not
 * a port blocks the run, because a port probe that silently checked nothing is
 * the 85-minute collision this exists to stop. `portHolders(port)` returns the
 * listeners on that port as `[{ pid, command }]`, or a string when it could not
 * tell.
 */
const portBlockers = ({ command, root, runCommand, portHolders }) => {
  const full = `${command} ${shellQuote(root)}`;
  const result = runCommand(full);
  if (result.status !== 0) return [`preflight ports command failed (exit ${result.status ?? 'none'}): \`${full}\`${tailOf(result)}`];
  const tokens = String(result.stdout ?? '').split(/[\s,]+/).filter(Boolean);
  const bad = tokens.filter((token) => !/^\d+$/.test(token) || Number(token) < 1 || Number(token) > 65535);
  if (bad.length) return [`preflight ports command printed ${bad.map((token) => `"${token}"`).join(', ')}, which is not a port: \`${full}\``];
  const blockers = [];
  for (const port of [...new Set(tokens.map(Number))]) {
    const holders = portHolders(port);
    if (typeof holders === 'string') blockers.push(`port ${port} (for ${root}): could not check — ${holders}`);
    else for (const holder of holders)
      blockers.push(`port ${port} (for ${root}) is held by pid ${holder.pid} (${holder.command || 'unknown command'})`);
  }
  return blockers;
};

// A bad ticket usually fails once, after real work; an auth/env fault fails
// EVERY task, near-instantly and uniformly. A cluster of sub-second failures
// across unrelated tasks is the environment, not the tickets — surface it as
// suspected-infra instead of marking good tickets failed. Two seconds matches
// the observed expired-login signature.
export const INFRA_FAILURE_MS = 2000;
export const looksLikeInfra = (failures, threshold = INFRA_FAILURE_MS) =>
  failures.length >= 2
  && new Set(failures.map((failure) => failure.taskId)).size >= 2
  // Near-instant is the SIGNATURE, not the definition: the thing being detected
  // is "no real work happened". A lane that burned 114 seconds against a fixed
  // runtime deadline and spent nothing is the same fault running slower, and
  // without this clause the breaker halts it under the "N tasks failed in a row"
  // label — blaming the tickets, which is exactly what the classifier exists to
  // stop.
  && failures.every((failure) =>
    failure.neverReachedApi
    || (Number.isFinite(failure.durationMs) && failure.durationMs < threshold));

// The slow sibling of `looksLikeInfra`, for one lane rather than a cluster: a
// builder that exits clean having spent NOTHING never reached the API, so
// "produced no source change" is a fact about the harness, not about the ticket.
// Two lanes died this way at 114,456ms and 114,711ms — a quarter-second apart on
// a 900s timeout, which is a fixed internal deadline, not two coincidences.
//
// Only the herdr runtime reports `tokens` today, so ABSENT must read as "no
// evidence" and leave the lane blocked. Otherwise every direct-runtime lane that
// correctly refused an unautomatable ticket would be relabelled infra.
//
// Zero tokens means "never reached the API" ONLY when `producedFiles` is also
// empty. Epic 50 on gitproj-demo falsified the tokens-only version: lanes 45
// and 46 both recorded all-zero counters (`{"input":0,"output":0,"cacheRead":0}`)
// yet had written `src/cli.js` and `src/format.js` respectively — a metering
// gap, not an infra death, and files on disk are proof the API was reached
// whatever the counters say. A genuine infra death still shows both: zero
// tokens AND no produced files, as with the two lanes that died at 114,456ms
// and 114,711ms against the 900s deadline.
export const neverReachedApi = (verification) => {
  if (verification?.producedFiles?.length) return false;
  const counts = Object.values(verification?.tokens ?? {});
  // An EMPTY bag is absent-shaped, not zero-shaped: it says the runtime reported
  // no counters, which is the same silence as no `tokens` key at all. Only
  // counters that exist and are all zero are evidence.
  if (!counts.length) return false;
  return !counts.some((count) => Number(count) > 0);
};

// The runtime kills a builder at `agent.timeoutMs` and records `timedOut: true`.
// A kill AFTER real work — tokens spent or files written — is a lane that ran out
// of clock, not one that got the ticket wrong, and it must read differently from a
// plain failure so the operator raises the deadline instead of going to the ticket
// (#73). Deliberately the inverse condition from `neverReachedApi`'s no-work test:
// a hung lane that spent nothing is NOT a productive timeout.
export const timedOutWithWork = (verification) => {
  if (verification?.timedOut !== true) return false;
  if (verification?.producedFiles?.length) return true;
  return Object.values(verification?.tokens ?? {}).some((count) => Number(count) > 0);
};

/**
 * Clear what a task's runtime carries over from its last lifecycle: attempt
 * counters, the retry clock, its integration-queue slot, its worker entry and
 * any `gate: after` acceptance. Mutates `state`; the caller sets the lifecycle.
 * `afk reset` and `afk salvage` both hand a task back through here.
 */
export const clearTaskRuntime = (state, id) => {
  Object.assign(state.tasks[id], { builderAttempt: 0, integrationAttempt: 0, retryAt: null });
  state.integrationQueue = (state.integrationQueue ?? []).filter((queued) => queued !== id);
  // A worker entry outlives the lifecycle it belonged to, and `maxParallel` is
  // measured against this map — so a reset that leaves it consumes a slot with a
  // ghost. Two orphaned lanes with null pids filled both slots of a
  // `max_parallel: 2` epic: `afk status` showed six pending tasks, the restart
  // admitted nobody, and the only escape was deleting the state file.
  delete state.activeWorkers?.[id];
  // (#215) A lane red held for a retry belongs to the attempts just cleared.
  delete state.tasks[id].laneDefect;
  // A `gate: after` acceptance is a RECORD, not an act, so it does not die with
  // the lifecycle. `acceptedGateIds` already stops counting it once the task
  // leaves `passed`, but the record left behind makes the re-acceptance a no-op
  // (`recordGateAcceptance` returns `already`) that never writes `passed` — so
  // the task sits in `awaiting_acceptance` and the epic can never close on it.
  delete state.epicClose?.acceptances?.[id];
};

export const taskState = (state, id) => state.tasks?.[id] ?? { lifecycle: 'pending', builderAttempt: 0, integrationAttempt: 0 };

// The "no state entry means pending" rule has one home, in lib.mjs. Re-exported
// so scheduler callers keep importing lifecycle questions from the scheduler.
export { lifecycleOf };

export const dependenciesPassed = (task, dag, state) => task.dependsOn.every((id) => {
  const dependency = dag.tasks.find((candidate) => candidate.id === id);
  return dependency && TASK_SUCCESS.has(lifecycleOf(dependency, state));
});

// A dependency in one of these will never pass on its own, so anything behind
// it cannot start. This is the ONLY definition of what blocks a task.
export const BLOCKING_LIFECYCLE = new Set(['failed', 'integration_failed', 'blocked']);

/**
 * Make `blocked` agree with the dependency graph, in both directions.
 *
 * `blocked` is a FUNCTION of dependency lifecycle, so it is re-derived every
 * scheduler turn rather than written once and trusted. The bug that forced this:
 * #40 was marked `{"lifecycle":"blocked","blockedBy":"35"}`, #35 later merged
 * and went `passed`, nothing re-read the edge, and the run logged "no active,
 * queued, or automatically runnable tasks remain" and closed the epic
 * incomplete. Nothing errored, and `afk status` showed a blocked task that was
 * indistinguishable from a correctly blocked one. A stored edge that outlives
 * its cause is a silent halt.
 *
 * Mutates `state` in place and returns what moved, so the caller can log and
 * commit the transitions it actually caused.
 *
 * @returns {{id: string, lifecycle: string, blocker: string|null}[]}
 */
export const deriveBlocked = (dag, state) => {
  const transitions = [];
  // Blocking is transitive: marking A blocked can block B behind it. Loop until
  // the graph stops moving rather than assuming a topological order.
  for (let changed = true; changed;) {
    changed = false;
    for (const task of dag.tasks ?? []) {
      const runtime = state.tasks?.[task.id];
      if (!runtime) continue;
      if (runtime.lifecycle !== 'pending' && runtime.lifecycle !== 'blocked') continue;
      // `blocked` is overloaded: this function owns the dependency-edge kind,
      // which always carries `blockedBy`, and must not touch the other kind — a
      // builder that produced no source change is `blocked` on its own merits
      // and re-deriving it into `pending` would put it straight back in a lane.
      if (runtime.lifecycle === 'blocked' && !runtime.blockedBy) continue;
      const blocker = task.dependsOn.find((id) => BLOCKING_LIFECYCLE.has(state.tasks?.[id]?.lifecycle)) ?? null;
      if (blocker && runtime.lifecycle !== 'blocked') {
        runtime.lifecycle = 'blocked';
        runtime.blockedBy = blocker;
        transitions.push({ id: task.id, lifecycle: 'blocked', blocker });
        changed = true;
      } else if (!blocker && runtime.lifecycle === 'blocked') {
        // The cause is gone. Back to pending, where the scheduler can see it.
        runtime.lifecycle = 'pending';
        delete runtime.blockedBy;
        transitions.push({ id: task.id, lifecycle: 'pending', blocker: null });
        changed = true;
      } else if (blocker && runtime.blockedBy !== blocker) {
        runtime.blockedBy = blocker;
      }
    }
  }
  return transitions;
};

/**
 * The tasks that can get a lane this run: what the owner checks key on, so a
 * `--accept`, a `--task=` relaunch or a closeout on an epic whose UI ticket
 * already passed probes nothing for it (#214). Dependencies are not required
 * passed: they can pass during the run. Mirrors `runnableTasks` otherwise.
 */
export const laneTasks = (dag, state = {}, explicitTaskId = null) => (dag?.tasks ?? []).filter((task) => {
  if (explicitTaskId) return task.id === explicitTaskId && !task.gateAfter;
  if (task.gateAfter || task.humanGated) return false;
  const lifecycle = lifecycleOf(task, state);
  // A dependency-blocked task (`blockedBy` set) is re-derived to pending by
  // `deriveBlocked` mid-run, after preflight, so it may still get a lane.
  if (lifecycle === 'blocked') return Boolean(state.tasks?.[task.id]?.blockedBy);
  return ['pending', 'infra_failed'].includes(lifecycle);
});

/**
 * The tasks whose `checks` run this run: every lane task, plus those already
 * built and waiting to merge, whose checks integrate.mjs runs after the merge.
 */
export const checkTasks = (dag, state = {}, explicitTaskId = null) => [
  ...laneTasks(dag, state, explicitTaskId),
  ...(dag?.tasks ?? []).filter((task) => (!explicitTaskId || task.id === explicitTaskId)
    && ['ready_to_integrate', 'integrating'].includes(lifecycleOf(task, state))),
];

export const runnableTasks = (dag, state, now = Date.now(), explicitTaskId = null) => dag.tasks.filter((task) => {
  if (explicitTaskId && task.id !== explicitTaskId) return false;
  // A `gate: after` task is human work. It gets no lane, no worktree and no
  // builder — not even under an explicit `--task=`, because there is nothing an
  // agent could do with it that would be true. `resolveGateAfterTasks` moves it
  // to `awaiting_acceptance` instead, and `--accept=` is its only exit.
  if (task.gateAfter) return false;
  if (state.activeWorkers?.[task.id]) return false;
  const runtime = taskState(state, task.id);
  const lifecycle = lifecycleOf(task, state);
  // `infra_failed` is not the ticket's fault — the breaker paused it on a
  // suspected environmental fault. A fresh run (past the auth/env preflight)
  // rebuilds it like a pending task.
  if (lifecycle !== 'pending' && lifecycle !== 'infra_failed') return false;
  if (task.humanGated && !explicitTaskId) return false;
  if (runtime.retryAt && runtime.retryAt > now) return false;
  return dependenciesPassed(task, dag, state);
});

// Slots come from the stack config (.afk-setup/config.yaml), the ready set from the
// spec (the DAG) — the two sources stay apart all the way down.
export const freeBuilderSlots = (config, state) => Math.max(0,
  Math.max(1, Number(config.maxParallel) || 1) - Object.keys(state.activeWorkers ?? {}).length);

/**
 * Is this task's scope repo-wide — and therefore no constraint at all?
 *
 * docs/wave-mode.md §6. This is the load-bearing half of the owns filter, not a
 * nicety. `epicToDag` hardcodes `allowedPaths: ["**"]` for every task on the
 * GitHub path (`epic.mjs:127`), and `**` overlaps everything, so without the
 * opt-out the filter would serialize every existing epic to a single lane — a
 * silent, catastrophic regression on the path that runs weekly.
 *
 * Fail direction: **open**. An entry the scheduler cannot resolve to a
 * directory — `**`, or a pattern globbed at its very first segment — reads as
 * repo-wide and takes no constraint, which is exactly today's behaviour. The
 * cost of failing open is a merge conflict the runner already knows how to
 * handle; the cost of failing closed is a one-wide epic nobody would connect to
 * this change. An absent or empty `allowedPaths` is repo-wide for the same
 * reason `normalizeDag` defaults it to `['**']` (auto.mjs:167).
 */
export const repoWideScope = (task) => {
  const paths = task?.allowedPaths ?? [];
  return paths.length === 0 || paths.some((path) => ownScope(path) === '');
};

// The paths the running lanes hold. A repo-wide lane claims NOTHING here: its
// scope says "unconstrained", and reading it as "owns the repo" would block
// every sibling — the same regression `repoWideScope` exists to prevent, just
// arriving from the other side.
// Each claim carries its owner, so a deferral can name the lane it lost to
// rather than the path alone: "205 is deferred" with no second id sends an
// operator reading a 3am log to grep three files to find out what it lost to.
const activeClaims = (dag, state) => Object.keys(state.activeWorkers ?? {})
  .map((id) => dag.tasks.find((candidate) => candidate.id === id))
  .filter((task) => task && !repoWideScope(task))
  .flatMap((task) => task.allowedPaths.map((path) => ({ id: task.id, path })));

// The first claim this task collides with, or null. First rather than all: the
// operator needs one name to look at, and a task overlapping a lane on six
// paths has one problem, not six.
const scopeConflict = (task, claimed) => {
  if (repoWideScope(task)) return null;
  for (const mine of task.allowedPaths) {
    for (const held of claimed) {
      if (ownsOverlap(mine, held.path)) return { path: mine, held };
    }
  }
  return null;
};

/**
 * This tick's batch: `picked`, the tasks that may start — capped by free builder
 * slots, and filtered so no task starts whose `owns` overlaps an active lane's
 * or an earlier pick in the same batch (docs/wave-mode.md §6) — and `deferred`,
 * the ones that filter excluded, each naming the path it lost and the lane it
 * lost to. `nextBuilderTasks` is `picked` alone, which is what the scheduler
 * wants; `auto.mjs` takes the whole batch, because an idle lane with no stated
 * reason reads as a broken runner.
 *
 * An excluded task is DEFERRED — not failed, not marked, not retried. It is
 * still `pending`, still runnable, and the next tick reconsiders it against
 * whatever is running then. Nothing is written to state, which is what keeps
 * this function pure and the exclusion free of consequences.
 *
 * `explicitTaskId` bypasses the filter, as it already bypasses `humanGated`: an
 * operator who named one task is present, and silently starting nothing would
 * read as the runner being broken.
 */
export const planBuilderBatch = (dag, config, state, now = Date.now(), explicitTaskId = null) => {
  const slots = freeBuilderSlots(config, state);
  const runnable = runnableTasks(dag, state, now, explicitTaskId);
  if (explicitTaskId) return { picked: runnable.slice(0, slots), deferred: [] };
  const claimed = activeClaims(dag, state);
  const picked = [];
  const deferred = [];
  for (const task of runnable) {
    if (picked.length >= slots) break;
    const conflict = scopeConflict(task, claimed);
    if (conflict) {
      deferred.push({
        id: task.id,
        path: conflict.path,
        conflictsWith: conflict.held.id,
        heldPath: conflict.held.path,
      });
      continue;
    }
    if (!repoWideScope(task)) claimed.push(...task.allowedPaths.map((path) => ({ id: task.id, path })));
    picked.push(task);
  }
  return { picked, deferred };
};

export const nextBuilderTasks = (dag, config, state, now = Date.now(), explicitTaskId = null) =>
  planBuilderBatch(dag, config, state, now, explicitTaskId).picked;

/**
 * One log line per deferral, and only when the deferral is NEW. The scheduler
 * ticks constantly; a line every tick is a log nobody reads, and the operator's
 * question — "why is that lane idle?" — is answered once.
 *
 * Pure, and the memo is a value in and a value out rather than a mutated Map,
 * so the debounce is testable without a running scheduler. A task that stops
 * being deferred drops out of the memo and speaks again if it comes back:
 * deferred → started → deferred against a different lane is a new fact.
 */
export const deferralAnnouncements = (deferred, announced = new Map()) => {
  const next = new Map();
  const lines = [];
  for (const entry of deferred) {
    const key = `${entry.conflictsWith}\u0000${entry.path}\u0000${entry.heldPath}`;
    next.set(entry.id, key);
    if (announced.get(entry.id) === key) continue;
    lines.push(
      `task ${entry.id} is deferred: its \`${entry.path}\` overlaps \`${entry.heldPath}\`, held by ${entry.conflictsWith}. It starts when that lane frees.`,
    );
  }
  return { lines, announced: next };
};

/**
 * Has this builder any retry budget left? `attempt` is the number of attempts
 * ALREADY made (auto.mjs increments `builderAttempt` before spawning), and
 * `budget` is `agent.maxBuilderRetries` — retries AFTER the first attempt. So a
 * budget of 1 lets attempt 1 retry and stops attempt 2, and a budget of 0 never
 * retries.
 *
 * A seam, not a refactor: the decision lived inside `runAuto`'s closure with no
 * harness able to reach it, so the config knob it reads shipped verified only by
 * reading. Here it is a pure function like every other scheduling decision.
 */
export const shouldRetryBuilder = (attempt, budget) => attempt <= budget;

export const canStartIntegration = (state, now = Date.now()) => {
  if (state.activeIntegrator || !(state.integrationQueue?.length)) return false;
  const next = taskState(state, state.integrationQueue[0]);
  return !next.integrationRetryAt || next.integrationRetryAt <= now;
};

export const enqueueIntegration = (state, id) => {
  state.integrationQueue ??= [];
  if (!state.integrationQueue.includes(id) && state.activeIntegrator?.taskId !== id) state.integrationQueue.push(id);
};

export const recordWorkerPid = (state, id, pid) => {
  state.tasks[id].pid = pid;
  state.activeWorkers[id].pid = pid;
};

export const clearWorkerPid = (state, id) => {
  delete state.tasks[id]?.pid;
  delete state.activeWorkers[id];
};

export const dequeueIntegration = (state) => state.integrationQueue.shift();

export const nextWakeDelay = (state, now = Date.now(), fallback = 1000) => {
  const retryTimes = Object.values(state.tasks ?? {}).flatMap((task) => [task.retryAt, task.integrationRetryAt]).filter((at) => Number.isFinite(at) && at > now);
  return retryTimes.length ? Math.max(10, Math.min(fallback, Math.min(...retryTimes) - now)) : fallback;
};

export const schedulerDone = (dag, state, now = Date.now(), explicitTaskId = null) =>
  Object.keys(state.activeWorkers ?? {}).length === 0
  && !state.activeIntegrator
  && !(state.integrationQueue?.length)
  && runnableTasks(dag, state, now, explicitTaskId).length === 0
  && !Object.entries(state.tasks ?? {}).some(([id, task]) => (!explicitTaskId || id === explicitTaskId)
    && task.lifecycle === 'pending' && task.retryAt > now);

export const reconcileStaleState = (state, isAlive = () => false) => {
  const recovered = structuredClone(state);
  const stalePids = [];
  recovered.activeWorkers ??= {};
  recovered.integrationQueue ??= [];
  recovered.tasks ??= {};
  for (const [id, worker] of Object.entries(recovered.activeWorkers)) {
    if (worker.pid && isAlive(worker.pid)) stalePids.push(worker.pid);
    const task = recovered.tasks[id] ??= {};
    task.lifecycle = 'pending';
    task.recoveredFrom = 'running';
    delete task.pid;
  }
  recovered.activeWorkers = {};
  if (recovered.activeIntegrator) {
    const { taskId, pid, integrationBase } = recovered.activeIntegrator;
    if (pid && isAlive(pid)) stalePids.push(pid);
    const task = recovered.tasks[taskId] ??= {};
    task.lifecycle = 'ready_to_integrate';
    task.integrationBase = integrationBase;
    recovered.integrationQueue = [taskId, ...recovered.integrationQueue.filter((id) => id !== taskId)];
    recovered.activeIntegrator = null;
  }
  recovered.recoveredAt = new Date().toISOString();
  return { state: recovered, stalePids };
};

/**
 * Fold the DAG's task list into runtime state.
 *
 * `.afk/state.json` is the sole owner of lifecycle, and a DAG task carries no
 * status, so this is now pure set reconciliation rather than a merge of two
 * opinions:
 *
 * - a task in the DAG with no state entry has NEVER run — seed it as pending;
 * - a state entry with no task in the DAG is an orphan — report it, keep it
 *   (an id dropped from the epic mid-run is a fact a human wants to see, not
 *   state to silently delete).
 *
 * The old adoption branch, where a manifest calling a task `passed` overrode
 * runtime state, is gone with the manifest that carried it. Nothing can now
 * disagree with state about lifecycle, so there is nothing to adopt — see
 * AGENTS.md failure mode 3.
 */
export const reconcileWithDag = (state, dag) => {
  const reconciled = structuredClone(state);
  reconciled.tasks ??= {};
  const seeded = [];
  for (const task of dag.tasks) {
    if (reconciled.tasks[task.id]) continue;
    reconciled.tasks[task.id] = {
      lifecycle: 'pending',
      builderAttempt: 0,
      integrationAttempt: 0,
    };
    seeded.push(task.id);
  }
  const orphaned = Object.keys(reconciled.tasks)
    .filter((id) => !dag.tasks.some((task) => task.id === id));
  return { state: reconciled, seeded, orphaned };
};

// ---------------------------------------------------------------------------
// The epic's lifecycle (docs/epic-schema.md failure mode 5)
// ---------------------------------------------------------------------------
//
// Until now the runner had no concept of an epic ending: the loop drained and
// the process exited. `gate: after` needs one, because it means "the task may
// run, but the epic cannot close until a human accepts" — a statement about the
// EPIC, not about the task. The task itself runs, integrates and passes exactly
// like any other; what the gate holds back is the close.
//
// Mechanically, next to `gate: before`:
//
//   gate: before  →  task.humanGated  →  `runnableTasks` skips it, so nothing
//                    schedules it until a human runs `afk run --task=<id>`.
//                    The release is an ACT (a run) and is not recorded: the
//                    task simply leaves `pending`, which is what a restart sees.
//   gate: after   →  task.gateAfter   →  scheduling is untouched. The release
//                    is a RECORD in `.afk/state.json`
//                    (`epicClose.acceptances[<id>]`), so a restart three hours
//                    later reads the acceptance instead of asking again.
//
// Epic lifecycle, and what each writes:
//
//   open                 the default; nothing beyond the record itself
//   awaiting_acceptance  every task passed, >=1 `gate: after` unaccepted.
//                        Writes `lifecycle`, `enteredAt` and the outstanding
//                        ids. Not terminal: the run exits 0 and the next run
//                        (or `--accept`) resumes from here.
//   closed               terminal. Writes `outcome`, `closedAt`, `reason` and
//                        the closeout artifacts.
//
// Terminal outcomes:
//
//   completed                every task passed, every gate accepted, and the
//                            verifier was clean, unavailable or inconclusive.
//   completed_with_findings  the same, but the verifier recommended `must-fix`
//                            or `criteria-unmet`. The epic still closes — the
//                            human's acceptance is the gate, not the verifier's
//                            opinion — and the closeout leads with the findings.
//   incomplete               the scheduler drained with at least one task in
//                            `failed`, `integration_failed` or `blocked`. No
//                            verifier runs: there is little point reviewing an
//                            epic against criteria it never delivered.
//
// A halted run (circuit breaker, auth death) is NOT an epic outcome. It ends a
// RUN, not an epic: the tasks it never reached are still pending, so the epic
// stays `open` and a rerun continues it. Same for an unreleased `gate: before`
// and for `infra_failed`.

export const EPIC_LIFECYCLE = new Set(['open', 'awaiting_acceptance', 'closed']);
export const EPIC_OUTCOMES = new Set(['completed', 'completed_with_findings', 'incomplete']);

// A task in one of these has stopped and will not restart on its own.
const TERMINAL_FAILURE = new Set(['failed', 'integration_failed', 'blocked']);
// A task in one of these is in flight; the epic cannot be judged yet.
const IN_FLIGHT = new Set(['running', 'ready_to_integrate', 'integrating']);

export const epicCloseRecord = (at = new Date().toISOString()) => ({
  lifecycle: 'open',
  outcome: null,
  reason: null,
  enteredAt: at,
  closedAt: null,
  acceptances: {},
  verifier: null,
  closeout: null,
  history: [],
});

// --- the supervisor's last diagnosis, on the surface a human types -----------
// The supervisor is advisory by design and that is right. What was wrong is
// where its advice landed: one line in `.afk/agent-auto.log`, a file nobody
// opens while a run is going. Two epics turned on a call it got mechanically
// right — the fast-forward cause, the exact `afk reset`, and why the retry would
// work this time — and in both the human found it hours later, or not at all.
// So the last decision worth acting on rides `.afk/state.json` and is rendered
// by `afk status`.
//
// Recorded, not executed. Giving the supervisor the loop is the one thing
// docs/epic-schema.md says that role does not own, and a `reset` run behind a
// human's back destroys the lane they were about to read.
//
// Here rather than in supervisor.mjs for the same reason `epicCloseSummary` is
// here: this is state shape and its rendering, and `afk status` must not import
// the agent-invocation stack to print two lines.

/**
 * The last supervisor decision an operator would want to act on, or null.
 *
 * `leave` with nothing proposed is the supervisor saying the run is fine —
 * recording that would push the last real diagnosis out of view, which is the
 * failure this exists to fix rather than a smaller version of it.
 *
 * `taskLifecycle` is the lane's lifecycle AT DIAGNOSIS TIME, and it is what
 * makes the advice expire: any move off it means the run has answered the
 * supervisor, whether by the reset it proposed (which lands on `pending`, not on
 * any "resolved" state), a retry that passed, or a human. Enumerating the states
 * that count as resolved was the first attempt and it was wrong twice over — it
 * named a lifecycle that does not exist, and missed the one the advice's own
 * remedy produces.
 */
export const supervisorRecord = (decision, commands = [], { at = new Date().toISOString(), taskLifecycle = null, runLifecycles = null } = {}) => {
  const proposals = commands.map((entry) => ({
    command: `afk ${entry.argv.join(" ")}`,
    why: entry.why ?? null,
  }));
  const noOp = isNoOpDecision(decision);
  const idle = !noOp && decision?.recommendation === "leave" && !proposals.length && !decision?.wake;
  if (!decision || idle) return null;
  return {
    at,
    event: decision.event ?? null,
    taskId: decision.evidence?.taskId ?? null,
    taskLifecycle,
    // (#179) Every task's lifecycle at diagnosis time, for a record about no
    // one task (the end of an epic). Any move expires it, the same rule as
    // `taskLifecycle`.
    ...(runLifecycles ? { runLifecycles } : {}),
    classification: decision.classification ?? null,
    confidence: decision.confidence ?? null,
    recommendation: decision.recommendation ?? null,
    answer: decision.answer ?? decision.reasoning ?? null,
    proposals,
  };
};

/** `afk status`'s supervisor block, as lines. Empty when there is nothing live. */
export const supervisorAdvice = (state) => {
  const record = state?.supervisor;
  if (!record) return [];
  // A note that outlives its cause teaches an operator to skim the whole block.
  if (record.taskId && state?.tasks?.[record.taskId]?.lifecycle !== record.taskLifecycle) return [];
  // An end-of-epic note that names a failure later fixed is the same lie at
  // run scale: #489's still said "flaky email test" after that task passed.
  if (record.runLifecycles && Object.entries(record.runLifecycles)
    .some(([id, lifecycle]) => (state?.tasks?.[id]?.lifecycle ?? "pending") !== lifecycle)) return [];
  const who = record.taskId ? `task ${record.taskId}` : "this run";
  const head = `supervisor · ${who} · ${record.event} → \`${record.recommendation}\` (${record.confidence})`;
  return [
    record.answer ? `${head}: ${record.answer}` : head,
    ...record.proposals.map((entry) =>
      `  \`${entry.command}\`${entry.why ? ` — ${entry.why}` : ""} (advisory; not run)`),
  ];
};

/** (#179) A failed PR delivery step in words: only a push is refused; `error` is a step that threw. */
export const deliveryFailureWords = ({ step }) =>
  step === 'push' ? 'push refused' : step === 'error' ? 'PR delivery failed' : `PR ${step} failed`;

/**
 * The epic's lifecycle in the two lines an operator needs, or null when there is
 * no epic to speak of.
 *
 * Written here rather than in `scripts/status.mjs` because the dashboard needs
 * the same answer, and a second rendering of a lifecycle is how the CLI and the
 * web view start disagreeing about whether a run is finished.
 *
 * `awaiting_acceptance` names the outstanding ids, because that state is the one
 * the operator can personally clear and the ids are the command they have to
 * type (`--accept=`).
 *
 * @param {object} state parsed .afk/state.json
 * @param {object|null} dag the run's DAG, when the caller has one
 * @returns {{lifecycle: string, outcome: string|null, summary: string}|null}
 */
export const epicCloseSummary = (state, dag = state?.dag ?? null) => {
  const close = state?.epicClose;
  if (!close) return null;
  const accepted = dag ? acceptedGateIds(dag, state) : Object.keys(close.acceptances ?? {});
  const outstanding = dag
    ? gateAfterTasks(dag).map((task) => task.id).filter((id) => !accepted.includes(id))
    : [];
  // (#179) A closed epic whose branch never reached the remote is not finished:
  // its own state, with the refusing step's words.
  const delivery = state?.prDelivery?.status === 'failed' ? state.prDelivery : null;
  const lifecycle = delivery && close.lifecycle === 'closed' ? 'not_delivered' : close.lifecycle;
  const parts = [`epic: ${lifecycle}${close.outcome ? ` (${close.outcome})` : ''}`];
  if (delivery) parts.push(`${deliveryFailureWords(delivery)}: ${delivery.message || 'no message'}`);
  if (close.reason) parts.push(close.reason);
  if (outstanding.length) parts.push(`awaiting acceptance: ${outstanding.join(', ')} — release with --accept=${outstanding.join(',')}`);
  else if (accepted.length) parts.push(`accepted: ${accepted.join(', ')}`);
  if (close.verifier) {
    parts.push(close.verifier.skipped
      ? 'closeout review: skipped'
      : `closeout review: ${close.verifier.recommendation ?? 'ran'}${close.verifier.blocking?.length ? ` (${close.verifier.blocking.length} must-fix)` : ''}`);
  }
  return {
    lifecycle,
    outcome: close.outcome ?? null,
    outstanding,
    accepted,
    summary: parts.join('  ·  '),
  };
};

/** The record, created in place on a state file written before it existed. */
export const ensureEpicClose = (state) => (state.epicClose ??= epicCloseRecord());

export const gateAfterTasks = (dag) => (dag.tasks ?? []).filter((task) => task.gateAfter);

/**
 * The gates a human has actually released.
 *
 * Every acceptance is re-derived from the DAG and re-checked here rather than
 * trusted as written, so a state file that acquired one by any route other than
 * `recordGateAcceptance` grants nothing:
 *
 *  - the task must still be in the DAG and still carry `gate: after`;
 *  - the record must carry `by: "human"` and an `at` timestamp;
 *  - the task must be `passed`. A gate cannot be accepted before the work it
 *    gates has been built, integrated and post-merge verified.
 *
 * This is the second of the two checks that stop a gated task self-completing.
 * The first is that no code path fed by an agent ever writes an acceptance —
 * see `recordGateAcceptance`.
 */
export const acceptedGateIds = (dag, state) =>
  gateAfterTasks(dag)
    .filter((task) => {
      const record = state?.epicClose?.acceptances?.[task.id];
      // `passed` only: `recordGateAcceptance` moves the task there as it writes
      // the record, so an accepted gate is never left in `awaiting_acceptance`
      // and a reset back out of `passed` still voids the acceptance.
      return Boolean(record)
        && acceptedBy(record, state, task.id)
        && typeof record.at === 'string'
        && lifecycleOf(task, state) === 'passed';
    })
    .map((task) => task.id);

/**
 * Who may have accepted a gate: a human, or the delegate (#188) — and the
 * delegate only for a gate a human delegated at launch, so a record that says
 * `by: "delegate"` over a gate with no delegation in state grants nothing.
 */
export const acceptedBy = (record, state, id) =>
  record?.by === 'human' || (record?.by === 'delegate' && Boolean(state?.delegations?.[String(id)]));

/** `gate: after` tasks with no valid acceptance, in DAG order. */
export const outstandingGates = (dag, state) => {
  const accepted = new Set(acceptedGateIds(dag, state));
  return gateAfterTasks(dag).map((task) => task.id).filter((id) => !accepted.has(id));
};

/**
 * Move every admissible `gate: after` task to `awaiting_acceptance`. Mutates.
 *
 * "Admissible" is the same test the scheduler applies to any other leaf — every
 * dependency passed — so the gate surfaces at exactly the moment the work it
 * gates is on the branch. What differs is what admission MEANS: for a gate it
 * is not a lane, it is the run handing the ticket to a person.
 *
 * @returns {string[]} the ids that moved
 */
export const resolveGateAfterTasks = (dag, state) => {
  const resolved = [];
  for (const task of gateAfterTasks(dag)) {
    const runtime = state.tasks?.[task.id];
    if (!runtime || runtime.lifecycle !== 'pending') continue;
    if (!dependenciesPassed(task, dag, state)) continue;
    runtime.lifecycle = AWAITING_ACCEPTANCE;
    delete runtime.blockedBy;
    resolved.push(task.id);
  }
  return resolved;
};

/**
 * Record a human's acceptance of a `gate: after` task.
 *
 * The ONLY writer of `epicClose.acceptances`. It is called from one place — the
 * `--accept=` CLI path, which a human invokes — and from no path that consumes
 * an agent's output. A builder's `verification.json`, a merger's result and an
 * agent's transcript have no field that reaches this function, so a lane cannot
 * accept its own gate by producing the right artifact. Refusing a gate that has
 * not passed additionally means acceptance cannot be granted ahead of the work.
 *
 * @returns {{ok: boolean, already?: boolean, reason?: string}}
 */
export const recordGateAcceptance = (state, { dag, id, at = new Date().toISOString(), note = null, by = 'human', detail = null }) => {
  const taskId = String(id);
  const task = (dag.tasks ?? []).find((candidate) => candidate.id === taskId);
  if (!task) return { ok: false, reason: `task ${taskId} is not in this epic` };
  if (!task.gateAfter) {
    return { ok: false, reason: `task ${taskId} is not \`gate: after\`; there is nothing to accept` };
  }
  const lifecycle = lifecycleOf(task, state);
  // `awaiting_acceptance` is the state a gate that was never dispatched sits in;
  // `passed` covers a gate recorded before gates stopped being dispatched, and a
  // re-accept. Everything else — pending, running, failed — still refuses.
  if (lifecycle !== 'passed' && lifecycle !== AWAITING_ACCEPTANCE) {
    return {
      ok: false,
      reason: `task ${taskId} is ${lifecycle}, not passed — a gate cannot be accepted before the work is built, integrated and verified`,
    };
  }
  // The delegate (#188) accepts only a gate a human delegated at launch; its
  // `detail` is the condition, the guardrails and the review they read.
  if (by === 'delegate' && !state.delegations?.[taskId]) {
    return { ok: false, reason: `#${taskId} was not delegated; a human must accept it` };
  }
  if (by !== 'human' && by !== 'delegate') return { ok: false, reason: `unknown acceptor ${JSON.stringify(by)}` };
  const close = ensureEpicClose(state);
  close.acceptances ??= {};
  if (acceptedBy(close.acceptances[taskId], state, taskId)) return { ok: true, already: true };
  close.acceptances[taskId] = by === 'human' ? { at, by: 'human', note } : { at, by, note, ...(detail ?? {}) };
  // The human's acceptance IS the gate's verdict, and it is the only thing that
  // can produce one. Recording it here keeps `awaiting_acceptance` meaning
  // "still waiting" everywhere it is rendered.
  const runtime = (state.tasks ??= {})[taskId] ??= {};
  runtime.lifecycle = 'passed';
  return { ok: true, already: false };
};

/**
 * What the epic is, given the DAG and the runtime state. Pure.
 *
 * Called when the scheduler has drained; the `in_progress` results exist so a
 * caller that asks early gets an honest "not yet" rather than a wrong verdict.
 *
 * @returns {{status: string, reason: string, failed: string[], pending: string[], awaiting: string[]}}
 */
export const epicOutcome = (dag, state) => {
  const tasks = dag.tasks ?? [];
  const lifecycleFor = (task) => lifecycleOf(task, state);
  const inFlight = tasks.filter((task) => IN_FLIGHT.has(lifecycleFor(task))).map((task) => task.id);
  const failed = tasks.filter((task) => TERMINAL_FAILURE.has(lifecycleFor(task))).map((task) => task.id);
  // `awaiting_acceptance` is not pending — nothing will ever run it — and not a
  // failure. It is the epic's own `awaiting_acceptance` branch below, reached
  // through `outstandingGates`, so it is excluded from both buckets here.
  const pending = tasks
    .filter((task) => !IN_FLIGHT.has(lifecycleFor(task))
      && !TERMINAL_FAILURE.has(lifecycleFor(task))
      && !TASK_SUCCESS.has(lifecycleFor(task))
      && lifecycleFor(task) !== AWAITING_ACCEPTANCE)
    .map((task) => task.id);
  const shape = { failed, pending, awaiting: [] };
  if (tasks.length === 0) return { status: 'empty', reason: 'this DAG has no tasks', ...shape };
  if (inFlight.length) {
    return { ...shape, status: 'in_progress', reason: `${inFlight.join(', ')} still in flight` };
  }
  if (failed.length) {
    return {
      ...shape,
      status: 'incomplete',
      reason: `task(s) ${failed.join(', ')} did not pass${pending.length ? `, and ${pending.join(', ')} never ran` : ''}`,
    };
  }
  if (pending.length) {
    return { ...shape, status: 'in_progress', reason: `task(s) ${pending.join(', ')} have not run yet` };
  }
  const awaiting = outstandingGates(dag, state);
  if (awaiting.length) {
    return {
      ...shape,
      awaiting,
      status: 'awaiting_acceptance',
      reason: `every task passed; \`gate: after\` task(s) ${awaiting.join(', ')} await a human's acceptance`,
    };
  }
  return { ...shape, status: 'complete', reason: 'every task passed or was a confirmed no-op, and every gate was accepted' };
};

/**
 * Is a lane's recorded verification one the restart path may integrate on?
 *
 * Read off the task branch's note (`readLaneVerification`) when `afk auto`
 * starts and finds a committed lane it has no `ready_to_integrate` for — an
 * orchestrator that died between the lane's commit and its state save, or a
 * plain restart. Null (no note, or one that does not parse) is NOT verified:
 * the branch is kept as a recovery patch and rebuilt, never merged on trust.
 */
export const laneVerified = (verification) =>
  Boolean(
    verification &&
    // `afk salvage` re-ran the checks on a commit no agent built, so it has
    // no exit code to report; its `salvage` record stands in for one.
    (verification.agentExitCode === 0 || Boolean(verification.salvage)) &&
    !verification.blocked &&
    // A lane whose build manifest was reverted ran its checks against a tree
    // that manifest no longer describes, so its green covers nothing. The
    // branch is kept as a recovery patch rather than integrated.
    !verification.checksInvalidated?.length &&
    (verification.producedFiles?.length ?? 0) > 0 &&
    (verification.checks ?? []).every((check) => check.skipped || check.code === 0),
  );


