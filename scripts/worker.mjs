import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  atomicWrite, buildAgentCommand, checkFailed, checkFailureReason, checkResult,
  checklistContinuation, checkTimeoutMs, continuationFloorMs, DEFAULT_BACKEND, MAX_CHECKLIST_CONTINUATIONS, readOpenChecklistItems, withTimeBudget, DEFAULT_PROTECTED_EDITS,
  ensureDir, globToRegExp, isBookkeeping, isProtectedPath, isRustCheck, MANIFEST_FILES,
  parseStatusPaths, pathAllowed, run, runAsync, shellQuote, shouldSkipRustChecks,
} from './lib.mjs';
import { finalText, parseStream, sessionIdOf } from './agent-stats.mjs';
import { lessonFromReport } from './defects.mjs';
import { CWD, roleAgent, roleFor, rolePrompt } from './roles.mjs';
// The one test for "this attempt never reached the API", shared with the
// scheduler rather than restated: two copies of that rule would drift, and the
// rule is subtle (zero tokens ONLY counts with no produced files — see the
// comment on it).
import { neverReachedApi } from './scheduler.mjs';
import { codexTerminalFailure, runHerdrRole, transcriptFile } from './runtime-herdr.mjs';
import { attachLaneVerification, listAfkWorktrees } from './worktree.mjs';
import { modelCheck, modelSwitchLine } from './model-check.mjs';
import { BROKER_LOG_FILE } from './permission-broker.mjs';

const LIMIT_RE = /(session[ _]limit|usage[ _]limit|rate[ _]limit|quota[ _]exceeded|too many requests|agent[ _]limit|resets? (at )?\d)/i;

const statusPaths = (cwd) => parseStatusPaths(run('git status --porcelain -uall', { cwd }).stdout);

