// scripts/cos.test.mjs — `afk cos`: the store, the register, the check-in and
// the stop summary (#227). Every test drives the `afk` CLI against a temporary
// HOME and AFK_COS_ROOT, with fakes for launchctl, herdr, gh,
// vercel-deploys-left and terminal-notifier on PATH. Nothing real is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

// Every allow line the probe asks for, so `cos start` passes it.
const ALLOW_ALL = [
  "Running `afk cos` (any subcommand) is allowed.",
  "Running `afk cos stop` is allowed.",
  "Running `afk land` is allowed.",
];

const fakeBin = (dir, name, body) => writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// A temp machine: HOME, a store root, and a bin dir of fakes ahead of PATH.
const machine = ({ allow = ALLOW_ALL, deploysLeft = "echo 7", gh = "echo '{}'", agents = "[]" } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "afk-cos-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow } }));
  const log = (name) => `echo "${name} $*" >> "${home}/calls.log"`;
  fakeBin(home, "launchctl", log("launchctl"));
  fakeBin(home, "herdr", `${log("herdr")}\necho '{"result":{"agents":${agents}}}'`);
  fakeBin(home, "gh", `${log("gh")}\n${gh}`);
  fakeBin(home, "vercel-deploys-left", deploysLeft);
  fakeBin(home, "terminal-notifier", log("terminal-notifier"));
  const env = {
    ...process.env,
    HOME: home,
    AFK_COS_ROOT: join(home, "cos"),
    AFK_GATE_LOCK_DIR: join(home, "gate-lock"),
    AFK_COS_PEERS: join(home, "peers.json"),
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  writeFileSync(env.AFK_COS_PEERS, "[]");
  const cos = (...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env, encoding: "utf8" });
  const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8") : "");
  const runDir = () => {
    const runs = readdirSync(env.AFK_COS_ROOT).filter((name) => existsSync(join(env.AFK_COS_ROOT, name, "run.json")));
    return join(env.AFK_COS_ROOT, runs.sort().at(-1));
  };
  const events = () => readFileSync(join(runDir(), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { home, env, cos, calls, runDir, events };
};

const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  // A killed child of a non-reaping pid 1 lingers as a zombie: dead, not alive.
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
};

test("start opens a run, installs the check-in agent and prints the hub URL", () => {
  const m = machine();
  const r = m.cos("start", "--mode=night", "226");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Hub: http:\/\/127\.0\.0\.1:4099/);
  const plist = readFileSync(join(m.home, "Library", "LaunchAgents", "com.afk-claude.cos-checkin.plist"), "utf8");
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>2700<\/integer>/, "night checks in every 45 min");
  assert.match(plist, /<string>cos<\/string>\s*<string>checkin<\/string>/);
  assert.match(m.calls(), /launchctl bootstrap gui\/\d+ .*com\.afk-claude\.cos-checkin\.plist/);
  const run = JSON.parse(readFileSync(join(m.runDir(), "run.json"), "utf8"));
  assert.equal(run.mode, "night");
  assert.deepEqual(run.epics, ["226"]);
  // A second start while one is open is refused.
  const again = m.cos("start", "--mode=day");
  assert.equal(again.status, 1);
  assert.match(again.stdout, /already open/);
});

test("day mode checks in every 25 minutes", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode", "day").status, 0);
  const plist = readFileSync(join(m.home, "Library", "LaunchAgents", "com.afk-claude.cos-checkin.plist"), "utf8");
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>1500<\/integer>/);
});

// Passes without the lock too (one O_APPEND line does not interleave on Linux);
// the next test is the one that proves the lock is honoured.
test("store: 20 concurrent `afk cos log` calls never interleave a line", async () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  // Long lines, so an unlocked writer would have room to interleave.
  const texts = Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + i).repeat(8_000));
  const codes = await Promise.all(texts.map((text) => new Promise((done) => {
    const child = spawn(process.execPath, [afk, "cos", "log", "--kind", "note", text], { env: m.env, stdio: "ignore" });
    child.on("exit", done);
  })));
  assert.deepEqual(codes, Array(20).fill(0));
  const raw = readFileSync(join(m.runDir(), "events.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  const logged = lines.map((line) => JSON.parse(line)).filter((event) => event.kind === "note" && event.text.length === 8_000);
  assert.equal(logged.length, 20);
  assert.deepEqual(logged.map((event) => event.text).sort(), texts.sort());
  for (const event of logged) assert.ok(!Number.isNaN(Date.parse(event.ts)), "the CLI stamps the time");
});

test("store: an append waits for a live lock holder and takes over a dead one", async () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const lock = join(m.runDir(), "events.lock");
  const count = () => m.events().filter((event) => event.text === "after the lock").length;
  // Held by this live test process: the append must wait.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }));
  const child = spawn(process.execPath, [afk, "cos", "log", "--kind=note", "after the lock"], { env: m.env, stdio: "ignore" });
  const exited = new Promise((done) => child.on("exit", done));
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(count(), 0, "nothing is appended while another writer holds the lock");
  rmSync(lock);
  assert.equal(await exited, 0);
  assert.equal(count(), 1);
  // Held by a pid that no longer exists: taken over, not waited on.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, token: "dead" }));
  assert.equal(m.cos("log", "--kind=note", "after the lock").status, 0);
  assert.equal(count(), 2);
});

