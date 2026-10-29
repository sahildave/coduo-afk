// scripts/dashboard-port.test.mjs — the dashboard port, and the ordering of
// `afk epic`'s cheapest preflight.
//
// Six concurrent epic runs from six checkouts of one project, on one machine,
// on one night: four of them died on a fixed `PORT=4041` already held by a
// sibling checkout, each diagnosed cold. The cost was not the refusal — the
// refusal was correct — it was that the check ran LAST, after a paid plan
// review, the feature branch and `.afk/state.json`, and reported itself only in
// a background log. Both halves are pinned here.
//
// Nothing here talks to a model. `gh` and `claude` are shell scripts on PATH,
// and the "other project's dashboard" is a four-line `/health` server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUB_PORT,
  dashboardHealth,
  derivedDashboardPort,
  discoverDashboards,
  probeDashboardPort,
  resolveDashboardPort,
  startDashboard,
} from "./dashboard-process.mjs";
import { isolateEnv, writeConfig } from "./test-helpers.mjs";
import { freePort } from "./free-port.mjs";

// One port for this file's spawned children, taken from the OS at load.
// The call sites are synchronous `spawnSync` helpers, so the await is hoisted.
const SPAWNED_CHILD_PORT = String(await freePort());

// ---------------------------------------------------------------------------
// Fix 1 — the port is derived, and a taken port is stepped over
// ---------------------------------------------------------------------------

test("the default port is derived from the checkout, not fixed", () => {
  const a = "/Users/someone/code/voice-studio-epic1";
  const b = "/Users/someone/code/voice-studio-epic2";
  // Same checkout, same port on every run: a bookmarked dashboard URL keeps
  // working, which is the whole reason this is a hash and not a scan from zero.
  assert.equal(derivedDashboardPort(a), derivedDashboardPort(a));
  // Two checkouts of one project were the actual failure. They must differ
  // before any scanning happens at all.
  assert.notEqual(derivedDashboardPort(a), derivedDashboardPort(b));
  for (const root of [a, b]) {
    assert.ok(derivedDashboardPort(root) >= 4100);
    assert.ok(derivedDashboardPort(root) < 4500);
  }
  // Relative and absolute spellings of one checkout are one port.
  assert.equal(derivedDashboardPort("."), derivedDashboardPort(resolve(".")));
});

test("an explicit PORT still wins, unchanged", () => {
  const root = "/tmp/whatever";
  assert.deepEqual(resolveDashboardPort({ root, env: { PORT: "4999" } }), {
    port: 4999,
    explicit: true,
  });
  // No caller passes a port it did not choose any more — `scripts/auto.mjs`
  // used to pass `Number(process.env.PORT || 4041)`, and the sentinel that
  // caught that historical default is gone with it. Absent both, derive.
  assert.deepEqual(resolveDashboardPort({ root, env: {} }), {
    port: derivedDashboardPort(root),
    explicit: false,
  });
  assert.deepEqual(resolveDashboardPort({ root, port: 4444, env: {} }), {
    port: 4444,
    explicit: true,
  });
});

test("the scan steps over ports held by other projects", async () => {
  const held = { 4200: "/other/one", 4201: "/other/two" };
  const probe = async (port) =>
    held[port] ? { ok: true, pid: port, root: held[port], port } : null;
  const found = await probeDashboardPort({ root: "/mine", port: 4200, probe });
  assert.deepEqual(found, { port: 4202, existing: null });
});

test("a dashboard already serving this checkout is reused, not skipped", async () => {
  const probe = async (port) => ({ ok: true, pid: 7, root: "/mine", port });
  const found = await probeDashboardPort({ root: "/mine", port: 4200, probe });
  assert.equal(found.port, 4200);
  assert.equal(found.existing.pid, 7);
});

