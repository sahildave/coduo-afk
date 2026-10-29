import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  atomicWrite, buildAgentCommand, checkFailed, checkFailureReason, checkResult,
  checkTimeoutMs, ensureDir,
  parseStatusPaths, run, runAsync, shellQuote,
} from './lib.mjs';
import { agentEvidence } from './worker.mjs';
import { finalText, parseStream } from './agent-stats.mjs';
import { modelCheck } from './model-check.mjs';
import { roleAgent, roleFor, rolePrompt } from './roles.mjs';
import { runHerdrRole } from './runtime-herdr.mjs';
import { gitMetadataDirs } from './worktree.mjs';
import { recordGate } from './measure.mjs';
import { withGateLock } from './gate-lock.mjs';
import { classifyGateFailure } from './supervisor.mjs';

const LIMIT_RE = /(session[ _]limit|usage[ _]limit|rate[ _]limit|quota[ _]exceeded|too many requests|agent[ _]limit|resets? (at )?\d)/i;
// Binary blobs in the merge prompt once produced a ~1.34M-token request against a
// 1M limit — both attempts died instantly on a merge a human finished in minutes.
// Plain `git diff` renders binaries as one "Binary files differ" line; past this
// budget the merger gets the file list instead of the patch.
const DIFF_CHAR_BUDGET = 400_000;
const MERGE_LEFTOVER_RE = /\.(orig|rej|BACKUP\.\d+|BASE\.\d+|LOCAL\.\d+|REMOTE\.\d+)$/;

export const untrackedPaths = (root) =>
  run('git ls-files --others --exclude-standard', { cwd: root })
    .stdout.split('\n').filter(Boolean);

/**
 * Put `main` back the way the merger found it.
 *
 * `preserved` is the untracked file list captured before this integration
 * started; everything untracked that is NOT in it was written by the merger and
 * is removed. Omit it and only Git's own merge leftovers go — a caller that
 * cannot say what pre-existed must not guess. This replaces a `git clean -fdq -e
 * .afk` that destroyed every untracked file in the repo, twice deleting real
 * task specs with nothing in the log to say so.
 */
const restoreMain = (root, integrationBase, preserved) => {
  // An empty base is a `git rev-parse` that failed upstream (a spawn that could
  // not start reads as empty stdout since #136). Fail closed: a reset to an
  // unknown target is the one move here that can lose work.
  if (!integrationBase) throw new Error('Refusing to restore main: no integration base was recorded.');
  run('git merge --abort', { cwd: root });
  const reset = run(`git reset --hard ${shellQuote(integrationBase)}`, { cwd: root });
  if (reset.status !== 0) throw new Error(`Failed to restore main to ${integrationBase}: ${reset.stderr}`);
  const keep = preserved ? new Set(preserved) : null;
  const removed = untrackedPaths(root).filter((file) => !file.startsWith('.afk/')
    && (keep ? !keep.has(file) : MERGE_LEFTOVER_RE.test(file)));
  // Files only, so an untracked directory the merger half-filled may be left
  // behind empty. Git ignores empty directories, so no check sees it as dirt.
  for (const file of removed) rmSync(resolve(root, file), { recursive: true, force: true });
  return removed;
};

// The post-merge gate: the task's own checks, plus whatever the stack insists on
// re-running against the merged tree. Deliberately NO `task.checks ?? []` — that
// fallback is how a task that reached integration without resolved checks merged
// having run ZERO post-merge commands, and said nothing. `checks` is resolved at
// the DAG boundary (normalizeDag in auto.mjs), which refuses to admit a task
// whose resolved list is empty, so this list is non-empty by construction; a
// task arriving here without one bypassed that boundary and should throw, loudly,
// before the merge is blessed rather than after.
//
// `integrationChecks`, when set, replaces the baseline chain here: a project
// whose full chain is minutes long runs it at the baseline and at closeout
// (`runCloseoutGate` then gates the tip even with no fix commit) instead of once
// per integrated task. `[]` means the task's own checks only.
export const postMergeChecks = (task, config) => [
  ...new Set([...task.checks, ...(config.integrationChecks ?? config.baselineChecks ?? config.defaultChecks ?? [])]),
];

