// The herdr transcript watcher declares a lane's login dead from its Claude
// transcript. Epic #183 lost lanes #178 and #179 ~90s in: each had grepped the
// runner's own source, the phrases came back inside a tool_result, and the
// watcher read that as an expired login while `claude auth status` said
// loggedIn. Only a line Claude Code wrote for a failed API call counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTranscriptWatcher, transcriptLimit, transcriptShowsAuthDeath } from './runtime-herdr.mjs';

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// Shape copied from real transcripts on disk (77 of 77 auth-error lines found
// under ~/.claude/projects looked like this; trimmed to the fields that matter).
const realAuthError = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'authentication_failed',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
  },
};

// What lane #179 saw (transcript 56ccac76-..., line 218): its own grep output.
const grepToolResult = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_x',
      content: "scripts/lib.mjs:392:  /OAuth session expired|Failed to authenticate|authentication_error/.test(",
    }],
  },
};

const assistantQuotingCode = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'looksLikeAuthDeath matches "OAuth session expired" and authentication_error.' }],
  },
};

test('a tool_result that contains the auth phrases is not auth death', () => {
  assert.equal(transcriptShowsAuthDeath(jsonl(grepToolResult)), false);
});

test('an assistant message quoting the auth phrases is not auth death', () => {
  assert.equal(transcriptShowsAuthDeath(jsonl(assistantQuotingCode)), false);
});

test('a real API auth-error line is auth death, even among quoted ones', () => {
  assert.equal(transcriptShowsAuthDeath(jsonl(realAuthError)), true);
  assert.equal(transcriptShowsAuthDeath(jsonl(grepToolResult, assistantQuotingCode, realAuthError)), true);
});

test('the watcher ignores a grep of the runner but catches a real auth error, even one split across scans', () => {
  const home = mkdtempSync(join(tmpdir(), 'afk-transcript-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/tmp/lane-wt';
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.jsonl');
    const marker = '/tmp/prompt-179.md';
    writeFileSync(file, jsonl({ type: 'user', message: { content: marker } }, grepToolResult, assistantQuotingCode));
    const watcher = makeTranscriptWatcher(cwd, 0, marker);
    assert.equal(watcher.scan(), false, 'reading the runner source is not an expired login');

    const line = JSON.stringify(realAuthError) + '\n';
    appendFileSync(file, line.slice(0, 50));
    assert.equal(watcher.scan(), false, 'half a line is not yet evidence');
    appendFileSync(file, line.slice(50));
    assert.equal(watcher.scan(), true, 'the completed auth-error line is caught');
  } finally {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a non-auth API error, partial lines and empty input are not auth death', () => {
  const rateLimited = { ...realAuthError, error: 'rate_limit', message: { ...realAuthError.message, content: [{ type: 'text', text: 'API Error: 429' }] } };
  assert.equal(transcriptShowsAuthDeath(jsonl(rateLimited)), false);
  // A slice can end mid-line while Claude Code is still writing it.
  assert.equal(transcriptShowsAuthDeath(JSON.stringify(realAuthError).slice(0, 40)), false);
  assert.equal(transcriptShowsAuthDeath(''), false);
  assert.equal(transcriptShowsAuthDeath(undefined), false);
});

// Shape copied from a real transcript on disk (Claude Code 2.1.234+): a herdr
// lane writes no stream.jsonl, so this line is the only place its quota shows.
const realLimitLine = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiErrorStatus: 429,
  quotaLimits: { status: 'rejected', resetsAt: 1788022800, rateLimitType: 'seven_day' },
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: "You've hit your weekly limit · resets Aug 30 at 1am (Asia/Kuala_Lumpur)" }],
  },
};

test('a real usage-limit line is a limit, with resetsAt from quotaLimits', () => {
  assert.deepEqual(transcriptLimit(jsonl(realLimitLine)), { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1788022800 });
});

test('a tool_result or assistant message quoting the limit text is not a limit', () => {
  const quoted = "You've hit your weekly limit · resets Aug 30 at 1am (Asia/Kuala_Lumpur)";
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_y', content: quoted }] } };
  const prose = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `The transcript says: ${quoted}` }] } };
  assert.equal(transcriptLimit(jsonl(toolResult, prose)), null);
});

test('the watcher sets .limit from a real limit line while scan() stays false for auth', () => {
  const home = mkdtempSync(join(tmpdir(), 'afk-transcript-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/tmp/lane-wt-limit';
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.jsonl');
    const marker = '/tmp/prompt-limit.md';
    writeFileSync(file, jsonl({ type: 'user', message: { content: marker } }));
    const watcher = makeTranscriptWatcher(cwd, 0, marker);
    assert.equal(watcher.scan(), false);
    assert.equal(watcher.limit, null);
    appendFileSync(file, jsonl(realLimitLine));
    assert.equal(watcher.scan(), false, 'a usage limit is not an expired login');
    assert.equal(watcher.limit?.resetsAt, 1788022800);
  } finally {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
