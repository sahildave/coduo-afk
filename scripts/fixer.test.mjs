// The bounded fixer: what it is asked to fix, and what its silence means.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkOnlyCriterion, FIXER_JSON_SCHEMA, fixerItems, fixerStateRecord, lessonCounts, needsHuman, normalizeFixerReport, parseFixerOutput,
  renderFixerItems, renderFixerMarkdown, renderFixerOutcome, renderMinorsComment,
  renderUnpassedLanes, runFixer, spawnFixer, unpassedLanes, unqueuedFindings, withCheckedCriteria,
} from './fixer.mjs';
import { roleFor, rolePrompt } from './roles.mjs';

const review = (over = {}) => ({
  status: 'ok',
  summary: 's',
  criteria: [],
  findings: [],
  mustFix: [],
  ...over,
});

test('the work list is must-fix, then blocker/major findings, then unmet criteria', () => {
  const items = fixerItems(review({
    mustFix: ['ship the migration'],
    findings: [
      { axis: 'spec', severity: 'blocker', title: 'no auth check', detail: 'd', file: 'a.ts' },
      { axis: 'standards', severity: 'minor', title: 'nit', detail: null, file: null },
      { axis: 'standards', severity: 'major', title: 'dead branch', detail: null, file: 'b.ts' },
    ],
    criteria: [
      { id: '204.1', text: 'button exists', verdict: 'unmet' },
      { id: '204.2', text: 'colour is right', verdict: 'met' },
      { id: '204.3', text: 'copy is final', verdict: 'unknown' },
    ],
  }));
  assert.deepEqual(items.map((i) => i.title), [
    'ship the migration', 'no auth check', 'dead branch', 'button exists',
  ]);
  assert.deepEqual(items.map((i) => i.id), ['F1', 'F2', 'F3', 'F4']);
});

test('minor findings and unknown criteria are not this pass\'s work', () => {
  // `minor` on an already-merged, already-reviewed branch is tidying nobody
  // asked for. `unknown` is a gap in the REVIEW — there is nothing to fix, and
  // an agent guessing what "fixed" meant is worse than a human reading it.
  assert.deepEqual(fixerItems(review({
    findings: [{ axis: 'spec', severity: 'minor', title: 'nit' }],
    criteria: [{ id: '1', text: 'x', verdict: 'unknown' }],
  })), []);
});

test('an unusable review asks for nothing', () => {
  assert.deepEqual(fixerItems(null), []);
  assert.deepEqual(fixerItems({ status: 'unparseable', mustFix: ['x'] }), []);
});

test('an item the fixer never mentioned is deferred, never fixed', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({ fixed: [{ id: 'F1', detail: 'done', files: ['a.ts'] }] }, items);
  assert.deepEqual(out.fixed.map((f) => f.id), ['F1']);
  assert.deepEqual(out.deferred, [
    { id: 'F2', title: 'two', reason: 'the fixer did not report on this item', kind: 'needs_human' },
  ]);
});

test('a fix claimed for an id nobody asked about is dropped', () => {
  const items = fixerItems(review({ mustFix: ['one'] }));
  const out = normalizeFixerReport({ fixed: [{ id: 'F9', detail: 'invented' }] }, items);
  assert.deepEqual(out.fixed, []);
  assert.equal(out.deferred.length, 1);
});

test('a dead or silent agent defers everything rather than reporting nothing', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  for (const [args, status] of [
    [{ agentStatus: 1 }, 'agent_failed'],
    [{ timedOut: true }, 'agent_failed'],
    [{ text: 'I had a lovely time' }, 'unparseable'],
  ]) {
    const out = parseFixerOutput({ items, ...args });
    assert.equal(out.status, status);
    assert.equal(out.fixed.length, 0);
    assert.equal(out.deferred.length, 2, status);
    assert.equal(out.problems.length, 1);
  }
});

test('a well-formed pass parses, and the last block wins', () => {
  const items = fixerItems(review({ mustFix: ['one'] }));
  const text = [
    'Here is an earlier draft:',
    '```json', '{"fixed":[]}', '```',
    'and my real answer:',
    '```json', '{"summary":"ok","fixed":[{"id":"F1","detail":"d","files":["a.ts"]}]}', '```',
  ].join('\n');
  const out = parseFixerOutput({ text, items });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.fixed, [{ id: 'F1', title: 'one', detail: 'd', files: ['a.ts'] }]);
  assert.deepEqual(out.deferred, []);
});

test('the rendered comment names what was left, not only what was done', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = parseFixerOutput({
    text: '```json\n{"fixed":[{"id":"F1","detail":"d","files":["a.ts"]}],"deferred":[{"id":"F2","reason":"needs a human"}]}\n```',
    items,
  });
  const md = renderFixerMarkdown(out);
  assert.match(md, /Fixed 1 of 2/);
  assert.match(md, /✅ \*\*one\*\* — d \(`a\.ts`\)/);
  assert.match(md, /Not fixed — 1 left for you/);
  assert.match(md, /⬜ \*\*two\*\* — needs a human/);
  assert.match(renderFixerOutcome(out), /fixed 1 of 2 closeout item\(s\); 1 left/);
});

test('one defect reported three ways is one item, keeping every source', () => {
  const target = 'scripts/roles.mjs:479';
  const items = fixerItems(review({
    mustFix: [`${target} — roleFor mutates the shared config object`],
    findings: [{
      axis: 'spec', severity: 'major', title: 'roleFor mutates the shared config object',
      detail: 'the role object is shared', file: target,
    }],
    criteria: [{ id: 'C1', verdict: 'partial', text: 'roleFor mutates the shared config object' }],
  }));
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.id, 'F1');
  assert.equal(item.file, target);
  assert.equal(item.detail, 'the role object is shared');
  assert.equal(item.sources.length, 3);
  assert.match(item.source, /must-fix/);
  assert.match(item.source, /major finding/);
  assert.match(item.source, /acceptance criterion C1/);
});

test('distinct defects survive dedup and ids stay contiguous', () => {
  const items = fixerItems(review({
    mustFix: ['a.ts:1 — one thing', 'a.ts:1 — one thing'],
    findings: [{ axis: 'spec', severity: 'blocker', title: 'another thing', file: 'b.ts:9' }],
  }));
  assert.deepEqual(items.map((i) => i.id), ['F1', 'F2']);
  assert.deepEqual(items.map((i) => i.title), ['a.ts:1 — one thing', 'another thing']);
});

