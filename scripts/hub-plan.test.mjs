// scripts/hub-plan.test.mjs — "Tonight's plan" on the hub: `afk cos plan`
// stores the chief of staff's planned rows in the open run, and the hub draws
// them beside what each epic's state.json and agent-auto.log say happened.
// Every test runs against a temp AFK_COS_ROOT and temp epic checkouts; the
// real store and the live hub are never touched.
process.env.TZ = "Asia/Kolkata"; // the axis is local time; pin it so labels are stable

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, readEvents } from "./cos/store.mjs";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

// The night: the run opened 00:15 IST, now is 01:30 IST.
const RUN_AT = "2026-10-15T18:45:00.000Z";
const NOW = "2026-10-15T20:00:00.000Z";

const machine = ({ open = true } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "afk-hub-plan-"));
  const env = { ...process.env, HOME: home, AFK_COS_ROOT: join(home, "cos"), AFK_COS_NOW: NOW, AFK_HUB_PEER_PORTS: "" };
  delete env.AFK_COS_PEERS;
  mkdirSync(env.AFK_COS_ROOT, { recursive: true });
  const run = open ? createRun({ root: env.AFK_COS_ROOT, mode: "night", epics: ["143", "191"], env: { AFK_COS_NOW: RUN_AT } }) : null;
  const cos = (...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env, encoding: "utf8" });
  return { home, env, run, cos };
};

const SAMPLE = {
  epics: [
    {
      epic: "143", project: "riverbend", label: "Mac daily-use fixes", launch: "2026-10-16T00:32+05:30",
      phases: [
        { kind: "baseline", start: "2026-10-16T00:32+05:30", minutes: 5 },
        { kind: "build", start: "2026-10-16T00:37+05:30", minutes: 90, label: "23, 24 build+merge" },
        { kind: "gate-human", start: "2026-10-16T02:07+05:30", minutes: 20, label: "93", caption: "93 waits for the owner to try the signed build" },
      ],
    },
    {
      epic: "191", label: "Website to riverbend.app", launch: "2026-10-16T01:15+05:30",
      phases: [{ kind: "closeout", start: "2026-10-16T03:00+05:30", minutes: 30 }],
      caption: "launches after #143's baseline frees the gate lock",
    },
  ],
};

const writePlan = (m, plan) => {
  const path = join(m.home, "plan.json");
  writeFileSync(path, typeof plan === "string" ? plan : JSON.stringify(plan));
  return path;
};

test("afk cos plan stores the plan as a plan event in the open run", () => {
  const m = machine();
  const out = m.cos("plan", `--file=${writePlan(m, SAMPLE)}`);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /COS: stored the plan for #143, #191 in run /);
  const plans = readEvents(m.run.dir).events.filter((event) => event.kind === "plan");
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].epics.map((row) => row.epic), ["143", "191"]);
  assert.equal(plans[0].epics[0].phases[2].caption, "93 waits for the owner to try the signed build");
});

test("afk cos plan refuses a bad plan, names every problem, and stores nothing", () => {
  const m = machine();
  const bad = {
    epics: [
      { epic: "143", label: "", launch: "00:32", phases: [{ kind: "nap", start: "2026-10-16T01:00+05:30", minutes: -5, colour: "red" }] },
      { epic: "143", label: "dup", launch: "2026-10-16T01:00+05:30", phases: [] },
    ],
  };
  const out = m.cos("plan", `--file=${writePlan(m, bad)}`);
  assert.equal(out.status, 1);
  for (const problem of [
    /epics\[0\]\.label must be a non-empty string/,
    /epics\[0\]\.launch must be an ISO time with a zone/,
    /epics\[0\]\.phases\[0\]\.kind must be one of build, gate-human, baseline, closeout, parked/,
    /epics\[0\]\.phases\[0\]\.minutes must be a positive number/,
    /epics\[0\]\.phases\[0\] has unknown key colour/,
    /epics\[1\]\.epic 143 is planned twice/,
  ]) assert.match(out.stdout, problem, out.stdout);
  assert.equal(readEvents(m.run.dir).events.filter((event) => event.kind === "plan").length, 0);
  const notJson = m.cos("plan", `--file=${writePlan(m, "{nope")}`);
  assert.equal(notJson.status, 1);
  assert.match(notJson.stdout, /COS: plan: .*plan\.json is not JSON/);
});

test("afk cos plan refuses when no run is open", () => {
  const m = machine({ open: false });
  const out = m.cos("plan", `--file=${writePlan(m, SAMPLE)}`);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /COS: no afk cos run is open/);
});

