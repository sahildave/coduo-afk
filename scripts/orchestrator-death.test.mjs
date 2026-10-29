// #144 (and #136): the orchestrator died silently on a mid-run throw, four
// times on atlas-workspace epics, and nothing noticed for up to 2h13m.
//
//   #841  TypeError in `ledgerDirty` on a failed spawn           (#136)
//   #865  ENOSPC from a retry's bootstrap `npm ci`
//   #874  ENOSPC writing `verification.json`
//   #790  `git worktree remove` failing after the merge had passed
//
// Each test below reproduces one of those shapes, or one of the three things
// the issue asks for (a visible death, a disk check before launch, cleanup that
// cannot kill a passed merge). `auto.mjs` is imported as a namespace so a
// missing export fails its own test, not the whole file.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import * as auto from "./auto.mjs";
import { mergeDashboardState } from "./dashboard-data.mjs";
import { freePort } from "./free-port.mjs";
import { restoreMain, runIntegration } from "./integrate.mjs";
import { flushNotifications, resetNotifyState, run } from "./lib.mjs";
import { fatalLine } from "./status.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import { removeTaskWorktree, taskWorktree, worktreeRoot } from "./worktree.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const statusScript = fileURLToPath(new URL("./status.mjs", import.meta.url));

/** A repo whose lanes live in a temp dir this test owns, removed after. */
const makeRepo = (t, config = null) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-death-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  if (config) writeConfig(repo, config);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const before = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(base, "lanes");
  t.after(() => {
    if (before === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, repo };
};

// The auth preflight's `claude`: the only agent any test here would spawn,
// and every builder and integrator below is stubbed or never reached.
const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-death-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

const runIn = async (repo, args) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await auto.runAuto({ config: readConfig(repo), root: repo, interactive: false, ...args });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

const stateOf = (repo) => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
const logOf = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
const dagOf = (...tasks) => ({ branch: "main", tasks });
const TASK = { id: "401", title: "Lane", dependsOn: [], body: "" };

const enospc = (message = "ENOSPC: no space left on device, open 'verification.json.123.tmp'") => {
  const error = new Error(message);
  error.code = "ENOSPC";
  return error;
};

// ---------------------------------------------------------------------------
// Separate cleanup from merge
// ---------------------------------------------------------------------------

test("removeTaskWorktree returns, and the directory is gone, when `git worktree remove` fails with it present", (t) => {
  // Epic #790: `Cannot remove worktree …: Directory not empty` after all nine
  // post-merge checks passed. The throw killed the scheduler and left a merged
  // task with no `worktreeRemoved`. A `git` shim makes exactly that one
  // subcommand fail, with the directory still on disk.
  const { base, repo } = makeRepo(t);
  const lane = join(worktreeRoot(repo), "7");
  git(repo, "worktree", "add", "-q", "-b", "afk/task-7", lane);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(base, "shim");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\ncase "$*" in *"worktree remove"*) echo "fatal: failed to delete '${lane}': Directory not empty" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
  );
  chmodSync(join(shim, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${shim}:${previous}`;
  let cleanup;
  try {
    cleanup = removeTaskWorktree({ root: repo, id: "7", branch: "afk/task-7" });
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(existsSync(lane), false, "the rm -rf fallback removed the lane");
  assert.equal(cleanup.removed, true);
  assert.match(cleanup.warning, /git worktree remove failed .*Directory not empty.*fell back to rm -rf/);
  // `git worktree prune` dropped the registration, so the branch could go too.
  assert.doesNotMatch(git(repo, "worktree", "list"), /task-7|\/7\b/);
  assert.equal(cleanup.branchDeleted, true);
});

test("reconcile retries the cleanup of a passed task that is missing worktreeRemoved", (t) => {
  // The state a failed cleanup leaves: merged, `passed`, and the lane still on
  // disk. The worktree-list sweep only sees lanes git still lists, so state is
  // the one record that can find the rest.
  const { repo } = makeRepo(t);
  const lane = join(worktreeRoot(repo), "8");
  git(repo, "worktree", "add", "-q", "-b", "afk/task-8", lane);
  const state = {
    tasks: {
      8: { lifecycle: "passed", branch: "afk/task-8", worktreeRemoved: false, cleanupWarning: "old" },
      // Already clean, and a gate accepted by a human with no lane at all:
      // neither is touched.
      9: { lifecycle: "passed", branch: "afk/task-9", worktreeRemoved: true },
      10: { lifecycle: "passed" },
    },
  };
  const { retried } = auto.retryPassedCleanup({ state, root: repo });
  assert.deepEqual(retried.map((entry) => entry.id), ["8"]);
  assert.equal(existsSync(lane), false);
  assert.equal(state.tasks[8].worktreeRemoved, true);
  assert.equal(state.tasks[8].branchDeleted, true);
  assert.equal(state.tasks[8].cleanupWarning, undefined);
});

// ---------------------------------------------------------------------------
// Make death visible
// ---------------------------------------------------------------------------

test("a throw inside the scheduler loop records a fatal in state.json, notifies, and afk status names it", async (t) => {
  // A `worktreeSetup.link` naming a missing path throws from `prepareBuilder`,
  // inside the loop, after a healthy start — the same place #841's TypeError
  // came from. It is a config fault every lane shares, so it stays fatal.
  const { repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    worktreeSetup: { link: ["node_modules"] },
  });
  const notes = [];
  await assert.rejects(
    runIn(repo, {
      dag: dagOf(TASK),
      explicitTaskId: "401",
      notify: (title, message, event) => notes.push({ title, message, event }),
    }),
    /node_modules does not exist/,
  );
  const state = stateOf(repo);
  assert.match(state.fatal?.message ?? "", /worktreeSetup\.link: node_modules does not exist/);
  assert.ok(!Number.isNaN(Date.parse(state.fatal.at)), `fatal.at is a timestamp: ${state.fatal.at}`);
  assert.deepEqual(notes.map((note) => note.event), ["orchestrator_fatal"]);
  assert.match(notes[0].message, /node_modules does not exist/);

  const status = spawnSync(process.execPath, [statusScript], { cwd: repo, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(
    status.stdout,
    new RegExp(`orchestrator exited at ${state.fatal.at.replace(/[.]/g, "\\.")}: worktreeSetup\\.link: node_modules does not exist`),
    status.stdout,
  );

  // The dashboard reads the same record.
  const merged = mergeDashboardState({ tasks: [{ id: "401", dependsOn: [] }] }, state, [], () => false);
  assert.deepEqual(merged.runtime.fatal, state.fatal);
});

test("a restart clears the previous run's fatal record", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(
    join(repo, ".afk", "state.json"),
    JSON.stringify({
      version: 1,
      orchestratorPid: null,
      activeWorkers: {},
      integrationQueue: [],
      activeIntegrator: null,
      fatal: { at: "2026-09-24T10:48:44.249Z", message: "TypeError: old" },
      tasks: { 401: { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 } },
    }),
  );
  const code = await runIn(repo, { dag: dagOf({ ...TASK, humanGated: true }) });
  assert.equal(code, 0, logOf(repo));
  assert.equal(stateOf(repo).fatal, undefined);
});

// ---------------------------------------------------------------------------
// Check disk before launch
// ---------------------------------------------------------------------------

// The baseline command writes into the same log the runner does, so the order
// of the two lines is the order they happened in.
const BASELINE_MARK = "echo BASELINE-RAN >> .afk/agent-auto.log";

test("free space below maxParallel × perLaneBytes prints a disk warning before any baseline command runs", async (t) => {
  const { repo } = makeRepo(t, {
    maxParallel: 3,
    defaultChecks: ["true"],
    baselineChecks: [BASELINE_MARK],
    diskPerLaneBytes: 4 * 1024 ** 3,
  });
  const code = await runIn(repo, {
    dag: dagOf({ ...TASK, humanGated: true }),
    freeDisk: () => 5 * 1024 ** 3,
  });
  assert.equal(code, 0, logOf(repo));
  const log = logOf(repo);
  const warning = log.indexOf("AUTO: disk: 5.0 GiB free");
  const baseline = log.indexOf("BASELINE-RAN");
  assert.ok(warning >= 0, `no disk warning:\n${log}`);
  assert.match(log, /below maxParallel 3 × 4\.0 GiB per lane \(diskPerLaneBytes\) = 12\.0 GiB/);
  assert.ok(baseline > warning, `the baseline ran before the warning:\n${log}`);
});

test("free space below the floor refuses the run and no baseline command runs", async (t) => {
  const { repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [BASELINE_MARK],
  });
  const code = await runIn(repo, {
    dag: dagOf({ ...TASK, humanGated: true }),
    freeDisk: () => 0.5 * 1024 ** 3,
  });
  assert.equal(code, 1);
  const log = logOf(repo);
  assert.match(log, /AUTO: disk: 0\.5 GiB free .* below the 1\.0 GiB floor \(diskFloorBytes\)/);
  assert.doesNotMatch(log, /BASELINE-RAN/);
  assert.equal(stateOf(repo).orchestratorPid, null);
});

test("diskPreflight: ok above the threshold, and when free space cannot be measured", () => {
  const args = { maxParallel: 2, perLaneBytes: 10, floorBytes: 5, path: "/x" };
  assert.equal(auto.diskPreflight({ ...args, freeBytes: 20 }).level, "ok");
  assert.equal(auto.diskPreflight({ ...args, freeBytes: 19 }).level, "warn");
  assert.equal(auto.diskPreflight({ ...args, freeBytes: 4 }).level, "refuse");
  assert.equal(auto.diskPreflight({ ...args, freeBytes: Number.NaN }).level, "ok");
});

// ---------------------------------------------------------------------------
// ENOSPC is the lane's failure, not the process's
// ---------------------------------------------------------------------------

test("ENOSPC in a lane's bootstrap fails that task as infra, and the run ends normally", async (t) => {
  // Epic #865: `npm ci` in `worktreeSetup.run` hit ENOSPC and the throw came up
  // through `bootstrapWorktree` into `runAuto`, killing the run for 2h13m.
  const { repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    worktreeSetup: { run: ["sh npm-ci.sh"] },
  });
  // A committed script, so the command line itself says nothing about a disk
  // and the log line has to come from its stderr, as `npm ci`'s does.
  writeFileSync(
    join(repo, "npm-ci.sh"),
    'echo "npm ERR! code ENOSPC" >&2\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n',
  );
  git(repo, "add", "npm-ci.sh");
  git(repo, "commit", "-qm", "npm ci that hits a full disk");
  const code = await runIn(repo, { dag: dagOf(TASK), explicitTaskId: "401" });
  assert.equal(typeof code, "number");
  const state = stateOf(repo);
  const log = logOf(repo);
  assert.equal(state.tasks[401].lifecycle, "infra_failed", log);
  assert.equal(state.tasks[401].diskFull.where, "worktree bootstrap");
  assert.match(log, /builder 401 hit a full disk during worktree bootstrap — npm ERR! nospc ENOSPC/);
  // `infra_failed` is rebuildable, so the lane gets one more go; the second
  // full disk trips the harness breaker and the run stops on its own terms.
  assert.match(log, /2 lanes never reached the API/);
  assert.doesNotMatch(log, /AUTO: fatal/);
  assert.equal(state.fatal, undefined);
});

test("ENOSPC writing a builder's record fails that task as infra, not the run, and still runs its teardown hook", async (t) => {
  const { base, repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    worktreeSetup: { teardown: ["echo torn >> ../../../teardown.log"] },
  });
  const code = await runIn(repo, {
    dag: dagOf(TASK),
    explicitTaskId: "401",
    builder: async () => {
      throw enospc();
    },
  });
  assert.equal(typeof code, "number");
  const state = stateOf(repo);
  const log = logOf(repo);
  assert.equal(state.tasks[401].lifecycle, "infra_failed", log);
  assert.equal(state.tasks[401].diskFull.where, "a record write");
  assert.doesNotMatch(log, /AUTO: fatal/);
  // Two attempts (the second trips the harness breaker), one teardown each.
  assert.equal(readFileSync(join(base, "lanes", "teardown.log"), "utf8").trim().split("\n").length, 2);
});

test("ENOSPC writing an integration's record is infra: main restored, ticket unmarked, no retry on the same disk", async (t) => {
  // Epic #874: ENOSPC writing `verification.json.*.tmp` in `runIntegration`.
  // It used to become `integration_failed`, retried at once on the same full
  // disk and charged to the ticket; the builder path already called it infra.
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const head = git(repo, "rev-parse", "HEAD").trim();
  let laneSha = null;
  let integrations = 0;
  const code = await runIn(repo, {
    dag: dagOf(TASK),
    explicitTaskId: "401",
    builder: async ({ worktree }) => {
      writeFileSync(join(worktree, "b.txt"), "lane\n");
      git(worktree, "add", "b.txt");
      git(worktree, "commit", "-qm", "lane");
      laneSha = git(worktree, "rev-parse", "HEAD").trim();
      return {
        outcome: "ready_to_integrate",
        commitSha: laneSha,
        verification: { checks: [] },
      };
    },
    // Merges for real, then dies writing its record — the #874 order.
    integrate: async ({ root, branch, onPid }) => {
      integrations += 1;
      onPid(null, git(root, "rev-parse", "HEAD").trim());
      git(root, "merge", "--no-ff", "--no-edit", branch);
      throw enospc();
    },
  });
  assert.equal(typeof code, "number");
  const state = stateOf(repo);
  const log = logOf(repo);
  assert.equal(integrations, 1, "no second integration on the same full disk");
  // Kept, not rebuilt: `infra_failed` would reset the committed lane to base.
  assert.equal(state.tasks[401].lifecycle, "ready_to_integrate", log);
  assert.equal(state.tasks[401].diskFull.where, "integration");
  assert.match(log, /integration 401 hit a full disk — ENOSPC: no space left on device/);
  assert.doesNotMatch(log, /integration_failed|AUTO: fatal/);
  // The half-landed merge was rolled back: main never took the lane's commit.
  // (HEAD itself moved: the runner commits its own status table.)
  assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", laneSha, "HEAD"], { cwd: repo }).status, 0);
  assert.ok(spawnSync("git", ["merge-base", "--is-ancestor", head, "HEAD"], { cwd: repo }).status === 0);
});

// ---------------------------------------------------------------------------
// #136: a spawn that fails outright is a failed command, not a TypeError
// ---------------------------------------------------------------------------

test("run() turns a spawn failure into a failed result instead of stdout: null", () => {
  // Epic #841: `ledgerDirty` read `.stdout.trim()` of a spawn that never
  // happened (EAGAIN under process pressure) and the TypeError ended the run.
  // A missing cwd fails the spawn the same way, deterministically.
  const result = run("true", { cwd: join(tmpdir(), "afk-136-no-such-dir") });
  assert.equal(result.stdout, "");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.stdout.trim(), "", "the exact call that threw in ledgerDirty");
});

// ---------------------------------------------------------------------------
// PR #148 review pass
// ---------------------------------------------------------------------------

/** Running, as opposed to a zombie still answering signal 0. */
const running = (pid) => {
  const ps = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && !/^\s*Z/.test(ps.stdout);
};

test("a builder whose promise rejects with ENOSPC has its agent stopped before the task is rebuilt", async (t) => {
  // `saveState` inside `onPid` can throw ENOSPC while the detached agent runs
  // on. Clearing the pid and rebuilding put two agents in one worktree.
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const pids = [];
  const aliveAtNextSpawn = [];
  const code = await runIn(repo, {
    dag: dagOf(TASK),
    explicitTaskId: "401",
    builder: async ({ worktree, onPid }) => {
      aliveAtNextSpawn.push(...pids.map(running));
      if (!pids.length) {
        const agent = spawn("sleep", ["30"], { cwd: worktree, detached: true, stdio: "ignore" });
        agent.unref();
        pids.push(agent.pid);
        onPid(agent.pid);
      }
      throw enospc();
    },
  });
  t.after(() => pids.forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} }));
  assert.equal(typeof code, "number");
  assert.equal(pids.length, 1, "only one agent was ever spawned");
  assert.deepEqual(aliveAtNextSpawn, [false], "the first agent was gone when the task was rebuilt");
  assert.equal(running(pids[0]), false);
  assert.match(logOf(repo), /stopped builder 401 pid \d+ after a full disk: stopped after SIGTERM/);
});

test("an integrator whose promise rejects with ENOSPC has its merger stopped before main is reset", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  let merger = null;
  await runIn(repo, {
    dag: dagOf(TASK),
    explicitTaskId: "401",
    builder: async ({ worktree }) => {
      writeFileSync(join(worktree, "b.txt"), "lane\n");
      git(worktree, "add", "b.txt");
      git(worktree, "commit", "-qm", "lane");
      return { outcome: "ready_to_integrate", commitSha: git(worktree, "rev-parse", "HEAD").trim(), verification: { checks: [] } };
    },
    integrate: async ({ root, onPid }) => {
      const agent = spawn("sleep", ["30"], { cwd: root, detached: true, stdio: "ignore" });
      agent.unref();
      merger = agent.pid;
      onPid(agent.pid, git(root, "rev-parse", "HEAD").trim());
      throw enospc();
    },
  });
  t.after(() => { try { process.kill(merger, "SIGKILL"); } catch {} });
  assert.equal(running(merger), false);
  assert.match(logOf(repo), /stopped integrator 401 pid \d+ after a full disk/);
});

test("a restart refused by the disk floor keeps the previous run's fatal record", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  mkdirSync(join(repo, ".afk"), { recursive: true });
  const fatal = { at: "2026-09-24T10:48:44.249Z", message: "TypeError: old" };
  writeFileSync(
    join(repo, ".afk", "state.json"),
    JSON.stringify({
      version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null, fatal,
      tasks: { 401: { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 } },
    }),
  );
  const code = await runIn(repo, { dag: dagOf({ ...TASK, humanGated: true }), freeDisk: () => 0.5 * 1024 ** 3 });
  assert.equal(code, 1);
  assert.deepEqual(stateOf(repo).fatal, fatal);
});

// Replace state.json with a non-empty directory, so the next `saveState`'s
// rename fails — the shape of a state write on a full disk.
const breakStateWrites = (repo) => {
  const path = join(repo, ".afk", "state.json");
  rmSync(path, { force: true });
  mkdirSync(join(path, "blocked"), { recursive: true });
};

test("a fatal whose final state write also fails still surfaces the original error and releases the lock", async (t) => {
  const { repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    worktreeSetup: { link: ["node_modules"] },
  });
  await assert.rejects(
    runIn(repo, { dag: dagOf(TASK), explicitTaskId: "401", notify: () => breakStateWrites(repo) }),
    /node_modules does not exist/,
  );
  assert.equal(existsSync(join(repo, ".afk", "orchestrator.lock")), false, "the lock was released");
});

test("a disk refusal whose state write fails still refuses cleanly, through refuse", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return write(chunk, ...rest); };
  let code;
  try {
    code = await runIn(repo, {
      dag: dagOf({ ...TASK, humanGated: true }),
      freeDisk: () => { breakStateWrites(repo); return 0.5 * 1024 ** 3; },
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(code, 1);
  assert.match(stderr.join(""), /AUTO: disk: 0\.5 GiB free/, "the refusal reaches stderr (R7)");
  assert.equal(existsSync(join(repo, ".afk", "orchestrator.lock")), false);
});

test("retryPassedCleanup leaves an unmerged lane alone, skips what the sweep handled, and never flips branchDeleted back", (t) => {
  const { repo } = makeRepo(t);
  // Ahead of main, with an uncommitted file an rm -rf would take.
  const ahead = join(worktreeRoot(repo), "11");
  git(repo, "worktree", "add", "-q", "-b", "afk/task-11", ahead);
  writeFileSync(join(ahead, "c.txt"), "c\n");
  git(ahead, "add", "c.txt");
  git(ahead, "commit", "-qm", "ahead");
  writeFileSync(join(ahead, "draft.md"), "uncommitted\n");
  // Handled by the sweep this start.
  const swept = join(worktreeRoot(repo), "12");
  git(repo, "worktree", "add", "-q", "-b", "afk/task-12", swept);
  // Its branch already deleted by an earlier pass; only the directory is left.
  const gone = join(worktreeRoot(repo), "13");
  mkdirSync(gone, { recursive: true });
  const state = {
    tasks: {
      11: { lifecycle: "passed", branch: "afk/task-11", worktreeRemoved: false },
      12: { lifecycle: "passed", branch: "afk/task-12", worktreeRemoved: false },
      13: { lifecycle: "passed", branch: "afk/task-13", worktreeRemoved: false, branchDeleted: true },
    },
  };
  const { retried, refused } = auto.retryPassedCleanup({ state, root: repo, baseBranch: "main", skip: new Set(["12"]) });
  assert.deepEqual(refused.map((entry) => entry.id), ["11"]);
  assert.equal(existsSync(join(ahead, "draft.md")), true, "the unmerged lane's files survived");
  assert.equal(existsSync(swept), true, "the swept lane was not cleaned a second time");
  assert.deepEqual(retried.map((entry) => entry.id), ["13"]);
  assert.equal(state.tasks[13].branchDeleted, true);
  assert.equal(state.tasks[13].cleanupWarning, undefined);
});

test("runAuto retries a passed task's cleanup at startup", async (t) => {
  // The call site, not just the function: removing it must fail a test.
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  git(repo, "branch", "afk/task-501");
  const lane = taskWorktree(repo, "501");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "left.txt"), "left behind\n");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(
    join(repo, ".afk", "state.json"),
    JSON.stringify({
      version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
      tasks: { 501: { lifecycle: "passed", branch: "afk/task-501", worktreeRemoved: false, builderAttempt: 1, integrationAttempt: 1 } },
    }),
  );
  const code = await runIn(repo, { dag: dagOf({ ...TASK, id: "501" }) });
  assert.equal(code, 0, logOf(repo));
  assert.equal(existsSync(lane), false);
  assert.equal(stateOf(repo).tasks[501].worktreeRemoved, true);
  assert.match(logOf(repo), /retried cleanup for passed task 501: worktree removed, branch gone/);
});

test("isDiskFull: the error code or the OS's own text, never a bare ENOSPC in some output", () => {
  assert.equal(auto.isDiskFull(enospc()), true);
  assert.equal(auto.isDiskFull(new Error("npm ERR! nospc ENOSPC: no space left on device, write")), true);
  assert.equal(
    auto.isDiskFull(new Error("worktreeSetup.run failed in /x: npm test\nnot ok 3 - retries after ENOSPC from the writer")),
    false,
  );
});

test("a non-numeric diskPerLaneBytes refuses the run instead of switching the check off", async (t) => {
  const { repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [BASELINE_MARK],
    diskPerLaneBytes: "14G",
  });
  const code = await runIn(repo, { dag: dagOf({ ...TASK, humanGated: true }), freeDisk: () => 100 * 1024 ** 3 });
  assert.equal(code, 1);
  const log = logOf(repo);
  assert.match(log, /AUTO: disk: diskPerLaneBytes must be a number of bytes .* not "14G"/);
  assert.doesNotMatch(log, /BASELINE-RAN/);
});

test("the fatal notification has its own group, so an earlier gate banner cannot dedupe it", async (t) => {
  const { base, repo } = makeRepo(t, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    worktreeSetup: { link: ["node_modules"] },
  });
  const bin = join(base, "notifier");
  mkdirSync(bin);
  const argv = join(base, "argv.log");
  writeFileSync(join(bin, "terminal-notifier"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argv)}\n`);
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  resetNotifyState();
  try {
    await assert.rejects(runIn(repo, { dag: dagOf(TASK), explicitTaskId: "401" }), /node_modules does not exist/);
    flushNotifications();
  } finally {
    process.env.PATH = previous;
    resetNotifyState();
  }
  const args = readFileSync(argv, "utf8").split("\n");
  assert.equal(args[args.indexOf("-group") + 1], "afk-orchestrator-fatal", args.join(" "));
});

