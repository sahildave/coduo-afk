// scripts/usage.test.mjs — token usage and cost from Claude Code transcripts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTranscriptsRoot, claudeCodeWeek, collectUsage, costOf, kindOf, normaliseProject, placeOf, priceOf, roleOf, usageInsights, usageReport } from "./usage.mjs";

const usage = (n) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n, cache_creation: { ephemeral_1h_input_tokens: n, ephemeral_5m_input_tokens: 0 } });
const line = (row) => JSON.stringify(row);

const root = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("roleOf names each runner prompt by its opening and leaves anything else unknown", () => {
  assert.deepEqual(roleOf('<pasted_content id="x">\nRead the file /a/.afk-claude/epics/E-7/repo/.afk/runs/12/integration-2/prompt.md and execute'),
    { role: "integration", taskId: "12", attempt: 2, promptRoot: "/a/.afk-claude/epics/E-7/repo" });
  assert.equal(roleOf("You are the plan-reviewer for an automated").role, "plan-review");
  assert.equal(roleOf("You are the fixer for one completed AFK epic.").role, "fixer");
  assert.equal(roleOf("You are writing the reflection for one AFK epic").role, "reflect");
  assert.equal(roleOf("Reply with the single word: OK").role, "preflight");
  assert.equal(roleOf("You are a design-conformance checker.").role, "unknown");
  assert.equal(roleOf(null).role, "unknown");
});

test("placeOf reads project and epic from an epic checkout or a worktree cwd", () => {
  assert.deepEqual(placeOf("/Users/x/.afk-claude/epics/Users-x-code-projects-atlas-workspace-841/atlas-workspace/.afk/reflect/841/workspace"), { project: "atlas-workspace", epicId: "841" });
  assert.deepEqual(placeOf("/Users/x/.afk-claude/worktrees/Users-x-afk-claude-epics-Users-x-code-projects-atlas-workspace-841-atlas-workspace/role-cwd-verify-841"), { project: "atlas-workspace", epicId: "841" });
  assert.deepEqual(placeOf("/Users/x/.afk-claude/worktrees/Users-x-afk-claude-epics-Users-x-code-projects-quillnote-wave-34-quillnote/3/quillnote"), { project: "quillnote", epicId: "wave-34" });
});

test("prices: dated ids resolve, unknown models are unpriced, 1h cache writes cost 2x input", () => {
  assert.equal(priceOf("claude-haiku-4-5-20251001"), priceOf("claude-haiku-4-5"));
  assert.equal(priceOf("gpt-5"), null);
  assert.equal(costOf("gpt-5", { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 }), null);
  const m = 1e6;
  assert.equal(costOf("claude-opus-5-5", { input: m, output: m, cacheRead: m, cacheWrite5m: m, cacheWrite1h: m }), 4 + 20 + 0.2 + 5 + 8);
  assert.equal(costOf("claude-sonnet-5-5", { input: m, output: m, cacheRead: m, cacheWrite5m: 0, cacheWrite1h: 0 }), 2 + 10 + 0.1);
});

test("collectUsage dedupes repeated message lines, inherits role into subagents, and filters by month", (t) => {
  const dir = root(t);
  const folder = join(dir, "-Users-x--afk-claude-epics-Users-x-code-projects-repo-5-repo");
  mkdirSync(join(folder, "s1", "subagents"), { recursive: true });
  const cwd = "/Users/x/.afk-claude/epics/Users-x-code-projects-repo-5/repo";
  writeFileSync(join(folder, "s1.jsonl"), [
    line({ type: "user", cwd, timestamp: "2026-09-30T23:00:00Z", message: { content: "You are the verifier for one completed AFK epic." } }),
    line({ type: "assistant", cwd, timestamp: "2026-09-30T23:01:00Z", message: { id: "old", model: "claude-opus-5-5", usage: usage(5) } }),
    line({ type: "assistant", cwd, timestamp: "2026-10-02T00:00:00Z", message: { id: "a", model: "claude-opus-5-5", usage: usage(1) } }),
    line({ type: "assistant", cwd, timestamp: "2026-10-02T00:00:01Z", message: { id: "a", model: "claude-opus-5-5", usage: usage(1) } }),
  ].join("\n"));
  writeFileSync(join(folder, "s1", "subagents", "agent-1.jsonl"), [
    line({ type: "user", cwd, timestamp: "2026-10-02T00:00:02Z", message: { content: "Explore the repo" } }),
    line({ type: "assistant", cwd, timestamp: "2026-10-02T00:00:03Z", message: { id: "b", model: "claude-haiku-4-5", usage: usage(2) } }),
  ].join("\n"));
  // Not an AFK folder: ignored.
  mkdirSync(join(dir, "-Users-x-code-other"));
  writeFileSync(join(dir, "-Users-x-code-other", "z.jsonl"), line({ type: "assistant", message: { id: "z", model: "claude-opus-5-5", usage: usage(9) } }));

  const all = collectUsage({ root: dir });
  assert.deepEqual(all.map((r) => [r.role, r.model, r.messages, r.input, r.subagent, r.project, r.epicId]).sort(), [
    ["verifier", "claude-haiku-4-5", 1, 2, true, "repo", "5"],
    ["verifier", "claude-opus-5-5", 2, 6, false, "repo", "5"],
  ]);
  const report = usageReport({ root: dir, month: true, now: new Date("2026-10-09T00:00:00Z") });
  assert.equal(report.total.messages, 2);
  assert.deepEqual(report.byRole.map((g) => g.key), ["verifier"]);
  assert.equal(report.budgetUsd, 200);
});