test("the CLI help and cos's verb list name plan", () => {
  const m = machine();
  assert.match(m.cos("bogus").stdout, /Verbs: .*\bplan\b/);
  const help = spawnSync(process.execPath, [afk, "help"], { env: m.env, encoding: "utf8" }).stdout;
  assert.match(help, /cos plan --file=<plan\.json>/);
});

// An epic checkout as the Runner leaves it: state.json and agent-auto.log.
const LOG_143 = [
  "[2026-10-15T17:00:00.000Z] AUTO: builder 9 attempt 1 started at aaaa in /x.", // an earlier night: ignored
  "[2026-10-15T19:02:21.816Z] AUTO: dashboard started at http://localhost:4430 (pid 62115).",
  "[2026-10-15T19:02:51.853Z] AUTO: baseline check still running after 30s: swift build",
  "[2026-10-15T19:06:17.522Z] AUTO: continuous scheduler started (maxParallel=6, base feat/143).",
  "[2026-10-15T19:06:17.522Z] AUTO: 93 is a `gate: after` acceptance gate — no lane, no builder. It is now awaiting_acceptance; release it with --accept=93.",
  "[2026-10-15T19:06:23.400Z] AUTO: builder 23 attempt 1 started at 3e9a9046 in /w/23.",
  "[2026-10-15T19:06:24.000Z] AUTO: builder 24 attempt 1 started at 3e9a9046 in /w/24.",
  "[2026-10-15T19:30:00.000Z] AUTO: builder 23 passed worktree checks and committed 1234abcd; queued for integration.",
  "[2026-10-15T19:31:00.000Z] AUTO: integrator 23 attempt 1 started from 3e9a9046.",
  "[2026-10-15T19:40:00.000Z] AUTO: 23 integrated and passed post-merge verification; worktree removed.",
  "[2026-10-15T19:41:00.000Z] AUTO: builder 24 failed after 2 retries.",
  "[2026-10-15T19:42:00.000Z] AUTO: builder 121 attempt 1 started at 3e9a9046 in /w/121.",
].join("\n");

const checkout = (home, epic, log) => {
  const root = join(home, "epic", epic, "riverbend");
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ startedAt: "2026-10-15T19:02:14.379Z", dag: { epic: { id: epic, title: "Mac daily-use fixes" } }, tasks: {} }));
  writeFileSync(join(root, ".afk", "agent-auto.log"), `${log}\n`);
  return root;
};

test("actuals: launch, baseline, each task's build-to-merge, a failed task as parked, open gates and builds run to now", async () => {
  const { readActuals } = await import("./hub/plan.mjs");
  const m = machine();
  const root = checkout(m.home, "143", LOG_143);
  const { launch, bars } = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.equal(launch, "2026-10-15T19:02:21.816Z");
  const pick = ({ kind, label, start, end, open }) => ({ kind, label, start, end, open });
  assert.deepEqual(bars.map(pick), [
    { kind: "baseline", label: "baseline", start: "2026-10-15T19:02:21.816Z", end: "2026-10-15T19:06:17.522Z", open: false },
    { kind: "gate-human", label: "93", start: "2026-10-15T19:06:17.522Z", end: NOW, open: true },
    { kind: "build", label: "23", start: "2026-10-15T19:06:23.400Z", end: "2026-10-15T19:40:00.000Z", open: false },
    { kind: "parked", label: "24", start: "2026-10-15T19:06:24.000Z", end: "2026-10-15T19:41:00.000Z", open: false },
    { kind: "build", label: "121", start: "2026-10-15T19:42:00.000Z", end: NOW, open: true },
  ]);
});

test("actuals: an accepted gate ends at the acceptance, and the closeout runs from the stop to the close", async () => {
  const { readActuals } = await import("./hub/plan.mjs");
  const m = machine();
  const root = checkout(m.home, "143", [
    "[2026-10-15T19:00:00.000Z] AUTO: continuous scheduler started (maxParallel=6).",
    "[2026-10-15T19:00:00.000Z] AUTO: 93 is a `gate: after` acceptance gate — no lane, no builder. It is now awaiting_acceptance; release it with --accept=93.",
    "[2026-10-15T19:20:00.000Z] AUTO: gate 93 accepted by a human; the epic may now close on it.",
    "[2026-10-15T19:21:00.000Z] AUTO: every task passed and every gate is accepted; the branch has not been reviewed yet — running the closeout verifier.",
    "[2026-10-15T19:50:00.000Z] AUTO: epic closed — complete: every task passed.",
  ].join("\n"));
  const { bars } = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.deepEqual(bars.filter((bar) => bar.kind !== "baseline").map(({ kind, start, end, open }) => ({ kind, start, end, open })), [
    { kind: "gate-human", start: "2026-10-15T19:00:00.000Z", end: "2026-10-15T19:20:00.000Z", open: false },
    { kind: "closeout", start: "2026-10-15T19:21:00.000Z", end: "2026-10-15T19:50:00.000Z", open: false },
  ]);
});

