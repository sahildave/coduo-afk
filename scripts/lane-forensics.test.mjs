// scripts/lane-forensics.test.mjs — the three things a lane must not lose.
//
// Every case here is a live epic's post-mortem, not a hypothetical:
//
//   1. Four of six epics shipped a green run over a test file that never
//      executed. The builder wrote `scripts/test-<area>.ts`, wired it into
//      `package.json`'s `test` script exactly as the project's own
//      CODING_STANDARDS.md requires, and the runner reverted the wiring as a
//      "dependency manifest" edit. The old suite chain then ran and reported
//      green. 380 assertions were dark for a whole epic. A check that does not
//      run is indistinguishable from a check that passes.
//   2. Under `--runtime=herdr` the agent draws into a terminal pane and writes
//      no stream, so `agent-output.log` was empty for every lane. Four lanes
//      crashed and the retry replaced their panes; why they died is gone.
//   3. A failed lane's untracked files — one run's only real deliverable among
//      them — sit in a worktree that `afk finish` prunes without naming them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  agentOutputText, allowedProtectedEdit, checksInvalidatedBy, DEFAULT_TEST_SCRIPTS,
  editsOnlyKeys, protectedActionItems, runBuilder, unregisteredTestScripts,
  unrunTestActionItems,
} from './worker.mjs';
// Lives in lib.mjs because `afk validate` reads it too — the worker's revert and
// validate's refusal must not drift about what a builder may touch.
import { DEFAULT_PROTECTED_EDITS, isProtectedPath, MANIFEST_FILES, PROTECTED_FILES } from './lib.mjs';
import { paneText } from './runtime-herdr.mjs';
import { laneVerified } from './scheduler.mjs';
import { finishBlockers, laneUntracked } from './finish.mjs';
import { createTaskWorktree, readLaneVerification } from './worktree.mjs';

// --- 1. the protected-path revert -------------------------------------------

const manifest = (extra = {}) => JSON.stringify({
  name: 'app',
  version: '1.0.0',
  scripts: { test: 'bun run scripts/test-a.ts' },
  dependencies: { left: '^1.0.0' },
  ...extra,
}, null, 2);

test('an edit confined to the allowed keys is not a manifest change', () => {
  const after = manifest({ scripts: { test: 'bun run scripts/test-a.ts && bun run scripts/test-judgement.ts' } });
  assert.equal(editsOnlyKeys(manifest(), after, ['scripts']), true);
});

test('a dependency edit is still a manifest change, even alongside a scripts edit', () => {
  // The bundled case matters most: a builder that wires its test in AND adds a
  // dependency must not smuggle the dependency through on the back of the part
  // it was allowed to do.
  assert.equal(
    editsOnlyKeys(manifest(), manifest({ dependencies: { left: '^2.0.0' } }), ['scripts']),
    false,
  );
  assert.equal(
    editsOnlyKeys(
      manifest(),
      manifest({
        scripts: { test: 'bun run scripts/test-a.ts && bun run scripts/test-b.ts' },
        devDependencies: { vitest: '^1.0.0' },
      }),
      ['scripts'],
    ),
    false,
  );
  // And a version bump is a manifest change however small.
  assert.equal(editsOnlyKeys(manifest(), manifest({ version: '1.0.1' }), ['scripts']), false);
});

test('an unparseable or non-object manifest is never an allowed edit', () => {
  // The revert is the safe answer. A manifest a builder mangled into invalid
  // JSON is the last thing to wave through on the grounds that we cannot tell.
  assert.equal(editsOnlyKeys(manifest(), '{ not json', ['scripts']), false);
  assert.equal(editsOnlyKeys('{ not json', manifest(), ['scripts']), false);
  assert.equal(editsOnlyKeys('[]', '[1]', ['scripts']), false);
  assert.equal(editsOnlyKeys('null', 'null', ['scripts']), false);
});

test('the allowance is per project and per key, and lockfiles have none', () => {
  // The default reaches a project that never edits its config; the config can
  // widen or narrow it, and a file with no entry — every lockfile — is reverted
  // whole as before.
  assert.deepEqual(DEFAULT_PROTECTED_EDITS, { 'package.json': ['scripts'] });
  const wt = '/nowhere';
  assert.equal(allowedProtectedEdit(wt, 'HEAD', 'bun.lockb', DEFAULT_PROTECTED_EDITS), false);
  assert.equal(allowedProtectedEdit(wt, 'HEAD', 'package.json', {}), false);
  assert.equal(allowedProtectedEdit(wt, 'HEAD', 'package.json', { 'package.json': [] }), false);
});