const row = (o) => ({ role: "builder", taskId: "1", attempt: 1, project: "repo", epicId: "5", costUsd: 1, ...o });

test("normaliseProject folds Lumina folders and sends junk keys to other", () => {
  assert.equal(normaliseProject("Lumina-futari-v2-pre-boards"), "Lumina");
  assert.equal(normaliseProject("Users-owner-code-projects-Lumina-futari-v2-pre-boards"), "Lumina");
  for (const junk of ["44504cf7147d", "21", ".afk", "unknown", "wave-throwaway", "wave-fail", "role-cwd-verify-23"]) assert.equal(normaliseProject(junk), "other", junk);
  assert.equal(normaliseProject("afk-claude"), "afk-claude");
  assert.equal(kindOf("Lumina"), "ui");
  assert.equal(kindOf("afk-claude"), "non-ui");
  assert.equal(kindOf("wave-run"), "unclassified");
});

test("usageInsights: lane median/p90, verdicts, small roles and greedy packing", () => {
  const rows = [
    // three afk-claude builder lanes: 2, 4, 10 (the 10 spans two models)
    row({ project: "afk-claude", taskId: "1", costUsd: 2 }),
    row({ project: "afk-claude", taskId: "2", costUsd: 4 }),
    row({ project: "afk-claude", taskId: "3", costUsd: 6 }), row({ project: "afk-claude", taskId: "3", costUsd: 4 }),
    row({ project: "Lumina-afk", role: "integration", taskId: "9", costUsd: 3 }),
    row({ project: "atlas-workspace", costUsd: 250 }),
    row({ project: "harbour", costUsd: 230 }),
    row({ project: "21", role: "unknown", taskId: null, costUsd: 1 }),
    row({ project: "atlas-workspace", role: "verifier", taskId: null, costUsd: 150 }),
    row({ project: "atlas-workspace", role: "preflight", taskId: null, costUsd: 5 }),
    row({ project: "atlas-workspace", role: "fixer", taskId: null, costUsd: 30 }),
  ];
  const weekRows = [row({ project: "afk-claude", costUsd: 10 }), row({ project: "x", role: "preflight", taskId: null, costUsd: 5 })];
  const r = usageInsights({ rows, weekRows, week: { costUsd: 100 }, budget: 200, now: new Date("2026-10-09T00:00:00Z") });

  const afk = r.builderLanes.find((l) => l.project === "afk-claude");
  assert.deepEqual([afk.lanes, afk.medianUsd, afk.lanesPerBudget], [3, 4, 50]);
  assert.equal(afk.p90Usd, 4 + (10 - 4) * 0.8);
  assert.deepEqual(r.integrationLanes.map((l) => [l.project, l.lanes, l.medianUsd]), [["Lumina", 1, 3]]);

  const verdict = Object.fromEntries(r.byProject.map((p) => [p.project, p.verdict]));
  assert.deepEqual(verdict, { "atlas-workspace": "does-not-fit", harbour: "borderline", "afk-claude": "fits", Lumina: "fits", other: "fits" });
  assert.equal(r.byProject.find((p) => p.project === "afk-claude").weekShare, 0.1);

  assert.equal(r.nonUi.smallRoles.costUsd, 3 + 150 + 5 + 30);
  assert.equal(r.nonUi.smallRoles.weekShare, 0.05);
  // cheapest first: preflight 5, integration 3 -> 3, 5, fixer 30, verifier 150 (=188), then afk builders 16 overflows.
  assert.deepEqual(r.recommendation.packed.map((i) => i.id), ["role:integration", "role:preflight", "role:fixer", "role:verifier"]);
  assert.deepEqual(r.recommendation.skipped.map((i) => i.id), ["builders:afk-claude"]);
  assert.equal(r.recommendation.leftUsd, 12);
  assert.equal(r.recommendation.weekShare, 0.05);
});