test("an exhausted window names the remedy in the error, not in a log", async () => {
  const probe = async (port) => ({ ok: true, pid: port, root: "/other", port });
  await assert.rejects(
    probeDashboardPort({ root: "/mine", port: 4200, attempts: 5, probe }),
    (error) => {
      assert.match(error.message, /4200-4204/);
      assert.match(error.message, /PORT=<n>/);
      assert.match(error.message, /runbook/);
      return true;
    },
  );
});

test("startDashboard binds the derived port and reuses it on a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-dash-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync("git", ["init", "-b", "main", dir]);
  const logPath = join(dir, "dashboard.log");
  // No PORT: this is the path a plain `afk epic` takes, and the port must fall
  // out of the checkout rather than out of a constant.
  isolateEnv(t, dir, { PORT: undefined });

  const first = await startDashboard({ root: dir, logPath });
  t.after(() => first.stop());
  assert.equal(first.port, derivedDashboardPort(dir));
  assert.equal(first.reused, false);

  const second = await startDashboard({ root: dir, logPath, previousPid: first.pid });
  assert.equal(second.port, first.port, "a restart lands on the same port");
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
});

// ---------------------------------------------------------------------------
// Fix 2 — the cheap preflight runs before anything is created or paid for
// ---------------------------------------------------------------------------

const EPIC_NUMBER = 400;
const BRANCH = "feat/400-preflight";

const EPIC_BODY = [
  "```yaml",
  "afk:",
  "  version: 1",
  `  branch: ${BRANCH}`,
  "  tasks:",
  "    401:",
  "      depends_on: []",
  "```",
].join("\n");

const GH_PAYLOAD = JSON.stringify({
  data: {
    repository: {
      issue: {
        number: EPIC_NUMBER,
        title: "Preflight",
        state: "OPEN",
        body: EPIC_BODY,
        subIssues: {
          totalCount: 1,
          nodes: [
            {
              number: 401,
              title: "Only task",
              state: "OPEN",
              body: "## Acceptance criteria\n\n- `file-401.txt` exists.\n",
            },
          ],
        },
      },
    },
  },
});

// The point of the fixture: `claude` records every invocation. A preflight that
// runs in the right order leaves this file absent — no plan review was paid for.
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-preflight-"));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  const claudeLog = join(dir, "claude.log");
  const payload = join(dir, "epic.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(payload, GH_PAYLOAD);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      `  "api graphql") cat ${JSON.stringify(payload)} ;;`,
      '  "repo view") echo "owner/preflight" ;;',
      '  "pr list") echo "[]" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "claude"),
    ["#!/bin/sh", `printf 'called\\n' >> ${JSON.stringify(claudeLog)}`, "exit 1"].join("\n"),
    { mode: 0o755 },
  );

  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "AGENTS.md"), "# rules\n");
  writeConfig(repo, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [],
    agent: { command: "claude", timeoutMs: 30_000, runtime: "direct" },
  });
  git("add", ".");
  git("commit", "-m", "base");
  return { dir, repo, bin, claudeLog, git };
};

const runEpic = (fx, env = {}) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./epic.mjs", import.meta.url)),
      "epic",
      String(EPIC_NUMBER),
      "--repo=owner/preflight",
      "--runtime=direct",
    ],
    {
      cwd: fx.repo,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${fx.bin}:${process.env.PATH}`,
        PORT: SPAWNED_CHILD_PORT,
        ...env,
      },
    },
  );

const nothingWasCreated = (fx) => {
  assert.doesNotMatch(fx.git("branch", "--list").stdout, /feat\/400-preflight/);
  try {
    readFileSync(join(fx.repo, ".afk", "state.json"), "utf8");
    assert.fail(".afk/state.json was written by a run that never started");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
};

test("a dirty tree is refused before the plan review and before the branch", (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  // The exact shape that bit epic 2: one uncommitted line in the runner's own
  // config, edited immediately before the run, which is the expected workflow.
  writeFileSync(
    join(fx.repo, ".afk-setup", "config.yaml"),
    `${readFileSync(join(fx.repo, ".afk-setup", "config.yaml"), "utf8")}\n# tweak\n`,
  );

  const result = runEpic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(result.stderr, /\.afk-setup\/config\.yaml/);
  assert.match(result.stderr, /commit the .*config\.yaml change first/);
  // The reason a human needs, and the one epic 1 had to work out: a lane never
  // sees the edit at all, because its worktree is cut from the committed branch.
  assert.match(result.stderr, /never reaches the lanes/);
  // The old wording, which called a deliberate config edit unrelated work.
  assert.doesNotMatch(result.stderr, /Commit or stash unrelated work/);
  nothingWasCreated(fx);
  // The ordering claim, and the only assertion that costs money when it fails.
  assert.throws(() => readFileSync(fx.claudeLog, "utf8"), { code: "ENOENT" });
});

