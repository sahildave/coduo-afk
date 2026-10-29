// scripts/grounded-retry.test.mjs — what a retried builder is told about the
// attempt that died before it (docs/wave-mode.md §5).
//
// Until this landed, a retry re-ran an identical prompt in a clean worktree:
// the evidence existed — `verification.json`, written per attempt precisely so a
// retry could not overwrite it — and nothing read it. The two things worth
// holding here are the two ways this goes wrong rather than merely useless:
// carrying every failing check (the 1.3M-token prompt of AGENTS.md failure mode
// 5), and grounding a retry on an attempt that never reached the API, which
// hands a model an infra error as if it were its own mistake.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderRunDir, priorAttemptsFor, renderPriorAttempts } from "./worker.mjs";
import { agentConfig } from "./lib.mjs";
import { implementerPrompt } from "./roles.mjs";

const TASK = { id: "204", title: "Add thing", allowedPaths: ["src/**"], checks: ["npm test"] };

const verification = (over = {}) => ({
  taskId: "204",
  attempt: 1,
  agentExitCode: 0,
  timedOut: false,
  durationMs: 61_000,
  tokens: { input: 12_000, output: 3_000 },
  producedFiles: ["src/app.ts", "src/app.test.ts"],
  checks: [{ command: "npm test", code: 1, output: "1 failing\n  expected 3 to equal 4" }],
  ...over,
});

const writeAttempt = (root, taskId, attempt, record) => {
  const dir = builderRunDir(root, taskId, attempt);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verification.json"), `${JSON.stringify(record, null, 2)}\n`);
};

test("a prior attempt is carried as its number, its first failing check and its paths", () => {
  const text = renderPriorAttempts([verification()]);
  assert.match(text, /Attempt 1 failed\./);
  assert.match(text, /First failing check: npm test/);
  assert.match(text, /expected 3 to equal 4/);
  assert.match(text, /Paths it touched: src\/app\.ts, src\/app\.test\.ts/);
});

test("a clipped output names the record that holds the unclipped copy", () => {
  // The 2,000-char window is orientation. The whole output is already on disk
  // in that attempt's verification.json; before this, nothing told the
  // successor the file existed, so the clip read as the end of the evidence.
  const text = renderPriorAttempts([verification({
    recordPath: "/repo/.afk/runs/204/builder-1/verification.json",
    checks: [{ command: "npm test", code: 1, output: "y".repeat(5_000) }],
  })]);
  assert.match(text, /Full unclipped output: \/repo\/\.afk\/runs\/204\/builder-1\/verification\.json/);
});

test("an output that fitted the window says nothing about a path", () => {
  // Noise discipline: the line only earns its place when something was cut.
  const text = renderPriorAttempts([verification({
    recordPath: "/repo/.afk/runs/204/builder-1/verification.json",
  })]);
  assert.doesNotMatch(text, /Full unclipped output/);
});

test("only the FIRST failing check is carried", () => {
  // The whole prompt-size guard. A suite stops at its first failure anyway, so
  // the later entries are noise that costs tokens the retry needs for the work.
  const text = renderPriorAttempts([verification({
    checks: [
      { command: "npm run lint", code: 0, output: "clean" },
      { command: "npm test", code: 1, output: "FIRST FAILURE" },
      { command: "npm run typecheck", code: 1, output: "SECOND FAILURE" },
    ],
  })]);
  assert.match(text, /First failing check: npm test/);
  assert.match(text, /FIRST FAILURE/);
  assert.doesNotMatch(text, /SECOND FAILURE/);
  // A skipped check is not a failing one (`checkFailed`, scripts/lib.mjs).
  const skipped = renderPriorAttempts([verification({
    checks: [
      { command: "cargo test", skipped: true, code: null, reason: "run changed no Rust" },
      { command: "npm test", code: 1, output: "the real one" },
    ],
  })]);
  assert.match(skipped, /First failing check: npm test/);
});

test("a long check output is clipped rather than carried whole", () => {
  const text = renderPriorAttempts([verification({
    checks: [{ command: "npm test", code: 1, output: "x".repeat(50_000) }],
  })]);
  assert.ok(text.length < 5_000, `expected a clipped block, got ${text.length} chars`);
  assert.match(text, /more chars/);
});

test("an attempt that never reached the API is dropped, so the retry runs plain", () => {
  // Zero tokens AND no produced files: the herdr kill / expired login shape.
  // Its failure says nothing about the ticket, so there is nothing to ground on
  // and the section must be absent rather than empty.
  assert.equal(
    renderPriorAttempts([verification({
      tokens: { input: 0, output: 0, cacheRead: 0 },
      producedFiles: [],
      checks: [],
      agentExitCode: 143,
    })]),
    null,
  );
});