test("claudeCodeWeek scans every project folder and subagents, dedupes ids, and keeps the last 7 days", (t) => {
  const dir = root(t);
  mkdirSync(join(dir, "-Users-x-code-a", "s", "subagents"), { recursive: true });
  mkdirSync(join(dir, "-Users-x-code-b"));
  const m = (id, ts, n = 1e6) => line({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(dir, "-Users-x-code-a", "s.jsonl"), [m("a", "2026-10-08T00:00:00Z"), m("a", "2026-10-08T00:00:00Z"), m("old", "2026-09-20T00:00:00Z")].join("\n"));
  writeFileSync(join(dir, "-Users-x-code-a", "s", "subagents", "x.jsonl"), m("b", "2026-10-07T00:00:00Z"));
  writeFileSync(join(dir, "-Users-x-code-b", "t.jsonl"), [m("a", "2026-10-08T00:00:00Z"), m("c", "2026-10-06T00:00:00Z")].join("\n"));
  const w = claudeCodeWeek({ root: dir, now: Date.parse("2026-10-09T00:00:00Z") });
  assert.equal(w.messages, 3);
  assert.equal(w.tokens.output, 3e6);
  assert.equal(w.costUsd, 60);
});

test("allTranscriptsRoot falls back to the pinned AFK root so tests never read real data", () => {
  const saved = { a: process.env.AFK_ALL_TRANSCRIPTS_ROOT, t: process.env.AFK_TRANSCRIPTS_ROOT };
  delete process.env.AFK_ALL_TRANSCRIPTS_ROOT;
  process.env.AFK_TRANSCRIPTS_ROOT = "/tmp/pinned";
  assert.equal(allTranscriptsRoot(), "/tmp/pinned");
  process.env.AFK_ALL_TRANSCRIPTS_ROOT = "/tmp/all";
  assert.equal(allTranscriptsRoot(), "/tmp/all");
  for (const [k, v] of [["AFK_ALL_TRANSCRIPTS_ROOT", saved.a], ["AFK_TRANSCRIPTS_ROOT", saved.t]]) if (v == null) delete process.env[k]; else process.env[k] = v;
});

test("collectUsage counts AFK sessions outside epic folders by their opening, preflight included, and skips interactive ones", (t) => {
  const dir = root(t);
  const at = "2026-10-07T10:00:00Z";
  const put = (folder, name, text, cwd, id) => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, `${name}.jsonl`), [
      line({ type: "user", cwd, timestamp: at, message: { content: text } }),
      line({ type: "assistant", cwd, timestamp: at, message: { id, model: "claude-opus-5-5", usage: usage(1) } }),
    ].join("\n"));
  };
  put("-Users-x-code-projects-riverbend", "pr", "You are the plan-reviewer for an automated parallel task runner.", "/Users/x/code/projects/riverbend", "p");
  put("-Users-x-code-projects-riverbend", "me", "Help me plan the next epic", "/Users/x/code/projects/riverbend", "i");
  put("-private-var-folders-ab-T-afk-merge-Q1", "m", "You are a fresh merger agent integrating exactly ONE completed task into main.\n\nTask ID: 300\n", "/private/var/folders/ab/T/afk-merge-Q1", "m");
  put("-private-var-folders-ab-T-afk-merge-Q1", "ok", "Reply with the single word: OK", "/private/var/folders/ab/T/afk-merge-Q1", "o");
  const rows = collectUsage({ root: dir });
  assert.deepEqual(rows.map((r) => [r.role, r.project, r.taskId]).sort(), [
    ["integration", "unknown", "300"],
    ["plan-review", "riverbend", null],
    ["preflight", "unknown", null],
  ]);
});

test("collectUsage spend buckets are null when a message in them is unpriced, and spendOf carries the null forward (#273 allKnown)", async (t) => {
  const dir = root(t);
  const folder = join(dir, "-Users-x--afk-claude-epics-Users-x-code-projects-repo-5-repo");
  mkdirSync(folder, { recursive: true });
  const cwd = "/Users/x/.afk-claude/epics/Users-x-code-projects-repo-5/repo";
  const out = (n) => ({ input_tokens: 0, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  writeFileSync(join(folder, "s1.jsonl"), [
    line({ type: "user", cwd, timestamp: "2026-10-02T00:00:00Z", message: { content: "You are the verifier for one completed AFK epic." } }),
    line({ type: "assistant", cwd, timestamp: "2026-10-02T00:10:00Z", message: { id: "a", model: "claude-opus-5-5", usage: out(1_000_000) } }),
    line({ type: "assistant", cwd, timestamp: "2026-10-02T00:40:00Z", message: { id: "b", model: "gpt-5", usage: out(1_000_000) } }),
  ].join("\n"));
  const step = 30 * 60_000;
  const rows = collectUsage({ root: dir, bucketMs: step });
  const bucketsOf = (model) => rows.find((r) => r.model === model).buckets;
  assert.deepEqual(bucketsOf("claude-opus-5-5"), { [Date.parse("2026-10-02T00:00:00Z")]: 20 });
  assert.deepEqual(bucketsOf("gpt-5"), { [Date.parse("2026-10-02T00:30:00Z")]: null }, "an unpriced message is not 0 USD");
  const { spendOf } = await import("./hub/snapshot.mjs");
  const spend = spendOf(rows, { project: "repo", epic: "5" }, Date.parse("2026-10-02T00:00:00Z"), Date.parse("2026-10-02T01:00:00Z"));
  assert.deepEqual(spend.map((p) => p.usd), [0, 20, null], "the cumulative curve is unknown from the unpriced bucket on");
});
