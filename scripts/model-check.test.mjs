// scripts/model-check.test.mjs — the Opus 5.5 lane hardening:
//
//   1. a role silently moved to another model is recorded, logged and surfaced;
//   2./3. the implementer's checklist lives in scratch outside the lane, is
//      copied back under .afk/runs/, and is named to the supervisor;
//   4. a verifier finding says how to show it fails, and that reaches the fixer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelCheck, modelSwitchLine, observedModels } from './model-check.mjs';
import { IMPLEMENTER_CHECKLIST_MARK, implementerChecklistPath, runBuilder } from './worker.mjs';
import { createTaskWorktree, readLaneVerification } from './worktree.mjs';
import { supervisorEvidence } from './supervisor.mjs';
import { renderModelSwitches, renderPrBody } from './pr.mjs';
import { normalizeReport, renderVerifierMarkdown, parseVerifierOutput, verifierDecision } from './verifier.mjs';
import { fixerItems, renderFixerItems } from './fixer.mjs';

// --- fixtures: stream.jsonl lines in the shape `claude -p --output-format
// stream-json` writes them (checked against real lane streams) -------------

const init = (model) => JSON.stringify({ type: 'system', subtype: 'init', model });
const said = (model, extra = {}) =>
  JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'x' }] }, parent_tool_use_id: null, ...extra });
const stream = (...lines) => `${lines.join('\n')}\n`;

// --- 1. the pure reading -----------------------------------------------------

test('a session whose later turns came from another model is a switch, with counts per model', () => {
  // No real stream on this machine shows a safeguard switch yet; this fixture
  // encodes the assumption stated in scripts/model-check.mjs (init keeps the
  // starting model, later turns carry the fallback model).
  const raw = stream(
    init('claude-opus-5-5'),
    said('claude-opus-5-5'), said('claude-opus-5-5'),
    said('claude-opus-4-6'), said('claude-opus-4-6'), said('claude-opus-4-6'),
  );
  const check = modelCheck(raw);
  assert.deepEqual(check, {
    started: 'claude-opus-5-5',
    observed: { 'claude-opus-5-5': 2, 'claude-opus-4-6': 3 },
    status: 'switched',
  });
  const line = modelSwitchLine('builder 204', check);
  assert.match(line, /^MODEL SWITCH — builder 204 started on claude-opus-5-5, later replies came from claude-opus-4-6 ×3\./);
});

test('every turn on the init model is a match and says nothing', () => {
  const check = modelCheck(stream(init('claude-opus-5-5'), said('claude-opus-5-5'), said('claude-opus-5-5')));
  assert.equal(check.status, 'match');
  assert.equal(modelSwitchLine('x', check), null);
});

test('no init model, or no assistant turns, is unknown, never an alarm', () => {
  // A herdr pane, a Codex stream and a fast-forward merge all look like this.
  for (const raw of [
    '',
    stream(JSON.stringify({ type: 'result', subtype: 'success' })),
    'not json\n{"type":"assistant"',
    stream(said('claude-opus-4-6')),
    stream(init('claude-opus-5-5')),
  ]) {
    const check = modelCheck(raw);
    assert.equal(check.status, 'unknown', raw);
    assert.equal(modelSwitchLine('x', check), null);
  }
});

test('synthetic turns and sub-agent turns on another model are not a switch', () => {
  const raw = stream(
    init('claude-opus-5-5'),
    said('claude-opus-5-5'),
    said('<synthetic>'),
    // A sub-agent runs on its own definition's model; that is a choice.
    said('claude-haiku-4-5', { parent_tool_use_id: 'toolu_1' }),
  );
  assert.deepEqual(observedModels(raw).counts, { 'claude-opus-5-5': 1 });
  assert.equal(modelCheck(raw).status, 'match');
});

// --- 1 + 3, end to end through a real builder --------------------------------

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A lane and a fake `claude` that reads its prompt from stdin, keeps a checklist
 * at the scratch path the prompt names, makes one edit, and answers on the
 * model `answeredOn` — the forced mismatch.
 */