test("status and the dashboard share one rule: a live orchestrator pid outranks a fatal record", () => {
  const state = { orchestratorPid: 4242, fatal: { at: "2026-09-24T10:48:44.249Z", message: "boom" } };
  assert.equal(fatalLine(state, () => true), null);
  assert.equal(fatalLine(state, () => false), "orchestrator exited at 2026-09-24T10:48:44.249Z: boom");
  const merged = mergeDashboardState({ tasks: [] }, state, [], () => true);
  assert.equal(merged.runtime.fatal, null);
});

test("runIntegration fails loudly on an unresolvable branch instead of merging an empty sha, and restoreMain refuses an empty base", async (t) => {
  const { repo } = makeRepo(t);
  const head = git(repo, "rev-parse", "HEAD").trim();
  const result = await runIntegration({
    root: repo,
    config: {},
    task: { id: "601", title: "gone" },
    branch: "afk/task-601",
    baseSha: head,
    attempt: 1,
  });
  assert.equal(result.outcome, "integration_failed");
  assert.match(result.failureReason, /cannot resolve afk\/task-601/);
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), head);
  assert.throws(() => restoreMain(repo, ""), /no integration base was recorded/);
});

// ---------------------------------------------------------------------------
// PR #148 second review pass
// ---------------------------------------------------------------------------