test('a reverted path becomes a human action item, not a silent JSON line', () => {
  assert.deepEqual(protectedActionItems([]), []);
  const [item] = protectedActionItems(['package.json']);
  assert.match(item, /package\.json/);
  // The two things the epics needed said out loud: the checks did not cover it,
  // and here is where to change the rule.
  assert.match(item, /WITHOUT that edit/);
  assert.match(item, /protectedEdits/);
});

// --- 1b. the other half of the same failure: nobody reverted anything --------
// Epics 1, 2 and 5 shipped a dead suite with no revert in sight — the builder
// simply never appended its new `scripts/test-<area>.ts` to the `test` chain,
// which the project's own CODING_STANDARDS.md required and each child issue
// asked for. Two independent lanes broke it the same way and every gate stayed
// green. The revert fix above cannot see this one: there is nothing to record.

const scriptsOf = (test) => JSON.stringify({ name: 'app', scripts: { test } }, null, 2);

test('a produced test script the manifest never names is unrun', () => {
  const produced = ['app/screen.tsx', 'scripts/test-judgement.ts'];
  assert.deepEqual(
    unregisteredTestScripts(produced, scriptsOf('bun run scripts/test-a.ts')),
    ['scripts/test-judgement.ts'],
  );
  // Wired in, by either the path or the bare file name, and it is not flagged.
  assert.deepEqual(
    unregisteredTestScripts(produced, scriptsOf('bun run scripts/test-a.ts && bun run scripts/test-judgement.ts')),
    [],
  );
  // Anywhere in the `scripts` block counts, not only the `test` key: a project
  // is free to chain its suites through a script of its own, and flagging a
  // registered file would be the false positive that gets this switched off.
  assert.deepEqual(
    unregisteredTestScripts(produced, JSON.stringify({
      scripts: { test: 'bun run suite', suite: 'bun run scripts/test-judgement.ts' },
    })),
    [],
  );
});

test('a suite another registered file imports is not dark', () => {
  // Epic 6's lane chained `scripts/test-fillers.ts` into `scripts/test-alignment.ts`
  // with a side-effect import, because it could not edit package.json. The file
  // DOES run. Accusing it of being dark — and advising the human to drop it —
  // would be the false positive that gets this switched off, so the files the
  // manifest names are read and what they import counts as registration.
  const read = (file) => (file === 'scripts/test-alignment.ts' ? "import './test-fillers.ts';\n" : '');
  assert.deepEqual(
    unregisteredTestScripts(['scripts/test-fillers.ts'], scriptsOf('bun run scripts/test-alignment.ts'), DEFAULT_TEST_SCRIPTS, read),
    [],
  );
  // Without that import the same file is dark, which is the case this exists for.
  assert.deepEqual(
    unregisteredTestScripts(['scripts/test-fillers.ts'], scriptsOf('bun run scripts/test-alignment.ts'), DEFAULT_TEST_SCRIPTS, () => ''),
    ['scripts/test-fillers.ts'],
  );
});

test('a project that discovers a whole directory registers nothing by hand', () => {
  // `node --test scripts/` runs every file in there, so no entry will ever name
  // one and every lane would be accused. A directory named as a directory counts
  // as registration for everything under it.
  assert.deepEqual(unregisteredTestScripts(['scripts/test-x.ts'], scriptsOf('node --test scripts/')), []);
  assert.deepEqual(unregisteredTestScripts(['scripts/test-x.ts'], scriptsOf('bun test scripts')), []);
  // A file path that merely starts with the directory is not the directory.
  assert.deepEqual(
    unregisteredTestScripts(['scripts/test-x.ts'], scriptsOf('bun run scripts/test-a.ts')),
    ['scripts/test-x.ts'],
  );
});