test("store: a lock whose holder pid was reused is taken over, not waited on", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  // A live pid (this test) whose recorded start is an hour before its real one:
  // the writer that held the lock died and its pid went to another process.
  writeFileSync(join(m.runDir(), "events.lock"), JSON.stringify({
    pid: process.pid, token: "reused", pidStartedAt: new Date(Date.now() - process.uptime() * 1000 - 3_600_000).toISOString(),
  }));
  const began = Date.now();
  const r = m.cos("log", "--kind=note", "after a reused holder");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - began < 8_000, "no 10 s wait behind a reused pid");
  assert.equal(m.events().at(-1).text, "after a reused holder");
});

test("store: log refuses a kind it does not own and text it was not given", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  assert.equal(m.cos("log", "--kind=checkin", "x").status, 1);
  assert.equal(m.cos("log", "--kind=note").status, 1);
  const ok = m.cos("log", "--kind=owner_intervention", "The owner pasted the merge command");
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(m.events().at(-1).kind, "owner_intervention");
});

test("store: a hand-edited line is flagged by every reader, never skipped silently", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  appendFileSync(join(m.runDir(), "events.jsonl"), 'this is not json\n{"kind":"note","text":"no time"}\n{"ts":"2026-10-13T00:00:00Z","kind":"nonsense"}\n');
  for (const verb of ["checkin", "stop"]) {
    const r = m.cos(verb);
    assert.equal(r.status, 0, `${verb}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /STORE: flagged line \d+ of .*events\.jsonl: not JSON/, verb);
    assert.match(r.stdout, /STORE: flagged line \d+ of .*events\.jsonl: missing ts/, verb);
    assert.match(r.stdout, /STORE: flagged line \d+ of .*events\.jsonl: unknown kind "nonsense"/, verb);
  }
});

test("register: after stop no registered pid is alive", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const pids = [];
  for (const purpose of ["poll the PR", "watch the gate"]) {
    const r = m.cos("run", "--ttl=30", "--purpose", purpose, "--", "sleep", "300");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pid = Number(r.stdout.match(/registered pid (\d+)/)[1]);
    assert.ok(alive(pid), `pid ${pid} runs after \`cos run\``);
    pids.push(pid);
  }
  const registered = m.events().filter((event) => event.kind === "process");
  assert.deepEqual(registered.map((event) => event.pid), pids);
  for (const event of registered) {
    assert.equal(event.ttlMin, 30);
    assert.ok(event.startedAt && event.owner && event.purpose);
  }
  const s = m.cos("stop");
  assert.equal(s.status, 0, s.stdout + s.stderr);
  for (const pid of pids) assert.ok(!alive(pid), `pid ${pid} is gone after stop`);
  assert.match(s.stdout, /killed 2/);
  assert.match(m.calls(), /launchctl bootout gui\/\d+\/com\.afk-claude\.cos-checkin/);
  assert.ok(!existsSync(join(m.home, "Library", "LaunchAgents", "com.afk-claude.cos-checkin.plist")), "stop removes the agent");
  assert.equal(m.events().at(-1).kind, "stop");
});

test("register: a pid whose start time changed is not killed", (t) => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const r = m.cos("run", "--ttl=5", "--purpose=timer", "--", "sleep", "300");
  const pid = Number(r.stdout.match(/registered pid (\d+)/)[1]);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  // The recorded process started an hour before the live one: a reused pid.
  const path = join(m.runDir(), "events.jsonl");
  const rewritten = readFileSync(path, "utf8").split("\n").map((line) => {
    if (!line.includes('"kind":"process"')) return line;
    const event = JSON.parse(line);
    event.startedAt = new Date(Date.parse(event.startedAt) - 3_600_000).toISOString();
    return JSON.stringify(event);
  }).join("\n");
  writeFileSync(path, rewritten);
  const s = m.cos("stop");
  assert.equal(s.status, 0, s.stdout);
  assert.ok(alive(pid), "a reused pid is never killed");
  assert.match(s.stdout, new RegExp(`refused pid ${pid}: start time changed`));
  assert.match(s.stdout, /refused 1/);
});

