// scripts/hub.test.mjs — `afk hub` (#229): the run list, annotate-and-send,
// the queue and the request guard. Every test drives the `afk` CLI against a
// temporary HOME and AFK_COS_ROOT, with a fake `herdr` and fake `launchctl` on
// PATH, and fake dashboards answering `/health` on ports the kernel picked.
// Nothing real is touched: no port 4099, no real store, no real session.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./free-port.mjs";
import { recordNoDashboard } from "./hub/runs.mjs";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

const fakeBin = (home, name, body) => writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// One transcript per session id, aged `ageMin` minutes: the cold guard and the
// hub's target states both read idle age from the transcript's last write.
const transcript = (home, sessionId, ageMin) => {
  const dir = join(home, ".claude", "projects", "-fixture");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, "{}\n");
  const when = (Date.now() - ageMin * 60_000) / 1000;
  utimesSync(file, when, when);
};

// A temp machine. `agents` is herdr's agent list: [{name, ageMin}] (ageMin
// null = no transcript). Each agent also gets an Orchestrator profile, which
// is how the hub and the check-in learn the Orchestrator names.
const machine = ({ agents = [] } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "afk-hub-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  const orchestrators = join(home, ".afk-claude", "orchestrators");
  mkdirSync(orchestrators, { recursive: true });
  const list = agents.map(({ name, ageMin }) => {
    writeFileSync(join(orchestrators, `${name}.settings.json`), "{}");
    if (ageMin != null) transcript(home, `sess-${name}`, ageMin);
    return { name, workspace_id: `w-${name}`, agent_status: "idle", agent_session: { value: `sess-${name}` } };
  });
  writeFileSync(join(home, "agents.json"), JSON.stringify({ result: { agents: list } }));
  // `agent prompt` fails for a name with a prompt-fail-<name> file, and waits
  // while a prompt-hold file exists, so a test can look at the store mid-send.
  fakeBin(home, "herdr", `echo "herdr $*" >> "${home}/calls.log"
case "$1 $2" in
  "agent list") [ -f "${home}/list-slow" ] && sleep 3; cat "${home}/agents.json";;
  "agent get") echo '{}';;
  "agent prompt")
    [ -f "${home}/prompt-fail-$3" ] && { echo 'agent_not_ready' >&2; exit 1; }
    while [ -f "${home}/prompt-hold" ]; do sleep 0.05; done
    echo "landed $3" >> "${home}/calls.log"
    echo '{"result":{"ok":true}}';;
  *) echo '{}';;
esac`);
  fakeBin(home, "launchctl", `echo "launchctl $*" >> "${home}/calls.log"`);
  const env = {
    ...process.env,
    HOME: home,
    AFK_COS_ROOT: join(home, "cos"),
    AFK_HUB_PEER_PORTS: "",
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  delete env.AFK_COS_PEERS;
  delete env.AFK_USAGE_CREDITS;
  const hub = (...args) => spawnSync(process.execPath, [afk, "hub", ...args], { env, encoding: "utf8" });
  const cos = (...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env, encoding: "utf8" });
  const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8") : "");
  const inbox = () => {
    const path = join(env.AFK_COS_ROOT, "inbox", "events.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  return { home, env, hub, cos, calls, inbox };
};

// Start `afk hub --port=<free>` and resolve once it says where it listens.
const startHub = async (m, extraEnv = {}, port) => {
  port ??= await freePort();
  // Its own process group: `afk` runs scripts/hub.mjs as a child, and stopping
  // only the parent would leave the server holding the port and the pipes.
  const child = spawn(process.execPath, [afk, "hub", `--port=${port}`], { env: { ...m.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { /* gone */ } };
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 10_000;
  while (!/Hub: http:\/\/127\.0\.0\.1:\d+/.test(out)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      killGroup("SIGKILL");
      throw new Error(`afk hub did not start (exit ${child.exitCode}):\n${out}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.doesNotMatch(out, /not built yet/);
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(`${base}/`)).text();
  const token = page.match(/<meta name="afk-hub-token" content="([^"]+)"/)?.[1];
  const stop = async () => { killGroup("SIGTERM"); await exited; };
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-afk-hub-token": token, ...headers },
    body: JSON.stringify(body),
  });
  const crash = async () => { killGroup("SIGKILL"); await exited; };
  return { port, base, page, token, stop, crash, post, output: () => out };
};

// A fake dashboard: answers `/health` the way dashboard-server.mjs does.
const fakeDashboard = async (health) => {
  const server = createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, port: server.address().port, ...health }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
};

// A checkout whose .afk/state.json records its dashboard port, as auto.mjs does.
const checkout = (home, name, state) => {
  const root = join(home, "repos", name);
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify(state));
  return root;
};

// A store run, as `afk cos start` leaves it, plus whatever events the test
// wants. Written through the store module, never by hand.
const storeRun = async (m, { adopted = [], events = [] } = {}) => {
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const run = createRun({ root: m.env.AFK_COS_ROOT, mode: "day", epics: [], adopted });
  for (const [kind, fields] of events) appendEvent(run.dir, kind, fields);
  return run;
};

test("the hub lists fixture runs from /peers and falls back to a recorded port", async (t) => {
  const m = machine();
  // Run A answers in the scanned range; run B was started with an explicit
  // port outside it, so only its state.json knows where its dashboard is.
  const rootA = checkout(m.home, "alpha", { dag: { epic: 226, branch: "feat/226", tasks: [] }, tasks: {} });
  const dashA = await fakeDashboard({ root: rootA, project: "alpha", epic: 226, branch: "feat/226", status: "running", progress: { total: 4, passed: 1 } });
  const dashB = await fakeDashboard({ root: "/elsewhere", project: "beta-live", epic: 301, status: "running", progress: { total: 2, passed: 2 } });
  const rootB = checkout(m.home, "beta", { dag: { epic: 301, branch: "feat/301", tasks: [] }, tasks: {}, dashboard: { port: dashB.port, pid: 1 } });
  // Run C recorded a port nobody answers on: still listed, marked as such.
  const deadPort = await freePort();
  const rootC = checkout(m.home, "gamma", { dag: { epic: 302, branch: "feat/302", tasks: [] }, tasks: {}, dashboard: { port: deadPort, pid: 1 } });
  t.after(() => Promise.all([dashA.close(), dashB.close()]));
  // The store knows B and C from a check-in and an adoption.
  await storeRun(m, {
    adopted: [{ epic: "302", root: rootC, port: deadPort }],
    events: [["checkin", { runs: [{ root: rootB, port: dashB.port, epic: "301" }], triggers: [], notified: [] }]],
  });
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: String(dashA.port) });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  const by = (epic) => runs.find((run) => run.epic === epic);
  assert.equal(by("226")?.source, "peers", JSON.stringify(runs));
  assert.equal(by("226").port, dashA.port);
  assert.equal(by("301")?.source, "state.json", JSON.stringify(runs));
  assert.equal(by("301").port, dashB.port);
  assert.equal(by("301").status, "running");
  assert.equal(by("302")?.source, "state.json");
  assert.equal(by("302").status, "not answering");
  // The page links each run's own dashboard.
  for (const port of [dashA.port, dashB.port, deadPort]) assert.match(hub.page, new RegExp(`href="http://127\\.0\\.0\\.1:${port}/?"`));
  // One dashboard link per run, in its Dashboard field (its tab frames the
  // dashboard as well); never inside the card's <summary>, where a click on
  // the link would also toggle the card. Every one opens in a new tab.
  const dashLinks = hub.page.match(/<a [^>]*href="http:\/\/127\.0\.0\.1:\d+\/?"[^>]*>/g) ?? [];
  assert.equal(dashLinks.length, 3, `expected one dashboard link per run, got ${dashLinks.length}`);
  for (const summary of hub.page.match(/<summary data-field="title">[\s\S]*?<\/summary>/g) ?? []) assert.doesNotMatch(summary, /<a /, summary);
  for (const a of dashLinks) assert.match(a, /target="_blank" rel="noopener noreferrer"/, a);
  // And never writes .afk/.
  for (const root of [rootA, rootB, rootC]) assert.deepEqual(readdirSync(join(root, ".afk")), ["state.json"]);
});

// A real .afk/state.json records the epic as `{id, title}`, and a dashboard's
// `/health` passes `state.dag.epic` through as it is. The hub must show the id.
test("an epic reported as {id, title} renders as its id on both paths, never [object Object]", async (t) => {
  const m = machine();
  const epic = { id: "27", title: "x" };
  const rootA = checkout(m.home, "alpha", { dag: { epic, branch: "feat/27", tasks: [{ id: "33" }] }, tasks: { 33: { lifecycle: "awaiting_acceptance" } } });
  const dashA = await fakeDashboard({ root: rootA, project: "alpha", epic, branch: "feat/27", status: "running", progress: { total: 1, passed: 0 } });
  t.after(() => dashA.close());
  // The fallback path: a recorded port nobody answers on, epic read from state.json.
  const deadPort = await freePort();
  const rootB = checkout(m.home, "beta", { dag: { epic: { id: "28", title: "y" }, branch: "feat/28", tasks: [] }, tasks: {}, dashboard: { port: deadPort, pid: 1 } });
  await storeRun(m, { adopted: [{ epic: "28", root: rootB, port: deadPort }] });
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: String(dashA.port) });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  assert.deepEqual(runs.map((run) => [run.source, run.epic, run.id]).sort(), [["peers", "27", "alpha#27"], ["state.json", "28", "beta#28"]], JSON.stringify(runs));
  assert.doesNotMatch(hub.page, /object Object/);
  assert.match(hub.page, /data-cli="afk epic 27 --accept=33"/);
  assert.match(hub.page, /epic #27/);
});

// #245 item 1: a chief-of-staff question, posted with `afk cos ask`, is a
// gate-style ask on the hub with no epic running at all.
const ASK_MERGE = [
  "ask", "--id=merge-who", "--title=Who merges #583?", "--why=The closeout needs one owner",
  "--option=owner|The owner merges|You merge after review", "--option=cos|Chief of staff merges|Only when CI is green",
  "--rec=owner",
];
const askBlock = (page, id) => page.match(new RegExp(`<fieldset class="ask" data-ask="cos:${id}"[\\s\\S]*?</fieldset>`))?.[0] ?? null;

test("#245: a question posted with afk cos ask renders on the hub with no epic running, its recommended option pre-checked", async (t) => {
  const m = machine();
  await storeRun(m);
  const posted = m.cos(...ASK_MERGE);
  assert.equal(posted.status, 0, posted.stdout + posted.stderr);
  const hub = await startHub(m);
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  assert.deepEqual(runs, [], "no epic is running");
  const block = askBlock(hub.page, "merge-who");
  assert.ok(block, `no cos:merge-who ask on the page:\n${hub.page}`);
  assert.match(block, /<p class="ask-q">Who merges #583\?<\/p>/);
  assert.match(block, /The closeout needs one owner/);
  assert.match(block, /<input type="radio" name="cos-merge-who" value="owner" checked>/);
  assert.match(block, /<input type="radio" name="cos-merge-who" value="cos">/);
  assert.match(block, /<span class="opt-label">The owner merges<\/span><small>recommended<\/small><small>You merge after review<\/small>/);
  assert.match(block, /Only when CI is green/);
  // A pre-checked recommendation is not an answer: The owner has not chosen yet.
  assert.match(block, /<legend>Chief of staff asks · merge-who · <span class="ask-st">to answer<\/span><\/legend>/);
});

test("#245: afk cos ask refuses a duplicate id in the run, and refuses with no open run", async () => {
  const m = machine();
  const none = m.cos(...ASK_MERGE);
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stdout, /no afk cos run is open/);
  const run = await storeRun(m);
  assert.equal(m.cos(...ASK_MERGE).status, 0);
  const again = m.cos(...ASK_MERGE);
  assert.equal(again.status, 1, again.stdout);
  assert.match(again.stdout, /merge-who is already asked/);
  const asks = readFileSync(join(run.dir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((e) => e.kind === "ask");
  assert.equal(asks.length, 1, "the duplicate wrote nothing");
});

test("#245: a question answered by a sent response is no longer open on reload; one sent as not answered stays", async (t) => {
  const m = machine();
  await storeRun(m);
  assert.equal(m.cos(...ASK_MERGE).status, 0);
  assert.equal(m.cos("ask", "--id=advisor", "--title=Run the advisor trial?", "--option=yes|Yes", "--option=no|No").status, 0);
  const hub = await startHub(m);
  t.after(hub.stop);
  assert.ok(askBlock(hub.page, "merge-who") && askBlock(hub.page, "advisor"), "both open before the answer");
  // The Markdown page.js builds on Respond: one line per ask, its answer below.
  const markdown = "# Re: afk hub\n\n## Decisions\n1. [ask:cos:merge-who] Who merges #583?\n   → **The owner merges**\n2. [ask:cos:advisor] Run the advisor trial?  _(not answered)_\n   → **no answer**\n";
  const sent = await hub.post("/respond", { target: "cos", verdict: null, markdown });
  assert.equal(sent.status, 200);
  const reloaded = await (await fetch(`${hub.base}/`)).text();
  assert.equal(askBlock(reloaded, "merge-who"), null, "an answered question is still open");
  assert.ok(askBlock(reloaded, "advisor"), "an unanswered question disappeared");
});

// #245 item 2: the plan page's read-only sections, from the open run's store.
// Each event is stamped at a fixed UTC time; the hub runs in Asia/Kolkata
// (UTC+05:30, no DST) so local time is provably not UTC.
const seedPlan = async (m) => {
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const run = createRun({ root: m.env.AFK_COS_ROOT, mode: "overnight", epics: ["583"] });
  const at = (iso, kind, fields) => appendEvent(run.dir, kind, fields, { ...m.env, AFK_COS_NOW: iso });
  const gone = spawnSync("true").pid;
  at("2026-10-13T19:00:00Z", "decision", { text: "Hold #583 until the advisor trial reports." });
  at("2026-10-13T19:05:00Z", "grant", { text: "you can merge #583 if CI is green" });
  at("2026-10-13T19:10:00Z", "note", { text: "atlas lane 3 retried twice" });
  at("2026-10-13T19:15:00Z", "process", { pid: process.pid, startedAt: null, owner: "cos", purpose: "watch #583 CI", ttlMin: 90, cmd: ["sleep", "1"], log: "/tmp/x.log" });
  at("2026-10-13T19:16:00Z", "process", { pid: gone, startedAt: null, owner: "cos", purpose: "old poller", ttlMin: 30, cmd: ["true"], log: "/tmp/y.log" });
  at("2026-10-13T19:20:00Z", "comment", { text: "The owner asked for the morning report by 07:00" });
  at("2026-10-13T19:25:00Z", "owner_intervention", { text: "The owner paused harbour#510 by hand" });
  at("2026-10-13T19:30:00Z", "decision", { text: "Skip the Vercel preview on #583: 0 deploys left." });
  at("2026-10-13T20:30:00Z", "checkin", {
    run: run.id, mode: "overnight",
    runs: [{ root: "/r/a", epic: "583" }, { root: "/r/b", epic: "1232" }],
    gateLock: { pid: 4242 }, orchestrators: [], deploysLeft: 0,
    triggers: [{ kind: "stall", epic: "583", root: "/r/a" }, { kind: "gate", epic: "1232", root: "/r/b", task: "7" }],
    notified: ["stall:/r/a:"],
  });
  return { run, gone };
};
const KOLKATA = { TZ: "Asia/Kolkata" };
const section = (page, key) => page.match(new RegExp(`<section class="hub-sec" data-run="[^"]*" data-field="${key}">[\\s\\S]*?</section>`))?.[0] ?? null;
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

test("#245 item 2: with an open run, the check-in, Decided, Night log and Processes sections render their content, in that order", async (t) => {
  const m = machine();
  const { gone } = await seedPlan(m);
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  const checkin = section(hub.page, "checkin");
  assert.ok(checkin, `no check-in section:\n${hub.page}`);
  assert.match(checkin, /<h2>Latest check-in<\/h2>/);
  assert.match(checkin, /data-field="checkin-runs"><dt>Runs counted<\/dt><dd>2<\/dd>/);
  assert.match(checkin, /data-field="checkin-gate-lock"><dt>Gate lock<\/dt><dd>held by pid 4242<\/dd>/);
  assert.match(checkin, /data-field="checkin-deploys-left"><dt>Deploys left<\/dt><dd>0<\/dd>/);
  // The same words as Needs you: "#583 stalled: no runner progress".
  assert.match(checkin, /data-field="checkin-flag:stall:583">#583 stalled: no runner progress \(notified\)<\/li>/);
  assert.match(checkin, /data-field="checkin-flag:gate:1232:7">#1232 task 7 gate open: waiting for you to accept<\/li>/);

  const decided = section(hub.page, "decided");
  assert.ok(decided, "no Decided section");
  const decidedText = text(decided);
  assert.ok(decidedText.indexOf("Skip the Vercel preview") < decidedText.indexOf("you can merge #583") && decidedText.indexOf("you can merge #583") < decidedText.indexOf("Hold #583"), `Decided is not newest first: ${decidedText}`);
  assert.match(decided, /data-field="event:2026-10-13T19:05:00.000Z:grant">.*<span class="kind">grant · owner&#39;s words<\/span><span class="verbatim">you can merge #583 if CI is green<\/span>/);
  assert.doesNotMatch(decided, /atlas lane 3|morning report|paused harbour/);

  const log = section(hub.page, "night-log");
  assert.ok(log, "no Night log section");
  const logText = text(log);
  assert.ok(logText.indexOf("paused harbour#510") < logText.indexOf("morning report") && logText.indexOf("morning report") < logText.indexOf("lane 3 retried"), `Night log is not newest first: ${logText}`);
  assert.match(log, /<span class="kind">owner intervention<\/span>/);
  assert.doesNotMatch(log, /Hold #583|you can merge/);

  const processes = section(hub.page, "processes");
  assert.ok(processes, "no Processes section");
  assert.match(processes, new RegExp(`data-field="process:${process.pid}">.*<span class="kind">alive</span><span>pid ${process.pid}: watch #583 CI \\(ttl 90 min\\)</span>`));
  assert.match(processes, new RegExp(`data-field="process:${gone}">.*<span class="kind">gone</span><span>pid ${gone}: old poller \\(ttl 30 min\\)</span>`));

  const order = ["Latest check-in", "Decided", "Night log", "Processes"].map((h) => hub.page.indexOf(`<h2>${h}</h2>`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `sections out of order: ${order}`);
});

test("#245 item 2: an open run with no events shows none of the four section headings", async (t) => {
  const m = machine();
  await storeRun(m);
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  assert.match(hub.page, /Chief of staff run/, "the run is open");
  for (const heading of ["Latest check-in", "Last check-in", "Decided", "Night log", "Processes"]) {
    assert.doesNotMatch(hub.page, new RegExp(`<h2>${heading}</h2>`), `an empty ${heading} heading renders`);
  }
});

test("#245 item 2: event times render in the machine's local time, the UTC stamp kept in datetime", async (t) => {
  const m = machine();
  await seedPlan(m);
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  // 20:30 UTC on the 13th is 02:00 on the 14th in Kolkata.
  assert.match(section(hub.page, "checkin"), /<time datetime="2026-10-13T20:30:00.000Z">2026-10-14 02:00<\/time>/);
  assert.match(section(hub.page, "decided"), /<time datetime="2026-10-13T19:05:00.000Z">2026-10-14 00:35<\/time>/);
  assert.match(section(hub.page, "night-log"), /<time datetime="2026-10-13T19:25:00.000Z">2026-10-14 00:55<\/time>/);
  assert.match(section(hub.page, "processes"), /<time datetime="2026-10-13T19:15:00.000Z">2026-10-14 00:45<\/time>/);
  for (const key of ["checkin", "decided", "night-log", "processes"]) {
    assert.doesNotMatch(text(section(hub.page, key)), /2026-10-13/, `${key} shows a UTC date`);
  }
  console.log(`--- rendered sections (TZ=Asia/Kolkata) ---\n${["checkin", "decided", "night-log", "processes"].map((key) => text(section(hub.page, key))).join("\n")}`);
});

// The hub demo (2026-10-14): Recent events printed the raw kind
// (`owner_intervention`) and both Recent events and Sent from the hub printed
// raw UTC ISO stamps, beside sections in local `YYYY-MM-DD HH:MM`.
const byHeading = (page, heading) => page.match(new RegExp(`<h2>${heading}</h2>[\\s\\S]*?</section>`))?.[0] ?? null;

test("Recent events and Sent from the hub use the local time format and the kind labels the other sections use", async (t) => {
  const m = machine();
  await seedPlan(m);
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  const sent = await hub.post("/comment", { target: "orch-nobody", anchor: { run: "alpha#226", field: "status" }, text: "hold the merge" });
  assert.equal(sent.status, 200, await sent.text());
  const page = await (await fetch(`${hub.base}/`)).text();
  const recent = byHeading(page, "Recent events");
  assert.ok(recent, "no Recent events section");
  assert.match(recent, /<time datetime="2026-10-13T19:25:00.000Z">2026-10-14 00:55<\/time><span class="kind">owner intervention<\/span>/);
  assert.doesNotMatch(text(recent), /owner_intervention|\d{4}-\d\d-\d\dT/);
  const sends = byHeading(page, "Sent from the hub");
  assert.match(sends, /<time datetime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d<\/time><span class="kind">/, sends);
  assert.doesNotMatch(text(sends), /\d{4}-\d\d-\d\dT/, "a raw ISO stamp is shown");
  console.log(`--- Recent events (TZ=Asia/Kolkata) ---\n${text(recent).slice(0, 300)}\n--- Sent from the hub ---\n${text(sends)}`);
});

// The hub demo, scenario 5: after `afk cos stop` no run is open, and Decided,
// Night log, Latest check-in and Recent events all vanished in the morning.
test("after stop, Decided, Night log, Latest check-in and Recent events show the most recent run, labelled closed", async (t) => {
  const m = machine();
  const { run } = await seedPlan(m);
  const { appendEvent } = await import("./cos/store.mjs");
  appendEvent(run.dir, "stop", { killed: [], gone: [], refused: [], survived: [] }, { ...m.env, AFK_COS_NOW: "2026-10-14T01:00:00Z" });
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  assert.match(hub.page, /No chief-of-staff run is open/);
  const label = `from run ${run.id} (closed)`;
  for (const key of ["checkin", "decided", "night-log", "events"]) {
    const sec = section(hub.page, key);
    assert.ok(sec, `no ${key} section after stop`);
    assert.ok(text(sec).includes(label), `${key} is not labelled "${label}": ${text(sec).slice(0, 200)}`);
    assert.match(sec, new RegExp(`data-run="${run.id}"`));
  }
  assert.match(section(hub.page, "decided"), /you can merge #583 if CI is green/);
  assert.match(section(hub.page, "night-log"), /The owner paused harbour#510 by hand/);
  assert.match(section(hub.page, "checkin"), /data-field="checkin-runs"><dt>Runs counted<\/dt><dd>2<\/dd>/);
  // A closed run's check-in flags are history, not something that needs you now.
  assert.doesNotMatch(section(hub.page, "needs-you"), /stalled/);
});

test("an open run's sections carry no closed-run label", async (t) => {
  const m = machine();
  await seedPlan(m);
  const hub = await startHub(m, KOLKATA);
  t.after(hub.stop);
  assert.doesNotMatch(hub.page, /\(closed\)/);
  assert.ok(section(hub.page, "events"), "Recent events has no anchor");
});

// The hub demo, scenario 3: riverbend's Orchestrator died on a fatal and the
// card said only "stale"; a dashboard not answering wore stale's orange dot.
test("a run card shows why its Orchestrator died, and not answering has its own dot colour", async (t) => {
  const m = machine();
  const gone = spawnSync("true").pid;
  const root = checkout(m.home, "riverbend", { orchestratorPid: gone, fatal: { at: "2026-10-13T22:30:00.000Z", message: "builder for 103 timed out three times" }, dag: { epic: 100, branch: "feat/100", tasks: [] }, tasks: {} });
  const dash = await fakeDashboard({ root, project: "riverbend", epic: 100, branch: "feat/100", status: "stale", progress: { total: 6, passed: 1 } });
  t.after(() => dash.close());
  const hub = await startHub(m, { ...KOLKATA, AFK_HUB_PEER_PORTS: String(dash.port) });
  t.after(hub.stop);
  const card = hub.page.match(/<details class="claim" data-l="1" data-run="riverbend#100"[\s\S]*?<\/details>/)?.[0];
  assert.ok(card, "no riverbend card");
  assert.match(card, /data-field="fatal"[^>]*><dt>Orchestrator died<\/dt><dd><time datetime="2026-10-13T22:30:00.000Z">2026-10-14 04:00<\/time> builder for 103 timed out three times<\/dd>/, card);
  const css = readFileSync(fileURLToPath(new URL("./hub/page.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const colour = (selector) => {
    const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(",").map((s) => s.trim()).includes(selector));
    return rule?.[2].match(/background:\s*([^;]+)/)?.[1].trim() ?? null;
  };
  for (const [stale, down] of [[".chip.st-stale::before", ".chip.st-not-answering::before"], [".hub-tabs .dot.st-stale", ".hub-tabs .dot.st-not-answering"]]) {
    assert.ok(colour(stale), `no colour for ${stale}`);
    assert.ok(colour(down), `no colour for ${down}`);
    assert.notEqual(colour(down), colour(stale), `${down} wears ${stale}'s colour`);
  }
});

test("a check-in's not_answering flag reads as words in the check-in and in Needs you", async (t) => {
  const m = machine();
  await storeRun(m, { events: [["checkin", { runs: [{ root: "/r/c", epic: "1232", status: "not answering" }], triggers: [{ kind: "not_answering", epic: "1232", root: "/r/c" }], notified: ["not_answering:/r/c:"] }]] });
  const hub = await startHub(m);
  t.after(hub.stop);
  assert.match(section(hub.page, "checkin"), /data-field="checkin-flag:not_answering:1232">#1232 dashboard not answering \(notified\)<\/li>/);
  assert.match(section(hub.page, "needs-you"), /data-field="not_answering">#1232 dashboard not answering<\/li>/);
  assert.match(section(hub.page, "events"), /triggers: not answering #1232;/);
});

// cos-night-2026-10-13: after `afk cos stop` the hub showed "No chief-of-staff
// run is open" and the morning report was only in chat.
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const prompts = (html) => Object.fromEntries([...html.matchAll(/<details class="claim report-card"[^>]*data-field="report:([^"]+)"[\s\S]*?data-prompt="([^"]*)"/g)].map(([, key, prompt]) => [key, unescape(prompt)]));
// atlas's clone is named atlas-workspace; only its origin remote says atlas.
const ATLAS_ROOT = join(mkdtempSync(join(tmpdir(), "afk-hub-atlas-")), "epic", "1232", "atlas-workspace");
mkdirSync(ATLAS_ROOT, { recursive: true });
spawnSync("git", ["init", "-q", ATLAS_ROOT]);
spawnSync("git", ["-C", ATLAS_ROOT, "remote", "add", "origin", "git@github.com:owner/atlas.git"]);
const HARBOUR_ROOT = "/Users/fixture/code/worktrees/harbour/epic/583/harbour";
const REPORT = `Night of 2026-10-13: both epics parked at their gates.

## harbour#583
Ended at gate #588. PR owner/harbour#595 (draft).
1. Run \`npm run test:db\` & read the <output>.

## atlas#1232
Ended at gate #1238.
1. Run test:live-db.

## atlas#9999
An epic the run never checked in on.
`;

test("morning report: after stop the hub shows the latest run's report.md, a summary and one card per epic, each with a Copy prompt", async (t) => {
  const m = machine();
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const night = createRun({ root: m.env.AFK_COS_ROOT, mode: "night", epics: ["583", "1232"] });
  appendEvent(night.dir, "checkin", {
    runs: [
      { root: HARBOUR_ROOT, project: "harbour", epic: { id: "583", title: "x" } },
      { root: ATLAS_ROOT, project: "atlas-workspace", epic: "1232" },
    ],
    triggers: [],
  });
  appendEvent(night.dir, "stop", { killed: [], gone: [], refused: [], survived: [] });
  const md = join(m.home, "report.md");
  writeFileSync(md, REPORT);
  assert.equal(m.cos("report", `--file=${md}`).status, 0);
  writeFileSync(md, "## atlas#1232\nFinished at 09:10; PR owner/atlas#1244 is ready.\n");
  assert.equal(m.cos("report", `--file=${md}`, "--append").status, 0);
  writeFileSync(md, "stopped: still alive 0\n");
  assert.equal(m.cos("report", `--file=${md}`, "--append").status, 0);
  // A newer run with no report does not hide the night's.
  const later = createRun({ root: m.env.AFK_COS_ROOT, mode: "day", env: { AFK_COS_NOW: "2099-01-01T00:00:00Z" } });
  const hub = await startHub(m);
  t.after(hub.stop);
  const report = join(night.dir, "report.md");
  const sec = section(hub.page, "report");
  assert.ok(sec, `no report section:\n${hub.page}`);
  assert.match(sec, /<h2>Morning report<\/h2>/);
  assert.ok(sec.includes(night.id) && !sec.includes(later.id), "the report is the night's run");
  // The first addendum only repeats an epic section, so the summary shows only the second.
  const stamps = [...readFileSync(report, "utf8").matchAll(/## Addendum (\S+)/g)].map((match) => match[1]);
  assert.equal(stamps.length, 2);
  assert.ok(sec.includes(`<pre class="r-md report-md" data-field="report-summary">Night of 2026-10-13: both epics parked at their gates.\n\n## Addendum ${stamps[1]}\n\nstopped: still alive 0</pre>`), sec);
  assert.deepEqual([...sec.matchAll(/data-field="report:([^"]+)"/g)].map((match) => match[1]), ["harbour#583", "atlas#1232", "atlas#9999"]);
  assert.match(sec, /Run `npm run test:db` &amp; read the &lt;output&gt;\./, "card text is escaped");
  const byKey = prompts(sec);
  assert.equal(byKey["atlas#1232"], [
    `Open this chat in ${ATLAS_ROOT}.`,
    "",
    `Epic atlas#1232, from the chief of staff's morning report (run ${night.id}). Its section, verbatim:`,
    "",
    "## atlas#1232\nEnded at gate #1238.\n1. Run test:live-db.",
    "",
    `## Addendum ${readFileSync(report, "utf8").match(/## Addendum (\S+)/)[1]}`,
    "",
    "## atlas#1232\nFinished at 09:10; PR owner/atlas#1244 is ready.",
    "",
    `Full report: ${report}`,
  ].join("\n"));
  assert.ok(byKey["harbour#583"].startsWith(`Open this chat in ${HARBOUR_ROOT}.\n`), byKey["harbour#583"]);
  assert.ok(byKey["harbour#583"].includes("1. Run `npm run test:db` & read the <output>."), "the prompt carries the section verbatim");
  assert.ok(byKey["atlas#9999"].startsWith(`No checkout is recorded for atlas#9999 in run ${night.id}, so this prompt names none.`), byKey["atlas#9999"]);
  assert.doesNotMatch(byKey["atlas#9999"], /Open this chat in/);
  assert.match(hub.page, /<button type="button" class="copy-prompt"/);
  console.log(`--- atlas#1232 Copy prompt ---\n${byKey["atlas#1232"]}`);
});

test("needs you: an Orchestrator's open ask is a card the owner answers in words; it stays, marked queued, until the chief of staff records the answer", async (t) => {
  const m = machine();
  await storeRun(m);
  const at = (iso, ...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env: { ...m.env, AFK_COS_NOW: iso }, encoding: "utf8" });
  assert.equal(at("2026-10-14T01:00:00Z", "ask", "--id=retry-583", "--title=Retry lane 3 a third time?", "--from=orch-583").status, 0);
  const hub = await startHub(m, { AFK_COS_NOW: "2026-10-14T01:32:00Z" });
  t.after(hub.stop);
  const needs = section(hub.page, "needs-you");
  const card = askBlock(hub.page, "retry-583");
  assert.ok(card, `no card for the Orchestrator's ask:\n${needs}`);
  assert.match(card, /data-from="orch-583"/);
  assert.match(card, /<legend>orch-583 asks the chief of staff · waiting 32 min · <span class="ask-st">to answer<\/span><\/legend>/);
  assert.match(card, /<p class="ask-q">Retry lane 3 a third time\?<\/p>/);
  // No options: the answer is the owner's own words.
  assert.match(card, /<textarea [^>]*name="answer-retry-583"/);
  assert.doesNotMatch(card, /type="radio"/);
  // The internal id stays in attributes, never in the visible text.
  assert.doesNotMatch(text(needs), /retry-583/);
  assert.doesNotMatch(needs, /waits on the chief of staff/);
  assert.doesNotMatch(needs, /Nothing waits for you/);
  assert.match(hub.page, /<h1>0 runs <span class="h1-sub">· 1 needs you<\/span><\/h1>/);

  // An answer sent straight to the Orchestrator never reaches the chief of
  // staff's queue, so it does not mark the card queued.
  const markdown = "# Re: afk hub\n\n## Decisions\n1. [ask:cos:retry-583] Retry lane 3 a third time?\n   → the owner's words for orch-583, relay verbatim:\n     > No. Park lane 3.\n";
  assert.equal((await hub.post("/respond", { target: "orch-583", verdict: null, markdown })).status, 200);
  assert.match(askBlock(await (await fetch(`${hub.base}/`)).text(), "retry-583"), /<span class="ask-st">to answer<\/span>/);
  // The Markdown page.js builds on Respond for a free-text ask, sent to cos.
  const markdownToCos = "# Re: afk hub\n\n## Decisions\n1. [ask:cos:retry-583] Retry lane 3 a third time?\n   → the owner's words for orch-583, relay verbatim:\n     > No. Park lane 3.\n";
  const sent = await hub.post("/respond", { target: "cos", verdict: null, markdown: markdownToCos });
  assert.equal(sent.status, 200);
  const queued = m.hub("queue", "cos");
  assert.match(queued.stdout, /\[ask:cos:retry-583\]/);
  assert.match(queued.stdout, /> No\. Park lane 3\./);
  const pending = askBlock(await (await fetch(`${hub.base}/`)).text(), "retry-583");
  assert.ok(pending, "the card left before the chief of staff recorded the answer");
  assert.match(pending, /<span class="ask-st">your answer is queued<\/span>/);
  assert.match(pending, /data-queued="1"/);

  assert.equal(at("2026-10-14T01:40:00Z", "answer", "--id=retry-583", "No. Park lane 3.").status, 0);
  const reloaded = await (await fetch(`${hub.base}/`)).text();
  assert.equal(askBlock(reloaded, "retry-583"), null, "the card stayed after the answer was recorded");
  assert.match(section(reloaded, "needs-you"), /Nothing waits for you/);
});

test("a posted comment is in the store before the HTTP response returns", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hub = await startHub(m);
  t.after(hub.stop);
  writeFileSync(join(m.home, "prompt-hold"), "");
  const pending = hub.post("/comment", { target: "orch-226", anchor: { run: "alpha#226", field: "status" }, text: "hold the merge" });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  // The relay is held inside `herdr agent prompt`: the response cannot have
  // returned, and the comment must already be stored.
  const deadline = Date.now() + 10_000;
  while (!/agent prompt orch-226/.test(m.calls()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(m.calls(), /agent prompt orch-226/);
  assert.equal(settled, false, "the response came back before the relay finished");
  const stored = m.inbox().filter((event) => event.status === "stored");
  assert.equal(stored.length, 1, JSON.stringify(m.inbox()));
  assert.equal(stored[0].text, "hold the merge");
  assert.equal(stored[0].target, "orch-226");
  assert.deepEqual(stored[0].anchor, { run: "alpha#226", field: "status" });
  assert.match(stored[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUID");
  const { rmSync } = await import("node:fs");
  rmSync(join(m.home, "prompt-hold"));
  const body = await (await pending).json();
  assert.deepEqual(body.steps, ["stored", "delivered"]);
});

test("a warm target is delivered, a failed relay and a cold or absent target are queued, and a queue returns an item until it is acknowledged", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }, { name: "orch-300", ageMin: 121 }, { name: "orch-301", ageMin: 3 }] });
  writeFileSync(join(m.home, "prompt-fail-orch-301"), "");
  const hub = await startHub(m);
  t.after(hub.stop);
  const targets = await (await fetch(`${hub.base}/targets`)).json();
  assert.deepEqual(targets.map((x) => [x.name, x.state]), [
    ["cos", "no session"], ["orch-226", "warm 2m"], ["orch-300", "cold 121m"], ["orch-301", "warm 3m"],
  ]);
  const send = async (target, text) => (await hub.post("/comment", { target, anchor: { run: "alpha#226", field: "pr" }, text })).json();
  const warm = await send("orch-226", "warm one");
  assert.deepEqual(warm.steps, ["stored", "delivered"]);
  assert.match(m.calls(), /agent prompt orch-226 Relayed by the chief of staff\. The owner said, in "afk hub, on alpha#226 · pr" at .*verbatim: "warm one"/);
  const failed = await send("orch-301", "relay fails");
  assert.deepEqual(failed.steps, ["stored", "queued"]);
  const cold = await send("orch-300", "cold one");
  assert.deepEqual(cold.steps, ["stored", "queued"]);
  assert.equal(cold.ageMin, 121);
  assert.doesNotMatch(m.calls(), /agent prompt orch-300/, "a cold target is never messaged");
  const absent = await send("cos", "nobody home");
  assert.deepEqual(absent.steps, ["stored", "queued"]);
  assert.equal(absent.ageMin, null);
  // The store logs delivered only for the relay that succeeded.
  const statusOf = (id) => m.inbox().filter((event) => event.id === id).map((event) => event.status);
  assert.deepEqual(statusOf(warm.id), ["stored", "delivered"]);
  assert.deepEqual(statusOf(failed.id), ["stored", "queued"]);
  assert.deepEqual(statusOf(cold.id), ["stored", "queued"]);
  // A respond is stored and relayed the same way.
  const respond = await (await hub.post("/respond", { target: "orch-300", verdict: null, markdown: "# Re: afk hub\n" })).json();
  assert.deepEqual(respond.steps, ["stored", "queued"]);
  // The cold target's queue returns each item once; after an ack, never again.
  // Reading the queue is not an acknowledgement: it survives a dead reader.
  const first = m.hub("queue", "orch-300");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const copies = (out, id) => out.split(`id: ${id}`).length - 1;
  assert.equal(copies(first.stdout, cold.id), 1, first.stdout);
  assert.match(first.stdout, /cold one/);
  assert.match(first.stdout, /# Re: afk hub/);
  assert.doesNotMatch(first.stdout, /warm one|relay fails|nobody home/);
  assert.equal(copies(m.hub("queue", "orch-300").stdout, cold.id), 1, "re-reading is not an ack");
  const ack = m.hub("ack", "orch-300", cold.id, respond.id);
  assert.equal(ack.status, 0, ack.stdout);
  assert.deepEqual(statusOf(cold.id), ["stored", "queued", "read"]);
  const after = m.hub("queue", "orch-300");
  assert.doesNotMatch(after.stdout, new RegExp(cold.id));
  assert.match(after.stdout, /nothing queued for orch-300/);
  // The other queues are untouched.
  assert.match(m.hub("queue", "cos").stdout, new RegExp(absent.id));
  assert.match(m.hub("queue", "orch-301").stdout, new RegExp(failed.id));
  assert.doesNotMatch(m.hub("queue", "orch-226").stdout, new RegExp(warm.id), "a delivered comment is not queued");
});

test("a POST without the token, or with a foreign Origin, is refused and stores nothing", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hub = await startHub(m);
  t.after(hub.stop);
  assert.ok(hub.token, "the page carries its token");
  const body = { target: "orch-226", anchor: { run: "alpha#226", field: "status" }, text: "x" };
  const noToken = await hub.post("/comment", body, { "x-afk-hub-token": "" });
  assert.equal(noToken.status, 403);
  const wrongToken = await hub.post("/respond", { target: "orch-226", verdict: null, markdown: "x" }, { "x-afk-hub-token": "not-it" });
  assert.equal(wrongToken.status, 403);
  const foreign = await hub.post("/comment", body, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(m.inbox(), [], "a refused request writes nothing");
  assert.doesNotMatch(m.calls(), /agent prompt/);
  const ok = await hub.post("/comment", body);
  assert.equal(ok.status, 200);
});

test("hub install writes and loads a launchd agent that serves on 4099; uninstall removes it", () => {
  const m = machine();
  const installed = m.hub("install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const plist = readFileSync(join(m.home, "Library", "LaunchAgents", "com.afk-claude.hub.plist"), "utf8");
  assert.match(plist, /<string>hub<\/string>\s*<string>--port=4099<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(m.calls(), /launchctl bootstrap gui\/\d+ .*com\.afk-claude\.hub\.plist/);
  const removed = m.hub("uninstall");
  assert.equal(removed.status, 0, removed.stdout);
  assert.ok(!existsSync(join(m.home, "Library", "LaunchAgents", "com.afk-claude.hub.plist")));
  assert.match(m.calls(), /launchctl bootout gui\/\d+\/com\.afk-claude\.hub/);
});

// --- Fix pass (#236 review) ---

const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("H1: a comment stranded at `stored` by a hub killed mid-relay is queued, once, after a restart or once it is old", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hold = join(m.home, "prompt-hold");
  writeFileSync(hold, "");
  t.after(async () => { const { rmSync } = await import("node:fs"); rmSync(hold, { force: true }); });
  const hub = await startHub(m);
  hub.post("/comment", { target: "orch-226", anchor: { run: "alpha#226", field: "status" }, text: "crash two" }).catch(() => {});
  await waitFor(() => /agent prompt orch-226/.test(m.calls()));
  await hub.crash();
  const [stranded] = m.inbox();
  assert.deepEqual(m.inbox().map((e) => e.status), ["stored"], "the hub died with the item unresolved");
  // Read later (past the relay timeout), with no hub running: queued, once.
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  const old = spawnSync(process.execPath, [afk, "hub", "queue", "orch-226"], { env: { ...m.env, AFK_COS_NOW: later }, encoding: "utf8" });
  assert.equal(old.stdout.split(`id: ${stranded.id}`).length - 1, 1, old.stdout);
  assert.match(old.stdout, /may already have arrived/);
  // Read now, before that age: a restarted hub resolves it at once.
  assert.doesNotMatch(m.hub("queue", "orch-226").stdout, new RegExp(stranded.id), "a fresh stored item is still in flight");
  const again = await startHub(m);
  t.after(again.stop);
  const now = m.hub("queue", "orch-226");
  assert.equal(now.stdout.split(`id: ${stranded.id}`).length - 1, 1, now.stdout);
  assert.deepEqual(m.inbox().filter((e) => e.id === stranded.id).map((e) => e.status), ["stored", "queued"]);
  // A second restart does not queue it twice.
  await again.stop();
  const third = await startHub(m);
  t.after(third.stop);
  assert.deepEqual(m.inbox().filter((e) => e.id === stranded.id).map((e) => e.status), ["stored", "queued"]);
});

// GET with an arbitrary Host header: fetch() will not send one, so use http.get.
const getWithHost = async (port, path, host) => {
  const { get } = await import("node:http");
  return new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
};

test("H2: a GET whose Host is not this hub (DNS rebinding) is refused and never sees the token", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hub = await startHub(m);
  t.after(hub.stop);
  for (const path of ["/", "/targets", "/runs.json", "/nope"]) {
    const r = await getWithHost(hub.port, path, `evil.example:${hub.port}`);
    assert.equal(r.status, 421, `${path}: ${r.status}`);
    assert.ok(!r.body.includes(hub.token), `${path} leaked the token`);
  }
  assert.equal((await getWithHost(hub.port, "/", `localhost:${hub.port}`)).status, 200);
});

test("H3: a relay that times out has its whole process group killed, is queued with the reason, and the queue shows it", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hold = join(m.home, "prompt-hold");
  writeFileSync(hold, "");
  const hub = await startHub(m, { AFK_HUB_RELAY_TIMEOUT_MS: "1500" });
  t.after(hub.stop);
  const body = await (await hub.post("/comment", { target: "orch-226", anchor: { run: "alpha#226", field: "pr" }, text: "slow one" })).json();
  assert.deepEqual(body.steps, ["stored", "queued"]);
  const queued = m.inbox().find((e) => e.id === body.id && e.status === "queued");
  assert.match(queued?.reason ?? "", /timed out.*may already have arrived/);
  // The held `herdr agent prompt` was killed with its parent: releasing the
  // hold now must never let the prompt land.
  const { rmSync } = await import("node:fs");
  rmSync(hold);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.doesNotMatch(m.calls(), /landed orch-226/, "the prompt landed after the item was logged queued");
  const out = m.hub("queue", "orch-226").stdout;
  assert.match(out, /note: relay timed out .*may already have arrived/);
});

test("H7: a slow herdr does not block the hub: /runs.json answers while /targets waits", async (t) => {
  const m = machine({ agents: [{ name: "orch-226", ageMin: 2 }] });
  const hub = await startHub(m);
  t.after(hub.stop);
  writeFileSync(join(m.home, "list-slow"), "");
  const targets = fetch(`${hub.base}/targets`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  const runs = await fetch(`${hub.base}/runs.json`);
  assert.equal(runs.status, 200);
  assert.ok(Date.now() - started < 1500, `runs.json took ${Date.now() - started} ms behind a slow herdr`);
  await targets;
});

test("H4: with a dashboard running and the hub down, the hub still binds its port when it starts, and no dashboard answers there", async (t) => {
  const m = machine();
  const root = mkdtempSync(join(tmpdir(), "afk-hub-dash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A private hub port, never the real 4099: the dashboard reads AFK_HUB_PORT
  // and the hub gets the same number through --port.
  const hubPort = await freePort();
  const dashPort = await freePort();
  const dash = spawn(process.execPath, [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))], {
    cwd: root,
    env: { ...m.env, PORT: String(dashPort), AFK_HUB_PORT: String(hubPort), AFK_HUB_RETRY_MS: "300" },
    stdio: "ignore",
  });
  t.after(() => dash.kill("SIGKILL"));
  const health = async (url) => {
    try { return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json(); } catch { return null; }
  };
  const deadline = Date.now() + 10_000;
  while (!(await health(`http://127.0.0.1:${dashPort}/health`))?.ok) {
    assert.ok(Date.now() < deadline, "the dashboard never came up");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Long enough for several of the dashboard's 300 ms hub-claim retries.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const hub = await startHub(m, {}, hubPort);
  t.after(hub.stop);
  assert.equal(hub.port, hubPort);
  // Every address the printed `localhost` URL can resolve to must reach the
  // hub, not a dashboard: on macOS a dashboard bound to `::` and the hub on
  // 127.0.0.1 can both listen, and `localhost` then opens the old page.
  for (const host of ["127.0.0.1", "[::1]"]) {
    const answer = await health(`http://${host}:${hubPort}/health`);
    assert.ok(!answer?.root, `a dashboard (${answer?.root}) answers on the hub port at ${host}`);
  }
});

// The run card for one run id, as rendered on the Overview.
const runCard = (page, id) => page.match(new RegExp(`<details class="claim" data-l="1" data-run="${id}"[\\s\\S]*?</details>`))?.[0] ?? null;
// One tab panel by the run id it shows.
const panel = (page, id) => page.match(new RegExp(`<section class="tab-panel[^"]*"[^>]*data-tab="${id}"[\\s\\S]*?</section><!-- /tab -->`))?.[0] ?? null;

// #277: a run whose dashboard failed to start carries on without one. Its
// state.json records no port, only `dashboardSkipped`; the hub still lists it,
// with no dashboard link and no frame. A checkout with neither stays unlisted.
test("the hub lists a run carrying on without a dashboard, with no dashboard link", async (t) => {
  const m = machine();
  const rootD = checkout(m.home, "delta", {
    dag: { epic: 303, branch: "feat/303", tasks: [] }, tasks: {}, dashboard: null,
    dashboardSkipped: { at: new Date().toISOString(), reason: "Dashboard failed to start on http://localhost:4200; see /x/dashboard.log" },
  });
  const rootE = checkout(m.home, "epsilon", { dag: { epic: 304, branch: "feat/304", tasks: [] }, tasks: {}, dashboard: null });
  await storeRun(m, { adopted: [{ epic: "303", root: rootD }, { epic: "304", root: rootE }] });
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: "" });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  const run = runs.find((r) => r.epic === "303");
  assert.ok(run, `the dashboard-less run is missing: ${JSON.stringify(runs)}`);
  assert.equal(run.status, "no dashboard");
  assert.equal(run.dashboard, null);
  assert.equal(run.port, null);
  assert.equal(run.branch, "feat/303");
  assert.ok(!runs.some((r) => r.epic === "304"), "a checkout with no run recorded was listed");
  assert.doesNotMatch(hub.page, /127\.0\.0\.1:null|href="null"/);
  const p = panel(hub.page, "delta#303");
  assert.ok(p, "no tab panel for the dashboard-less run");
  assert.doesNotMatch(p, /<iframe/, "a run with no dashboard must not get an empty frame");
  assert.match(p, /did not start/);
  assert.match(runCard(hub.page, "delta#303") ?? "", /data-field="dashboard"[\s\S]*none/);
});

// #279: a run whose dashboard failed is no peer, and in a checkout no chief of
// staff has seen the store does not know it either. `runAuto` records its root
// in the machine-wide no-dashboard record; the hub lists it from there.
test("the hub lists a no-dashboard run from the machine's record, in a checkout the store has never seen", async (t) => {
  const m = machine();
  const root = checkout(m.home, "zeta", {
    dag: { epic: 305, branch: "feat/305", tasks: [] }, tasks: {}, dashboard: null,
    dashboardSkipped: { at: new Date().toISOString(), reason: "Dashboard failed to start on http://127.0.0.1:4200; see /x/dashboard.log" },
  });
  recordNoDashboard(root, m.env);
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: "" });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  const run = runs.find((r) => r.epic === "305");
  assert.ok(run, `the recorded run is missing: ${JSON.stringify(runs)}`);
  assert.equal(run.status, "no dashboard");
  assert.equal(run.port, null);
  assert.equal(run.dashboard, null);
  assert.equal(run.branch, "feat/305");
});

test("the hub does not list a recorded root whose run no longer says dashboardSkipped", async (t) => {
  const m = machine();
  // Killed hard, or cleared by an exit whose record write failed: the state decides.
  const root = checkout(m.home, "eta", { dag: { epic: 306, branch: "feat/306", tasks: [] }, tasks: {}, dashboard: null });
  recordNoDashboard(root, m.env);
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: "" });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  assert.ok(!runs.some((r) => r.epic === "306"), `a recorded root with no dashboardSkipped was listed: ${JSON.stringify(runs)}`);
});

test("#243: the hub shows Overview plus one tab per run, each run's tab frames its dashboard with ?embed=1, and a run not answering shows that state instead of a frame", async (t) => {
  const m = machine();
  const rootA = checkout(m.home, "alpha", { dag: { epic: 226, branch: "feat/226", tasks: [] }, tasks: {} });
  const dashA = await fakeDashboard({ root: rootA, project: "alpha", epic: 226, branch: "feat/226", status: "running", progress: { total: 2, passed: 1 } });
  const dashB = await fakeDashboard({ root: "/elsewhere", project: "beta", epic: 301, status: "running", progress: { total: 1, passed: 0 } });
  const rootB = checkout(m.home, "beta", { dag: { epic: 301, branch: "feat/301", tasks: [] }, tasks: {}, dashboard: { port: dashB.port, pid: 1 } });
  const deadPort = await freePort();
  const rootC = checkout(m.home, "gamma", { dag: { epic: 302, branch: "feat/302", tasks: [] }, tasks: {}, dashboard: { port: deadPort, pid: 1 } });
  t.after(() => Promise.all([dashA.close(), dashB.close()]));
  await storeRun(m, {
    adopted: [{ epic: "302", root: rootC, port: deadPort }],
    events: [["checkin", { runs: [{ root: rootB, port: dashB.port, epic: "301" }], triggers: [], notified: [] }]],
  });
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: String(dashA.port) });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  assert.equal(runs.length, 3, JSON.stringify(runs));

  const strip = hub.page.match(/<nav class="hub-tabs" role="tablist"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(strip, "no tab strip on the hub page");
  const tabs = [...strip.matchAll(/<button [^>]*role="tab"[^>]*data-tab="([^"]+)"/g)].map((match) => match[1]);
  // Overview first, then one tab per run in /runs.json order, then the two machine-wide tabs.
  assert.deepEqual(tabs, ["overview", ...runs.map((run) => run.id), "spending", "lanes"]);
  assert.match(strip, /<button [^>]*data-tab="overview"[^>]*aria-selected="true"/);

  // The Overview is today's page: the Runs section is in it.
  assert.match(panel(hub.page, "overview") ?? "", /<h2>Runs<\/h2>/);

  for (const [id, port] of [["alpha#226", dashA.port], ["beta#301", dashB.port]]) {
    const p = panel(hub.page, id);
    assert.ok(p, `no tab panel for ${id}`);
    assert.match(p, new RegExp(`<iframe [^>]*data-src="http://127\\.0\\.0\\.1:${port}/\\?embed=1"`), p);
  }
  const dead = panel(hub.page, "gamma#302");
  assert.ok(dead, "no tab panel for the run not answering");
  assert.doesNotMatch(dead, /<iframe/, "a run not answering must not get an empty frame");
  assert.match(dead, /not answering/);
  assert.match(dead, new RegExp(`port ${deadPort}`));
});

test("#244: a run card's progress bar has the dashboard's four coloured sections on both run paths, and the plain bar when a dashboard sends no counts", async (t) => {
  const m = machine();
  // 6 tasks: 1 done, 1 active, 1 review + 1 gate, 1 failed, 1 waiting.
  const counts = { done: 1, active: 1, review: 1, gate: 1, failed: 1, stale: 0, waiting: 1 };
  const rootA = checkout(m.home, "alpha", { dag: { epic: 226, branch: "feat/226", tasks: [] }, tasks: {} });
  const dashA = await fakeDashboard({ root: rootA, project: "alpha", epic: 226, status: "running", progress: { total: 6, passed: 1 }, counts });
  // B answers only on the port its state.json records: the fallback path.
  const dashB = await fakeDashboard({ root: "/elsewhere", project: "beta", epic: 301, status: "running", progress: { total: 6, passed: 1 }, counts });
  const rootB = checkout(m.home, "beta", { dag: { epic: 301, branch: "feat/301", tasks: [] }, tasks: {}, dashboard: { port: dashB.port, pid: 1 } });
  // C is a dashboard running older code: no counts.
  const rootC = checkout(m.home, "gamma", { dag: { epic: 302, tasks: [] }, tasks: {} });
  const dashC = await fakeDashboard({ root: rootC, project: "gamma", epic: 302, status: "running", progress: { total: 4, passed: 3 } });
  t.after(() => Promise.all([dashA.close(), dashB.close(), dashC.close()]));
  await storeRun(m, { events: [["checkin", { runs: [{ root: rootB, port: dashB.port, epic: "301" }], triggers: [], notified: [] }]] });
  const hub = await startHub(m, { AFK_HUB_PEER_PORTS: `${dashA.port},${dashC.port}` });
  t.after(hub.stop);
  const runs = await (await fetch(`${hub.base}/runs.json`)).json();
  assert.equal(runs.find((run) => run.id === "beta#301")?.source, "state.json", JSON.stringify(runs));

  for (const id of ["alpha#226", "beta#301"]) {
    const card = runCard(hub.page, id);
    assert.ok(card, `no run card for ${id}`);
    const segs = [...card.matchAll(/<span class="seg seg-(\w+)" style="width:([\d.]+)%"><\/span>/g)].map((match) => [match[1], Number(match[2])]);
    // Review and gate share one section, as on the dashboard.
    assert.deepEqual(segs, [["done", 16.67], ["active", 16.67], ["review", 33.33], ["failed", 16.67]], `${id}: ${card}`);
    assert.doesNotMatch(card, /<progress/);
  }
  // The dashboard's colours, one per section.
  for (const [cls, token] of [["done", "success"], ["active", "accent"], ["review", "warn"], ["failed", "danger"]]) {
    assert.match(hub.page, new RegExp(`\\.seg-${cls} \\{ background: var\\(--${token}\\); \\}`));
  }
  assert.match(hub.page, /--success: #16a34a;/);

  const plain = runCard(hub.page, "gamma#302");
  assert.ok(plain, "no run card for gamma#302");
  assert.match(plain, /<progress max="4" value="3"><\/progress>/);
  assert.doesNotMatch(plain, /class="seg /);
});

test("the hub serves the coduo.co favicon as image/png and the page head links it", async (t) => {
  const m = machine();
  const hub = await startHub(m);
  t.after(hub.stop);
  const head = hub.page.match(/<head>[\s\S]*<\/head>/)?.[0] ?? "";
  assert.match(head, /<link rel="icon" type="image\/png" href="\/favicon\.ico">/);
  const source = readFileSync(fileURLToPath(new URL("./hub/icon.png", import.meta.url)));
  const res = await fetch(`${hub.base}/favicon.ico`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), source);
});

// Design pass (better-interface review, design/hub-better-interface): the page
// rendered straight from a view, so each finding's markup is pinned without a
// live store. One run per state the page draws.
const designView = (over = {}) => ({
  cos: { id: "night-1", meta: { mode: "night" } },
  closedRun: null,
  questions: [{ id: "deploy-batch", ts: "2026-10-14T01:00:00Z", title: "Batch two previews?", options: [{ value: "batch", label: "Batch them" }, { value: "wait", label: "Wait" }], rec: "batch" }],
  waiting: [],
  report: { id: "night-1", path: "/r/report.md", summary: "Night done.", sections: [{ key: "atlas#1232", text: "Closed.", prompt: "brief" }] },
  decided: [], nightLog: [], processes: [],
  runs: [
    { id: "alpha#226", project: "alpha", epic: "226", status: "running", port: 5001, dashboard: "http://127.0.0.1:5001/", source: "peers", root: "/r/alpha", branch: "feat/226", progress: { total: 6, passed: 1 }, counts: { done: 1, active: 1, review: 1, gate: 1, failed: 1, stale: 0 }, gates: ["33"], pr: null, deploy: null, fatal: null },
    { id: "gamma#302", project: "gamma", epic: "302", status: "not answering", port: 5002, dashboard: "http://127.0.0.1:5002/", source: "state.json", root: "/r/gamma", branch: "feat/302", progress: null, counts: null, gates: [], pr: null, deploy: null, fatal: null },
  ],
  triggers: [], lastCheckin: null, events: [], sends: [], flagged: [],
  ...over,
});
const renderDesign = async (over) => (await import("./hub/page.mjs")).renderPage(designView(over), { token: "t" });

// #273: a run parked at a `gate: after` task has exited, so it has no
// dashboard, but it did not fail to start one: its card and tab say it waits.
test("a run parked at a gate says it waits for you, not that its dashboard did not start", async () => {
  const parked = { id: "kappa#273", project: "kappa", epic: "273", status: "waits for you", port: null, dashboard: null, source: "state.json", root: "/r/kappa", branch: "feat/273", progress: null, counts: null, gates: ["5"], pr: null, deploy: null, fatal: null };
  const skipped = { ...parked, id: "delta#303", project: "delta", epic: "303", status: "no dashboard", root: "/r/delta", gates: [] };
  const page = await renderDesign({ runs: [parked, skipped] });
  const p = panel(page, "kappa#273");
  assert.ok(p, "no tab panel for the parked run");
  assert.match(p, /<span class="chip st-waits-for-you">waits for you<\/span>/);
  assert.match(p, /waits for you at gate 5/);
  assert.match(p, /afk status/);
  assert.doesNotMatch(p, /did not start|>no dashboard</);
  assert.match(runCard(page, "kappa#273") ?? "", /data-field="dashboard"[\s\S]*none — the run stopped at a gate/);
  assert.doesNotMatch(runCard(page, "kappa#273") ?? "", /did not start/);
  assert.match(panel(page, "delta#303") ?? "", /did not start/);
  assert.match(runCard(page, "delta#303") ?? "", /none — it did not start/);
});

test("design: a run's state is never carried by colour alone (tab word, ask state word, progress in words)", async () => {
  const page = await renderDesign();
  const tab = (id) => page.match(new RegExp(`<button [^>]*role="tab"[^>]*data-tab="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
  // The tab names the state in words when it is not plain running; the dot only repeats it.
  assert.match(text(tab("gamma#302")), /gamma #302 not answering/, tab("gamma#302"));
  assert.doesNotMatch(text(tab("alpha#226")), /running/, tab("alpha#226"));
  assert.match(tab("gamma#302"), /<span class="dot st-not-answering" aria-hidden="true"><\/span>/);
  // Each decision says in its legend whether it still needs an answer.
  assert.match(page, /<legend>Needs you · alpha#226 · <span class="ask-st">to answer<\/span><\/legend>/);
  // deploy-batch has a recommended option, pre-checked; that is not the owner's answer.
  assert.match(page, /<legend>Chief of staff asks · deploy-batch · <span class="ask-st">to answer<\/span><\/legend>/);
  // The bar's sections are written out under it; the bar itself is decoration.
  const card = runCard(page, "alpha#226");
  assert.match(card, /<span class="pbar" aria-hidden="true">/, card);
  assert.match(card, /<small class="pbar-key">1 passed, 1 building, 2 in review or waiting for you, 1 failed or stale<\/small>/, card);
});

test("design: a report card's Copy prompt sits in its body, not inside the summary, and the open/close mark is not read out", async () => {
  const page = await renderDesign();
  const summaries = [...page.matchAll(/<details class="claim report-card"[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((match) => match[1]);
  assert.equal(summaries.length, 1);
  for (const s of summaries) assert.doesNotMatch(s, /<button/, s);
  assert.match(page, /<div class="c-body"><p class="report-actions"><button type="button" class="copy-prompt" data-prompt="brief">Copy prompt<\/button><\/p>/);
  const css = readFileSync(fileURLToPath(new URL("./hub/page.css", import.meta.url)), "utf8");
  assert.match(css, /\.claim > summary::after \{ content: "\+" \/ ""; /);
});

test("design: Needs you does not say nothing waits while it lists problems", async () => {
  const quiet = await renderDesign({ questions: [], runs: [], triggers: [] });
  assert.match(section(quiet, "needs-you"), /<p class="empty">Nothing waits for you\.<\/p>/);
  const flagged = await renderDesign({ questions: [], runs: [], triggers: [{ kind: "stall", epic: "100", root: "/r/s" }] });
  const needs = section(flagged, "needs-you");
  assert.doesNotMatch(needs, /Nothing waits for you/);
  assert.match(needs, /<p class="empty">No question waits for you\.<\/p>/);
  assert.match(needs, /#100 stalled: no runner progress/);
});

test("design: text and focus rings reach their contrast, sticky bars never hide focus, tabs wrap instead of scrolling hidden", () => {
  const css = readFileSync(fileURLToPath(new URL("./hub/page.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(",").map((s) => s.trim()).includes(selector))?.[2] ?? "";
  // --faint (#8d969e) is 2.95:1 on the page and 60% ink 4.48:1: both under 4.5:1.
  assert.match(rule(".hub-tabs .epic"), /color: var\(--muted\)/);
  assert.match(rule(".hub-sec > h2"), /color: var\(--muted\)/);
  // The risk text on its 10% tint was 3.97:1; on the plain surface it is 4.75:1.
  assert.doesNotMatch(rule("button.danger"), /background: color-mix/);
  // A 30% halo is under 3:1; buttons keep the page's 2px focus ring.
  assert.equal(rule("button:focus-visible"), "", "button:focus-visible overrides the page focus ring");
  // A text box filled #f4f4f4 on white with a transparent edge is 1.1:1; its edge needs 3:1.
  assert.match(rule(".ve-pop textarea"), /border: 1px solid var\(--muted\)/);
  assert.match(rule("html"), /scroll-padding-block: /);
  assert.match(rule(".hub-tabs"), /flex-wrap: wrap/);
  assert.doesNotMatch(rule(".hub-tabs"), /scrollbar-width: none|overflow-x/);
});

// A transcripts root with one builder lane in it, the shape lanes.test.mjs and
// usage.test.mjs read: enough for /lanes and /usage to show real rows.
const transcriptsFixture = (home) => {
  const root = join(home, "transcripts");
  const folder = join(root, "-Users-x--afk-claude-epics-Users-x-code-projects-atlas-workspace-841-atlas-workspace");
  mkdirSync(folder, { recursive: true });
  const at = new Date().toISOString();
  const cwd = "/Users/x/.afk-claude/epics/Users-x-code-projects-atlas-workspace-841/atlas-workspace";
  const turn = (n, context, tool) => JSON.stringify({
    type: "assistant", timestamp: at,
    message: { id: `m${n}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id: `t${n}`, name: tool, input: { file_path: "src/a.ts", command: "ls" } }], usage: { input_tokens: 10, cache_read_input_tokens: context - 10, cache_creation_input_tokens: 0, output_tokens: 100 } },
  });
  writeFileSync(join(folder, "a.jsonl"), [
    JSON.stringify({ type: "user", cwd, timestamp: at, message: { content: `Read the file ${cwd}/.afk/runs/7/builder-1/prompt.md and execute` } }),
    turn(1, 20_000, "Read"), turn(2, 30_000, "Edit"),
  ].join("\n"));
  return root;
};

test("the machine-wide AFK spending and AFK lanes views are served by the hub with no dashboard running, from the same pages and readers", async (t) => {
  const m = machine();
  const hub = await startHub(m, { AFK_TRANSCRIPTS_ROOT: transcriptsFixture(m.home), AFK_LANES_CACHE: join(m.home, "lanes-cache.json") });
  t.after(hub.stop);
  const usagePage = await fetch(`${hub.base}/usage.html?embed=1`);
  assert.equal(usagePage.status, 200);
  const usageHtml = await usagePage.text();
  assert.match(usageHtml, /<title>AFK usage<\/title>/);
  assert.match(usageHtml, /<body data-embed>/, "?embed=1 marks the page so its own nav links hide");
  assert.doesNotMatch(await (await fetch(`${hub.base}/usage.html`)).text(), /<body data-embed>/);
  assert.match(await (await fetch(`${hub.base}/lanes.html?embed=1`)).text(), /<title>AFK lanes<\/title>[\s\S]*<body data-embed>/);
  const lanes = await (await fetch(`${hub.base}/lanes?days=30`)).json();
  assert.equal(lanes.headline.lanes, 1, JSON.stringify(lanes.headline));
  assert.equal((await (await fetch(`${hub.base}/lanes/compare?since=2000-01-01`)).json()).after.lanes, 1);
  const usage = await (await fetch(`${hub.base}/usage`)).json();
  assert.ok(usage.insights, "usage carries its insights block");
  assert.equal((await fetch(`${hub.base}/usage?all=1`)).status, 200);
});

test("the tab bar ends with the AFK spending and AFK lanes tabs, framing the embedded pages, even with no run open", async (t) => {
  const m = machine();
  const hub = await startHub(m);
  t.after(hub.stop);
  const strip = hub.page.match(/<nav class="hub-tabs" role="tablist"[\s\S]*?<\/nav>/)?.[0];
  const tabs = [...strip.matchAll(/<button [^>]*role="tab"[^>]*data-tab="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((x) => [x[1], x[2].replace(/<[^>]+>/g, "").trim()]);
  assert.deepEqual(tabs.slice(-2), [["spending", "AFK spending"], ["lanes", "AFK lanes"]]);
  assert.equal(tabs[0][0], "overview");
  assert.match(panel(hub.page, "spending") ?? "", /<iframe [^>]*data-src="\/usage\.html\?embed=1"/);
  assert.match(panel(hub.page, "lanes") ?? "", /<iframe [^>]*data-src="\/lanes\.html\?embed=1"/);
});

test("design: the tab bar sits on the --fill grey, the two machine tabs are pinned right and never wrap away", () => {
  const css = readFileSync(fileURLToPath(new URL("./hub/page.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(",").map((s) => s.trim()).includes(selector))?.[2] ?? "";
  assert.match(css, /--fill: #/, "the --fill token exists");
  assert.match(rule(".hub-tabs"), /background: var\(--fill\)/);
  assert.match(rule(".hub-tabs .pin"), /order: 1/);
  assert.match(rule(".hub-tabs .pin-first"), /margin-left: auto/);
});

// ---- The hub artifact (#274): snapshot, page, threads -------------------

// A fixture transcripts folder: `lanes` builder lanes of epic 841, each with
// `turns` assistant messages of 10 input and 100 output tokens, written now.
const laneTranscriptsFixture = (home, { lanes = 2, turns = 3 } = {}) => {
  const root = join(home, "transcripts");
  const folder = join(root, "-Users-x--afk-claude-epics-Users-x-code-projects-atlas-workspace-841-atlas-workspace");
  mkdirSync(folder, { recursive: true });
  const cwd = "/Users/x/.afk-claude/epics/Users-x-code-projects-atlas-workspace-841/atlas-workspace";
  const at = new Date().toISOString();
  for (let lane = 1; lane <= lanes; lane += 1) {
    const lines = [JSON.stringify({ type: "user", cwd, timestamp: at, message: { content: `Read the file ${cwd}/.afk/runs/${lane}/builder-1/prompt.md and execute` } })];
    for (let turn = 1; turn <= turns; turn += 1) {
      lines.push(JSON.stringify({ type: "assistant", timestamp: at, message: { id: `m${lane}-${turn}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id: `t${lane}${turn}`, name: turn === turns ? "Edit" : "Read", input: { file_path: "src/a.ts" } }], usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
    }
    writeFileSync(join(folder, `lane-${lane}.jsonl`), `${lines.join("\n")}\n`);
  }
  return root;
};

const snapshotEnv = (m) => ({
  ...m.env,
  AFK_TRANSCRIPTS_ROOT: laneTranscriptsFixture(m.home),
  AFK_LANES_CACHE: join(m.home, "cache", "lanes-cache.json"),
  AFK_USAGE_CACHE: join(m.home, "cache", "usage-cache.json"),
});

test("#274: afk hub snapshot writes the document, 50 night-log entries, usage and lanes summaries, and prints its doc_id", async () => {
  const m = machine();
  const root = checkout(m.home, "riverbend", {
    dag: { epic: { id: "9", title: "x" }, branch: "afk/epic-9", tasks: [{ id: "3", humanGated: true }] },
    dashboardSkipped: { at: new Date().toISOString(), reason: "test" },
  });
  const events = Array.from({ length: 60 }, (_, i) => ["note", { text: `night note ${i + 1}` }]);
  await storeRun(m, { adopted: [{ epic: "9", root }], events });
  const env = snapshotEnv(m);
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout.trim(), /^\d{8}T\d{4}Z$/);
  assert.ok(readFileSync(out).length < 256 * 1024);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(doc), ["at", "mode", "cosRun", "runs", "gates", "asks", "nightLog", "usage", "lanes"]);
  assert.equal(r.stdout.trim(), doc.at.replace(/[-:]/g, "").slice(0, 13) + "Z");
  assert.equal(doc.mode, "day");
  assert.equal(doc.cosRun.closed, false);
  assert.equal(doc.nightLog.length, 50);
  assert.equal(doc.nightLog[0].text, "night note 60", "newest first");
  assert.equal(doc.nightLog.at(-1).text, "night note 11");
  assert.deepEqual(doc.runs.map((run) => [run.project, run.epic, run.status]), [["riverbend", "9", "no dashboard"]]);
  assert.deepEqual(doc.gates, [{ project: "riverbend", epic: "9", task: "3" }]);
  // 2 lanes x 3 messages of 10 input and 100 output tokens.
  assert.equal(doc.usage.total.messages, 6);
  assert.equal(doc.usage.total.input, 60);
  assert.equal(doc.usage.total.output, 600);
  assert.ok(doc.usage.spentUsd > 0);
  assert.deepEqual(doc.usage.byProject.map((row) => [row.key, row.messages]), [["atlas-workspace", 6]]);
  assert.deepEqual(doc.usage.byRole.map((row) => [row.key, row.messages]), [["builder", 6]]);
  assert.equal(doc.lanes.total.lanes, 2);
  assert.equal(doc.lanes.total.edited, 2);
  assert.deepEqual(doc.lanes.byProject.map((row) => [row.key, row.lanes]), [["atlas-workspace", 2]]);
  assert.deepEqual(doc.lanes.byRole.map((row) => [row.key, row.lanes]), [["builder", 2]]);
  // Summaries only: no per-lane or per-transcript rows.
  assert.deepEqual(Object.keys(doc.lanes), ["window", "days", "total", "byProject", "byRole"]);
  assert.deepEqual(Object.keys(doc.usage), ["window", "budgetUsd", "spentUsd", "remainingUsd", "budgetShare", "total", "byProject", "byRole"]);
  // The usage parse is cached on disk for the next check-in.
  assert.ok(existsSync(env.AFK_USAGE_CACHE));
  const again = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).usage.total.messages, 6, "a warm cache gives the same totals");
});

// #273: a runner parked at a `gate: after` task has exited, so #277 cleared
// its `dashboard` and it records no `dashboardSkipped`. The gate still waits
// for the owner: the run is listed, and the snapshot carries the gate card.
// An exited run with nothing awaiting acceptance stays unlisted.
test("#273: an exited run parked at a gate is listed with that gate, on listRuns and in the snapshot", async () => {
  const m = machine();
  const parked = checkout(m.home, "afk-claude", {
    dag: { epic: { id: "273", title: "x" }, branch: "feat/273", tasks: [{ id: "274" }, { id: "275", dependsOn: ["274"] }] },
    tasks: { 274: { lifecycle: "passed" }, 275: { lifecycle: "awaiting_acceptance" } },
    dashboard: null,
  });
  const drained = checkout(m.home, "drained", {
    dag: { epic: "280", branch: "feat/280", tasks: [{ id: "281" }] },
    tasks: { 281: { lifecycle: "passed" } },
    dashboard: null,
  });
  // Parked at a `gate: before`: the gated task is pending and its dependency
  // passed, which the check-in's `openGates` counts as an open gate.
  const before = checkout(m.home, "before", {
    dag: { epic: "290", branch: "feat/290", tasks: [{ id: "291" }, { id: "292", humanGated: true, dependsOn: ["291"] }] },
    tasks: { 291: { lifecycle: "passed" } },
    dashboard: null,
  });
  await storeRun(m, { adopted: [{ epic: "273", root: parked }, { epic: "280", root: drained }, { epic: "290", root: before }] });
  const env = snapshotEnv(m);
  const { listRuns } = await import("./hub/runs.mjs");
  const runs = await listRuns(env);
  assert.deepEqual(runs.map((run) => [run.id, run.status, run.port, run.dashboard, run.source, run.gates]),
    [["afk-claude#273", "waits for you", null, null, "state.json", ["275"]],
      ["before#290", "waits for you", null, null, "state.json", ["292"]]]);
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(doc.runs.map((run) => [run.project, run.epic, run.status, run.gates]),
    [["afk-claude", "273", "waits for you", ["275"]], ["before", "290", "waits for you", ["292"]]]);
  assert.deepEqual(doc.gates, [{ project: "afk-claude", epic: "273", task: "275" }, { project: "before", epic: "290", task: "292" }]);
});

// The store keeps every chief of staff run, so an older run's adopted epic
// parked at a gate is still listed. The snapshot is the open run's: only its
// `epics`, its `adopted` roots and the epics its plan names.
test("the snapshot holds only the open chief of staff run's epics, adopted roots and planned epics", async () => {
  const m = machine();
  const gated = (name, epic) => checkout(m.home, name, {
    dag: { epic, branch: `feat/${epic}`, tasks: [{ id: "2" }] },
    tasks: { 2: { lifecycle: "awaiting_acceptance" } },
    dashboard: null,
  });
  const old = gated("old-repo", "1326");
  const named = gated("mac-directory", "1");
  const adopted = gated("adopted-repo", "55");
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const before = createRun({ root: m.env.AFK_COS_ROOT, mode: "night", epics: [], adopted: [{ epic: "1326", root: old }] });
  appendEvent(before.dir, "stop", {});
  const open = createRun({ root: m.env.AFK_COS_ROOT, mode: "day", epics: ["1"], adopted: [{ epic: "55", root: adopted }] });
  const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
  appendEvent(open.dir, "checkin", { runs: [{ root: named }] });
  appendEvent(open.dir, "plan", { epics: [{ epic: "8", project: "mac-directory", label: "queued", launch: at(60), phases: [{ kind: "build", start: at(60), minutes: 60 }] }] });
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env: snapshotEnv(m), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(doc.runs.map((run) => run.id).sort(), ["adopted-repo#55", "mac-directory#1"]);
  assert.deepEqual(doc.gates.map((gate) => gate.epic).sort(), ["1", "55"]);
  assert.deepEqual(doc.unlaunched.map((row) => [row.project, row.epic]), [["mac-directory", "8"]]);
});

test("#274: an exited run closed under 24 h ago reaches the snapshot with closedAt; one closed 25 h ago does not", async () => {
  const m = machine();
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  const closedRun = (name, h) => checkout(m.home, name, {
    dag: { epic: { id: "9", title: "x" }, branch: `feat/${name}`, tasks: [{ id: "1" }] },
    tasks: { 1: { lifecycle: "passed" } },
    dashboard: null,
    epicClose: { lifecycle: "closed", outcome: "complete", closedAt: hoursAgo(h) },
  });
  const recent = closedRun("recent", 1);
  const old = closedRun("old", 25);
  await storeRun(m, { adopted: [{ epic: "9", root: recent }, { epic: "9", root: old }] });
  const env = snapshotEnv(m);
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  const recentClose = JSON.parse(readFileSync(join(recent, ".afk", "state.json"), "utf8")).epicClose.closedAt;
  assert.deepEqual(doc.runs.map((run) => [run.project, run.epic, run.status, run.closedAt]), [["recent", "9", "closed", recentClose]]);
  // The local hub page draws it closed, not as a dashboard that did not start.
  const { renderPage, hubView } = await import("./hub/page.mjs");
  const html = renderPage(await hubView(env), { token: "t" });
  assert.match(html, /none — the run closed/);
  assert.doesNotMatch(html, /did not start/);
});

test("#274: the artifact draws an Orchestrator fatal and a run's progress as words, never [object Object]", async () => {
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const html = drawSnapshot({ at: "2026-10-19T10:00:00Z", runs: [{ project: "p", epic: "1", status: "running", progress: { total: 4, passed: 1 }, fatal: { at: "2026-10-19T09:00:00Z", message: "boom" } }] });
  assert.match(html, /<p class="pill red">boom<\/p>/);
  assert.match(html, /1 of 4 tasks passed/);
  assert.doesNotMatch(html, /object Object/);
});

test("#274: a snapshot over 256 KB drops its oldest night-log entries until it fits, and says so on stderr", async () => {
  const m = machine();
  const events = Array.from({ length: 50 }, (_, i) => ["note", { text: `${i + 1} ${"x".repeat(8_000)}` }]);
  await storeRun(m, { events });
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env: snapshotEnv(m), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(out).length < 256 * 1024);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(doc.nightLog.length < 50 && doc.nightLog.length > 20);
  assert.match(doc.nightLog[0].text, /^50 /, "the newest entries are kept");
  assert.match(r.stderr, new RegExp(`dropped the ${50 - doc.nightLog.length} oldest night-log entries`));
});

// A snapshot as `afk hub snapshot` writes it, for the page and the router.
const fixtureSnapshot = () => {
  const at = "2026-10-19T14:30:00.000Z";
  const hoursBefore = (h) => new Date(Date.parse(at) - h * 3_600_000).toISOString();
  return {
    at,
    mode: "night",
    cosRun: { id: "20261019-120000-night", mode: "night", startedAt: hoursBefore(2), closed: false },
    runs: [
      { id: "atlas#1232", project: "atlas", epic: "1232", status: "running", gates: ["7"], closedAt: null },
      { id: "riverbend#143", project: "riverbend", epic: "143", status: "running", gates: [], closedAt: hoursBefore(23) },
      { id: "quillnote#88", project: "quillnote", epic: "88", status: "running", gates: [], closedAt: hoursBefore(25) },
    ],
    gates: [{ project: "atlas", epic: "1232", task: "7" }],
    asks: [{ id: "pick-db", title: "Which database?", why: "", options: [], rec: null, from: "orch-1232", ts: hoursBefore(1) }],
    nightLog: [{ ts: hoursBefore(1), kind: "note", text: "baseline green" }],
    usage: { spentUsd: 12.5, budgetUsd: 200, budgetShare: 0.0625, total: { messages: 6 }, byProject: [{ key: "atlas", costUsd: 12.5, messages: 6 }], byRole: [{ key: "builder", costUsd: 12.5, messages: 6 }] },
    lanes: { days: 7, total: { lanes: 2, edited: 2, peakShare: 0.4, costUsd: 12.5 }, byProject: [{ key: "atlas", lanes: 2, peakShare: 0.4, costUsd: 12.5 }], byRole: [{ key: "builder", lanes: 2, peakShare: 0.4, costUsd: 12.5 }] },
    report: { id: "20261019-120000-night", summary: "All green.", sections: [{ key: "atlas#1232", text: "merged" }] },
  };
};

test("#274: the hub artifact page draws every card with its fixed id, marks a run closed 23 h ago with a closed pill, drops one closed 25 h ago, and says as of", async () => {
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const snapshot = fixtureSnapshot();
  const html = drawSnapshot(snapshot, { now: Date.parse(snapshot.at) + 7 * 60_000 });
  for (const id of ["cos", "run-atlas-1232", "gate-atlas-1232-7", "ask-pick-db", "report", "usage", "lanes"]) {
    assert.match(html, new RegExp(`<section class="[\\w-]+" id="${id}" data-comment-target[ >]`), id);
  }
  assert.match(html, /<section class="epic" id="run-riverbend-143" data-comment-target>[\s\S]*?<span class="pill">closed<\/span>/);
  assert.doesNotMatch(html, /run-quillnote-88/);
  const d = new Date(snapshot.at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.match(html, new RegExp(`As of <time datetime="${snapshot.at}">${hhmm}</time> \\(7 min ago\\)`));
});

test("#273: a snapshot with a report draws a Report tab after Night log and a report panel that takes a comment; one without draws neither", async () => {
  const { cardIds, drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const snapshot = fixtureSnapshot();
  snapshot.report.summary = "All green.\n<b>two</b> lines";
  const now = Date.parse(snapshot.at);
  const html = drawSnapshot(snapshot, { now });
  const tabs = [...html.match(/<div class="seg" role="tablist" aria-label="Hub views">([\s\S]*?)<\/div>/)[1].matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["hub", "decide", "log", "report"]);
  assert.match(html, /<button type="button" role="tab" data-tab="report" aria-selected="false">Report<\/button>/);
  assert.match(html, /<div data-panel="report" class="sec" id="panel-report" hidden>\s*<section class="panel-card" id="report" data-comment-target>/);
  assert.ok(cardIds(snapshot).includes("report"));
  assert.ok(html.includes("All green.\n&lt;b&gt;two&lt;/b&gt; lines"), "the summary is drawn as written, escaped");
  assert.match(html, /<h2>atlas#1232<\/h2><p style="white-space:pre-wrap">merged<\/p>/);
  delete snapshot.report;
  const bare = drawSnapshot(snapshot, { now, state: { tab: "report" } });
  assert.doesNotMatch(bare, /data-tab="report"|data-panel="report"|id="report"/);
  assert.ok(!cardIds(snapshot).includes("report"));
  // A saved Report tab with no report falls back to Hub.
  assert.match(bare, /<div data-panel="hub" class="sec" id="panel-hub">/);
});

test("#274: afk hub artifact --out writes a self-contained page that reads the newest snapshot through db and inlines the drawing", () => {
  const m = machine();
  const out = join(m.home, "hub-artifact.html");
  const r = m.hub("artifact", "--out", out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // #273: Respond sends through comments.sendToClaude, which needs the full comments grant.
  assert.ok(r.stdout.includes('Publish it with capabilities {comments: {}, db: {rules: [{path: "snapshots", read: "view", write: "owner"}]}}'), r.stdout);
  const page = readFileSync(out, "utf8");
  assert.match(page, /^<title>AFK Hub<\/title>/);
  assert.match(page, /use\("db"\)/);
  assert.match(page, /collection\("snapshots"\)\.orderBy\("at", "desc"\)\.limit\(1\)/);
  assert.match(page, /const drawSnapshot = /);
  assert.doesNotMatch(page, /^export /m);
  assert.doesNotMatch(page, /<script[^>]+src=/, "no external script");
  const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
});

// The router's machine: an open run with an Orchestrator's ask and the chief
// of staff's own, and a relays.log that already carries one thread.
const threadsMachine = async () => {
  const m = machine();
  await storeRun(m, { events: [
    ["ask", { id: "pick-db", title: "Which database?", why: "", options: [], rec: null, from: "orch-1232" }],
    ["ask", { id: "ship-it", title: "Ship tonight?", why: "", options: [{ value: "y", label: "yes" }, { value: "n", label: "no" }], rec: "y" }],
  ] });
  writeFileSync(join(m.home, ".afk-claude", "orchestrators", "relays.log"),
    `${JSON.stringify({ at: "2026-10-19T07:40:00Z", name: "orch-1232", text: 'Relayed by the chief of staff. The owner said, in "afk hub artifact, thread T-done" at 13:10 IST, verbatim: "go"' })}\n`);
  const snapshotFile = join(m.home, "snapshot.json");
  writeFileSync(snapshotFile, JSON.stringify(fixtureSnapshot()));
  const route = (threads, { snapshot = false } = {}) => {
    const input = join(m.home, "threads.json");
    writeFileSync(input, JSON.stringify({ threads }));
    const r = spawnSync(process.execPath, [afk, "hub", "threads", "--in", input, ...(snapshot ? ["--snapshot", snapshotFile] : [])], { env: { ...m.env, TZ: "UTC" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const log = () => {
    const path = join(m.env.AFK_COS_ROOT, "hub-threads.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  return { m, route, log };
};

const OWNER = "the user (owner)";
const thread = (id, anchor, comments = [{ by: OWNER, at: "2026-10-19T07:33", sentToClaude: true, text: "ping" }], extra = {}) =>
  ({ id, status: "open", activated: true, anchor, comments, ...extra });
const herdr = fileURLToPath(new URL("./orchestrator-herdr.mjs", import.meta.url));
const relayLine = (to, said, id) => `node ${herdr} relay ${to} --said ${said} --at '07:33 UTC' --session 'afk hub artifact, thread ${id}'`;

test("#274 threads rule 1: a thread not sent to Claude is skipped", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T1", "#run-atlas-1232", undefined, { activated: false })]);
  assert.deepEqual(action, { thread: "T1", action: "skip", why: "not sent to Claude" });
});

test("#274 threads rule 2: a resolved thread is skipped", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T2", "#run-atlas-1232", undefined, { status: "resolved" })]);
  assert.deepEqual(action, { thread: "T2", action: "skip", why: "resolved" });
});

test("#274 threads rule 2: a thread Claude replied to last is skipped", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T3", "#run-atlas-1232", [
    { by: OWNER, at: "2026-10-19T07:33", text: "ping" },
    { by: "Claude", at: "2026-10-19T07:40", text: "Relayed to orch-1232" },
  ])]);
  assert.deepEqual(action, { thread: "T3", action: "skip", why: "Claude replied last" });
});

test("#274 threads rule 3: a comment that is not the owner's is refused, never relayed", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T4", "#run-atlas-1232", [{ by: "a viewer (commenter)", at: "2026-10-19T07:33", text: "do it" }])]);
  assert.deepEqual(action, { thread: "T4", commentAt: "2026-10-19T07:33", action: "refuse", reply: "not relayed: not the owner's comment" });
});

test("#274 threads rule 4: a thread already in relays.log is reply-only", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T-done", "#run-atlas-1232")]);
  assert.deepEqual(action, { thread: "T-done", commentAt: "2026-10-19T07:33", action: "reply-only" });
});

test("#274 threads rule 4: the whole thread id must match, in the session field", async () => {
  const { routeThread } = await import("./hub/threads.mjs");
  const relayedText = (id, said) => `Relayed by the chief of staff. The owner said, in "afk hub artifact, thread ${id}" at 13:10 IST, verbatim: "${said}"`;
  const route = (id, relayed) => routeThread(thread(id, "#run-atlas-1232"), { relayed }).action;
  assert.equal(route("1", [relayedText("12", "go")]), "relay", "thread 12's relay is not thread 1's");
  assert.equal(route("1", [relayedText("12", "same as thread 1")]), "relay", "owner words naming thread 1 are not its session");
  assert.equal(route("12", [relayedText("12", "go")]), "reply-only");
});

test("#274 threads rule 5: an answer on an Orchestrator's ask is recorded and relayed to the asker", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T6", "#ask-pick-db", [{ by: OWNER, at: "2026-10-19T07:33", text: "use sqlite, it's enough" }])]);
  assert.equal(action.action, "answer-and-relay");
  assert.equal(action.to, "orch-1232");
  assert.equal(action.ask, "pick-db");
  assert.equal(action.command, relayLine("orch-1232", `'use sqlite, it'\\''s enough'`, "T6"));
  assert.equal(action.answer, `afk cos answer --id=pick-db 'use sqlite, it'\\''s enough'`);
});

test("#274 threads rule 5: a comment on a run card is relayed to that epic's Orchestrator", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T8", "#run-atlas-1232")]);
  assert.equal(action.action, "relay");
  assert.equal(action.to, "orch-1232");
  assert.equal(action.command, relayLine("orch-1232", "ping", "T8"));
});

test("#274 threads rule 5: a comment on a gate card is relayed to that epic's Orchestrator", async () => {
  const { route } = await threadsMachine();
  const [action] = route([thread("T9", "#gate-atlas-1232-7", [{ by: OWNER, at: "2026-10-19T07:33", text: "accept gate 7" }])], { snapshot: true });
  assert.equal(action.action, "relay");
  assert.equal(action.to, "orch-1232");
  assert.equal(action.task, "7");
  assert.equal(action.command, relayLine("orch-1232", "'accept gate 7'", "T9"));
});

test("#274 threads rule 5: a comment on the chief of staff card, the report or no card is for the chief of staff", async () => {
  const { route } = await threadsMachine();
  const actions = route([thread("T10a", "#cos"), thread("T10b", "#report"), thread("T10c", null)]);
  assert.deepEqual(actions, ["T10a", "T10b", "T10c"].map((id) => ({ thread: id, commentAt: "2026-10-19T07:33", action: "cos" })));
});

test("#274 threads rule 5: an answer on the chief of staff's own ask is record-decision, carrying the ask and the owner's words", async () => {
  const { routeThread } = await import("./hub/threads.mjs");
  const asks = [{ id: "ship-it", title: "Ship tonight?" }, { id: "pick-db", title: "Which database?", from: "orch-1232" }];
  const action = routeThread(thread("T7", "#ask-ship-it", [{ by: OWNER, at: "2026-10-19T07:33", text: "yes, ship it" }]), { asks });
  assert.deepEqual(action, { thread: "T7", commentAt: "2026-10-19T07:33", action: "record-decision", ask: "ship-it", text: "yes, ship it" });
});

test("#273 threads rule 5: a comment on the usage or lanes card on the hub is for the chief of staff", async () => {
  const { route } = await threadsMachine();
  const actions = route([thread("T12a", "#usage"), thread("T12b", "#lanes")], { snapshot: true });
  assert.deepEqual(actions.map((a) => a.action), ["cos", "cos"]);
});

test("#274 threads rule 5: a card no longer in the snapshot asks which epic", async () => {
  const { route } = await threadsMachine();
  // Closed 25 h before the snapshot: no longer drawn, so no longer a card.
  const [action] = route([thread("T11", "#run-quillnote-88")], { snapshot: true });
  assert.equal(action.action, "ask-which-epic");
  assert.match(action.reply, /#run-quillnote-88 is no longer on the hub/);
});

test("#274: afk hub threads appends one hub-threads.jsonl line per acted-on thread and none for a skip", async () => {
  const { route, log } = await threadsMachine();
  route([
    thread("A", "#run-atlas-1232"),
    thread("B", "#cos"),
    thread("C", "#run-atlas-1232", undefined, { activated: false }),
    thread("D", "#run-atlas-1232", undefined, { status: "resolved" }),
  ]);
  const rows = log();
  assert.deepEqual(rows.map((row) => [row.threadId, row.action, row.commentAt]), [["A", "relay", "2026-10-19T07:33"], ["B", "cos", "2026-10-19T07:33"]]);
  for (const row of rows) assert.deepEqual(Object.keys(row), ["threadId", "commentAt", "decidedAt", "action"]);
});

// ---- The hub artifact redesign (#273, 2026-10-19) -----------------------

// The frozen design's working-state snapshot: three epics, every field drawn.
const hubFixture = () => JSON.parse(readFileSync(new URL("./hub/fixtures/hub-snapshot.json", import.meta.url), "utf8"));
const fixtureNow = (s) => Date.parse(s.at) + 2 * 60_000;

test("#273: drawSnapshot draws the fixture's three runs as epic cards and as rows of the Gantt", async () => {
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const s = hubFixture();
  const html = drawSnapshot(s, { now: fixtureNow(s) });
  for (const run of s.runs) {
    assert.match(html, new RegExp(`<section class="epic" id="run-${run.project}-${run.epic}" data-comment-target>`), run.id);
    assert.match(html, new RegExp(`<b><span class="dot" style="color:var\\(--c\\)"></span>${run.project} #${run.epic}</b><small>${run.activity}</small>`), run.id);
  }
  // One Gantt bar per planned phase and per logged span.
  const bars = s.runs.reduce((n, run) => n + run.planned.length + run.timeline.length, 0);
  assert.equal((html.match(/class="gx-bar /g) ?? []).length, bars);
  assert.match(html, /<h1 id="title">3 epics running<\/h1>/);
  assert.match(html, /<span class="sub">2 building · 1 at a gate · 8 of 14 tasks passed<\/span>/);
  // A run whose dashboard did not start is still building (#277).
  const noDashboard = drawSnapshot({ ...s, runs: s.runs.map((run) => (run.epic === "301" ? { ...run, status: "no dashboard" } : run)) }, { now: fixtureNow(s) });
  assert.match(noDashboard, /<span class="sub">2 building · 1 at a gate/);
});

test("#273: the lanes row reads now 3, peak 5, cap 6 on the fixture, and draws red blocks over a cap of 3", async () => {
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const s = hubFixture();
  const red = /<rect [^>]*style="fill:var\(--red\)"\/>/g;
  const html = drawSnapshot(s, { now: fixtureNow(s) });
  assert.match(html, /<b>Lanes at once<\/b><small>3 now · peak 5 · cap 6<\/small>/);
  assert.equal((html.match(red) ?? []).length, 0, "nothing over a cap of 6");
  const capped = drawSnapshot({ ...s, laneCap: 3 }, { now: fixtureNow(s) });
  assert.match(capped, /<small>3 now · peak 5 · cap 3<\/small>/);
  assert.ok((capped.match(red) ?? []).length > 0, "over a cap of 3 is red");
  const { laneCap, ...uncapped } = s;
  const none = drawSnapshot(uncapped, { now: fixtureNow(s) });
  assert.match(none, /<small>3 now · peak 5<\/small>/, "no cap known, no cap drawn");
  assert.doesNotMatch(none, /gx-cap|stroke:var\(--red\)/);
});

test("#273: a ticket's spans under 15 min apart hold one lane; 15 min or more apart they are two", async () => {
  const { heldSpans } = await import("./hub/artifact-draw.mjs");
  const t = (hm) => `2026-10-19T${hm}:00.000Z`;
  const span = (label, start, end, open = false) => ({ kind: "build", label, start: t(start), end: t(end), open });
  const held = heldSpans([
    span("1", "10:00", "10:20"), span("1", "10:34", "10:50"),
    span("2", "10:00", "10:20"), span("2", "10:35", "10:40"),
    { kind: "gate-human", label: "3", start: t("10:00"), end: t("11:00"), open: false },
    span("4", "10:00", "10:30", true),
  ], Date.parse(t("11:30")));
  assert.deepEqual(held.map(([a, b]) => [new Date(a).toISOString().slice(11, 16), new Date(b).toISOString().slice(11, 16)]),
    [["10:00", "10:50"], ["10:00", "10:20"], ["10:35", "10:40"], ["10:00", "11:30"]]);
});

const dagTops = (html) => Object.fromEntries([...html.matchAll(/<div class="dag-node t-[\w-]+" style="left:[\d.-]+px;top:(\d+)px[^>]*><div class="dag-head"><b>#([^<]+)<\/b>/g)].map(([, top, id]) => [id, Number(top)]));

test("#273: the task DAG puts each task one band below its deepest dependency, and a cycle still draws", async () => {
  const { drawSnapshot, taskDag } = await import("./hub/artifact-draw.mjs");
  const s = hubFixture();
  const html = drawSnapshot(s, { now: fixtureNow(s), state: { open: { "run-riverbend-301": true } } });
  // A band is 66 px of node and 40 px of gap.
  assert.deepEqual(dagTops(html), { 302: 0, 303: 0, 305: 106, 304: 106, 306: 212, 307: 212, 308: 318 });
  const cycle = taskDag([{ id: "a", title: "A", status: "waiting", after: ["b"] }, { id: "b", title: "B", status: "waiting", after: ["a"] }, { id: "c", title: "C", status: "waiting", after: ["c"] }]);
  assert.deepEqual(dagTops(cycle), { b: 0, c: 0, a: 106 });
});

// Run the shipped page's script against a stub DOM and a fake db holding `docs`.
// `comments` stubs the comments API; `get(sel)` is the stub element a selector
// returns, and each element's and the document's listeners land in `.on`.
const runArtifactPage = async (docs, { comments = null } = {}) => {
  const vm = await import("node:vm");
  const { artifactPage } = await import("./hub/artifact.mjs");
  const page = artifactPage();
  const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
  const els = new Map();
  const el = () => { const on = {}; return { on, innerHTML: "", textContent: "", hidden: false, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener: (type, fn) => { on[type] = fn; }, focus() {}, remove() {}, querySelector: get }; };
  const get = (sel) => { if (!els.has(sel)) els.set(sel, el()); return els.get(sel); };
  const document = { on: {}, querySelector: get, querySelectorAll: () => [], getElementById: (id) => get(`#${id}`), addEventListener: (type, fn) => { document.on[type] = fn; }, documentElement: el(), body: { append() {} }, createElement: el };
  const db = { collection: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: (ok) => ok({ docs: docs.map((doc) => ({ data: () => doc })) }) }) }) }) };
  const window = { claude: { use: async (name) => (name === "db" ? db : name === "comments" ? comments : null) } };
  vm.runInNewContext(script, { window, document, setInterval: () => 0, setTimeout: () => 0, matchMedia: () => ({ matches: false }), scrollY: 0, scrollTo() {}, TextEncoder, console });
  await new Promise((resolve) => setImmediate(resolve));
  return { page, main: get("#hub").innerHTML, get, document };
};

// Press the element a click handler finds with `closest(sel)`.
const clickOn = (document, sel) => document.on.click({ target: { closest: (s) => (s === sel ? {} : null) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("#273: after a Respond is sent, each sent decision card and the Respond panel say so with a See reply button; a failed send says nothing of the kind", async () => {
  const SENT = "sent · Claude replies in the comments on the header card";
  const composed = [];
  const stub = (sendToClaude) => ({ canSendToClaude: async () => "available", anchorFor: async () => ({}), sendToClaude, openComposer: async (o) => { composed.push(o); } });
  const s = hubFixture();
  const send = async (sendToClaude) => {
    const p = await runArtifactPage([s], { comments: stub(sendToClaude) });
    // Answer one decision, open Respond, press Send to Claude.
    p.document.on.change({ target: { closest: () => ({ value: "quarantine", closest: () => ({ dataset: { key: "cos:flaky-304" } }) }) } });
    clickOn(p.document, "#dock-respond");
    await settle();
    await p.get("#r-send").on.click();
    await settle();
    return p;
  };

  const ok = await send(async () => ({ threadId: "T9" }));
  const main = ok.get("#hub").innerHTML;
  const card = (id) => main.slice(main.indexOf(`id="${id}"`), main.indexOf("</section>", main.indexOf(`id="${id}"`)));
  assert.match(card("ask-flaky-304"), new RegExp(SENT), "the sent decision card");
  assert.match(card("ask-flaky-304"), /data-see-reply>See reply<\/button>/);
  assert.doesNotMatch(card("ask-migrate-1294"), /sent ·|See reply/, "an unsent decision has no label");
  assert.match(ok.get("#r-state").innerHTML, new RegExp(SENT), "the Respond panel");
  assert.match(ok.get("#r-state").innerHTML, /data-see-reply>See reply<\/button>/);
  await clickOn(ok.document, "[data-see-reply]");
  await settle();
  assert.equal(composed.length, 1);
  assert.equal(composed[0].element, ok.get("#cos"), "See reply opens the composer at the #cos header card");

  const failed = await send(async () => { throw Object.assign(new Error("no"), { code: "claude_unavailable" }); });
  assert.doesNotMatch(failed.get("#r-state").innerHTML + failed.get("#r-state").textContent, /sent ·|See reply/);
  assert.match(failed.get("#r-state").textContent, /^Not sent/);
  assert.doesNotMatch(failed.get("#hub").innerHTML, /sent ·|See reply/);
});

test("#273: with the snapshots collection empty the page says No snapshot yet and draws no sample data", async () => {
  const fixtureWords = ["riverbend", "atlas", "flaky-304", "migrate-1294", "Sample data"];
  const empty = await runArtifactPage([]);
  assert.match(empty.main, /<h1 id="title">No snapshot yet<\/h1>/);
  assert.match(empty.main, /<section class="top" id="cos" data-comment-target>/, "#cos still takes a comment");
  for (const word of fixtureWords) {
    assert.doesNotMatch(empty.main, new RegExp(word), `drawn: ${word}`);
    assert.doesNotMatch(empty.page, new RegExp(word), `shipped in the page: ${word}`);
  }
  assert.doesNotMatch(empty.page, /__FIXTURE__|id="fixture"/);
  // The same harness with one snapshot draws it, so the empty result is not the harness.
  const full = await runArtifactPage([hubFixture()]);
  assert.match(full.main, /id="run-riverbend-301"/);
});

test("#273: every card id the router knows is drawn on an element that takes a comment", async () => {
  const { cardIds, drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const s = hubFixture();
  const ids = cardIds(s);
  assert.deepEqual(ids, ["cos", "run-riverbend-301", "run-atlas-1290", "run-afk-claude-273", "gate-afk-claude-273-275", "ask-flaky-304", "ask-migrate-1294", "usage", "lanes"]);
  const html = drawSnapshot(s, { now: fixtureNow(s) });
  for (const id of ids) assert.match(html, new RegExp(`<section class="[\\w-]+" id="${id}" data-comment-target[ >]`), id);
});

// A fake epic checkout: state.json, the Runner's agent-auto.log and its lanes' transcripts.
const epicFixture = (m, { name, epic, dag, tasks, extra = {}, log }) => {
  const root = checkout(m.home, name, { dag: { epic: { id: epic, title: "x" }, branch: `feat/${epic}`, tasks: dag }, tasks, ...extra });
  writeFileSync(join(root, ".afk", "agent-auto.log"), `${log.map(([ts, said]) => `[${ts}] AUTO: ${said}`).join("\n")}\n`);
  return root;
};
const spendTranscripts = (home, rows) => {
  const root = join(home, "transcripts");
  for (const { project, epic, at, output } of rows) {
    const folder = join(root, `-Users-x--afk-claude-epics-Users-x-repos-${project}-${epic}-${project}`);
    mkdirSync(folder, { recursive: true });
    const cwd = `/Users/x/.afk-claude/epics/Users-x-repos-${project}-${epic}/${project}`;
    const lines = [
      JSON.stringify({ type: "user", cwd, timestamp: at, message: { content: `Read the file ${cwd}/.afk/runs/1/builder-1/prompt.md and execute` } }),
      JSON.stringify({ type: "assistant", timestamp: at, message: { id: `m-${project}-${at}`, model: "claude-opus-5-5", content: [], usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    ];
    writeFileSync(join(folder, `${project}-${Date.parse(at)}.jsonl`), `${lines.join("\n")}\n`);
  }
  return root;
};

test("#273: afk hub snapshot carries each run's timeline, plan, tasks, spend and activity, and the live runs' lane cap", async () => {
  const m = machine();
  // An hour boundary two hours back, so the 30-minute spend buckets are fixed.
  const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const live = epicFixture(m, {
    name: "riverbend", epic: "301",
    dag: [{ id: "302", title: "Share sheet data model", dependsOn: [] }, { id: "303", title: "Recipient picker", dependsOn: ["302"] }, { id: "304", title: "Send flow e2e", dependsOn: ["302"] }],
    tasks: { 302: { lifecycle: "passed" }, 303: { lifecycle: "running" }, 304: { lifecycle: "pending" } },
    extra: { dashboardSkipped: { at: at(5), reason: "test" } },
    log: [
      [at(-600), "continuous scheduler started (maxParallel=9)."],
      [at(5), "warning: the dashboard did not start; carrying on without it."],
      [at(6), "continuous scheduler started (maxParallel=3)."],
      [at(7), "builder 302 attempt 1 started"],
      [at(20), "302 integrated and passed post-merge verification"],
      [at(21), "builder 303 attempt 1 started"],
    ],
  });
  const parked = epicFixture(m, {
    name: "afk-claude", epic: "273",
    dag: [{ id: "274", title: "Page", dependsOn: [] }, { id: "275", title: "Threads", dependsOn: ["274"], gateAfter: true }],
    tasks: { 274: { lifecycle: "passed" }, 275: { lifecycle: "awaiting_acceptance" } },
    log: [[at(2), "continuous scheduler started (maxParallel=2)."], [at(30), "275 is a `gate: after` acceptance gate"]],
  });
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const run = createRun({ root: m.env.AFK_COS_ROOT, mode: "night", adopted: [{ epic: "301", root: live }, { epic: "273", root: parked }], env: { AFK_COS_NOW: at(0) } });
  appendEvent(run.dir, "plan", { epics: [{ epic: "301", project: "riverbend", label: "share sheet", launch: at(5), phases: [{ kind: "baseline", start: at(5), minutes: 10 }, { kind: "build", start: at(15), minutes: 60, label: "3 tasks" }] }] });
  const env = {
    ...snapshotEnv(m),
    AFK_COS_NOW: at(60),
    // 1M output tokens of Opus 5.5 is $20; the epic-999 message is another epic's.
    AFK_TRANSCRIPTS_ROOT: spendTranscripts(m.home, [
      { project: "riverbend", epic: "301", at: at(10), output: 1_000_000 },
      { project: "riverbend", epic: "301", at: at(40), output: 1_000_000 },
      { project: "riverbend", epic: "999", at: at(41), output: 1_000_000 },
    ]),
  };
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(doc.laneCap, 3, "the live run's newest cap; the parked run is not live");
  const by = (project) => doc.runs.find((row) => row.project === project);
  const share = by("riverbend");
  assert.equal(share.status, "no dashboard");
  assert.deepEqual(share.timeline, [
    { kind: "baseline", label: "baseline", start: at(5), end: at(6), open: false },
    { kind: "build", label: "302", start: at(7), end: at(20), open: false },
    { kind: "build", label: "303", start: at(21), end: at(60), open: true },
  ]);
  assert.deepEqual(share.planned, [
    { kind: "baseline", label: "baseline", start: at(5), end: at(15) },
    { kind: "build", label: "3 tasks", start: at(15), end: at(75) },
  ]);
  assert.deepEqual(share.tasks, [
    { id: "302", title: "Share sheet data model", status: "passed", after: [] },
    { id: "303", title: "Recipient picker", status: "building", after: ["302"] },
    { id: "304", title: "Send flow e2e", status: "waiting", after: ["302"] },
  ]);
  assert.deepEqual(share.spend, [{ at: at(0), usd: 0 }, { at: at(30), usd: 20 }, { at: at(60), usd: 40 }]);
  assert.equal(share.activity, "building 303");
  const gate = by("afk-claude");
  assert.equal(gate.activity, "parked at gate 275");
  assert.deepEqual(gate.tasks.map((task) => task.status), ["passed", "gate"]);
  assert.deepEqual(gate.planned, [], "no plan row for this epic");
  assert.deepEqual(gate.timeline, [{ kind: "gate-human", label: "275", start: at(30), end: at(60), open: true }]);
});

test("#273: a snapshot of a large epic stays under 256 KiB, dropping its oldest closed timeline spans, and says so on stderr", async () => {
  const m = machine();
  const t0 = Date.now() - 20 * 3_600_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  // Task 99 has built since the start and is still open: it holds a lane now.
  const log = [[at(0), "continuous scheduler started (maxParallel=4)."], [at(0), "builder 99 attempt 1 started"]];
  // 30 tasks rebuilt 120 times each: 3,600 more spans, about 400 KB of timeline.
  for (let round = 0; round < 120; round += 1) {
    for (let task = 1; task <= 30; task += 1) {
      const start = 1 + round * 10;
      log.push([at(start), `builder ${task} attempt 1 started`], [at(start + 5), `${task} integrated and passed post-merge verification`]);
    }
  }
  const root = epicFixture(m, {
    name: "big", epic: "500",
    dag: Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), title: `Task ${i + 1}`, dependsOn: [] })),
    tasks: {},
    extra: { dashboardSkipped: { at: at(0), reason: "test" } },
    log,
  });
  const { createRun } = await import("./cos/store.mjs");
  createRun({ root: m.env.AFK_COS_ROOT, mode: "night", adopted: [{ epic: "500", root }], env: { AFK_COS_NOW: at(-1) } });
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env: { ...snapshotEnv(m), AFK_COS_NOW: at(1210) }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const bytes = readFileSync(out).length;
  assert.ok(bytes < 256 * 1024, `${bytes} bytes`);
  const [run] = JSON.parse(readFileSync(out, "utf8")).runs;
  assert.ok(run.timeline.length > 1000 && run.timeline.length < 3601, `${run.timeline.length} spans kept`);
  assert.equal(run.timeline.at(-1).start, at(1191), "the newest spans are kept");
  assert.deepEqual(run.timeline.filter((bar) => bar.open).map((bar) => [bar.label, bar.start]), [["99", at(0)]], "the oldest span, still open, is kept");
  assert.match(r.stderr, new RegExp(`dropped the ${3601 - run.timeline.length} oldest timeline spans`));
  console.log(`large-fixture snapshot: ${bytes} bytes, ${run.timeline.length} of 3601 spans kept`);
});

test("#273: afk hub threads routes a Respond to the chief of staff, split into queue items; a gate answer is reported, never accepted", async () => {
  const { buildDecisions, buildResponse } = await import("./hub/artifact-draw.mjs");
  const { m, route } = await threadsMachine();
  const s = hubFixture();
  const body = buildResponse(buildDecisions(s), {
    answers: {
      "afk-claude#273:gate:275": { value: "accept", how: "picked" },
      "cos:flaky-304": { value: "quarantine", how: "picked", words: "file the flake ticket tonight" },
    },
    sent: {},
    note: "the gantt reads well",
  });
  assert.match(body, /^# Re: afk hub\n/);
  const [action] = route([thread("R1", "#cos", [{ by: OWNER, at: "2026-10-19T19:20", sentToClaude: true, text: body }])]);
  assert.equal(action.action, "cos");
  assert.equal(action.command, undefined, "nothing to run");
  assert.deepEqual(action.respond.items, [{
    id: "R1:cos:flaky-304",
    ts: "2026-10-19T19:20:00.000Z",
    target: "cos",
    via: "respond",
    verdict: null,
    status: "queued",
    ask: "flaky-304",
    from: "orch-301",
    words: "file the flake ticket tonight",
    text: [
      "# Re: afk hub",
      "",
      "## Decisions",
      "1. [ask:cos:flaky-304] Task 304's send-flow e2e test fails about 1 run in 3 on CI. Quarantine it, or hold the merge?",
      "   → **Quarantine the test, merge 304** `quarantine`",
      "   → the owner's words for orch-301, relay verbatim:",
      "     > Quarantine the test, merge 304",
      "     > file the flake ticket tonight",
      "",
    ].join("\n"),
  }]);
  assert.deepEqual(action.respond.gates, [{
    key: "afk-claude#273:gate:275", project: "afk-claude", epic: "273", task: "275", answer: "accept", words: "",
    report: "The owner answered accept on gate 275 of afk-claude #273. Reported only: nothing was accepted.",
  }]);
  assert.deepEqual(action.respond.unanswered, ["cos:migrate-1294"]);
  assert.deepEqual(action.respond.comments, ["the gantt reads well"]);
  assert.deepEqual(m.inbox(), [], "printed, never written to the local inbox");
  // The rules before routing still hold: a Respond from anyone else is refused.
  const [stranger] = route([thread("R2", "#cos", [{ by: "a viewer (commenter)", at: "2026-10-19T19:20", text: body }])]);
  assert.equal(stranger.action, "refuse");
});

test("#273: a Respond split keeps the owner's own words on every gate and ask, each on the entry its > lines follow", async () => {
  const { buildDecisions, buildResponse } = await import("./hub/artifact-draw.mjs");
  const { route } = await threadsMachine();
  // Both fixture asks name a `from`; dropping it gives buildResponse's other
  // shape, where the owner's words are the only `>` lines.
  const decisions = buildDecisions(hubFixture()).map(({ from, ...d }) => (d.key.startsWith("cos:") ? d : { ...d, from }));
  const body = buildResponse(decisions, {
    answers: {
      "afk-claude#273:gate:275": { value: "accept", how: "picked", words: "These are my own words.\nWere you able to read this?" },
      "cos:flaky-304": { value: "quarantine", how: "picked", words: "file the flake ticket tonight" },
      "cos:migrate-1294": { value: "split", how: "picked" },
    },
    sent: {},
    note: "",
  });
  assert.equal(body, [
    "# Re: afk hub",
    "",
    "## Decisions",
    "1. [ask:afk-claude#273:gate:275] Accept task 275 of epic #273?",
    "   → **Accept** `accept`  (`afk epic 273 --accept=275`)",
    "     > These are my own words.",
    "     > Were you able to read this?",
    "2. [ask:cos:flaky-304] Task 304's send-flow e2e test fails about 1 run in 3 on CI. Quarantine it, or hold the merge?",
    "   → **Quarantine the test, merge 304** `quarantine`",
    "     > file the flake ticket tonight",
    "3. [ask:cos:migrate-1294] Integrating 1294 needs a migration of the board cache table. Run it in this epic, or split it into its own ticket?",
    "   → **Split it into a new ticket** `split`",
    "",
  ].join("\n"), "the frozen buildResponse shape");
  const [action] = route([thread("R3", "#cos", [{ by: OWNER, at: "2026-10-19T19:20", sentToClaude: true, text: body }])]);
  assert.deepEqual(action.respond.gates.map((g) => g.words), ["These are my own words.\nWere you able to read this?"]);
  assert.deepEqual(action.respond.items.map((i) => [i.ask, i.words]), [
    ["flaky-304", "file the flake ticket tonight"],
    ["migrate-1294", ""],
  ]);
});

// ---- Last pass on #273 (M2, relays.log fail direction) ------------------

// A fresh `afk hub snapshot`'s asks, by id.
const snapshotAsks = (m) => {
  const out = join(m.home, "fresh-snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env: m.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(readFileSync(out, "utf8")).asks.map((ask) => ask.id);
};

test("#273 M2: a Respond answering the chief of staff's own ask records it, as the local hub does, once", async () => {
  const { m, route } = await threadsMachine();
  assert.ok(snapshotAsks(m).includes("ship-it"), "open before");
  const body = [
    "# Re: afk hub", "", "## Decisions",
    "1. [ask:cos:ship-it] Ship tonight?",
    "   → **no** `n`",
    "     > wait for the morning review",
    "",
  ].join("\n");
  const respond = thread("R9", "#cos", [{ by: OWNER, at: "2026-10-19T19:20", sentToClaude: true, text: body }]);
  const [action] = route([respond]);
  assert.equal(action.action, "cos");
  assert.deepEqual(action.respond.items.map((i) => [i.ask, i.status, i.words]), [["ship-it", "recorded", "wait for the morning review"]]);
  const stored = m.inbox().filter((e) => e.status === "stored");
  assert.equal(stored.length, 1, JSON.stringify(m.inbox()));
  assert.deepEqual([stored[0].target, stored[0].via, stored[0].verdict], ["cos", "respond", null]);
  assert.match(stored[0].text, /\[ask:cos:ship-it\]/);
  assert.ok(!snapshotAsks(m).includes("ship-it"), "closed: gone from a fresh snapshot");
  const [again] = route([respond]);
  assert.deepEqual(again.respond.items.map((i) => i.status), ["already recorded"]);
  assert.equal(m.inbox().filter((e) => e.status === "stored").length, 1, "a rerun records nothing new");
});

test("#273 M2: a plain thread on the chief of staff's own ask card records the owner's words, once", async () => {
  const { m, route } = await threadsMachine();
  const plain = thread("T7", "#ask-ship-it", [{ by: OWNER, at: "2026-10-19T07:33", text: "yes, ship it" }]);
  const [action] = route([plain]);
  assert.deepEqual(action, { thread: "T7", commentAt: "2026-10-19T07:33", action: "recorded", ask: "ship-it", words: "yes, ship it" });
  const stored = m.inbox().filter((e) => e.status === "stored");
  assert.equal(stored.length, 1, JSON.stringify(m.inbox()));
  assert.match(stored[0].text, /\[ask:cos:ship-it\][\s\S]*> yes, ship it/);
  assert.ok(!snapshotAsks(m).includes("ship-it"), "closed: gone from a fresh snapshot");
  const [again] = route([plain]);
  assert.equal(again.action, "reply-only", "already recorded: only the reply is left");
  assert.equal(m.inbox().filter((e) => e.status === "stored").length, 1, "a rerun records nothing new");
  // An Orchestrator's ask keeps its relay routing, and writes nothing.
  const [orch] = route([thread("T6", "#ask-pick-db")]);
  assert.equal(orch.action, "answer-and-relay");
  assert.equal(m.inbox().filter((e) => e.status === "stored").length, 1);
});

test("#273: a relays.log line that does not parse still marks its thread relayed (fails closed)", async () => {
  const { routeThreads } = await import("./hub/threads.mjs");
  const m = machine();
  const line = JSON.stringify({ at: "2026-10-19T07:40:00Z", name: "orch-1232", text: 'Relayed by the chief of staff. The owner said, in "afk hub artifact, thread T1" at 13:10 IST, verbatim: "go ahead' });
  writeFileSync(join(m.home, ".afk-claude", "orchestrators", "relays.log"), line.slice(0, -3));
  const before = process.env.HOME;
  process.env.HOME = m.home;
  try {
    const { actions } = routeThreads({ threads: [thread("T1", "#run-atlas-1232")], env: m.env });
    assert.equal(actions[0].action, "reply-only");
    const { actions: other } = routeThreads({ threads: [thread("T", "#run-atlas-1232")], env: m.env });
    assert.equal(other[0].action, "relay", "thread T is not thread T1");
  } finally { process.env.HOME = before; }
});