test('only the paths the project registers by hand are candidates', () => {
  // `scripts/test-*` is the convention that REQUIRES registration. A glob-
  // discovered suite (`*.test.mjs`, which this very repo uses) is picked up by
  // the runner without an entry, so flagging it would cry wolf on every lane.
  assert.deepEqual(DEFAULT_TEST_SCRIPTS, ['scripts/test-*']);
  assert.deepEqual(unregisteredTestScripts(['scripts/lib.test.mjs'], scriptsOf('node --test')), []);
  assert.deepEqual(unregisteredTestScripts(['app/scripts/test-x.ts'], scriptsOf('node --test')), []);
  // Per project, like `protectedEdits`: a repo that keeps its suites elsewhere
  // says so and gets the same check over its own layout.
  assert.deepEqual(
    unregisteredTestScripts(['tests/judgement_test.py'], scriptsOf('pytest tests/a_test.py'), ['tests/*_test.py']),
    ['tests/judgement_test.py'],
  );
});

test('a manifest that cannot be read accuses nobody', () => {
  // Fail toward silence. "No package.json" is every non-node project, and a
  // mangled one is already the revert's problem — neither is evidence that a
  // test file is dark, and a warning nobody can act on trains people to ignore
  // the ones that matter.
  const produced = ['scripts/test-judgement.ts'];
  assert.deepEqual(unregisteredTestScripts(produced, null), []);
  assert.deepEqual(unregisteredTestScripts(produced, '{ not json'), []);
  assert.deepEqual(unregisteredTestScripts(produced, JSON.stringify({ name: 'app' })), []);
  assert.deepEqual(unregisteredTestScripts([], scriptsOf('bun run scripts/test-a.ts')), []);
});

test('an unrun test script is a human action item in the same words as a revert', () => {
  assert.deepEqual(unrunTestActionItems([]), []);
  const [item] = unrunTestActionItems(['scripts/test-judgement.ts']);
  assert.match(item, /scripts\/test-judgement\.ts/);
  assert.match(item, /never ran/);
  // Where to fix it, on the surface the builder could not reach for itself.
  assert.match(item, /test/);
});

// --- the same rule, end to end through a real builder -----------------------

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A repo with a `package.json`, and a fake `claude` that makes exactly the edit
 * the test names before writing its test file.
 */
