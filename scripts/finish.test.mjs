// `afk finish` pruning, end to end against a real repo: the `worktreeSetup.finish`
// hook reaches every lane worktree before it goes (#109).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneLanes, renderFinishHooks } from './finish.mjs';
import { removeTaskWorktree, teardownWorktree, worktreeRoot } from './worktree.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A repo with two lane worktrees, the shape `afk finish` prunes. */
const fixture = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'afk-finish-')));
  const main = join(base, 'main');
  execFileSync('git', ['init', '-q', main]);
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', `echo hi > ${join(main, 'a.txt')}`]);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const before = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(base, 'lanes');
  t.after(() => {
    if (before === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  const lanes = ['1', '2'].map((id) => join(worktreeRoot(main), id));
  for (const [i, lane] of lanes.entries()) git(main, 'worktree', 'add', '-q', '-b', `afk/task-${i + 1}`, lane);
  return { base, main, lanes };
};

test('the finish hook runs once per pruned worktree, in that worktree, and a failing hook stops nothing', (t) => {
  const { base, main, lanes } = fixture(t);
  const log = join(base, 'hook.log');
  // Exits 1 every time: the first lane's failure must not skip the second's
  // hook, and neither failure may keep a worktree or throw out of `finish`.
  const setup = { finish: [`printf '%s\\n' "$PWD" >> ${JSON.stringify(log)}; echo kept nothing; exit 1`] };

  const { removed, hooks } = pruneLanes(main, ['1', '2'], { setup });

  // `base` is realpath'd, so git lists the lanes by the same path the hook saw.
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), [...lanes].sort(), 'the hook saw each lane as $PWD');
  assert.deepEqual(
    hooks.map((hook) => [hook.branch, hook.status, hook.output]),
    [['afk/task-1', 1, 'kept nothing'], ['afk/task-2', 1, 'kept nothing']],
  );
  assert.deepEqual(removed, [
    'afk/task-1 (worktree)', 'afk/task-2 (worktree)',
    'afk/task-1 (branch)', 'afk/task-2 (branch)',
  ]);
  // Rendered with the hook's own output, since only the hook knows what it deleted.
  assert.deepEqual(renderFinishHooks(hooks), [
    'FINISH: finish hook afk/task-1: printf \'%s\\n\' "$PWD" >> ' + JSON.stringify(log) + '; echo kept nothing; exit 1 → exit 1\n  kept nothing',
    'FINISH: finish hook afk/task-2: printf \'%s\\n\' "$PWD" >> ' + JSON.stringify(log) + '; echo kept nothing; exit 1 → exit 1\n  kept nothing',
  ]);
});

test('no finish hook configured prunes exactly as before, and a pruned branch takes its verification note with it', (t) => {
  const { main, lanes } = fixture(t);
  writeFileSync(join(main, 'v.json'), '{}\n');
  git(lanes[0], 'notes', '--ref=afk-verification/1', 'add', '-F', join(main, 'v.json'), 'HEAD');
  assert.equal(git(main, 'for-each-ref', 'refs/notes/afk-verification').trim().split('\n').length, 1);

  const { removed, hooks } = pruneLanes(main, ['1', '2']);
  assert.deepEqual(hooks, []);
  assert.equal(removed.length, 4);
  assert.equal(git(main, 'for-each-ref', 'refs/notes/afk-verification').trim(), '');
});

test('a passed lane runs the finish hook when its worktree goes at integration, not only at afk finish', (t) => {
  // Most worktrees are removed mid-run by `removeTaskWorktree`, the moment a
  // lane integrates. A hook that only ran under `afk finish` would meet the
  // failed lanes and miss the 14 devices for pruned worktrees the issue counted.
  const { base, main, lanes } = fixture(t);
  const log = join(base, 'hook.log');
  const setup = { finish: [`printf '%s' "$PWD" > ${JSON.stringify(log)}`] };
  const cleanup = removeTaskWorktree({ root: main, id: '1', branch: 'afk/task-1', setup });
  assert.equal(readFileSync(log, 'utf8'), lanes[0]);
  assert.deepEqual(cleanup.hooks.map((hook) => hook.status), [0]);
  assert.equal(cleanup.branchDeleted, true);
});

test('a hook that hangs is cut off and reported, and the next hook still runs', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'afk-hook-timeout-')));
  try {
    const hooks = teardownWorktree({ worktree: dir, setup: { teardown: ['sleep 30', 'echo second'] }, timeoutMs: 300 });
    assert.match(hooks[0].output, /timed out after/);
    assert.equal(hooks[0].status, null);
    assert.deepEqual([hooks[1].status, hooks[1].output], [0, 'second']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
