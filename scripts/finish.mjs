// `afk finish` — the end-of-run checklist, in one place.
//
// Everything it does is local and reversible. It does NOT merge the PR, and
// that is a design position rather than caution: the merge is the last human
// checkpoint in a run nobody watched, and every other irreversible boundary
// here is already advisory for the same reason — the closeout review marks
// nothing complete, and a `gate: after` needs a human `--accept`. A runner that
// landed its own work on main would be trusting the agents that wrote the code
// to also decide it ships. So this prints the merge command; you run it.
//
// It reads the closeout review off disk and never spawns one. `afk verify` owns
// that and costs tokens; `finish` stays free and offline.
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configPath, currentRepo, die, ensureDir, existsSync, isMainModule, loadConfig, parseStatusPaths, run, shellQuote } from './lib.mjs';
import { epicCloseSummary } from './scheduler.mjs';
import { readVerifierReport, renderVerifierOutcome } from './verifier.mjs';
import { closeHerdrEpic, mainCheckout } from './runtime-herdr.mjs';
import { dropLaneVerification, listAfkWorktrees, ownedEpicParent, pruneOrphanClaims, teardownWorktree } from './worktree.mjs';

// A lane that is still moving, or about to. Anything else has stopped for good
// — including `failed` and `blocked`, which are reported below as warnings
// rather than blockers: landing the tasks that worked is the operator's call.
const IN_FLIGHT = new Set(['pending', 'running', 'ready_to_integrate', 'integrating']);

const untrackedIn = (worktree) => {
  const result = run('git status --porcelain -uall', { cwd: worktree });
  if (result.status !== 0) return [];
  return result.stdout.split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
};

/**
 * Untracked files sitting in a retained lane worktree — exactly what
 * `pruneLanes` below deletes without ever naming.
 *
 * A failed or blocked lane keeps its worktree deliberately, and a builder whose
 * output is a document rather than code leaves it untracked there. One run's
 * single most valuable artifact — a 138-line device-acceptance checklist, the
 * thing the human needed in hand to close the epic — sat as `?? docs/acceptance/`
 * in a lane, one routine `afk finish` from deletion, with nothing in `afk
 * status` saying so (epic-4 §5). Retaining the worktree is not enough if the
 * next documented command deletes it.
 *
 * `list` and `untracked` are injected so this is testable without a repo, and
 * exported so `afk status` can report the same lanes while the run is going.
 */
export const laneUntracked = (root, { list = listAfkWorktrees, untracked = untrackedIn } = {}) =>
  list(root)
    .map((entry) => {
      const branch = String(entry.branch ?? '').replace('refs/heads/', '');
      const worktree = String(entry.worktree ?? '');
      return {
        taskId: branch.replace(/^afk\/task-/, '') || branch,
        branch,
        worktree,
        files: worktree ? untracked(worktree) : [],
      };
    })
    .filter((lane) => lane.files.length);

/**
 * Why this run cannot be finished yet, in the order a human should fix them.
 *
 * Pure so it can be tested without a repo. `lockPid` is null when no lock file
 * exists; `alive` answers whether that pid is still running, because a lock left
 * by a killed orchestrator must not wedge the command forever. `lanes` is
 * `laneUntracked`'s answer, empty when the operator has said to discard it.
 */
export const finishBlockers = ({ state, lockPid = null, alive = () => false, lanes = [] }) => {
  const blockers = [];
  if (lockPid !== null && alive(lockPid))
    blockers.push(`\`afk auto\` is still running (pid ${lockPid}). Stop it first.`);
  const inFlight = Object.entries(state?.tasks ?? {})
    .filter(([, task]) => IN_FLIGHT.has(task?.lifecycle))
    .map(([id, task]) => `${id} (${task.lifecycle})`);
  if (inFlight.length) blockers.push(`tasks have not finished: ${inFlight.join(', ')}.`);
  const close = epicCloseSummary(state);
  if (close?.outstanding?.length)
    blockers.push(
      `gates awaiting acceptance: ${close.outstanding.join(', ')} — release with \`afk epic <issue> --accept=${close.outstanding.join(',')}\`.`,
    );
  // Last, because it is the only blocker whose fix is "go and look at a file".
  // A blocker rather than a warning: the very next thing this command does is
  // delete these, so a line printed after the fact would be an obituary.
  for (const lane of lanes)
    blockers.push(
      `lane ${lane.taskId} holds ${lane.files.length} untracked file(s) that pruning would delete: `
      + `${lane.files.map((file) => `${lane.worktree}/${file}`).join(', ')} — commit them to ${lane.branch}, `
      + 'copy them out, or rerun with `--discard-untracked`.',
    );
  return blockers;
};

