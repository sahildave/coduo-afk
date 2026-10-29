// scripts/start.test.mjs — `afk start`, the one-terminal-per-epic launcher.
//
// **No test here spawns a real `claude` session or a real orchestrator.** The
// two things that would are seams on `startCommand`: `openSession` and
// `spawnEpic`, both injected. The one test that spawns a real process is
// `the orchestrator outlives the process that started it`, which is the whole
// point of the command and cannot be faked — it runs a throwaway Node script as
// the stand-in orchestrator and asserts on the process table after its parent
// has exited.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  awaitRun,
  liveLockPid,
  parseStartArgs,
  readRunIdentity,
  renderIdentity,
  spawnOrchestrator,
  startCommand,
  sessionCli,
} from "./start.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..");
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-start-"));
  mkdirSync(join(dir, ".afk"), { recursive: true });
  return dir;
};
const writeState = (root, state) =>
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify(state));

// A `spawnEpic` that pretends the orchestrator started and stayed up. `reports`
// is what that orchestrator writes to `.afk/state.json` once it is up — written
// at spawn time, after `startCommand` has taken its launch timestamp, exactly
// as a real run does.
const fakeSpawn = (calls, { alive = () => true, reports = null } = {}) => (options) => {
  calls.push(options);
  if (reports) writeState(options.root, reports());
  return { pid: 4242, alive };
};

const pgid = (pid) =>
  spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

test("parse: an issue number is required, and the refusal names the fix", () => {
  const parsed = parseStartArgs(["--base=main"]);
  assert.match(parsed.error, /usage/);
  assert.match(parsed.error, /afk start 255/);
});

test("parse: the issue is consumed and every other argument is forwarded verbatim", () => {
  const parsed = parseStartArgs(["#255", "--runtime=herdr", "--instructions=be careful"]);
  assert.equal(parsed.issue, "255");
  assert.deepEqual(parsed.forward, ["--runtime=herdr", "--instructions=be careful"]);
});

test("parse: a space-form flag value is not mistaken for the issue", () => {
  const parsed = parseStartArgs(["--task", "40", "255"]);
  assert.equal(parsed.issue, "255");
  assert.deepEqual(parsed.forward, ["--task", "40"]);
});