// 401 → 402, plus a gated task so neither run reaches the epic close.
const strandDag = () => dagOf(
  TASK,
  { id: "402", title: "Dependent", dependsOn: ["401"], body: "" },
  { id: "403", title: "Gate", dependsOn: [], body: "", humanGated: true },
);

const commitIn = (worktree, name) => {
  writeFileSync(join(worktree, name), `${name}\n`);
  git(worktree, "add", name);
  git(worktree, "commit", "-qm", name);
  return { outcome: "ready_to_integrate", commitSha: git(worktree, "rev-parse", "HEAD").trim(), verification: { checks: [] } };
};

// A real `--no-ff` merge, returned as the passing integration it is.
const mergeFor = async ({ root, branch, onPid }) => {
  const integrationBase = git(root, "rev-parse", "HEAD").trim();
  onPid(null, integrationBase);
  git(root, "merge", "--no-ff", "--no-edit", branch);
  return { outcome: "passed", integrationBase, head: git(root, "rev-parse", "HEAD").trim(), verification: { checks: [] } };
};

/** Run 1: 401 builds, then its integration hits a full disk. The operator frees space by deleting the lane. */
const parkThenDeleteLane = async (repo) => {
  const code = await runIn(repo, {
    dag: strandDag(),
    builder: async ({ worktree, task }) => commitIn(worktree, `${task.id}.txt`),
    integrate: async ({ onPid, root }) => {
      onPid(null, git(root, "rev-parse", "HEAD").trim());
      throw enospc();
    },
  });
  rmSync(taskWorktree(repo, "401"), { recursive: true, force: true });
  git(repo, "worktree", "prune");
  return code;
};