/**
 * Remove every lane worktree and branch the run left behind.
 *
 * `removeTaskWorktree` already runs on a passing task, so on a clean run this
 * finds nothing. What it is for is the other endings: a failed or blocked lane
 * keeps its worktree deliberately, and a branch whose delete was refused only
 * left a warning in the log at the time.
 *
 * The path comes from `git worktree list`, never from `taskWorktree()`. That is
 * why this does not call `removeTaskWorktree`: that function reconstructs the
 * path from the id, so a lane sitting anywhere else — an older layout, another
 * `AFK_WORKTREE_ROOT` — is reported removed while it is still on disk.
 *
 * Branches go with `git branch -d`, never `-D`. An unmerged lane refusing to
 * delete is the correct outcome: that is unlanded work, and it is named in the
 * output instead of being destroyed.
 *
 * `taskIds` scopes the BRANCH pass. `git branch` answers for the repository, so
 * once two epics run from two worktrees of one checkout it lists both epics'
 * lanes — and this would try to delete a sibling epic's live branch, or at best
 * report it as this run's problem. The worktree pass is already scoped by
 * `listAfkWorktrees`. Null means "every `afk/task-*` branch", which is right for
 * the one-epic-per-checkout case and is what a caller without run state gets.
 *
 * `setup` is the project's `worktreeSetup`. Its `finish` hook runs in each
 * worktree BEFORE the worktree is removed (#109): a device a lane's check
 * created is the same kind of leftover as the worktree, and the project's hook
 * needs the path as `$PWD` to name it — which it cannot be once the directory
 * is gone. The hook's exit and output come back as `hooks`, one row per
 * command per lane, for the caller to print; a hook that fails neither stops
 * the next lane's nor keeps the worktree.
 */
export const pruneLanes = (root, taskIds = null, { setup = null } = {}) => {
  const ours = taskIds === null ? null : new Set(taskIds.map(String));
  const removed = [];
  const kept = [];
  const hooks = [];
  for (const entry of listAfkWorktrees(root)) {
    const branch = String(entry.branch).replace('refs/heads/', '');
    const path = String(entry.worktree ?? '');
    for (const hook of teardownWorktree({ worktree: path, setup, hook: 'finish' })) hooks.push({ branch, ...hook });
    const result = run(`git worktree remove --force ${shellQuote(path)}`, { cwd: root });
    if (result.status === 0 || !existsSync(path)) removed.push(`${branch} (worktree)`);
    else kept.push(`${branch} — ${result.stderr.trim() || `cannot remove ${path}`}`);
  }
  // Branch deletion is deliberately a second pass over `git branch`, not part of
  // the loop above: it also catches a branch whose worktree was already gone,
  // and a branch cannot be deleted while a worktree still holds it anyway.
  const listed = run(
    `git branch --list ${shellQuote('afk/task-*')} --format=${shellQuote('%(refname:short)')}`,
    { cwd: root },
  );
  if (listed.status !== 0) kept.push(`branches — cannot list: ${listed.stderr.trim()}`);
  for (const branch of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (ours && !ours.has(branch.replace(/^afk\/task-/, ''))) continue;
    const deletion = run(`git branch -d ${shellQuote(branch)}`, { cwd: root });
    if (deletion.status === 0) {
      removed.push(`${branch} (branch)`);
      dropLaneVerification(root, branch.replace(/^afk\/task-/, ''));
    }
    // First line only: git follows the refusal with two lines of advice, one of
    // which is `git branch -D` — exactly the thing this must not encourage.
    else kept.push(`${branch} — ${deletion.stderr.trim().split('\n')[0] || 'not merged'}`);
  }
  // Repo folders under ~/code/worktrees left holding only a claim on a clone
  // that has since been deleted. Returned apart from `removed`, which callers
  // count as lanes.
  const claims = pruneOrphanClaims();
  return { removed, kept, hooks, claims };
};

