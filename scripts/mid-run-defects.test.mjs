// scripts/mid-run-defects.test.mjs — #215: a defect caught before the closeout
// is owed a lesson, the same as one the closeout fixer fixes.
//
// The incident: a lane statically imported a desktop-only module, only the
// post-merge `build:web` caught it, the fix came back through `afk salvage`,
// and nothing asked what rule would have caught it. This drives that run end
// to end: integration red twice on a check the lane never ran, a hand fix, a
// salvage that refuses without a lesson, a relaunch that merges, a closeout
// and a PR body that list the defect with its lesson.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { renderCloseout, runAuto } from "./auto.mjs";
import { recordIntegrationDefect, renderMidRunDefects } from "./defects.mjs";
import { freePort } from "./free-port.mjs";
import { renderPrBody } from "./pr.mjs";
import { salvageLane } from "./salvage.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import { taskBranch, taskWorktree } from "./worktree.mjs";

process.setMaxListeners(60);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-defects-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

// The lane runs LINT only; integration runs LINT and BUILD, and BUILD is red
// until the lane's file says `fixed` — the desktop-only import, in miniature.
const LINT = "true";
const BUILD = "grep -q fixed lane.txt";
const TASK = { id: "500", title: "Lane", dependsOn: [], body: "" };
const DAG = { branch: "main", tasks: [TASK] };

const makeRepo = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-defects-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeConfig(repo, { maxParallel: 1, defaultChecks: [LINT, BUILD], baselineChecks: [] });
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

// A builder whose own gate ran LINT and nothing else.
const builder = async ({ worktree }) => {
  writeFileSync(join(worktree, "lane.txt"), "lane\n");
  git(worktree, "add", "lane.txt");
  git(worktree, "commit", "-qm", "lane");
  return {
    outcome: "ready_to_integrate",
    commitSha: git(worktree, "rev-parse", "HEAD"),
    verification: { checks: [{ command: LINT, code: 0 }] },
  };
};

const stateOf = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
const logOf = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");

test("integration red twice, a salvage that owes a lesson, and a closeout that lists the defect (#215)", async (t) => {
  const repo = makeRepo(t);
  await runIn(repo, { dag: DAG, explicitTaskId: "500", builder });

  // Red twice on the same merged tree, so a real defect, owed a lesson.
  let state = stateOf(repo);
  assert.equal(state.tasks[500].lifecycle, "integration_failed", logOf(repo));
  assert.deepEqual(state.midRunDefects.map((d) => [d.taskId, d.source, d.command, d.laneRan, d.lesson]),
    [["500", "integration", BUILD, false, null]]);
  // The lane's own gate never ran the check that caught it, and the log says which.
  assert.ok(logOf(repo).includes(`lane checks lack \`${BUILD}\``), logOf(repo));
  // Mid-run, the PR body already shows the lesson as missing.
  assert.match(renderPrBody({ dag: DAG, state, renderedAt: "now" }), /## Defects found mid-run[\s\S]*\*\*500\*\*[\s\S]*Lesson: missing/);

  // The hand fix, committed on the lane branch.
  const worktree = taskWorktree(repo, "500");
  writeFileSync(join(worktree, "lane.txt"), "lane fixed\n");
  git(worktree, "commit", "-qam", "fix 500 by hand");
  const tip = git(repo, "rev-parse", taskBranch("500"));

  // No lesson, no salvage: refused with the fixer's three shapes, nothing changed.
  const before = readFileSync(join(repo, ".afk", "state.json"), "utf8");
  const refused = await salvageLane({ root: repo, id: "500", commit: tip, say: () => {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.message,
    'SALVAGE: a salvage needs a lesson: the defect this commit fixes either becomes a rule, a standard, or says why not. '
    + 'Pass --lesson=rule:<id>:<file>:<redOn>, --lesson=standard:"<line>" or --lesson=none:"<reason>".');
  assert.equal(readFileSync(join(repo, ".afk", "state.json"), "utf8"), before);

  const salvaged = await salvageLane({
    root: repo, id: "500", commit: tip, say: () => {},
    lesson: "rule:no-desktop-import:lint/rules/no-desktop-import.mjs:lint/fixtures/red/desktop-import.ts",
  });
  assert.equal(salvaged.ok, true, salvaged.message);
  const rule = { class: "rule", id: "no-desktop-import", file: "lint/rules/no-desktop-import.mjs", redOn: "lint/fixtures/red/desktop-import.ts" };
  state = stateOf(repo);
  assert.equal(state.midRunDefects.length, 1, "the salvage lessons the open defect rather than adding a second");
  assert.deepEqual(state.midRunDefects[0].lesson, rule);
  assert.equal(state.midRunDefects[0].fixedBy.commit, tip);

  // The relaunch merges the fix, and the defect survives into the closeout.
  // The merge itself is git's: this fixture has no merger to call, and the
  // relaunch's job here is only to land the salvaged tip and keep the record.
  const integrate = async ({ root, task, branch, attempt, onPid }) => {
    const integrationBase = git(root, "rev-parse", "HEAD");
    onPid(null, integrationBase);
    git(root, "merge", "--no-ff", "-q", "-m", `Merge task ${task.id}`, branch);
    return {
      outcome: "passed", integrationBase, head: git(root, "rev-parse", "HEAD"),
      verification: { taskId: task.id, attempt, branch, passed: true, checks: [], checkReruns: [] },
    };
  };
  await runIn(repo, { dag: DAG, builder, integrate });
  state = stateOf(repo);
  assert.equal(state.tasks[500].lifecycle, "passed", logOf(repo));
  const closeout = renderCloseout(DAG, state, null, null);
  assert.match(closeout, /## Defects found mid-run/);
  assert.match(closeout, new RegExp(`\\*\\*500\\*\\* — post-merge check \`${BUILD}\` failed twice on the same merged tree \\(the lane's own checks did not run it\\); fixed by salvage at ${tip.slice(0, 8)}`));
  assert.match(closeout, /Lesson: rule no-desktop-import \(red fixture lint\/fixtures\/red\/desktop-import\.ts\)/);
  assert.doesNotMatch(closeout, /Lesson: missing/);
  assert.match(renderPrBody({ dag: DAG, state, renderedAt: "now" }), /Lesson: rule no-desktop-import/);
});

test("an integration red read as the environment, or green on its re-run, is no defect (#215)", () => {
  const state = {};
  const env = { command: "npm test", passed: false, classification: "environment", confidence: "high" };
  const flake = { command: "npm test", passed: true, classification: "unclear", confidence: "low" };
  assert.equal(recordIntegrationDefect(state, { taskId: "1", verification: { checkReruns: [env, flake] } }), null);
  assert.equal(renderMidRunDefects(state), "");

  // Unknown lane checks are not "lacks": no log line is owed.
  const real = { command: "npm run build:web", passed: false, classification: "ticket", confidence: "medium" };
  const found = recordIntegrationDefect(state, { taskId: "1", verification: { checkReruns: [real] } });
  assert.equal(found.laneLacks, null);
  // Recording the same failure again lists it once.
  recordIntegrationDefect(state, { taskId: "1", verification: { checkReruns: [real] } });
  assert.equal(state.midRunDefects.length, 1);
  assert.match(renderMidRunDefects(state), /1 defect\(s\) caught before the closeout; 1 without a lesson/);
});