const hubPage = async (m) => {
  const { hubView, renderPage } = await import("./hub/page.mjs");
  return renderPage(await hubView(m.env), { token: "t" });
};

const section = (page) => page.match(/<section class="hub-sec night-plan"[\s\S]*?<\/section>/)?.[0] ?? "";

test("the hub draws Tonight's plan: one row per epic, planned hatched and actual solid, an IST hour axis, a now line, ✋ and captions", async () => {
  const m = machine();
  const root = checkout(m.home, "143", LOG_143);
  const peers = join(m.home, "peers.json");
  writeFileSync(peers, JSON.stringify([{ root, port: 4430, project: "riverbend", epic: { id: "143", title: "Mac daily-use fixes" }, status: "running" }]));
  m.env.AFK_COS_PEERS = peers;
  assert.equal(m.cos("plan", `--file=${writePlan(m, SAMPLE)}`).status, 0);
  const page = await hubPage(m);
  const plan = section(page);
  assert.ok(plan, "the section is drawn");
  assert.match(plan, /<h2>Tonight's plan<\/h2>/);
  // It sits at the top: right under the header, above Needs you.
  const at = page.indexOf('class="hub-sec night-plan"');
  assert.ok(at > page.indexOf("</header>") && at < page.indexOf("<h2>Needs you</h2>"));
  // The axis: 00:00 to 04:00 local (the latest planned end is 03:30), each hour labelled.
  for (const hour of ["00:00", "01:00", "02:00", "03:00", "04:00"]) assert.match(plan, new RegExp(`<span class="gx-hour"[^>]*>${hour}</span>`));
  assert.match(plan, /Local time \(UTC\+05:30\)/);
  // Now is 01:30, so 37.5% across a four-hour axis.
  assert.match(plan, /<span class="gx-now" style="left:37\.5%"[^>]*>/);
  // A row per planned epic, labelled.
  assert.match(plan, /data-field="plan:143"[\s\S]*#143[\s\S]*Mac daily-use fixes/);
  assert.match(plan, /data-field="plan:191"[\s\S]*#191[\s\S]*Website to riverbend\.app/);
  // Planned bars are the hatched class; the gate carries ✋ and its caption sits under it.
  assert.match(plan, /<span class="gx-bar gx-plan k-gate-human"[^>]*>✋ 93<\/span>/);
  assert.match(plan, /<span class="gx-bar gx-plan k-build"[^>]*>23, 24 build\+merge<\/span>/);
  assert.match(plan, /<span class="gx-cap"[^>]*>93 waits for the owner to try the signed build<\/span>/);
  assert.match(plan, /launches after #143&#39;s baseline frees the gate lock/);
  // #143's actual bars are solid, from its log: baseline, ✋ 93 still open, 23 merged, 24 parked.
  assert.match(plan, /<span class="gx-bar gx-actual k-baseline"[^>]*>baseline<\/span>/);
  assert.match(plan, /<span class="gx-bar gx-actual k-gate-human gx-open"[^>]*>✋ 93<\/span>/);
  assert.match(plan, /<span class="gx-bar gx-actual k-build"[^>]*>23<\/span>/);
  assert.match(plan, /<span class="gx-bar gx-actual k-parked"[^>]*>24<\/span>/);
  // #191 has not launched: its row says so instead of drawing actual bars.
  const row191 = plan.match(/data-field="plan:191"[\s\S]*?<\/div><!-- \/row -->/)?.[0] ?? "";
  assert.match(row191, /not launched/);
  assert.doesNotMatch(row191, /gx-actual/);
  const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("./hub/page.css", import.meta.url)), "utf8");
  assert.match(css, /\.gx-plan \{[^}]*repeating-linear-gradient/, "planned bars are hatched");
});

test("the hub draws no plan section when no plan was stored or no run is open", async () => {
  const withRun = machine();
  assert.equal(section(await hubPage(withRun)), "");
  assert.doesNotMatch(await hubPage(withRun), /<h2>Tonight's plan<\/h2>/);
  const closed = machine();
  assert.equal(closed.cos("plan", `--file=${writePlan(closed, SAMPLE)}`).status, 0);
  writeFileSync(join(closed.run.dir, "events.jsonl"), `${JSON.stringify({ ts: NOW, kind: "stop" })}\n`, { flag: "a" });
  const closedPage = await hubPage(closed);
  assert.equal(section(closedPage), "");
  assert.doesNotMatch(closedPage, /<h2>Tonight's plan<\/h2>/);
});

// PR #269 review, must-fix: a bad store line or an unreadable log must not
// take the whole hub page down. Pure functions over temp dirs only.
const COS = (events) => ({ id: "r", meta: { startedAt: RUN_AT }, events });
const planEvent = (fields) => ({ ts: "2026-10-15T18:50:00.000Z", kind: "plan", ...fields });

test("a plan event the schema refuses is skipped: no epics, or a row with no phases, falls back to the last good plan", async () => {
  const { latestPlan, planChart } = await import("./hub/plan.mjs");
  const good = planEvent({ from: "good.json", epics: SAMPLE.epics });
  const noEpics = planEvent({ ts: "2026-10-15T19:00:00.000Z", from: "bad.json" });
  const noPhases = planEvent({ ts: "2026-10-15T19:10:00.000Z", epics: [{ epic: "143", label: "x", launch: "2026-10-16T00:32+05:30" }] });
  assert.deepEqual(latestPlan([good, noEpics, noPhases]).epics.map((row) => row.epic), ["143", "191"]);
  assert.equal(latestPlan([noEpics, noPhases]), null);
  for (const bad of [noEpics, noPhases]) assert.equal(planChart({ cos: COS([bad]), runs: [], now: Date.parse(NOW) }), null);
  assert.equal(planChart({ cos: COS([good, noPhases]), runs: [], now: Date.parse(NOW) }).planTs, good.ts);
});

test("an unreadable agent-auto.log fails soft: no throw, no bars, the reason on the row", async () => {
  const { readActuals, planChart, renderPlan } = await import("./hub/plan.mjs");
  const m = machine();
  const root = join(m.home, "epic", "143", "riverbend");
  mkdirSync(join(root, ".afk", "agent-auto.log"), { recursive: true }); // a directory: readFileSync throws EISDIR
  const actual = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.deepEqual({ launch: actual.launch, bars: actual.bars }, { launch: null, bars: [] });
  assert.match(actual.error, /EISDIR/);
  const runs = [{ id: "p1", root, project: "riverbend", epic: "143" }];
  const html = renderPlan(planChart({ cos: COS([planEvent({ epics: SAMPLE.epics })]), runs, now: Date.parse(NOW) }), "r");
  assert.match(html, /log unreadable \(EISDIR\)/);
});

test("a throw while building or drawing the chart shows one line and the rest of the page renders", async () => {
  const { planChart, renderPlan } = await import("./hub/plan.mjs");
  // runs is not a list: building the chart throws inside.
  const failed = planChart({ cos: COS([planEvent({ epics: SAMPLE.epics })]), runs: null, now: Date.parse(NOW) });
  assert.match(failed.error, /\S/);
  const html = renderPlan(failed, "r");
  assert.match(html, /<h2>Tonight's plan<\/h2>/);
  assert.match(html, /plan unavailable: /);
  // A chart whose rows are not a list throws while drawing.
  assert.match(renderPlan({ planTs: NOW, from: 0, hours: 1, now: 0, rows: null, zone: "UTC+05:30" }, "r"), /plan unavailable: /);
  // The whole page: a bad plan line in the open run's store still draws Needs you.
  const m = machine();
  writeFileSync(join(m.run.dir, "events.jsonl"), `${JSON.stringify(planEvent({ from: "bad.json" }))}\n`, { flag: "a" });
  const page = await hubPage(m);
  assert.match(page, /<h2>Needs you<\/h2>/);
});

// PR #269 review, major: only the Runner's own launch line (scripts/auto.mjs
// prints "dashboard started|ready at …" on every start, before the baseline)
// opens a baseline bar. A run adopted mid-epic has none in the window.
test("a log that opens mid-epic draws no baseline bar, has no launch, and the row says adopted", async () => {
  const { readActuals, planChart, renderPlan } = await import("./hub/plan.mjs");
  const m = machine();
  const root = checkout(m.home, "143", [
    "[2026-10-15T19:06:23.400Z] AUTO: builder 23 attempt 1 started at 3e9a9046 in /w/23.",
    "[2026-10-15T19:40:00.000Z] AUTO: 23 integrated and passed post-merge verification; worktree removed.",
  ].join("\n"));
  const { launch, bars } = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.equal(launch, null);
  assert.deepEqual(bars.map((bar) => bar.kind), ["build"]);
  const runs = [{ id: "p1", root, project: "riverbend", epic: "143" }];
  const html = renderPlan(planChart({ cos: COS([planEvent({ epics: SAMPLE.epics })]), runs, now: Date.parse(NOW) }), "r");
  const row143 = html.match(/data-field="plan:143"[\s\S]*?<\/div><!-- \/row -->/)?.[0] ?? "";
  assert.match(row143, /adopted/);
  assert.doesNotMatch(row143, /launched \d/);
  assert.doesNotMatch(row143, /gx-actual k-baseline/);
});

test("launch is the dashboard line, not an earlier preflight line, and a per-command skip does not close the baseline", async () => {
  const { readActuals } = await import("./hub/plan.mjs");
  const m = machine();
  const root = checkout(m.home, "143", [
    "[2026-10-15T19:01:00.000Z] AUTO: preflight warning: lane 23 touches package.json.",
    "[2026-10-15T19:02:00.000Z] AUTO: dashboard ready at http://localhost:4430 (pid 1).",
    "[2026-10-15T19:03:00.000Z] AUTO: baseline check skipped: cargo test — no Rust-relevant change since the green baseline at abc.",
    "[2026-10-15T19:05:00.000Z] AUTO: continuous scheduler started (maxParallel=6).",
  ].join("\n"));
  const { launch, bars } = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.equal(launch, "2026-10-15T19:02:00.000Z");
  assert.deepEqual(bars.map(({ kind, start, end }) => ({ kind, start, end })), [
    { kind: "baseline", start: "2026-10-15T19:02:00.000Z", end: "2026-10-15T19:05:00.000Z" },
  ]);
});

// #277: a run whose dashboard failed to start prints the warning in place of
// "dashboard started|ready at". That line is its launch; without it the row
// read as adopted mid-epic and drew no baseline bar.
test("a run carrying on without a dashboard is launched at its warning line", async () => {
  const { readActuals } = await import("./hub/plan.mjs");
  const m = machine();
  const root = checkout(m.home, "143", [
    "[2026-10-15T19:02:00.000Z] AUTO: warning: the dashboard did not start; carrying on without it. Dashboard failed to start on http://localhost:4430; see /r/.afk/dashboard.log",
    "[2026-10-15T19:05:00.000Z] AUTO: continuous scheduler started (maxParallel=6).",
  ].join("\n"));
  const { launch, bars } = readActuals({ root, since: Date.parse(RUN_AT), now: Date.parse(NOW) });
  assert.equal(launch, "2026-10-15T19:02:00.000Z");
  assert.deepEqual(bars.map(({ kind, start, end }) => ({ kind, start, end })), [
    { kind: "baseline", start: "2026-10-15T19:02:00.000Z", end: "2026-10-15T19:05:00.000Z" },
  ]);
});

test("the hub artifact draws a planned epic that has no run yet: the snapshot carries it and the Gantt shows planned bars, not launched", async () => {
  const m = machine();
  assert.equal(m.cos("plan", `--file=${writePlan(m, SAMPLE)}`).status, 0);
  const env = {
    ...m.env,
    AFK_TRANSCRIPTS_ROOT: join(m.home, "transcripts"),
    AFK_LANES_CACHE: join(m.home, "cache", "lanes-cache.json"),
    AFK_USAGE_CACHE: join(m.home, "cache", "usage-cache.json"),
  };
  mkdirSync(env.AFK_TRANSCRIPTS_ROOT, { recursive: true });
  const out = join(m.home, "snapshot.json");
  const r = spawnSync(process.execPath, [afk, "hub", "snapshot", "--out", out], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(doc.runs, []);
  assert.deepEqual(doc.unlaunched.map((row) => [row.epic, row.planned.length]), [["143", 3], ["191", 1]]);
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const html = drawSnapshot(doc, { now: Date.parse(NOW) });
  assert.match(html, /#143<\/b><small>Mac daily-use fixes · not launched<\/small>/);
  assert.match(html, /#191<\/b><small>Website to riverbend\.app · not launched<\/small>/);
  assert.equal((html.match(/class="gx-bar /g) ?? []).length, 4, "one bar per planned phase");
  assert.doesNotMatch(html, /No timeline in this snapshot/);
});