/**
 * Remove the epic's own worktree — `afk epic --worktree`'s checkout — and the
 * `<slug>-<id>` directory the runner made to hold it, build output included.
 *
 * Whoever creates the parent deletes it. Lanes already do (`removeTaskWorktree`
 * removes `<id>/`); the epic's parent was left behind, and a project that builds
 * one level outside its checkout (`target-dir = "../.atlas-target"`) left 15–18
 * GB in it per epic: three closed epics, 48 GB, each folder holding only the
 * build directory once the checkout had been removed by hand.
 *
 * `root` is the checkout `finish` runs in. Anything `ownedEpicParent` does not
 * recognise as this epic's is `refused` and left alone — which is also the
 * ordinary answer for a run in the main checkout.
 *
 * Order matters: the `worktreeSetup.finish` hook runs first, so whatever it
 * writes is inside the checks that follow. Then the folder is `kept`, named,
 * and never forced when the checkout holds changes that are not the runner's
 * own (`.afk/` and the `worktreeSetup` link/copy entries), when its HEAD is on
 * no local branch, when `git worktree remove` fails, or when the parent holds
 * anything but build caches once the checkout is gone. Ignored files do not
 * block; the top-level ones that go with the folder are returned as `ignored`
 * so the caller can print them.
 *
 * The run's `.afk/` (state, logs, the closeout review) is copied to the main
 * checkout's `.afk/archive/epic-<id>/` before the delete — the path `afk
 * archive` uses — because the delete would otherwise take the only record of
 * the run with it. A copy that fails keeps the worktree. The epic's branch is
 * not touched: it is the PR.
 *
 * Call it last. It deletes the process's own cwd; git runs from `main` after.
 *
 * `force: false` is the merge verb's (scripts/merge.mjs): it has already
 * checked `git status --porcelain` is empty, and asks git to refuse rather than
 * override anything that appeared since.
 */
