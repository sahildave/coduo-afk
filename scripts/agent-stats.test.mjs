// scripts/agent-stats.test.mjs — `afk stats --efficiency` against a real
// session transcript excerpt. Expected values come from the reference
// implementation (/tmp/impl-eff/analyze.py) run on the same file, so the
// numbers below were not computed by the code under test.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { efficiency, formatEfficiency, formatLane, laneMetrics } from "./agent-stats.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude/session-excerpt.jsonl", import.meta.url));
const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));
const transcript = readFileSync(fixture, "utf8");
// A lane's stream.jsonl (claude -p --output-format stream-json), excerpted.
const streamFixture = fileURLToPath(new URL("./fixtures/claude/stream-excerpt.jsonl", import.meta.url));
const stream = readFileSync(streamFixture, "utf8");
// Two assistant lines and the first two result events of a resumed verifier run.
const multiResult = readFileSync(fileURLToPath(new URL("./fixtures/claude/stream-multi-result.jsonl", import.meta.url)), "utf8");

test("efficiency: usage counts once per message id, not once per line", () => {
  // 11 lines, 5 messages: stream-json writes one line per content block and
  // repeats the message's usage on each. Summing lines double-counts.
  const e = efficiency(transcript);
  assert.equal(e.turns, 5);
  assert.equal(e.tokens.output, 1390);
  assert.equal(e.tokens.input, 10);
  assert.equal(e.tokens.cacheRead, 260766);
  assert.equal(e.tokens.cacheWrite, 55653);
  assert.deepEqual(e.tools, { Bash: 5 });
});

test("efficiency: derived measures", () => {
  const e = efficiency(transcript);
  assert.equal(e.costUnits, Math.round(10 + 1.25 * 55653 + 0.1 * 260766 + 5 * 1390));
  assert.equal(e.firstContext, 48624);
  // The first turn creates that context rather than re-reading it.
  assert.equal(e.firstContextShare, (48624 * 4) / 260766);
  assert.equal(e.cacheReadPerTurn, Math.round(260766 / 5));
  // text 138 chars, tool input 717 chars (compact JSON of each unique
  // tool_use input, counted by a separate Python pass); thinking is the
  // remainder, since a transcript reports no thinking count.
  assert.equal(e.tokens.outputEstimate.text, Math.round(138 / 4));
  assert.equal(e.tokens.outputEstimate.toolInput, Math.round(717 / 4));
  assert.equal(e.tokens.thinkingSource, "estimate");
  assert.equal(e.tokens.outputEstimate.thinking, 1390 - e.tokens.outputEstimate.text - e.tokens.outputEstimate.toolInput);
  assert.deepEqual(e.retries, { sandboxDisabled: 1, repeatedCommands: 1 });
});

test("efficiency: a Codex stream has no per-message usage and says so", () => {
  const codex = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3 } });
  assert.equal(efficiency(codex).turns, 0);
  assert.match(formatEfficiency("7", efficiency(codex)), /no Claude per-message usage/);
});