test('a deferral that means "nothing to do" is not counted as human work', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two', 'three'] }));
  const out = normalizeFixerReport({
    deferred: [
      { id: 'F1', reason: 'already met on the branch' },
      { id: 'F2', reason: 'no-op: the finding describes generated output' },
      { id: 'F3', reason: 'needs a product decision' },
    ],
  }, items);
  assert.deepEqual(out.deferred.map((d) => d.kind), ['no_op', 'no_op', 'needs_human']);
  const report = { ...out, status: 'ok', items, problems: [] };
  assert.match(renderFixerOutcome(report), /1 left for you/);
  const md = renderFixerMarkdown(report);
  assert.match(md, /Not fixed — 1 left for you/);
  assert.match(md, /needs a product decision/);
  // The no-ops are still reported, just not counted.
  assert.match(md, /2 needed no change/);
  assert.match(md, /already met on the branch/);
});

test('an unrecognised deferral reason defaults to needing a human', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({ deferred: [{ id: 'F1', reason: 'mumble' }] }, items);
  assert.deepEqual(out.deferred.map((d) => d.kind), ['needs_human', 'needs_human']);
});

test('the report points at the stream instead of embedding it', () => {
  const raw = `${'x'.repeat(200 * 1024)}END`;
  const out = parseFixerOutput({
    text: '```json\n{"summary":"done","fixed":[],"deferred":[]}\n```',
    raw,
    items: [],
    streamPath: '/tmp/epic/stream.jsonl',
  });
  assert.equal(out.raw, undefined);
  assert.equal(out.rawPath, '/tmp/epic/stream.jsonl');
  assert.ok(out.rawTail.length <= 8192, `rawTail is ${out.rawTail.length} bytes`);
  assert.ok(out.rawTail.endsWith('END'));
  assert.ok(JSON.stringify(out).length < 16 * 1024);
});

test('a clean review renders as "nothing to fix", not as a failed pass', () => {
  const md = renderFixerMarkdown({ status: 'nothing_to_do', items: [], fixed: [], deferred: [] });
  assert.match(md, /nothing a fix pass is allowed to change/);
  assert.equal(renderFixerMarkdown(null), '## Closeout fixes\n\n_No fix pass ran._');
});

// ---------------------------------------------------------------------------
// Dedup must not lose the title the closeout ticks back off
// ---------------------------------------------------------------------------
//
// scripts/verifier.mjs renders `report.mustFix` VERBATIM as `- [ ] <line>`, and
// scripts/auto.mjs matches the fixed items back against those lines. A merge
// that replaced the must-fix title with a finding's silently stopped the tick.

test('a merged item keeps the must-fix title and carries the others as aliases', () => {
  const target = 'scripts/roles.mjs:479';
  const mustFix = `${target} — roleFor mutates the shared config object`;
  const [item] = fixerItems(review({
    mustFix: [mustFix],
    findings: [{
      axis: 'spec', severity: 'major', title: 'roleFor mutates the shared config object',
      detail: 'the role object is shared', file: target,
    }],
  }));
  assert.equal(item.title, mustFix, 'the must-fix line is the only title guaranteed to be rendered');
  assert.deepEqual(item.aliases, ['roleFor mutates the shared config object']);
  // The richest DETAIL is what the fixer agent acts on, and it still survives.
  assert.equal(item.detail, 'the role object is shared');
});

test('aliases reach report.fixed so the closeout can match on any of them', () => {
  const items = fixerItems(review({
    mustFix: ['a.ts:9 — drop the mutation'],
    findings: [{ axis: 'spec', severity: 'blocker', title: 'drop the mutation', detail: 'd', file: 'a.ts' }],
  }));
  const out = normalizeFixerReport({ fixed: [{ id: 'F1', detail: 'done', files: [] }] }, items);
  assert.deepEqual(out.fixed[0].aliases, ['drop the mutation']);
  // An item that was never merged carries no aliases at all.
  const plain = normalizeFixerReport(
    { fixed: [{ id: 'F1', detail: 'done' }] },
    fixerItems(review({ mustFix: ['one'] })),
  );
  assert.equal(plain.fixed[0].aliases, undefined);
});

test('the same words at two different file:line targets are two defects', () => {
  // `textKey` strips every path, so these key identically. Merging them loses
  // the second `- [ ]` line, which can then never tick.
  const items = fixerItems(review({
    mustFix: ['a.ts:1 — narrow the deny list', 'b.ts:9 — narrow the deny list'],
  }));
  assert.deepEqual(items.map((i) => i.title), [
    'a.ts:1 — narrow the deny list', 'b.ts:9 — narrow the deny list',
  ]);
  // Same words with no target on either side still merge.
  assert.equal(fixerItems(review({ mustFix: ['narrow the deny list', 'narrow the deny list'] })).length, 1);
  // A bare file and a file:line in the same file are still one defect.
  assert.equal(fixerItems(review({
    mustFix: ['scripts/roles.mjs:479 — roleFor mutates'],
    findings: [{ axis: 'spec', severity: 'major', title: 'roleFor mutates', file: 'scripts/roles.mjs' }],
  })).length, 1);
});

test('the one-line outcome accounts for all three numbers', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two', 'three'] }));
  const out = normalizeFixerReport({
    fixed: [{ id: 'F1', detail: 'd' }],
    deferred: [
      { id: 'F2', reason: 'already met on the branch' },
      { id: 'F3', reason: 'no-op: nothing to do' },
    ],
  }, items);
  const line = renderFixerOutcome({ ...out, status: 'ok', items, problems: [] });
  assert.match(line, /fixed 1 of 3 closeout item\(s\); 0 left for you/);
  assert.match(line, /2 needed no change/, 'the skimmed log line must sum to the total');
});

// --- duplicateOf: the fixer declaring one defect reported twice -------------

const dupeReport = (deferred) => {
  const items = fixerItems(review({ mustFix: ['one', 'two', 'three'] }));
  const out = normalizeFixerReport({ deferred }, items);
  return { ...out, status: 'ok', items, problems: [] };
};

test('a declared duplicate is reported but not counted as human work', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'needs a product decision' },
    { id: 'F2', reason: 'needs a human' },
    { id: 'F3', reason: 'Same evidence as F1', duplicateOf: 'F1' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1', 'F2']);
  assert.match(renderFixerOutcome(report), /2 left for you/);
  assert.match(renderFixerOutcome(report), /1 restating another item/);
  const md = renderFixerMarkdown(report);
  // Listed, not hidden — otherwise the count is lower than the list for no
  // visible reason.
  assert.match(md, /1 restating another item/);
  assert.match(md, /\*\*three\*\* — restates F1 — Same evidence as F1/);
});

