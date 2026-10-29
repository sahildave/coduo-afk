// scripts/dashboard-herdr-log.test.mjs — the ticket panel on a herdr run.
//
// A `direct` lane streams JSONL into its attempt directory and the panel reads
// it. A herdr lane draws into a terminal pane and writes nothing there until it
// ends, so for the whole life of every herdr run the panel answered
// `no stream log yet · (waiting for output)` — the buttons were real, the log
// behind them never was. Two channels replace it: the pane while the attempt is
// the live one, and the scrollback captured into `agent-output.log` afterwards.
//
// Nothing here talks to a model or to a real herdr: `herdr` is a shell script on
// PATH that prints a known pane.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dashboardHealth } from "./dashboard-process.mjs";
import { phaseLogPath, recordPhase } from "./runtime-herdr.mjs";
import { freePort } from "./free-port.mjs";

const SERVER_READY_MS = 60_000;
const waitForServer = async (port) => {
  const deadline = Date.now() + SERVER_READY_MS;
  while (Date.now() < deadline) {
    if (await dashboardHealth(port)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`the dashboard never came up on ${port} within ${SERVER_READY_MS}ms`);
};

const getJson = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
};

const PANE_TEXT = "⏺ writing the filter row\n❯";
// The lane's OWN pane, which by now hosts whatever ran there next. Answering
// with it for a finished attempt is the failure the liveness guard exists for.
const LANE_PANE_TEXT = "⏺ some other agent entirely";

/** A `herdr` on PATH that answers `pane read`, and nothing else. */
const fakeHerdr = (dir) => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "herdr");
  writeFileSync(
    path,
    `#!/bin/sh\n`
      + `[ "$1" = "pane" ] && [ "$2" = "read" ] || exit 1\n`
      + `case "$3" in\n`
      + `  w1HD:p1) printf '%s\\n' ${JSON.stringify(PANE_TEXT)} ;;\n`
      + `  w1HZ:p1) printf '%s\\n' ${JSON.stringify(LANE_PANE_TEXT)} ;;\n`
      + `  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(path, 0o755);
  return bin;
};

const serve = async (t, root, extraEnv = {}) => {
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))],
    {
      cwd: root,
      env: { ...process.env, PORT: String(port), AFK_NO_HUB: "1", ...extraEnv },
      stdio: "ignore",
    },
  );
  t.after(() => server.kill("SIGTERM"));
  await waitForServer(port);
  return port;
};

test("a herdr lane's log is its pane while it runs, and its capture after", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-herdr-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attempt = (name) => {
    const dir = join(root, ".afk", "runs", "661", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  // Attempt 1 ended: only the scrollback captured when it finished.
  writeFileSync(join(attempt("builder-1"), "agent-output.log"), "all gates green\n");
  // Attempt 2 is the integrator, live in the parent pane. No file at all.
  attempt("integration-1");
  writeFileSync(
    join(root, ".afk", "herdr.json"),
    JSON.stringify({
      parentWorkspaceId: "w1HD",
      parentPaneId: "w1HD:p1",
      tasks: { 661: { paneId: "w1HZ:p1" } },
    }),
  );
  writeFileSync(
    join(root, ".afk", "state.json"),
    JSON.stringify({
      // This process is alive by definition, so the run reads as live — the
      // pane belongs to a dead run otherwise and must not be quoted.
      orchestratorPid: process.pid,
      activeWorkers: {},
      activeIntegrator: { taskId: "661", attempt: 1, pid: process.pid },
      tasks: {},
    }),
  );

  const port = await serve(t, root, { PATH: `${fakeHerdr(root)}:${process.env.PATH}` });

  const live = await getJson(port, "/task-log?id=661");
  assert.equal(live.status, 200);
  assert.deepEqual(live.body.attempts, ["builder-1", "integration-1"]);
  assert.equal(live.body.attempt, "integration-1");
  assert.match(live.body.timeline, /writing the filter row/, "the live pane is the log");
  assert.match(live.body.summary, /herdr pane w1HD:p1/);
  assert.doesNotMatch(live.body.summary, /no stream log yet/);

  const ended = await getJson(port, "/task-log?id=661&attempt=builder-1");
  assert.equal(ended.status, 200);
  // Not the integrator's pane: this attempt is not the live one, so the only
  // honest answer is what it left behind.
  assert.match(ended.body.timeline, /all gates green/);
  assert.match(ended.body.summary, /pane is gone/);
  assert.doesNotMatch(ended.body.timeline, /some other agent/);
});

test("the phase walk an attempt reported is served with its log", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-herdr-phases-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".afk", "runs", "662", "builder-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-output.log"), "done\n");
  writeFileSync(
    join(dir, "phases.jsonl"),
    [
      { at: "2026-09-18T22:07:00.000Z", status: "working", phase: "Resolve", step: 1, total: 7 },
      { at: "2026-09-18T22:19:00.000Z", status: "working", phase: "Implement", step: 4, total: 7 },
      "not json at all",
      { at: "2026-09-18T22:41:00.000Z", status: "done" },
    ]
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n") + "\n",
  );
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ tasks: {} }));

  const port = await serve(t, root);
  const log = await getJson(port, "/task-log?id=662");
  assert.equal(log.status, 200);
  assert.deepEqual(
    log.body.phases.map((p) => p.phase ?? p.status),
    ["Resolve", "Implement", "done"],
    "every phase, in order, and a corrupt line drops rather than blanking the walk",
  );
  assert.equal(log.body.phases[0].step, 1);
  assert.equal(log.body.phases[0].at, "2026-09-18T22:07:00.000Z");

  // An attempt that reported nothing has no walk — not a fabricated first phase.
  const bare = join(root, ".afk", "runs", "663", "builder-1");
  mkdirSync(bare, { recursive: true });
  const none = await getJson(port, "/task-log?id=663");
  assert.deepEqual(none.body.phases, []);
});

test("a phase is recorded once, when it changes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-record-phase-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = () =>
    readFileSync(phaseLogPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  let last = null;
  // `.afk-report.json` is rewritten on every poll, not only on a transition:
  // recording each read would put one line per 5s tick in the walk.
  last = recordPhase(dir, { status: "working", phase: "Resolve", step: 1, total: 7, updatedAt: "2026-09-18T22:07:00.000Z" }, last);
  last = recordPhase(dir, { status: "working", phase: "Resolve", step: 1, total: 7, updatedAt: "2026-09-18T22:08:00.000Z" }, last);
  last = recordPhase(dir, { status: "working", phase: "Test", step: 5, total: 7, updatedAt: "2026-09-18T22:41:00.000Z" }, last);
  // A lane with no report yet writes nothing at all.
  last = recordPhase(dir, null, last);
  last = recordPhase(dir, { status: "done", updatedAt: "2026-09-18T22:59:00.000Z" }, last);

  assert.deepEqual(
    lines().map((entry) => [entry.status, entry.phase, entry.at]),
    [
      ["working", "Resolve", "2026-09-18T22:07:00.000Z"],
      ["working", "Test", "2026-09-18T22:41:00.000Z"],
      ["done", null, "2026-09-18T22:59:00.000Z"],
    ],
  );
  // The agent's own timestamp, not the poll's: a phase is dated when it was
  // entered, not when the runner next looked.
  assert.equal(lines()[1].step, 5);
});