test("a port held by another project is refused before the plan review", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  // Stand in for a sibling checkout's dashboard: the same `/health` shape the
  // runner serves, answering for a different root. It has to be a separate
  // PROCESS — the `spawnSync` below blocks this one's event loop, so an
  // in-process server would never accept the probe's connection and the test
  // would pass for the wrong reason.
  // The SAME port `runEpic` hands its child, because the point of the test is
  // that the child finds this one occupied. The two used to agree by both
  // spelling out `46000 + (process.pid % 1000)`; they now share the constant,
  // so the coupling is visible instead of being two copies of a formula.
  const port = Number(SPAWNED_CHILD_PORT);
  const other = spawn(
    process.execPath,
    [
      "-e",
      `require('node:http').createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, pid: 4242, root: '/some/other/checkout', port: ${port} })); }).listen(${port}, '127.0.0.1');`,
    ],
    { stdio: "ignore" },
  );
  t.after(() => other.kill("SIGTERM"));
  for (let tries = 0; tries < 40 && !(await dashboardHealth(port)); tries += 1)
    await new Promise((done) => setTimeout(done, 50));
  assert.ok(await dashboardHealth(port), "the stand-in dashboard never came up");

  const result = runEpic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  // Named on STDOUT/STDERR with its remedy, not buried in `.afk/agent-auto.log`.
  assert.match(result.stderr, /already serving a different project/);
  assert.match(result.stderr, /\/some\/other\/checkout/);
  assert.match(result.stderr, /PORT=<n>/);
  assert.match(result.stderr, /Nothing was created/);
  nothingWasCreated(fx);
  assert.throws(() => readFileSync(fx.claudeLog, "utf8"), { code: "ENOENT" });
});


// ---------------------------------------------------------------------------
// The run's non-lane agents — verifier, supervisor, fixer, reflector — are
// reachable from the page. Each writes `.afk/<dir>/<id>/stream.jsonl`, and the
// scan is structural so a role added later needs no edit here. The id comes
// from the client, so the traversal guard is pinned beside the happy path.
// ---------------------------------------------------------------------------

// Node startup plus a listen is 6-10s on an idle machine and worse under the
// full suite, so readiness is waited out generously and its failure is stated.
// A 3s budget here failed roughly one full-suite run in two, and the failure
// read as a broken endpoint rather than a tight clock.
const SERVER_READY_MS = 60_000;

const waitForServer = async (port) => {
  const deadline = Date.now() + SERVER_READY_MS;
  while (Date.now() < deadline) {
    const health = await dashboardHealth(port);
    if (health) return health;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`the dashboard never came up on ${port} within ${SERVER_READY_MS}ms`);
};

const getJson = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
};