test('a duplicateOf pointing at nothing is ignored, never swallowed', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'needs a human' },
    { id: 'F2', reason: 'restates something', duplicateOf: 'F99' },
    { id: 'F3', reason: 'needs a human' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1', 'F2', 'F3']);
  assert.match(renderFixerOutcome(report), /3 left for you/);
});

test('a self-referencing duplicateOf is ignored', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'needs a human', duplicateOf: 'F1' },
    { id: 'F2', reason: 'b' },
    { id: 'F3', reason: 'c' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1', 'F2', 'F3']);
});

test('a duplicateOf cycle leaves exactly one survivor, the lowest id', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'a', duplicateOf: 'F2' },
    { id: 'F2', reason: 'b', duplicateOf: 'F1' },
    { id: 'F3', reason: 'c' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1', 'F3']);
  // and a longer ring, still one survivor
  const ring = dupeReport([
    { id: 'F1', reason: 'a', duplicateOf: 'F2' },
    { id: 'F2', reason: 'b', duplicateOf: 'F3' },
    { id: 'F3', reason: 'c', duplicateOf: 'F1' },
  ]);
  assert.deepEqual(needsHuman(ring).map((d) => d.id), ['F1']);
});

test('a chain of duplicates collapses onto the item that is nobody\'s restatement', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'a' },
    { id: 'F2', reason: 'b', duplicateOf: 'F1' },
    { id: 'F3', reason: 'c', duplicateOf: 'F2' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1']);
});

test('with no duplicateOf anywhere the counts are exactly as before', () => {
  const report = dupeReport([
    { id: 'F1', reason: 'needs a human' },
    { id: 'F2', reason: 'needs a human too' },
    { id: 'F3', reason: 'already met on the branch' },
  ]);
  assert.deepEqual(needsHuman(report).map((d) => d.id), ['F1', 'F2']);
  const line = renderFixerOutcome(report);
  assert.match(line, /2 left for you/);
  assert.match(line, /1 needed no change/);
  assert.doesNotMatch(line, /restating/);
});

test('duplicateOf survives normalization from the model\'s block', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({
    deferred: [{ id: 'F1', reason: 'r' }, { id: 'F2', reason: 'same as F1', duplicateOf: 'F1' }],
  }, items);
  assert.equal(out.deferred[0].duplicateOf, undefined);
  assert.equal(out.deferred[1].duplicateOf, 'F1');
});

// --- duplicateOf on the FIXED path -----------------------------------------
// Epic 56 fixed both restatements, so there was no slot to declare them in and
// "fixed 5 of 5" counted two defects as five.

const fixedReport = (fixed) => {
  const items = fixerItems(review({ mustFix: ['one', 'two', 'three'] }));
  const out = normalizeFixerReport({ fixed }, items);
  return { ...out, status: 'ok', items, problems: [] };
};

test('a fixed item declared a restatement is listed but counted once', () => {
  const report = fixedReport([
    { id: 'F1', detail: 'fixed the README' },
    { id: 'F2', detail: 'fixed the test' },
    { id: 'F3', detail: 'same README change as F1', duplicateOf: 'F1' },
  ]);
  const line = renderFixerOutcome(report);
  assert.match(line, /fixed 2 of 3 closeout item\(s\)/);
  assert.match(line, /1 restating another item/);
  const md = renderFixerMarkdown(report);
  assert.match(md, /\*\*Fixed 2 of 3\.\*\*/);
  // Listed, not hidden: all three items still appear, and the restatement says
  // what it restates.
  for (const title of ['one', 'two', 'three']) assert.match(md, new RegExp(`\\*\\*${title}\\*\\*`));
  assert.match(md, /\*\*three\*\* — restates F1 — same README change as F1/);
});

test('a dangling duplicateOf on a fixed item is ignored, never swallowed', () => {
  const report = fixedReport([
    { id: 'F1', detail: 'a' },
    { id: 'F2', detail: 'b', duplicateOf: 'F99' },
    { id: 'F3', detail: 'c' },
  ]);
  assert.match(renderFixerOutcome(report), /fixed 3 of 3/);
  assert.doesNotMatch(renderFixerOutcome(report), /restating/);
});

test('a self-referencing duplicateOf on a fixed item is ignored', () => {
  const report = fixedReport([
    { id: 'F1', detail: 'a', duplicateOf: 'F1' },
    { id: 'F2', detail: 'b' },
    { id: 'F3', detail: 'c' },
  ]);
  assert.match(renderFixerOutcome(report), /fixed 3 of 3/);
});

test('a duplicateOf cycle on the fixed path leaves exactly one survivor', () => {
  const report = fixedReport([
    { id: 'F1', detail: 'a', duplicateOf: 'F2' },
    { id: 'F2', detail: 'b', duplicateOf: 'F1' },
    { id: 'F3', detail: 'c' },
  ]);
  assert.match(renderFixerOutcome(report), /fixed 2 of 3/);
  assert.match(renderFixerOutcome(report), /1 restating another item/);
});

test('restatements on both paths are one number, and the arithmetic still sums', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two', 'three', 'four'] }));
  const out = normalizeFixerReport({
    fixed: [{ id: 'F1', detail: 'a' }, { id: 'F2', detail: 'same as F1', duplicateOf: 'F1' }],
    deferred: [{ id: 'F3', reason: 'needs a human' }, { id: 'F4', reason: 'same as F3', duplicateOf: 'F3' }],
  }, items);
  const report = { ...out, status: 'ok', items, problems: [] };
  // 1 fixed + 1 open + 2 restating = 4 items.
  assert.match(renderFixerOutcome(report), /fixed 1 of 4 closeout item\(s\); 1 left for you \(2 restating another item\)/);
});

test('duplicateOf survives normalization on the fixed path too', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({
    fixed: [{ id: 'F1', detail: 'd' }, { id: 'F2', detail: 'same as F1', duplicateOf: 'F1' }],
  }, items);
  assert.equal(out.fixed[0].duplicateOf, undefined);
  assert.equal(out.fixed[1].duplicateOf, 'F1');
});

// --- findings the pass never queued ----------------------------------------
// Epic 56's verifier reported 6 minors. They cannot reach `deferred`, so the
// run said "0 left for you" with six findings outstanding.

test('minor findings are counted as never queued, not silently dropped', () => {
  const r = review({
    mustFix: ['one'],
    findings: [
      { axis: 'spec', severity: 'blocker', title: 'b' },
      { axis: 'spec', severity: 'minor', title: 'm1' },
      { axis: 'standards', severity: 'minor', title: 'm2' },
    ],
  });
  assert.equal(unqueuedFindings(r), 2);
  assert.equal(unqueuedFindings(review({ findings: [] })), 0);
  assert.equal(unqueuedFindings(null), 0);
});