export const removeEpicWorktree = ({ root, epicId, setup = null, main = mainCheckout(root), now = Date.now, force = true }) => {
  const parent = ownedEpicParent({ root, main, epicId });
  if (!parent) return { refused: `${root} is not the worktree afk created for epic ${epicId}` };
  const hooks = teardownWorktree({ worktree: root, setup, hook: 'finish' });

  const status = run('git status --porcelain -uall', { cwd: root });
  if (status.status !== 0) return { kept: `${root} — cannot read its status: ${status.stderr.trim()}`, hooks };
  const own = ['.afk', ...(setup?.link ?? []), ...(setup?.copy ?? [])].map((entry) => String(entry).replace(/\/+$/, ''));
  const isOwn = (path) => own.some((entry) => path === entry || path.startsWith(`${entry}/`));
  const foreign = parseStatusPaths(status.stdout).filter((path) => !isOwn(path));
  if (foreign.length)
    return { kept: `${root} — ${foreign.length} uncommitted file(s) that are not the runner's: ${foreign.join(', ')}`, hooks };

  // Fail direction: closed. Commits on no local branch (a detached HEAD) exist
  // only in this checkout's reflog; removing it would orphan them. Not `git
  // branch --contains`: it lists the detached HEAD itself as a branch.
  const contains = run("git for-each-ref --contains HEAD --format='%(refname)' refs/heads", { cwd: root });
  if (contains.status !== 0 || !contains.stdout.trim())
    return { kept: `${root} — its HEAD is on no local branch, so its commits would be unreachable once it is removed`, hooks };

  // Ignored files never block (every build leaves some), but a lost
  // `.env.local` should at least be visible. Build caches and the runner's own
  // entries are not worth naming.
  // `-unormal` keeps an ignored directory to one line instead of one per file.
  // Fail direction: open. This is a listing, not a guard; a failed read names nothing.
  const isCache = (path) => existsSync(resolve(path, 'CACHEDIR.TAG'));
  const ignoredStatus = run('git status --porcelain --ignored -unormal', { cwd: root });
  const ignoredLines = ignoredStatus.stdout.split('\n').filter((line) => line.startsWith('!!')).join('\n');
  const ignored = [...new Set(parseStatusPaths(ignoredLines)
    .map((path) => path.replace(/\/+$/, '').split('/')[0]))]
    .filter((entry) => !isOwn(entry) && !isCache(resolve(root, entry)));

  let archived = null;
  if (existsSync(resolve(root, '.afk'))) {
    archived = resolve(main, '.afk', 'archive', `epic-${epicId}`);
    if (existsSync(archived)) archived = `${archived}-${now()}`;
    try {
      ensureDir(dirname(archived));
      // Fail direction: closed. A collision throws rather than merging this
      // run's record into another's.
      cpSync(resolve(root, '.afk'), archived, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    } catch (error) {
      return { kept: `${root} — could not copy its .afk/ to ${archived} (${error.message}); nothing deleted`, hooks };
    }
  }

  // Fail direction: closed. A worktree git will not remove (locked, say) keeps
  // its parent: git's refusal is the only word on why, and rm would override it.
  const remove = run(`git worktree remove${force ? ' --force' : ''} ${shellQuote(root)}`, { cwd: main });
  if (remove.status !== 0)
    return { kept: `${parent} — git worktree remove failed: ${String(remove.stderr || remove.stdout).trim()}`, archived, hooks };

  // Fail direction: closed. Two clones can share one slug (/x/a-b and /x/a/b
  // both make `x-a-b-<id>`), so the parent may hold another epic's checkout.
  // Only build caches may remain beside ours; anything else keeps the parent.
  if (existsSync(parent)) {
    const others = readdirSync(parent).filter((entry) => !isCache(resolve(parent, entry)));
    if (others.length)
      return { kept: `${parent} — the checkout was removed, but the folder also holds ${others.join(', ')}, which are not build caches`, archived, hooks, ignored };
  }
  try {
    rmSync(parent, { recursive: true, force: true });
  } catch (error) {
    return { kept: `${parent} — ${error.message}`, archived, hooks, ignored };
  }
  return existsSync(parent)
    ? { kept: `${parent} — still on disk after removal`, archived, hooks, ignored }
    : { removed: parent, archived, hooks, ignored };
};

/**
 * What `finish` prints for each `worktreeSetup.finish` hook it ran: the exit
 * code, and the hook's own output — the runner does not know what the hook
 * deleted or kept, so the hook's stdout is the only listing there is.
 */
export const renderFinishHooks = (hooks) =>
  hooks.map((hook) =>
    `FINISH: finish hook ${hook.branch}: ${hook.command} → ${hook.status === null ? hook.output : `exit ${hook.status}`}`
    + (hook.status !== null && hook.output ? `\n${hook.output.split('\n').map((line) => `  ${line}`).join('\n')}` : ''));

/**
 * The commit the feature branch points at right now, or null when it cannot be
 * resolved (no branch recorded, or the ref is gone). This is the other half of
 * the staleness check in `renderVerifierOutcome`: the report knows which commit
 * it read, and only the repository knows which one is current.
 */
export const branchHead = (root, branch) => {
  const ref = branch || 'HEAD';
  const result = run(`git rev-parse --verify --quiet ${shellQuote(ref)}`, { cwd: root });
  return result.status === 0 ? result.stdout.trim() || null : null;
};

/**
 * What `finish` prints about the closeout review. Exported so the staleness
 * path is testable without a repo or a run — `cli` below only supplies the
 * arguments.
 */
export const renderCloseoutReview = (report, epicId, currentHead = null) =>
  report
    ? renderVerifierOutcome(report, currentHead)
    : `FINISH: no closeout review on disk. Run \`afk verify ${epicId}\` before merging.`;

const cli = async () => {
  const root = process.cwd();
  const lockPath = resolve(root, '.afk', 'orchestrator.lock');
  const lockPid = existsSync(lockPath) ? Number(readFileSync(lockPath, 'utf8').trim()) : null;

  let state = null;
  try {
    state = JSON.parse(readFileSync(resolve(root, '.afk', 'state.json'), 'utf8'));
  } catch {}
  if (!state?.dag) die('No run in this project (.afk/state.json is missing). Nothing to finish.');

  const blockers = finishBlockers({
    state,
    lockPid,
    alive: (pid) => Number.isInteger(pid) && pid > 0 && run(`kill -0 ${pid}`).status === 0,
    lanes: process.argv.includes('--discard-untracked') ? [] : laneUntracked(root),
  });
  if (blockers.length) {
    for (const blocker of blockers) console.error(`FINISH: ${blocker}`);
    return 1;
  }
  if (lockPid !== null) rmSync(lockPath, { force: true });

  const epicId = state.dag.epic?.id ?? state.dag.epic;
  const branch = state.dag.branch ?? state.branch ?? null;

  const unhappy = Object.entries(state.tasks ?? {})
    .filter(([, task]) => task?.lifecycle !== 'passed')
    .map(([id, task]) => `${id} (${task.lifecycle})`);
  if (unhappy.length) console.log(`FINISH: not every task passed — ${unhappy.join(', ')}.`);

  const report = readVerifierReport(root, epicId);
  console.log(renderCloseoutReview(report, epicId, branchHead(root, branch)));

  let setup = null;
  try {
    setup = existsSync(configPath(root)) ? loadConfig(root).worktreeSetup ?? null : null;
  } catch (error) {
    console.log(`FINISH: .afk-setup/config.yaml did not load (${error.message}); worktreeSetup.finish hooks will not run.`);
  }
  const { removed, kept, hooks, claims } = pruneLanes(root, Object.keys(state.tasks ?? {}), { setup });
  console.log(`FINISH: pruned ${removed.length} lane(s)${removed.length ? `: ${removed.join(', ')}` : ''}.`);
  if (claims.length) console.log(`FINISH: removed ${claims.length} orphan repo claim(s): ${claims.join(', ')}.`);
  for (const line of kept) console.log(`FINISH: retained ${line}`);
  for (const line of renderFinishHooks(hooks)) console.log(line);
  // The herdr side of pruning. A runner that closed the epic has already
  // closed the integrator's workspace, so a clean run prints zeros; a runner
  // that died before its close leaves that pane (and its broker) at the prompt
  // until something closes it (#111). Lane workspaces go here too: a failed
  // lane's pane was kept beside its retained worktree, and this is the command
  // that prunes the worktree. The count is printed either way, so an orphan is
  // visible here rather than in `ps`.
  const reaped = (await closeHerdrEpic(root, { lanes: true })) ?? { panes: 0, workspaces: 0 };
  console.log(`FINISH: herdr: closed ${reaped.panes} pane(s), ${reaped.workspaces} workspace(s).`);

  // --push is the human's on-demand trigger and intentionally ignores the `pr:`
  // config mode — a human who types `--push` has decided they want the push
  // regardless of whether the run was configured to push automatically.
  if (process.argv.includes('--push')) {
    if (!branch) {
      console.log('FINISH: no branch recorded in state — nothing to push.');
    } else {
      const { ensureDraftPr, persistPrDelivery, renderPrOutcome } = await import('./pr.mjs');
      const repo = currentRepo(root);
      const baseBranch = state.dag?.baseBranch ?? state.epicBase ?? 'main';
      const outcome = ensureDraftPr({
        root,
        repo,
        branch,
        baseBranch,
        epic: state.epic ?? state.dag?.epic ?? {},
        dag: state.dag ?? { tasks: [] },
        state,
        verifierReport: report ?? undefined,
      });
      const line = renderPrOutcome(outcome);
      if (line) console.log(`FINISH: ${line}`);
      for (const warning of outcome.warnings ?? []) console.log(`FINISH: ${warning}`);
      persistPrDelivery(root, outcome);
    }
  }

  // Last: it deletes this process's cwd. Kept when a task did not pass, because
  // rerunning `afk epic --worktree` resumes from this checkout and its `.afk/`.
  const main = mainCheckout(root);
  const epicParent = ownedEpicParent({ root, main, epicId });
  if (epicParent) {
    if (unhappy.length) {
      console.log(`FINISH: retained epic worktree ${root} — not every task passed, and a rerun of \`afk epic --worktree\` resumes from it. To remove it by hand:`);
      console.log(`  git worktree remove ${shellQuote(root)}`);
      console.log(`  rm -rf ${shellQuote(epicParent)}`);
    } else if (!Object.keys(state.tasks ?? {}).length) {
      // Fail direction: closed. No tasks means nothing proves the run finished.
      console.log(`FINISH: retained epic worktree ${root} — state lists no tasks, so nothing shows the run finished.`);
    } else {
      const epicCleanup = removeEpicWorktree({ root, epicId, setup, main });
      for (const line of renderFinishHooks((epicCleanup.hooks ?? []).map((hook) => ({ branch: 'epic worktree', ...hook }))))
        console.log(line);
      if (epicCleanup.archived) console.log(`FINISH: copied the run's .afk/ to ${epicCleanup.archived}.`);
      if (epicCleanup.ignored?.length) console.log(`FINISH: ignored files deleted with the epic worktree: ${epicCleanup.ignored.join(', ')}`);
      if (epicCleanup.removed) console.log(`FINISH: removed epic worktree ${epicCleanup.removed} (checkout and build output). Your shell was in it: cd ${main}`);
      else console.log(`FINISH: retained epic worktree ${epicCleanup.kept}`);
    }
  }

  console.log('FINISH: nothing was merged. When the review above satisfies you:');
  console.log(branch ? `  gh pr merge ${branch}` : '  gh pr merge <branch>');
  return 0;
};

// Not a top-level await: scripts/epic.mjs documents why one deadlocks a
// dynamic import in this repo. Same shape as verifier.mjs.
if (isMainModule(import.meta.url)) {
  cli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`FINISH: ${error.message}`);
      process.exitCode = 1;
    });
}
