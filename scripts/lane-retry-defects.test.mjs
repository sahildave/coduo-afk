// scripts/lane-retry-defects.test.mjs — #215: a lane that fails its own check
// and is fixed by the builder's retry found a real defect, and owes a lesson
// the same as one the post-merge check or the closeout fixer catches.
//
// Drives the retry end to end: attempt 1 red on its own check, attempt 2 green,
// a merge, and a closeout and PR body that list the defect. The retried
// builder is asked for a lesson; one that gives none shows `Lesson: missing`.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { renderCloseout, runAuto } from "./auto.mjs";
import { laneDefectCheck, lessonFromReport } from "./defects.mjs";
import { freePort } from "./free-port.mjs";
import { renderPrBody } from "./pr.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";

process.setMaxListeners(60);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-lane-defects-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

const CHECK = "npm test";
const TASK = { id: "600", title: "Lane", dependsOn: [], body: "" };
const DAG = { branch: "main", tasks: [TASK] };

const makeRepo = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-lane-defects-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const before = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(base, "lanes");
  t.after(() => {
    if (before === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  return repo;
};

const runIn = async (repo, args) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await runAuto({ config: readConfig(repo), root: repo, interactive: false, ...args });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

// Attempt 1 fails its own check on the code; attempt 2 passes it, with `lesson`.
const builderWith = (firstOutput, lesson) => async ({ worktree, attempt }) => {
  if (attempt === 1)
    return { outcome: "failed", verification: { attempt, checks: [{ command: CHECK, code: 1, output: firstOutput }] } };
  writeFileSync(join(worktree, "lane.txt"), "lane\n");
  git(worktree, "add", "lane.txt");
  git(worktree, "commit", "-qm", "lane");
  return {
    outcome: "ready_to_integrate",
    commitSha: git(worktree, "rev-parse", "HEAD"),
    verification: { attempt, checks: [{ command: CHECK, code: 0 }], ...(lesson ? { lesson } : {}) },
  };
};

const integrate = async ({ root, task, branch, attempt, onPid }) => {
  const integrationBase = git(root, "rev-parse", "HEAD");
  onPid(null, integrationBase);
  git(root, "merge", "--no-ff", "-q", "-m", `Merge task ${task.id}`, branch);
  return {
    outcome: "passed", integrationBase, head: git(root, "rev-parse", "HEAD"),
    verification: { taskId: task.id, attempt, branch, passed: true, checks: [], checkReruns: [] },
  };
};

const stateOf = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
const logOf = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
const RED = "AssertionError [ERR_ASSERTION]: expected 2, got 3";

test("a lane red on its own check and fixed by the retry is a defect that owes a lesson (#215)", async (t) => {
  const repo = makeRepo(t);
  await runIn(repo, { dag: DAG, explicitTaskId: "600", builder: builderWith(RED, null), integrate });
  const state = stateOf(repo);
  assert.equal(state.tasks[600].lifecycle, "passed", logOf(repo));
  assert.deepEqual(state.midRunDefects.map((d) => [d.taskId, d.source, d.command, d.failedAttempt, d.fixedAttempt, d.lesson]),
    [["600", "lane", CHECK, 1, 2, null]]);
  const closeout = renderCloseout(DAG, state, null, null);
  assert.match(closeout, /## Defects found mid-run/);
  assert.match(closeout, /\*\*600\*\* — lane check `npm test` failed on attempt 1; fixed by the builder's retry \(attempt 2\)\n {2}Lesson: missing/);
  assert.match(renderPrBody({ dag: DAG, state, renderedAt: "now" }), /\*\*600\*\*[\s\S]*Lesson: missing/);
});

test("the retried builder's lesson rides its report into the closeout (#215)", async (t) => {
  const repo = makeRepo(t);
  const lesson = { class: "standard", line: "Count fixtures from the manifest, never by hand." };
  await runIn(repo, { dag: DAG, explicitTaskId: "600", builder: builderWith(RED, lesson), integrate });
  const state = stateOf(repo);
  assert.deepEqual(state.midRunDefects[0].lesson, lesson);
  assert.doesNotMatch(renderCloseout(DAG, state, null, null), /Lesson: missing/);
});

test("an environment-classed lane red is no defect, even when the retry passes (#215)", async (t) => {
  const repo = makeRepo(t);
  const env = "Error: listen EADDRINUSE: address already in use :::3000";
  await runIn(repo, { dag: DAG, explicitTaskId: "600", builder: builderWith(env, null), integrate });
  const state = stateOf(repo);
  assert.equal(state.tasks[600].lifecycle, "passed", logOf(repo));
  assert.deepEqual(state.midRunDefects ?? [], []);
});

test("infra failures and agent deaths with no red check are no lane defect (#215)", () => {
  assert.equal(laneDefectCheck({ checks: [] }), null);
  assert.equal(laneDefectCheck({ authFailure: true, checks: [{ command: CHECK, code: 1, output: RED }] }), null);
  assert.equal(laneDefectCheck({ checks: [{ command: CHECK, code: 1, output: "No valid login session found" }] }), null);
  assert.equal(laneDefectCheck({ checks: [{ command: CHECK, skipped: true, code: null }] }), null);
  assert.equal(laneDefectCheck({ checks: [{ command: CHECK, code: 1, output: RED }] }).command, CHECK);
});

test("a builder report's LESSON line is read through the fixer's lesson shapes (#215)", () => {
  assert.deepEqual(lessonFromReport("Done.\nLESSON: rule:no-x:lint/no-x.mjs:lint/red/x.ts\n"),
    { class: "rule", id: "no-x", file: "lint/no-x.mjs", redOn: "lint/red/x.ts" });
  assert.deepEqual(lessonFromReport('LESSON: none:"a typo, nothing a rule would catch"'), { class: "none", reason: "a typo, nothing a rule would catch" });
  assert.equal(lessonFromReport("LESSON: rule:only-an-id"), null);
  assert.equal(lessonFromReport("no lesson here"), null);
});

test("a held lane red never outlives its run: reset and attempt-resetting paths drop it (#215)", async () => {
  const { recordLaneDefect } = await import("./defects.mjs");
  const { clearTaskRuntime } = await import("./scheduler.mjs");
  const state = { tasks: { 7: { builderAttempt: 2, laneDefect: { command: CHECK, failedAttempt: 1 } } } };
  clearTaskRuntime(state, "7");
  assert.equal(state.tasks[7].laneDefect, undefined);
  // An infra path reset the attempts to 0; the next pass is attempt 1, not a retry.
  const runtime = { laneDefect: { command: CHECK, failedAttempt: 1 } };
  assert.equal(recordLaneDefect(state, { taskId: "7", taskRuntime: runtime, verification: {}, attempt: 1 }), null);
  assert.equal(runtime.laneDefect, undefined);
  assert.deepEqual(state.midRunDefects ?? [], []);
});

test("the retry's lesson is read across every session, so a checklist continuation does not hide it (#215)", async () => {
  const { retryLesson } = await import("./worker.mjs");
  const report = "Fixed it.\nLESSON: standard:\"Count fixtures from the manifest.\"";
  assert.deepEqual(retryLesson(2, [report, "Done."]), { class: "standard", line: "Count fixtures from the manifest." });
  assert.equal(retryLesson(1, [report]), null, "attempt 1 was never asked");
});

test("both Infisical detectors agree on `npm run infisical` gates (#210, #214)", async () => {
  const { usesInfisicalRun } = await import("./infisical.mjs");
  const { usesInfisical } = await import("./scheduler.mjs");
  for (const command of ["infisical run -- npm test", "npm run infisical -- -- npx vitest run", "npm run infisical", "npm run infisical:sync", "npm test"])
    assert.equal(usesInfisicalRun({ defaultChecks: [command] }), usesInfisical({ defaultChecks: [command] }), command);
});