test('the never-queued findings reach both renderers', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({ fixed: [{ id: 'F1' }, { id: 'F2' }] }, items);
  const report = { ...out, status: 'ok', items, problems: [], notQueued: 6 };
  const line = renderFixerOutcome(report);
  assert.match(line, /6 minor finding\(s\) never queued and still open/);
  assert.doesNotMatch(line, /0 left for you\./, 'a run with outstanding findings must not claim zero');
  assert.match(renderFixerMarkdown(report), /6 minor finding\(s\) never queued/);
});

test('nothing_to_do still says what it never attempted', () => {
  const line = renderFixerOutcome({ status: 'nothing_to_do', items: [], fixed: [], deferred: [], notQueued: 3 });
  assert.match(line, /3 minor finding\(s\) never queued and still open/);
});

test('a report with no notQueued renders exactly as before', () => {
  const items = fixerItems(review({ mustFix: ['one', 'two'] }));
  const out = normalizeFixerReport({ fixed: [{ id: 'F1' }, { id: 'F2' }] }, items);
  const report = { ...out, status: 'ok', items, problems: [] };
  assert.equal(renderFixerOutcome(report), 'FIX: fixed 2 of 2 closeout item(s); 0 left for you.');
  assert.doesNotMatch(renderFixerMarkdown(report), /never queued/);
});

test('the state record and the log line count the same report the same way', () => {
  // Epic #389's "four surfaces, four numbers". `renderFixerOutcome` and the
  // closeout markdown were repaired to use the partitions; `close.fixer` in
  // auto.mjs was not, so state.json — the surface a later tool reads — carried
  // `{fixed: 6, deferred: 4}` for the report the log line describes as "fixed 4
  // of 10; 2 left for you (1 needed no change, 3 restating another item); 3
  // minor finding(s) never queued", and omitted notQueued entirely.
  const report = {
    status: 'ok',
    ranAt: '2026-08-24T08:32:15.534Z',
    items: Array.from({ length: 10 }, (_, i) => ({ id: `F${i + 1}` })),
    fixed: [
      { id: 'F1', title: 'a', files: [] }, { id: 'F2', title: 'b', files: [] },
      { id: 'F3', title: 'c', files: [] }, { id: 'F4', title: 'd', files: [] },
      { id: 'F5', title: 'e', files: [], duplicateOf: 'F1' },
      { id: 'F6', title: 'f', files: [], duplicateOf: 'F2' },
    ],
    deferred: [
      { id: 'F7', title: 'g', reason: 'r' },
      { id: 'F8', title: 'h', reason: 'r', duplicateOf: 'F3' },
      { id: 'F9', title: 'i', reason: 'r', kind: 'no_op' },
      { id: 'F10', title: 'j', reason: 'r' },
    ],
    notQueued: 3,
  };
  assert.equal(
    renderFixerOutcome(report),
    'FIX: fixed 4 of 10 closeout item(s); 2 left for you (1 needed no change, 3 restating another item); 3 minor finding(s) never queued and still open.',
  );
  assert.deepEqual(fixerStateRecord(report), {
    status: 'ok',
    items: 10,
    distinct: 4,
    restating: 3,
    open: 2,
    noOp: 1,
    notQueued: 3,
    unknownNotQueued: 0,
    ranAt: '2026-08-24T08:32:15.534Z',
  });
});

test('a report that never ran still yields a whole record, and null yields null', () => {
  assert.deepEqual(fixerStateRecord({ status: 'nothing_to_do', items: [], fixed: [], deferred: [] }), {
    status: 'nothing_to_do', items: 0, distinct: 0, restating: 0, open: 0, noOp: 0, notQueued: 0, unknownNotQueued: 0, ranAt: null,
  });
  assert.equal(fixerStateRecord(null), null);
});

test('parseFixerOutput carries the never-queued count onto the report', () => {
  const items = fixerItems(review({ mustFix: ['one'] }));
  const report = parseFixerOutput({ text: '```json\n{"fixed":[{"id":"F1"}]}\n```', items, notQueued: 6 });
  assert.equal(report.notQueued, 6);
  assert.equal(parseFixerOutput({ text: '```json\n{}\n```', items }).notQueued, undefined);
});