test("afk stats --efficiency / --json read a transcript path", () => {
  const text = spawnSync(process.execPath, [afk, "stats", "--efficiency", fixture], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /cost units +102\.6k \(input x1 \+ cache write x1\.25 \+ cache read x0\.1 \+ output x5\)/);
  assert.match(text.stdout, /estimate/);
  // Only the efficiency block: the legacy one-line summary disagreed with it.
  assert.equal(text.stdout.split("\n")[0], `${fixture} efficiency`);
  const json = spawnSync(process.execPath, [afk, "stats", "--json", fixture], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const [report] = JSON.parse(json.stdout);
  assert.equal(report.turns, 5);
  assert.deepEqual(report.costWeights, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
});

test("efficiency: on a stream log, output comes from the result event, not the per-message stubs", () => {
  // Each assistant line in stream-json carries a stub output_tokens (1-3
  // here); only the closing `result` event has the final count. Figures
  // below are that event's usage, read off the fixture's last line.
  const result = JSON.parse(stream.trim().split("\n").at(-1));
  assert.equal(result.type, "result");
  assert.equal(result.usage.output_tokens, 11928);
  assert.equal(result.usage.output_tokens_details.thinking_tokens, 2411);
  const e = efficiency(stream);
  assert.equal(e.tokens.output, 11928);
  assert.equal(e.tokens.outputEstimate.thinking, 2411);
  assert.equal(e.tokens.thinkingSource, "reported");
});

test("efficiency: several result events are summed, each covers only its own segment", () => {
  const results = multiResult.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "result");
  assert.deepEqual(results.map((r) => r.usage.output_tokens), [19753, 59]);
  const e = efficiency(multiResult);
  assert.equal(e.tokens.output, 19812);
  assert.equal(e.tokens.outputEstimate.thinking, 5778);
  assert.equal(e.tokens.outputSource, "result");
});

test("efficiency: stream-json with no result event marks output as a stub; a transcript does not", () => {
  const noResult = multiResult.split("\n").filter((l) => l && !l.includes('"type":"result"') && !l.startsWith('{"is_error"')).join("\n");
  assert.equal(JSON.parse(noResult.split("\n")[0]).type, "assistant");
  const e = efficiency(noResult);
  assert.equal(e.tokens.outputSource, "stub");
  assert.ok(e.tokens.output > 0, "the number stays in the JSON");
  assert.match(formatEfficiency("9", e), /output +n\/a \(run has no result event yet\)/);
  assert.equal(efficiency(stream).tokens.outputSource, "result");
  assert.equal(efficiency(transcript).tokens.outputSource, "transcript");
});

test("formatEfficiency: with reported thinking, the unattributed remainder is printed", () => {
  const e = efficiency(stream);
  const t = e.tokens;
  const rest = t.output - t.outputEstimate.thinking - t.outputEstimate.text - t.outputEstimate.toolInput;
  assert.match(formatEfficiency("19", e), new RegExp(`unattributed ~${(rest / 1000).toFixed(1)}k`));
});

test("efficiency: sub-agent turns on a stream log are not this lane's turns", () => {
  // Two main-thread messages (one tool call each) and one sub-agent message
  // (two tool calls) that stream-json marks with parent_tool_use_id.
  const e = efficiency(stream);
  assert.equal(e.turns, 2);
  assert.equal(e.toolCalls, 2);
});

test("afk stats: --json=1 and --efficiency=x are honoured, not ignored", () => {
  const json = spawnSync(process.execPath, [afk, "stats", "--json=1", fixture], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout)[0].turns, 5);
  const text = spawnSync(process.execPath, [afk, "stats", "--efficiency=x", fixture], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /efficiency\n +turns +5/);
});

test("afk stats --efficiency on a task with no stream log names the fix", () => {
  const cwd = mkdtempSync(join(tmpdir(), "afk-stats-"));
  const text = spawnSync(process.execPath, [afk, "stats", "--efficiency", "77"], { encoding: "utf8", cwd });
  assert.equal(text.stdout.trim(), "77: no stream log; pass the session transcript path, or check .afk/archive");
  const json = spawnSync(process.execPath, [afk, "stats", "--json", "77"], { encoding: "utf8", cwd });
  const [report] = JSON.parse(json.stdout);
  assert.equal(report.error, "no stream log; pass the session transcript path, or check .afk/archive");
});

test("afk stats --efficiency names an archived stream log when one exists", () => {
  const cwd = mkdtempSync(join(tmpdir(), "afk-stats-"));
  const dir = join(cwd, ".afk/archive/epic-9/verifier/9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stream.jsonl"), stream);
  const text = spawnSync(process.execPath, [afk, "stats", "--efficiency", "9"], { encoding: "utf8", cwd });
  assert.match(text.stdout, /^9: no stream log;.*\.afk\/archive\/epic-9\/verifier\/9\/stream\.jsonl/);
});

// Lane exploration metrics: did the lane read docs/CODE-MAP.md, and what did it
// spend finding its way around before its first edit.

const usage = (input, output, read = 0, write = 0) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const assistant = (id, blocks, u) =>
  JSON.stringify({ type: "assistant", message: { id, usage: u, content: blocks } });
const tool = (name, input) => ({ type: "tool_use", id: `${name}-${JSON.stringify(input)}`, name, input });

