// scripts/salvage.test.mjs — `afk salvage`: integrate a lane a human fixed
// after its builder finished, without rebuilding it.
//
// The case is Riverbend epic #109, task 110: a fix committed on top of the
// builder's commit carried no verification note, so the restart path would
// have thrown it away and started a new builder. The hand recovery copied the
// builder's note onto the fix, which recorded checks the fix never met.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { salvageLane } from './salvage.mjs';
import { deriveBlocked, laneVerified } from './scheduler.mjs';
import { createTaskWorktree, readLaneVerification } from './worktree.mjs';
import { writeConfig } from './test-helpers.mjs';

const AFK = fileURLToPath(new URL('../afk.mjs', import.meta.url));
const REF = 'refs/notes/afk-verification/110';
const CHECK = 'grep -q ok b.txt';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commitFile = (cwd, file, content, message) => {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const dag = {
  tasks: [
    { id: '110', dependsOn: [] },
    { id: '111', dependsOn: ['110'] },
  ],
};

/**
 * A run in which task 110's builder committed and noted its lane, the lane then
 * failed, 111 is blocked behind it, and the epic closed incomplete. `fix` is
 * the content of the human's commit on top, or null for no fix commit.
 */
const fixture = (t, { fix = 'ok\nfixed\n', checks = [CHECK] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-salvage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(dir, 'lanes');
  t.after(() => { if (previous === undefined) delete process.env.AFK_WORKTREE_ROOT; else process.env.AFK_WORKTREE_ROOT = previous; });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, '.gitignore'), '.afk/\n');
  git(repo, 'add', '.gitignore');
  const base = commitFile(repo, 'a.txt', 'a\n', 'base');

  const { worktree } = createTaskWorktree({ root: repo, id: '110', baseSha: base, setup: null });
  const builder = commitFile(worktree, 'b.txt', 'ok\nbug\n', 'task 110: builder');
  const note = join(dir, 'note.json');
  writeFileSync(note, JSON.stringify({
    taskId: '110', baseSha: base, agent: { model: 'builder-model' }, agentExitCode: 0, blocked: false,
    producedFiles: ['b.txt'], checks: checks.map((command) => ({ command, code: 0 })),
  }));
  git(repo, 'notes', `--ref=${REF}`, 'add', '-F', note, builder);
  const tip = fix === null ? builder : commitFile(worktree, 'b.txt', fix, 'fix 110 by hand');

  mkdirSync(join(repo, '.afk'));
  const statePath = join(repo, '.afk', 'state.json');
  writeFileSync(statePath, `${JSON.stringify({
    branch: 'main',
    tasks: {
      110: { lifecycle: 'failed', builderAttempt: 2, integrationAttempt: 1, retryAt: null },
      111: { lifecycle: 'blocked', blockedBy: '110' },
    },
    integrationQueue: [],
    activeWorkers: { 110: { pid: null } },
    epicClose: { lifecycle: 'closed', acceptances: { 110: { by: 'human' } } },
  }, null, 2)}\n`);
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const stateBytes = () => readFileSync(statePath, 'utf8');
  return { dir, repo, worktree, base, builder, tip, statePath, state, stateBytes };
};

const LESSON = 'none:"fixture fix; nothing to generalise"';
const salvage = (fx, options = {}) =>
  salvageLane({ root: fx.repo, id: '110', config: { defaultChecks: ['false'] }, say: () => {}, lesson: LESSON, ...options });

// #215: a hand fix brought back through salvage is a defect caught mid-run, and
// a defect that never becomes a rule is caught again next time. Written red
// first, before `--lesson` existed.
test('salvage without a lesson refuses, naming the three lesson shapes, and changes nothing', async (t) => {
  const fx = fixture(t);
  const before = fx.stateBytes();
  for (const lesson of [undefined, null, '', 'rule:only-an-id', 'standard:', 'bogus:"x"']) {
    const result = await salvage(fx, { lesson });
    assert.equal(result.ok, false, `lesson ${JSON.stringify(lesson)} was accepted`);
    assert.match(result.message, /^SALVAGE: a salvage needs a lesson/);
    assert.match(result.message, /--lesson=rule:<id>:<file>:<redOn>/);
    assert.match(result.message, /--lesson=standard:"<line>"/);
    assert.match(result.message, /--lesson=none:"<reason>"/);
  }
  assert.equal(readLaneVerification(fx.repo, '110', 'afk/task-110'), null);
  assert.equal(fx.stateBytes(), before);
});