const sleepers = (tag) => spawnSync("pgrep", ["-x", "-f", `sleep ${tag}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number).filter(alive);

test("register: stop kills the whole process group, even after its leader exited", async (t) => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const tag = String(4000 + Math.floor(Math.random() * 900000));
  t.after(() => { for (const pid of sleepers(tag)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const r = m.cos("run", "--ttl=5", "--purpose=bg", "--", "sh", "-c", `sleep ${tag} & exit 0`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const leader = Number(r.stdout.match(/registered pid (\d+)/)[1]);
  for (let i = 0; i < 50 && alive(leader); i += 1) await new Promise((done) => setTimeout(done, 100));
  assert.ok(!alive(leader), "the leader exited");
  assert.equal(sleepers(tag).length, 1, "its child still runs in the group");
  const s = m.cos("stop");
  assert.equal(s.status, 0, s.stdout);
  assert.deepEqual(sleepers(tag), [], `no member of the group survives stop:\n${s.stdout}`);
  assert.match(s.stdout, /killed 1/);
});

test("register: a `cos run` that loses the race to `cos stop` kills its process and registers nothing", async (t) => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const tag = String(4000 + Math.floor(Math.random() * 900000));
  t.after(() => { for (const pid of sleepers(tag)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const lock = join(m.runDir(), "events.lock");
  // Hold the store lock, start `cos run`, and close the run while it waits:
  // exactly what a `cos stop` landing between its spawn and its append does.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }));
  const child = spawn(process.execPath, [afk, "cos", "run", "--ttl=5", "--purpose=late", "--", "sleep", tag], { env: m.env });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((done) => child.on("exit", done));
  for (let i = 0; i < 100 && sleepers(tag).length === 0; i += 1) await new Promise((done) => setTimeout(done, 100));
  appendFileSync(join(m.runDir(), "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind: "stop", killed: [], gone: [], refused: [], survived: [], ownerInterventions: 0 })}\n`);
  rmSync(lock);
  assert.equal(await exited, 1, out);
  assert.match(out, /closed/);
  assert.deepEqual(sleepers(tag), [], "the process it started is killed");
  const events = readFileSync(join(m.runDir(), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!events.some((event) => event.kind === "process"), "nothing is registered into the closed run");
});