test("the dashboard lists a run's non-lane agents and serves their logs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-dashboard-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stream = (...segments) => {
    mkdirSync(join(root, ".afk", ...segments), { recursive: true });
    writeFileSync(
      join(root, ".afk", ...segments, "stream.jsonl"),
      `${JSON.stringify({ type: "result", subtype: "success", result: "verdict" })}\n`,
    );
  };
  stream("verifier", "56");
  // The plan reviewer numbers its stream by attempt. Matching only the plain
  // name made every plan review invisible to the page.
  mkdirSync(join(root, ".afk", "plan-review", "56"), { recursive: true });
  writeFileSync(join(root, ".afk", "plan-review", "56", "stream-1.jsonl"), "{}\n");
  // A role this file has never heard of. The whole point of scanning by shape:
  // it is listed anyway.
  stream("role-invented-tomorrow", "56");
  // A lane's own stream lives one level deeper and belongs to its ticket; an
  // archived run is a previous epic. Neither is an agent of THIS run.
  stream("runs", "57", "builder-1");
  stream("archive", "epic-55", "verifier");
  // A supervisor call decided deterministically never spawns an agent: it
  // writes `decision.json` and no stream. Scanning for streams alone hid every
  // one of them, along with the epic-close agent's prose — the rulings an
  // operator most wants to read were the ones with no chip.
  mkdirSync(join(root, ".afk", "supervisor", "58-ab12"), { recursive: true });
  writeFileSync(
    join(root, ".afk", "supervisor", "58-ab12", "decision.json"),
    JSON.stringify({ recommendation: "wake-human", reasoning: "a gate is the human's" }),
  );
  // Its prompt is input, not output, and is the biggest file in the directory.
  writeFileSync(join(root, ".afk", "supervisor", "58-ab12", "prompt.md"), "x".repeat(2000));
  // Still nothing here: an empty directory is not an agent.
  mkdirSync(join(root, ".afk", "supervisor", "59-empty"), { recursive: true });

  isolateEnv(t, root);
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))],
    { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" },
  );
  t.after(() => server.kill("SIGTERM"));
  await waitForServer(port);

  const listed = await getJson(port, "/agents");
  assert.deepEqual(
    listed.body.map((entry) => entry.key).sort(),
    ["plan-review/56", "role-invented-tomorrow/56", "supervisor/58-ab12", "verifier/56"],
    "every agent's leavings, streamed or not — an empty directory is still not one",
  );
  assert.equal(listed.body.find((entry) => entry.role === "verifier").id, "56");

  const log = await getJson(port, "/agent-log?id=verifier%2F56");
  assert.equal(log.status, 200);
  // The stream carries a result line, so the agent answered — `recent` is a
  // claim about the file's mtime and this is the one about the agent.
  assert.equal(log.body.finished, true);
  assert.match(log.body.summary, /verifier\/56/);

  // The streamless one serves its artifacts, and not its prompt.
  const decision = await getJson(port, "/agent-log?id=supervisor%2F58-ab12");
  assert.equal(decision.status, 200);
  assert.match(decision.body.timeline, /decision\.json/);
  assert.match(decision.body.timeline, /wake-human/);
  assert.doesNotMatch(decision.body.timeline, /prompt\.md/);
  const empty = await getJson(port, "/agent-log?id=supervisor%2F59-empty");
  assert.equal(empty.status, 404);

  // The id is client input. None of these may 200.
  for (const bad of [
    "..%2F..%2Fetc",
    "runs%2F57",
    "verifier%2F..%2F..%2Fstate.json",
    "verifier%2F56%2Fbuilder-1",
    "verifier",
  ]) {
    const refused = await getJson(port, `/agent-log?id=${bad}`);
    assert.equal(refused.status, 400, `${bad} was not refused`);
  }
  // Well-formed, just not there.
  const missing = await getJson(port, "/agent-log?id=verifier%2F99");
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// Several runs, one page. Discovery is the same `/health` probe the port scan
// trusts — no registry file, which would go stale the first time a dashboard
// was killed with -9.
// ---------------------------------------------------------------------------