// A stream-json lane: reads the code map, explores, asks graphify, then edits.
const LANE = [
  JSON.stringify({ type: "system", subtype: "init" }),
  assistant("m1", [tool("Read", { file_path: "/wt/docs/CODE-MAP.md" })], usage(100, 10, 1000, 500)),
  assistant("m2", [tool("Bash", { command: "ls src && grep -rn foo src" })], usage(50, 5, 2000)),
  assistant("m3", [tool("Bash", { command: "graphify explain \"Foo()\"" })], usage(20, 2, 3000)),
  assistant("m4", [tool("Grep", { pattern: "bar" }), tool("Bash", { command: "npm test" })], usage(10, 1, 4000)),
  assistant("m5", [tool("Edit", { file_path: "src/a.ts" })], usage(10, 50, 5000)),
  assistant("m6", [tool("Bash", { command: "cat docs/CODE-MAP.md" })], usage(10, 5, 6000)),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1 }),
].join("\n");

test("lane metrics: code-map read, pre-edit spend split by tool family, totals", () => {
  const m = laneMetrics(LANE);
  assert.equal(m.readCodeMap, true);
  assert.equal(m.edited, true);
  assert.deepEqual(m.beforeFirstEdit, {
    tokens: 1610 + 2055 + 3022 + 4011,
    contextGrowth: 4010 - 1600,
    toolCalls: 5,
    explore: { tokens: 1610 + 2055 + 4011, toolCalls: 3 },
    graphify: { tokens: 3022, toolCalls: 1 },
    other: { tokens: 0, toolCalls: 1 },
  });
  assert.equal(m.inputTokens, 1600 + 2050 + 3020 + 4010 + 5010 + 6010);
  assert.equal(m.cachedInputTokens, 21000);
  assert.equal(m.outputTokens, 73);
  assert.match(formatLane(m), /code map read \| before first edit: 10\.7k tok billed, context \+2\.4k, 5 calls \(explore 7\.7k\/3, graphify 3\.0k\/1/);
});

test("a lane that only mentions the code map, or greps for it, did not read it", () => {
  const m = laneMetrics([
    JSON.stringify({ type: "user", message: { content: "Read docs/CODE-MAP.md first." } }),
    assistant("a", [{ type: "text", text: "I'll skip docs/CODE-MAP.md" }, tool("Bash", { command: "grep -n x docs/CODE-MAP.md.bak" })], usage(1, 1)),
    assistant("b", [tool("Read", { file_path: "docs/CODE-MAP.mdx" })], usage(1, 1)),
  ].join("\n"));
  assert.equal(m.readCodeMap, false);
  assert.equal(m.edited, false);
  assert.match(formatLane(m), /code map not read \| before first edit \(no edit\)/);
});

// A session transcript writes one line per content block, each repeating the
// message's usage: counted once, and charged to the message's tool call.
test("a message split over transcript lines is counted once and charged to its tool", () => {
  const u = usage(100, 10);
  const m = laneMetrics([
    assistant("x", [{ type: "text", text: "Looking around." }], u),
    assistant("x", [tool("Bash", { command: "cd /wt\nfind . -name '*.ts'" })], u),
    assistant("y", [tool("Write", { file_path: "a" })], u),
  ].join("\n"));
  assert.deepEqual(m.beforeFirstEdit.explore, { tokens: 110, toolCalls: 1 });
  assert.equal(m.beforeFirstEdit.other.tokens, 0);
  assert.equal(m.inputTokens, 200);
});

// Codex: commands arrive wrapped in a login shell, edits as `file_change`.
test("a Codex lane's wrapped commands are classified and its file_change is the first edit", () => {
  const item = (id, type, extra) => JSON.stringify({ type: "item.started", item: { id, type, ...extra } });
  const m = laneMetrics([
    item("i1", "command_execution", { command: `/bin/zsh -lc "sed -n '1,260p' docs/CODE-MAP.md"` }),
    item("i2", "command_execution", { command: "/bin/zsh -lc 'graphify path A B'" }),
    item("i3", "file_change", { changes: [] }),
    item("i4", "command_execution", { command: "/bin/zsh -lc 'ls'" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 70 } }),
  ].join("\n"));
  assert.equal(m.readCodeMap, true);
  assert.equal(m.edited, true);
  assert.equal(m.beforeFirstEdit.explore.toolCalls, 1);
  assert.equal(m.beforeFirstEdit.graphify.toolCalls, 1);
  assert.equal(m.inputTokens, 900);
});
