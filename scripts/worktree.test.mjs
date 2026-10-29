// Lane bookkeeping that has to stay correct once two epics share one repo:
// which lanes are OURS, and which checkout herdr must be pointed at.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpicWorktree, epicWorktree, foreignLane, listAfkWorktrees, liveEpics, sharedBuildPaths, taskWorktree, worktreeRoot }
  from './worktree.mjs';
import { mainCheckout } from './runtime-herdr.mjs';
import { pruneLanes, removeEpicWorktree } from './finish.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A repo with a main checkout, an epic worktree, and a lane in each. */
const fixture = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-')));
  const main = join(base, 'main');
  execFileSync('git', ['init', '-q', main]);
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  execFileSync('sh', ['-c', `echo hi > ${join(main, 'a.txt')}`]);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const epic = join(base, 'epic');
  git(main, 'worktree', 'add', '-q', '-b', 'epic-1', epic);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, main, epic };
};

/**
 * Point the lane (and epic) roots at a directory this test owns.
 *
 * Restores rather than deletes: `scripts/selftest.mjs` sets AFK_WORKTREE_ROOT
 * once for the whole run so tests never write real worktrees into the home
 * directory, and it runs every test file in ONE process. A `delete` here would
 * unset it for everything that follows.
 */
const useRoots = (t, base) => {
  const before = { wt: process.env.AFK_WORKTREE_ROOT, epic: process.env.AFK_EPIC_ROOT };
  process.env.AFK_WORKTREE_ROOT = join(base, 'lanes');
  process.env.AFK_EPIC_ROOT = join(base, 'epics');
  t.after(() => {
    for (const [key, value] of [['AFK_WORKTREE_ROOT', before.wt], ['AFK_EPIC_ROOT', before.epic]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

test('mainCheckout resolves a linked worktree back to the checkout that owns it', (t) => {
  const { main, epic } = fixture(t);
  assert.equal(realpathSync(mainCheckout(epic)), main);
});

test('mainCheckout leaves an ordinary checkout alone', (t) => {
  const { main } = fixture(t);
  assert.equal(realpathSync(mainCheckout(main)), main);
});

test('mainCheckout falls back to root outside a repo rather than throwing', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'afk-nogit-')));
  try { assert.equal(mainCheckout(outside), outside); }
  finally { rmSync(outside, { recursive: true, force: true }); }
});

test('a sibling checkout\'s lane is foreign; our own is not', () => {
  const mine = worktreeRoot('/repos/thing');
  assert.equal(foreignLane('/repos/thing', join(mine, '42')), false);
  assert.equal(foreignLane('/repos/thing', join(worktreeRoot('/repos/thing-epic-7'), '42')), true);
});

test('a lane outside the shared base is kept, not excluded', () => {
  // The stray `pruneLanes` exists to catch: an older layout, or a different
  // AFK_WORKTREE_ROOT than the one in force now.
  assert.equal(foreignLane('/repos/thing', '/repos/thing/.afk/worktrees/42'), false);
  assert.equal(foreignLane('/repos/thing', '/somewhere/else/42'), false);
});

test('listAfkWorktrees drops another epic worktree\'s lanes and keeps ours', (t) => {
  const { base, main, epic } = fixture(t);
  useRoots(t, base);

  const ours = join(worktreeRoot(epic), '1');
  const theirs = join(worktreeRoot(main), '2');
  git(main, 'worktree', 'add', '-q', '-b', 'afk/task-1', ours);
  git(main, 'worktree', 'add', '-q', '-b', 'afk/task-2', theirs);

  // git lists all four from either checkout; the filter is what differs.
  assert.deepEqual(
    listAfkWorktrees(epic).map((e) => e.branch),
    ['refs/heads/afk/task-1'],
  );
  assert.deepEqual(
    listAfkWorktrees(main).map((e) => e.branch),
    ['refs/heads/afk/task-2'],
  );
});

test('pruneLanes leaves a sibling epic\'s lane worktree and branch alone', (t) => {
  const { base, main, epic } = fixture(t);
  useRoots(t, base);

  git(main, 'worktree', 'add', '-q', '-b', 'afk/task-1', join(worktreeRoot(epic), '1'));
  git(main, 'worktree', 'add', '-q', '-b', 'afk/task-2', join(worktreeRoot(main), '2'));
  // The sibling's branch with its worktree already gone — the case `git branch`
  // would happily delete if the second pass were not scoped.
  git(main, 'branch', 'afk/task-3');

  const { removed } = pruneLanes(epic, ['1']);
  assert.deepEqual(removed, ['afk/task-1 (worktree)', 'afk/task-1 (branch)']);
  const left = git(main, 'branch', '--list', 'afk/task-*', '--format=%(refname:short)');
  assert.deepEqual(left.trim().split('\n').sort(), ['afk/task-2', 'afk/task-3']);
});

test('the epic worktree is created on its branch and reused on a restart', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  git(main, 'branch', 'feat/7-thing');

  const first = createEpicWorktree({ root: main, branch: 'feat/7-thing', epicId: '7' });
  assert.equal(first.reused, false);
  assert.equal(first.worktree, epicWorktree(main, '7'));
  assert.equal(git(first.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/7-thing');

  const again = createEpicWorktree({ root: main, branch: 'feat/7-thing', epicId: '7' });
  assert.equal(again.reused, true);
  assert.equal(again.worktree, first.worktree);
});

test('an epic worktree on the wrong branch is refused, not moved', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  git(main, 'branch', 'feat/7-thing');
  git(main, 'branch', 'feat/8-other');
  createEpicWorktree({ root: main, branch: 'feat/7-thing', epicId: '7' });

  assert.throws(
    () => createEpicWorktree({ root: main, branch: 'feat/8-other', epicId: '7' }),
    /is on feat\/7-thing, not feat\/8-other/,
  );
});

test('an epic worktree is not a lane, and is invisible to lane bookkeeping', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  git(main, 'branch', 'feat/7-thing');
  const epicRoot = createEpicWorktree({ root: main, branch: 'feat/7-thing', epicId: '7' }).worktree;
  git(main, 'worktree', 'add', '-q', '-b', 'afk/task-1', join(worktreeRoot(epicRoot), '1'));

  assert.deepEqual(listAfkWorktrees(epicRoot).map((e) => e.branch), ['refs/heads/afk/task-1']);
  assert.equal(foreignLane(epicRoot, epicRoot), false);
});