test("every dashboard in the range is discovered, in a stable order", async () => {
  const listening = {
    4102: { ok: true, root: "/code/beta", project: "beta", port: 4102 },
    4101: { ok: true, root: "/code/alpha", project: "alpha", port: 4101 },
    4103: { ok: true, root: "/code/alpha-two", project: "alpha", port: 4103 },
    // Something that answers 200 but is not a dashboard, and a dead one.
    4104: { status: "fine" },
  };
  const probed = [];
  const probe = async (port) => {
    probed.push(port);
    return listening[port] ?? null;
  };
  const found = await discoverDashboards({ probe, start: 4100, span: 8, chunk: 3 });
  assert.deepEqual(
    found.map((peer) => [peer.project, peer.port]),
    [
      ["alpha", 4101],
      ["alpha", 4103],
      ["beta", 4102],
    ],
    "by project then port, so tabs do not reshuffle under the cursor",
  );
  // Every port in the window, chunked — none skipped, none probed twice.
  assert.deepEqual(probed.sort((a, b) => a - b), [
    4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107,
  ]);
});

test("a dashboard's health names its run, and its liveness is the run's", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-dashboard-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(
    join(root, ".afk", "state.json"),
    JSON.stringify({
      // A pid that cannot be alive: the dashboard answering says nothing about
      // whether the RUN is still going, and the tab must not claim otherwise.
      orchestratorPid: 2_147_483_600,
      dag: {
        epic: { id: "654", title: "Reduce the filter menu" },
        branch: "feat/654",
        tasks: [{ id: "655" }, { id: "656" }, { id: "657" }],
      },
      tasks: {
        655: { lifecycle: "passed" },
        // `no-op` is finished work — `renderCloseout` marks it ✅ beside passed.
        656: { lifecycle: "no-op" },
        657: { lifecycle: "running" },
      },
    }),
  );

  isolateEnv(t, root);
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))],
    { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" },
  );
  t.after(() => server.kill("SIGTERM"));
  const health = await waitForServer(port);
  // The fields the port scan already depends on are untouched.
  assert.equal(health.ok, true);
  assert.equal(health.port, port);
  assert.ok(health.root);
  assert.equal(health.project, root.split("/").filter(Boolean).at(-1));
  assert.equal(health.epic.id, "654");
  assert.equal(health.branch, "feat/654");
  // A frozen state file with `running` tasks in it is STALE, not idle, and not
  // running: a live web server is not a live run.
  assert.equal(health.status, "stale");
  assert.deepEqual(health.progress, { total: 3, passed: 2 });
  // #244: the per-phase counts sit beside progress, never inside it.
  assert.deepEqual(health.counts, { done: 2, active: 0, review: 0, gate: 0, failed: 0, stale: 1, waiting: 0 });
});

// A dashboard serving this state, on a free port. Returns its health.
const serveState = async (t, state) => {
  const root = mkdtempSync(join(tmpdir(), "afk-dashboard-counts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify(state));
  isolateEnv(t, root);
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))],
    { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" },
  );
  t.after(() => server.kill("SIGTERM"));
  return { port, health: await waitForServer(port) };
};

test("#244: /health counts each task's phase the way the dashboard's bar does", async (t) => {
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const { health } = await serveState(t, {
    // This test process: alive, so `running` is active, not stale.
    orchestratorPid: process.pid,
    dag: {
      epic: { id: "9", title: "x" },
      branch: "feat/9",
      tasks: ids.map((id) => ({ id, dependsOn: id === "8" ? ["7"] : [] })),
    },
    tasks: {
      1: { lifecycle: "passed" },
      2: { lifecycle: "no-op" },
      3: { lifecycle: "running" },
      4: { lifecycle: "ready_to_integrate" },
      5: { lifecycle: "awaiting_acceptance" },
      6: { lifecycle: "failed" },
      7: { lifecycle: "integration_failed" },
      8: { lifecycle: "pending" },
    },
  });
  assert.equal(health.status, "running");
  assert.deepEqual(health.progress, { total: 8, passed: 2 });
  assert.deepEqual(health.counts, { done: 2, active: 1, review: 1, gate: 1, failed: 2, stale: 0, waiting: 1 });
});