test("register: a process registered while `cos stop` waits for the lock is still killed", async (t) => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const tag = String(4000 + Math.floor(Math.random() * 900000));
  t.after(() => { for (const pid of sleepers(tag)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const lock = join(m.runDir(), "events.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }));
  const stop = spawn(process.execPath, [afk, "cos", "stop"], { env: m.env });
  let out = "";
  stop.stdout.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((done) => stop.on("exit", done));
  // Let stop read the (empty) register and block on the lock.
  await new Promise((done) => setTimeout(done, 3_000));
  const late = spawn("sleep", [tag], { detached: true, stdio: "ignore" });
  late.unref();
  const started = Date.parse(spawnSync("ps", ["-o", "lstart=", "-p", String(late.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim());
  appendFileSync(join(m.runDir(), "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind: "process", pid: late.pid, startedAt: new Date(started).toISOString(), owner: "t", purpose: "late", ttlMin: 5, cmd: ["sleep", tag], log: "/dev/null" })}\n`);
  rmSync(lock);
  assert.equal(await exited, 0, out);
  assert.deepEqual(sleepers(tag), [], `stop re-reads the register under the lock:\n${out}`);
});

test("stop prints the owner_intervention count from the store", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  for (const text of ["asked for status", "pasted gh pr merge", "typed the salvage"]) {
    assert.equal(m.cos("log", "--kind=owner_intervention", text).status, 0);
  }
  assert.equal(m.cos("log", "--kind=note", "not an intervention").status, 0);
  const s = m.cos("stop");
  assert.equal(s.status, 0, s.stdout);
  assert.match(s.stdout, /owner interventions: 3/);
  assert.equal(m.events().at(-1).ownerInterventions, 3);
});

test("verbs that need a run refuse when none is open", () => {
  const m = machine();
  for (const args of [["log", "--kind=note", "x"], ["run", "--ttl=1", "--purpose=x", "--", "true"]]) {
    const r = m.cos(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout, /no afk cos run is open/);
  }
});

test("`afk cos run` refuses without a TTL, a purpose or a command", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=day").status, 0);
  assert.equal(m.cos("run", "--purpose=x", "--", "true").status, 1);
  assert.equal(m.cos("run", "--ttl=5", "--", "true").status, 1);
  assert.equal(m.cos("run", "--ttl=5", "--purpose=x").status, 1);
  assert.equal(m.events().filter((event) => event.kind === "process").length, 0);
});

test("start refuses when a planned verb has no standing allow line", () => {
  const m = machine({ allow: ["Running `afk cos` (any subcommand) is allowed."] });
  const r = m.cos("start", "--mode=day");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /afk cos stop/);
  assert.match(r.stdout, /afk land/);
  assert.ok(!existsSync(m.env.AFK_COS_ROOT) || readdirSync(m.env.AFK_COS_ROOT).length === 0, "no run is opened");
});

// --- check-in -------------------------------------------------------------

// Five runs: one at a gate, one finished, one stalled, one with a red Vercel
// deploy, one healthy. Each is a checkout with its own .afk/state.json.
const fixtureRuns = (m) => {
  const run = (name, state, { status = "running", logAgeMin = 1 } = {}) => {
    const root = join(m.home, "runs", name);
    mkdirSync(join(root, ".afk"), { recursive: true });
    writeFileSync(join(root, ".afk", "state.json"), JSON.stringify(state));
    writeFileSync(join(root, ".afk", "agent-auto.log"), "x\n");
    const when = (Date.now() - logAgeMin * 60_000) / 1000;
    utimesSync(join(root, ".afk", "agent-auto.log"), when, when);
    return { ok: true, root, port: 4100 + name.length, project: name, epic: state.dag.epic, branch: state.dag.branch, status };
  };
  const dag = (epic, tasks) => ({ epic, branch: `feat/${epic}`, tasks });
  const peers = [
    run("run-gate", { dag: dag("301", [{ id: "1" }]), tasks: { 1: { lifecycle: "awaiting_acceptance" } } }),
    run("run-done", { dag: dag("302", [{ id: "1" }]), tasks: { 1: { lifecycle: "passed" } }, epicClose: { lifecycle: "closed", outcome: "completed" } }, { status: "idle" }),
    run("run-stall", { dag: dag("303", [{ id: "1" }]), tasks: { 1: { lifecycle: "running" } } }, { status: "stale" }),
    run("run-red", { dag: dag("304", [{ id: "1" }]), tasks: { 1: { lifecycle: "running" } } }),
    run("run-fine", { dag: dag("305", [{ id: "1" }]), tasks: { 1: { lifecycle: "running" } } }),
  ];
  writeFileSync(m.env.AFK_COS_PEERS, JSON.stringify(peers));
  return peers;
};

const RED_VERCEL_GH = `case "$PWD" in
  *run-red*) echo '{"number":4,"state":"OPEN","url":"u","statusCheckRollup":[{"__typename":"StatusContext","context":"Vercel","state":"FAILURE"}]}';;
  *) echo '{"number":1,"state":"OPEN","url":"u","statusCheckRollup":[{"__typename":"CheckRun","name":"test","conclusion":"SUCCESS","status":"COMPLETED"}]}';;
esac`;

test("check-in: one checkin event with the expected fields, and notifications only on the four triggers", () => {
  const m = machine({ gh: RED_VERCEL_GH, deploysLeft: "echo 12" });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  fixtureRuns(m);
  const before = m.events().length;
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const added = m.events().slice(before);
  assert.equal(added.length, 1, "exactly one event");
  const [event] = added;
  assert.equal(event.kind, "checkin");
  assert.ok(event.ts);
  assert.equal(event.deploysLeft, 12);
  assert.equal(event.gateLock, null);
  assert.ok(Array.isArray(event.orchestrators));
  const byEpic = Object.fromEntries(event.runs.map((run) => [run.epic, run]));
  assert.deepEqual(Object.keys(byEpic).sort(), ["301", "302", "303", "304", "305"]);
  for (const run of event.runs) for (const field of ["root", "port", "status", "gates", "stalled", "finished", "pr", "deploy"]) {
    assert.ok(field in run, `run ${run.epic} has ${field}`);
  }
  assert.deepEqual(byEpic["301"].gates, ["1"]);
  assert.equal(byEpic["302"].finished, true);
  assert.equal(byEpic["303"].stalled, true);
  assert.equal(byEpic["304"].deploy, "red");
  assert.equal(byEpic["305"].deploy, "none");
  assert.equal(byEpic["304"].pr.number, 4);
  assert.deepEqual(
    event.triggers.map((trigger) => `${trigger.kind}:${trigger.epic}`).sort(),
    ["finished:302", "gate:301", "red_deploy:304", "stall:303"],
  );
  const notified = m.calls().split("\n").filter((line) => line.startsWith("terminal-notifier"));
  assert.equal(notified.length, 4, m.calls());
  // The check-in never messages a session.
  assert.ok(!/herdr agent prompt/.test(m.calls()), m.calls());
  // Nothing changed: the next check-in notifies nothing new.
  assert.equal(m.cos("checkin").status, 0);
  assert.equal(m.calls().split("\n").filter((line) => line.startsWith("terminal-notifier")).length, 4);
});

// #277: a run whose dashboard failed to start is listed "no dashboard", not
// "running". It is a live run all the same, and a log that stopped moving is a
// stall, which the check-in only checked for "running".
test("check-in: a \"no dashboard\" run whose log stopped moving raises the stall trigger", () => {
  const m = machine({ deploysLeft: "echo 12" });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const run = (name, epic, logAgeMin) => {
    const root = join(m.home, "runs", name);
    mkdirSync(join(root, ".afk"), { recursive: true });
    writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({
      dag: { epic, branch: `feat/${epic}`, tasks: [{ id: "1" }] }, tasks: { 1: { lifecycle: "running" } },
      dashboard: null, dashboardSkipped: { at: new Date().toISOString(), reason: "Dashboard failed to start" },
    }));
    writeFileSync(join(root, ".afk", "agent-auto.log"), "x\n");
    const when = (Date.now() - logAgeMin * 60_000) / 1000;
    utimesSync(join(root, ".afk", "agent-auto.log"), when, when);
    return { ok: true, root, port: null, project: name, epic, branch: `feat/${epic}`, status: "no dashboard" };
  };
  writeFileSync(m.env.AFK_COS_PEERS, JSON.stringify([run("run-quiet", "311", 60), run("run-moving", "312", 1)]));
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [event] = m.events().filter((e) => e.kind === "checkin");
  const byEpic = Object.fromEntries(event.runs.map((x) => [x.epic, x]));
  assert.equal(byEpic["311"].status, "no dashboard", "fixture precondition: the peer reads as no dashboard");
  assert.equal(byEpic["311"].stalled, true, "a no-dashboard run with a 60-minute-old log is not flagged stalled");
  assert.equal(byEpic["312"].stalled, false);
  assert.deepEqual(event.triggers.map((trigger) => `${trigger.kind}:${trigger.epic}`), ["stall:311"]);
});

// The hub demo, scenario 3: atlas#1232's dashboard died after the night
// began. The hub listed it (from the store's roots) as not answering; the
// check-in read only the sweep, counted 2 runs, and never said a word.
test("check-in: a run the store knows whose dashboard does not answer is counted and flagged not_answering, once", async () => {
  const m = machine({ deploysLeft: "echo 12" });
  const { freePort } = await import("./free-port.mjs");
  const known = (name, port, extra = {}) => {
    const root = join(m.home, "runs", name);
    mkdirSync(join(root, ".afk"), { recursive: true });
    writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ dag: { epic: name.replace(/\D/g, ""), branch: `feat/${name}`, tasks: [] }, tasks: {}, dashboard: { port, pid: 1 }, ...extra }));
    return { ok: true, root, port, project: name, epic: name.replace(/\D/g, ""), status: "running" };
  };
  const down = known("atlas1232", await freePort());
  const closed = known("done777", await freePort(), { epicClose: { lifecycle: "closed", outcome: "completed" } });
  // Both answered when the night started, so `cos start` adopted them.
  writeFileSync(m.env.AFK_COS_PEERS, JSON.stringify([down, closed]));
  assert.equal(m.cos("start", "--mode=night").status, 0);
  // Then both dashboards stopped: the sweep no longer finds either.
  writeFileSync(m.env.AFK_COS_PEERS, "[]");
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  console.log(r.stdout.trim());
  const event = m.events().at(-1);
  const byEpic = Object.fromEntries(event.runs.map((run) => [run.epic, run]));
  assert.deepEqual(Object.keys(byEpic).sort(), ["1232", "777"], JSON.stringify(event.runs));
  assert.equal(byEpic["1232"].status, "not answering");
  assert.deepEqual(event.triggers.map((t) => `${t.kind}:${t.epic}`).sort(), ["finished:777", "not_answering:1232"]);
  assert.ok(event.notified.includes(`not_answering:${down.root}:`), JSON.stringify(event.notified));
  assert.match(r.stdout, /COS: not_answering #1232 \(notified\)/);
  const notifications = () => m.calls().split("\n").filter((line) => line.startsWith("terminal-notifier"));
  assert.ok(notifications().some((line) => /#1232 dashboard not answering/.test(line)), m.calls());
  const count = notifications().length;
  assert.equal(m.cos("checkin").status, 0);
  assert.equal(notifications().length, count, "an unchanged not_answering notified again");
});

test("start adopts a running peer whose epic is {id, title} by its id", () => {
  const m = machine();
  writeFileSync(m.env.AFK_COS_PEERS, JSON.stringify([{ ok: true, root: join(m.home, "runs", "x"), port: 4107, epic: { id: "27", title: "x" }, status: "running" }]));
  const r = m.cos("start", "--mode=day");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /adopted running epic 27 at /);
  assert.deepEqual(JSON.parse(readFileSync(join(m.runDir(), "run.json"), "utf8")).adopted.map((a) => a.epic), ["27"]);
});

test("check-in: an epic recorded as {id, title} is its id in the run row and the gate trigger", () => {
  const m = machine({ gh: RED_VERCEL_GH, deploysLeft: "echo 12" });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const root = join(m.home, "runs", "run-obj");
  mkdirSync(join(root, ".afk"), { recursive: true });
  const epic = { id: "27", title: "x" };
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ dag: { epic, branch: "feat/27", tasks: [{ id: "33" }] }, tasks: { 33: { lifecycle: "awaiting_acceptance" } } }));
  writeFileSync(m.env.AFK_COS_PEERS, JSON.stringify([{ ok: true, root, port: 4107, project: "run-obj", epic, branch: "feat/27", status: "running" }]));
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const event = m.events().at(-1);
  assert.deepEqual(event.runs.map((run) => run.epic), ["27"]);
  assert.deepEqual(event.triggers.map((trigger) => `${trigger.kind}:${trigger.epic}`), ["gate:27"]);
  assert.doesNotMatch(m.calls(), /object Object/);
});