// --- private parents --------------------------------------------------------
// A build path written relative to the checkout and escaping it — cargo's
// `target-dir = "../.atlas-target"` is the live case — resolves to ONE directory
// when the worktrees are siblings. Two cargo runs then share a build lock.

test('two epics of one checkout do not share the directory above their worktrees', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  const a = epicWorktree(main, '388');
  const b = epicWorktree(main, '389');
  assert.notEqual(dirname(a), dirname(b), 'a relative escape path would collide');
  assert.equal(join(a, '..', '.atlas-target').startsWith(dirname(a)), true);
});

test('two lanes of one epic do not share the directory above their worktrees', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  assert.notEqual(dirname(taskWorktree(main, '204')), dirname(taskWorktree(main, '205')));
  // Still one lane root per checkout, so `pruneRoleCwds` and `foreignLane` hold.
  assert.equal(foreignLane(main, taskWorktree(main, '204')), false);
});

test('a worktree from the flat layout is reused where it stands', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  // What is on disk from a run started by an earlier version: the checkout IS
  // the directory the new layout would use as a private parent.
  const flat = dirname(epicWorktree(main, '23'));
  git(main, 'branch', 'docs/23-closeout');
  git(main, 'worktree', 'add', '-q', flat, 'docs/23-closeout');
  assert.equal(epicWorktree(main, '23'), flat);
  assert.equal(createEpicWorktree({ root: main, branch: 'docs/23-closeout', epicId: '23' }).reused, true);
});

// --- what the private parent cannot cover -----------------------------------