test('a fix on top of the builder is verified at the tip and handed back for integration', async (t) => {
  const fx = fixture(t, { checks: [CHECK, 'cargo test'] });
  // The gap: the tip has no note, so the restart path would rebuild the lane.
  assert.equal(laneVerified(readLaneVerification(fx.repo, '110', 'afk/task-110')), false);

  const result = await salvage(fx);
  assert.equal(result.ok, true, result.message);

  const note = readLaneVerification(fx.repo, '110', 'afk/task-110');
  assert.equal(laneVerified(note), true);
  assert.equal(note.commitSha, fx.tip);
  assert.equal(note.salvage.from, fx.builder);
  assert.equal(note.salvage.checksFrom, 'note');
  // No agent built the fix, so the note claims none.
  assert.equal(note.agent, null);
  assert.equal(note.agentExitCode, null);
  // The builder's own checks ran, not defaultChecks (`false`), and the Rust
  // check was skipped because the lane changed no Rust.
  assert.deepEqual(note.checks.map((check) => [check.command, check.code, Boolean(check.skipped)]),
    [[CHECK, 0, false], ['cargo test', null, true]]);
  assert.deepEqual(note.producedFiles, ['b.txt']);
  // The builder's record is untouched on the builder's commit.
  assert.equal(JSON.parse(git(fx.repo, 'notes', `--ref=${REF}`, 'show', fx.builder)).agent.model, 'builder-model');

  const state = fx.state();
  const runtime = state.tasks['110'];
  assert.equal(runtime.lifecycle, 'ready_to_integrate');
  assert.equal(runtime.commitSha, fx.tip);
  assert.equal(runtime.baseSha, fx.base);
  assert.equal(runtime.builderAttempt, 0);
  assert.equal(state.activeWorkers['110'], undefined);
  assert.equal(state.epicClose.acceptances['110'], undefined);
  // What the relaunch does next turn: the dependent behind 110 unblocks.
  assert.deepEqual(deriveBlocked(dag, state), [{ id: '111', lifecycle: 'pending', blocker: null }]);
});

test('a red check writes no note and leaves state byte-for-byte alone', async (t) => {
  const fx = fixture(t, { fix: 'still wrong\n' });
  const before = fx.stateBytes();
  const result = await salvage(fx);
  assert.equal(result.ok, false);
  assert.match(result.message, /check failed: grep -q ok b\.txt/);
  assert.equal(readLaneVerification(fx.repo, '110', 'afk/task-110'), null);
  assert.equal(fx.stateBytes(), before);
});

test('uncommitted work in the lane refuses; the bootstrap\'s own output does not', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.repo, 'seed.txt'), 'seed\n');
  const config = { defaultChecks: ['false'], worktreeSetup: { copy: ['seed.txt'] } };

  writeFileSync(join(fx.worktree, 'stray.txt'), 'unsaved\n');
  const before = fx.stateBytes();
  const dirty = await salvage(fx, { config });
  assert.equal(dirty.ok, false);
  assert.match(dirty.message, /uncommitted changes \(stray\.txt\)/);
  assert.equal(fx.stateBytes(), before);

  rmSync(join(fx.worktree, 'stray.txt'));
  const clean = await salvage(fx, { config });
  assert.equal(clean.ok, true, clean.message);
});

test('a branch checked out in another checkout refuses instead of throwing', async (t) => {
  const fx = fixture(t);
  git(fx.repo, 'worktree', 'remove', fx.worktree);
  git(fx.repo, 'checkout', '-q', 'afk/task-110');
  const result = await salvage(fx);
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot set up the lane worktree: .*already (used|checked out)/s);
});

