// scripts/lanes.test.mjs — lane efficiency rows, report and the code-map comparison.
// Fixtures only: every test points the readers at a temp transcripts root.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./free-port.mjs";
import { isolateEnv } from "./test-helpers.mjs";

const scratch = mkdtempSync(join(tmpdir(), "afk-lanes-"));
process.env.AFK_LANES_CACHE = join(scratch, "cache.json");
const { CACHE_VERSION, codemapWindow, collectLanes, compareLanes, laneOf, lanesReport, median } = await import("./lanes.mjs");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const GP = "-Users-x--afk-claude-epics-Users-x-code-projects-atlas-workspace-841-atlas-workspace";
const OTHER = "-Users-x--afk-claude-epics-Users-x-code-projects-quillnote-9-quillnote";
const cwdOf = (project, epic) => `/Users/x/.afk-claude/epics/Users-x-code-projects-${project}-${epic}/${project}`;

let msg = 0;
const assistant = (context, calls = [], { model = "claude-opus-5-5", output = 100, at = "2026-10-06T10:00:00Z" } = {}) => JSON.stringify({
  type: "assistant", timestamp: at,
  message: { id: `m${++msg}`, model, content: calls.map(([name, input]) => ({ type: "tool_use", id: `t${msg}${name}`, name, input })), usage: { input_tokens: 10, cache_read_input_tokens: context - 10, cache_creation_input_tokens: 0, output_tokens: output } },
});
const user = (text, cwd, at = "2026-10-06T09:59:00Z") => JSON.stringify({ type: "user", cwd, timestamp: at, message: { content: text } });
// A large tool result: skipped before parsing, so it must not change any number.
const toolResult = () => JSON.stringify({ type: "user", timestamp: "2026-10-06T10:00:30Z", message: { content: [{ type: "tool_result", content: "x".repeat(5000) }] } });

const BUILDER = (task, attempt = 1) => `Read the file /Users/x/.afk-claude/epics/Users-x-code-projects-atlas-workspace-841/atlas-workspace/.afk/runs/${task}/builder-${attempt}/prompt.md and execute`;

// A builder lane: explore twice (Read, then a grep), graphify once, then edit.
const builderLane = (task, { readMap = false, grow = 30_000 } = {}) => [
  user(BUILDER(task), cwdOf("atlas-workspace", 841)),
  assistant(20_000, [["Read", { file_path: readMap ? "docs/CODE-MAP.md" : "src/a.ts" }]]),
  toolResult(),
  assistant(20_000 + grow / 2, [["Bash", { command: "grep -rn foo src" }]]),
  assistant(20_000 + grow, [["Bash", { command: "graphify explain \"Foo()\"" }]]),
  assistant(20_000 + grow + 5_000, [["Edit", { file_path: "src/a.ts" }]]),
  assistant(90_000, [["Bash", { command: "npm test" }]], { at: "2026-10-06T10:30:00Z" }),
].join("\n");

const write = (root, folder, name, body, mtime) => {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, `${name}.jsonl`);
  writeFileSync(path, body);
  if (mtime) utimesSync(path, new Date(mtime), new Date(mtime));
  return path;
};
const root = () => mkdtempSync(join(scratch, "root-"));

test("laneOf: context and calls before the first edit, peak context, model, role, place", () => {
  const r = root();
  const row = laneOf(write(r, GP, "a", builderLane(7)));
  assert.equal(row.project, "atlas-workspace");
  assert.equal(row.epicId, "841");
  assert.deepEqual([row.role, row.taskId, row.attempt], ["builder", "7", 1]);
  assert.equal(row.model, "claude-opus-5-5");
  assert.equal(row.edited, true);
  assert.equal(row.readCodeMap, false);
  assert.equal(row.beforeFirstEdit.contextGrowth, 30_000);
  assert.deepEqual([row.beforeFirstEdit.toolCalls, row.beforeFirstEdit.explore, row.beforeFirstEdit.graphify, row.beforeFirstEdit.other], [3, 2, 1, 0]);
  assert.equal(row.turns, 5);
  assert.equal(row.toolCalls, 5);
  assert.deepEqual(row.tools, { Read: 1, Bash: 3, Edit: 1 });
  assert.equal(row.peakContext, 90_000);
  assert.equal(row.lastTool, "Bash");
  assert.equal(row.firstAt, "2026-10-06T09:59:00Z");
  assert.equal(row.lastAt, "2026-10-06T10:30:00.000Z");
  assert.ok(row.costUsd > 0);
});

