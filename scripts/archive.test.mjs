// One run's state, put away in one place. The policy is what is tested here;
// the move itself is three lines of fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVED, archiveBlocker, archiveDir, archiveEpic } from './archive.mjs';

test('a closed epic archives, and so does one parked on a human gate', () => {
  assert.equal(archiveBlocker({ epicClose: { lifecycle: 'closed' } }), null);
  // `gate: after` is where a CORRECT epic waits, sometimes for days. Refusing
  // to archive it is what sent operators to `rm -rf .afk/`.
  assert.equal(archiveBlocker({ epicClose: { lifecycle: 'awaiting_acceptance' } }), null);
});

test('an unfinished epic is refused, and the refusal names what is unfinished', () => {
  const blocker = archiveBlocker({
    epicClose: { lifecycle: 'open' },
    tasks: { 21: { lifecycle: 'failed' }, 22: { lifecycle: 'passed' }, 23: { lifecycle: 'blocked' } },
  });
  assert.match(blocker, /21 \(failed\)/);
  assert.match(blocker, /23 \(blocked\)/);
  assert.ok(!blocker.includes('22'), 'a passed task is not a reason to refuse');
});

test('an open epic with nothing unfinished still refuses, without inventing a list', () => {
  assert.equal(archiveBlocker({ epicClose: { lifecycle: 'open' }, tasks: {} }),
    'the epic record is still open');
  assert.equal(archiveBlocker(null), 'the epic record is still open');
});

test('every per-run directory moves, and the tracked ledger does not', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'afk-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const afk = join(root, '.afk');
  mkdirSync(afk, { recursive: true });
  writeFileSync(join(afk, 'state.json'), '{"epic":{"id":"12"}}');
  for (const dir of ['runs', 'verifier', 'supervisor']) mkdirSync(join(afk, dir));
  // Each auto-restart's output (#146), one file per attempt.
  for (const k of [1, 2]) writeFileSync(join(afk, `restart-${k}.log`), 'output\n');
  // Tracked on purpose (scripts/ledger.mjs). Moving it stages a deletion that
  // the next status flush sweeps onto the epic branch.
  writeFileSync(join(afk, 'epic-ledger.yaml'), 'entries: []\n');
  // Not per-run either: the log is appended across epics.
  writeFileSync(join(afk, 'agent-auto.log'), 'lines\n');

  const { target, moved, absent } = archiveEpic({ root, epicId: '12' });
  assert.equal(target, archiveDir(root, '12'));
  assert.deepEqual(moved, ['state.json', 'runs', 'verifier', 'supervisor', 'restart-1.log', 'restart-2.log']);
  assert.equal(existsSync(join(target, 'restart-2.log')), true);
  assert.ok(absent.includes('fixer') && absent.includes('reflect'));

  assert.equal(existsSync(join(afk, 'state.json')), false, 'state.json must not be left behind');
  assert.equal(existsSync(join(target, 'state.json')), true, 'and it must be a move, not a delete');
  assert.equal(existsSync(join(afk, 'epic-ledger.yaml')), true, 'the tracked ledger stays');
  assert.equal(existsSync(join(afk, 'agent-auto.log')), true, 'the log outlives one run');
});

test('the archived set is the whole of what a run writes', () => {
  // A new per-run directory that is not in this list is one the next epic
  // inherits under its own path. `fixer/` and `reflect/` were both added after
  // the original two-entry auto-archive and neither was noticed.
  for (const entry of ['state.json', 'runs', 'verifier', 'fixer', 'reflect', 'supervisor', 'plan-review', 'epic-close', 'recovery']) {
    assert.ok(ARCHIVED.includes(entry), `${entry} must be archived with its run`);
  }
  assert.ok(!ARCHIVED.includes('epic-ledger.yaml'));
  assert.ok(!ARCHIVED.includes('agent-auto.log'));
});