test("#243: `/?embed=1` serves the dashboard marked as embedded, which hides its own tab strip", async (t) => {
  const { port } = await serveState(t, { dag: { tasks: [] }, tasks: {} });
  const plain = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(plain.status, 200);
  const plainHtml = await plain.text();
  assert.match(plainHtml, /<body>/);
  assert.doesNotMatch(plainHtml, /<body data-embed>/);
  const embedded = await fetch(`http://127.0.0.1:${port}/?embed=1`);
  assert.equal(embedded.status, 200, "the query string must not 404 the page");
  const html = await embedded.text();
  assert.match(html, /<body data-embed>/);
  // The strip is hidden by CSS, so the JS that shows it after a sweep cannot bring it back.
  assert.match(html, /body\[data-embed\] \.peers \{\s*display: none !important;/);
});

test("the hub port is fixed and outside the range", () => {
  // Below the derived window on purpose: no checkout can hash onto it, so
  // holding it never costs a run the port it needed. `afk hub` holds it; no
  // dashboard listens there (#237 H4, checked in hub.test.mjs).
  assert.ok(HUB_PORT < derivedDashboardPort("/any/checkout"));
  assert.ok(HUB_PORT < 4100);
});

// ---------------------------------------------------------------------------
// The dashboard is off the launch path. Its lanes warm-up read every Claude
// transcript on this machine synchronously inside the listen callback (~15k
// files, 2 s warm to 23 s cold), so `/health` missed startDashboard's 3 s
// deadline and the epic died before its baseline.
// ---------------------------------------------------------------------------

// A transcripts root whose scan never finishes: `.jsonl` files that are FIFOs
// with no writer, so opening one to read its head blocks until killed. One sits
// in a atlas-workspace folder, the only folders /lanes/compare reads.
const blockingTranscripts = (t) => {
  const r = mkdtempSync(join(tmpdir(), "afk-transcripts-fifo-"));
  t.after(() => rmSync(r, { recursive: true, force: true }));
  for (const folder of ["-Users-x-code-projects-p", "-Users-x-code-projects-atlas-workspace"]) {
    mkdirSync(join(r, folder));
    const made = spawnSync("mkfifo", [join(r, folder, "s.jsonl")]);
    assert.equal(made.status, 0, "fixture precondition: mkfifo");
  }
  return r;
};

// A dashboard over `blockingTranscripts`, on a free port.
const serveBlocked = async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-dash-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  isolateEnv(t, root, { AFK_TRANSCRIPTS_ROOT: blockingTranscripts(t), AFK_NO_HUB: "1" });
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./dashboard-server.mjs", import.meta.url))],
    { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" },
  );
  // SIGKILL: a thread blocked opening a FIFO does not wait for SIGTERM's turn.
  t.after(() => server.kill("SIGKILL"));
  return port;
};

test("/health answers while the lanes warm-up scan is still reading transcripts", async (t) => {
  const port = await serveBlocked(t);
  let answer = null;
  const deadline = Date.now() + 3000;
  while (!answer && Date.now() < deadline) {
    answer = await dashboardHealth(port);
    if (!answer) await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(answer?.ok, "/health did not answer within 3 s while the scan was blocked");
});

// /lanes and /lanes/compare scan on a cold cache too. On the request thread
// that scan held every other request, /health included, until it finished.
for (const path of ["/lanes", "/lanes/compare"]) {
  test(`/health answers while a ${path} request is still reading transcripts`, async (t) => {
    const port = await serveBlocked(t);
    await waitForServer(port);
    const outstanding = new AbortController();
    t.after(() => outstanding.abort());
    let answered = false;
    fetch(`http://127.0.0.1:${port}${path}`, { signal: outstanding.signal }).then(() => { answered = true; }, () => {});
    // Long enough for the server to take the request before /health is sent.
    await new Promise((done) => setTimeout(done, 300));
    const started = Date.now();
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      .then((res) => res.json(), (error) => ({ error: error.message }));
    assert.equal(answered, false, `fixture precondition: ${path} is still outstanding`);
    assert.ok(health.ok, `/health did not answer within 1000 ms while ${path} was outstanding (${Date.now() - started} ms: ${health.error})`);
  });
}

test("a dashboard that does not answer /health in time is named as that, and no other port is tried", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-dash-slow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "dashboard.log");
  isolateEnv(t, dir, { PORT: undefined }); // derived port: the case that used to walk 20 ports
  const started = Date.now();
  // 50 ms is shorter than node takes to boot, so the child is alive and silent.
  // A start that wrongly succeeds is stopped, so a red run does not hang.
  const outcome = await startDashboard({ root: dir, logPath, healthTimeoutMs: 50 }).then(
    (dashboard) => { dashboard.stop(); return dashboard; },
    (error) => error,
  );
  assert.ok(outcome instanceof Error, "a dashboard silent past the deadline was treated as started");
  assert.match(outcome.message, /started but did not answer \/health in 0\.05s/);
  assert.ok(outcome.message.includes(logPath), outcome.message);
  assert.doesNotMatch(outcome.message, /could not bind a port|taken by other projects/);
  assert.ok(Date.now() - started < 2000, "it walked other ports instead of stopping");
});