test("laneOf re-reads a transcript only when its size or mtime moves, and persists rows", () => {
  const r = root();
  const path = write(r, GP, "a", builderLane(7));
  assert.equal(laneOf(path).turns, 5);
  appendFileSync(path, "\n" + assistant(120_000, [["Bash", { command: "ls" }]]));
  const row = laneOf(path);
  assert.equal(row.turns, 6);
  assert.equal(row.peakContext, 120_000);
  collectLanes({ root: r });
  assert.ok(existsSync(process.env.AFK_LANES_CACHE), "rows are written to the disk cache");
});

// The dashboard's warm-up worker, its /lanes workers and the hub each hold their
// own cache and write one file. Written in place, a reader could parse half of
// one, and loadCache then started empty without a word.
test("two processes writing one lanes cache at once never leave a reader a partial file", async (t) => {
  const cachePath = join(scratch, "shared-cache.json");
  writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, rows: {} }));
  // Distinct tool names make each row big, so the file passes 1 MB and one
  // write takes long enough for a reader to land inside it.
  const wideLane = (task, k) => [
    user(BUILDER(task), cwdOf("atlas-workspace", 841)),
    assistant(20_000, Array.from({ length: 4_000 }, (_, i) => [`tool_${k}_${task}_${i}_${"w".repeat(40)}`, {}])),
  ].join("\n");
  const ROUNDS = 20;
  const writer = (k) => {
    const r = root();
    for (let task = 1; task <= 5; task += 1) write(r, GP, `w${task}`, wideLane(task, k));
    const lanes = JSON.stringify(new URL("./lanes.mjs", import.meta.url).href);
    // Each round appends to a transcript, so the row moves and saveCache writes.
    const code = `import { appendFileSync } from "node:fs";
      const m = await import(${lanes});
      for (let i = 0; i < ${ROUNDS}; i += 1) {
        appendFileSync(${JSON.stringify(join(r, GP, "w1.jsonl"))}, "\\n" + JSON.stringify({ type: "assistant", message: { id: "x" + i, model: "claude-opus-5-5", content: [], usage: { input_tokens: i + 1 } } }));
        m.lanesReport({ root: ${JSON.stringify(r)}, days: 3650 });
      }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, AFK_LANES_CACHE: cachePath }, stdio: ["ignore", "ignore", "inherit"] });
    t.after(() => child.kill("SIGKILL"));
    return new Promise((done) => child.on("exit", (code) => done(code)));
  };
  let running = 2;
  const exits = [writer("a"), writer("b")].map((p) => p.then((code) => { running -= 1; return code; }));
  let reads = 0, largest = 0;
  const bad = [];
  while (running > 0) {
    const text = readFileSync(cachePath, "utf8");
    reads += 1;
    largest = Math.max(largest, text.length);
    try {
      const disk = JSON.parse(text);
      if (disk.version !== CACHE_VERSION) bad.push(`version ${disk.version}`);
    } catch (error) {
      bad.push(`${text.length} bytes: ${error.message}`);
    }
    await new Promise((done) => setImmediate(done));
  }
  assert.deepEqual(await Promise.all(exits), [0, 0], "both writers finished");
  assert.ok(largest > 1_000_000, `fixture precondition: the cache passes 1 MB (largest read ${largest} bytes)`);
  assert.ok(statSync(cachePath).size > 1_000_000);
  assert.deepEqual(bad, [], `${bad.length} of ${reads} reads did not parse as a version ${CACHE_VERSION} cache`);
});

test("median is the upper middle, as codemap-lanes.mjs takes it", () => {
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([5]), 5);
  assert.equal(median([]), null);
});

test("lanesReport: drops preflight pings, filters by project and window, medians over editing lanes", () => {
  const r = root();
  const now = Date.parse("2026-10-09T12:00:00Z");
  write(r, GP, "a", builderLane(1, { grow: 10_000 }), now - 3_600_000);
  write(r, GP, "b", builderLane(2, { grow: 30_000 }), now - 3_600_000);
  write(r, GP, "c", builderLane(3, { grow: 50_000, readMap: true }), now - 2 * 86_400_000);
  write(r, GP, "old", builderLane(4, { grow: 99_000 }), now - 40 * 86_400_000);
  write(r, GP, "ping", [user("Reply with the single word: OK", cwdOf("atlas-workspace", 841)), assistant(5_000)].join("\n"), now - 60_000);
  write(r, OTHER, "v", [user("You are the verifier for one task", cwdOf("quillnote", 9)), assistant(8_000, [["Read", { file_path: "x" }]])].join("\n"), now - 60_000);

  const rep = lanesReport({ root: r, now, days: 30 });
  assert.equal(rep.headline.lanes, 4, "preflight and the 40-day-old lane are out");
  assert.equal(rep.headline.edited, 3);
  assert.equal(rep.headline.contextBeforeEdit, 30_000);
  assert.equal(rep.headline.exploreBeforeEdit, 2);
  assert.equal(rep.headline.readCodeMapShare, 1 / 4);
  assert.deepEqual(rep.projects, ["atlas-workspace", "quillnote"]);
  assert.deepEqual(rep.byRole.map((g) => [g.key, g.lanes]), [["builder", 3], ["verifier", 1]]);
  assert.deepEqual(rep.trend.map((d) => [d.key, d.edited]), [["2026-10-07", 1], ["2026-10-09", 2]]);
  assert.equal(rep.lanes[0].peakContext, 90_000, "most context first");
  assert.equal(rep.live.length, 1, "only the verifier was written in the last 5 minutes");
  assert.equal(rep.lanes[0].file, undefined, "no paths in the payload");

  const mac = lanesReport({ root: r, now, days: 30, project: "quillnote" });
  assert.equal(mac.headline.lanes, 1);
  assert.equal(mac.headline.edited, 0);
  assert.equal(mac.headline.contextBeforeEdit, null);
});

test("codemapWindow keeps the routine's rules: atlas-workspace folders, mtime window with `to` inclusive, editing lanes", () => {
  const r = root();
  write(r, GP, "base1", builderLane(1, { grow: 20_000 }), "2026-09-10T12:00:00Z");
  write(r, GP, "base2", builderLane(2, { grow: 40_000, readMap: true }), "2026-10-03T23:00:00Z");
  write(r, GP, "gap", builderLane(3), "2026-10-04T12:00:00Z");
  write(r, GP, "after", builderLane(4, { grow: 60_000 }), "2026-10-06T12:00:00Z");
  write(r, `${GP.replace(/-atlas-workspace$/, "")}-atlas-workspace-2`, "after2", builderLane(5, { grow: 70_000 }), "2026-10-07T12:00:00Z");
  write(r, OTHER, "elsewhere", builderLane(6), "2026-10-06T12:00:00Z");
  write(r, GP, "noedit", [user(BUILDER(7), cwdOf("atlas-workspace", 841)), assistant(9_000, [["Read", { file_path: "a" }]])].join("\n"), "2026-10-06T12:00:00Z");

  const base = codemapWindow({ root: r, from: "2026-08-25", to: "2026-10-03" });
  assert.equal(base.lanes, 2);
  assert.deepEqual([base.noMap.lanes, base.noMap.contextBeforeEdit], [1, 20_000]);
  assert.deepEqual([base.readMap.lanes, base.readMap.contextBeforeEdit], [1, 40_000]);

  const { after } = compareLanes({ root: r, since: "2026-10-05" });
  assert.equal(after.noMap.lanes, 2, "the -2 checkout counts; quillnote and the no-edit lane do not");
  assert.equal(after.noMap.contextBeforeEdit, 70_000);
  assert.equal(after.noMap.exploreBeforeEdit, 2);
  assert.equal(after.readMap.lanes, 0);
});

test("the dashboard serves /lanes, /lanes/compare and /lanes.html", async (t) => {
  const r = root();
  write(r, GP, "a", builderLane(1));
  isolateEnv(t, r, { AFK_TRANSCRIPTS_ROOT: r, AFK_NO_HUB: "1" });
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/dashboard-server.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => child.kill());
  await new Promise((done) => child.stdout.on("data", (d) => String(d).includes("Dashboard:") && done()));
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  const lanes = await (await get("/lanes?days=3650")).json();
  assert.equal(lanes.headline.lanes, 1);
  assert.equal(lanes.window.days, 365, "days is capped");
  const cmp = await (await get("/lanes/compare?since=2000-01-01&from=bad")).json();
  assert.equal(cmp.after.lanes, 1);
  assert.equal(cmp.baseline.from, "2026-08-25", "an invalid date falls back to the default");
  assert.match(await (await get("/lanes.html")).text(), /<title>AFK lanes<\/title>/);
});

test("collectLanes finds AFK sessions by their opening, in any folder, and skips interactive ones", () => {
  const r = root();
  const now = Date.parse("2026-10-09T12:00:00Z");
  // A plan-reviewer run from the project's main checkout, with a large attachment before its first user line.
  const attachment = JSON.stringify({ type: "attachment", attachment: { content: "y".repeat(200_000) } });
  write(r, "-Users-x-code-projects-riverbend", "pr", [attachment, user("You are the plan-reviewer for an automated parallel task runner.", "/Users/x/code/projects/riverbend"), assistant(9_000)].join("\n"), now - 3_600_000);
  // A merger in a temp folder; its prompt names the epic worktree.
  const merger = "You are a fresh merger agent integrating exactly ONE completed task into main.\n\nTask ID: 72\nTask worktree verification:\n{\"cwd\":\"/Users/x/.afk-claude/worktrees/Users-x-afk-claude-epics-Users-x-code-projects-harbour-486-harbour/72/harbour\"}";
  write(r, "-private-var-folders-ab-T-afk-merge-Xy12", "m", [user(merger, "/private/var/folders/ab/T/afk-merge-Xy12"), assistant(7_000, [["Edit", { file_path: "a" }]])].join("\n"), now - 3_600_000);
  // A worktree folder that does not carry "afk-claude-epics" in its name.
  write(r, "-Users-x--afk-claude-worktrees-Users-x-code-projects-riverbend-72-riverbend-role-cwd-supervise-72", "s", [user("You are the supervisor of one running AFK epic.", "/Users/x/.afk-claude/worktrees/Users-x-code-projects-riverbend-72-riverbend/role-cwd-supervise-72"), assistant(5_000)].join("\n"), now - 3_600_000);
  // The owner's own session in the same main checkout folder: not a lane.
  write(r, "-Users-x-code-projects-riverbend", "me", [user("I want to explore making the pills movable", "/Users/x/code/projects/riverbend"), assistant(5_000)].join("\n"), now - 3_600_000);
  write(r, "-private-var-folders-ab-T-afk-merge-Xy12", "ping", [user("Reply with the single word: OK", "/private/var/folders/ab/T/afk-merge-Xy12"), assistant(1_000)].join("\n"), now - 3_600_000);

  const rep = lanesReport({ root: r, now, days: 30 });
  assert.deepEqual(rep.lanes.map((l) => [l.role, l.project, l.epicId, l.taskId]).sort(), [
    ["integration", "harbour", "486", "72"],
    ["plan-review", "riverbend", "unknown", null],
    ["supervisor", "riverbend", "72", null],
  ]);
});
