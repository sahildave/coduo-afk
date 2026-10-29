// Where the reflection is written, what it is written from, and what "it ran"
// means. The staging exists because of a measured failure — see epic #23.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reflectionEvidence, reflectionOutcome, reflectionPath, reflectionWorkspace,
  projectName, renderEvidence, renderReflectionOutcome, runReflector, stageEvidence,
} from './reflect.mjs';

const withRoots = (t) => {
  const base = mkdtempSync(join(tmpdir(), 'afk-reflect-'));
  const before = process.env.AFK_REFLECTIONS_ROOT;
  process.env.AFK_REFLECTIONS_ROOT = join(base, 'reflection');
  t.after(() => {
    if (before === undefined) delete process.env.AFK_REFLECTIONS_ROOT;
    else process.env.AFK_REFLECTIONS_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  return base;
};

test('the path is <reflections>/<project>/epic-<id>.md, one container', (t) => {
  // One folder holding a folder per project, not a top-level folder per
  // project: a wrong project name then costs a junk directory inside
  // docs/reflection/ rather than one beside docs/README.md. Forty-one of the
  // latter accumulated from test runs before anyone noticed.
  const base = withRoots(t);
  assert.equal(
    reflectionPath('/anywhere', '42', 'voice-studio'),
    join(base, 'reflection', 'voice-studio', 'epic-42.md'),
  );
});

test('only evidence that exists is offered, under the name it is copied to', (t) => {
  const base = withRoots(t);
  const root = join(base, 'project');
  mkdirSync(join(root, '.afk', 'verifier', '42'), { recursive: true });
  writeFileSync(join(root, '.afk', 'state.json'), '{}');
  writeFileSync(join(root, '.afk', 'verifier', '42', 'report.json'), '{}');

  const evidence = reflectionEvidence(root, '42');
  assert.deepEqual(evidence.map((e) => e.name), ['state.json', 'review.json']);
  // A prompt naming a file the agent cannot open teaches it the list is
  // unreliable, and the next missing one gets invented around.
  assert.ok(!renderEvidence(evidence).includes('run.log'));
  // Plain names, never the absolute source: the agent cannot read out of its cwd.
  assert.ok(!renderEvidence(evidence).includes(root));
});

test('evidence is COPIED in, because reads are capped to the cwd too', (t) => {
  // Measured on epic #23: the reflector wrote nothing and said why in its own
  // final message — "reads are confined to <cwd>". `allowWrite` does not govern
  // reads, so widening the sandbox would not have helped; bringing the files in
  // does, and it narrows the role rather than widening it.
  const base = withRoots(t);
  const root = join(base, 'project');
  mkdirSync(join(root, '.afk'), { recursive: true });
  writeFileSync(join(root, '.afk', 'state.json'), '{"epic":"42"}');

  const workspace = reflectionWorkspace(root, '42');
  const staged = stageEvidence(reflectionEvidence(root, '42'), workspace);
  assert.deepEqual(staged.map((e) => e.name), ['state.json']);
  assert.equal(readFileSync(join(workspace, 'state.json'), 'utf8'), '{"epic":"42"}');
});

test('a huge log is staged as its tail, and the file says so', (t) => {
  const base = withRoots(t);
  const root = join(base, 'project');
  mkdirSync(join(root, '.afk'), { recursive: true });
  writeFileSync(
    join(root, '.afk', 'agent-auto.log'),
    Array.from({ length: 9000 }, (_, i) => `line ${i}`).join('\n'),
  );

  const workspace = reflectionWorkspace(root, '42');
  stageEvidence(reflectionEvidence(root, '42'), workspace);
  const staged = readFileSync(join(workspace, 'run.log'), 'utf8');
  assert.match(staged, /truncated — the last 4000 of 9000 lines/);
  // The tail, because a run's ending is what explains its ending.
  assert.ok(staged.includes('line 8999'));
  assert.ok(!staged.includes('line 100\n'));
});

test('the lanes\' verification reports are evidence, their transcripts are not', (t) => {
  // Without these the reflector cannot tell an infra death from a real failure:
  // `verification.json` carries `tokens` and `producedFiles`, and zero of both
  // means the agent never reached the API. Two reflections dead-ended on this,
  // one of them saying "that file is not in this workspace".
  const base = withRoots(t);
  const root = join(base, 'project');
  mkdirSync(join(root, '.afk', 'runs', '47', 'builder-1'), { recursive: true });
  mkdirSync(join(root, '.afk', 'runs', '47', 'integration-1'), { recursive: true });
  mkdirSync(join(root, '.afk', 'runs', '48'), { recursive: true });
  writeFileSync(join(root, '.afk', 'runs', '47', 'builder-1', 'verification.json'), '{"tokens":0}');
  writeFileSync(join(root, '.afk', 'runs', '47', 'builder-1', 'stream.jsonl'), 'x'.repeat(1024));
  writeFileSync(join(root, '.afk', 'runs', '47', 'integration-1', 'verification.json'), '{"ok":true}');
  writeFileSync(join(root, '.afk', 'runs', '48', 'integration-verification.json'), '{"ok":false}');

  const evidence = reflectionEvidence(root, '42');
  assert.deepEqual(evidence.map((e) => e.name), [
    'runs/47/builder-1/verification.json',
    'runs/47/integration-1/verification.json',
    'runs/48/integration-verification.json',
  ]);
  // The transcript is deliberately absent: one lane's stream is bigger than the
  // reflector's whole context, and a reflection has already run out of room.
  assert.ok(!renderEvidence(evidence).includes('stream.jsonl'));
  // Nothing is truncated here, so nothing claims to be.
  assert.ok(!renderEvidence(evidence).includes('TRUNCATED'));

  // And they must actually LAND — a listed path the agent cannot open is worse
  // than no path at all.
  const workspace = reflectionWorkspace(root, '42');
  stageEvidence(evidence, workspace);
  assert.equal(
    readFileSync(join(workspace, 'runs', '47', 'builder-1', 'verification.json'), 'utf8'),
    '{"tokens":0}',
  );
});

test('past the cap, the reflector is told what it is NOT seeing', (t) => {
  // A reflection that silently sees ten of twenty lanes draws confident,
  // wrong conclusions about the run. The cap is fine; the silence is not.
  const base = withRoots(t);
  const root = join(base, 'project');
  for (let lane = 0; lane < 30; lane += 1) {
    const dir = join(root, '.afk', 'runs', `1${String(lane).padStart(2, '0')}`, 'builder-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verification.json'), '{}');
  }
  const evidence = reflectionEvidence(root, '42');
  assert.ok(evidence.length < 30, 'the lane files are capped');
  const rendered = renderEvidence(evidence);
  assert.match(rendered, /TRUNCATED/);
  assert.match(rendered, new RegExp(`${evidence.length} of 30`));
  assert.match(rendered, /of 30 lanes/);
});

test('the cap drops passing lanes, not the end of the run', (t) => {
  // Lane directories sort lexicographically, so a plain prefix always dropped
  // the highest-numbered lanes — the end of the run, which is where the
  // failures are, and the same lanes every time.
  const base = withRoots(t);
  const root = join(base, 'project');
  for (let lane = 0; lane < 30; lane += 1) {
    const id = `1${String(lane).padStart(2, '0')}`;
    const dir = join(root, '.afk', 'runs', id, 'builder-1');
    mkdirSync(dir, { recursive: true });
    // Every lane passed except the last two, which are past the cap's prefix.
    const failed = lane >= 28;
    writeFileSync(join(dir, 'verification.json'), JSON.stringify({
      tokens: { output: 12 }, checks: [{ command: 'npm test', code: failed ? 1 : 0 }],
    }));
  }
  const names = reflectionEvidence(root, '42').map((e) => e.name);
  assert.equal(names.length, 24, 'still capped');
  assert.ok(names.includes('runs/128/builder-1/verification.json'), 'the failing late lane is kept');
  assert.ok(names.includes('runs/129/builder-1/verification.json'), 'and so is the other');
  assert.match(renderEvidence(reflectionEvidence(root, '42')), /failing lanes first/);
});

test('a staged JSON report is still parseable JSON', (t) => {
  // The line tail prepends a prose line. On a log that is correct; on a report
  // the agent is told to read as JSON it hands over a file that cannot parse.
  const base = withRoots(t);
  const root = join(base, 'project');
  const dir = join(root, '.afk', 'runs', '47', 'builder-1');
  mkdirSync(dir, { recursive: true });
  const report = { taskId: '47', producedFiles: Array.from({ length: 9000 }, (_, i) => `src/f${i}.ts`) };
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(report, null, 2));

  const workspace = reflectionWorkspace(root, '42');
  stageEvidence(reflectionEvidence(root, '42'), workspace);
  const staged = readFileSync(join(workspace, 'runs', '47', 'builder-1', 'verification.json'), 'utf8');
  assert.deepEqual(JSON.parse(staged), report);
});

