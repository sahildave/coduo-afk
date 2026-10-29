// The place a human learns a task is gated is `afk status`, and until now it was
// the one place that would not tell them how to ungate it: `pending (gated)` and
// nothing else, with the release verb several screens down in `afk help`. The
// runner holds every value the command needs, so a placeholder is not an option
// — these tests pin the literal `afk epic 296 --task=260`.
//
// The third test is the one that keeps the other two honest. `scripts/status.mjs`
// used to be a top-level script that read `.afk/state.json` and printed at import
// time, so there was nothing to call; if the extraction ever regresses, importing
// the module talks and this test says so.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { gatedReleaseLines } from "./status.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const GATED = {
  dag: {
    epic: { id: 296 },
    tasks: [{ id: 260, title: "provision the API key", dependsOn: [], humanGated: true }],
  },
  tasks: {},
};

test("a gated row prints its release command", () => {
  const lines = gatedReleaseLines(GATED);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /260 is human-gated/);
  assert.ok(
    lines.some((line) => line.includes("afk epic 296 --task=260")),
    `no release command in ${JSON.stringify(lines)}`,
  );
});

test("an ungated run prints no release command", () => {
  assert.deepEqual(
    gatedReleaseLines({
      dag: { epic: { id: 296 }, tasks: [{ id: 260, title: "build it", dependsOn: [] }] },
      tasks: {},
    }),
    [],
  );
  // A gated task whose dependencies have not passed is not ready, and a command
  // that would be refused is worse than no command.
  assert.deepEqual(
    gatedReleaseLines({
      dag: {
        epic: { id: 296 },
        tasks: [
          { id: 259, title: "first", dependsOn: [] },
          { id: 260, title: "second", dependsOn: [259], humanGated: true },
        ],
      },
      tasks: {},
    }),
    [],
  );
  assert.deepEqual(gatedReleaseLines({}), []);
});