test("check-in: a Vercel deploy cap is `deploy_cap`, never `red`, and does not notify", () => {
  const m = machine({ gh: RED_VERCEL_GH, deploysLeft: "echo 0" });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  fixtureRuns(m);
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const event = m.events().at(-1);
  assert.equal(event.deploysLeft, 0);
  const red = event.runs.find((run) => run.epic === "304");
  assert.equal(red.deploy, "deploy_cap");
  assert.ok(!event.runs.some((run) => run.deploy === "red"));
  assert.ok(!event.triggers.some((trigger) => trigger.kind === "red_deploy"));
});

test("check-in: a failing vercel-deploys-left is recorded as unknown and the check-in still succeeds", () => {
  const m = machine({ gh: RED_VERCEL_GH, deploysLeft: "echo 'token expired' >&2; exit 1" });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  fixtureRuns(m);
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const event = m.events().at(-1);
  assert.equal(event.kind, "checkin");
  assert.equal(event.deploysLeft, "unknown");
  // Unknown is not a cap: a red deploy stays red.
  assert.equal(event.runs.find((run) => run.epic === "304").deploy, "red");
});

test("check-in: each Orchestrator's idle age comes from herdr and its transcript", () => {
  const m = machine({ agents: '[{"name":"orch-301","agent_status":"idle","agent_session":{"value":"sess-301"}}]' });
  assert.equal(m.cos("start", "--mode=day").status, 0);
  const profiles = join(m.home, ".afk-claude", "orchestrators");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, "orch-301.settings.json"), "{}");
  writeFileSync(join(profiles, "orch-302.settings.json"), "{}");
  writeFileSync(join(profiles, "owner-settings.json"), "{}");
  const project = join(m.home, ".claude", "projects", "-x");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "sess-301.jsonl"), "{}\n");
  const when = (Date.now() - 30 * 60_000) / 1000;
  utimesSync(join(project, "sess-301.jsonl"), when, when);
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(m.events().at(-1).orchestrators, [
    { name: "orch-301", status: "idle", idleMin: 30 },
    { name: "orch-302", status: "absent", idleMin: null },
  ]);
});

