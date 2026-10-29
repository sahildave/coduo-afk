import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTerminalFailure, laneAgentStartArgs } from "./runtime-herdr.mjs";

const CODEX = {
  backend: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  sandbox: "workspace-write",
  approvalPolicy: "never",
};

test("the Herdr Codex launch carries native model, effort, sandbox and worktree arguments only", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-herdr-codex-"));
  try {
    const args = laneAgentStartArgs({
      name: "afk-204-1",
      pane: "w1:p1",
      agent: CODEX,
      launchDir: dir,
      cwd: "/tmp/lane-204",
      broker: ["--permission-prompt-tool", "mcp__afk_permission__decide"],
    });
    assert.deepEqual(args.slice(0, 7), ["agent", "start", "afk-204-1", "--kind", "codex", "--pane", "w1:p1"]);
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(args[args.indexOf("-c") + 1], "model_reasoning_effort=max");
    // An unattended lane must never stop at Codex's "Update available" prompt:
    // herdr reads it as blocked during startup and the attempt never runs (#295).
    const config = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
    assert.ok(config.includes("check_for_update_on_startup=false"), "the update prompt is off");
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(args[args.indexOf("--cd") + 1], "/tmp/lane-204");
    assert.equal(args.includes("--settings"), false);
    assert.equal(args.includes("--permission-prompt-tool"), false);
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #292 defect 3: only a message that NAMES a quota or usage limit is
// exhaustion. A bare 429 is a transient throttle ("rate-limit"), and quoted
// historical error text is nothing. Both the captured `codex exec --json`
// streams and interactive pane captures are read.
for (const [fixture, expected] of [
  ["rate-limit.jsonl", "quota"],
  ["auth-failure.jsonl", "auth"],
  ["bare-429.jsonl", "rate-limit"],
  ["quoted-history.jsonl", null],
  ["success.jsonl", null],
  ["herdr-quota-limit.txt", "quota"],
  ["herdr-auth-failure.txt", "auth"],
  ["herdr-bare-429.txt", "rate-limit"],
  ["herdr-quoted-history.txt", null],
]) {
  test(`Codex fixture ${fixture} classifies as ${expected ?? "no failure"}`, () => {
    const text = readFileSync(new URL(`./fixtures/codex/${fixture}`, import.meta.url), "utf8");
    const kind = codexTerminalFailure(text);
    assert.equal(kind, expected);
    if (expected !== "quota") assert.notEqual(kind, "quota", "not exhaustion");
    if (expected !== "auth") assert.notEqual(kind, "auth", "not an auth outcome");
  });
}

test("a transient Codex throttle is a rate limit, not exhaustion", () => {
  assert.equal(codexTerminalFailure("error: 429 Too Many Requests, retry in 2s"), "rate-limit");
  assert.equal(codexTerminalFailure("Too many requests"), "rate-limit");
  assert.equal(codexTerminalFailure("Error: You've hit your usage limit. Try again at Oct 2."), "quota");
});
