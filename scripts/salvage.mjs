// `afk salvage <id> [--commit=<sha>]` — integrate a lane branch someone fixed
// after its builder finished, without rebuilding it.
//
// The restart path integrates a committed lane only when its branch TIP carries
// a verification note (`readLaneVerification`, `laneVerified`). A fix committed
// on top of the builder's commit has none, so `afk reset` alone threw the fix
// away and started a new builder. The hand recovery on Riverbend #109 task 110
// was `git notes copy <builder> <fix>`, which put a record of checks run on the
// builder commit onto a commit they never saw. This re-runs the lane's checks
// at the tip, attaches a fresh note there, and marks the task
// `ready_to_integrate`, so a relaunch merges the fix and the post-merge gate is
// not the only check it ever met.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  atomicWrite, checkFailed, checkFailureReason, checkResult, checkTimeoutMs, die, ensureDir, existsSync,
  isMainModule, isRustCheck, loadConfig, normalizeId, parseArgv, root as cwdRoot, run, runAsync,
  shellQuote, shouldSkipRustChecks,
} from './lib.mjs';
import { AWAITING_ACCEPTANCE, TASK_SUCCESS, clearTaskRuntime, laneVerified, lifecycleOf } from './scheduler.mjs';
import {
  attachLaneVerification, changedPaths, createTaskWorktree, laneVerificationRef, readLaneVerification, taskBranch,
  taskWorktree,
} from './worktree.mjs';
import { coerceLesson as coerceLessonObject, lessonFlagUsage, parseLessonFlag } from './fixer.mjs';
import { recordSalvageLesson } from './defects.mjs';