export const runIntegration = async ({ root, config, epic = null, say = console.log, task, branch, baseSha, baseBranch = 'main', attempt, taskVerification, onPid = () => {}, onCheckRerun = () => {} }) => {
  const baseRead = run('git rev-parse HEAD', { cwd: root });
  const tipRead = run(`git rev-parse ${shellQuote(branch)}`, { cwd: root });
  const integrationBase = baseRead.status === 0 ? baseRead.stdout.trim() : '';
  const taskTip = tipRead.status === 0 ? tipRead.stdout.trim() : '';
  // Fail closed and loud, before anything is merged: an empty sha here used to
  // flow into the merge and into `restoreMain`'s reset (#144 review). Nothing
  // has touched main yet, so there is nothing to restore.
  if (!integrationBase || !taskTip) {
    const failureReason = !integrationBase
      ? `cannot read HEAD: ${baseRead.stderr.trim()}`
      : `cannot resolve ${branch}: ${tipRead.stderr.trim()}`;
    return {
      outcome: 'integration_failed',
      verification: { taskId: task.id, attempt, branch, passed: false, failureReason },
      integrationBase: integrationBase || null,
      failureReason,
      removed: [],
    };
  }
  const runDir = resolve(root, '.afk', 'runs', task.id, `integration-${attempt}`);
  ensureDir(runDir);
  // Untracked files that were already here. They are the user's, not this
  // integration's: never cleaned on rollback, never counted as a dirty tree.
  const preexistingUntracked = untrackedPaths(root);
  const preexisting = new Set(preexistingUntracked);
  const streamPath = resolve(runDir, 'stream.jsonl');
  const role = roleFor('integrator');
  const agent = roleAgent(role, config);
  const metadataDirs = gitMetadataDirs(root);

  // Every epic's FIRST integration is a fast-forward, by construction: the
  // feature branch still sits at its own base commit, so the task tip is a
  // descendant of it and git has NOTHING to reconcile. Rejecting that shape cost
  // epic #4 four of five tasks — a root's blast radius of 3 went down with it,
  // the epic closed incomplete, and the closeout verifier was suppressed — and
  // cost epic #5 its fastest root task. Because the condition is fully
  // deterministic, the retry 60 seconds later re-ran an identical state and
  // failed identically: pure waste.
  //
  // The runner wants a real merge commit as its rollback anchor, and `--no-ff`
  // is exactly how you ask git for one. It is safe here precisely because the
  // merge is trivial. So do it in-process: no agent session is spent on a merge
  // with no conflict to resolve, and the deterministic "fast-forward, not a real
  // merge" failure never has to be retried because it never happens.
  const fastForward = Boolean(taskTip)
    && run(
      `git merge-base --is-ancestor ${shellQuote(integrationBase)} ${shellQuote(taskTip)}`,
      { cwd: root },
    ).status === 0;

  let agentResult;
  let diffTruncated = false;
  let raw = '';
  if (fastForward) {
    // No agent, so no child pid — but integrationBase must still publish so
    // concurrent builders keep branching from the pre-merge snapshot.
    onPid(null, integrationBase);
    const message = `Merge task ${task.id}${task.title ? `: ${task.title}` : ''}`;
    const merged = run(
      `git merge --no-ff --no-edit -m ${shellQuote(message)} ${shellQuote(branch)}`,
      { cwd: root },
    );
    agentResult = { status: merged.status, timedOut: false };
    atomicWrite(
      resolve(runDir, 'agent-output.log'),
      `No merger ran: ${branch} is a fast-forward onto ${integrationBase}, so afk `
      + `created the merge commit itself with --no-ff.\n${merged.stdout}${merged.stderr}`,
    );
  } else {
    const taskText = task.body ?? '';
    const range = `${shellQuote(integrationBase)}...${shellQuote(branch)}`;
    const diffResult = run(`git diff ${range}`, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    diffTruncated = diffResult.stdout.length > DIFF_CHAR_BUDGET;
    const diff = diffTruncated
      ? `${run(`git diff --stat ${range}`, { cwd: root, maxBuffer: 10 * 1024 * 1024 }).stdout}\n`
        + `[Patch omitted: ${diffResult.stdout.length} characters exceeds the prompt budget. Read the branch with git.]`
      : diffResult.stdout;
    const promptPath = resolve(runDir, 'prompt.md');
    atomicWrite(promptPath, rolePrompt(role, config, { task, taskText, branch, baseSha, baseBranch, integrationBase, taskVerification, diff }));

    const runtime = config.agent?.runtime || 'direct';
    if (runtime === 'herdr') {
      // No child pid in a pane, but integrationBase must still publish so
      // concurrent builders keep branching from the pre-merge snapshot.
      onPid(null, integrationBase);
      agentResult = await runHerdrRole({
        role,
        root,
        task,
        agent,
        promptPath,
        attempt,
        onPid: (pid) => onPid(pid, integrationBase),
      });
    } else {
      const command = buildAgentCommand(agent, {
        nodeBin: process.execPath.replace(/\/node$/, ''), promptPath, streamPath,
        taskId: task.id, processName: role.processName(task.id),
        cwd: root,
        // The integrator's extra writable paths. Empty when git names none: a
        // merge that then fails on a lock file is recoverable, while granting
        // the wrong directory would widen the sandbox.
        addDirs: metadataDirs ?? [],
      });
      agentResult = await runAsync(command, {
        cwd: root,
        timeout: agent.timeoutMs,
        onSpawn: (child) => onPid(child.pid, integrationBase),
      });
    }
    try { raw = readFileSync(streamPath, 'utf8'); } catch {}
    atomicWrite(resolve(runDir, 'agent-output.log'), finalText(raw) || raw.slice(0, 4000));
  }
  const stats = parseStream(raw);
  const rateLimited = stats.apiErrorStatus === 429
    || stats.rateLimit?.status === 'rejected'
    || (raw.length <= 600 && LIMIT_RE.test(raw));

  const inspectHead = () => {
    const conflicts = run('git diff --name-only --diff-filter=U', { cwd: root }).stdout.trim().split('\n').filter(Boolean);
    const head = run('git rev-parse HEAD', { cwd: root }).stdout.trim();
    const parents = head ? run(`git rev-list --parents -n 1 ${shellQuote(head)}`, { cwd: root }).stdout.trim().split(/\s+/).slice(1) : [];
    const containsTask = taskTip && run(`git merge-base --is-ancestor ${shellQuote(taskTip)} HEAD`, { cwd: root }).status === 0;
    // An unrelated untracked file sitting in the tree once failed an integration
    // whose conflicts were resolved correctly and whose checks would have passed.
    // Only dirt this integration introduced counts.
    const dirtyBeforeChecks = parseStatusPaths(run('git status --porcelain -uall', { cwd: root }).stdout)
      .filter((file) => !preexisting.has(file));
    return { conflicts, head, parents, containsTask, dirtyBeforeChecks };
  };
  let { conflicts, head, parents, containsTask, dirtyBeforeChecks } = inspectHead();
  // A merger that fast-forwarded instead of merging (#145, epic #841 task 849):
  // the history holds the task, the tree is clean, nothing conflicted, and the
  // one thing missing is the two-parent commit the runner rolls back to. That
  // was rejected as "a fast-forward, not a real merge" before a single check
  // ran, and requeued behind two lanes for 27 minutes. The runner now makes the
  // commit itself from `integrationBase`, as the in-process path above does.
  // Fails closed: a redo that does not come out a clean two-parent merge is
  // rolled back by the same gate below, with its own reason.
  let redoneNoFf = null;
  if (!rateLimited && agentResult.status === 0 && parents.length === 1 && containsTask
    && !conflicts.length && dirtyBeforeChecks.length === 0) {
    run(`git reset --hard ${shellQuote(integrationBase)}`, { cwd: root });
    const message = `Merge task ${task.id}${task.title ? `: ${task.title}` : ''}`;
    const redo = run(
      `git merge --no-ff --no-edit -m ${shellQuote(message)} ${shellQuote(branch)}`,
      { cwd: root },
    );
    redoneNoFf = { singleParentHead: head, exitCode: redo.status };
    ({ conflicts, head, parents, containsTask, dirtyBeforeChecks } = inspectHead());
  }
  const cleanBeforeChecks = dirtyBeforeChecks.length === 0;
  let ok = !rateLimited && agentResult.status === 0 && !redoneNoFf?.exitCode && head !== integrationBase && parents.length >= 2 && parents[0] === integrationBase && containsTask && !conflicts.length && cleanBeforeChecks;
  // Why this integration is being rolled back, in words, so the orchestrator log
  // carries the reason instead of hiding it inside verification.json.
  let failureReason = agentResult.agentStillRunning ? 'merger agent is still running in its Herdr pane'
    : rateLimited ? 'rate limited'
    : agentResult.timedOut ? `merger timed out after ${agent.timeoutMs}ms`
    : agentResult.status !== 0
      ? (fastForward ? `--no-ff merge exited ${agentResult.status}` : `merger exited ${agentResult.status}`)
    // Not "fast-forwarded": a merger that linearised a CONFLICTING merge leaves
    // the same one-parent shape, and only the redo tells the two apart.
    : redoneNoFf?.exitCode ? `the merger left a one-parent commit instead of a merge (${redoneNoFf.singleParentHead.slice(0, 12)}), and the --no-ff redo exited ${redoneNoFf.exitCode}${conflicts.length ? ` with conflicts: ${conflicts.join(', ')}` : ''}`
    : conflicts.length ? `unresolved conflicts: ${conflicts.join(', ')}`
    : head === integrationBase ? 'merger produced no commit'
    : parents.length < 2 ? 'merge commit is a fast-forward, not a real merge'
    // HEAD^1 is the rollback anchor and the base `--changed HEAD^1` diffs from.
    : parents[0] !== integrationBase ? `merge commit's first parent is ${parents[0].slice(0, 12)}, not the integration base ${integrationBase.slice(0, 12)} (merged from the task side)`
    : !containsTask ? 'resulting history does not contain the task branch tip'
    : !cleanBeforeChecks ? `merger left the tree dirty: ${dirtyBeforeChecks.join(', ')}`
    : null;

  const checks = [];
  // Each check that failed on the merged tree and was run a second time
  // (#176). The merge was clean, so a fresh merger would rebuild the same tree
  // — five of five whole-integration retries on disk failed again the same way.
  // One more run of just the failed command is the only retry that can differ.
  // `checks` keeps one entry per command, the re-run's: every reader of it
  // (the dashboard, the wave digest) asks "did a check fail?", and a first run
  // the re-run overturned would answer yes on a passed integration.
  const checkReruns = [];
  if (ok) {
    const commands = postMergeChecks(task, config);
    // Integration is SERIAL, so an unbounded check here holds the whole epic,
    // not one lane. `runAsync` arms no timer at 0, which is what it inherited.
    const checkTimeout = checkTimeoutMs(config);
    const runCheck = async (commandText) => checkResult(commandText, await runAsync(commandText, {
      cwd: root,
      timeout: checkTimeout,
      env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH}` },
    }), checkTimeout);
    // (#178) The post-merge chain is a full gate: it waits for the machine-wide
    // gate lock. `checkTimeout` is armed per command inside, so the wait never
    // counts against it, and the lock is released however the chain ends.
    await withGateLock({ root, config, epic, kind: 'integration', say }, async ({ lockWaitS }) => {
      for (const commandText of commands) {
        let check = await runCheck(commandText);
        // Fail direction: OPEN for a flaky check — a red first run that passes on
        // the re-run lands the integration green, and the first run is kept in
        // `checkReruns` and the gate events so the false red stays countable.
        // Never for a timeout: integration is serial, a second run holds every
        // lane for another `checkTimeoutMs`, and a slow check is not a flake.
        if (checkFailed(check) && !check.timedOut) {
          onCheckRerun(commandText, checkFailureReason(check));
          const first = check;
          check = await runCheck(commandText);
          checkReruns.push({
            command: commandText, firstCode: first.code, firstOutput: first.output,
            firstStartedAt: first.startedAt ?? null, firstDurationMs: first.durationMs ?? null, firstLoad1: first.load1 ?? null,
            ...(first.timedOut ? { firstTimedOut: true } : {}), passed: !checkFailed(check),
            // (#179) What the first red looked like to the deterministic
            // reading. Recorded only: this re-run predates it and runs on any red.
            ...classifyGateFailure({ output: first.output, timedOut: first.timedOut }),
          });
        }
        checks.push(check);
        if (checkFailed(check)) { ok = false; failureReason = checkFailureReason(check); break; }
      }
      await recordGate({ root, kind: 'integration', taskId: task.id, attempt, commands, checks, checkReruns, lockWaitS });
    });
    const dirtyAfterChecks = parseStatusPaths(run('git status --porcelain -uall', { cwd: root }).stdout)
      .filter((file) => !preexisting.has(file));
    if (ok && dirtyAfterChecks.length) {
      ok = false;
      failureReason = `checks left the tree dirty: ${dirtyAfterChecks.join(', ')}`;
    }
  }

  const verification = {
    taskId: task.id, attempt, branch, taskTip, baseSha, integrationBase,
    // Same three facts as a builder's record, for the same reason. Recorded on
    // a fast-forward too, where no agent ran: the record then says which
    // provider WOULD have merged, and `fastForward: true` alongside it says
    // none did. Blanking it there would read as "backend unknown".
    agent: agentEvidence(agent),
    // Which model(s) answered the merger; `unknown` on a fast-forward, where no
    // agent ran. scripts/model-check.mjs.
    modelCheck: modelCheck(raw),
    // The extra writable paths this integration granted, or null. The one thing
    // that distinguishes a merger which could take Git's index.lock and write
    // its objects from one which could not, and there is no other record of it.
    gitMetadataDirs: metadataDirs,
    mergerExitCode: agentResult.status, timedOut: agentResult.timedOut,
    ...(agentResult.agentStillRunning ? { agentStillRunning: true } : {}),
    rateLimited, diffTruncated, fastForward, redoneNoFf,
    resultingHead: head, mergeParents: parents, containsTask, conflicts,
    cleanBeforeChecks, dirtyBeforeChecks, preexistingUntracked, checks, checkReruns,
    passed: ok, failureReason,
  };
  atomicWrite(resolve(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  if (!ok) {
    // FAIL DIRECTION: leaving the checkout dirty is cheaper than resetting it
    // while an unproven merger may still be writing. Fail closed on reuse and
    // retain both the tree and pane for a human to stop and inspect.
    if (agentResult.agentStillRunning) {
      return {
        outcome: 'integration_failed',
        verification,
        integrationBase,
        failureReason,
        removed: [],
      };
    }
    const removed = restoreMain(root, integrationBase, preexistingUntracked);
    verification.removedOnRollback = removed;
    atomicWrite(resolve(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
    return {
      outcome: rateLimited ? 'rate_limited' : 'integration_failed',
      verification, integrationBase, rateLimit: stats.rateLimit, failureReason, removed,
      // The failed check already had its second run; a retry would only
      // re-merge into the same tree. A failure after a re-run that PASSED
      // (dirt the checks left) is not a check failure and keeps the retry.
      // A timeout gets no whole-integration retry either: it would rebuild
      // the same tree and wait out the same timeout on every check.
      checkRerun: checkReruns.some((rerun) => !rerun.passed) || checks.some((check) => check.timedOut),
    };
  }

  // No second copy under the project root: it used to be committed as
  // `.afk-runs/<id>/integration-verification.json` by `flushStatuses` and
  // then read by the consumer's own format gate at the next integration (#106).
  // `runDir` above is the record.
  return { outcome: 'passed', verification, integrationBase, head };
};

export { restoreMain };