const fakeLane = (answeredOn) => {
  const repo = mkdtempSync(join(tmpdir(), 'afk-model-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'runner@example.test');
  git(repo, 'config', 'user.name', 'Runner Test');
  writeFileSync(join(repo, '.gitignore'), '.afk/\n');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: '301', baseSha });
  const bin = mkdtempSync(join(tmpdir(), 'afk-fake-bin-'));
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const checklist = input.match(/\`(\\/tmp\\/[^\`]*checklist\\.md)\`/)[1];
  fs.writeFileSync(checklist, '- [x] Orient\\n- [ ] Verify\\n- found: the README is the only doc\\n');
  fs.writeFileSync('feature.txt', 'built\\n');
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
  line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'start' }] }, parent_tool_use_id: null });
  line({ type: 'assistant', message: { model: ${JSON.stringify(answeredOn)}, content: [{ type: 'text', text: 'moved' }] }, parent_tool_use_id: null });
  line({ type: 'assistant', message: { model: ${JSON.stringify(answeredOn)}, content: [{ type: 'text', text: 'done' }] }, parent_tool_use_id: null });
  line({ type: 'result', subtype: 'success', result: 'done' });
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { repo, lane, baseSha, bin };
};

const build = async ({ repo, lane, baseSha, bin }) => {
  const lines = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const built = await runBuilder({
      root: repo,
      config: {
        maxParallel: 1,
        defaultChecks: [],
        agent: { command: 'claude', model: 'claude-opus-5-5', bypassPermissions: true, timeoutMs: 10_000, runtime: 'direct' },
      },
      task: { id: '301', title: 'Build the feature', dependsOn: [], allowedPaths: ['**'], checks: [], body: '# 301\n' },
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha,
      attempt: 1,
      say: (line) => lines.push(line),
    });
    return { built, lines };
  } finally {
    process.env.PATH = previousPath;
  }
};

test('a builder moved to another model mid-lane is recorded, logged, noted on the branch — and still passes', async () => {
  const fixture = fakeLane('claude-opus-4-6');
  const { built, lines } = await build(fixture);
  // Not failed: the work continued legitimately.
  assert.equal(built.outcome, 'ready_to_integrate');
  assert.deepEqual(built.verification.modelCheck, {
    started: 'claude-opus-5-5',
    observed: { 'claude-opus-5-5': 1, 'claude-opus-4-6': 2 },
    status: 'switched',
  });
  const alarms = lines.filter((line) => /MODEL SWITCH/.test(line));
  assert.equal(alarms.length, 1, `expected one MODEL SWITCH line, got: ${JSON.stringify(lines)}`);
  assert.match(alarms[0], /builder 301 \(attempt 1\) started on claude-opus-5-5, later replies came from claude-opus-4-6 ×2\./);
  // The copy restart and integration read back, off the task commit.
  const note = readLaneVerification(fixture.repo, '301', built.commitSha);
  assert.equal(note?.modelCheck?.status, 'switched');
});

test('a builder that stayed on its model raises nothing', async () => {
  const { built, lines } = await build(fakeLane('claude-opus-5-5'));
  assert.equal(built.verification.modelCheck.status, 'match');
  assert.equal(lines.filter((line) => /MODEL SWITCH/.test(line)).length, 0);
});

test('the checklist path is substituted, lies outside the lane, and is kept for the supervisor', async () => {
  const fixture = fakeLane('claude-opus-5-5');
  const { built } = await build(fixture);
  const runDir = resolve(fixture.repo, '.afk', 'runs', '301', 'builder-1');
  const prompt = readFileSync(join(runDir, 'prompt.md'), 'utf8');
  assert.ok(!prompt.includes(IMPLEMENTER_CHECKLIST_MARK), 'the mark was left in the prompt');
  const scratch = prompt.match(/`(\/tmp\/[^`]*checklist\.md)`/)?.[1];
  assert.ok(scratch, 'the prompt names no /tmp checklist path');
  assert.ok(!resolve(scratch).startsWith(resolve(fixture.lane.worktree)), 'the checklist is inside the lane');
  // Copied back under .afk/runs/, and the scratch removed.
  assert.equal(built.verification.checklistPath, join(runDir, 'checklist.md'));
  assert.match(readFileSync(built.verification.checklistPath, 'utf8'), /- \[x\] Orient/);
  assert.equal(existsSync(scratch), false);
  // Nothing of it rode the branch.
  assert.equal(git(fixture.repo, 'show', '--name-only', '--format=', built.commitSha).stdout.trim(), 'feature.txt');
  // And the supervisor is told where it is, for every lane event.
  const evidence = supervisorEvidence('lane_failed', { taskId: '301', verification: built.verification });
  assert.equal(evidence.artifacts.checklist, built.verification.checklistPath);
});

test('the scratch goes even when the agent run throws, and its parent is private', async () => {
  const fixture = fakeLane('claude-opus-5-5');
  // A herdr that fails every call: `runHerdrRole` throws before any agent runs.
  writeFileSync(join(fixture.bin, 'herdr'), '#!/bin/sh\necho "herdr: no server" >&2\nexit 1\n');
  chmodSync(join(fixture.bin, 'herdr'), 0o755);
  const parent = `/tmp/afk-implementer-${process.getuid()}`;
  const mine = () => (existsSync(parent) ? readdirSync(parent).filter((name) => name.startsWith('301-7-')) : []);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    await assert.rejects(runBuilder({
      root: fixture.repo,
      config: { maxParallel: 1, defaultChecks: [], agent: { command: 'claude', model: 'claude-opus-5-5', timeoutMs: 10_000, runtime: 'herdr' } },
      task: { id: '301', title: 'Build the feature', dependsOn: [], allowedPaths: ['**'], checks: [], body: '# 301\n' },
      worktree: fixture.lane.worktree,
      branch: fixture.lane.branch,
      baseSha: fixture.baseSha,
      attempt: 7,
      say: () => {},
    }));
  } finally {
    process.env.PATH = previousPath;
  }
  assert.deepEqual(mine(), [], 'the attempt scratch outlived a thrown run');
  assert.equal(statSync(parent).mode & 0o777, 0o700);
});