const git = (root, command) => run(`git ${command}`, { cwd: root });
const revParse = (root, rev) => {
  const result = git(root, `rev-parse --verify --quiet ${shellQuote(`${rev}^{commit}`)}`);
  return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * The nearest commit on `tip`'s first-parent line that carries this task's
 * note, and the note. That is the builder's record: the only place the task's
 * own `checks:` survive, because `state.dag` keeps the shape and not the gate.
 */
const priorNote = (root, id, tip) => {
  const ref = shellQuote(laneVerificationRef(id));
  const noted = new Set(git(root, `notes --ref=${ref} list`).stdout.split('\n')
    .map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
  if (!noted.size) return null;
  // Bounded: the builder's commit sits a few hand fixes below the tip, and an
  // unbounded walk of a long history overflows run()'s output buffer.
  for (const commit of git(root, `rev-list --first-parent --max-count=1000 ${shellQuote(tip)}`).stdout.split('\n')) {
    if (!noted.has(commit)) continue;
    try {
      return { commit, note: JSON.parse(git(root, `notes --ref=${ref} show ${shellQuote(commit)}`).stdout) };
    } catch {
      return { commit, note: null };
    }
  }
  return null;
};

/**
 * Re-verify task `id`'s lane at its branch tip and hand it back to the Runner.
 *
 * Refuses, changing nothing, while `afk auto` holds the lock, when the task
 * already succeeded (or awaits acceptance), when a dependency has not
 * succeeded, when `commit` is given and is not the tip, when the note on the
 * branch's history does not parse, when the lane has no work over its base,
 * when its worktree is dirty or cannot be set up, when the branch moves while
 * the checks run, or when there is no check to run. A red check writes no note
 * and leaves state alone. A tip that already carries a verified note runs no
 * checks and keeps its note; the task is only marked `ready_to_integrate`.
 *
 * `lesson` is required (#215), in `--lesson` spelling (`parseLessonFlag`) or
 * as a lesson object. A hand fix is a defect caught mid-run; it is recorded in
 * `state.midRunDefects` with this lesson, and the closeout lists it.
 *
 * @returns {Promise<{ok: boolean, message: string, verification?: object}>}
 */
export const salvageLane = async ({ root = cwdRoot, id: rawId, commit = null, config = null, lesson: rawLesson = null, say = console.log }) => {
  const id = normalizeId(rawId);
  const refuse = (message) => ({ ok: false, message: `SALVAGE: ${message}` });
  // Fails CLOSED, first: a defect fixed by hand with no lesson is caught again
  // next epic, and asking costs one flag. The shapes are the fixer's own
  // `LESSON_FIELDS`, so a salvage lesson and a fixer lesson render alike.
  const lesson = typeof rawLesson === 'string' ? parseLessonFlag(rawLesson) : coerceLessonObject(rawLesson);
  if (!lesson)
    return refuse(`a salvage needs a lesson: the defect this commit fixes either becomes a rule, a standard, or says why not. Pass ${lessonFlagUsage()}.${typeof rawLesson === 'string' && rawLesson ? ` \`${rawLesson}\` is not one of these.` : ''}`);
  if (existsSync(resolve(root, '.afk/orchestrator.lock')))
    return refuse('cannot salvage while `afk auto` owns runtime state. Stop it first.');
  const statePath = resolve(root, '.afk/state.json');
  let state = null;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  if (!state?.tasks) return refuse('no runtime state (.afk/state.json is missing).');
  const runtime = state.tasks[id];
  if (!runtime) return refuse(`unknown task ${id}.`);
  if (TASK_SUCCESS.has(runtime.lifecycle) || runtime.lifecycle === AWAITING_ACCEPTANCE)
    return refuse(`task ${id} is ${runtime.lifecycle}; there is nothing to salvage.`);
  // A lane merged ahead of a dependency integrates out of order. `state.dag`
  // is written by every `afk auto` start; a state file from before it has
  // none, and then this check is skipped rather than refusing every salvage.
  const shaped = state.dag?.tasks?.find((task) => task.id === id);
  const unmet = (shaped?.dependsOn ?? []).filter((dep) => !TASK_SUCCESS.has(lifecycleOf(dep, state)));
  if (unmet.length)
    return refuse(`task ${id} waits on dependencies that have not succeeded: ${unmet.map((dep) => `${dep} (${lifecycleOf(dep, state)})`).join(', ')}. Salvage or rebuild those first.`);

  const branch = taskBranch(id);
  const tip = revParse(root, branch);
  if (!tip) return refuse(`${branch} does not exist.`);
  if (commit) {
    const wanted = revParse(root, commit);
    if (!wanted) return refuse(`--commit=${commit} is not a commit.`);
    // The note is read off the tip and nowhere else, so verifying any other
    // commit would write a record nothing reads.
    if (wanted !== tip)
      return refuse(`${branch} is at ${tip.slice(0, 8)}, not ${wanted.slice(0, 8)}. Move the branch first (\`git branch -f ${branch} ${wanted.slice(0, 8)}\`), then salvage.`);
  }

  // What `afk reset` clears, then the record the restart path re-queues on:
  // a `ready_to_integrate` whose branch tip is its `commitSha`. That re-queue
  // needs the branch, not the worktree.
  const markReady = (fields, verification) => {
    runtime.lifecycle = 'ready_to_integrate';
    clearTaskRuntime(state, id);
    Object.assign(runtime, {
      branch, commitSha: tip, ...fields,
      taskVerification: { ...verification, checks: (verification.checks ?? []).map((check) => ({ ...check, ...(typeof check.output === 'string' ? { output: check.output.slice(-4000) } : {}) })) },
    });
    delete runtime.blockedBy;
    delete runtime.diskFull;
    recordSalvageLesson(state, { taskId: id, commit: tip, lesson });
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  // A check over a dirty tree verifies something other than the commit, and a
  // verified tip marked ready with edits left uncommitted merges without them;
  // the lane worktree is then force-removed and the edits are gone. Read before
  // both, and BEFORE the bootstrap below, which writes the project's own setup
  // files and would otherwise refuse every salvage on output nobody authored.
  const existing = taskWorktree(root, id);
  if (existsSync(existing)) {
    const dirty = changedPaths(existing);
    if (dirty.length)
      return refuse(`the lane worktree ${existing} has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). `
        + 'Commit them on the lane branch (this is the case the supervisor\'s "salvage" finding points at) or discard them, then salvage.');
  }

  // An already-verified tip is not re-checked and its note is not touched:
  // `notes add -f` would replace the builder's record with this one. It may
  // still need marking: an `integration_failed` task whose worktree was pruned
  // is seen by neither the restart sweep (registered worktrees only) nor the
  // re-queue (`ready_to_integrate` only), so a relaunch alone never merges it.
  const tipNote = readLaneVerification(root, id, branch);
  if (laneVerified(tipNote)) {
    markReady({ worktree: tipNote.worktree ?? taskWorktree(root, id), baseSha: tipNote.baseSha ?? runtime.baseSha ?? null }, tipNote);
    return {
      ok: true,
      verification: tipNote,
      message: `SALVAGE: ${id}: ${branch} at ${tip.slice(0, 8)} already carries a verified note; ran no checks, kept that note, and marked it ready_to_integrate. Relaunch the run to merge it.`,
    };
  }

  config ??= loadConfig(root);
  const prior = priorNote(root, id, tip);
  // Fails CLOSED. A note that does not parse is the builder's record of the
  // task's own checks, lost; falling back to defaultChecks would verify the
  // lane against a gate weaker than the one it was built under, and mark it
  // mergeable on that. Refusing costs a human one look at the note.
  if (prior && !prior.note)
    return refuse(`the verification note on ${prior.commit.slice(0, 8)} (${laneVerificationRef(id)}) does not parse, so the task's own checks are unknown. Repair or remove that note, then salvage.`);
  const priorChecks = [...new Set((prior?.note?.checks ?? []).map((check) => check.command).filter(Boolean))];
  const commands = priorChecks.length ? priorChecks : [...(config.defaultChecks ?? [])];
  // The house rule `normalizeDag` follows: a lane with no gate is not merged.
  if (!commands.length)
    return refuse(`no checks to run: no verification note on ${branch}'s history, and .afk-setup/config.yaml sets no defaultChecks.`);
  const checksFrom = priorChecks.length ? `the note on ${prior.commit.slice(0, 8)}` : 'defaultChecks (no note on this branch names the task\'s own checks)';

  // Merge-base first: after a human rebases the lane or merges the run branch
  // into it, the builder's recorded base is stale and `produced` would count
  // the run branch's own files. The restart sweep measures it the same way.
  const mergeBase = state.branch ? git(root, `merge-base ${shellQuote(state.branch)} ${shellQuote(tip)}`).stdout.trim() : '';
  const baseSha = mergeBase || prior?.note?.baseSha || runtime.baseSha || null;
  if (!baseSha) return refuse(`cannot tell where ${branch} forked; no note, no baseSha in state, no run branch to measure from.`);
  const produced = git(root, `diff --name-only ${shellQuote(baseSha)} ${shellQuote(tip)}`).stdout.split('\n').filter(Boolean);
  if (!produced.length) return refuse(`${branch} changes nothing over ${baseSha.slice(0, 8)}; there is nothing to integrate.`);

  let worktree;
  try {
    ({ worktree } = createTaskWorktree({ root, id, baseSha, setup: config.worktreeSetup }));
  } catch (error) {
    // Most often the branch is checked out in the checkout the human fixed it
    // in, and git will not check one branch out twice.
    return refuse(`cannot set up the lane worktree: ${String(error.message).trim()} Switch that checkout off ${branch}, then salvage.`);
  }

  say(`SALVAGE: ${id}: running ${commands.length} check(s) from ${checksFrom} at ${tip.slice(0, 8)} in ${worktree}.`);
  const checks = [];
  const skipRust = shouldSkipRustChecks(produced);
  const timeout = checkTimeoutMs(config);
  for (const command of commands) {
    if (skipRust && isRustCheck(command)) {
      checks.push({ command, skipped: true, code: null, reason: 'run changed no Rust' });
      continue;
    }
    const result = await runAsync(command, {
      cwd: worktree,
      timeout,
      env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH}` },
    });
    checks.push(checkResult(command, result, timeout));
    say(`SALVAGE: ${id}: ${checkFailed(checks.at(-1)) ? 'FAIL' : 'pass'} ${command}`);
    if (checkFailed(checks.at(-1)))
      return refuse(`${checkFailureReason(checks.at(-1))}. No note written; ${branch} and state are unchanged.\n${checks.at(-1).output.slice(-2000)}`);
  }

  // The note goes on the worktree's HEAD, so it must still be the commit the
  // checks ran on. A commit landed during a 30-minute check would otherwise
  // take a record of checks it never met.
  const head = revParse(worktree, 'HEAD');
  if (head !== tip || revParse(root, branch) !== tip)
    return refuse(`${branch} moved from ${tip.slice(0, 8)} while the checks ran. No note written; salvage again.`);

  const verification = {
    taskId: id, branch, worktree, baseSha, commitSha: tip,
    // No agent built this commit, so no agent fields: `laneVerified` accepts a
    // `salvage` record in place of a builder's exit code. `from` is the
    // builder's commit, whose own note still says who built that.
    salvage: { at: new Date().toISOString(), from: prior?.commit ?? null, checksFrom: priorChecks.length ? 'note' : 'defaultChecks' },
    agent: null,
    agentExitCode: null,
    blocked: false,
    producedFiles: produced,
    checks,
  };
  const file = resolve(root, '.afk', 'runs', id, 'salvage-verification.json');
  ensureDir(resolve(file, '..'));
  atomicWrite(file, `${JSON.stringify(verification, null, 2)}\n`);
  const noteError = attachLaneVerification({ worktree, id, file });
  if (noteError) return refuse(`checks passed but the note could not be attached to ${tip.slice(0, 8)}: ${noteError}. State is unchanged.`);

  markReady({ worktree, baseSha }, verification);
  return {
    ok: true,
    verification,
    message: `SALVAGE: ${id}: verified ${branch} at ${tip.slice(0, 8)} and marked it ready_to_integrate. Relaunch the run to merge it.`,
  };
};

if (isMainModule(import.meta.url)) {
  let parsed;
  try { parsed = parseArgv(process.argv.slice(2), ['commit', 'lesson'], { command: 'salvage' }); } catch (error) {
    die(error.message);
  }
  const [id] = parsed.positional;
  if (!id || parsed.flags.commit === true) die(`Usage: afk salvage <task-id> [--commit=<sha>] ${lessonFlagUsage()}`);
  const result = await salvageLane({ id, commit: parsed.flags.commit ?? null, lesson: parsed.flags.lesson === true ? '' : parsed.flags.lesson ?? null });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