test('a fix pass is reused only for the commit it fixed', async (t) => {
  // Epic #391 ran twice. The second close replayed the FIRST pass's report
  // verbatim — character-identical counts, `ranAt` two hours stale — over a
  // branch where the finding it described had already been reverted. The
  // verifier and the reflector both key `reuse` on the commit; this one keyed
  // it on the file existing, which is not the same test.
  const root = mkdtempSync(join(tmpdir(), 'afk-fixer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'one');

  const dag = { epic: { id: '391' }, tasks: [] };
  const config = { agent: { command: 'claude', model: 'x', timeoutMs: 1000 } };
  const verifierReport = review({ mustFix: ['project-key the cache'], head: 'aaaa111' });
  // The fixer COMMITS — prompts/fixer.md step 4 — so HEAD moves during a pass
  // that changed anything. A key read off the working HEAD therefore never
  // matches on the next start, which would turn a deliberately ONE-attempt
  // agent into one that re-runs on every restart. The identity that matters is
  // the REVIEW this pass answered, not the tree it left behind.
  const pass = (label, report = verifierReport) => runFixer({
    root, config, dag, verifierReport: report, reuse: true,
    runAgent: async ({ streamPath }) => {
      writeFileSync(streamPath, `\`\`\`json\n{"summary":"${label}","fixed":[{"id":"F1","detail":"d"}],"deferred":[]}\n\`\`\`\n`);
      writeFileSync(join(root, `${label.replace(/\W+/g, '-')}.txt`), 'fixed\n');
      git('add', '-A'); git('commit', '-qm', `fix: closeout findings (${label})`);
      return { status: 0 };
    },
  });

  const first = await pass('the first pass');
  assert.equal(first.status, 'ok');
  assert.equal(first.summary, 'the first pass');
  assert.equal(first.reviewHead, verifierReport.head);

  // Same review: the close that happens twice across a restart costs one pass.
  // The fixer's own commit has moved HEAD by now, which must NOT count as the
  // branch having changed under it — it is this pass's own wake.
  assert.notEqual(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    first.head,
    'the fixture must actually commit, or it is not reproducing the real role',
  );
  const again = await runFixer({
    root, config, dag, verifierReport, reuse: true,
    runAgent: () => { throw new Error('the fixer gets ONE attempt; a restart must not buy a second'); },
  });
  assert.equal(again.summary, 'the first pass');
  assert.equal(again.ranAt, first.ranAt);

  // A different review — epic #391's second close, after a human reverted the
  // refusal and the verifier read the branch again. The old report answered a
  // question nobody is asking any more.
  const fresh = await pass(
    'the pass that ran on the real change',
    review({ mustFix: ['project-key the cache'], head: 'bbbb222' }),
  );
  assert.equal(fresh.summary, 'the pass that ran on the real change');
  assert.equal(fresh.reviewHead, 'bbbb222');
  assert.notEqual(fresh.ranAt, first.ranAt);
});

test('a Codex fixer can commit from a linked worktree', async (t) => {
  // Live smoke #45 let the fixer edit the epic worktree, then denied Git's
  // write to the per-worktree index.lock in the main checkout's .git directory.
  const dir = mkdtempSync(join(tmpdir(), 'afk-fixer-linked-'));
  const repo = join(dir, 'repo');
  const linked = join(dir, 'linked');
  const bin = join(dir, 'bin');
  t.after(() => {
    try { execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args) => execFileSync(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: repo });
  mkdirSync(bin);
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const cwd = value('--cd');
const addDirs = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
const perWorktree = path.resolve(cwd, git('rev-parse', '--absolute-git-dir').stdout.trim());
const common = path.resolve(cwd, git('rev-parse', '--git-common-dir').stdout.trim());
if (!addDirs.includes(perWorktree) || !addDirs.includes(common)) process.exit(41);
fs.writeFileSync(path.join(cwd, 'fixed.txt'), 'fixed\\n');
if (git('add', 'fixed.txt').status !== 0) process.exit(42);
if (git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'fix').status !== 0) process.exit(43);
`);
  chmodSync(fake, 0o755);
  const promptPath = join(linked, 'prompt.md');
  const streamPath = join(linked, 'stream.jsonl');
  writeFileSync(promptPath, 'fix it\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const result = await spawnFixer({
      root: linked,
      agent: {
        backend: 'codex', command: 'codex', model: 'gpt-5.6-luna',
        reasoningEffort: 'low', sandbox: 'workspace-write', approvalPolicy: 'never',
        timeoutMs: 10_000,
      },
      promptPath,
      streamPath,
      epicId: '45',
    });
    assert.equal(result.status, 0, readFileSync(streamPath, 'utf8'));
    assert.equal(readFileSync(join(linked, 'fixed.txt'), 'utf8'), 'fixed\n');
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: linked, encoding: 'utf8' }).trim(), 'fix');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('fixer Git grants dedupe in a plain checkout and never reach Claude', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-fixer-grants-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const argvPath = join(dir, 'argv.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'add', '-A'],
    { cwd: repo },
  );
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'base'],
    { cwd: repo },
  );
  mkdirSync(bin);
  const recorder = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.AFK_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
`;
  for (const command of ['codex', 'claude']) {
    writeFileSync(join(bin, command), recorder);
    chmodSync(join(bin, command), 0o755);
  }
  const promptPath = join(repo, 'prompt.md');
  const streamPath = join(repo, 'stream.jsonl');
  writeFileSync(promptPath, 'fix it\n');
  const previousPath = process.env.PATH;
  const previousArgv = process.env.AFK_FAKE_ARGV;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.AFK_FAKE_ARGV = argvPath;
  try {
    await spawnFixer({
      root: repo,
      agent: {
        backend: 'codex', command: 'codex', model: 'gpt-5.6-luna',
        reasoningEffort: 'low', sandbox: 'workspace-write', approvalPolicy: 'never',
        timeoutMs: 10_000,
      },
      promptPath,
      streamPath,
      epicId: '45',
    });
    const codexArgs = JSON.parse(readFileSync(argvPath, 'utf8'));
    const codexDirs = codexArgs.flatMap((arg, index) =>
      arg === '--add-dir' ? [codexArgs[index + 1]] : []);
    assert.deepEqual(codexDirs, [execFileSync(
      'git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' },
    ).trim()]);

    await spawnFixer({
      root: repo,
      agent: {
        backend: 'claude', command: 'claude', model: 'claude-opus-5',
        reasoningEffort: 'low', timeoutMs: 10_000,
      },
      promptPath,
      streamPath,
      epicId: '45',
    });
    const claudeArgs = JSON.parse(readFileSync(argvPath, 'utf8'));
    assert.equal(claudeArgs.includes('--add-dir'), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgv === undefined) delete process.env.AFK_FAKE_ARGV;
    else process.env.AFK_FAKE_ARGV = previousArgv;
  }
});

// ---------------------------------------------------------------------------
// #142 — an unparseable review still hands the fixer what it has
// ---------------------------------------------------------------------------

test('an unparseable review queues its unwired entries and its prose-recovered findings', () => {
  // #878: `StoredMarker` reached `unwired` and still reached nobody, because
  // the fixer took nothing from a review whose status was not `ok`.
  const items = fixerItems({
    status: 'unparseable',
    findings: [
      { axis: 'standards', severity: 'unknown', title: 'Hardcoded strings', detail: null, file: 'src/ui/S.tsx:40', recovered: 'prose' },
    ],
    unwired: [{ symbol: 'StoredMarker', file: 'src/markers.ts' }],
    criteria: [{ id: '879.1', taskId: '879', text: 'x', verdict: 'unknown', evidence: null }],
  });
  assert.ok(items.length > 0);
  assert.deepEqual(items.map((item) => item.title), ['Hardcoded strings', '`StoredMarker` has no non-test caller']);
  assert.match(items[0].source, /recovered from prose/);
  assert.equal(items[1].file, 'src/markers.ts');
});

test('a dying session is still not a review the fixer works from', () => {
  for (const status of ['agent_failed', 'auth_failed'])
    assert.deepEqual(fixerItems({ status, findings: [{ axis: 'spec', severity: 'unknown', title: 'x' }] }), []);
});

// ---------------------------------------------------------------------------
// #143 — an unknown the verifier's SANDBOX could not settle goes to the fixer
// ---------------------------------------------------------------------------

test('an unknown criterion whose evidence is "mutation denied" is queued, check-only', () => {
  // #760: 818.3, 819.11, 820.10 and 821.10 were fail-first criteria closed
  // `unknown` on "mutation denied in this session". The fixer, whose sandbox
  // can edit, ran that exact kind of check for other items and was never
  // handed these four.
  const items = fixerItems(review({
    criteria: [{ id: '818.3', taskId: '818', text: 'break the hint, watch the test fail, restore', verdict: 'unknown', evidence: 'mutation denied in this session' }],
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].checkOnly, true);
  assert.match(items[0].source, /acceptance criterion 818\.3 \(unknown — check only\)/);
  assert.match(items[0].detail, /mutation denied/);
  assert.match(renderFixerItems(items), /check only: run this criterion's check/);
});

test('an unknown that needs a human or a device stays out of the queue', () => {
  const items = fixerItems(review({
    criteria: [
      { id: '1.1', taskId: '1', text: 'haptics feel right', verdict: 'unknown', evidence: 'needs a physical device' },
      { id: '1.2', taskId: '1', text: 'copy reads well', verdict: 'unknown', evidence: 'sandbox denied the browser; a human has to eyeball it' },
      { id: '1.3', taskId: '1', text: 'no reason given', verdict: 'unknown', evidence: null },
    ],
  }));
  assert.deepEqual(items, []);
});

test('the outcome line counts the unknown criteria left unqueued', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'afk-fixer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await runFixer({
    root,
    config: {},
    dag: { epic: { id: '760' }, tasks: [] },
    verifierReport: review({
      criteria: [
        { id: '1.1', taskId: '1', text: 'haptics', verdict: 'unknown', evidence: 'needs a physical device' },
        { id: '1.2', taskId: '1', text: 'copy', verdict: 'unknown', evidence: null },
      ],
    }),
    runAgent: async () => { throw new Error('nothing is queued, so no agent may run'); },
  });
  assert.equal(report.status, 'nothing_to_do');
  assert.equal(report.unknownNotQueued, 2);
  assert.equal(renderFixerOutcome(report), 'FIX: nothing the review found is fixable here; 2 unknown criteria never queued and still unchecked.');
  assert.equal(fixerStateRecord(report).unknownNotQueued, 2);
  assert.match(renderFixerMarkdown(report), /2 unknown criteria never queued/);
});