const cargoConfig = (t, targetDir) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-cargo-')));
  mkdirSync(join(root, '.cargo'));
  writeFileSync(join(root, '.cargo', 'config.toml'), `[build]\ntarget-dir = "${targetDir}"\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a cargo target-dir that escapes past the private parent is named with its resolved path', (t) => {
  const root = cargoConfig(t, '../../shared-target');
  assert.deepEqual(sharedBuildPaths(root), [{
    file: '.cargo/config.toml',
    key: 'build.target-dir',
    value: '../../shared-target',
    resolved: join(root, '..', '..', 'shared-target').replace(/\/[^/]+\/\.\.\/[^/]+\/\.\.\//, '/'),
  }]);
});

test('an absolute cargo target-dir is shared however shallow it looks', (t) => {
  const root = cargoConfig(t, '/tmp/afk-abs-target');
  assert.deepEqual(sharedBuildPaths(root).map((e) => e.resolved), ['/tmp/afk-abs-target']);
});

test('a cargo target-dir the private parent already covers is not warned about', (t) => {
  assert.deepEqual(sharedBuildPaths(cargoConfig(t, '../.atlas-target')), []);
  assert.deepEqual(sharedBuildPaths(cargoConfig(t, 'target')), []);
  // A `target-dir` outside `[build]` is a different setting entirely.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-cargo-')));
  mkdirSync(join(root, '.cargo'));
  writeFileSync(join(root, '.cargo', 'config.toml'), '[other]\ntarget-dir = "../../x"\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(sharedBuildPaths(root), []);
});

test('a checkout with no cargo config reports nothing', (t) => {
  const { main } = fixture(t);
  assert.deepEqual(sharedBuildPaths(main), []);
});

// ---------------------------------------------------------------------------
// Two epics, one clone, one file (docs/failure-modes.md R17)
// ---------------------------------------------------------------------------

const writeState = (root, state) => {
  mkdirSync(join(root, '.afk'), { recursive: true });
  writeFileSync(join(root, '.afk', 'state.json'), JSON.stringify(state));
};

/** The fixture plus a second epic worktree under the epics base, holding state. */
const concurrentEpic = (t, { pid = process.pid, claimedPaths = ['locales/en.json'] } = {}) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  git(main, 'branch', 'feat/389-compose');
  const made = createEpicWorktree({ root: main, branch: 'feat/389-compose', epicId: '389' });
  writeState(made.worktree, {
    orchestratorPid: pid, epic: { id: '389' }, branch: 'feat/389-compose', claimedPaths,
  });
  return { base, main, worktree: made.worktree };
};

test('liveEpics reports a concurrent epic on this clone and the paths it claims', (t) => {
  const { main } = concurrentEpic(t);
  const live = liveEpics({ root: main, exclude: '388' });
  assert.deepEqual(live.map((entry) => entry.id), ['389']);
  assert.deepEqual(live[0].paths, ['locales/en.json']);
  assert.equal(live[0].branch, 'feat/389-compose');
});

test('liveEpics ignores an epic whose orchestrator exited (state.json was never archived)', (t) => {
  // `orchestratorPid: null` is what runAuto writes on the way out. A state file
  // that outlived its run must not block a new epic forever.
  const { main } = concurrentEpic(t, { pid: null });
  assert.deepEqual(liveEpics({ root: main, exclude: '388' }), []);
});

test('liveEpics ignores an epic whose orchestrator died without cleaning up', (t) => {
  const { main } = concurrentEpic(t, { pid: 0x7ffffff });
  assert.deepEqual(liveEpics({ root: main, exclude: '388' }), []);
});

test('liveEpics never reports the epic being started against itself', (t) => {
  const { main } = concurrentEpic(t);
  assert.deepEqual(liveEpics({ root: main, exclude: 389 }), []);
});

test('liveEpics sees an epic running in the main checkout, not only in a worktree', (t) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  writeState(main, {
    orchestratorPid: process.pid, epic: { id: '390' }, branch: 'feat/390', claimedPaths: ['src/a.js'],
  });
  assert.deepEqual(liveEpics({ root: main, exclude: '388' }).map((entry) => entry.id), ['390']);
});

// --- the epic's own directory at `afk finish` ------------------------------
// Whoever creates the parent deletes it. Three closed epics left 48 GB behind in
// `~/.afk-claude/epics/<slug>-<id>/.atlas-target`: finish pruned the lanes and
// nothing ever removed the epic's own folder or what cargo built beside it.

const FINISH = join(dirname(new URL(import.meta.url).pathname), 'finish.mjs');

/** An epic worktree as `afk epic --worktree` leaves it: run state inside, build output beside. */
const finishedEpic = (t, { lifecycle = 'passed', tasks = null } = {}) => {
  const { base, main } = fixture(t);
  useRoots(t, base);
  git(main, 'branch', 'feat/7-thing');
  const { worktree } = createEpicWorktree({ root: main, branch: 'feat/7-thing', epicId: '7' });
  const parent = dirname(worktree);
  mkdirSync(join(parent, '.atlas-target', 'debug'), { recursive: true });
  writeFileSync(join(parent, '.atlas-target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(join(parent, '.atlas-target', 'debug', 'app'), 'binary');
  mkdirSync(join(worktree, '.afk'), { recursive: true });
  writeFileSync(join(worktree, '.afk', 'state.json'), JSON.stringify({
    dag: { epic: { id: '7' }, branch: 'feat/7-thing' },
    tasks: tasks ?? { 11: { lifecycle } },
  }));
  return { base, main, worktree, parent };
};

const runFinish = (worktree) => spawnSync(process.execPath, [FINISH], { cwd: worktree, env: process.env, encoding: 'utf8' });

test('afk finish removes the epic worktree and its whole <slug>-<id> folder, build output included', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  const result = runFinish(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`removed epic worktree ${parent}`));
  assert.equal(existsSync(parent), false, 'the folder and its .atlas-target are gone');
  assert.equal(git(main, 'worktree', 'list').includes(worktree), false);
  // The branch is the PR; the run's record survives in the main checkout.
  assert.equal(git(main, 'branch', '--list', 'feat/7-thing').trim(), 'feat/7-thing');
  assert.match(readFileSync(join(main, '.afk', 'archive', 'epic-7', 'state.json'), 'utf8'), /feat\/7-thing/);
});

test('afk finish keeps the epic worktree when a task did not pass, so a rerun can resume', (t) => {
  const { worktree, parent } = finishedEpic(t, { lifecycle: 'failed' });
  const result = runFinish(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retained epic worktree .* not every task passed/);
  assert.equal(existsSync(join(parent, '.atlas-target', 'debug', 'app')), true);
});

test('a kept epic worktree prints the two commands that remove it by hand', (t) => {
  const { worktree, parent } = finishedEpic(t, { lifecycle: 'failed' });
  const result = runFinish(worktree);
  assert.ok(result.stdout.includes(`\n  git worktree remove '${worktree}'\n  rm -rf '${parent}'\n`), result.stdout);
});

test('afk finish keeps the epic worktree when state lists no tasks', (t) => {
  const { worktree, parent } = finishedEpic(t, { tasks: {} });
  const result = runFinish(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retained epic worktree .* lists no tasks/);
  assert.equal(existsSync(join(parent, '.atlas-target', 'debug', 'app')), true);
});

test('a locked epic worktree that git will not remove keeps its parent and reports git\'s error', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  git(main, 'worktree', 'lock', worktree);
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main });
  assert.match(outcome.kept, /git worktree remove failed: .*locked/);
  assert.equal(existsSync(join(parent, '.atlas-target', 'debug', 'app')), true);
  assert.equal(existsSync(join(worktree, 'a.txt')), true);
});

test('an epic folder that also holds another clone\'s checkout keeps it and names the entry', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  // /x/a-b and /x/a/b slug to the same folder; the other clone's checkout sits beside ours.
  mkdirSync(join(parent, 'b'));
  writeFileSync(join(parent, 'b', 'live.txt'), 'another epic');
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main });
  assert.match(outcome.kept, /also holds b, which are not build caches/);
  assert.equal(readFileSync(join(parent, 'b', 'live.txt'), 'utf8'), 'another epic');
  assert.equal(existsSync(join(parent, '.atlas-target', 'debug', 'app')), true);
});

test('an epic worktree whose HEAD is on no local branch is kept', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  git(worktree, 'checkout', '-q', '--detach');
  writeFileSync(join(worktree, 'b.txt'), 'orphan\n');
  git(worktree, 'add', 'b.txt');
  git(worktree, 'commit', '-qm', 'detached work');
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main });
  assert.match(outcome.kept, /HEAD is on no local branch/);
  assert.equal(existsSync(join(worktree, 'b.txt')), true);
  assert.equal(existsSync(parent), true);
});

test('the finish hook runs before the dirty check, so a file it writes keeps the worktree', (t) => {
  const { main, worktree } = finishedEpic(t);
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main, setup: { finish: ['echo hook > hook-wrote.txt'] } });
  assert.match(outcome.kept, /not the runner's: hook-wrote\.txt/);
  assert.equal(existsSync(join(worktree, 'hook-wrote.txt')), true);
});

test('afk finish names the ignored files it deletes, but not build caches or the runner\'s own', (t) => {
  const { main, worktree } = finishedEpic(t);
  writeFileSync(join(main, '.git', 'info', 'exclude'), '.env.local\ntarget/\n.afk/\n');
  writeFileSync(join(worktree, '.env.local'), 'SECRET=1\n');
  mkdirSync(join(worktree, 'target'));
  writeFileSync(join(worktree, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  const result = runFinish(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ignored files deleted with the epic worktree: \.env\.local\n/);
});

test('an archive copy that collides fails closed instead of merging into the older record', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  const older = join(main, '.afk', 'archive', 'epic-7');
  const collision = `${older}-42`;
  for (const dir of [older, collision]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), 'older run');
  }
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main, now: () => 42 });
  assert.match(outcome.kept, /could not copy its \.afk\/.*nothing deleted/);
  assert.equal(readFileSync(join(collision, 'state.json'), 'utf8'), 'older run');
  assert.equal(existsSync(parent), true);
});

test('an epic worktree holding changes that are not the runner\'s is kept and named, never forced', (t) => {
  const { main, worktree, parent } = finishedEpic(t);
  writeFileSync(join(worktree, 'notes.md'), 'a human wrote this\n');
  const outcome = removeEpicWorktree({ root: worktree, epicId: '7', main });
  assert.match(outcome.kept, /1 uncommitted file\(s\) that are not the runner's: notes\.md/);
  assert.equal(existsSync(join(worktree, 'notes.md')), true);
  assert.equal(existsSync(join(parent, '.atlas-target')), true);
});

test('removing an epic folder refuses any checkout the runner did not create for that epic', (t) => {
  const { base, main, worktree, parent } = finishedEpic(t);
  const elsewhere = join(base, 'elsewhere', 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'side', elsewhere);
  writeFileSync(join(dirname(elsewhere), 'keep.txt'), 'keep');
  for (const [root, epicId] of [[main, '7'], [elsewhere, '7'], [worktree, '8']])
    assert.match(removeEpicWorktree({ root, epicId, main }).refused, /is not the worktree afk created for epic/, `${root} #${epicId}`);
  assert.equal(existsSync(join(dirname(elsewhere), 'keep.txt')), true);
  assert.equal(existsSync(join(main, 'a.txt')), true);
  assert.equal(existsSync(parent), true);
});