test('no evidence at all is said out loud, not rendered as an empty list', (t) => {
  withRoots(t);
  assert.match(renderEvidence([]), /none — this run left no readable artifacts/);
});

test('an empty or missing file is not a reflection, whatever the agent exited', (t) => {
  const base = withRoots(t);
  const root = join(base, 'project');
  const workspace = reflectionWorkspace(root, '42');
  mkdirSync(workspace, { recursive: true });

  const missing = reflectionOutcome({ root, epicId: '42', status: 0 });
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /wrote no file/);
  assert.match(reflectionOutcome({ root, epicId: '42', timedOut: true }).problem, /timed out/);
  assert.match(reflectionOutcome({ root, epicId: '42', status: 3 }).problem, /exited 3/);

  writeFileSync(join(workspace, 'epic-42.md'), '   \n');
  assert.equal(reflectionOutcome({ root, epicId: '42', status: 0 }).ok, false,
    'whitespace is not a reflection');

  writeFileSync(join(workspace, 'epic-42.md'), '# Reflection\n\nIt ran.\n');
  const written = reflectionOutcome({ root, epicId: '42', status: 0 });
  assert.equal(written.ok, true);
  assert.match(renderReflectionOutcome(written), /^REFLECT: wrote /);
});

test('untracked runner-change proposals are counted and named in the outcome line', (t) => {
  // The quillnote waves 15-38 audit: every "What I would change in the runner"
  // item in a week of reflections was untracked prose, and none reached the
  // tracker. The reflector cannot file issues, so the guardrail is the count —
  // harvested here and said out loud where the operator reads REFLECT: lines.
  const base = withRoots(t);
  const root = join(base, 'project');
  const workspace = reflectionWorkspace(root, '42');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'epic-42.md'), [
    '# Reflection — epic #42',
    '',
    '## What I would change in the runner',
    '',
    '- tracked: #87 — the deadline is named at dispatch.',
    '- untracked — baseline reports every red gate: today it stops at the first.',
    '- untracked — reopen re-integrates serially: merger states cluster otherwise.',
    '',
  ].join('\n'));
  const written = reflectionOutcome({ root, epicId: '42', status: 0 });
  assert.equal(written.ok, true);
  assert.equal(written.untrackedProposals, 2, 'tracked bullets do not count');
  assert.match(renderReflectionOutcome(written), /2 runner-change proposals? .*untracked/);

  writeFileSync(join(workspace, 'epic-42.md'), '# Reflection\n\nIt ran.\n');
  const clean = reflectionOutcome({ root, epicId: '42', status: 0 });
  assert.equal(clean.untrackedProposals, 0);
  assert.doesNotMatch(renderReflectionOutcome(clean), /untracked/,
    'a reflection with no proposals gets no nag');
});

