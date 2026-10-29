// #146: opt-in auto-restart after an orchestrator fatal, through the real
// `afk epic` CLI and real processes.
//
// The fault is injected by a preload (`--import`) that makes `fs.symlinkSync`
// throw. The runner's only call to it is `worktreeSetup.link` inside
// `prepareBuilder`, so the throw lands in the scheduler loop — the place #841's
// TypeError came from — after plan review, preflight, dashboard and baseline
// have all passed. The preload is an exec argument, so a restart only faults
// again if it really re-ran the same argv.
//
// Nothing touches the network or a model, and nothing reaches the desktop:
// `gh`, `claude` and `terminal-notifier` are scripts on PATH that log what they
// were asked, and lanes live in a temp directory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { freePort } from "./free-port.mjs";
import { normalizeFatal, restartDecision, restartLines } from "./restart.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";

const epicScript = fileURLToPath(new URL("./epic.mjs", import.meta.url));
const statusScript = fileURLToPath(new URL("./status.mjs", import.meta.url));
const autoUrl = new URL("./auto.mjs", import.meta.url).href;

const EPIC = 300;
const BODY = ["```yaml", "afk:", "  version: 1", "  branch: feat/300-restart", "  tasks:", "    301:", "      depends_on: []", "```"].join("\n");
const PAYLOAD = JSON.stringify({
  data: { repository: { issue: {
    number: EPIC, title: "Restart", state: "OPEN", body: BODY,
    subIssues: { totalCount: 1, nodes: [{ number: 301, title: "Lane", state: "OPEN", body: "## Acceptance criteria\n\n- a file exists.\n" }] },
  } } },
});

// Every agent this run reaches is a reader (auth probe, plan reviewer), and a
// clean report satisfies all of them. No builder starts: the fault fires first.
// It is also a child the run spawns, so it reports any restart variable it
// inherited (#146: they must not leak into checks, builders or hooks).
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const leaked = Object.keys(process.env).filter((key) => key.startsWith('AFK_RESTART_'));
if (leaked.length) fs.appendFileSync(process.env.LEAK_LOG, leaked.join(',') + '\\n');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const fence = String.fromCharCode(96, 96, 96);
  const report = fence + 'json\\n' + JSON.stringify({ findings: [], mustFix: [], problems: [], criteria: [], summary: 'clean' }) + '\\n' + fence;
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: report }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: report }) + '\\n');
});
`;

// `distinct`: each process throws a differently worded message. `same`: every
// process throws the same fault, worded with its own pid and time, which is
// what the comparison has to see through. `FAULT_HOLD` keeps the event loop
// busy after the throw, the way the dashboard child and herdr output held #136's
// process open for ~15 minutes.
const FAULT = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.symlinkSync = () => {
  fs.appendFileSync(process.env.FAULT_LOG, process.pid + "\\n");
  const n = fs.readFileSync(process.env.FAULT_LOG, "utf8").trim().split("\\n").length;
  if (process.env.FAULT_HOLD) setInterval(() => {}, 1000);
  throw new Error(process.env.FAULT_MODE === "same"
    ? "injected fault in pid " + process.pid + " at " + new Date().toISOString()
    : "injected fault " + ["alpha", "bravo", "charlie", "delta"][n - 1]);
};
syncBuiltinESMExports();
`;