// ---------------------------------------------------------------------------
// One worktree root (#228): ~/code/worktrees/<repo>/<kind>/<name>
// ---------------------------------------------------------------------------

/**
 * Run `code` against worktree.mjs in a child process whose HOME is `home` and
 * whose environment carries neither override, so the defaults are what is
 * measured. A child, not this process: the suite sets both overrides for every
 * file, and this file runs in one process.
 */
const withDefaults = (home, code) => {
  const env = { ...process.env, HOME: home };
  delete env.AFK_WORKTREE_ROOT;
  delete env.AFK_EPIC_ROOT;
  const moduleUrl = new URL('./worktree.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const wt = await import(${JSON.stringify(moduleUrl)});\nconst out = await (async () => { ${code} })();\nprocess.stdout.write(JSON.stringify(out));`],
  { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('a new epic and its lane land under ~/code/worktrees/<repo>/, each in its own parent folder', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const main = join(home, 'src', 'atlas');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'a.txt'), 'hi\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  git(main, 'branch', 'feat/232');
  const out = withDefaults(home, `
    const epic = wt.createEpicWorktree({ root: ${JSON.stringify(main)}, branch: 'feat/232', epicId: '232', setup: {} }).worktree;
    const sha = wt.currentBaseSha(epic, 'feat/232');
    const lane = wt.createTaskWorktree({ root: epic, id: '5', baseSha: sha, setup: {} }).worktree;
    const lane2 = wt.taskWorktree(epic, '6');
    return { epic, lane, lane2, isEpic: wt.isEpicCheckout(epic), lanes: wt.listAfkWorktrees(epic).map((entry) => entry.worktree) };
  `);
  const root = join(home, 'code', 'worktrees', 'atlas');
  assert.equal(out.epic, join(root, 'epic', '232', 'atlas'));
  assert.equal(out.lane, join(root, 'lane', '232', '5', 'atlas'));
  assert.equal(out.lane2, join(root, 'lane', '232', '6', 'atlas'));
  assert.equal(out.isEpic, true);
  assert.deepEqual(out.lanes, [out.lane], 'the lane is this epic\'s own, not foreign');
  // The private-parent rule: nothing else shares the folder above a worktree.
  assert.deepEqual(readdirSync(dirname(out.epic)), ['atlas']);
  assert.deepEqual(readdirSync(dirname(out.lane)), ['atlas']);
  assert.notEqual(dirname(out.lane), dirname(out.lane2));
  assert.equal(existsSync(join(home, '.afk-claude', 'worktrees')), false);
  assert.equal(existsSync(join(home, '.afk-claude', 'epics')), false);
});

/** A clone at `<home>/src/<name>` with one commit. */
const cloneAt = (home, name) => {
  const main = join(home, 'src', name);
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'a.txt'), 'hi\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  return main;
};