test('a non-zero exit that still wrote the file counts as written', (t) => {
  // The document is the output. An agent that produced it and then fell over on
  // its way out has done the job, and discarding the file to punish the exit
  // code would cost the only artifact of the run.
  const base = withRoots(t);
  const root = join(base, 'project');
  const workspace = reflectionWorkspace(root, '42');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'epic-42.md'), '# Reflection\n');
  assert.equal(reflectionOutcome({ root, epicId: '42', status: 1 }).ok, true);
});

test('a checkout with no GitHub remote gets no reflection and no folder', async (t) => {
  // The root cause of the forty-one empty folders. `projectName` used to fall
  // back to `basename(root)`, so every test that closed an epic filed a
  // reflection under a temp directory's name — in the runner's own docs/.
  const base = withRoots(t);
  const root = join(base, 'no-remote');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);

  assert.equal(projectName(root), null);
  const result = await runReflector({
    root,
    config: { agent: { command: 'claude', model: 'x', timeoutMs: 1000 } },
    dag: { epic: { id: '42' }, tasks: [] },
    runAgent: () => { throw new Error('the agent must never be reached'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.problem, /no GitHub remote/);
  // Nothing was created. This is the assertion that matters: the failure mode
  // was empty directories, not bad documents.
  assert.equal(existsSync(join(base, 'reflection')), false);
});

test('a reflection is reused only for the commit it was written about', async (t) => {
  // Epic #23 closed three times: two failures that reflected on an empty
  // branch, then a success that reused the failure's reflection and filed
  // "produced no documentation at all" against a branch carrying both
  // documents. Existence is not the test; the commit is.
  const base = withRoots(t);
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], { cwd: root });
  execFileSync('sh', ['-c', `echo one > ${join(root, 'a.txt')}`]);
  git('add', '-A'); git('commit', '-qm', 'one');
  // `currentRepo` asks `gh`, not git, so the project's identity needs one on
  // PATH. Same shim the e2e fixture uses, for the same reason.
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho o/thing\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });

  const dag = { epic: { id: '42' }, tasks: [] };
  // `roleAgent` refuses any command but "claude"; `runAgent` is stubbed below,
  // so nothing is ever spawned.
  const config = { agent: { command: 'claude', model: 'x', timeoutMs: 1000 } };
  // First close: the agent writes, the runner places it and stamps the commit.
  const first = await runReflector({
    root, config, dag,
    runAgent: async ({ cwd }) => {
      writeFileSync(join(cwd, 'epic-42.md'), '# Reflection\n\nthe first run\n');
      return { status: 0 };
    },
  });
  assert.equal(first.ok, true);
  assert.ok(!first.reused);

  // Same commit, so the second close costs nothing.
  const again = await runReflector({
    root, config, dag,
    runAgent: () => { throw new Error('must not re-run on an unchanged branch'); },
  });
  assert.equal(again.reused, true);

  // The branch moves — a later run built what the earlier one failed to.
  execFileSync('sh', ['-c', `echo two > ${join(root, 'b.txt')}`]);
  git('add', '-A'); git('commit', '-qm', 'two');
  const fresh = await runReflector({
    root, config, dag,
    runAgent: async ({ cwd }) => {
      writeFileSync(join(cwd, 'epic-42.md'), '# Reflection\n\nthe run that worked\n');
      return { status: 0 };
    },
  });
  assert.ok(!fresh.reused, 'a moved branch is a different run and deserves its own reading');
  assert.match(readFileSync(fresh.path, 'utf8'), /the run that worked/);
});
