// scripts/integration-rerun.test.mjs — #176 W1: a clean merge whose post-merge
// check fails re-runs only that command, once, on the same merged tree.
//
// Before this, any failed check retried the whole integration: base restored,
// merge redone, every check run again. Five of five such retries on disk failed
// again the same way, and on a fast-forward the retried tree is byte-identical
// by construction. A merge conflict or a merger failure still gets the full
// retry, because a fresh merger can actually produce a different tree.
//
// The checks below append to a log OUTSIDE the repo, so the assertions are on
// the commands that really ran, and running them leaves the tree clean.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { runAuto } from "./auto.mjs";
import { freePort } from "./free-port.mjs";
import { runIntegration } from "./integrate.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";

process.setMaxListeners(60);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-rerun-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

// `first` always passes; `last` fails until it has run `passOnRun` times
// (Infinity: never passes).
const checksFor = (logFile, passOnRun) => ({
  first: `echo first >> ${logFile}`,
  last: `echo last >> ${logFile}; [ $(grep -c '^last$' ${logFile}) -ge ${passOnRun === Infinity ? 99 : passOnRun} ]`,
});

const invocations = (logFile) => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);

/** A repo with a lane branch `task/500` ahead of `main` by one commit. */
const makeRepo = (t, config) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-rerun-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeConfig(repo, config);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const before = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(base, "lanes");
  t.after(() => {
    if (before === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, repo, logFile: join(base, "checks.log") };
};

const laneBranch = (repo) => {
  git(repo, "checkout", "-q", "-b", "task/500");
  writeFileSync(join(repo, "lane.txt"), "lane\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "lane");
  git(repo, "checkout", "-q", "main");
};

// ---------------------------------------------------------------------------
// runIntegration itself
// ---------------------------------------------------------------------------

const integrateOnce = async (t, passOnRun) => {
  const { repo, logFile } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  laneBranch(repo);
  const { first, last } = checksFor(logFile, passOnRun);
  const result = await runIntegration({
    root: repo,
    config: readConfig(repo),
    task: { id: "500", title: "Lane", body: "", checks: [first, last] },
    branch: "task/500",
    baseSha: git(repo, "rev-parse", "HEAD").trim(),
    attempt: 1,
  });
  return { result, logFile };
};

test("a clean merge whose last check fails re-runs only that command, once (#176 W1)", async (t) => {
  const { result, logFile } = await integrateOnce(t, 2);
  assert.deepEqual(invocations(logFile), ["first", "last", "last"],
    "the passing check runs once in total; only the failing one runs again");
  assert.equal(result.outcome, "passed", result.failureReason);
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.checkReruns.length, 1);
  assert.match(result.verification.checkReruns[0].command, /echo last/);
  assert.equal(result.verification.checkReruns[0].firstCode, 1);
  assert.equal(result.verification.checkReruns[0].passed, true);
  assert.ok(result.verification.checks.every((check) => check.code === 0),
    "the overturned first run must not read as a failed check on a passed integration");
});

test("a re-run that fails again fails the integration and says no merger retry is owed (#176 W1)", async (t) => {
  const { result, logFile } = await integrateOnce(t, Infinity);
  assert.deepEqual(invocations(logFile), ["first", "last", "last"]);
  assert.equal(result.outcome, "integration_failed");
  assert.equal(result.checkRerun, true, "the caller must know the check already had its second run");
  assert.match(result.failureReason, /check failed: echo last/);
});

test("a check that timed out is not re-run, and no merger retry is owed (#177 minor 10)", async (t) => {
  const { repo, logFile } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [], checkTimeoutMs: 500 });
  laneBranch(repo);
  const result = await runIntegration({
    root: repo,
    config: readConfig(repo),
    task: { id: "500", title: "Lane", body: "", checks: [`echo slow >> ${logFile}; sleep 5`] },
    branch: "task/500",
    baseSha: git(repo, "rev-parse", "HEAD").trim(),
    attempt: 1,
  });
  assert.deepEqual(invocations(logFile), ["slow"], "a timeout holds the serial queue; it runs once");
  assert.equal(result.outcome, "integration_failed");
  assert.equal(result.verification.checkReruns.length, 0);
  assert.equal(result.checkRerun, true, "a whole second integration would time out the same way");
});

// ---------------------------------------------------------------------------
// The orchestrator: what happens after the integration reports back
// ---------------------------------------------------------------------------

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

const builder = async ({ worktree }) => {
  writeFileSync(join(worktree, "lane.txt"), "lane\n");
  git(worktree, "add", "lane.txt");
  git(worktree, "commit", "-qm", "lane");
  return { outcome: "ready_to_integrate", commitSha: git(worktree, "rev-parse", "HEAD").trim(), verification: { checks: [] } };
};