test('removing the last lane drops lane/<key>/ and lane/, and the sweep drops only orphan claims', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gone = cloneAt(home, 'gone');
  const live = cloneAt(home, 'live');
  const base = join(home, 'code', 'worktrees');
  // An orphan claim with something else in the folder: not the runner's to delete.
  mkdirSync(join(base, 'busy'), { recursive: true });
  writeFileSync(join(base, 'busy', '.afk-repo'), `${join(home, 'nowhere', '.git')}\n`);
  writeFileSync(join(base, 'busy', 'notes.md'), 'mine\n');
  // An orphan claim whose name a second clone holds as `<name>-<hash>`: deleting
  // it would move that clone's lanes to `<name>` mid-run.
  mkdirSync(join(base, 'twin'), { recursive: true });
  writeFileSync(join(base, 'twin', '.afk-repo'), `${join(home, 'gone-twin', '.git')}\n`);
  mkdirSync(join(base, 'twin-0a1b2c', 'lane'), { recursive: true });
  const lanes = (root) => `
    const sha = wt.currentBaseSha(${JSON.stringify(root)}, 'main');
    const lane = wt.createTaskWorktree({ root: ${JSON.stringify(root)}, id: '5', baseSha: sha, setup: {} }).worktree;
    const removed = wt.removeTaskWorktree({ root: ${JSON.stringify(root)}, id: '5', branch: 'afk/task-5' });
    return { lane, removed: removed.removed };`;
  const first = withDefaults(home, lanes(gone));
  withDefaults(home, lanes(live));
  assert.equal(first.lane.startsWith(join(base, 'gone', 'lane') + '/'), true, first.lane);
  assert.equal(first.removed, true);
  // The lane's parents are gone; the claim stays while its clone exists.
  assert.deepEqual(readdirSync(join(base, 'gone')), ['.afk-repo']);
  assert.deepEqual(readdirSync(join(base, 'live')), ['.afk-repo']);
  // The clone is deleted; the end-of-run sweep finds its claim orphaned.
  rmSync(gone, { recursive: true, force: true });
  const swept = withDefaults(home, 'return wt.pruneOrphanClaims();');
  assert.deepEqual(swept, [join(base, 'gone')]);
  assert.equal(existsSync(join(base, 'gone')), false);
  assert.deepEqual(readdirSync(join(base, 'live')), ['.afk-repo'], 'a live claim survives');
  assert.deepEqual(readdirSync(join(base, 'busy')).sort(), ['.afk-repo', 'notes.md'], 'a folder holding more than a claim survives');
  assert.deepEqual(readdirSync(join(base, 'twin')), ['.afk-repo'], 'a claim a hashed sibling depends on survives');
});