test("importing status runs nothing", () => {
  // A child process, because this file has already imported the module: an
  // in-process re-import is served from the cache and would prove nothing.
  const status = resolve(here, "status.mjs");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(status)});`],
    { encoding: "utf8", cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(out, "");
});

// #292: one routing row per task — preferred backend/model, the backend/model
// the latest attempt ACTUALLY ran on (after a fallback too), and why.
test("afk status prints a builder routing row per task with preferred and actual model", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-status-routing-"));
  try {
    mkdirSync(join(dir, ".afk"));
    writeFileSync(join(dir, ".afk", "state.json"), JSON.stringify({
      dag: { tasks: [
        { id: "401", title: "codex task", dependsOn: [] },
        { id: "402", title: "claude task", dependsOn: [] },
      ] },
      builderRouting: { assignments: {
        401: { preferredBackend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", reason: "bounded edit" },
        402: { preferredBackend: "claude", model: "claude-opus-5-5", reason: "default" },
      } },
      tasks: {
        401: { lifecycle: "running", builderRuns: [
          { attempt: 1, dispatch: 1, backend: "codex", model: "gpt-5.6-luna", reason: "bounded edit", outcome: "rate_limited" },
          { attempt: 2, dispatch: 2, backend: "claude", model: "claude-opus-5-5", reason: "Codex reported its usage limit exhausted; retried on Claude Opus", outcome: null },
        ] },
        402: { lifecycle: "passed", builderRuns: [
          { attempt: 1, dispatch: 1, backend: "claude", model: "claude-opus-5-5", reason: "default", outcome: "ready_to_integrate" },
        ] },
      },
    }));
    const out = execFileSync(process.execPath, [resolve(here, "status.mjs")], { cwd: dir, encoding: "utf8" });
    assert.match(out, /#401: codex\/gpt-5\.6-luna → claude\/claude-opus-5-5 · Codex reported its usage limit exhausted; retried on Claude Opus/);
    assert.match(out, /#402: claude\/claude-opus-5-5 → claude\/claude-opus-5-5 · default/);
    // #295: an escalated task shows every attempt, not only the last one.
    assert.match(out, /#401: .* · attempts codex\/gpt-5\.6-luna \(rate_limited\), claude\/claude-opus-5-5\n/);
    assert.doesNotMatch(out, /#402: .*attempts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #294: the tier, the Jev answers that decided it and the Jev version per task,
// "router skipped: <reason>" for a ticket that fell back, and a run with no key
// says once why the router was skipped.
const statusOf = (state) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-status-tiers-"));
  try {
    mkdirSync(join(dir, ".afk"));
    writeFileSync(join(dir, ".afk", "state.json"), JSON.stringify(state));
    return execFileSync(process.execPath, [resolve(here, "status.mjs")], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("afk status shows tier, deciding answers and Jev version per task", () => {
  const answers = { sensitive: 0.88, format: 0.1, shared_interface: 0.1, unknown_cause: 0.1, pattern_named: 0.9, concrete_criteria: 0.9, scope: 1, scopeConfidence: 0.7 };
  const out = statusOf({
    dag: { tasks: [{ id: "501", title: "a", dependsOn: [] }, { id: "502", title: "b", dependsOn: [] }, { id: "503", title: "c", dependsOn: [] }] },
    builderRouting: { assignments: {
      501: { tier: "critical", reason: "critical: sensitive 0.88, scope 1 (confidence 0.70)", routerSkipped: null, jev: { model: "jev-1.14.2", answers, deciding: ["sensitive"] } },
      502: { tier: "routine", reason: "routine: pattern_named 0.90, concrete_criteria 0.90, scope 1 (confidence 0.70)", routerSkipped: null, jev: { model: "jev-1.14.2", answers: { ...answers, sensitive: 0.1 }, deciding: ["pattern_named", "concrete_criteria"] } },
      503: { tier: "critical", reason: "router skipped: Jev answered 529 (overloaded)", routerSkipped: "Jev answered 529 (overloaded)", jev: null },
    } },
    tasks: {
      501: { lifecycle: "running", builderRuns: [{ attempt: 1, backend: "claude", model: "claude-opus-5-5", tier: "critical", reason: "critical: sensitive 0.88, scope 1 (confidence 0.70)", outcome: null }] },
      502: { lifecycle: "running", builderRuns: [{ attempt: 1, backend: "codex", model: "gpt-6.1-sol", tier: "routine", reason: "routine: codex has the most quota (70%)", outcome: null }] },
    },
  });
  assert.match(out, /#501: critical tier → claude\/claude-opus-5-5 · .* · tier critical · sensitive 0\.88, scope 1 \(confidence 0\.70\) · jev jev-1\.14\.2/);
  assert.match(out, /#502: routine tier → codex\/gpt-6\.1-sol · routine: codex has the most quota \(70%\) · tier routine · pattern_named 0\.90, concrete_criteria 0\.90, scope 1 \(confidence 0\.70\) · jev jev-1\.14\.2/);
  assert.match(out, /#503: critical tier → - · router skipped: Jev answered 529 \(overloaded\) · tier critical/);
});

test("afk status says once why the router was skipped when the run had no key", () => {
  const out = statusOf({
    dag: { tasks: [{ id: "501", title: "a", dependsOn: [] }, { id: "502", title: "b", dependsOn: [] }] },
    builderRouting: { assignments: {}, skipped: { reason: "no TYPESAFE_API_KEY in the runner's environment" } },
    tasks: {
      501: { lifecycle: "running", builderRuns: [{ attempt: 1, backend: "claude", model: "claude-opus-5-5", reason: null, outcome: null }] },
      502: { lifecycle: "running", builderRuns: [{ attempt: 1, backend: "claude", model: "claude-opus-5-5", reason: null, outcome: null }] },
    },
  });
  assert.equal(out.match(/router skipped/g)?.length, 1, out);
  assert.match(out, /tier router skipped: no TYPESAFE_API_KEY in the runner's environment/);
  assert.match(out, /#501: - → claude\/claude-opus-5-5 · - · tier critical/);
});