test("zero counters with files on disk is a metering gap, not an infra death", () => {
  // Epic 50 on gitproj-demo: all-zero counters and `src/cli.js` written. Files
  // are proof the API was reached whatever the counters say, so this attempt
  // still grounds the retry.
  const text = renderPriorAttempts([verification({
    tokens: { input: 0, output: 0, cacheRead: 0 },
    producedFiles: ["src/cli.js"],
  })]);
  assert.match(text, /Paths it touched: src\/cli\.js/);
});

test("an attempt whose checks never ran says why the process died", () => {
  const timedOut = renderPriorAttempts([verification({
    checks: [], timedOut: true, agentExitCode: null, durationMs: 900_000,
  })]);
  assert.match(timedOut, /timed out after 900000ms/);
  const exited = renderPriorAttempts([verification({ checks: [], agentExitCode: 2 })]);
  assert.match(exited, /exited 2/);
});

test("every prior attempt is carried, oldest first", () => {
  const text = renderPriorAttempts([
    verification({ attempt: 1, checks: [{ command: "npm test", code: 1, output: "one" }] }),
    verification({ attempt: 2, checks: [{ command: "npm test", code: 1, output: "two" }] }),
  ]);
  assert.ok(text.indexOf("Attempt 1 failed.") < text.indexOf("Attempt 2 failed."));
});

test("priorAttemptsFor reads the per-attempt run directories, and attempt 1 gets nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-grounded-"));
  writeAttempt(root, "204", 1, verification());
  assert.equal(priorAttemptsFor({ root, taskId: "204", attempt: 1 }), null);
  assert.match(priorAttemptsFor({ root, taskId: "204", attempt: 2 }), /Attempt 1 failed\./);
});

test("an unreadable verification costs the retry its grounding, never the lane", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-grounded-"));
  mkdirSync(builderRunDir(root, "204", 1), { recursive: true });
  writeFileSync(join(builderRunDir(root, "204", 1), "verification.json"), "{ half-written");
  writeAttempt(root, "204", 2, verification({ attempt: 2 }));
  const text = priorAttemptsFor({ root, taskId: "204", attempt: 3 });
  assert.match(text, /Attempt 2 failed\./);
  assert.doesNotMatch(text, /Attempt 1 failed\./);
  // And a task with no run directory at all is not an error.
  assert.equal(priorAttemptsFor({ root, taskId: "999", attempt: 3 }), null);
});

test("the implementer prompt carries the section only when there is evidence", () => {
  const plain = implementerPrompt({ task: TASK, taskText: "# 204\nDo the thing" });
  assert.doesNotMatch(plain, /Earlier attempts/);
  const grounded = implementerPrompt({
    task: TASK,
    taskText: "# 204\nDo the thing",
    priorAttempts: renderPriorAttempts([verification()]),
  });
  assert.match(grounded, /Earlier attempts at this same task failed/);
  assert.match(grounded, /expected 3 to equal 4/);
  // Placed after the builder rules, whose closing sentence overrides anything
  // an earlier attempt's output might read as an instruction.
  assert.ok(grounded.indexOf("Builder rules:") < grounded.indexOf("Earlier attempts"));
  // And nothing of the template leaks when the value is absent.
  assert.doesNotMatch(plain, /\{\{/);
});

test("a retried builder is required to end its report with a LESSON line (#215)", () => {
  const plain = implementerPrompt({ task: TASK, taskText: "# 204\nDo the thing" });
  assert.doesNotMatch(plain, /LESSON:/);
  const grounded = implementerPrompt({ task: TASK, taskText: "# 204\nDo the thing", priorAttempts: renderPriorAttempts([verification()]) });
  assert.match(grounded, /LESSON: rule:<id>:<file>:<redOn>/);
  assert.match(grounded, /LESSON: standard:"<line>"/);
  assert.match(grounded, /LESSON: none:"<reason>"/);
});

test("agent.maxBuilderRetries defaults to 1 and is read like every other agent value", () => {
  assert.equal(agentConfig({}).maxBuilderRetries, 1);
  assert.equal(agentConfig({ agent: { maxBuilderRetries: 2 } }).maxBuilderRetries, 2);
  assert.equal(agentConfig({ agent: { maxBuilderRetries: 0 } }).maxBuilderRetries, 0);
});

test("a malformed maxBuilderRetries refuses the run instead of coercing", () => {
  // `"2"` compares against the attempt counter by JS coercion and quietly gives
  // the run a budget the operator did not write.
  assert.throws(() => agentConfig({ agent: { maxBuilderRetries: "2" } }), /maxBuilderRetries/);
  assert.throws(() => agentConfig({ agent: { maxBuilderRetries: -1 } }), /maxBuilderRetries/);
  assert.throws(() => agentConfig({ agent: { maxBuilderRetries: 2.5 } }), /maxBuilderRetries/);
});

test("a Codex attempt stopped by its quota or login does not ground the Opus retry (#292)", () => {
  assert.equal(renderPriorAttempts([verification({ quotaRejected: true, rateLimited: true, checks: [], agentExitCode: 1 })]), null);
  assert.equal(renderPriorAttempts([verification({ authFailure: true, checks: [], agentExitCode: 1 })]), null);
});