test('the scratch path is under /tmp, per attempt, never in a worktree', () => {
  const a = implementerChecklistPath('301', 1);
  const b = implementerChecklistPath('301', 1);
  assert.ok(a.startsWith('/tmp/afk-implementer-'));
  assert.ok(a.endsWith('/checklist.md'));
  assert.notEqual(a, b);
});

// --- 1, surfaced where lane results are summarised ---------------------------

test('the PR body names every switched lane, and says nothing on a clean run', () => {
  const switched = { started: 'claude-opus-5-5', observed: { 'claude-opus-4-6': 4 }, status: 'switched' };
  const state = {
    tasks: {
      301: { lifecycle: 'passed', taskVerification: { modelCheck: switched } },
      302: { lifecycle: 'passed', taskVerification: { modelCheck: { ...switched, status: 'match' } } },
    },
  };
  const body = renderPrBody({ epic: { id: '9' }, dag: { tasks: [{ id: '301', title: 'a', dependsOn: [] }, { id: '302', title: 'b', dependsOn: [] }] }, state, renderedAt: 'T' });
  assert.match(body, /### ⚠️ Model switches/);
  assert.match(body, /builder 301 started on claude-opus-5-5, later replies came from claude-opus-4-6 ×4/);
  assert.doesNotMatch(body, /builder 302/);
  assert.match(renderModelSwitches({}, { modelCheck: switched }), /the closeout verifier started on/);
  assert.equal(renderModelSwitches({ tasks: { 302: state.tasks[302] } }, null), null);
  // A clean run leaves no trace in the body, not even a blank line (the body's
  // own blank-line collapse sees to it; this pins that it stays so).
  const clean = renderPrBody({ epic: { id: '9' }, dag: { tasks: [{ id: '302', title: 'b', dependsOn: [] }] }, state: { tasks: { 302: state.tasks[302] } }, renderedAt: 'T' });
  assert.doesNotMatch(clean, /\n\n\n## Progress/);
  assert.match(clean, /[^\n]\n\n## Progress/);
});

// --- 4. howToShowItFails -----------------------------------------------------

const withProof = {
  axis: 'spec', severity: 'blocker', title: 'no auth check', detail: 'anyone can call it',
  file: 'api/x.ts:12', howToShowItFails: 'curl -s localhost:3000/api/x returns 200 without a token',
};

test('a finding keeps how to show it fails, and a report written before the field still parses', () => {
  const [kept] = normalizeReport({ findings: [withProof] }).findings;
  assert.equal(kept.howToShowItFails, withProof.howToShowItFails);
  const { howToShowItFails: _drop, ...old } = withProof;
  const [legacy] = normalizeReport({ findings: [old] }).findings;
  assert.equal(legacy.howToShowItFails, null);
  assert.equal(legacy.title, 'no auth check');
});

test('a blocker without a way to show it fails is noted, not blocked on', () => {
  const report = (finding) => parseVerifierOutput({
    text: `\`\`\`json\n${JSON.stringify({ summary: 's', findings: [finding], mustFix: [] })}\n\`\`\`\n`,
    raw: '',
    criteria: [],
    agentStatus: 0,
  });
  const { howToShowItFails: _drop, ...old } = withProof;
  const unshown = verifierDecision(report(old));
  assert.ok(unshown.notes.some((note) => /1 blocker\/major finding came with no way to show it fails/.test(note)));
  assert.equal(unshown.recommendation, 'must-fix');
  const shown = verifierDecision(report(withProof));
  assert.ok(!shown.notes.some((note) => /no way to show/.test(note)));
  assert.match(renderVerifierMarkdown(report(withProof)), /Shows it fails: curl -s localhost:3000/);
});

test('the fixer is handed the reproduction as its fail-first check', () => {
  const items = fixerItems({ status: 'ok', findings: [withProof], mustFix: [], criteria: [] });
  assert.equal(items[0].howToShowItFails, withProof.howToShowItFails);
  assert.match(renderFixerItems(items), /- shows it fails: curl -s localhost:3000\/api\/x returns 200 without a token/);
  // A must-fix line restating the same finding keeps the reproduction.
  const merged = fixerItems({ status: 'ok', findings: [withProof], mustFix: ['no auth check'], criteria: [] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].howToShowItFails, withProof.howToShowItFails);
  const prompt = readFileSync(new URL('../prompts/fixer.md', import.meta.url), 'utf8');
  assert.match(prompt, /shows it fails.*fail-first/s);
  // Bounded: only a local command that ends by itself, never a server or a human harness.
  assert.match(prompt, /local, non-interactive command that terminates/);
  assert.match(prompt, /dev:web:e2e/);
  assert.match(prompt, /skip it, say why/);
});

test('the verifier may not fill howToShowItFails with an excuse', () => {
  const prompt = readFileSync(new URL('../prompts/verifier.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /say why in that field/);
  assert.match(prompt, /leave `howToShowItFails` null/);
  assert.match(prompt, /Never fill the field with an explanation/);
});

// --- the integrator's record describes its latest attempt ---------------------

test('a clean integration retry clears the switch an earlier attempt recorded', async () => {
  const { recordIntegratorModelCheck } = await import('./auto.mjs');
  const switched = { started: 'claude-opus-5-5', observed: { 'claude-opus-4-6': 2 }, status: 'switched' };
  const taskRuntime = { lifecycle: 'running' };
  recordIntegratorModelCheck(taskRuntime, switched);
  assert.deepEqual(taskRuntime.integratorModelCheck, switched);
  // The retry stayed on the model it started on: the PR must not name a switch the
  // merge that landed never had.
  recordIntegratorModelCheck(taskRuntime, { ...switched, observed: { 'claude-opus-5-5': 1 }, status: 'match' });
  assert.equal('integratorModelCheck' in taskRuntime, false);
  assert.equal(renderModelSwitches({ tasks: { 301: taskRuntime } }), null);
  // A fast-forward retry (no agent, `unknown`) replaces it too.
  recordIntegratorModelCheck(taskRuntime, switched);
  recordIntegratorModelCheck(taskRuntime, undefined);
  assert.equal('integratorModelCheck' in taskRuntime, false);
  // And a second switch replaces the first rather than keeping the stale one.
  recordIntegratorModelCheck(taskRuntime, switched);
  const again = { ...switched, observed: { 'claude-sonnet-4-5': 1 } };
  recordIntegratorModelCheck(taskRuntime, again);
  assert.deepEqual(taskRuntime.integratorModelCheck, again);
});