const autoRepo = (t, passOnRun) => {
  // The paths are only known once the temp dir exists, so the config is
  // rewritten with the real checks before the run.
  const fx = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const { first, last } = checksFor(fx.logFile, passOnRun);
  const config = { maxParallel: 1, defaultChecks: [first, last], baselineChecks: [] };
  writeConfig(fx.repo, config);
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-qm", "checks");
  return fx;
};

const stateOf = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
const logOf = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
const TASK = { id: "500", title: "Lane", dependsOn: [], body: "" };

test("a failed check whose re-run fails is not followed by a whole second integration (#176 W1)", async (t) => {
  const { repo, logFile } = autoRepo(t, Infinity);
  await runIn(repo, { dag: { branch: "main", tasks: [TASK] }, explicitTaskId: "500", builder });
  // Before #176: first,last then the full retry's first,last — four runs, two
  // mergers' worth, over the same tree.
  assert.deepEqual(invocations(logFile), ["first", "last", "last"], logOf(repo));
  assert.equal(stateOf(repo).tasks[500].lifecycle, "integration_failed");
  assert.equal(stateOf(repo).tasks[500].integrationAttempt, 1, "no further integration attempt");
  assert.match(logOf(repo), /re-ran the failed check/);
  assert.doesNotMatch(logOf(repo), /retrying with a fresh merger/);
});

test("a failed check whose re-run passes marks the integration passed (#176 W1)", async (t) => {
  const { repo, logFile } = autoRepo(t, 2);
  await runIn(repo, { dag: { branch: "main", tasks: [TASK] }, explicitTaskId: "500", builder });
  assert.deepEqual(invocations(logFile), ["first", "last", "last"]);
  assert.equal(stateOf(repo).tasks[500].lifecycle, "passed", logOf(repo));
  assert.match(logOf(repo), /re-running the failed check/);
});

test("a post-merge re-run is recorded in state with the reading of its first red (#179)", async (t) => {
  const fx = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  // Red with a held port on its first run, green on its second.
  const check = `echo e2e >> ${fx.logFile}; if [ $(grep -c '^e2e$' ${fx.logFile}) -lt 2 ]; then echo 'Error: listen EADDRINUSE: address already in use :::3000' >&2; exit 1; fi`;
  writeConfig(fx.repo, { maxParallel: 1, defaultChecks: [check], baselineChecks: [] });
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-qm", "checks");
  await runIn(fx.repo, { dag: { branch: "main", tasks: [TASK] }, explicitTaskId: "500", builder });
  assert.equal(stateOf(fx.repo).tasks[500].lifecycle, "passed", logOf(fx.repo));
  const [rerun, ...more] = stateOf(fx.repo).gateReruns ?? [];
  assert.equal(more.length, 0);
  assert.equal(rerun.kind, "integration");
  assert.equal(rerun.taskId, "500");
  assert.equal(rerun.classification, "environment");
  assert.match(rerun.evidence.join("\n"), /EADDRINUSE/);
  assert.equal(rerun.passed, true);
});

test("a merge conflict still gets the full integration retry with a fresh merger (#176 W1)", async (t) => {
  const { repo } = autoRepo(t, 1);
  let integrations = 0;
  await runIn(repo, {
    dag: { branch: "main", tasks: [TASK] },
    explicitTaskId: "500",
    builder,
    integrate: async ({ root, task, branch, attempt, onPid }) => {
      integrations += 1;
      const integrationBase = git(root, "rev-parse", "HEAD").trim();
      onPid(null, integrationBase);
      const failureReason = "unresolved conflicts: lane.txt";
      return {
        outcome: "integration_failed",
        verification: { taskId: task.id, attempt, branch, passed: false, failureReason },
        integrationBase, failureReason, removed: [],
      };
    },
  });
  assert.equal(integrations, 2, "a conflict is retried whole, as before");
  assert.match(logOf(repo), /retrying with a fresh merger/);
  assert.equal(stateOf(repo).tasks[500].lifecycle, "integration_failed");
});

// ---------------------------------------------------------------------------
// #176 W3: baselines may skip the Rust checks; integration never does. It is
// the backstop for every hole the lane and baseline skips have.
// ---------------------------------------------------------------------------

test("an integration with no Rust in its diff still runs the Rust checks (#176 W3)", async (t) => {
  const { repo, logFile } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  laneBranch(repo);
  assert.deepEqual(git(repo, "diff", "--name-only", "main", "task/500").trim().split("\n"), ["lane.txt"],
    "fixture precondition: the lane changed no Rust");
  const rust = `echo rust:test >> ${logFile}`;
  const result = await runIntegration({
    root: repo,
    config: readConfig(repo),
    task: { id: "500", title: "Lane", body: "", checks: [rust] },
    branch: "task/500",
    baseSha: git(repo, "rev-parse", "HEAD").trim(),
    attempt: 1,
  });
  assert.equal(result.outcome, "passed", result.failureReason);
  assert.deepEqual(invocations(logFile), ["rust:test"]);
  assert.ok(result.verification.checks.every((check) => !check.skipped));
});