const fixture = (t, config) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "afk-restart-")));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(dir, "epic.json"), PAYLOAD);
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    `  "api graphql") cat ${JSON.stringify(join(dir, "epic.json"))} ;;`,
    '  "repo view") echo "owner/restart" ;;',
    '  "pr list") echo "[]" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(join(bin, "terminal-notifier"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(dir, "notes.log"))}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "fault.mjs"), FAULT);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  // Ignored, so it exists only in this checkout and every lane has to link it.
  writeFileSync(join(repo, ".gitignore"), ".afk/\nnode_modules/\n");
  mkdirSync(join(repo, "node_modules"));
  writeConfig(repo, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    pr: "off",
    agent: { command: "claude", timeoutMs: 30_000, runtime: "direct" },
    worktreeSetup: { link: ["node_modules"] },
    ...config,
  });
  git("add", "-A");
  git("commit", "-qm", "base");
  const fx = {
    dir, repo, bin,
    faultLog: join(dir, "faults.log"),
    leakLog: join(dir, "leak.log"),
    notesLog: join(dir, "notes.log"),
    extraPids: [],
  };
  // Whatever a red run left alive: every process that faulted, every successor
  // the log names, and anything the test itself started.
  t.after(() => {
    const successors = (logOrEmpty(fx).match(/as pid \d+/g) ?? []).map((hit) => Number(hit.slice(7)));
    for (const pid of [...faultPids(fx), ...successors, ...fx.extraPids])
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return fx;
};

const envFor = async (fx, extra = {}) => ({
  ...process.env,
  PATH: `${fx.bin}:${process.env.PATH}`,
  PORT: String(await freePort()),
  AFK_WORKTREE_ROOT: join(fx.dir, "lanes"),
  AFK_EPIC_ROOT: join(fx.dir, "epics"),
  AFK_NOTIFY_COALESCE_MS: "0",
  FAULT_LOG: fx.faultLog,
  LEAK_LOG: fx.leakLog,
  ...extra,
});

const EPIC_ARGS = ["epic", String(EPIC), "--repo=owner/restart", "--runtime=direct", "--instructions=keep it small"];

/**
 * `afk epic` with the fault preloaded. Resolves when the launched process has
 * exited; `onOutput` sees its stdout and stderr as they arrive.
 */
const launch = async (fx, mode, { env = {}, onOutput = () => {} } = {}) => {
  const childEnv = await envFor(fx, { FAULT_MODE: mode, ...env });
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", join(fx.dir, "fault.mjs"), epicScript, ...EPIC_ARGS], { cwd: fx.repo, env: childEnv });
    let output = "";
    const take = (chunk) => {
      output += chunk;
      onOutput(output, child);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => fail(new Error(`the launched process did not exit:\n${output}`)), 150_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      done({ firstPid: child.pid, output: () => output, code, signal });
    });
  });
};