test('removing a lane of a moved clone drops its repo folder once only an orphan claim is left', (t) => {
  // The clone moves (same name, new path): its claim names a git directory that
  // is gone, and the run's state.json still records the lane under `<name>/`.
  // Removing that last lane reaches tidyRepoFolder's orphan-claim branch.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = cloneAt(home, 'roam');
  const base = join(home, 'code', 'worktrees');
  const { lane } = withDefaults(home, `
    const sha = wt.currentBaseSha(${JSON.stringify(old)}, 'main');
    return { lane: wt.createTaskWorktree({ root: ${JSON.stringify(old)}, id: '5', baseSha: sha, setup: {} }).worktree };`);
  assert.equal(lane.startsWith(join(base, 'roam', 'lane') + '/'), true, lane);
  mkdirSync(join(old, '.afk'), { recursive: true });
  writeFileSync(join(old, '.afk', 'state.json'), JSON.stringify({ tasks: { 5: { worktree: lane } } }));
  const moved = join(home, 'moved', 'roam');
  mkdirSync(dirname(moved), { recursive: true });
  execFileSync('mv', [old, moved]);
  const out = withDefaults(home, `return wt.removeTaskWorktree({ root: ${JSON.stringify(moved)}, id: '5', branch: 'afk/task-5' });`);
  assert.equal(out.removed, true, JSON.stringify(out));
  assert.equal(existsSync(join(base, 'roam')), false, 'the orphan claim folder is removed with its last lane');
});