const laneWith = (edit) => {
  const repo = mkdtempSync(join(tmpdir(), 'afk-protected-'));
  assert.equal(git(repo, 'init', '-b', 'main').status, 0);
  git(repo, 'config', 'user.email', 'runner@example.test');
  git(repo, 'config', 'user.name', 'Runner Test');
  writeFileSync(join(repo, '.gitignore'), '.afk/\n');
  writeFileSync(join(repo, 'package.json'), manifest());
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: '204', baseSha });

  const bin = mkdtempSync(join(tmpdir(), 'afk-fake-bin-'));
  const fake = join(bin, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.mkdirSync('scripts', { recursive: true });
  fs.writeFileSync('scripts/test-judgement.ts', '// 29 assertions\\n');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  ${edit}
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\\n');
});
`);
  chmodSync(fake, 0o755);
  return { repo, lane, baseSha, bin };
};

const buildIn = async ({ repo, lane, baseSha, bin }) => {
  const said = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    return {
      said,
      built: await runBuilder({
        root: repo,
        config: {
          maxParallel: 1,
          defaultChecks: [],
          agent: { command: 'claude', model: 'claude-opus-5', bypassPermissions: true, timeoutMs: 10_000, runtime: 'direct' },
        },
        task: {
          id: '204',
          title: 'Wire the judgement suite in',
          dependsOn: [],
          allowedPaths: ['**'],
          checks: [],
          body: '# 204\n\nAdd scripts/test-judgement.ts and append it to the `test` script.\n',
        },
        worktree: lane.worktree,
        branch: lane.branch,
        baseSha,
        attempt: 1,
        say: (line) => said.push(line),
      }),
    };
  } finally {
    process.env.PATH = previousPath;
  }
};

test('a scripts-only package.json edit survives the lane and reaches the commit', async () => {
  const fixture = laneWith("pkg.scripts.test += ' && bun run scripts/test-judgement.ts';");
  const { built, said } = await buildIn(fixture);
  assert.equal(built.outcome, 'ready_to_integrate');
  assert.deepEqual(built.verification.revertedProtected, []);
  assert.deepEqual(built.verification.keptProtectedEdits, ['package.json']);
  // The wiring is on the branch, so the gate the next lane runs is the NEW
  // chain. This is the whole point: an unrun test file is a green lie.
  assert.match(
    git(fixture.repo, 'show', `${built.commitSha}:package.json`).stdout,
    /test-judgement\.ts/,
  );
  assert.ok(built.verification.producedFiles.includes('package.json'));
  assert.equal(built.verification.needsHumanAction, undefined);
  assert.equal(said.length, 0);
});

test('a dependency edit is still reverted, and says so on three surfaces', async () => {
  const fixture = laneWith("pkg.dependencies.sneaky = '^9.9.9';");
  const { built, said } = await buildIn(fixture);
  assert.deepEqual(built.verification.revertedProtected, ['package.json']);
  assert.equal(
    JSON.parse(git(fixture.repo, 'show', `${built.commitSha}:package.json`).stdout).dependencies.sneaky,
    undefined,
  );
  // 1. the verification, as an action rather than a bare path. Two items: this
  // fixture's builder also leaves its test file out of the chain, which is the
  // other half of the same failure and reported alongside.
  assert.equal(built.verification.needsHumanAction.length, 2);
  assert.match(built.verification.needsHumanAction[0], /reverted it/);
  // 2. the orchestrator log, which is where a human looks during a run;
  assert.equal(said.filter((line) => /NEEDS A HUMAN/.test(line)).length, 1);
  // 3. the task branch, so a `passed` cannot be merged as an unqualified one.
  const committed = git(fixture.repo, 'show', `${built.commitSha}:.afk-runs/204/ACTION-REQUIRED.md`);
  assert.equal(committed.status, 0);
  assert.match(committed.stdout, /did not cover the items below/);
  assert.match(committed.stdout, /reverted it/);
});

test('a test file nobody wired in is named, on the same three surfaces', async () => {
  // No revert, nothing to record, every gate green: the lane simply wrote the
  // file and left the chain alone. Advisory, so the lane still integrates — the
  // checks that DID run still ran, and blocking here would strand work over a
  // file a human can wire in from the branch.
  const fixture = laneWith('');
  const { built, said } = await buildIn(fixture);
  assert.equal(built.outcome, 'ready_to_integrate');
  assert.deepEqual(built.verification.revertedProtected, []);
  assert.deepEqual(built.verification.unrunTestScripts, ['scripts/test-judgement.ts']);
  assert.equal(built.verification.needsHumanAction.length, 1);
  assert.equal(said.filter((line) => /NEEDS A HUMAN/.test(line)).length, 1);
  const committed = git(fixture.repo, 'show', `${built.commitSha}:.afk-runs/204/ACTION-REQUIRED.md`);
  assert.equal(committed.status, 0);
  assert.match(committed.stdout, /test-judgement\.ts/);
});

test('only a reverted check INPUT invalidates the lane, not every protected path', () => {
  // The distinction the gate rests on: does a check command read this file?
  // The manifest and its lockfiles decide what the checks run and what they run
  // against, so a revert there makes the lane's green cover nothing.
  assert.deepEqual(checksInvalidatedBy(['package.json']), ['package.json']);
  assert.deepEqual(checksInvalidatedBy(['pnpm-lock.yaml', 'yarn.lock']), ['pnpm-lock.yaml', 'yarn.lock']);
  // Everything else on the protected list is agent instruction, runner
  // bookkeeping or editor config. `.claude/` matters most: the herdr teardown
  // produces that revert on EVERY lane (F3.11), so blocking on it would block
  // every herdr run there is — and `scripts/selftest.mjs`'s happy path pins
  // exactly that lane as `ready_to_integrate`.
  assert.deepEqual(
    checksInvalidatedBy(['.claude/settings.json', 'planning/tasks/204.md', 'AGENTS.md', 'docs/progress.md', '.afk-setup/config.yaml']),
    [],
  );
  // Mixed: the manifest is named, the noise is not.
  assert.deepEqual(checksInvalidatedBy(['.claude/settings.json', 'package.json']), ['package.json']);
  assert.deepEqual(checksInvalidatedBy(), []);
});

test('a reverted manifest blocks the lane instead of reporting a green it did not cover', async () => {
  // The failure this exists for: the checks ran the OLD chain, reported green,
  // and the task was marked `passed` with 380 assertions never executed.
  const fixture = laneWith("pkg.dependencies.sneaky = '^9.9.9';");
  const { built } = await buildIn(fixture);
  assert.equal(built.outcome, 'blocked');
  assert.deepEqual(built.verification.checksInvalidated, ['package.json']);
  // Committed anyway, and the branch kept: a human arriving at a blocked lane
  // needs the work, the verification and ACTION-REQUIRED.md to read — and the
  // restart path needs the verification on the commit to refuse integrating it.
  assert.ok(built.commitSha);
  assert.deepEqual(readLaneVerification(fixture.repo, '204', fixture.lane.branch).checksInvalidated, ['package.json']);
});

test('a finished lane is recovered from its git note, and nothing of the runner\'s is in its tree (#106)', async () => {
  // The restart path: `afk auto` finds a committed task branch it has no
  // `ready_to_integrate` for and asks the branch whether it may integrate.
  // That record used to be `.afk-runs/204/verification.json`, committed on the
  // branch — and read by the consumer's own `format:check` at the next
  // integration. Now it is a note on the task commit.
  const fixture = laneWith("pkg.scripts.test += ' && bun run scripts/test-judgement.ts';");
  const { built } = await buildIn(fixture);
  assert.equal(built.outcome, 'ready_to_integrate');

  // Nothing under `.afk-runs/` reached the commit.
  const tree = git(fixture.repo, 'ls-tree', '-r', '--name-only', built.commitSha).stdout.split('\n');
  assert.deepEqual(tree.filter((path) => path.startsWith('.afk-runs/')), []);

  // The note is on the exact commit, and it is the record the sweep integrates on.
  const recovered = readLaneVerification(fixture.repo, '204', fixture.lane.branch);
  assert.equal(recovered.agentExitCode, 0);
  assert.equal(laneVerified(recovered), true);

  // Remove the read-back source and the same lane is no longer trusted: this
  // is what a restart does with it — recovery patch and rebuild, not a merge.
  git(fixture.repo, 'update-ref', '-d', 'refs/notes/afk-verification/204');
  assert.equal(readLaneVerification(fixture.repo, '204', fixture.lane.branch), null);
  assert.equal(laneVerified(null), false);
});

test('a lane whose only reverted path is noise still integrates', async () => {
  // `.claude/` is reverted, reported as a human action item, and does not stop
  // the lane. Both halves of the distinction in one lane.
  const fixture = laneWith("fs.mkdirSync('.claude', { recursive: true }); fs.writeFileSync('.claude/settings.json', '{}');");
  const { built, said } = await buildIn(fixture);
  assert.equal(built.outcome, 'ready_to_integrate');
  assert.deepEqual(built.verification.revertedProtected, ['.claude/settings.json']);
  assert.equal(built.verification.checksInvalidated, undefined);
  assert.equal(said.filter((line) => /NEEDS A HUMAN/.test(line)).length, 1);
});

test('the orchestrator hands `say` to every builder it spawns', () => {
  // Item 2, and the reason it is a test rather than a glance: `runBuilder`
  // defaults `say` to `console.log`, so the omission is invisible — the line
  // still prints, it just never reaches `.afk/agent-auto.log`, and a diagnosis
  // only one surface can see is not a diagnosis (AGENTS.md #7, #8).
  const auto = readFileSync(new URL('./auto.mjs', import.meta.url), 'utf8');
  const call = auto.slice(auto.indexOf('const promise = builder({'));
  assert.match(call.slice(0, call.indexOf('}).then(')), /^\s*say,$/m);
});

// --- 2. a crashed herdr lane keeps its diagnosis ----------------------------

test('the pane scrollback becomes agent-output.log when the stream is empty', () => {
  // The herdr runtime writes no stream at all, so `raw` is '' for every lane —
  // which is why every herdr `agent-output.log` was empty and four crashed
  // lanes left nothing to read.
  assert.equal(agentOutputText('', 'Error: connection reset\n$ '), 'Error: connection reset\n$ ');
  // A runtime that DID write its stream still wins: the structured transcript
  // is better evidence than a terminal redraw.
  const stream = JSON.stringify({ type: 'result', subtype: 'success', result: 'built it' });
  assert.equal(agentOutputText(stream, 'scrollback'), 'built it');
  // And nothing anywhere is an empty file, never a crash.
  assert.equal(agentOutputText('', null), '');
});

test('herdr pane output is read as text, whatever the CLI answers with', () => {
  // `herdr()` parses JSON when it can and hands back the raw string when it
  // cannot, and `pane read --format text` is the second case.
  assert.equal(paneText('  agent crashed  '), '  agent crashed  ');
  assert.equal(paneText({ result: { text: 'from json' } }), 'from json');
  assert.equal(paneText(null), '');
  assert.equal(paneText({ result: {} }), '');
});

// --- 3. a failed lane's untracked artifacts ---------------------------------

const lanes = (files) => laneUntracked('/repo', {
  list: () => [{ branch: 'refs/heads/afk/task-33', worktree: '/wt/33' }],
  untracked: () => files,
});

test('untracked files in a retained lane are reported by path and block the prune', () => {
  const found = lanes(['docs/acceptance/device-checklist.md', 'runs/33/report.md']);
  assert.deepEqual(found, [{
    taskId: '33',
    branch: 'afk/task-33',
    worktree: '/wt/33',
    files: ['docs/acceptance/device-checklist.md', 'runs/33/report.md'],
  }]);
  const [blocker] = finishBlockers({ state: { tasks: { 33: { lifecycle: 'failed' } } }, lanes: found });
  // By path, absolute, because the operator has to go and get the file.
  assert.match(blocker, /\/wt\/33\/docs\/acceptance\/device-checklist\.md/);
  assert.match(blocker, /afk\/task-33/);
  assert.match(blocker, /--discard-untracked/);
});

test('a clean lane blocks nothing, and the operator can still discard', () => {
  assert.deepEqual(lanes([]), []);
  assert.deepEqual(finishBlockers({ state: { tasks: { 33: { lifecycle: 'failed' } } } }), []);
  // `--discard-untracked` passes no lanes, which is the whole opt-out: the
  // blocker must never be able to wedge the command permanently.
  assert.deepEqual(finishBlockers({ state: { tasks: {} }, lanes: [] }), []);
});

test('`afk status` names the prunable artifacts while there is still time to save them', () => {
  // `afk finish` blocks on these, but it is the command that DELETES them, so
  // by the time it speaks the operator is at the point of loss. The 138-line
  // device-acceptance checklist survived only because a supervisor mentioned it.
  const repo = mkdtempSync(join(tmpdir(), 'afk-status-'));
  assert.equal(git(repo, 'init', '-b', 'main').status, 0);
  git(repo, 'config', 'user.email', 'runner@example.test');
  git(repo, 'config', 'user.name', 'Runner Test');
  writeFileSync(join(repo, '.gitignore'), '.afk/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: '33', baseSha });
  mkdirSync(join(lane.worktree, 'docs', 'acceptance'), { recursive: true });
  writeFileSync(join(lane.worktree, 'docs', 'acceptance', 'device-checklist.md'), '# 138 lines\n');
  mkdirSync(join(repo, '.afk'), { recursive: true });
  writeFileSync(
    join(repo, '.afk', 'state.json'),
    JSON.stringify({ dag: { tasks: [] }, tasks: { 33: { lifecycle: 'failed' } } }),
  );

  const status = spawnSync(process.execPath, [new URL('./status.mjs', import.meta.url).pathname], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.match(status.stdout, /lane 33 holds 1 untracked file\(s\)/);
  // Absolute, because the reader's next move is to open it.
  assert.match(status.stdout, new RegExp(`${lane.worktree}/docs/acceptance/device-checklist\\.md`));
  rmSync(repo, { recursive: true, force: true });
});

test('an untracked artifact outranks nothing — the other blockers still come first', () => {
  // Order is the contract of this function: stop the orchestrator, then finish
  // the tasks, then release the gates, and only then go and rescue a file.
  const blockers = finishBlockers({
    state: { tasks: { 33: { lifecycle: 'running' } } },
    lockPid: 4242,
    alive: () => true,
    lanes: lanes(['docs/acceptance/device-checklist.md']),
  });
  assert.match(blockers[0], /still running \(pid 4242\)/);
  assert.match(blockers[1], /have not finished/);
  assert.match(blockers.at(-1), /untracked/);
});

// ---------------------------------------------------------------------------
// 4. The two lists that have to agree about dependency manifests.
//
// `PROTECTED_FILES` decides what a lane's edit gets reverted; `CHECK_INPUT_FILES`
// decides whether that revert invalidates the lane's green. They were written
// out separately and drifted — `bun.lock`, bun's newer TEXT lockfile, was on
// neither, so in the two repos that use it a builder could move a dependency
// and nothing reverted or noticed. Adding it to the protected list ALONE would
// have been worse than leaving it: the lockfile reverted, the green standing,
// and the checks having run against a tree the manifest no longer describes,
// which is precisely the lie the protected list exists to prevent.
// ---------------------------------------------------------------------------

test('every protected dependency manifest also invalidates a green when reverted', () => {
  // The drift guard. One set now, imported by both sites; this asserts the
  // relationship rather than the membership, so a manifest added later cannot
  // land on one list only.
  for (const file of MANIFEST_FILES) {
    assert.ok(PROTECTED_FILES.has(file), `${file} is a manifest but is not protected`);
    assert.deepEqual(checksInvalidatedBy([file]), [file],
      `${file} is reverted but its revert leaves the lane's green standing`);
  }
});