test('a tip that already carries a verified note runs no checks, keeps the builder\'s note, and is marked ready', async (t) => {
  // An `integration_failed` lane whose worktree was pruned: no restart path
  // re-queues it, so salvage must mark it even though there is nothing to check.
  const fx = fixture(t, { fix: null });
  git(fx.repo, 'worktree', 'remove', fx.worktree);
  const failed = fx.state();
  failed.tasks['110'].lifecycle = 'integration_failed';
  writeFileSync(fx.statePath, JSON.stringify(failed));
  const noteBefore = git(fx.repo, 'notes', `--ref=${REF}`, 'show', fx.builder);

  const result = await salvage(fx);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /ran no checks, kept that note/);
  // A check run would have written its record here.
  assert.equal(existsSync(join(fx.repo, '.afk', 'runs', '110', 'salvage-verification.json')), false);
  assert.equal(git(fx.repo, 'notes', `--ref=${REF}`, 'show', fx.builder), noteBefore);
  assert.equal(readLaneVerification(fx.repo, '110', 'afk/task-110').agent.model, 'builder-model');
  const runtime = fx.state().tasks['110'];
  assert.equal(runtime.lifecycle, 'ready_to_integrate');
  assert.equal(runtime.commitSha, fx.builder);
  assert.equal(runtime.baseSha, fx.base);
  assert.equal(fx.state().activeWorkers['110'], undefined);
});

test('a verified tip with uncommitted edits in the lane refuses, so the edits are not merged without', async (t) => {
  // The edits would be left out of the merge, and the lane worktree is
  // force-removed after it, so they would be lost.
  const fx = fixture(t, { fix: null });
  writeFileSync(join(fx.worktree, 'b.txt'), 'ok\nfixed but not committed\n');
  const before = fx.stateBytes();
  const result = await salvage(fx);
  assert.equal(result.ok, false);
  assert.match(result.message, /uncommitted changes \(b\.txt\)/);
  assert.equal(fx.stateBytes(), before);
});

test('a note on the history that does not parse refuses instead of falling back to defaultChecks', async (t) => {
  const fx = fixture(t);
  const corrupt = join(fx.dir, 'corrupt.json');
  writeFileSync(corrupt, '{ not json');
  git(fx.repo, 'notes', `--ref=${REF}`, 'add', '-f', '-F', corrupt, fx.builder);
  const before = fx.stateBytes();
  // `true` as defaultChecks: a silent fallback would pass and mark the lane ready.
  const result = await salvage(fx, { config: { defaultChecks: ['true'] } });
  assert.equal(result.ok, false, result.message);
  assert.match(result.message, /does not parse/);
  assert.equal(readLaneVerification(fx.repo, '110', 'afk/task-110'), null);
  assert.equal(fx.stateBytes(), before);
});

test('a dependency that has not succeeded refuses; no state.dag skips the check', async (t) => {
  const fx = fixture(t);
  const withDag = fx.state();
  withDag.dag = { tasks: [{ id: '109', dependsOn: [] }, { id: '110', dependsOn: ['109'] }] };
  withDag.tasks['109'] = { lifecycle: 'failed' };
  writeFileSync(fx.statePath, JSON.stringify(withDag));
  const before = fx.stateBytes();
  const refused = await salvage(fx);
  assert.equal(refused.ok, false, refused.message);
  assert.match(refused.message, /dependencies that have not succeeded: 109 \(failed\)/);
  assert.equal(fx.stateBytes(), before);

  // A state file from before `state.dag` existed: 109 is still failed, but
  // there is no shape to read the edge from, so salvage does not refuse on it.
  const noDag = JSON.parse(before);
  delete noDag.dag;
  writeFileSync(fx.statePath, JSON.stringify(noDag));
  const skipped = await salvage(fx);
  assert.equal(skipped.ok, true, skipped.message);
  git(fx.repo, 'update-ref', '-d', REF);
  git(fx.repo, 'notes', `--ref=${REF}`, 'add', '-F', join(fx.dir, 'note.json'), fx.builder);

  withDag.tasks['109'].lifecycle = 'no-op';
  writeFileSync(fx.statePath, JSON.stringify(withDag));
  assert.equal((await salvage(fx)).ok, true);
});

