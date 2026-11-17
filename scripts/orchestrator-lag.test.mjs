// scripts/orchestrator-lag.test.mjs — lane events against Orchestrator mentions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, lagReport, laneEvents, mentions } from "./orchestrator-lag.mjs";

const LOG = [
  "[2026-11-12T13:00:00.000Z] AUTO: builder 635 attempt 1 started.",
  "[2026-11-12T13:20:00.000Z] AUTO: builder 635 passed worktree checks and committed ba4bc203; queued for integration.",
  "[2026-11-12T13:30:00.000Z] AUTO: builder 636 failed; retrying with a fresh agent process.",
  "[2026-11-12T14:00:00.000Z] AUTO: integration 636 failed after 1 retry; branch/worktree retained.",
  "[2026-11-12T14:10:00.000Z] AUTO: builder 637: quota exhausted until Nov 13 09:00; not retrying.",
  "[2026-11-12T14:20:00.000Z] AUTO: 638 blocked because dependency 636 cannot pass.",
  "[2026-11-12T14:25:00.000Z] AUTO: integration 639 failed — check failed: pnpm run check; main restored, retrying with a fresh merger.",
  "[2026-11-12T14:26:00.000Z] AUTO: integration 640 failed — check failed: pnpm run check, again after it re-ran the failed check on the same merged tree; branch/worktree retained.",
  "[2026-11-12T14:30:00.000Z] AUTO: 639 integrated and passed post-merge verification; worktree removed and branch deleted.",
].join("\n");

const say = (at, content) => JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content } });

const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-orch-lag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const run = join(repo, ".afk", "archive", "epic-683");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "agent-auto.log"), LOG);
  const root = join(dir, "transcripts");
  const folder = join(root, repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "orch.jsonl"), [
    JSON.stringify({ type: "user", timestamp: "2026-11-12T12:45:00.000Z", message: { role: "user", content: "/coduo-afk check #683 --base=main\nYou are the Orchestrator for this epic." } }),
    say("2026-11-12T12:50:00.000Z", [{ type: "text", text: "Lanes 635 to 639 queued; #636 starts first." }]),
    say("2026-11-12T13:24:00.000Z", [{ type: "text", text: "#635 committed, waiting on integration." }]),
    say("2026-11-12T14:05:00.000Z", [{ type: "tool_use", name: "Bash", input: { command: "afk status 636" } }, { type: "thinking", thinking: "636 failed" }]),
    say("2026-11-12T14:40:00.000Z", [{ type: "text", text: "Integration 636 failed after a retry." }]),
    say("2026-11-12T14:41:00.000Z", [{ type: "text", text: "639 merged." }]),
  ].join("\n"));
  // Not an Orchestrator: a session in the same folder that names every lane.
  writeFileSync(join(folder, "other.jsonl"), [
    JSON.stringify({ type: "user", timestamp: "2026-11-12T12:00:00.000Z", message: { role: "user", content: "fix the docs" } }),
    say("2026-11-12T14:15:00.000Z", [{ type: "text", text: "637 and 638 are stuck." }]),
  ].join("\n"));
  return { repo, root };
};

test("laneEvents keeps lane outcomes and drops retries and progress lines", () => {
  assert.deepEqual(laneEvents(LOG).map((e) => [e.task, e.kind]), [
    ["635", "committed"], ["636", "failed"], ["637", "quota"], ["638", "blocked"], ["640", "failed"], ["639", "merged"],
  ]);
});

test("mentions needs a word-bounded id, and # for a short id", () => {
  assert.ok(mentions("#635 done", "635"));
  assert.ok(mentions("lane 635, merged", "635"));
  assert.ok(!mentions("lane 6350 merged", "635"));
  assert.ok(!mentions("2 lanes running", "2"));
  assert.ok(mentions("#2 merged", "2"));
});

test("lag: in time, late, never, a mention before the event and a tool call do not count", (t) => {
  const { repo, root } = fixture(t);
  const [run] = lagReport({ repo, root, project: null });
  const byTask = Object.fromEntries(run.rows.map((r) => [r.task, r]));
  // In time: 4 minutes after the commit. The 12:50 mention predates it.
  assert.equal(byTask["635"].mentionedAt, "2026-11-12T13:24:00.000Z");
  assert.equal(byTask["635"].lagMin, 4);
  assert.equal(byTask["635"].missed, false);
  // Late: the 14:05 tool call and thinking name 636 but do not count; text at 14:40 is 40 min on.
  assert.equal(byTask["636"].lagMin, 40);
  assert.equal(byTask["636"].missed, true);
  // Never: only the non-Orchestrator session named 637 and 638.
  assert.equal(byTask["637"].mentionedAt, null);
  assert.equal(byTask["637"].missed, true);
  assert.equal(byTask["638"].missed, true);
  assert.equal(byTask["639"].lagMin, 11);
  assert.deepEqual([run.events, run.mentioned, run.missed, run.medianLagMin, run.runtime], [6, 2, 4, 11, null]);
  assert.match(formatReport([run]), /epic-683 \(#683\): 6 events, 2 mentioned within 15 min, 4 missed, median lag 11m, runtime null/);
});

test("no Orchestrator transcript: says so and measures nothing", (t) => {
  const { repo } = fixture(t);
  const [run] = lagReport({ repo, root: join(repo, "nowhere"), project: null });
  assert.equal(run.rows, null);
  assert.equal(run.missed, null);
  assert.match(formatReport([run]), /6 events; no Orchestrator transcript found for #683; lag not measured/);
});