test('a repo folder that gains an entry after the orphan check is kept, with that entry', (t) => {
  // The race: the check reads one `.afk-repo`; before the delete another tool
  // writes into the folder. Simulated by writing the entry as the check reads
  // the claim file, the last read before the delete.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, 'code', 'worktrees');
  const folder = join(base, 'late');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.afk-repo'), `${join(home, 'nowhere', '.git')}\n`);
  const swept = withDefaults(home, `
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...rest) => {
      if (String(path) === ${JSON.stringify(join(folder, '.afk-repo'))}) fs.writeFileSync(${JSON.stringify(join(folder, 'session'))}, 'late\\n');
      return read(path, ...rest);
    };
    syncBuiltinESMExports();
    return wt.pruneOrphanClaims();`);
  assert.deepEqual(swept, []);
  assert.equal(existsSync(join(folder, 'session')), true, 'the late entry survives');
});

test('under the test runner the real home is swapped for AFK_TEST_HOME', (t) => {
  // HOME is the real user's here, as in any test that never moves it; the
  // roots must still land in the test home, never the real ~/code/worktrees.
  const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'afk-test-home-')));
  t.after(() => rmSync(testHome, { recursive: true, force: true }));
  const main = cloneAt(testHome, 'swap');
  const env = { ...process.env, HOME: userInfo().homedir, NODE_TEST_CONTEXT: 'child-v8', AFK_TEST_HOME: testHome };
  delete env.AFK_WORKTREE_ROOT;
  delete env.AFK_EPIC_ROOT;
  const moduleUrl = new URL('./worktree.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const wt = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(wt.worktreeRoot(${JSON.stringify(main)}));`],
  { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.startsWith(join(testHome, 'code', 'worktrees') + '/'), true, result.stdout);
});