test('bun.lock is protected and invalidates, like every other lockfile', () => {
  // docs-evalapp and voice-studio are on `bun.lock`. `bun.lockb` was covered
  // and its text replacement was not, which is the whole bug.
  assert.equal(isProtectedPath('bun.lock'), true);
  assert.deepEqual(checksInvalidatedBy(['bun.lock']), ['bun.lock']);
});

test('bookkeeping is protected WITHOUT invalidating — the sets are not the same list', () => {
  // The relationship is one-directional. `.claude/`, AGENTS.md and the progress
  // tables are reverted routinely (herdr's teardown produces the first on every
  // lane); treating those reverts as green-invalidating would block every herdr
  // lane there is.
  assert.equal(isProtectedPath('AGENTS.md'), true);
  assert.deepEqual(checksInvalidatedBy(['AGENTS.md', '.claude/settings.json']), []);
});

test('a file the bootstrap hook dirtied is not attributed to the builder, and is not reverted', async () => {
  // The revert baseline used to be read AFTER the agent ran and nowhere else,
  // so everything a `worktreeSetup.run` hook wrote looked like the builder's
  // work. With a lockfile protected that is not a mis-blame, it is a REVERT:
  // the file goes back to baseSha and the lane's installed tree no longer
  // matches its manifest — and the lane's green is invalidated for an edit no
  // agent made. Bun is clean today; a bun release that rewrites the lockfile on
  // install would do this to every lane in two repos.
  //
  // Make it fail first: revert the post-bootstrap snapshot in runBuilder and
  // this test goes red while the rest of the file stays green.
  const fixture = laneWith("pkg.scripts.lint = 'eslint .';");
  // Stand in for the hook: dirty a protected manifest in the lane BEFORE the
  // builder is invoked, which is exactly where bootstrapWorktree's `run` writes.
  writeFileSync(join(fixture.lane.worktree, 'bun.lock'), '# rewritten by bun install\n');
  const { built } = await buildIn(fixture);
  assert.deepEqual(built.verification.revertedProtected, [],
    'the hook\'s own write must not be reverted out from under the install');
  assert.deepEqual(built.verification.checksInvalidated ?? [], [],
    'and it must not invalidate a green the builder honestly earned');
  // THE HAZARD THIS LEAVES OPEN, recorded here because §21 asked for it in the
  // test rather than only in the code: the subtraction is by PATH. An agent
  // edit to a file the hook also dirtied is masked — the path is in the
  // bootstrap snapshot, so the agent's change to it is neither reverted nor
  // counted. Accepted: the alternative is hashing every bootstrapped path on
  // every lane, which costs more than the case is worth. If a lane ever ships a
  // dependency change that nothing reverted, this is the first place to look.
  // No assertion on needsHumanAction: the shared fixture's fake agent writes an
  // unwired test file, which raises an unrelated item of its own.
});

test('the builder\'s OWN edit to the same class of file is still caught', async () => {
  // The subtraction must not become a blanket exemption: the fake agent below
  // moves a dependency, which is the case the protected list exists for.
  const fixture = laneWith("pkg.dependencies.sneaky = '^9.9.9';");
  const { built } = await buildIn(fixture);
  assert.deepEqual(built.verification.revertedProtected, ['package.json']);
});