// --- verbs owned by later tickets ---------------------------------------------

// `fate` (#228), `land` (#228) and `hub` (#229) are built; their own test files
// cover them. Here only the dispatcher's side: each is registered with the flags
// #227 gave it, and none still says "not built yet". Every call takes a path
// that exits before the script does any work: `--help` and an unknown flag are
// answered by afk.mjs itself, and the usage paths stop before `gh` or a port.
// A bare `afk hub` would serve on the real 4099 and never exit.
test("`afk fate`, `afk land` and `afk hub` are built and registered with their flags", () => {
  const m = machine({ gh: "exit 1" });
  const run = (...args) => spawnSync(process.execPath, [afk, ...args], { env: m.env, encoding: "utf8", timeout: 20_000 });
  const registered = {
    fate: ["epic", "finding", "accepted", "fixed", "dropped", "reason", "by"],
    land: ["repo", "dry-run"],
    hub: ["port", "out", "url", "in", "snapshot"],
  };
  for (const [verb, flags] of Object.entries(registered)) {
    // `--port=0` makes hub.mjs refuse before it listens, should afk.mjs ever
    // stop refusing the unknown flag first.
    const refused = run(verb, ...(verb === "hub" ? ["--port=0"] : []), "--not-a-flag");
    assert.equal(refused.status, 1, `${verb}: ${refused.stdout}${refused.stderr}`);
    const accepted = refused.stdout.match(/Accepted: (.*)\./)?.[1].split(", ").map((flag) => flag.replace(/^--/, ""));
    assert.deepEqual(accepted?.sort(), [...flags].sort(), `${verb}: ${refused.stdout}`);

    const help = run(verb, "--help");
    assert.equal(help.status, 0, `${verb} --help: ${help.stdout}`);
    assert.doesNotMatch(help.stdout, /not\s+built\s+yet/i, `${verb} --help`);
    for (const flag of flags) assert.ok(help.stdout.includes(`--${flag}`), `${verb} --help names --${flag}: ${help.stdout}`);
  }
  for (const argv of [["fate"], ["land"], ["hub", "no-such-verb"]]) {
    const r = run(...argv);
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /not built yet/i, argv.join(" "));
    assert.match(r.stdout, /usage|unknown verb/i, argv.join(" "));
  }
  assert.doesNotMatch(m.calls(), /^gh /m, "no path above reached gh");
});

// cos-night-2026-10-13: the morning report lived only in chat, and an
// Orchestrator waiting on the chief of staff read as idle for 67 minutes.
test("report: --file stores report.md in the open run, a second call replaces it, --append adds an Addendum heading", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  const md = join(m.home, "report.md");
  writeFileSync(md, "Two epics parked at their gates.\n\n## atlas#1232\nOwed: run test:live-db.\n");
  const first = m.cos("report", `--file=${md}`);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const stored = join(m.runDir(), "report.md");
  assert.equal(readFileSync(stored, "utf8"), "Two epics parked at their gates.\n\n## atlas#1232\nOwed: run test:live-db.\n");
  assert.ok(first.stdout.includes(`stored the report at ${stored}`), first.stdout);
  writeFileSync(md, "Replaced.\n");
  assert.equal(m.cos("report", `--file=${md}`).status, 0);
  assert.equal(readFileSync(stored, "utf8"), "Replaced.\n");
  const report = m.events().filter((e) => e.kind === "report");
  assert.equal(report.length, 2);
  assert.equal(report[0].append, false);
  assert.deepEqual(report[0].sections, ["atlas#1232"]);
  // After stop the run is closed; an addendum still lands in it, the most recent run.
  assert.equal(m.cos("stop").status, 0);
  writeFileSync(md, "stopped: still alive 0\n");
  const later = m.cos("report", `--file=${md}`, "--append");
  assert.equal(later.status, 0, later.stdout);
  assert.match(readFileSync(stored, "utf8"), /^Replaced\.\n\n## Addendum \d{4}-\d\d-\d\dT[\d:.]+Z\n\nstopped: still alive 0\n$/);
  assert.equal(m.events().at(-1).kind, "report");
  assert.equal(m.events().at(-1).append, true);
});