// ---------------------------------------------------------------------------
// #145 — minors get a follow-up; a failed lane's criteria stay out of scope
// ---------------------------------------------------------------------------

test('never-queued minors render as one uncollapsed checklist, and none render nothing', () => {
  const body = renderMinorsComment(review({
    findings: [
      { axis: 'spec', severity: 'minor', title: 'stale link status after unlink', detail: 'line one\nline two', file: 'src/link.ts:9' },
      { axis: 'standards', severity: 'minor', title: 'unmemoized detectPlatform' },
      { axis: 'spec', severity: 'major', title: 'queued, so not listed' },
    ],
  }));
  assert.match(body, /^### 2 minor finding\(s\) from the closeout review, never queued/);
  assert.match(body, /^- \[ \] \*\*stale link status after unlink\*\* \(`src\/link\.ts:9`\) — spec: line one line two$/m);
  assert.match(body, /^- \[ \] \*\*unmemoized detectPlatform\*\* — standards$/m);
  assert.doesNotMatch(body, /<details>|queued, so not listed/);
  assert.equal(renderMinorsComment(review()), null);
});

test('criteria of a task that never passed are left out of the fix queue', async (t) => {
  // #803: task 809 failed twice on a leaked port; the fixer "fixed 14 of 17" by
  // hand-writing 809's whole UI on the run branch, out of every lane's scope.
  const report = review({
    criteria: [
      { id: '806.1', taskId: '806', text: 'grid renders', verdict: 'unmet' },
      { id: '809.1', taskId: '809', text: 'drawer opens', verdict: 'unmet' },
      { id: '809.2', taskId: '809', text: 'fail-first', verdict: 'unknown', evidence: 'mutation denied' },
    ],
  });
  assert.deepEqual(fixerItems(report, { skipTasks: ['809'] }).map((item) => item.title), ['grid renders']);

  const root = mkdtempSync(join(tmpdir(), 'afk-fixer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let handed = null;
  const fixed = await runFixer({
    root, config: {}, dag: { epic: { id: '803' }, tasks: [] }, verifierReport: report, skipTasks: ['809'],
    runAgent: async ({ promptPath, streamPath }) => {
      handed = readFileSync(promptPath, 'utf8');
      writeFileSync(streamPath, '```json\n{"summary":"s","fixed":[],"deferred":[]}\n```\n');
      return { status: 0 };
    },
  });
  assert.deepEqual(fixed.items.map((item) => item.title), ['grid renders']);
  assert.doesNotMatch(handed, /drawer opens/);
  assert.equal(fixed.unknownNotQueued, 1, "809.2 is an unknown nobody was handed");
});

test('a task that never passed is named with its retained branch and its last attempt\'s checks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'afk-fixer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attempt = (id, name, record) => {
    mkdirSync(join(root, '.afk', 'runs', id, name), { recursive: true });
    writeFileSync(join(root, '.afk', 'runs', id, name, 'verification.json'), JSON.stringify(record));
  };
  attempt('809', 'builder-1', { branch: 'afk/task-809', checks: [{ command: 'npm test', code: 2 }] });
  attempt('809', 'builder-2', {
    branch: 'afk/task-809',
    checks: [{ command: 'npm run lint', code: 0 }, { command: 'npm run test:stories', code: 1 }],
  });
  const dag = { tasks: [{ id: '806' }, { id: '809' }, { id: '810' }] };
  const state = { tasks: { 806: { lifecycle: 'passed' }, 809: { lifecycle: 'failed' }, 810: { lifecycle: 'blocked' } } };
  const lanes = unpassedLanes({ root, dag, state });
  assert.deepEqual(lanes.map((lane) => [lane.taskId, lane.branch, lane.attempt]), [['809', 'afk/task-809', 2], ['810', null, null]]);
  const markdown = renderUnpassedLanes(lanes);
  assert.match(markdown, /^- \*\*809\*\* `failed` — branch `afk\/task-809`, builder attempt 2: ✅ `npm run lint` · ❌ `npm run test:stories` \(exit 1\)$/m);
  assert.match(markdown, /^- \*\*810\*\* `blocked` — never built, so there is no branch\.$/m);
  assert.equal(renderUnpassedLanes([]), '');
});

test('an unparseable review queues the shared files nobody reviewed after the merge', () => {
  // #142 names seams beside unwired: structured entries must reach the fixer
  // whether or not the review returned a block.
  const items = fixerItems({
    status: 'unparseable',
    seams: [{ file: 'src/shared.ts', tasks: ['657', '661'], read: false, note: null }],
  });
  assert.deepEqual(items.map((item) => [item.title, item.file]), [
    ['`src/shared.ts`, written by #657 and #661, was not reviewed after the merge', 'src/shared.ts'],
  ]);
  assert.match(items[0].source, /unreviewed seam \(reach\)/);
});

test('check-only routing, case by case: the sandbox stopped it (queue) or a person, device or service must (drop)', () => {
  // Every string the #149 review ran, with its route. The subject of a test
  // ("human-readable", "phone-number", "sign-in", "Visual regression") is not
  // a person; "Permission denied (publickey)" and a rate limit are not the
  // review sandbox.
  const table = [
    ['mutation denied in this session', true],
    ['Edit denied by sandbox; could not break parseKeymap to watch the test fail', true],
    ['Visual regression snapshot test (vitest toMatchSnapshot) — mutation denied, could not break it', true],
    ['The login-form validation test: mutation denied in this session', true],
    ['fail-first on the sign-in reducer test; edit denied in this session', true],
    ['EPERM writing the phone-number formatter fixture', true],
    ['mutation denied; the human-readable error string test could not be broken', true],
    ['gate could not start: vitest hit EPERM on node_modules/.vite-temp', true],
    ['gate could not run: the tree is read-only in this sandbox', true],
    ['Could not run: needs STAGING_API_KEY and network access to staging', false],
    ['Did not run the e2e; it needs a deployed preview URL', false],
    ['Permission denied (publickey) fetching origin; could not compare against main', false],
    ['GitHub API request denied: rate limited', false],
    // Names no person and nothing out of reach: ambiguous, so queued (open).
    ['No evidence found in the diff; the PR description doesn\'t mention it', true],
    ['Needs a person to click through the onboarding flow', false],
    ['Requires a physical iPhone; sandbox cannot run the simulator', false],
    ['gate could not start: `npm run test:e2e` waits for a browser', false],
    ['mutation denied, and it needs a human sign-off anyway', false],
    ['sandbox denied the browser; a human has to eyeball it', false],
    // The second review's twelve (/tmp/route149.mjs).
    ['Could not run `npm test`: the review session is read-only.', true],
    ['Bash was denied by the permission profile, so the fail-first check was not executed.', true],
    ['Unable to execute the red-first revert because the worktree is read-only.', true],
    ['The verifier may not modify files, so the mutation step was skipped.', true],
    ['EROFS: read-only file system when reverting the fix', true],
    ['Edits are denied here; revert-and-rerun not attempted.', true],
    ['Needs a Stripe sandbox account with a webhook signing secret configured.', false],
    ['Requires the App Sandbox entitlement on a signed, notarized build.', false],
    ['Only verifiable in the sandbox environment of the payment provider (live webhooks).', false],
    ['Needs an iOS 18 device; mutation denied in this session anyway.', false],
    ['Must be checked on TestFlight by the owner; edits denied here.', false],
    ['The gate could not run: it needs the production database.', false],
    // No evidence at all is a criterion the review never answered, not one it
    // tried and was stopped on.
    [null, false],
  ];
  const wrong = table.filter(([evidence, want]) => checkOnlyCriterion({ verdict: 'unknown', evidence }) !== want);
  assert.deepEqual(wrong, []);
});

test('a check-only item the fixer found already met is written back as met, with its output', () => {
  // #143 asked for `met` with pasted output. The fixer reports a passing check
  // as `already met — …`, and the closeout's criteria table kept saying unknown.
  const report = review({
    criteria: [
      { id: '818.3', taskId: '818', text: 'break the hint, watch the test fail', verdict: 'unknown', evidence: 'mutation denied in this session' },
      { id: '818.4', taskId: '818', text: 'another', verdict: 'unknown', evidence: 'mutation denied in this session' },
    ],
  });
  const items = fixerItems(report);
  assert.equal(items[0].criterionId, '818.3');
  const fixReport = {
    status: 'ok',
    items,
    fixed: [],
    deferred: [
      { id: 'F1', title: items[0].title, reason: 'already met — `npm test -- hint`: 1 failed with the span removed, 12 passed restored', kind: 'no_op' },
      { id: 'F2', title: items[1].title, reason: 'could not run it either: the suite needs a browser', kind: 'needs_human' },
    ],
  };
  const merged = withCheckedCriteria(report, fixReport);
  assert.equal(merged.criteria[0].verdict, 'met');
  assert.match(merged.criteria[0].evidence, /closeout fix pass.*`npm test -- hint`: 1 failed with the span removed/);
  assert.equal(merged.criteria[1].verdict, 'unknown', 'a check the fixer could not run stays unknown');
  assert.equal(merged.counts.criteria.met, 1);
  assert.equal(report.criteria[0].verdict, 'unknown', 'the verifier\'s own report is not rewritten');
  assert.equal(withCheckedCriteria(report, null), report);
});

test('a task parked on a human acceptance is named as that, not as never built', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'afk-fixer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lanes = unpassedLanes({
    root,
    dag: { tasks: [{ id: '720' }] },
    state: { tasks: { 720: { lifecycle: 'awaiting_acceptance' } } },
  });
  const markdown = renderUnpassedLanes(lanes);
  assert.match(markdown, /^- \*\*720\*\* `awaiting_acceptance` — waiting on a human's acceptance \(`--accept=720`\); there is no lane to build\.$/m);
  assert.doesNotMatch(markdown, /never built/);
});