test('a lane that merged the run branch is measured from the merge-base, not the builder\'s base', async (t) => {
  const fx = fixture(t);
  commitFile(fx.repo, 'c.txt', 'c\n', 'run branch moves on');
  git(fx.worktree, 'merge', '-q', '--no-edit', 'main');
  const result = await salvage(fx);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.verification.producedFiles, ['b.txt']);
  assert.equal(fx.state().tasks['110'].baseSha, git(fx.repo, 'rev-parse', 'main'));
});

test('a commit that lands on the lane while the checks run gets no note', async (t) => {
  // The check itself commits, standing in for anyone committing to the lane
  // during a check window that can run thirty minutes.
  const fx = fixture(t, { checks: [`${CHECK} && git commit -q --allow-empty -m sneaked-in`] });
  const before = fx.stateBytes();
  const result = await salvage(fx);
  assert.equal(result.ok, false);
  assert.match(result.message, /moved from .* while the checks ran/);
  assert.equal(readLaneVerification(fx.repo, '110', 'afk/task-110'), null);
  assert.equal(fx.stateBytes(), before);
});

test('refusals: the orchestrator lock, a task that already succeeded, a --commit that is not the tip, no checks to run', async (t) => {
  const fx = fixture(t);
  const before = fx.stateBytes();

  writeFileSync(join(fx.repo, '.afk', 'orchestrator.lock'), '1');
  assert.match((await salvage(fx)).message, /while `afk auto` owns runtime state/);
  rmSync(join(fx.repo, '.afk', 'orchestrator.lock'));

  assert.match((await salvage(fx, { commit: fx.builder })).message, /is at .*, not /);

  git(fx.repo, 'update-ref', '-d', REF);
  assert.match((await salvage(fx, { config: {} })).message, /no checks to run/);
  assert.equal(fx.stateBytes(), before);

  for (const lifecycle of ['passed', 'no-op', 'awaiting_acceptance']) {
    const done = fx.state();
    done.tasks['110'].lifecycle = lifecycle;
    writeFileSync(fx.statePath, JSON.stringify(done));
    assert.match((await salvage(fx)).message, new RegExp(`is ${lifecycle}; there is nothing to salvage`));
  }
});

test('`afk salvage` runs end to end through the CLI', (t) => {
  const fx = fixture(t);
  writeConfig(fx.repo, { defaultChecks: ['false'] });
  const env = { ...process.env, AFK_WORKTREE_ROOT: join(fx.dir, 'lanes') };
  const bad = spawnSync(process.execPath, [AFK, 'salvage', '110', '--comit=abc'], { cwd: fx.repo, encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /unknown flag --comit/);

  const bare = spawnSync(process.execPath, [AFK, 'salvage', '110', `--commit=${fx.tip}`], { cwd: fx.repo, encoding: 'utf8', env });
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /SALVAGE: a salvage needs a lesson: .*--lesson=rule:<id>:<file>:<redOn>, --lesson=standard:"<line>" or --lesson=none:"<reason>"/);
  assert.equal(fx.state().tasks['110'].lifecycle, 'failed');

  const ok = spawnSync(process.execPath, [AFK, 'salvage', '110', `--commit=${fx.tip}`, '--lesson=standard:"Read b.txt before writing it"'], { cwd: fx.repo, encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /marked it ready_to_integrate/);
  assert.equal(fx.state().tasks['110'].lifecycle, 'ready_to_integrate');
  assert.deepEqual(fx.state().midRunDefects.map((defect) => [defect.taskId, defect.source, defect.lesson]),
    [['110', 'salvage', { class: 'standard', line: 'Read b.txt before writing it' }]]);
});