test("report: --append with no report.md yet stores the file as the report, and a heading may carry text after the epic", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  const md = join(m.home, "report.md");
  writeFileSync(md, "Summary.\n\n## atlas#1232 — parked at #1238\nOwed: test:live-db.\n");
  const r = m.cos("report", `--file=${md}`, "--append");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readFileSync(join(m.runDir(), "report.md"), "utf8"), "Summary.\n\n## atlas#1232 — parked at #1238\nOwed: test:live-db.\n");
  assert.deepEqual(m.events().at(-1).sections, ["atlas#1232"]);
});

test("report: refuses without --file, with an empty file, and when no run was ever opened", () => {
  const m = machine();
  const md = join(m.home, "report.md");
  writeFileSync(md, "x\n");
  const none = m.cos("report", `--file=${md}`);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no afk cos run exists/);
  assert.equal(m.cos("start", "--mode=day").status, 0);
  assert.match(m.cos("report").stdout, /report needs --file=<path\.md>/);
  writeFileSync(md, "  \n");
  assert.match(m.cos("report", `--file=${md}`).stdout, /is empty/);
  assert.equal(existsSync(join(m.runDir(), "report.md")), false);
});

test("ask --from: an Orchestrator's open question needs no options, checkin prints it first with its age, and answer closes it", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  // The owner-ask rule is unchanged: no --from, no two options, no ask.
  assert.match(m.cos("ask", "--id=owner-q", "--title=Merge?").stdout, /at least two --option/);
  const at = (iso, ...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env: { ...m.env, AFK_COS_NOW: iso }, encoding: "utf8" });
  const asked = at("2026-10-14T00:03:00Z", "ask", "--id=go-1232", "--title=Is #1237 settled, may I launch?", "--from=orch-1232");
  assert.equal(asked.status, 0, asked.stdout);
  assert.match(asked.stdout, /asked cos:go-1232 from orch-1232/);
  const event = m.events().at(-1);
  assert.equal(event.from, "orch-1232");
  assert.deepEqual(event.options, []);
  const check = at("2026-10-14T01:10:00Z", "checkin");
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const lines = check.stdout.trim().split("\n");
  assert.match(lines[0], /^COS: orch-1232 has waited 67 min on the chief of staff: cos:go-1232 "Is #1237 settled, may I launch\?"\. Answer with `afk cos answer --id=go-1232 "<text>"`\.$/);
  assert.match(lines[1], /^COS: check-in /);
  assert.match(m.cos("answer", "--id=nope", "yes").stdout, /no question nope/);
  assert.match(m.cos("answer", "--id=go-1232").stdout, /answer needs the text/);
  const answered = at("2026-10-14T01:11:00Z", "answer", "--id=go-1232", "Yes, launch.");
  assert.equal(answered.status, 0, answered.stdout);
  assert.deepEqual(
    (({ kind, id, text, from }) => ({ kind, id, text, from }))(m.events().at(-1)),
    { kind: "answer", id: "go-1232", text: "Yes, launch.", from: "orch-1232" },
  );
  assert.match(m.cos("answer", "--id=go-1232", "again").stdout, /already answered/);
  assert.doesNotMatch(m.cos("checkin").stdout, /waited/);
});

test("answer: an Orchestrator ask left open at `afk cos stop` can still be closed", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  assert.equal(m.cos("ask", "--id=late", "--title=Park it?", "--from=orch-583").status, 0);
  assert.equal(m.cos("stop").status, 0);
  const r = m.cos("answer", "--id=late", "Yes, parked.");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(m.events().at(-1).kind, "answer");
});

test("answer: refuses an owner ask (no --from); the owner answers it in the hub", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  assert.equal(m.cos("ask", "--id=merge", "--title=Merge #9?", "--option=y|Yes", "--option=n|No").status, 0);
  const r = m.cos("answer", "--id=merge", "cos decided yes");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /merge is the owner's question.*answered in the hub/);
  assert.equal(m.events().at(-1).kind, "ask", "no answer event was written");
});