const stateOf = (fx) => JSON.parse(readFileSync(join(fx.repo, ".afk", "state.json"), "utf8"));
const logOrEmpty = (fx) => {
  try {
    return readFileSync(join(fx.repo, ".afk", "agent-auto.log"), "utf8");
  } catch {
    return "";
  }
};
const faultPids = (fx) => (existsSync(fx.faultLog) ? readFileSync(fx.faultLog, "utf8").trim().split("\n").map(Number) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until `check()` is truthy, or fail with `describe()` after `ms`. */
const waitFor = async (check, ms, describe) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms}ms: ${describe()}`);
    await new Promise((done) => setTimeout(done, 200));
  }
};

/** The chain is over: a stop is on record and every process that faulted is gone. */
const chainEnd = (fx, ms = 90_000) =>
  waitFor(
    () => existsSync(join(fx.repo, ".afk", "state.json")) && stateOf(fx).restart?.stopped && faultPids(fx).every((pid) => !alive(pid)),
    ms,
    () => `faults ${faultPids(fx)}; log:\n${logOrEmpty(fx)}`,
  );

test("a scheduler fatal with autoRestart 2 restarts exactly twice, each a new process, then stops with the fatal intact", { timeout: 200_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2 });
  // A leftover from an earlier launch: each restart's file starts fresh.
  mkdirSync(join(fx.repo, ".afk"), { recursive: true });
  writeFileSync(join(fx.repo, ".afk", "restart-1.log"), "OLD RUN\n");
  const { firstPid } = await launch(fx, "distinct");
  await chainEnd(fx);

  const pids = faultPids(fx);
  assert.equal(pids.length, 3, `one launch and two restarts faulted:\n${logOrEmpty(fx)}`);
  assert.equal(new Set(pids).size, 3, `each attempt is its own process: ${pids}`);
  assert.equal(pids[0], firstPid, "the first fault is the process the test launched");

  const state = stateOf(fx);
  assert.equal(state.fatal?.message, "injected fault charlie", "the last fatal is the one on record");
  assert.equal(state.restart.attempt, 2);
  assert.equal(state.restart.budget, 2);
  assert.deepEqual(state.restart.history.map((entry) => entry.fromPid), pids.slice(0, 2));
  assert.deepEqual(state.restart.history.map((entry) => entry.fatal), ["injected fault alpha", "injected fault bravo"]);
  assert.match(state.restart.stopped.reason, /budget is spent \(2 of 2\)/);
  // Custom instructions carried over: the same argv, and the state guard that
  // refuses a different string never fired.
  assert.equal(state.customInstructions, "keep it small");
  assert.equal(existsSync(join(fx.repo, ".afk", "orchestrator.lock")), false);
  // Each successor wrote to its own file, not to the parent's pipe.
  assert.match(readFileSync(join(fx.repo, ".afk", "restart-1.log"), "utf8"), /injected fault bravo/);
  assert.doesNotMatch(readFileSync(join(fx.repo, ".afk", "restart-1.log"), "utf8"), /OLD RUN/);
  assert.match(readFileSync(join(fx.repo, ".afk", "restart-2.log"), "utf8"), /injected fault charlie/);

  const log = logOrEmpty(fx);
  assert.equal(log.match(/AUTO: restarting after the fatal/g)?.length, 2, log);
  assert.match(log, /output in \S+restart-1\.log/);
  assert.match(log, /AUTO: not restarting after the fatal — the auto-restart budget is spent \(2 of 2\)\./);

  const status = spawnSync(process.execPath, [statusScript], { cwd: fx.repo, encoding: "utf8" });
  assert.match(status.stdout, /orchestrator exited at .*: injected fault charlie/, status.stdout);
  assert.match(status.stdout, /restarted after fatal \(2 of 2\)/, status.stdout);
});

test("no child of a restarted run inherits the restart variables", { timeout: 200_000 }, async (t) => {
  // A check that runs this runner's own suite (this repo's does) saw
  // AFK_RESTART_ATTEMPT and ran restart.test.mjs as "a restarted run".
  const fx = fixture(t, { autoRestart: 1 });
  await launch(fx, "distinct");
  await chainEnd(fx);
  assert.equal(faultPids(fx).length, 2, logOrEmpty(fx));
  assert.equal(existsSync(fx.leakLog) ? readFileSync(fx.leakLog, "utf8") : "", "", "a spawned agent saw AFK_RESTART_*");
});

test("a repeated identical fatal stops after one restart, and the log says why", { timeout: 200_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2 });
  await launch(fx, "same");
  await chainEnd(fx);

  const pids = faultPids(fx);
  assert.equal(pids.length, 2, `one launch and one restart:\n${logOrEmpty(fx)}`);
  assert.notEqual(pids[0], pids[1]);

  const state = stateOf(fx);
  assert.equal(state.restart.attempt, 1);
  // The two messages differ as written (pid, time) and equal once normalised.
  assert.notEqual(state.restart.last.message, state.fatal.message);
  assert.match(state.restart.stopped.reason, /fatal repeated the one the last restart was for/);
  assert.match(
    logOrEmpty(fx),
    /AUTO: not restarting after the fatal — the fatal repeated the one the last restart was for, so another restart would hit it again: injected fault in pid \d+/,
  );
});

test("a successor survives the launching pipe closing after the first restart", { timeout: 200_000 }, async (t) => {
  // Inherited stdio died with EPIPE on the successor's first write once the
  // reader went away, before it could log anything.
  const fx = fixture(t, { autoRestart: 2 });
  await launch(fx, "distinct", {
    onOutput: (output, child) => {
      if (/restarting after the fatal/.test(output)) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    },
  });
  await chainEnd(fx);
  assert.equal(faultPids(fx).length, 3, logOrEmpty(fx));
  assert.match(stateOf(fx).restart.stopped.reason, /budget is spent \(2 of 2\)/);
});

test("a Ctrl-C during the restart hand-over stops the successor too and keeps the record", { timeout: 200_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2 });
  let successor = null;
  // FAULT_HOLD keeps the predecessor alive for EXIT_GRACE_MS after the restart
  // line. Without it the process exits ~0.5ms after writing the line, and the
  // SIGINT races that exit: it lands after the handlers are gone, so the
  // successor is never told to stop.
  const { signal, code } = await launch(fx, "distinct", {
    env: { FAULT_HOLD: "1" },
    onOutput: (output, child) => {
      const hit = output.match(/restarting after the fatal \(1 of 2\) as pid (\d+)/);
      if (hit && !successor) {
        successor = Number(hit[1]);
        fx.extraPids.push(successor);
        child.kill("SIGINT");
      }
    },
  });
  assert.ok(successor, "the restart line was seen");
  assert.ok(code === 130 || signal === "SIGINT", `exit ${code} / ${signal}`);
  await waitFor(() => !alive(successor), 10_000, () => `successor ${successor} still alive`);
  // Time for a successor that survived to fault, so a red run shows it.
  await new Promise((done) => setTimeout(done, 3_000));
  assert.equal(faultPids(fx).length, 1, `only the first process ran:\n${logOrEmpty(fx)}`);
  const record = stateOf(fx).restart;
  assert.equal(record?.attempt, 1);
  assert.equal(record?.last?.message, "injected fault alpha");
  assert.equal(record?.history?.length, 1);
  assert.match(record?.stopped?.reason ?? "", /stopped by SIGINT during the restart/);
});

test("a process that died on a fatal exits promptly even when something holds it open", { timeout: 120_000 }, async (t) => {
  // #136: after the fatal, the process lived ~15 minutes, held open by the
  // dashboard child and herdr output. With no restart to hand over to, it
  // still has to go.
  const fx = fixture(t, {});
  const launched = launch(fx, "distinct", { env: { FAULT_HOLD: "1" } });
  const pid = await waitFor(() => faultPids(fx)[0], 60_000, () => logOrEmpty(fx));
  const faultedAt = Date.now();
  await waitFor(() => !alive(pid), 15_000, () => `pid ${pid} still alive ${Date.now() - faultedAt}ms after its fatal`);
  await launched;
});

// `restartAfterFatal` arms signal handlers, so it runs in a child of its own
// rather than in this test process.
const restartWith = async (fx, spawnChild) => {
  const script = `
    import { spawn } from "node:child_process";
    import { restartAfterFatal } from ${JSON.stringify(new URL("./restart.mjs", import.meta.url).href)};
    let result;
    try {
      const child = restartAfterFatal({ root: process.cwd(), config: { autoRestart: 2 }, fatal: { at: "2026-09-28T05:00:00.000Z", message: "injected fault alpha" }, spawnChild: ${spawnChild} });
      result = child ? "child " + child.pid : "null";
    } catch (error) {
      result = "threw " + error.message;
    }
    setTimeout(() => console.log("RESULT " + result), 300);
  `;
  mkdirSync(join(fx.repo, ".afk"), { recursive: true });
  writeFileSync(join(fx.repo, ".afk", "state.json"), JSON.stringify({ version: 1, fatal: { at: "2026-09-28T05:00:00.000Z", message: "injected fault alpha" }, tasks: {} }));
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fx.repo, encoding: "utf8", timeout: 20_000, env: await envFor(fx) });
};

for (const [name, spawnChild] of [
  ["an asynchronous spawn error (ENOENT)", `(command, args, options) => spawn("/nonexistent/node", args, options)`],
  ["a synchronous spawn throw", `() => { throw new Error("spawn EAGAIN"); }`],
])
  test(`a restart that cannot be spawned (${name}) is recorded as stopped, not as a restart`, { timeout: 30_000 }, async (t) => {
    const fx = fixture(t, {});
    const result = await restartWith(fx, spawnChild);
    assert.match(result.stdout, /RESULT null/, `${result.stdout}\n${result.stderr}`);
    const record = stateOf(fx).restart;
    assert.equal(record.attempt, 0, "a restart that never ran is not counted");
    assert.equal(record.history, undefined);
    assert.match(record.stopped?.reason ?? "", /the restart could not be spawned: .*(ENOENT|EAGAIN)/);
    assert.doesNotMatch(logOrEmpty(fx), /as pid undefined|AUTO: restarting after the fatal/);
  });

/** The state a restart's predecessor left: a fatal, and the record of restart 1. */
const seedRestarted = (fx) => {
  mkdirSync(join(fx.repo, ".afk"), { recursive: true });
  writeFileSync(join(fx.repo, ".afk", "state.json"), JSON.stringify({
    version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
    fatal: { at: "2026-09-28T05:00:00.000Z", message: "injected fault alpha" },
    restart: { budget: 2, attempt: 1, last: { at: "2026-09-28T05:00:00.000Z", message: "injected fault alpha" }, history: [{ at: "2026-09-28T05:00:00.100Z", fatal: "injected fault alpha", fromPid: 1 }] },
    tasks: { 301: { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 } },
  }));
};

const runRestarted = async (fx, env) =>
  spawnSync(process.execPath, [epicScript, ...EPIC_ARGS], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 60_000,
    env: await envFor(fx, { AFK_RESTART_ATTEMPT: "1", AFK_RESTART_ROOT: fx.repo, ...env }),
  });

test("a restart whose predecessor never exits records the stop, logs it and notifies", { timeout: 60_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2 });
  seedRestarted(fx);
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  fx.extraPids.push(holder.pid);
  const result = await runRestarted(fx, { AFK_RESTART_OF: String(holder.pid), AFK_RESTART_WAIT_MS: "500" });
  assert.equal(result.status, 1, result.stderr);
  const reason = stateOf(fx).restart.stopped?.reason ?? "";
  assert.match(reason, new RegExp(`restart 1 did not start: the orchestrator this restart replaces \\(pid ${holder.pid}\\) is still alive`));
  assert.match(logOrEmpty(fx), /AUTO: not restarting after the fatal — restart 1 did not start/);
  assert.match(existsSync(fx.notesLog) ? readFileSync(fx.notesLog, "utf8") : "", /-message \S+ auto-restart stopped — restart 1 did not start.*-subtitle orchestrator exited/);
  const status = spawnSync(process.execPath, [statusScript], { cwd: fx.repo, encoding: "utf8" });
  assert.match(status.stdout, /auto-restart stopped: restart 1 did not start/, status.stdout);
});

test("a restart that refuses to start (a dirty tree) records the stop and notifies", { timeout: 60_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2 });
  seedRestarted(fx);
  writeFileSync(join(fx.repo, "scratch.txt"), "mid-edit\n");
  const result = await runRestarted(fx, {});
  assert.equal(result.status, 1, result.stderr);
  assert.match(stateOf(fx).restart.stopped?.reason ?? "", /restart 1 refused to start; its output is in \S+restart-1\.log/);
  assert.match(existsSync(fx.notesLog) ? readFileSync(fx.notesLog, "utf8") : "", /auto-restart stopped/);
});

test("a refusal is not a fatal: a failing baseline with autoRestart 2 restarts nothing", { timeout: 120_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: 2, baselineChecks: ["false"] });
  const { output } = await launch(fx, "distinct");
  assert.match(output(), /AUTO: baseline check failed before scheduling: false/);
  assert.equal(existsSync(fx.faultLog), false, output());
  const state = stateOf(fx);
  assert.equal(state.restart, undefined);
  assert.equal(state.fatal, undefined);
});

test("a non-integer autoRestart refuses before anything is created", { timeout: 60_000 }, async (t) => {
  const fx = fixture(t, { autoRestart: "yes" });
  const { output } = await launch(fx, "distinct");
  assert.match(output(), /EPIC: autoRestart must be a non-negative integer .*Nothing was created\./);
  assert.equal(existsSync(join(fx.repo, ".afk", "state.json")), false);
});

test("a dying process's exit handler leaves a lock another process has taken", { timeout: 60_000 }, async (t) => {
  // #136: the process that died on a fatal lingered ~15 minutes, and its
  // `process.on("exit", release)` was still armed when it finally went. By
  // then the lock is a restart's, and removing it lets a third one start.
  const fx = fixture(t, {});
  const lock = join(fx.repo, ".afk", "orchestrator.lock");
  const script = `
    import { writeFileSync } from "node:fs";
    import { runAuto } from ${JSON.stringify(autoUrl)};
    import { readConfig } from ${JSON.stringify(new URL("./test-helpers.mjs", import.meta.url).href)};
    const dag = { branch: "main", tasks: [{ id: "301", title: "Lane", dependsOn: [], body: "" }] };
    try { await runAuto({ config: readConfig(process.cwd()), dag, interactive: false, explicitTaskId: "301" }); } catch {}
    writeFileSync(${JSON.stringify(lock)}, process.ppid + "\\n");
  `;
  const result = spawnSync(process.execPath, ["--import", join(fx.dir, "fault.mjs"), "--input-type=module", "-e", script], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 50_000,
    env: await envFor(fx, { FAULT_MODE: "same" }),
  });
  assert.equal(faultPids(fx).length, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(lock), true, "the exit handler removed a lock it did not own");
  assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
});

test("a start a human typed resets the restart count; a restart keeps it", { timeout: 60_000 }, async (t) => {
  const fx = fixture(t, {});
  const { runAuto } = await import("./auto.mjs");
  const record = { budget: 2, attempt: 2, last: { at: "2026-09-24T10:48:44.249Z", message: "old" } };
  const seed = () => {
    mkdirSync(join(fx.repo, ".afk"), { recursive: true });
    writeFileSync(join(fx.repo, ".afk", "state.json"), JSON.stringify({
      version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
      restart: record, tasks: { 301: { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 } },
    }));
  };
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  const previousRoot = process.env.AFK_WORKTREE_ROOT;
  process.env.PATH = `${fx.bin}:${previousPath}`;
  process.env.PORT = String(await freePort());
  process.env.AFK_WORKTREE_ROOT = join(fx.dir, "lanes");
  const start = (autoRestarted) => runAuto({
    config: readConfig(fx.repo), root: fx.repo, interactive: false, autoRestarted,
    dag: { branch: "main", tasks: [{ id: "301", title: "Lane", dependsOn: [], body: "", humanGated: true }] },
  });
  try {
    seed();
    assert.equal(await start(true), 0, logOrEmpty(fx));
    assert.deepEqual(stateOf(fx).restart, record);
    seed();
    assert.equal(await start(false), 0, logOrEmpty(fx));
    assert.equal(stateOf(fx).restart, undefined);
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousRoot === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = previousRoot;
  }
});

// Each pair is one failure hit twice: it must compare equal.
const SAME_WALL = [
  ["timestamp", "died at 2026-09-24T10:48:44.249Z", "died at 2026-09-25T01:00:00Z"],
  ["pid", "worker pid 77 exited", "worker pid 12 exited"],
  ["pid=", "lock held (pid=4411)", "lock held (pid=982)"],
  ["process", "process 4411 did not stop", "process 12 did not stop"],
  ["seconds", "timed out after 123s", "timed out after 9s"],
  ["milliseconds", "no reply in 30012ms", "no reply in 29998ms"],
  ["port", "listen EADDRINUSE: address already in use :::4317", "listen EADDRINUSE: address already in use :::51200"],
  ["position", "Unexpected token } in JSON at position 1234", "Unexpected token } in JSON at position 7"],
  ["short sha", "cannot merge 4e94f6a9 into main", "cannot merge a09fe18 into main"],
  ["attempt", "builder attempt 2 lost its worktree", "builder attempt 3 lost its worktree"],
  ["absolute path", "ENOENT: open '/tmp/a/x.json'", "ENOENT: open '/var/b/y.json'"],
  ["home path", "cannot read ~/.afk-claude/worktrees/a/401", "cannot read ~/.afk-claude/worktrees/b/402"],
  ["bracketed path", "hook failed [/tmp/afk-1/lane]", "hook failed [/private/var/afk-2/lane]"],
  ["atomicWrite temp", "ENOSPC: write 'state.json.4411.1727500000000.tmp'", "ENOSPC: write 'state.json.12.1727500999999.tmp'"],
  ["task id", "task 401 failed", "task 402 failed"],
  ["sha256", "digest mismatch 3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed", "digest mismatch 89e6c98d92887913cadf06b2adb97f26cde4849b89e6c98d92887913cadf06b2"],
  ["uuid", "session 0b9f1c52-7d7e-4c1a-9f3e-2d5b8e6a1c44 expired", "session a1e8d3f0-2c4b-4e9a-8b7d-6f5c3e2a1b09 expired"],
  ["upper-case uuid", "run 0B9F1C52-7D7E-4C1A-9F3E-2D5B8E6A1C44 lost", "run A1E8D3F0-2C4B-4E9A-8B7D-6F5C3E2A1B09 lost"],
];
// Different failures: they must not.
const DIFFERENT_WALL = [
  ["error code", "ENOSPC: no space left on device", "EACCES: permission denied"],
  ["config key", "worktreeSetup.link: node_modules does not exist", "worktreeSetup.copy: .env does not exist"],
  ["wording", "TypeError: Cannot read properties of undefined (reading 'dirty')", "TypeError: Cannot read properties of undefined (reading 'pid')"],
];

for (const [name, a, b] of SAME_WALL)
  test(`normalizeFatal: the same failure with a different ${name} compares equal`, () => {
    assert.equal(normalizeFatal(a), normalizeFatal(b));
  });
for (const [name, a, b] of DIFFERENT_WALL)
  test(`normalizeFatal: a different ${name} is a different failure`, () => {
    assert.notEqual(normalizeFatal(a), normalizeFatal(b));
  });

test("restartDecision", () => {
  const fatal = { message: "boom alpha" };
  assert.deepEqual(restartDecision({ budget: 0, attempt: 0, fatal }), { restart: false, reason: null });
  assert.equal(restartDecision({ budget: 2, attempt: 0, fatal }).restart, true);
  assert.equal(restartDecision({ budget: 2, attempt: 1, fatal, previous: { message: "boom bravo" } }).restart, true);
  assert.match(restartDecision({ budget: 2, attempt: 2, fatal }).reason, /budget is spent \(2 of 2\)/);
  assert.match(restartDecision({ budget: 3, attempt: 1, fatal, previous: { message: "boom alpha" } }).reason, /repeated/);
});

test("restartLines: the count under a fatal, and what happened once a restart ran on", () => {
  assert.deepEqual(restartLines({}), []);
  const history = [{ at: "2026-09-28T05:11:58.277Z" }, { at: "2026-09-28T05:11:58.723Z" }];
  assert.deepEqual(
    restartLines({ fatal: { at: "x", message: "m" }, restart: { attempt: 1, budget: 3, history: history.slice(0, 1) } }),
    ["restarted after fatal (1 of 3)"],
  );
  assert.deepEqual(
    restartLines({ restart: { attempt: 1, budget: 3, history: history.slice(0, 1) } }),
    ["restarted once after a fatal at 2026-09-28T05:11:58.277Z, then ran on"],
  );
  assert.deepEqual(
    restartLines({ restart: { attempt: 2, budget: 3, history } }),
    ["restarted 2 times after fatals, the last at 2026-09-28T05:11:58.723Z, then ran on"],
  );
  assert.deepEqual(
    restartLines({ fatal: { at: "x", message: "m" }, restart: { attempt: 0, budget: 2, stopped: { reason: "the orchestrator lock is still held" } } }),
    ["auto-restart stopped: the orchestrator lock is still held"],
  );
});