test("a non-dashboard on 127.0.0.1 at the derived port is a taken port: the dashboard starts on the next one", async (t) => {
  // A dev server bound to 127.0.0.1 answers the probe's /health with a 404, so
  // the probe calls the port free. The dashboard must then fail to bind (exit
  // 98) and walk on. Bound to `::`, it bound beside the squatter on macOS, the
  // probe kept reaching the 404, and the start died as a /health timeout.
  const dir = mkdtempSync(join(tmpdir(), "afk-dash-squat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "dashboard.log");
  isolateEnv(t, dir, { PORT: undefined });
  const squatted = derivedDashboardPort(dir);
  const squatter = createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((done) => squatter.listen(squatted, "127.0.0.1", done));
  t.after(() => squatter.close());

  const outcome = await startDashboard({ root: dir, logPath }).catch((error) => error);
  if (!(outcome instanceof Error)) outcome.stop();
  assert.ok(!(outcome instanceof Error), `the start failed: ${outcome.message}`);
  assert.ok(outcome.port > squatted, `started on ${outcome.port}, squatter holds ${squatted}`);
  assert.equal(outcome.reused, false);
  assert.match(readFileSync(logPath, "utf8"), new RegExp(`port ${squatted} is already in use`));
});

test("a process on `::` at the dashboard's port does not get the printed link: the URL names 127.0.0.1", async (t) => {
  // Node's default listen (no host) is `::`, e.g. a Next dev server. The
  // dashboard binds 127.0.0.1 beside it on macOS, and `localhost` resolves to
  // ::1 first, so a printed `http://localhost:P` opened the other process.
  const dir = mkdtempSync(join(tmpdir(), "afk-dash-v6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "dashboard.log");
  isolateEnv(t, dir);
  const squatter = createServer((_, res) => { res.writeHead(200); res.end("squatter"); });
  await new Promise((done) => squatter.listen(0, "::", done));
  t.after(() => squatter.close());
  const port = squatter.address().port;

  const dashboard = await startDashboard({ root: dir, logPath, port });
  t.after(() => dashboard.stop());
  assert.equal(dashboard.port, port, "fixture precondition: the dashboard bound beside the `::` squatter");
  // The link the dashboard prints, and the one the runner prints from the start.
  let printed = null;
  for (const deadline = Date.now() + 2000; !printed && Date.now() < deadline;) {
    printed = readFileSync(logPath, "utf8").match(/Dashboard: (\S+)/)?.[1] ?? null;
    if (!printed) await new Promise((done) => setTimeout(done, 25));
  }
  for (const url of [printed, dashboard.url]) {
    assert.equal(url, `http://127.0.0.1:${port}`);
    const body = await fetch(`${url}/health`).then((res) => res.text());
    assert.notEqual(body, "squatter", `${url} reached the squatter`);
    assert.equal(realpathSync(JSON.parse(body).root), realpathSync(dir));
  }
});