// ---------------------------------------------------------------------------
// Every fix ends in a lesson (#153)
// ---------------------------------------------------------------------------

const lessonItems = [
  { id: 'F1', title: 'one' }, { id: 'F2', title: 'two' }, { id: 'F3', title: 'three' },
];
const lessonPass = (fixed, extra = {}) => normalizeFixerReport({ summary: 's', fixed, deferred: [], ...extra }, lessonItems);
const lessonMarkdown = (fixed, extra) => renderFixerMarkdown({ status: 'ok', problems: [], items: lessonItems, ...lessonPass(fixed, extra) });
const RULE = { class: 'rule', id: 'no-unscoped-invalidate', file: 'eslint/lessons/no-unscoped-invalidate.js', redOn: 'eslint/lessons/fixtures/red.ts' };

test('a rule lesson renders its id and its red fixture under the fix', () => {
  const md = lessonMarkdown([{ id: 'F1', detail: 'd', files: ['a.ts'], lesson: RULE }]);
  assert.match(md, /\*\*one\*\*.*\n\s+Lesson: rule no-unscoped-invalidate \(red fixture eslint\/lessons\/fixtures\/red\.ts\)/);
});

test('a standard lesson renders its line, and a none lesson its reason', () => {
  const md = lessonMarkdown([
    { id: 'F1', detail: 'd', files: [], lesson: { class: 'standard', line: 'Never pass undefined into a cache filter.' } },
    { id: 'F2', detail: 'd', files: [], lesson: { class: 'none', reason: 'a one-off typo in copy' } },
  ]);
  assert.match(md, /Lesson: standard — Never pass undefined into a cache filter\./);
  assert.match(md, /Lesson: none — a one-off typo in copy/);
});