test("a lane parked by a disk-full integration is integrated on restart even after its worktree was deleted and pruned", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const first = await parkThenDeleteLane(repo);
  assert.equal(first, 1, "a run that ends with a parked lane is not done");
  assert.match(logOf(repo), /401 parked after a full disk during integration/);

  const built = [];
  const second = await runIn(repo, {
    dag: strandDag(),
    builder: async ({ worktree, task }) => { built.push(task.id); return commitIn(worktree, `${task.id}.txt`); },
    integrate: mergeFor,
  });
  const state = stateOf(repo);
  const log = logOf(repo);
  assert.match(log, /re-queued 401 for integration from afk\/task-401/);
  assert.equal(state.tasks[401].lifecycle, "passed", log);
  assert.deepEqual(built, ["402"], "401 was integrated from its branch, not rebuilt; its dependent ran");
  assert.equal(state.tasks[402].lifecycle, "passed", log);
  assert.equal(second, 0, log);
});

test("a parked lane whose branch is gone too is failed by name, not left in flight", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  await parkThenDeleteLane(repo);
  git(repo, "branch", "-D", "afk/task-401");
  await runIn(repo, { dag: strandDag(), builder: async () => assert.fail("nothing to build"), integrate: mergeFor });
  const state = stateOf(repo);
  assert.equal(state.tasks[401].lifecycle, "integration_failed");
  assert.match(logOf(repo), /401 was ready_to_integrate but afk\/task-401 no longer exists; marked integration_failed/);
});