test("epicRoot: a single recorded root counts only when its project, basename or origin remote names the section's repo", async () => {
  const { epicRoot } = await import("./cos/report.mjs");
  const riverbend = { events: [{ kind: "checkin", runs: [{ root: "/Users/s/code/riverbend", project: "riverbend", epic: "100" }] }] };
  assert.equal(epicRoot(riverbend, { repo: "atlas", epic: "100" }), null);
  assert.equal(epicRoot(riverbend, { repo: "riverbend", epic: "100" }), "/Users/s/code/riverbend");
  const root = join(mkdtempSync(join(tmpdir(), "afk-cos-root-")), "epic", "1232", "atlas-workspace");
  mkdirSync(root, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:owner/atlas.git"]);
  const atlas = { meta: { adopted: [{ root, project: "atlas-workspace", epic: "1232" }] }, events: [] };
  assert.equal(epicRoot(atlas, { repo: "atlas", epic: "1232" }), root);
  assert.equal(epicRoot(atlas, { repo: "harbour", epic: "1232" }), null);
});

// Fable review of feat/cos-report-hub: a heading with a colon after the epic
// or an owner prefix fell into the summary, so its epic got no card.
test("parseReport: a heading may put a colon, dash or bracket after the epic, or an owner/ prefix before the repo", async () => {
  const { parseReport } = await import("./cos/report.mjs");
  const parsed = parseReport([
    "Summary.",
    "## atlas#1232: parked at #1238",
    "a",
    "## harbour#583 — done",
    "b",
    "## owner/riverbend#72",
    "c",
    "## open-seo#9(parked)",
    "d",
    "## Advisor trial",
    "e",
  ].join("\n"));
  assert.deepEqual(parsed.sections.map(({ key, repo, epic }) => ({ key, repo, epic })), [
    { key: "atlas#1232", repo: "atlas", epic: "1232" },
    { key: "harbour#583", repo: "harbour", epic: "583" },
    { key: "riverbend#72", repo: "riverbend", epic: "72" },
    { key: "open-seo#9", repo: "open-seo", epic: "9" },
  ]);
  assert.equal(parsed.sections[0].text, "## atlas#1232: parked at #1238\na");
  assert.equal(parsed.summary, "Summary.\n## Advisor trial\ne");
  assert.deepEqual(parsed.stray, []);
  // A word character after the number is not an epic: atlas#12a stays text.
  assert.deepEqual(parseReport("## atlas#12a\n").sections, []);
});

test("parseReport: a ## line naming #<digits> that is no section is stray; `## riverbend #72` (space before #) is stray, not a card", async () => {
  const { parseReport } = await import("./cos/report.mjs");
  const parsed = parseReport("S.\n## riverbend #72\nx\n## Advisor trial, see #1238\n```\n## atlas #1\n```\n## Addendum 2026-10-14T07:00:00.000Z\n");
  assert.deepEqual(parsed.sections, []);
  assert.deepEqual(parsed.stray, ["## riverbend #72", "## Advisor trial, see #1238"]);
});

test("epicRoot resolves a section parsed from an owner-prefixed heading", async () => {
  const { epicRoot, parseReport } = await import("./cos/report.mjs");
  const [section] = parseReport("## owner/riverbend#100: done\n").sections;
  const run = { events: [{ kind: "checkin", runs: [{ root: "/Users/s/code/riverbend", project: "riverbend", epic: "100" }] }] };
  assert.equal(epicRoot(run, section), "/Users/s/code/riverbend");
});

test("report: warns for every ## heading that names #<digits> but opens no section, and still stores the file", () => {
  const m = machine();
  assert.equal(m.cos("start", "--mode=night").status, 0);
  const md = join(m.home, "report.md");
  writeFileSync(md, "S.\n\n## atlas#1232: parked\nx\n## riverbend #72\ny\n## Advisor trial #2\n");
  const r = m.cos("report", `--file=${md}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /sections: atlas#1232\)/);
  const warnings = r.stdout.split("\n").filter((line) => line.includes("names no epic section"));
  assert.deepEqual(warnings, [
    'COS: heading "## riverbend #72" names no epic section; write it as "## <repo>#<epic>"',
    'COS: heading "## Advisor trial #2" names no epic section; write it as "## <repo>#<epic>"',
  ]);
});

test("#274: start prints the saved hub artifact URL, and the not-set line when none is saved", () => {
  const m = machine();
  const first = m.cos("start", "--mode=day");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /^hub artifact: not set \(afk hub artifact --url <url>\)$/m);
  assert.equal(m.cos("stop").status, 0);
  const url = "https://claude.ai/artifact/VFXc9gP9P2QUeDpjA9YMe2";
  const saved = spawnSync(process.execPath, [afk, "hub", "artifact", "--url", url], { env: m.env, encoding: "utf8" });
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  // Machine-wide, beside the runs, not inside one.
  assert.equal(JSON.parse(readFileSync(join(m.env.AFK_COS_ROOT, "hub-artifact.json"), "utf8")).url, url);
  const second = m.cos("start", "--mode=night");
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, new RegExp(`^hub artifact: ${url}$`, "m"));
  const bad = spawnSync(process.execPath, [afk, "hub", "artifact", "--url", "https://example.com/x"], { env: m.env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /is not a claude\.ai artifact URL/);
});