test("refuses on STDOUT when `claude` is not on PATH, and spawns nothing", async () => {
  const root = scratch();
  const lines = [];
  const calls = [];
  const code = await startCommand({
    root,
    argv: ["255"],
    out: (line) => lines.push(line),
    onPath: () => false,
    spawnEpic: fakeSpawn(calls),
    openSession: () => 0,
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 0, "no orchestrator is started without a session to watch it");
  const said = lines.join("\n");
  assert.match(said, /refusing/);
  assert.match(said, /not on PATH/);
  assert.match(said, /afk epic 255/, "the refusal names the remedy");
  rmSync(root, { recursive: true, force: true });
});

test("refuses on STDOUT when a live orchestrator already holds this checkout", async () => {
  const root = scratch();
  writeFileSync(join(root, ".afk", "orchestrator.lock"), `${process.pid}\n`);
  const lines = [];
  const calls = [];
  const code = await startCommand({
    root,
    argv: ["255"],
    out: (line) => lines.push(line),
    onPath: () => true,
    spawnEpic: fakeSpawn(calls),
    openSession: () => 0,
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
  const said = lines.join("\n");
  assert.match(said, /already running/);
  assert.match(said, /afk status/);
  assert.match(said, /own checkout/);
  rmSync(root, { recursive: true, force: true });
});

test("a lock held by a dead pid does not block a start", () => {
  const root = scratch();
  // A pid that cannot exist: exceeds every platform's pid_max.
  writeFileSync(join(root, ".afk", "orchestrator.lock"), "999999999\n");
  assert.equal(liveLockPid(root), null);
  rmSync(root, { recursive: true, force: true });
});

test("the dashboard URL and branch come from the run's own state, never a default", async () => {
  const root = scratch();
  const lines = [];
  let sessionCwd = null;
  const code = await startCommand({
    root,
    argv: ["255"],
    out: (line) => lines.push(line),
    onPath: () => true,
    spawnEpic: fakeSpawn([], {
      reports: () => ({
        branch: "feat/255-lifecycle",
        epic: { id: "255", title: "Session lifecycle" },
        // The port the dashboard layer resolved — not one this command chose.
        dashboard: { port: 4137, pid: 9, startedAt: new Date().toISOString() },
      }),
    }),
    openSession: (cwd) => {
      sessionCwd = cwd;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(sessionCwd, root, "the session opens in the checkout that is running");
  const said = lines.join("\n");
  assert.match(said, /http:\/\/127\.0\.0\.1:4137/);
  assert.doesNotMatch(said, /4041/, "no fixed default port is ever printed");
  assert.match(said, /feat\/255-lifecycle/);
  assert.match(said, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(said, /afk status/);
  assert.match(said, /gh pr list --head feat\/255-lifecycle/);
  assert.match(said, /git ls-remote --heads origin feat\/255-lifecycle/);
  rmSync(root, { recursive: true, force: true });
});

test("a dashboard block left by a previous run is not reported as this run's", async () => {
  const root = scratch();
  writeState(root, {
    branch: "feat/9-old",
    dashboard: { port: 4041, pid: 9, startedAt: "2020-01-01T00:00:00.000Z" },
  });
  const stale = readRunIdentity(root, Date.now());
  assert.equal(stale.dashboard, null);
  // And with no fresh report, the wait times out as "pending" rather than
  // printing the old port as if the new run had claimed it.
  const outcome = await awaitRun({
    root,
    alive: () => true,
    since: Date.now(),
    timeoutMs: 0,
    sleep: async () => {},
  });
  assert.equal(outcome.status, "pending");
  assert.match(renderIdentity({ issue: "9", root, pid: 1, logPath: "/l", run: outcome }), /STILL STARTING/);
  rmSync(root, { recursive: true, force: true });
});

// A run whose dashboard failed to start carries on without one (#277). It
// reports that in `dashboardSkipped`, and `afk start` must read it as started:
// not wait out its 120 s as STILL STARTING, and not call a run that has since
// finished "exited before it reported a dashboard ... It refused or failed".
const skippedReport = () => ({
  branch: "feat/277-no-dash",
  epic: { id: "277", title: "No dashboard" },
  dashboard: null,
  dashboardSkipped: { at: new Date().toISOString(), reason: "Dashboard failed to start on http://localhost:4200; see /x/dashboard.log" },
});

test("a run carrying on without a dashboard is started, not STILL STARTING", async () => {
  const root = scratch();
  writeState(root, skippedReport());
  const outcome = await awaitRun({ root, alive: () => true, since: Date.now() - 1000, timeoutMs: 0, sleep: async () => {} });
  assert.equal(outcome.status, "ready");
  const block = renderIdentity({ issue: "277", root, pid: 1, logPath: "/l", run: outcome });
  assert.doesNotMatch(block, /STILL STARTING/);
  assert.match(block, /dashboard {2}did not start — the run carries on without it; see the log/);
  rmSync(root, { recursive: true, force: true });
});

test("a run that carried on without a dashboard and has already ended is not reported as refused", async () => {
  const root = scratch();
  const lines = [];
  let opened = false;
  const code = await startCommand({
    root,
    argv: ["277"],
    out: (line) => lines.push(line),
    onPath: () => true,
    spawnEpic: fakeSpawn([], { alive: () => false, reports: skippedReport }),
    openSession: () => {
      opened = true;
      return 0;
    },
  });
  const said = lines.join("\n");
  assert.equal(code, 0, said);
  assert.ok(opened, "the session was not opened");
  assert.doesNotMatch(said, /exited before it reported a dashboard|refused or failed/);
  assert.match(said, /feat\/277-no-dash/);
  rmSync(root, { recursive: true, force: true });
});

test("a dashboardSkipped block left by a previous run is not this run's", () => {
  const root = scratch();
  writeState(root, { dashboard: null, dashboardSkipped: { at: "2020-01-01T00:00:00.000Z", reason: "old" } });
  assert.equal(readRunIdentity(root, Date.now()).dashboardSkipped, null);
  rmSync(root, { recursive: true, force: true });
});

test("an orchestrator that dies before reporting is refused on STDOUT with its log tail", async () => {
  const root = scratch();
  const logPath = join(root, ".afk", "start-255.log");
  writeFileSync(logPath, "EPIC: task 261 has no child issue; refusing.\n");
  const lines = [];
  let opened = false;
  const code = await startCommand({
    root,
    argv: ["255"],
    out: (line) => lines.push(line),
    onPath: () => true,
    spawnEpic: fakeSpawn([], { alive: () => false }),
    openSession: () => {
      opened = true;
      return 0;
    },
  });
  assert.equal(code, 1);
  assert.equal(opened, false, "a dead run does not get a session opened over it");
  const said = lines.join("\n");
  assert.match(said, /exited before it reported/);
  assert.match(said, /has no child issue/, "the reason is on STDOUT, not only in the log");
  rmSync(root, { recursive: true, force: true });
});

test("the orchestrator outlives the process that started it", async () => {
  const root = scratch();
  const fake = join(root, "fake-epic.mjs");
  // Stands in for epic.mjs: records that it ran, then stays up long enough to
  // be observed after its parent is gone.
  writeFileSync(
    fake,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_MARK, process.argv.slice(2).join(" "));
setTimeout(() => {}, 30_000);
`,
  );
  const mark = join(root, "ran.txt");
  const pidFile = join(root, "pid.txt");
  // The parent: spawns the orchestrator through the real seam and exits at once.
  const parent = join(root, "parent.mjs");
  writeFileSync(
    parent,
    `import { writeFileSync } from "node:fs";
import { spawnOrchestrator } from ${JSON.stringify(join(here, "start.mjs"))};
const child = spawnOrchestrator({
  root: process.cwd(),
  issue: "255",
  forward: ["--runtime=herdr"],
  logPath: ${JSON.stringify(join(root, ".afk", "log.txt"))},
  script: ${JSON.stringify(fake)},
});
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
`,
  );
  const result = spawnSync(process.execPath, [parent], {
    cwd: root,
    env: { ...process.env, FAKE_MARK: mark },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const pid = Number(readFileSync(pidFile, "utf8"));
  // The parent has exited (spawnSync returned) and the child is still there.
  assert.doesNotThrow(() => process.kill(pid, 0), "the orchestrator died with its parent");
  // And it is in its own process group, so the terminal's SIGHUP misses it.
  assert.notEqual(pgid(pid), pgid(process.pid));
  // The parent exits without waiting, so the orphan may still be booting Node.
  // Give it a deadline rather than reading the marker on the first tick.
  const deadline = Date.now() + 10_000;
  while (!existsSync(mark) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(
    readFileSync(mark, "utf8"),
    "epic 255 --runtime=herdr",
    "the epic command and its forwarded flags reach the orchestrator",
  );
  process.kill(pid, "SIGKILL");
  rmSync(root, { recursive: true, force: true });
});


// --- the two entry points ---------------------------------------------------
//
// `afk start` and `afk-codex start` are this same file. Which CLI it checks for
// and opens is the whole difference, and it arrives in `AFK_BACKEND` — set by
// afk.mjs on every subcommand it spawns. Before this, `afk-codex start` refused
// on a missing `claude` and then opened a Claude session to watch a Codex run.

test("the session CLI is the one the entry point selected", () => {
  assert.equal(sessionCli("claude"), "claude");
  assert.equal(sessionCli("codex"), "codex");
  // Absent means Claude, like every other backend read in this runner.
  assert.equal(sessionCli(undefined), "claude");
  assert.throws(() => sessionCli("gemini"), /Unknown agent backend/);
});

test("afk-codex start checks for and opens `codex`, not `claude`", async () => {
  const root = scratch();
  const calls = [];
  const opened = [];
  const code = await startCommand({
    root,
    argv: ["77"],
    cli: "codex",
    out: () => {},
    // The recorded argument is what makes this a real assertion: a check that
    // only counted calls would pass with `claude` hardcoded.
    onPath: (command) => { calls.push(command); return command === "codex"; },
    spawnEpic: () => ({ pid: 42, alive: () => true }),
    openSession: (cwd, command) => { opened.push(command); return 0; },
    wait: async () => ({ status: "ready", branch: "afk/epic-77", epic: null, dashboard: { port: 4100 } }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["codex"]);
  assert.deepEqual(opened, ["codex"]);
  rmSync(root, { recursive: true, force: true });
});

test("afk-codex start names Codex in its refusal, and spawns nothing", async () => {
  const root = scratch();
  const said = [];
  const spawned = [];
  const code = await startCommand({
    root,
    argv: ["77"],
    cli: "codex",
    out: (line) => said.push(line),
    onPath: () => false,
    spawnEpic: (options) => { spawned.push(options); return { pid: 1, alive: () => true }; },
    openSession: () => 0,
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0, "nothing was spawned");
  const text = said.join("\n");
  assert.match(text, /`codex` is not on PATH/);
  assert.match(text, /Codex CLI/);
  assert.doesNotMatch(text, /claude/i, "a Codex refusal must not name the other CLI");
  rmSync(root, { recursive: true, force: true });
});

test("the identity block names the session it is about to open", () => {
  const run = { status: "ready", branch: "afk/epic-77", epic: null, dashboard: { port: 4100 } };
  const claude = renderIdentity({ issue: "77", root: "/r", pid: 5, logPath: "/l", run, cli: "claude" });
  assert.match(claude, /Opening a claude session/);
  const codex = renderIdentity({ issue: "77", root: "/r", pid: 5, logPath: "/l", run, cli: "codex" });
  assert.match(codex, /Opening a codex session/);
});