test('a fixed entry with no lesson renders `Lesson: missing`, never a default', () => {
  const report = lessonPass([{ id: 'F1', detail: 'd', files: [] }]);
  assert.equal('lesson' in report.fixed[0], false);
  assert.match(renderFixerMarkdown({ status: 'ok', problems: [], items: lessonItems, ...report }), /Lesson: missing/);
});

test('a malformed lesson is coerced to absent, the way a dangling duplicateOf is', () => {
  const malformed = [
    { class: 'rules', id: 'x', file: 'f', redOn: 'r' },          // wrong class
    { class: 'rule', id: 'x', file: 'f' },                        // missing redOn
    { class: 'rule', id: '  ', file: 'f', redOn: 'r' },           // blank id
    { class: 'standard' },                                        // missing line
    { class: 'none', reason: 7 },                                 // not a string
    'rule',                                                       // not an object
    null,
  ];
  for (const lesson of malformed) {
    const report = lessonPass([{ id: 'F1', detail: 'd', files: [], lesson }]);
    assert.equal('lesson' in report.fixed[0], false, JSON.stringify(lesson));
  }
  // A good one keeps only its own class's fields.
  const kept = lessonPass([{ id: 'F1', detail: 'd', files: [], lesson: { ...RULE, line: 'stray' } }]);
  assert.deepEqual(kept.fixed[0].lesson, RULE);
});

test('a duplicateOf entry renders its primary\'s lesson', () => {
  const md = lessonMarkdown([
    { id: 'F1', detail: 'd', files: [], lesson: RULE },
    { id: 'F3', detail: 'd', files: [], duplicateOf: 'F1' },
  ]);
  const three = md.split('\n').findIndex((line) => line.includes('**three**'));
  assert.match(md.split('\n')[three + 1], /Lesson: rule no-unscoped-invalidate/);
  assert.doesNotMatch(md, /Lesson: missing/);
});

test('noLessonsHome renders the setup-coduo-toolchain notice once, and only with no rule lesson', () => {
  const none = [
    { id: 'F1', detail: 'd', files: [], lesson: { class: 'standard', line: 'l' } },
    { id: 'F2', detail: 'd', files: [], lesson: { class: 'none', reason: 'r' } },
  ];
  const md = lessonMarkdown(none, { noLessonsHome: true });
  assert.equal(md.match(/setup-coduo-toolchain/g)?.length, 1, md);
  assert.equal(lessonPass(none, { noLessonsHome: true }).noLessonsHome, true);
  // Only a literal `true` counts; anything else is absent.
  assert.equal('noLessonsHome' in lessonPass(none, { noLessonsHome: 'yes' }), false);
  assert.doesNotMatch(lessonMarkdown(none), /setup-coduo-toolchain/);
  // A rule lesson means a home exists after all, whatever the flag says.
  assert.doesNotMatch(lessonMarkdown([{ id: 'F1', detail: 'd', files: [], lesson: RULE }], { noLessonsHome: true }), /setup-coduo-toolchain/);
});

test('noLessonsHome accepts the boolean the schema shows and the string "true" a model may emit (#155)', () => {
  // The schema shows an unambiguous boolean, not a string that reads as prose
  // and coerces to nothing under `=== true`.
  assert.match(FIXER_JSON_SCHEMA, /"noLessonsHome": true/);
  assert.doesNotMatch(FIXER_JSON_SCHEMA, /"noLessonsHome": "true/);
  // The boolean the schema shows is kept.
  assert.equal(lessonPass([], { noLessonsHome: true }).noLessonsHome, true);
  // A model that copies the value as a string is coerced, not dropped silently.
  assert.equal(lessonPass([], { noLessonsHome: 'true' }).noLessonsHome, true);
  assert.equal(lessonPass([], { noLessonsHome: '  TRUE  ' }).noLessonsHome, true);
  // Anything that is not a form of true stays absent and says nothing.
  assert.equal('noLessonsHome' in lessonPass([], { noLessonsHome: 'yes' }), false);
  assert.equal('noLessonsHome' in lessonPass([], { noLessonsHome: 'true — optional' }), false);
});

test('the no-lessons-home notice renders even when nothing was fixed (#155)', () => {
  // The spec condition is "no fixed entry has a rule lesson", which a pass that
  // fixed nothing satisfies. The notice used to sit inside `if (fixed.length)`.
  const md = lessonMarkdown([], { noLessonsHome: true });
  assert.match(md, /setup-coduo-toolchain/);
});

test('a restatement carrying its own rule lesson does not silence the notice, matching lessonCounts (#155)', () => {
  // F1 is the distinct fix with a non-rule lesson; F3 restates it but declares
  // its own rule. No DISTINCT fix produced a rule, so `lessonCounts.rule` is 0
  // and the notice must render — the guard and the count used to disagree.
  const fixed = [
    { id: 'F1', detail: 'd', files: [], lesson: { class: 'none', reason: 'r' } },
    { id: 'F3', detail: 'd', files: [], duplicateOf: 'F1', lesson: RULE },
  ];
  const report = { status: 'ok', problems: [], items: lessonItems, ...lessonPass(fixed, { noLessonsHome: true }) };
  assert.equal(lessonCounts(report).rule, 0);
  assert.match(renderFixerMarkdown(report), /setup-coduo-toolchain/);
});

test('the rendered fixer prompt carries the lesson step and the schema describes it', () => {
  const prompt = rolePrompt(roleFor('fixer'), {}, { epic: { id: 1 }, branch: 'b', schema: FIXER_JSON_SCHEMA });
  assert.match(prompt, /lesson/);
  assert.match(prompt, /red fixture/);
  // The step sits after Step 2's fixes and before Step 3's checks.
  assert.ok(prompt.indexOf('Step 2') < prompt.indexOf('red fixture'));
  assert.ok(prompt.indexOf('red fixture') < prompt.indexOf('Step 3'));
  // A rule has to say where it came from, or the next reader cannot find the defect it guards.
  assert.match(prompt, /end every rule's message with the PR or finding reference it came from/i);
  assert.match(prompt, /"lesson"/);
  assert.match(prompt, /"noLessonsHome"/);
});