/** A `git` that fails `show-ref` the way a spawn or repository error does: not exit 1. */
const brokenShowRef = (t, base) => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(base, "shim-show-ref");
  mkdirSync(shim);
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase "$*" in *show-ref*) echo "fatal: cannot" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${shim}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  return () => { process.env.PATH = previous; };
};

test("a branch check git could not answer is never read as 'branch gone'", (t) => {
  const { base, repo } = makeRepo(t);
  const lane = join(worktreeRoot(repo), "14");
  git(repo, "worktree", "add", "-q", "-b", "afk/task-14", lane);
  writeFileSync(join(lane, "draft.md"), "uncommitted\n");
  const state = { tasks: { 14: { lifecycle: "passed", branch: "afk/task-14", worktreeRemoved: false } } };
  const restore = brokenShowRef(t, base);
  const { retried, refused } = auto.retryPassedCleanup({ state, root: repo });
  const direct = removeTaskWorktree({ root: repo, id: "99", branch: "afk/task-99" });
  restore();
  assert.deepEqual(retried, []);
  assert.deepEqual(refused.map((entry) => entry.reason), ["git could not say whether it exists"]);
  assert.equal(existsSync(join(lane, "draft.md")), true);
  assert.equal(direct.branchDeleted, false, "unknown is not deleted");
});

test("a disk-full builder whose agent cannot be signalled (EPERM) and is still alive is fatal, not rebuilt", async (t) => {
  // pid 1 is always alive and never ours to signal: the EPERM shape, safely.
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  let calls = 0;
  await assert.rejects(
    runIn(repo, {
      dag: dagOf(TASK),
      explicitTaskId: "401",
      builder: async ({ onPid }) => {
        calls += 1;
        onPid(1);
        throw enospc();
      },
    }),
    /builder 401 pid 1 is still running \(signal failed/,
  );
  assert.equal(calls, 1, "never rebuilt over a live agent");
});

test("a disk-full builder whose agent had already exited logs it quietly and carries on", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  const code = await runIn(repo, {
    dag: dagOf(TASK),
    explicitTaskId: "401",
    builder: async ({ worktree, onPid }) => {
      const done = spawnSync("sh", ["-c", "echo $$"], { cwd: worktree, encoding: "utf8" });
      onPid(Number(done.stdout.trim()));
      throw enospc();
    },
  });
  assert.equal(typeof code, "number");
  const log = logOf(repo);
  assert.match(log, /builder 401 pid \d+ had already exited/);
  assert.doesNotMatch(log, /signal failed|AUTO: fatal/);
});
