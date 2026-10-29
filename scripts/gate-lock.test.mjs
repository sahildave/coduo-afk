// scripts/gate-lock.test.mjs — one full gate at a time across every epic on the machine (#178).
//
// harbour #489 and atlas-workspace #928 overlapped their gates five times in two
// days; #489's e2e went red at host load 12 and passed 248/248 on a quiet host.
// These tests hold the lock from OTHER processes, because that is the case the
// lock exists for: two epics are two orchestrators.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireGateLock, gateLockEnabled, gateWaitLine, gateWaitPath, processStartedMs, readGateHolder, takeOver, withGateLock,
} from "./gate-lock.mjs";
import { runBaselineChecks } from "./auto.mjs";
import { runCloseoutGate } from "./fixer.mjs";
import { recordGate, gateEventsPath } from "./measure.mjs";
import { holdGateLock } from "./test-helpers.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-lock-")));

// A fake full gate in its own process: takes the lock (unless the project
// config turns it off), records when its body ran, and sleeps `ms` inside it.
const fakeGate = ({ lockPath, root, epic, ms, record, gateLock = true }) => {
  const code = `import(${JSON.stringify(new URL("./gate-lock.mjs", import.meta.url).href)}).then(async ({ withGateLock }) => {
    const { appendFileSync } = await import("node:fs");
    await withGateLock({ root: ${JSON.stringify(root)}, config: { gateLock: ${gateLock} }, epic: ${JSON.stringify(epic)},
      kind: "baseline", path: ${JSON.stringify(lockPath)}, pollMs: 20, heartbeatMs: 100,
      say: (line) => appendFileSync(${JSON.stringify(`${record}.log`)}, line + "\\n") }, async () => {
      const start = Date.now();
      await new Promise((done) => setTimeout(done, ${ms}));
      appendFileSync(${JSON.stringify(record)}, JSON.stringify({ epic: ${JSON.stringify(epic)}, start, end: Date.now() }) + "\\n");
    });
  });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", done));
};

const intervals = (record) => readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .sort((a, b) => a.start - b.start);

test("two gates from two epics contend for the lock and run one after the other", async () => {
  const dir = scratch();
  try {
    const lockPath = join(dir, "gate.lock");
    const record = join(dir, "gates.jsonl");
    const repoA = join(dir, "harbour"); const repoB = join(dir, "atlas-workspace");
    mkdirSync(repoA); mkdirSync(repoB);
    await Promise.all([
      fakeGate({ lockPath, root: repoA, epic: "489", ms: 500, record }),
      fakeGate({ lockPath, root: repoB, epic: "928", ms: 500, record }),
    ]);
    const [first, second] = intervals(record);
    assert.ok(first && second, "both gates ran");
    assert.ok(second.start >= first.end, `the gates overlapped: ${JSON.stringify([first, second])}`);
    // The waiter named who held it, with the gate kind and since when.
    const log = readFileSync(`${record}.log`, "utf8");
    assert.match(log, /baseline gate waiting for the gate lock held by (harbour #489|atlas-workspace #928) \(baseline, pid \d+, since \d{4}-\d\d-\d\dT/);
    assert.equal(existsSync(lockPath), false, "the lock was left behind after both gates finished");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with `gateLock: false` the same two gates overlap, and the default is on", async () => {
  // The control for the test above: the sleep is long enough to overlap, so the
  // serialisation there is the lock's doing.
  assert.equal(gateLockEnabled({}), true);
  assert.equal(gateLockEnabled(undefined), true);
  assert.equal(gateLockEnabled({ gateLock: false }), false);
  const dir = scratch();
  try {
    const lockPath = join(dir, "gate.lock");
    const record = join(dir, "gates.jsonl");
    await Promise.all([
      fakeGate({ lockPath, root: dir, epic: "489", ms: 500, record, gateLock: false }),
      fakeGate({ lockPath, root: dir, epic: "928", ms: 500, record, gateLock: false }),
    ]);
    const [first, second] = intervals(record);
    assert.ok(second.start < first.end, "with the lock off the gates still ran one after the other");
    assert.equal(existsSync(lockPath), false, "a disabled lock wrote a lock file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead process is detected by pid and taken over", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "gate.lock");
    // A pid that certainly exited: a child we waited for.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(path, `${JSON.stringify({ pid: dead, project: "harbour", epic: "489", kind: "baseline", since: "2026-10-05T00:00:00.000Z", token: "dead" })}\n`);
    const waits = [];
    const lock = await acquireGateLock({ path, holder: { project: "here", kind: "fix" }, pollMs: 20, onWait: (holder) => waits.push(holder) });
    assert.equal(readGateHolder(path).pid, process.pid, "the dead holder's lock was not taken over");
    assert.deepEqual(waits, [], "a dead holder was waited on");
    lock.release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder killed mid-gate (SIGKILL, no cleanup ran) is taken over", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "gate.lock");
    const holder = holdGateLock(path); // holds forever
    await holder.held;
    assert.equal(readGateHolder(path).pid, holder.pid);
    holder.kill("SIGKILL");
    await holder.exited;
    assert.equal(existsSync(path), true, "fixture precondition: a SIGKILL leaves the lock file behind");
    const lock = await acquireGateLock({ path, holder: { project: "here", kind: "integration" }, pollMs: 20 });
    assert.equal(readGateHolder(path).pid, process.pid);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiting gate's time bound starts when it acquires the lock, and the wait is recorded", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "gate.lock");
    const holder = holdGateLock(path, { ms: 1500 });
    await holder.held;
    const lines = [];
    // Waits ~1.5s, then runs a 0.6s command under a 1s bound. Counted from the
    // gate's entry, the bound would have fired before the command even started.
    const started = Date.now();
    const outcome = await withGateLock(
      { root: dir, config: {}, epic: "183", kind: "baseline", path, pollMs: 20, heartbeatMs: 400, say: (line) => lines.push(line) },
      ({ lockWaitS }) => recordGate({ root: dir, kind: "baseline", commands: ["sleep 0.6"], lockWaitS, say: () => {} },
        () => runBaselineChecks({ commands: ["sleep 0.6"], cwd: dir, timeoutMs: 1000, heartbeatMs: 60_000, say: () => {} })),
    );
    assert.ok(Date.now() - started >= 1500, "the gate did not wait for the holder");
    assert.equal(outcome.ok, true, `the wait was counted against the bound: ${JSON.stringify(outcome.result ?? null)}`);
    // Once on entry, then at the heartbeat: ~1.5s at 400ms is 3 or more lines.
    const waiting = lines.filter((line) => line.includes("waiting for the gate lock held by other-repo #928 (baseline"));
    assert.ok(waiting.length >= 3, `expected the wait logged on entry and per heartbeat, got ${waiting.length}: ${lines.join(" | ")}`);
    const [event] = readFileSync(gateEventsPath(join(dir, ".afk")), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(event.lockWaitS >= 1, `the gate event did not carry the lock wait: ${JSON.stringify(event)}`);
    await holder.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung gate is still killed by its own bound, and the lock is released when it is", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "gate.lock");
    const outcome = await withGateLock({ root: dir, config: {}, kind: "baseline", path, say: () => {} },
      () => runBaselineChecks({ commands: ["sleep 30"], cwd: dir, timeoutMs: 300, say: () => {} }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.timedOut, true);
    assert.equal(existsSync(path), false, "a timed-out gate kept holding every other epic");
    await assert.rejects(withGateLock({ root: dir, config: {}, kind: "fix", path, say: () => {} }, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(path), false, "a gate that threw kept the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`afk status` says which project and epic a waiting gate is waiting on", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "gate.lock");
    mkdirSync(join(dir, ".afk"));
    writeFileSync(join(dir, ".afk", "state.json"), JSON.stringify({ dag: { epic: { id: "183" }, tasks: [] }, tasks: {} }));
    const holder = holdGateLock(path, { ms: 1200 });
    await holder.held;
    let entered;
    const entry = new Promise((done) => { entered = done; });
    const gate = withGateLock({ root: dir, config: {}, epic: "183", kind: "integration", path, pollMs: 20, say: () => entered() }, async () => {});
    await entry;
    const status = spawnSync(process.execPath, [join(scripts, "status.mjs")], { cwd: dir, encoding: "utf8" });
    assert.match(status.stdout, /waiting for gate lock held by other-repo #928 \(baseline gate, since /, status.stdout + status.stderr);
    assert.match(gateWaitLine(dir), /^waiting for gate lock held by other-repo #928/);
    await gate;
    assert.equal(gateWaitLine(dir), null, "the wait marker outlived the wait");
    assert.equal(existsSync(gateWaitPath(dir)), false);
    await holder.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the baseline, the post-merge checks and the closeout fix gate take the lock; lane checks do not", async () => {
  // The closeout fix gate, end to end: it waits for a held lock.
  const dir = scratch();
  try {
    const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-b", "main"); git("config", "user.email", "t@example.test"); git("config", "user.name", "T");
    writeFileSync(join(dir, ".gitignore"), ".afk/\n");
    git("add", "."); git("commit", "-m", "base");
    const before = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(dir, "fix.txt"), "fixed\n"); git("add", "."); git("commit", "-m", "fix");
    const lockDir = join(dir, ".afk", "lock");
    const previous = process.env.AFK_GATE_LOCK_DIR;
    process.env.AFK_GATE_LOCK_DIR = lockDir;
    try {
      const holder = holdGateLock(join(lockDir, "gate.lock"), { ms: 1200 });
      await holder.held;
      let ranAt = null;
      const lines = [];
      const startedAt = Date.now();
      const record = await runCloseoutGate({
        root: dir, config: { baselineChecks: ["true"] }, epicId: "183", headBefore: before, reuse: false,
        say: (line) => lines.push(line),
        runChecks: async () => { ranAt = Date.now(); return { ok: true, ran: [], skipped: [] }; },
      });
      assert.equal(record.status, "passed");
      assert.ok(ranAt - startedAt >= 1000, `the closeout fix gate ran ${ranAt - startedAt}ms in, while another epic held the lock`);
      assert.match(lines.join("\n"), /fix gate waiting for the gate lock held by other-repo #928/);
      await holder.exited;
    } finally {
      if (previous === undefined) delete process.env.AFK_GATE_LOCK_DIR;
      else process.env.AFK_GATE_LOCK_DIR = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The other two sites, by the call itself: each wraps its chain, and the
  // lane's check runner (worker.mjs) never reaches the lock. The baseline and
  // the post-merge gate are each driven end to end in baseline.test.mjs and
  // integration-merge.test.mjs.
  const read = (name) => readFileSync(join(scripts, name), "utf8");
  assert.match(read("auto.mjs"), /withGateLock\(\s*\{ root, config, epic: [^}]*kind: "baseline"/);
  assert.match(read("integrate.mjs"), /withGateLock\(\{ root, config, epic, kind: 'integration'/);
  assert.doesNotMatch(read("worker.mjs"), /gate-lock|withGateLock|acquireGateLock/, "a lane check took the machine-wide gate lock");
});

test("a takeover that raced past a dead holder never removes the live lock that replaced it", () => {
  // A dead, B already took over and holds the lock, C still acts on its stale
  // view of A, and D tries to create the lock while C is mid-takeover.
  const dir = scratch();
  try {
    const lockPath = join(dir, "gate.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "B" })}\n`);
    takeOver(lockPath, { token: "A" }, () => {
      try { writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "D" })}\n`, { flag: "wx" }); } catch {}
    });
    assert.equal(readGateHolder(lockPath)?.token, "B", "the live holder B lost its lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder whose pid now belongs to a different, later process is taken over, not waited on forever", async () => {
  // The holder crashed and its pid was reused by an unrelated live process: a
  // pid check alone would wait behind it for good.
  const dir = scratch();
  const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const lockPath = join(dir, "gate.lock");
    const crashedAt = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(lockPath, `${JSON.stringify({ pid: stranger.pid, token: "crashed", pidStartedAt: crashedAt })}\n`);
    const acquired = acquireGateLock({ path: lockPath, holder: { kind: "baseline" }, pollMs: 20 });
    const outcome = await Promise.race([acquired.then(() => "acquired"), new Promise((done) => setTimeout(() => done("still waiting"), 2_000))]);
    assert.equal(outcome, "acquired");
    (await acquired).release();
  } finally {
    stranger.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, holderPid, alive, reused] of [
  ["a dead holder", 999_999, () => false, false],
  ["a reused pid", process.pid + 1, () => true, true],
]) {
  test(`a waiter behind ${label} whose takeover is blocked by another's breaker yields to the event loop`, async () => {
    // A taker crashed holding `<lock>.break`. Until the breaker goes stale the
    // waiter cannot take over; it must sleep between tries, not spin.
    const dir = scratch();
    try {
      const lockPath = join(dir, "gate.lock");
      writeFileSync(lockPath, `${JSON.stringify({ pid: holderPid, token: "crashed", pidStartedAt: new Date(0).toISOString() })}\n`);
      writeFileSync(`${lockPath}.break`, "1\n");
      const aged = (Date.now() - 9_600) / 1000; // stale in about 400 ms
      utimesSync(`${lockPath}.break`, aged, aged);
      let checks = 0;
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 10);
      const lock = await acquireGateLock({
        path: lockPath, holder: { kind: "baseline" }, pollMs: 20,
        alive: () => { checks += 1; return alive(); },
        startedAt: () => (reused ? Date.now() : null),
      });
      clearInterval(timer);
      lock.release();
      assert.ok(ticks >= 5, `timers fired ${ticks} times during the wait`);
      assert.ok(checks < 200, `alive() ran ${checks} times during the wait`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a process start time is read under a non-English locale", () => {
  const before = process.env.LC_ALL;
  process.env.LC_ALL = "de_DE.UTF-8";
  try {
    const started = processStartedMs(process.pid);
    assert.ok(started !== null && Math.abs(started - (Date.now() - process.uptime() * 1000)) < 5_000, `start time read as ${started}`);
  } finally {
    if (before === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = before;
  }
});
