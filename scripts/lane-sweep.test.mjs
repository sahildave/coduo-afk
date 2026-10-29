// scripts/lane-sweep.test.mjs — a run that stops takes its lane processes with it.
//
// After the 2026-10-01 overnight runs ended normally, five lane `claude`
// sessions (each with an MCP and a permission-broker child) stayed alive 5 to 9
// hours in lane and epic worktrees. Their argv names no lane; only the cwd ties
// them to the run. Fakes only: a `sleep` with its cwd inside a fake lane
// worktree, and one outside every worktree that must survive.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuto } from "./auto.mjs";
import { worktreeRoot } from "./worktree.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import { freePort } from "./free-port.mjs";

const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-sweep-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

// A repo whose only task already passed, so the run goes straight to close.
const closedRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-sweep-")));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify({
    version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
    tasks: { 204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 } },
  }));
  return repo;
};

const DAG = {
  epic: { id: "203", title: "Sweep" },
  branch: "main",
  tasks: [{ id: "204", title: "task 204", dependsOn: [], checks: ["true"], allowedPaths: ["**"] }],
};

const start = async (repo) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await runAuto({
      config: readConfig(repo), dag: DAG, root: repo, interactive: false,
      verify: async () => ({ version: 1, status: "ok", summary: "Reviewed.", criteria: [], findings: [], mustFix: [], problems: [], outstanding: [] }),
      commentOnEpic: () => ({ status: 0 }),
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

// Resolves with the signal that ended the child, or null if it is still alive
// after `ms`. The child is ours, so `exit` fires once it is reaped.
const endedWithin = (child, ms) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done(child.signalCode ?? "exit");
  const timer = setTimeout(() => done(null), ms);
  child.once("exit", (code, signal) => { clearTimeout(timer); done(signal ?? "exit"); });
});

test("a run that stops kills a leftover process in a lane worktree and spares one outside", async () => {
  const repo = closedRepo();
  const lane = join(worktreeRoot(repo), "204", "checkout");
  mkdirSync(lane, { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "afk-sweep-outside-")));
  const leftover = spawn("sleep", ["300"], { cwd: lane, stdio: "ignore" });
  // An interactive pane shell ignores SIGTERM; it has to be escalated.
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"], { cwd: lane, stdio: "ignore" });
  const bystander = spawn("sleep", ["300"], { cwd: outside, stdio: "ignore" });
  try {
    assert.equal(await start(repo), 0);
    assert.ok(await endedWithin(leftover, 2_000), `the lane process ${leftover.pid} outlived the run`);
    assert.equal(await endedWithin(stubborn, 2_000), "SIGKILL", "a SIGTERM-ignoring lane process was not escalated");
    assert.equal(await endedWithin(bystander, 200), null, "a process outside every worktree was killed");
    const log = readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
    const line = log.match(/AUTO: stopped (\d+) leftover lane process\(es\): ([\d, ]+)\./);
    assert.ok(line, "no sweep line in the log");
    assert.deepEqual(line[2].split(", ").map(Number).sort(), [leftover.pid, stubborn.pid].sort());
  } finally {
    leftover.kill("SIGKILL");
    stubborn.kill("SIGKILL");
    bystander.kill("SIGKILL");
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