// The tools that write a file directly, and where each keeps the path. These
// are the ones bypass leaves uncovered (docs/findings.md 3.15); a write a
// builder performs through `Bash` is governed by the sandbox, which the same
// probe measured refusing it.
const EDIT_TOOLS = new Map([
  ['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

/**
 * Where this lane's builder may write, as absolute paths.
 *
 * Derived from the role's own `sandbox.allowWrite` rather than restated, so a
 * role that widens its grant cannot drift out of step with the detector. `CWD`
 * is the lane's worktree, exactly as `preflightSettings` renders it.
 *
 * `os.tmpdir()` is added because Claude Code grants the session's `$TMPDIR`
 * alongside the working directory before this runner says anything
 * (docs/findings.md 3.2, the control row). A builder using it is doing
 * something ordinary, and calling that an escape is the false positive that
 * would get this switched off.
 *
 * A role with NO sandbox still gets the lane and `$TMPDIR`, never an empty
 * grant. Returning "nothing is granted" would read downstream as "nothing is
 * foreign", which fails open on precisely the least-capped role — the one where
 * detection is the only thing left.
 */
export const laneGrant = (worktree, allowWrite) => [
  ...(allowWrite ?? [CWD]).map((entry) => (entry === CWD ? worktree : entry)),
  tmpdir(),
];

/**
 * An absolute path with every symlink in it resolved, whether or not it exists.
 *
 * Both sides of this comparison arrive by different routes and spell the same
 * directory differently: `git worktree list` reports `/private/var/...` while
 * the runner's own lane path is the `/var/...` that `worktreeRoot` built, and
 * on macOS `/tmp` and `/var` are symlinks into `/private`. Comparing them as
 * strings silently answers "different directory", and this detector then
 * reports nothing at all — which is the exact failure it exists to prevent, so
 * it is worth the walk.
 *
 * `realpathSync` needs the path to exist, and a blocked write's target does
 * not, so resolve the deepest ancestor that does and re-append the rest.
 */
const canonical = (target) => {
  let head = resolve(target);
  const tail = [];
  for (;;) {
    try { return tail.length ? join(realpathSync.native(head), ...tail) : realpathSync.native(head); }
    catch { /* not there yet — try the parent */ }
    const parent = dirname(head);
    if (parent === head) return resolve(target);
    tail.unshift(basename(head));
    head = parent;
  }
};

const within = (path, root) => path === root || path.startsWith(`${root}${sep}`);

// A tool_result the runtime marked as an error, or whose text reads like one.
// Under bypass a Write outside the lane simply succeeds (docs/findings.md
// 3.15), so anything that came back refused is an ATTEMPT — worth recording,
// but not worth halting an epic over.
const REFUSED = /operation not permitted|permission|not allowed|denied|no such tool|disabled for this session|allowed working directories|was blocked/i;

/**
 * Editing-tool calls in a builder's transcript that target a path outside its
 * lane. The evidence of 3.15's escape, read from the builder's own stream.
 *
 * Deliberately NOT a before/after diff of the other worktrees. Lanes run in
 * parallel, so lane 207's own builder changes lane 207 while this one runs, and
 * a tree diff would attribute that here every single time. Reading this
 * builder's transcript attributes correctly by construction, needs nothing from
 * the scheduler, and names the tool and the turn rather than just a path.
 *
 * What it does NOT cover, stated plainly because a detector believed to be
 * complete is worse than one known to be partial:
 *
 *   - a write by a program the builder launches. That route goes through
 *     `Bash`, which the sandbox governs and was measured refusing exactly these
 *     targets, so the two layers compose here.
 *   - a write by a `Task` subagent, or by an MCP/plugin tool this list does not
 *     name. Those are silent misses with no second layer behind them.
 *   - a path the shell would expand, `~/notes.md` above all: it resolves inside
 *     the lane as a literal directory and reads as in-lane.
 *
 * `refused` separates the two things a transcript records. Under bypass a Write
 * outside the lane simply succeeds, so a call that came back an error was an
 * attempt that something else stopped — recorded, but not grounds for halting.
 *
 * @param worktree the lane, passed explicitly. It used to be read as `grant[0]`,
 *   which was only the lane because `ROLES.implementer` happens to list `CWD`
 *   first: reordering that array would have silently made `/tmp` the lane and
 *   stopped every out-of-lane write under it being reported.
 */
export const foreignWrites = (raw, worktree, grant, deny = []) => {
  // Canonicalised once. `within` is called per tool call per directory, and
  // each `canonical` is a walk up the filesystem.
  const lane = canonical(worktree);
  const allowed = grant.map(canonical);
  const forbidden = deny.map(canonical);
  const found = new Map();
  const pending = new Map();
  for (const line of String(raw).split('\n')) {
    let message;
    // A builder that died mid-sentence leaves a truncated last line. Throwing
    // here would turn a failed lane into a crashed runner.
    try { message = JSON.parse(line); } catch { continue; }
    // Codex reports an edit as a `file_change` item rather than a `tool_use`
    // block, so without this branch the whole detector is dark on that backend
    // — the guard would report a clean lane for a builder that had written the
    // main checkout. The item carries every path it touched in one event, and
    // its own terminal status, so there is no result to correlate: a failed
    // item is the refused case.
    if (message?.type === 'item.completed' && message.item?.type === 'file_change') {
      const refused = message.item.status === 'failed';
      for (const change of message.item.changes ?? []) {
        const declared = typeof change === 'string' ? change : change?.path;
        if (typeof declared !== 'string' || !declared) continue;
        const path = canonical(resolve(lane, declared));
        if (within(path, lane)) continue;
        if (!forbidden.some((dir) => within(path, dir)) && allowed.some((dir) => within(path, dir))) continue;
        const entry = found.get(path) ?? { tool: 'file_change', path, refused };
        // One call that landed outranks any number that were refused, exactly
        // as it does on the Claude side.
        if (!refused) entry.refused = false;
        found.set(path, entry);
      }
      continue;
    }
    for (const block of message?.message?.content ?? []) {
      if (block.type === 'tool_result') {
        const entry = pending.get(block.tool_use_id);
        if (!entry) continue;
        const text = JSON.stringify(block.content ?? '');
        // Both directions, because the same path may be attempted twice: one
        // call that landed outranks any number that were refused.
        entry.refused = Boolean(block.is_error || REFUSED.test(text));
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const key = EDIT_TOOLS.get(block.name);
      const declared = key && block.input?.[key];
      if (typeof declared !== 'string' || !declared) continue;
      // Resolved against the LANE: the agent's cwd is the worktree, so a bare
      // `src/app.ts` is in-lane. Resolving against the runner's own cwd would
      // call ordinary work an escape.
      const path = canonical(resolve(lane, declared));
      // Own lane first, then the named exclusions, then the grant. The order is
      // load-bearing: `$TMPDIR` is in the grant and a project may put its
      // worktrees under it — this runner's own worktrees lived in `.afk/` once
      // — so a prefix that swallows a sibling lane must lose to `deny`, and a
      // `deny` entry that encloses this lane must lose to the lane.
      if (within(path, lane)) continue;
      if (!forbidden.some((dir) => within(path, dir)) && allowed.some((dir) => within(path, dir))) continue;
      // Assumed landed until a result says otherwise: under bypass that is what
      // was measured, and a truncated transcript must not quietly downgrade an
      // escape to an attempt.
      const entry = found.get(path) ?? { tool: block.name, path, refused: false };
      found.set(path, entry);
      pending.set(block.id, entry);
    }
  }
  return [...found.values()];
};

/** The subset that actually landed. Only these are grounds for stopping a run. */
export const landedWrites = (writes) => writes.filter((entry) => !entry.refused);

/**
 * True when `after` differs from `before` only inside `keys`.
 *
 * Anything that does not parse as a JSON object is NOT an allowed edit: the
 * revert is the safe answer, and a manifest a builder mangled into invalid JSON
 * is the last thing to wave through.
 */
export const editsOnlyKeys = (before, after, keys) => {
  const parse = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return false;
  const allowed = new Set(keys);
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (allowed.has(name)) continue;
    if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) return false;
  }
  return true;
};

/**
 * Whether this lane's change to a protected file is one the project permits.
 *
 * A file absent at `baseSha`, or absent now, is never an allowed edit: "the
 * builder introduced a manifest" and "the builder deleted the manifest" are
 * both exactly what the revert exists for.
 */
export const allowedProtectedEdit = (worktree, baseSha, file, edits) => {
  const keys = edits?.[file];
  if (!Array.isArray(keys) || !keys.length) return false;
  const before = run(`git show ${shellQuote(`${baseSha}:${file}`)}`, { cwd: worktree });
  if (before.status !== 0) return false;
  let after;
  try { after = readFileSync(resolve(worktree, file), 'utf8'); } catch { return false; }
  return editsOnlyKeys(before.stdout, after, keys);
};

/**
 * What a human must DO about the paths this lane's revert undid.
 *
 * `revertedProtected` has been recorded since the revert shipped and nothing
 * has ever read it, so a lane could run its checks without an edit its own
 * acceptance criteria required and still report green. A check that does not
 * run is indistinguishable from a check that passes, and a builder that is
 * prevented from wiring up its own tests and cannot say so ships a green lie.
 */
export const protectedActionItems = (reverted = []) => reverted.map((file) =>
  `The builder edited \`${file}\` and the runner reverted it. This lane's checks ran WITHOUT that edit, `
  + 'so a green result here does not cover it. Make the edit by hand if the task needed it, or allow it in '
  + '`protectedEdits` in .afk-setup/config.yaml if builders should be able to make it themselves.');

// --- a test file the gate never runs ----------------------------------------
// The revert above is one route to a dead suite. The other needs no revert at
// all: the builder writes `scripts/test-<area>.ts` and simply never appends it
// to the `test` chain. Three live epics shipped that — two of them in lanes
// whose own child issue asked for the wiring in as many words — and every gate
// stayed green, because a check that does not run is indistinguishable from a
// check that passes. Nothing in a lane can catch it: the checks pass, the diff
// is clean, the tree is green. The runner is the only thing that sees both the
// files a lane produced and the manifest that decides what runs.
//
// Registration is looked for anywhere in the `scripts` block rather than inside
// the `test` script specifically. A project is free to chain its suites through
// a script of its own, and a false positive on a properly registered file is
// what gets a warning like this switched off.
//
// Candidates are only the paths a project must register BY HAND. `scripts/test-*`
// is that convention; a glob-discovered suite (`*.test.mjs`, which this repo
// itself uses) runs without an entry and must never be flagged. Per project, in
// `.afk-setup/config.yaml`, for a repo that keeps its suites somewhere else:
//
//   testScripts: ["tests/*_test.py"]
export const DEFAULT_TEST_SCRIPTS = ['scripts/test-*'];

/**
 * The test files this lane produced that nothing the project runs will execute.
 *
 * Registration is looked for three ways, each one a false positive this check
 * cannot afford:
 *
 *   - named anywhere in the `scripts` block. Not inside the `test` script
 *     specifically: a project may chain its suites through a script of its own.
 *   - imported by a file the `scripts` block names. Epic 6's lane chained its
 *     new suite into another with a side-effect import because it could not edit
 *     the manifest — that file runs, and telling its author it is dark would be
 *     wrong twice over.
 *   - inside a directory the `scripts` block names AS a directory
 *     (`node --test scripts/`). Nothing there is ever registered by hand, so
 *     every lane in such a project would be accused.
 *
 * What it does NOT see, said plainly: a file registered under a script key that
 * nothing chains into `test`, and a file already dark on the base branch. This
 * reads one lane's own output, and the leniency is deliberate — a warning that
 * cries wolf is one nobody reads.
 *
 * Fails toward silence: no manifest, an unparseable one, or one with no
 * `scripts` block is every non-node project plus the case the revert already
 * owns — none of them is evidence that a test file is dark.
 *
 * @param readSibling reads a repo-relative file, '' when it is not there. The
 *   caller binds it to the lane; a pure default keeps this testable.
 */
export const unregisteredTestScripts = (
  produced = [], manifestText = null, patterns = DEFAULT_TEST_SCRIPTS, readSibling = () => '',
) => {
  let scripts;
  try { scripts = JSON.parse(manifestText ?? '')?.scripts; } catch { return []; }
  if (!scripts || typeof scripts !== 'object') return [];
  const registered = JSON.stringify(scripts);
  const candidates = produced.filter((file) => patterns.some((pattern) => globToRegExp(pattern).test(file)));
  if (!candidates.length) return [];
  // Read once per lane, not once per candidate: the manifest names the same
  // handful of files however many test scripts this lane wrote.
  const chained = [...new Set(registered.match(/[\w.][\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb)/g) ?? [])]
    .map((file) => readSibling(file))
    .join('\n');
  // A directory as a directory: `scripts/` or `scripts` followed by whitespace,
  // a quote or the end — never `scripts/test-a.ts`, where a file follows.
  const discovers = (dir) => new RegExp(`(^|[\\s"'])${dir.replace(/[.+^\${}()|[\]\\]/g, '\\$&')}/?(?=["'\\s]|$)`).test(registered);
  return candidates.filter((file) => !registered.includes(file)
    && !registered.includes(basename(file))
    && !chained.includes(basename(file))
    && !discovers(dirname(file)));
};

/** The same three surfaces a reverted path gets: the lane cannot fix this one either. */
export const unrunTestActionItems = (unrun = []) => unrun.map((file) =>
  `The builder wrote \`${file}\` and nothing package.json runs reaches it — no \`scripts\` entry names it or `
  + "the directory holding it, and no file those entries name imports it. This lane's checks never ran it, and a "
  + 'check that does not run is indistinguishable from one that passes. Append it to the `test` chain by hand.');

// --- which reverts actually invalidate this lane's green ---------------------
// A reverted path is a human action item either way. Only some of them make the
// lane's OWN checks meaningless, and those are the ones that must not be allowed
// to report `passed`.
//
// The distinction is whether the reverted file is an INPUT to the check commands
// — something the shell reads to decide what the checks do and what they run
// against. That is the build manifest and its lockfiles, and nothing else on the
// protected list:
//
//   package.json      the test/lint chain itself, plus the dependency set
//   *lock*            the versions the chain resolves to
//
// `.claude/`, `planning/`, `AGENTS.md`, `PLANNER.md`, the progress tables,
// `agent-auto.log` and `.afk-setup/` are agent instruction, runner bookkeeping
// or editor config. No check command reads any of them, so a revert there leaves
// the lane's verdict exactly as trustworthy as it was — and reverting `.claude/`
// is routine: the herdr runtime's own teardown produces it on every lane
// (F3.11). Blocking on that would block every herdr lane there is.
//
// The motivating failure is package.json specifically: a builder wired its new
// test script into the `test` chain, the runner reverted it, the command then
// ran the OLD chain and reported green, and 380 assertions never executed. Note
// that with `protectedEdits` narrowing by key, a `scripts`-only edit now
// SURVIVES — so what reaches this list is a builder moving `dependencies`, a
// version, or a lockfile, where the checks ran against a tree the reverted
// manifest no longer describes.
//
// RE-EXPORTED, not re-listed. These two sets were written out separately and
// drifted: adding a lockfile to the protected list alone reverts it and leaves
// the green standing, which is the lie the protected list exists to prevent.
// `export { X as Y }` rather than `const Y = X` so no reader can take this for
// a second set that happens to be equal today.
export { MANIFEST_FILES as CHECK_INPUT_FILES };

/** The reverted paths whose absence makes this lane's green meaningless. */
export const checksInvalidatedBy = (reverted = []) => reverted.filter((file) => MANIFEST_FILES.has(file));

/**
 * The agent's own output, from whichever channel this runtime actually used.
 *
 * `direct` writes `stream.jsonl`; `herdr` draws into a terminal pane and writes
 * nothing, which is why `agent-output.log` was EMPTY for every lane of every
 * herdr run and four crashed lanes left no diagnosis at all (epic-6 §3).
 */
export const agentOutputText = (raw, paneOutput = null) =>
  finalText(raw) || raw.slice(0, 4000) || String(paneOutput ?? '');

const restoreProtected = (worktree, baseSha, files) => {
  const tracked = new Set(run(`git ls-tree -r --name-only ${shellQuote(baseSha)}`, { cwd: worktree }).stdout.split('\n').filter(Boolean));
  for (const file of files) {
    if (tracked.has(file)) {
      const result = run(`git checkout ${shellQuote(baseSha)} -- ${shellQuote(file)}`, { cwd: worktree });
      if (result.status !== 0) throw new Error(`Cannot restore protected file ${file}: ${result.stderr}`);
    } else {
      rmSync(resolve(worktree, file), { recursive: true, force: true });
    }
  }
};

/**
 * Where one builder attempt's forensics live. Per ATTEMPT on purpose: a retry
 * must not overwrite why the previous one died, which is the only reason
 * `priorAttempts` below has anything to read.
 */
export const builderRunDir = (root, taskId, attempt) =>
  resolve(root, '.afk', 'runs', taskId, `builder-${attempt}`);

/**
 * Staggered launch of sibling lanes.
 *
 * Lanes that start together share a ~18.8k-token prompt prefix (system prompt,
 * tools, the project's instructions). Launched at the same instant, every one
 * of them misses the cache and pays to write that prefix. Launched after the
 * first lane's first API response, they read it from the cache the first lane
 * just wrote. So a batch of N starts one lane, waits, then starts the rest.
 *
 * FAIL DIRECTION: the wait is bounded and never blocks on a dead lane. It ends
 * on the first of: the leader's first response, the leader's builder settling
 * (crashed, refused, done — anything), or `STAGGER_MAX_WAIT_MS`. The worst case
 * costs the followers that many seconds of their own budget-free time (their
 * clock has not started), never a lane.
 */
export const STAGGER_MAX_WAIT_MS = 20_000;

const hasAssistantTurn = (path, since) => {
  try {
    if (statSync(path).mtimeMs < since) return false;
    return readFileSync(path, 'utf8').includes('"type":"assistant"');
  } catch { return false; }
};

// Whether a lane's agent has had its first API response. Direct runtime: the
// `-p` stream file. Herdr: the session transcript, bound by the lane's prompt
// path (`transcriptFile`), because a herdr lane writes no stream file.
export const laneResponded = ({ runDir, worktree, since }) => {
  if (hasAssistantTurn(resolve(runDir, 'stream.jsonl'), since)) return true;
  const transcript = transcriptFile(worktree, since, resolve(runDir, 'prompt.md'));
  return transcript ? hasAssistantTurn(transcript, since) : false;
};

export const staggerGate = ({ responded, leaderDone, maxWaitMs = STAGGER_MAX_WAIT_MS, pollMs = 500 }) =>
  new Promise((done) => {
    let open = true;
    const finish = (why) => {
      if (!open) return;
      open = false;
      clearInterval(poll);
      clearTimeout(cap);
      done(why);
    };
    const poll = setInterval(() => {
      let seen = false;
      try { seen = responded(); } catch {}
      if (seen) finish('first-response');
    }, pollMs);
    const cap = setTimeout(() => finish('timeout'), maxWaitMs);
    Promise.resolve(leaderDone).then(() => finish('leader-ended'), () => finish('leader-ended'));
  });

// One failing check's output can be megabytes. Carrying all of it into the next
// attempt's prompt reproduces AGENTS.md failure mode 5 (the merger that died on
// a 1.3M-token prompt) in a new place, which is the same reason
// `supervisorEvidence` clips (scripts/supervisor.mjs). The budget is the same
// 2,000 characters it always was; what changed is WHICH 2,000.
const PRIOR_OUTPUT_BUDGET = 2_000;

// The head keeps this much and the tail keeps the rest, because a build tool
// puts its verdict at the END. A real 73KB `xcodebuild test` transcript
// (scripts/fixtures/xcodebuild/failing-test.log) carries zero occurrences of
// `error:` in its first 2,000 characters — they are xcodegen chatter,
// destination warnings and compile progress — while `Test Case '-[X testY]'
// failed`, the `error:` line and `** TEST FAILED **` are all in the last 1,500.
// Head-clipping handed the retry lane 2,000 characters of noise and it re-ran
// the same failure blind.
//
// The head is not dropped altogether: `tsc`, `eslint` and a Node stack trace
// put the FIRST diagnostic at the top, and 500 characters is enough to carry it
// while leaving the tail the bigger share.
const PRIOR_OUTPUT_HEAD = 500;

const clipOutput = (value) => {
  const text = String(value ?? '').trim();
  if (text.length <= PRIOR_OUTPUT_BUDGET) return text;
  const head = text.slice(0, PRIOR_OUTPUT_HEAD);
  const tail = text.slice(text.length - (PRIOR_OUTPUT_BUDGET - PRIOR_OUTPUT_HEAD));
  return `${head}\n…[${text.length - PRIOR_OUTPUT_BUDGET} more chars]\n${tail}`;
};

/**
 * The failure evidence a retry is given, rendered from prior attempts'
 * `verification.json` (docs/wave-mode.md §5).
 *
 * What is carried, and every omission is a decision rather than an oversight:
 *
 * - `attempt`, so two blocks are distinguishable.
 * - the FIRST failing check's command and output. A suite stops at its first
 *   failure anyway and the later entries are noise, and carrying all of them is
 *   the token death above.
 * - `producedFiles`, as the paths that attempt touched — the successor's
 *   cheapest orientation, since it starts from a clean worktree with none of them.
 * - `agentExitCode`, `timedOut` and `durationMs`, but ONLY when no check failed.
 *   Then the agent process itself is what went wrong, and "attempt 1 failed"
 *   with no reason reads to a builder as a failure it should find in the code.
 * - `tokens` with `producedFiles` again, as the zero-token test below.
 *
 * Not carried: `branch`, `worktree`, `baseSha` (per-attempt, and the successor
 * gets fresh ones); `rateLimited`, `builderCommitsRemoved`,
 * `keptOutsideDeclaredPaths` (runner bookkeeping, nothing a builder can act on);
 * `wroteOutsideLane`, `authFailure`, `checksInvalidated`, `needsHumanAction`
 * (every one of these halts or blocks in auto.mjs instead of retrying, so no
 * attempt carrying them can reach this function). A rate-limited attempt cannot
 * reach it either: that path decrements `builderAttempt`, so the next run
 * overwrites its directory rather than becoming a successor to it.
 *
 * **A Codex attempt that hit its quota or its login is dropped too (#292).**
 * It is the one exception above: auto.mjs retries it on Claude Opus as a
 * normal attempt, so its record IS a predecessor. What stopped it was the
 * provider, not the ticket, and the Opus retry must not be told otherwise.
 *
 * **A zero-token attempt is dropped entirely.** `neverReachedApi` says the
 * attempt never got to the API, so its "failure" is a fact about the harness —
 * an expired login, a herdr kill — and none of it is about the ticket. Handing
 * a model an infra error as if it were its own mistake sends it to fix the
 * wrong thing. Every prior attempt dropped this way means the retry runs plain,
 * exactly as today.
 *
 * @param {object[]} verifications prior attempts, oldest first
 * @returns {string|null} the prompt section body, or null when there is nothing
 *   worth grounding on
 */
export const renderPriorAttempts = (verifications = []) => {
  const blocks = [];
  for (const verification of verifications) {
    if (!verification || neverReachedApi(verification)) continue;
    if (verification.quotaRejected || verification.authFailure) continue;
    const checks = Array.isArray(verification.checks) ? verification.checks : [];
    const failed = checks.find((check) => checkFailed(check));
    const lines = [`Attempt ${verification.attempt} failed.`];
    if (failed) {
      // A timeout is named as one. A successor told "First failing check:
      // swift test" goes looking for a broken assertion; one told the check
      // never returned inside its bound goes looking for what blocked it.
      lines.push(failed.timedOut
        ? `  ${checkFailureReason(failed)}`
        : `  First failing check: ${failed.command}`);
      const output = clipOutput(failed.output);
      lines.push(output ? `  Its output:\n${output.split('\n').map((line) => `    ${line}`).join('\n')}` : '  It produced no output.');
      // The clip above is orientation, not the whole record. The UNCLIPPED
      // output is already on disk in that attempt's verification.json, so name
      // the path rather than spend prompt on text the successor may not need —
      // it can read the file if the 2,000 characters do not settle the question.
      // Only said when something was actually cut; otherwise it is noise.
      if (verification.recordPath && String(failed.output ?? '').trim().length > PRIOR_OUTPUT_BUDGET) {
        lines.push(`  Full unclipped output: ${verification.recordPath} (the failing entry's \`output\` under \`checks\`)`);
      }
    } else {
      // No check failed, so the agent process itself is what went wrong. Said
      // plainly rather than left blank: "attempt 1 failed" with no reason reads
      // to a builder as a failure it should be able to find in the code.
      lines.push(verification.timedOut
        ? `  No check failed; the agent process timed out after ${verification.durationMs ?? 'unknown'}ms.`
        : `  No check failed; the agent process exited ${verification.agentExitCode ?? 'non-zero'}.`);
    }
    const produced = verification.producedFiles ?? [];
    lines.push(produced.length ? `  Paths it touched: ${produced.join(', ')}` : '  It touched no files.');
    blocks.push(lines.join('\n'));
  }
  return blocks.length ? blocks.join('\n\n') : null;
};

/**
 * (#215) The lesson a retried builder was asked for: the last `LESSON:` line in
 * any of its sessions' closing messages, since a checklist continuation's
 * "Done." may follow the report that carries it. Attempt 1 was never asked.
 */
export const retryLesson = (attempt, sessionTexts) =>
  (attempt > 1 ? lessonFromReport(sessionTexts.join("\n")) : null);

/**
 * Read the prior attempts of this task off disk and render them.
 *
 * Never fatal, in either direction: an unreadable or half-written
 * `verification.json` costs the retry its grounding, which is strictly less bad
 * than refusing to start the lane over a forensics file. Attempt 1 reads
 * nothing and gets nothing.
 */
export const priorAttemptsFor = ({ root, taskId, attempt }) => {
  const verifications = [];
  for (let n = 1; n < attempt; n += 1) {
    try {
      const recordPath = resolve(builderRunDir(root, taskId, n), 'verification.json');
      verifications.push({ ...JSON.parse(readFileSync(recordPath, 'utf8')), recordPath });
    } catch { /* no record of that attempt; the ones that have a record still count */ }
  }
  return renderPriorAttempts(verifications);
};

/**
 * The three facts about the agent that a verification record must carry: which
 * provider ran, which model it ran on, and at which reasoning effort. Read off
 * the resolved agent record, so it is the values that reached the command line
 * rather than the values a config asked for.
 */
export const agentEvidence = (agent = {}) => ({
  backend: agent.backend ?? DEFAULT_BACKEND,
  model: agent.model ?? null,
  reasoningEffort: agent.reasoningEffort ?? null,
});

/**
 * Where the implementer keeps its phase checklist while it works: scratch under
 * `/tmp`, OUTSIDE the lane. A lane commits with `git add -A`, so a checklist in
 * the worktree would ride the task branch into the consumer's history. `/tmp`
 * rather than `os.tmpdir()` because it is what the implementer's sandbox
 * `allowWrite` names, and so what `laneGrant` treats as inside the grant — the
 * same choice `verifierScratchReportPath` makes. Random per attempt, so a retry
 * never reads its predecessor's ticks.
 */
export const implementerChecklistPath = (taskId, attempt) =>
  resolve(
    '/tmp',
    `afk-implementer-${process.getuid?.() ?? 'user'}`,
    `${String(taskId)}-${attempt}-${randomUUID().slice(0, 8)}`,
    'checklist.md',
  );

// The mark `prompts/implementer.md` carries for that path. Same mechanism, and
// the same reason, as `VERIFIER_REPORT_PATH_MARK`: `render` blanks any `{{…}}`
// mark its value set does not name, so this is substituted on the rendered text.
export const IMPLEMENTER_CHECKLIST_MARK = '@@AFK_CHECKLIST_PATH@@';

// The permission broker's decision log for this attempt (#53), or null when the
// broker never ruled — the direct runtime has no broker, and a herdr lane whose
// classifier never escalated writes no file. A torn line is skipped: the log is
// evidence, and one bad line must not cost the rest of it.
const readBrokerDecisions = (runDir) => {
  let text;
  try { text = readFileSync(resolve(runDir, BROKER_LOG_FILE), 'utf8'); } catch { return null; }
  const entries = text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const denied = entries.filter((entry) => entry.behavior === 'deny').length;
  return { allowed: entries.length - denied, denied, entries };
};

export const runBuilder = async ({ root, config, task, worktree, branch, baseSha, attempt, backend = undefined, model = null, reasoningEffort = null, backendFallbackReason = null, customInstructions = null, ledgerNotes = null, priorAttempts = null, onPid = () => {}, say = console.log, runHerdr = runHerdrRole, startGate = null }) => {
  // A follower in a staggered batch waits here, before its clock starts
  // (`staggerGate` above); its worktree is already prepared.
  if (startGate) say(`WORKER: builder ${task.id} launching after the batch's first lane (${await startGate}).`);
  const runDir = builderRunDir(root, task.id, attempt);
  ensureDir(runDir);
  // builder-N is reused (a rate limit steps the attempt back; an infra/auth
  // failure or `afk reset` zeroes it) and the broker APPENDS, so a leftover log
  // would put a dead attempt's denials on this one. Clear it before the agent
  // runs, and the dead attempt's record with it: the agent call below is
  // try/finally with no catch, so a throw skips writing this attempt's record
  // and the wave digest would read the old one as this attempt's. Nothing reads
  // THIS dir's record before it is rewritten — `priorAttemptsFor` reads only
  // attempts below this one, and it ran at launch.
  rmSync(resolve(runDir, BROKER_LOG_FILE), { force: true });
  rmSync(resolve(runDir, 'verification.json'), { force: true });
  // What the worktree looked like BEFORE the agent ran — which is after
  // `bootstrapWorktree`, because every path into here bootstraps first: a fresh
  // lane via `createTaskWorktree`, a reused one via `createTaskWorktree` →
  // `resetTaskWorktree` → re-bootstrap (scripts/auto.mjs:1440-1452). So a
  // `worktreeSetup.run` hook's writes are in this list, and subtracting it
  // below is what stops them being attributed to the builder.
  //
  // It matters because of what that attribution costs: a hook-dirtied file on
  // the protected list is not merely mis-blamed, it is REVERTED to `baseSha`,
  // leaving the tree in a state the install no longer matches — and with
  // `bun.lock` now protected, a future bun that rewrites the lockfile on
  // install would do exactly that to every lane in two repos.
  //
  // Path-level, so one hazard remains and is documented rather than fixed: an
  // agent edit to a file the hook ALSO dirtied is masked. The alternative is
  // hashing every bootstrapped path on every lane, which costs more than the
  // case is worth.
  const bootstrapped = new Set(statusPaths(worktree));
  const promptPath = resolve(runDir, 'prompt.md');
  const streamPath = resolve(runDir, 'stream.jsonl');
  const taskText = task.body ?? '';
  const role = roleFor('implementer');
  const checklistScratch = implementerChecklistPath(task.id, attempt);
  atomicWrite(
    promptPath,
    rolePrompt(role, config, { task, taskText, customInstructions, ledgerNotes, priorAttempts, backend })
      .replaceAll(IMPLEMENTER_CHECKLIST_MARK, checklistScratch),
  );

  // Clock starts here, a moment before the agent does (lib.mjs `withTimeBudget`).
  // `root` is the run's checkout, which an `afk epic --worktree` run puts
  // somewhere other than the runner's cwd; the guard hook keeps its file tools
  // off it and off every lane but `worktree`.
  // `backend`, `model` and `reasoningEffort` are this task's routing assignment
  // (scripts/builder-routing.mjs); absent, the lane runs exactly as before.
  const routed = roleAgent(role, config, backend, root, worktree);
  const agent = withTimeBudget({
    ...routed,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }, runDir);
  // The resolved runtime rides on config, set once by runAuto. Never read from
  // process.env here: the runner also spawns this project's checks as children,
  // and an exported variable would reach those too.
  const runtime = config.agent?.runtime || 'direct';
  // Wall-clock of the agent process. A builder that dies in under a couple of
  // seconds did no real work, which is how the breaker tells an infra/auth fault
  // apart from a genuinely bad ticket.
  const startedAt = Date.now();
  let agentResult;
  // The scratch exists only while the agent runs, and goes whatever happens to
  // it. Both levels are private: the per-user parent is where another account
  // on the host could otherwise list or pre-create attempt directories.
  const scratchParent = dirname(dirname(checklistScratch));
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  chmodSync(scratchParent, 0o700);
  mkdirSync(dirname(checklistScratch), { mode: 0o700 });
  // Copied under `.afk/runs/` before the scratch goes, so the supervisor and a
  // post-mortem read what the builder actually ticked.
  let checklistPath = null;
  // Each continuation's own stream, so the report and the rate-limit check can
  // tell the first session from what followed it.
  const continuationRaws = [];
  try {
    if (runtime === 'herdr') {
      agentResult = await runHerdr({ role, root, task, worktree, agent, promptPath, attempt, onPid, checklistPath: checklistScratch });
    } else {
      const command = buildAgentCommand(agent, {
        nodeBin: process.execPath.replace(/\/node$/, ''), promptPath, streamPath, taskId: task.id,
        processName: role.processName(task.id),
        // The lane, named on the command line as well as set as the shell's cwd.
        // Codex takes its workspace boundary from `--cd`, so leaving it implicit
        // is what lets a builder's stray edit land in the wrong checkout.
        cwd: worktree,
      });
      agentResult = await runAsync(command, {
        cwd: worktree,
        timeout: agent.timeoutMs,
        onSpawn: (child) => onPid(child.pid),
      });
      // A `-p` session that exits 0 has ended a turn, which is not the same as
      // finishing the task (lib.mjs `openChecklistItems`). With checklist items
      // still open, resume the same session and send it back to them, inside
      // what is left of the lane's deadline. Claude only: Codex has no resume
      // on this command line.
      //
      // FAIL DIRECTION: a continuation never makes the lane worse off than not
      // sending it. The session before it had exited 0, so a continuation that
      // exits non-zero or times out is recorded in the log and dropped, and
      // the lane keeps the result it had.
      for (let n = 1; n <= MAX_CHECKLIST_CONTINUATIONS && agentResult.status === 0 && !agentResult.timedOut; n += 1) {
        const open = readOpenChecklistItems(checklistScratch, role.phases.at(-1));
        const remaining = agent.timeoutMs - (Date.now() - startedAt);
        let sessionId = null;
        try { sessionId = sessionIdOf(readFileSync(streamPath, 'utf8')); } catch {}
        if (!open.length || !sessionId || remaining < continuationFloorMs(agent.timeoutMs)
          || (agent.backend ?? DEFAULT_BACKEND) !== 'claude') break;
        say(`WORKER: builder ${task.id} stopped with ${open.length} open checklist item(s); continuing (${n}/${MAX_CHECKLIST_CONTINUATIONS}).`);
        const continuePrompt = resolve(runDir, `continue-${n}.md`);
        const continueStream = resolve(runDir, `stream-continue-${n}.jsonl`);
        atomicWrite(continuePrompt, `${checklistContinuation(open)}\n`);
        const continued = await runAsync(buildAgentCommand({ ...agent, resume: sessionId }, {
          nodeBin: process.execPath.replace(/\/node$/, ''), promptPath: continuePrompt, streamPath: continueStream, taskId: task.id,
          processName: role.processName(task.id), cwd: worktree,
        }), { cwd: worktree, timeout: remaining, onSpawn: (child) => onPid(child.pid) });
        // One transcript for the lane-escape scan below, which must see the
        // continuation's writes too, whatever became of it.
        let continuedRaw = '';
        try { continuedRaw = readFileSync(continueStream, 'utf8'); } catch {}
        appendFileSync(streamPath, continuedRaw);
        continuationRaws.push(continuedRaw);
        if (continued.status !== 0 || continued.timedOut) {
          say(`WORKER: builder ${task.id} continuation ${n} ${continued.timedOut ? 'timed out' : `exited ${continued.status}`}; keeping the lane's earlier result.`);
          break;
        }
        agentResult = continued;
      }
    }
  } finally {
    if (existsSync(checklistScratch)) {
      checklistPath = resolve(runDir, 'checklist.md');
      try { atomicWrite(checklistPath, readFileSync(checklistScratch, 'utf8')); } catch { checklistPath = null; }
    }
    rmSync(dirname(checklistScratch), { recursive: true, force: true });
  }
  const durationMs = Date.now() - startedAt;
  let raw = '';
  try { raw = readFileSync(streamPath, 'utf8'); } catch {}
  // The pane scrollback is the herdr runtime's only output channel, and
  // `runHerdrRole` reads it before anything tears the pane down. Written to the
  // per-attempt run directory, so a retry cannot overwrite the reason the
  // previous attempt died.
  // The first session's text before its continuations' (each ends on its own
  // closing message), so a continuation's "Done." never replaces the report.
  const sessionsRaw = continuationRaws.length ? [raw.slice(0, raw.length - continuationRaws.join('').length), ...continuationRaws] : [raw];
  atomicWrite(resolve(runDir, 'agent-output.log'), continuationRaws.length
    ? sessionsRaw.map((text) => finalText(text)).filter(Boolean).join('\n\n')
    : agentOutputText(raw, agentResult.paneOutput));
  const stats = parseStream(raw);
  // Read off the first session alone: a continuation that hit a limit was
  // dropped above and must not turn a finished lane into a rate-limited one.
  const firstRaw = sessionsRaw[0];
  const firstStats = continuationRaws.length ? parseStream(firstRaw) : stats;
  // A Codex lane's own failure, read from its provider events (direct) or its
  // pane (Herdr, already classified as `agentResult.quotaRejected` /
  // `authFailure`). Only a failed run is read — a non-zero exit or a
  // `turn.failed` — so reconnect noise in a run that succeeded is not one.
  const codex = (agent.backend ?? DEFAULT_BACKEND) === 'codex';
  const codexRunFailed = agentResult.status !== 0 || /"type"\s*:\s*"turn\.failed"/.test(firstRaw);
  const codexFailure = !codex || !codexRunFailed ? null
    : agentResult.quotaRejected === true ? 'quota'
      : agentResult.authFailure === true ? 'auth'
        : codexTerminalFailure(firstRaw);
  const rateLimited = agentResult.rateLimited === true
    || codexFailure === 'quota' || codexFailure === 'rate-limit'
    || firstStats.apiErrorStatus === 429
    || firstStats.rateLimit?.status === 'rejected'
    || (firstRaw.length <= 600 && LIMIT_RE.test(firstRaw));
  // FAIL DIRECTION: only a provider message that NAMES a quota or usage limit
  // is exhaustion, which sends this lane to Claude. A bare 429 or throttle
  // stays an ordinary rate limit and retries on Codex (#292, defect 3).
  const quotaRejected = codexFailure === 'quota';
  const authFailure = agentResult.authFailure === true || codexFailure === 'auth';
  // Recorded, logged and surfaced in the PR body; never an outcome. See
  // scripts/model-check.mjs for why a switch does not fail the lane.
  const models = modelCheck(raw);
  const switchLine = modelSwitchLine(`builder ${task.id} (attempt ${attempt})`, models);
  if (switchLine) say(`WORKER: ${switchLine}`);

  const currentHead = run('git rev-parse HEAD', { cwd: worktree }).stdout.trim();
  const agentCommits = currentHead && currentHead !== baseSha
    ? run(`git rev-list ${shellQuote(baseSha)}..HEAD`, { cwd: worktree }).stdout.trim().split('\n').filter(Boolean)
    : [];
  if (agentResult.agentStillRunning) {
    // FAIL DIRECTION: preserving a dirty or committed lane is cheaper than
    // resetting files underneath an agent that may still be writing. Fail
    // closed on every cleanup/retry path and leave the exact tree for recovery.
    const committed = agentCommits.length
      ? run(`git diff --name-only ${shellQuote(baseSha)}..HEAD`, { cwd: worktree }).stdout.trim().split('\n').filter(Boolean)
      : [];
    const produced = [...new Set([...committed, ...statusPaths(worktree)])]
      .filter((file) => !isBookkeeping(file, config));
    const verification = {
      taskId: task.id, attempt,
      branch, worktree, baseSha,
      agent: agentEvidence(agent),
      ...(backendFallbackReason ? { backendFallbackReason } : {}),
      modelCheck: models,
      ...(checklistPath ? { checklistPath } : {}),
      agentExitCode: agentResult.status, timedOut: agentResult.timedOut,
      durationMs, rateLimited, agentStillRunning: true,
      ...(agentResult.report ? { report: agentResult.report } : {}),
      producedFiles: produced,
      builderCommitsRetained: agentCommits,
      blocked: false,
      checks: [],
    };
    atomicWrite(resolve(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
    return { outcome: 'infra_failed', verification };
  }
  if (agentCommits.length) {
    const reset = run(`git reset --mixed ${shellQuote(baseSha)}`, { cwd: worktree });
    if (reset.status !== 0) throw new Error(`Cannot remove builder-owned commits for ${task.id}: ${reset.stderr}`);
  }

  const beforeProtection = statusPaths(worktree).filter((file) => !bootstrapped.has(file));
  const protectedEdits = config.protectedEdits ?? DEFAULT_PROTECTED_EDITS;
  const touchedProtected = beforeProtection.filter(isProtectedPath);
  const keptProtectedEdits = touchedProtected.filter((file) => allowedProtectedEdit(worktree, baseSha, file, protectedEdits));
  const protectedFiles = touchedProtected.filter((file) => !keptProtectedEdits.includes(file));
  restoreProtected(worktree, baseSha, protectedFiles);
  const changed = statusPaths(worktree);
  const advisory = changed.filter((file) => !isBookkeeping(file, config) && !pathAllowed(file, task.allowedPaths));
  // Reverted paths, not "protected" paths: a kept edit is this lane's output and
  // must count as such, or a lane whose whole job was wiring a script in reads
  // as having produced nothing and is marked blocked.
  const reverted = new Set(protectedFiles);
  const produced = changed.filter((file) => !isBookkeeping(file, config) && !reverted.has(file));
  // Read AFTER the revert, so the manifest asked is the one the checks below
  // actually run against rather than the one the builder wished for.
  let manifestText = null;
  try { manifestText = readFileSync(resolve(worktree, 'package.json'), 'utf8'); } catch { /* not a node project */ }
  const readSibling = (file) => {
    try { return readFileSync(resolve(worktree, file), 'utf8'); } catch { return ''; }
  };
  const unrunTests = unregisteredTestScripts(produced, manifestText, config.testScripts ?? DEFAULT_TEST_SCRIPTS, readSibling);
  const needsHumanAction = [...protectedActionItems(protectedFiles), ...unrunTestActionItems(unrunTests)];
  const checksInvalidated = checksInvalidatedBy(protectedFiles);

  // docs/findings.md 3.15: the lane boundary does not hold against the editing
  // tools, so the runner has to see the crossing itself. Read BEFORE the checks
  // run — an escaped lane must not spend minutes on a test suite whose verdict
  // cannot change the outcome, and the escape matters more than the verdict.
  //
  // The main checkout and every OTHER lane are foreign whatever the grant says.
  // Named explicitly rather than left to the grant, because a project is free
  // to put its worktrees somewhere the grant already covers — `$TMPDIR` is in
  // the grant, and this runner kept worktrees under `.afk/` until recently.
  const siblings = listAfkWorktrees(root)
    .map((entry) => entry.worktree)
    .filter((path) => path && canonical(path) !== canonical(worktree));
  const foreign = foreignWrites(
    raw,
    worktree,
    laneGrant(worktree, role.permissions.sandbox?.allowWrite ?? null),
    [root, ...siblings],
  );
  // Only writes that LANDED stop a run. A refused one is an attempt something
  // else already blocked, and halting an epic over a cap doing its job is the
  // false positive that would get this switched off.
  const escaped = landedWrites(foreign);

  let ok = agentResult.status === 0 && !rateLimited && !escaped.length;
  const checks = [];
  const skipRust = shouldSkipRustChecks(changed);
  // Without this the lane has no bound at all: `runAsync` defaults to 0, which
  // arms no timer, so a check that never returns holds the worktree and the
  // scheduler slot until a human intervenes.
  const checkTimeout = checkTimeoutMs(config);
  if (ok) for (const commandText of task.checks) {
    if (skipRust && isRustCheck(commandText)) {
      checks.push({ command: commandText, skipped: true, code: null, reason: 'run changed no Rust' });
      continue;
    }
    const check = await runAsync(commandText, {
      cwd: worktree,
      timeout: checkTimeout,
      env: { ...process.env, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH}` },
    });
    checks.push(checkResult(commandText, check, checkTimeout));
    if (checkFailed(checks.at(-1))) { ok = false; break; }
  }
  const blocked = ok && produced.length === 0;
  const brokerDecisions = readBrokerDecisions(runDir);
  // (#215) A retry is asked for a lesson in its closing message; the last
  // session's report is the one that says what it fixed. Absent is absent.
  const lesson = retryLesson(attempt, sessionsRaw.map((text) => finalText(text) || text));
  const verification = {
    taskId: task.id, attempt, branch, worktree, baseSha,
    // WHO built this, on WHICH model, at WHICH effort. One runner drives two
    // providers now, and the verification file is the only artifact that rides
    // the task branch — without these three a green lane says nothing about
    // what produced it, and a tier change is invisible in every post-mortem.
    agent: agentEvidence(agent),
    ...(backendFallbackReason ? { backendFallbackReason } : {}),
    // Which model(s) actually answered, against the one asked for. `agent.model`
    // above is the request; this is what the stream says served it.
    modelCheck: models,
    ...(checklistPath ? { checklistPath } : {}),
    agentExitCode: agentResult.status, timedOut: agentResult.timedOut, durationMs, rateLimited,
    ...(quotaRejected ? { quotaRejected } : {}),
    ...(escaped.length ? { wroteOutsideLane: escaped } : {}),
    // Recorded even when nothing landed: a builder that repeatedly tried to
    // leave its lane is worth seeing, and it is the only evidence that the
    // layer which refused it was doing anything.
    ...(foreign.length > escaped.length ? { attemptedOutsideLane: foreign.filter((e) => e.refused) } : {}),
    ...(agentResult.tokens ? { tokens: agentResult.tokens } : {}),
    ...(authFailure ? { authFailure: true } : {}),
    ...(agentResult.agentDied ? { agentDied: true } : {}),
    ...(agentResult.agentStillRunning ? { agentStillRunning: true } : {}),
    ...(agentResult.report ? { report: agentResult.report } : {}),
    // What the permission broker ruled on this lane's classifier escalations.
    // A denial does not fail the attempt, so this is the only record of it.
    ...(brokerDecisions ? { brokerDecisions } : {}),
    revertedProtected: protectedFiles,
    ...(keptProtectedEdits.length ? { keptProtectedEdits } : {}),
    // The reverts as ACTIONS. `revertedProtected` alone is a fact nothing reads;
    // this is the field a report, a PR body or a human can act on, and it rides
    // the committed copy below onto the task branch.
    ...(needsHumanAction.length ? { needsHumanAction } : {}),
    // Recorded separately from the reverts because they have a different cause
    // and a different fix: nothing stopped this lane wiring its test in, it just
    // did not. Advisory — the file is dark, but everything the checks DID run
    // still ran, so the lane's green is narrower than it looks rather than void.
    ...(unrunTests.length ? { unrunTestScripts: unrunTests } : {}),
    // The subset of the above that this lane's own verdict rests on. Separate
    // from `blocked` (which still means "produced nothing") because auto.mjs
    // reads both, and a reader has to be able to tell the two apart.
    ...(checksInvalidated.length ? { checksInvalidated } : {}),
    keptOutsideDeclaredPaths: advisory,
    producedFiles: produced, builderCommitsRemoved: agentCommits, blocked, checks,
    ...(lesson ? { lesson } : {}),
  };
  atomicWrite(resolve(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);

  // The copy auto.mjs reads back to decide whether a branch is safe to
  // integrate is attached to the task commit as a git note, below, once the
  // commit exists — never written into the lane's tree, where it would ride
  // the branch into the consumer's history and under its format gate (#106).
  // The prompt, the agent output and the changed-file list are forensics — no
  // code reads them here, and `.afk/runs/` above already holds them for the
  // dashboard, `afk stats` and a post-mortem.

  // Two surfaces, because the JSON line was the failure. The orchestrator log
  // is where a human looks while the run is going; the markdown file rides the
  // task branch into the PR, where it is impossible to merge past without
  // seeing. For most reverted paths these are reports rather than a gate — the
  // runner cannot know whether the edit mattered. For the build manifest it
  // can, and `checksInvalidated` below stops the lane outright.
  if (needsHumanAction.length) {
    const bullets = needsHumanAction.map((item) => `- ${item}`).join('\n');
    say(`WORKER: task ${task.id} NEEDS A HUMAN — ${needsHumanAction.length} item(s) this lane's green does not cover:\n${bullets}`);
    const taskRunDir = resolve(worktree, '.afk-runs', task.id);
    ensureDir(taskRunDir);
    atomicWrite(
      resolve(taskRunDir, 'ACTION-REQUIRED.md'),
      `# Task ${task.id} — human action required\n\nThe checks this lane reports green did not cover the items below.\n\n${bullets}\n`,
    );
  }

  // Before `rate_limited`, and that order is the whole point: a builder can be
  // rate-limited AND have written outside its lane, and `rate_limited` routes
  // through auto.mjs's retry, which calls `resetTaskWorktree`. That would wipe
  // this lane while the file it wrote elsewhere stayed exactly where it is —
  // the evidence destroyed and the escape kept.
  if (escaped.length) return { outcome: 'failed', verification };
  if (rateLimited) return { outcome: 'rate_limited', verification, rateLimit: stats.rateLimit, ...(quotaRejected ? { quotaRejected } : {}) };
  if (blocked) return { outcome: 'blocked', verification };
  if (!ok) return { outcome: 'failed', verification };

  const add = run('git add -A', { cwd: worktree });
  if (add.status !== 0) return { outcome: 'failed', verification: { ...verification, commitError: add.stderr } };
  const message = `task ${task.id}: ${task.title}`.replace(/["`$\\]/g, '');
  const commit = run(`git commit --no-verify -m ${shellQuote(message)}`, { cwd: worktree });
  if (commit.status !== 0) return { outcome: 'failed', verification: { ...verification, commitError: commit.stderr } };
  const commitSha = run('git rev-parse HEAD', { cwd: worktree }).stdout.trim();
  // The record the crash sweep and the restart path read back off this branch.
  // A note that could not be written is said out loud and recorded, not
  // thrown: the work is committed and the outcome below still stands, but a
  // restart will find no verification on the branch and rebuild the lane.
  const noteError = attachLaneVerification({ worktree, id: task.id, file: resolve(runDir, 'verification.json') });
  if (noteError) {
    verification.verificationNoteError = noteError;
    say(`WORKER: task ${task.id}: could not attach verification.json to ${commitSha.slice(0, 8)} as a git note (${noteError}); a restart will rebuild this lane instead of integrating it.`);
  }
  // After the commit, not before it. The lane does not integrate — its checks
  // ran against a tree the reverted manifest no longer describes, so its green
  // covers nothing — but the work, the verification and `ACTION-REQUIRED.md`
  // still have to ride the branch, or a human arrives at a blocked lane with
  // nothing to read. `blocked` rather than `failed` because a retry would hit
  // the same revert for the same reason; this needs a person, not another agent.
  if (checksInvalidated.length) return { outcome: 'blocked', verification, commitSha };
  return { outcome: 'ready_to_integrate', verification, commitSha };
};