test('an existing run keeps the paths it recorded under the old roots', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const main = join(home, 'src', 'atlas');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'a.txt'), 'hi\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  // The epic and its lane, where the runner put them before #228.
  const slug = main.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const oldEpic = join(home, '.afk-claude', 'epics', `${slug}-233`, 'atlas');
  mkdirSync(dirname(oldEpic), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 'feat/233', oldEpic);
  const oldLane = join(home, '.afk-claude', 'worktrees', oldEpic.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), '9', 'atlas');
  mkdirSync(dirname(oldLane), { recursive: true });
  git(oldEpic, 'worktree', 'add', '-q', '-b', 'afk/task-9', oldLane);
  mkdirSync(join(oldEpic, '.afk'), { recursive: true });
  writeFileSync(join(oldEpic, '.afk', 'state.json'), JSON.stringify({ epic: { id: '233' }, tasks: { 9: { lifecycle: 'running', worktree: oldLane } } }));
  const out = withDefaults(home, `
    const root = ${JSON.stringify(main)};
    const epic = wt.epicWorktree(root, '233');
    return {
      epic,
      reused: wt.createEpicWorktree({ root, branch: 'feat/233', epicId: '233', setup: {} }).reused,
      isEpic: wt.isEpicCheckout(epic),
      lane: wt.taskWorktree(epic, '9'),
      lanes: wt.listAfkWorktrees(epic).map((entry) => entry.worktree),
      newLane: wt.taskWorktree(epic, '10'),
      lanesRoot: wt.worktreeRoot(epic),
      removed: (wt.removeTaskWorktree({ root: epic, id: '9', branch: 'afk/task-9' }), true),
    };
  `);
  assert.equal(out.epic, oldEpic);
  assert.equal(out.reused, true);
  assert.equal(out.isEpic, true);
  assert.equal(out.lane, oldLane, 'the lane state.json recorded');
  assert.deepEqual(out.lanes, [oldLane], 'an old-root lane of this run is still ours');
  // S4 (#235): the whole run stays on the root it started on, so the end-of-run
  // sweep and the write guard, which take worktreeRoot, cover every lane of it.
  assert.equal(out.lanesRoot, dirname(dirname(oldLane)));
  assert.equal(out.newLane, join(dirname(dirname(oldLane)), '10', 'atlas'));
  // Removing the old-root lane takes its private parent with it.
  assert.equal(existsSync(dirname(oldLane)), false);
});

// S5 (#235): two repositories cloned under the same directory name.
test('two repos that share a directory name get their own folders under ~/code/worktrees', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = (path) => {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'config', 'user.email', 't@t.t');
    git(path, 'config', 'user.name', 't');
    writeFileSync(join(path, 'a.txt'), `${path}\n`);
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', 'init');
    git(path, 'branch', 'feat/12');
    return path;
  };
  const one = repo(join(home, 'work', 'app'));
  const two = repo(join(home, 'side', 'app'));
  const out = withDefaults(home, `
    const made = (root) => {
      const epic = wt.createEpicWorktree({ root, branch: 'feat/12', epicId: '12', setup: {} });
      const lane = wt.createTaskWorktree({ root: epic.worktree, id: '13', baseSha: wt.currentBaseSha(epic.worktree, 'feat/12'), setup: {} });
      return { epic: epic.worktree, reused: epic.reused, lane: lane.worktree, laneReused: lane.reused };
    };
    const first = made(${JSON.stringify(one)});
    const second = made(${JSON.stringify(two)});
    return { first, second, again: wt.epicWorktree(${JSON.stringify(one)}, '12') };
  `);
  assert.equal(out.first.epic, join(home, 'code', 'worktrees', 'app', 'epic', '12', 'app'), 'the first repo keeps the plain name');
  assert.notEqual(out.second.epic, out.first.epic);
  assert.notEqual(out.second.lane, out.first.lane);
  assert.equal(out.second.reused, false, 'the second repo never adopts the first one\'s epic');
  assert.equal(out.second.laneReused, false);
  assert.match(out.second.epic, /\/code\/worktrees\/app-[0-9a-f]{6}\/epic\/12\/app$/);
  assert.equal(out.again, out.first.epic, 'deterministic: asking again gives the same path');
  assert.equal(git(out.second.epic, 'rev-parse', '--git-common-dir').trim(), join(two, '.git'));
});
