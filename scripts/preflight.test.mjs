// scripts/preflight.test.mjs — the host probes a run makes before any lane (#180).
//
// harbour #246 needed six launches for four host faults, and a Playwright
// `webServer` timed out 13 times on a port another process already held. Each
// was found by a failing gate or a dead lane, after a plan review and often a
// baseline had been paid for. These tests hold the preflight that finds them
// first: a project's own probe commands, the herdr server under the herdr
// runtime, and the ports the epic checkout's gates bind.
//
// The harness (`makeRepo`, `fakeClaude`, `runIn`) is copied from
// orchestrator-death.test.mjs; the delta is a builder seam that only counts.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import * as auto from "./auto.mjs";
import { validateEpic } from "./epic.mjs";
import { freePort } from "./free-port.mjs";
import { renderBaselinePreflight, runBaselinePreflight, runPreflight } from "./preflight.mjs";
import * as scheduler from "./scheduler.mjs";
import { missingPackageWarnings, npmPackagesNamed, preflightBlockers, preflightConfigErrors } from "./scheduler.mjs";
import { holdGateLock, readConfig, writeConfig } from "./test-helpers.mjs";

process.setMaxListeners(60);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const afkBin = fileURLToPath(new URL("../afk.mjs", import.meta.url));

const makeRepo = (t, config) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-preflight-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeConfig(repo, config);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const before = process.env.AFK_WORKTREE_ROOT;
  process.env.AFK_WORKTREE_ROOT = join(base, "lanes");
  t.after(() => {
    if (before === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = before;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, repo };
};

// The auth probe is the only agent anything here spawns through PATH.
const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-preflight-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

const runIn = async (repo, args) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await auto.runAuto({ config: readConfig(repo), root: repo, interactive: false, ...args });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

const logOf = (repo) => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
const TASK = { id: "401", title: "Lane", dependsOn: [], body: "" };
const DAG = { branch: "main", tasks: [TASK] };

// A builder that only counts. A `blocked` outcome ends the lane without a
// merger; "spawned" is the count, and that is all these tests ask.
const countingBuilder = () => {
  const calls = [];
  return {
    calls,
    builder: async ({ task }) => {
      calls.push(task.id);
      return { outcome: "blocked", verification: { checks: [], durationMs: 5000, tokens: 1 } };
    },
  };
};

const listen = async (t) => {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  t.after(() => server.close());
  return server.address().port;
};

const BASE = { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] };

test("a failing project probe blocks with its label, its command and its output tail, and spawns nothing", async (t) => {
  const { repo } = makeRepo(t, {
    ...BASE,
    preflight: {
      probes: {
        "pnpm shim answers": "true",
        "container runtime is up": "echo 'Cannot connect to the Docker daemon' >&2; exit 3",
      },
    },
  });
  const { calls, builder } = countingBuilder();
  const code = await runIn(repo, { dag: DAG, explicitTaskId: "401", builder });
  const log = logOf(repo);
  assert.equal(code, 1, log);
  assert.deepEqual(calls, [], "no lane may be spawned past a failed probe");
  assert.match(log, /AUTO: preflight "container runtime is up" failed \(exit 3\): `echo 'Cannot connect to the Docker daemon' >&2; exit 3`/);
  assert.match(log, /\n {4}Cannot connect to the Docker daemon/);
  assert.doesNotMatch(log, /pnpm shim answers/, "a passing probe is not a blocker");
  assert.match(log, /AUTO: preflight failed; no builders were spawned/);
});

test("a held port on the epic checkout is reported with the pid and command holding it", async (t) => {
  const port = await listen(t);
  const { base, repo } = makeRepo(t, BASE);
  // The ports command gets the checkout path as its last argument, the way
  // Harbour derives its ports from a hash of the path.
  const seen = join(base, "ports-arg.txt");
  writeFileSync(join(base, "ports.sh"), `#!/bin/sh\nprintf '%s' "$1" > '${seen}'\necho ${port}\n`);
  chmodSync(join(base, "ports.sh"), 0o755);
  writeConfig(repo, { ...BASE, preflight: { ports: `'${join(base, "ports.sh")}'` } });
  git(repo, "commit", "-qam", "ports");
  const { calls, builder } = countingBuilder();
  const code = await runIn(repo, { dag: DAG, explicitTaskId: "401", builder });
  const log = logOf(repo);
  assert.equal(code, 1, log);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(seen, "utf8"), repo, "the ports command is asked about the epic checkout");
  assert.match(log, new RegExp(`AUTO: port ${port} \\(for ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) is held by pid ${process.pid} \\(node\\)`));
});

test("a ports command that fails or prints a non-port blocks, rather than checking nothing", () => {
  const ok = { status: 0, stdout: "" };
  const config = { preflight: { ports: "derive-ports" } };
  const run = (stdout, status = 0) => preflightBlockers({
    config, env: {}, root: "/co", checkAuth: () => true,
    runCommand: () => ({ status, stdout, stderr: "" }),
    portHolders: () => [],
  });
  assert.deepEqual(run("3000, 3001\n"), []);
  assert.match(run("", 2)[0], /preflight ports command failed \(exit 2\): `derive-ports '\/co'`/);
  assert.match(run("port 3000")[0], /printed "port", which is not a port/);
  assert.match(
    preflightBlockers({ config, env: {}, root: "/co", checkAuth: () => true, runCommand: () => ({ ...ok, stdout: "3000" }), portHolders: () => "lsof exited 2: boom" })[0],
    /port 3000 \(for \/co\): could not check — lsof exited 2: boom/,
  );
});

test("a missing herdr server blocks under the herdr runtime and is not probed under direct", async (t) => {
  const { repo } = makeRepo(t, BASE);
  // `herdr status server` exits 0 when the server is down; only the status line says so.
  let probed = 0;
  const herdrStatus = () => {
    probed += 1;
    return { status: 0, stdout: "status: not running\nsocket: /tmp/herdr.sock\n", stderr: "" };
  };
  const env = { PATH: `${fakeClaude}:${process.env.PATH}` };
  const herdr = runPreflight({ root: repo, config: readConfig(repo), runtime: "herdr", env, checkAuth: () => true, herdrStatus });
  assert.equal(herdr.ok, false);
  assert.match(herdr.blockers[0], /^herdr server is not running — start it with `herdr`, then rerun\n {4}status: not running/);
  assert.equal(probed, 1);

  const direct = runPreflight({ root: repo, config: readConfig(repo), runtime: "direct", env, checkAuth: () => true, herdrStatus });
  assert.deepEqual(direct.blockers, []);
  assert.equal(probed, 1, "the direct runtime never asks herdr");

  const running = runPreflight({
    root: repo, config: readConfig(repo), runtime: "herdr", env, checkAuth: () => true,
    herdrStatus: () => ({ status: 0, stdout: "status: running\nversion: 0.8.2\n" }),
  });
  assert.deepEqual(running.blockers, []);

  // And the run itself refuses on it, before any lane.
  const { calls, builder } = countingBuilder();
  const code = await runIn(repo, { dag: DAG, explicitTaskId: "401", builder, runtime: "herdr", herdrStatus });
  assert.equal(code, 1, logOf(repo));
  assert.deepEqual(calls, []);
  assert.match(logOf(repo), /AUTO: herdr server is not running/);
});

test("with every probe passing the run spawns its lane as today", async (t) => {
  const { base, repo } = makeRepo(t, BASE);
  const port = await freePort();
  writeConfig(repo, {
    ...BASE,
    preflight: { probes: { "database answers": "true" }, ports: `sh -c "echo ${port}" ports` },
  });
  git(repo, "commit", "-qam", "probes");
  const { calls, builder } = countingBuilder();
  await runIn(repo, { dag: DAG, explicitTaskId: "401", builder });
  assert.deepEqual(calls, ["401"], logOf(repo));
  assert.doesNotMatch(logOf(repo), /preflight failed/);
  assert.ok(existsSync(base));
});

test("`afk preflight` runs the same probes on demand and exits non-zero on a blocker", (t) => {
  const { repo } = makeRepo(t, { ...BASE, preflight: { probes: { "local database is up": "exit 7" } } });
  const env = { ...process.env, PATH: `${fakeClaude}:${process.env.PATH}` };
  const failed = spawnSync(process.execPath, [afkBin, "preflight"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /PREFLIGHT: preflight "local database is up" failed \(exit 7\): `exit 7`/);
  assert.match(failed.stdout, /1 blocker\(s\); a run would spawn nothing/);

  writeConfig(repo, { ...BASE, preflight: { probes: { "local database is up": "true" } } });
  const passed = spawnSync(process.execPath, [afkBin, "preflight"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /PREFLIGHT: ok — every probe passed\./);
});

// --- `afk validate` stays offline ------------------------------------------

const EPIC = {
  number: 900,
  title: "Probes",
  body: ["```yaml", "afk:", "  version: 1", "  branch: feat/900-probes", "  tasks:", "    901:", "      depends_on: []", "```"].join("\n"),
  children: [{ number: 901, title: "One", state: "OPEN", body: "x\n\n## Acceptance criteria\n\n- It works\n" }],
};

test("an unknown key under `preflight:` is a validation error, and validate runs no probe", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-preflight-validate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const touched = join(dir, "probe-ran");
  const good = { defaultChecks: ["true"], preflight: { probes: { "would touch": `touch '${touched}'` }, ports: `touch '${touched}'` } };
  const report = validateEpic({ epic: EPIC, config: good, branchStatus: () => ({ exists: false }) });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(existsSync(touched), false, "validate must not run a probe");

  const typo = validateEpic({
    epic: EPIC,
    config: { defaultChecks: ["true"], preflight: { probe: { x: "true" } } },
    branchStatus: () => ({ exists: false }),
  });
  assert.equal(typo.ok, false);
  assert.match(typo.errors.find((error) => error.code === "preflight_config").message, /unknown key\(s\) probe \(allowed: probes, ports, macAutomation\)/);

  assert.match(preflightConfigErrors({ preflight: { probes: { empty: "" } } })[0], /probe "empty" must be a non-empty command string/);
  assert.match(preflightConfigErrors({ preflight: { ports: ["3000"] } })[0], /`ports:` must be one command/);
  assert.deepEqual(preflightConfigErrors({}), []);
});

// ---------------------------------------------------------------------------
// The Infisical session (#210)
// ---------------------------------------------------------------------------

// A stub `infisical` on PATH: `user get token` answers as a CLI with no
// session does, and every call is counted, so "skipped" is checkable.
const stubInfisical = (t, { loggedIn }) => {
  const bin = mkdtempSync(join(tmpdir(), "afk-infisical-bin-"));
  const calls = join(bin, "calls.log");
  writeFileSync(join(bin, "infisical"), loggedIn
    ? `#!/bin/sh\necho "$@" >> '${calls}'\necho tok\nexit 0\n`
    : `#!/bin/sh\necho "$@" >> '${calls}'\necho 'error: No valid login session found, please run infisical login' >&2\nexit 1\n`);
  chmodSync(join(bin, "infisical"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; rmSync(bin, { recursive: true, force: true }); });
  return () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
};

const INFISICAL_CHECK = "infisical run --domain=https://secrets.example.com -- npm test";

test("an expired Infisical session refuses preflight before any builder, naming the login command", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, defaultChecks: [INFISICAL_CHECK] });
  const calls = stubInfisical(t, { loggedIn: false });
  const { calls: spawned, builder } = countingBuilder();
  const code = await runIn(repo, { dag: DAG, explicitTaskId: "401", builder });
  const log = logOf(repo);
  assert.equal(code, 1, log);
  assert.deepEqual(spawned, [], "no lane may be spawned without an Infisical session");
  // The preflight probe is #214's (`hostProbes`), one call, one line.
  assert.match(log, /AUTO: Infisical login expired or missing: .*Run `infisical login`, then rerun\./);
  assert.deepEqual(calls(), ["user get token --silent"]);
});

test("per-task checks count, and a live session passes the probe", async (t) => {
  const { repo } = makeRepo(t, BASE);
  const calls = stubInfisical(t, { loggedIn: true });
  const dag = { ...DAG, tasks: [{ ...TASK, checks: ["infisical run -- npm test"] }] };
  const { calls: spawned, builder } = countingBuilder();
  await runIn(repo, { dag, explicitTaskId: "401", builder });
  assert.deepEqual(spawned, ["401"], logOf(repo));
  assert.ok(calls().length >= 1, "the session was probed");
});

test("repos whose checks never call `infisical run` skip the probe", async (t) => {
  const { repo } = makeRepo(t, BASE);
  const calls = stubInfisical(t, { loggedIn: false });
  const report = runPreflight({ root: repo, config: readConfig(repo), env: process.env, checkAuth: () => true });
  assert.equal(report.blockers.some((line) => /Infisical/.test(line)), false);
  assert.deepEqual(calls(), []);
});

test("a gate red on 'No valid login session found' is infra, and the domain falls back to a placeholder", async () => {
  const { gateLostInfisicalSession } = auto;
  const { infisicalBlocker, infisicalDomain } = await import("./infisical.mjs");
  assert.equal(gateLostInfisicalSession({ checks: [{ command: "infisical run -- npm test", code: 1, output: "error: No valid login session found" }] }), true);
  assert.equal(gateLostInfisicalSession({ checks: [{ command: "npm test", code: 1, output: "AssertionError" }] }), false);
  assert.equal(gateLostInfisicalSession({ checks: [], checkReruns: [{ firstOutput: "No valid login session found" }] }), true);
  assert.equal(infisicalDomain({ defaultChecks: ["infisical run -- x"] }, null, {}), "<your-infisical-domain>");
  assert.equal(infisicalDomain({ defaultChecks: ["infisical run -- x"] }, null, { INFISICAL_API_URL: "https://s.example/api" }), "https://s.example");
  assert.equal(infisicalBlocker({ config: { defaultChecks: ["npm test"] }, probe: () => assert.fail("probed") }), null);
});

test("a lane whose gate loses the Infisical session is left infra_failed with its reset kept", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, defaultChecks: [INFISICAL_CHECK] });
  const builder = async () => ({
    outcome: "failed",
    verification: { durationMs: 30_000, tokens: 10, checks: [{ command: INFISICAL_CHECK, code: 1, output: "No valid login session found" }] },
  });
  // Live at preflight (#214's probe), gone by the gate.
  const code = await runIn(repo, { dag: DAG, explicitTaskId: "401", builder,
    preflightProbeOverrides: { infisicalProbe: () => ({ status: 0 }), ghAuthProbe: null },
    infisicalProbe: () => true });
  const log = logOf(repo);
  const state = JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
  assert.equal(state.tasks["401"].lifecycle, "infra_failed", log);
  assert.equal(state.tasks["401"].builderAttempt, 0);
  assert.match(log, /expired Infisical session \(infra, not the ticket\)/);
  assert.notEqual(code, 0);
});

test("a red gate that only prints the Infisical phrase is a normal failure when no check calls `infisical run`", async (t) => {
  // Epic #292 lane #293: afk-claude's selftest went red on cancelled tests,
  // and its own Infisical tests print the phrase in their TAP output.
  const { repo } = makeRepo(t, BASE);
  const builder = async () => ({
    outcome: "failed",
    verification: { durationMs: 30_000, tokens: 10, checks: [{ command: "node afk.mjs selftest", code: 1, output: "# cancelled 3\n# error: No valid login session found" }] },
  });
  await runIn(repo, { dag: DAG, explicitTaskId: "401", builder });
  const log = logOf(repo);
  const state = JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
  assert.notEqual(state.tasks["401"].lifecycle, "infra_failed", log);
  assert.doesNotMatch(log, /Infisical/);
});

test("`afk validate --unattended` refuses on an expired Infisical session", async () => {
  const { unattendedVerdict } = await import("./forecast.mjs");
  const report = { ok: true, forecast: { stops: [] } };
  const line = "Infisical login expired: run `infisical login --domain=x`, then rerun.";
  const verdict = unattendedVerdict({ report, review: { ok: true }, infisical: line });
  assert.equal(verdict.ok, false);
  assert.match(verdict.line, /UNATTENDED: refused: Infisical login expired: run `infisical login --domain=x`, then rerun\./);
  assert.equal(unattendedVerdict({ report, review: { ok: true } }).ok, true);
});

// ---------------------------------------------------------------------------
// Owner checks (#210): the Infisical login and macOS automation, probed
// automatically from what the config and the tickets use. Probes are stubbed;
// no test runs the real infisical or agent-device.
// ---------------------------------------------------------------------------

const INFISICAL = { ...BASE, defaultChecks: ["infisical run -- npm test"] };
const UI_TASK = { ...TASK, body: "Verify with `agent-device snapshot -i` on the board." };
const failingInfisical = () => ({ status: 1, stdout: "", stderr: "No valid login session found" });

test("an `infisical run` gate with no login session blocks the run before any lane, naming `infisical login`", async (t) => {
  const { repo } = makeRepo(t, INFISICAL);
  const { calls, builder } = countingBuilder();
  const code = await runIn(repo, {
    dag: DAG, explicitTaskId: "401", builder,
    preflightProbeOverrides: { infisicalProbe: failingInfisical },
  });
  const log = logOf(repo);
  assert.equal(code, 1, log);
  assert.deepEqual(calls, []);
  assert.match(log, /AUTO: Infisical login expired or missing: .*Run `infisical login`, then rerun\./);
});

test("the Infisical probe runs for baselineChecks and task checks, and never when no gate uses it", () => {
  let probed = 0;
  const probe = () => { probed += 1; return { status: 1 }; };
  const run = (config, tasks = []) => preflightBlockers({ config, checkAuth: () => true, tasks, infisicalProbe: probe });
  assert.deepEqual(run(BASE), []);
  assert.equal(probed, 0, "no `infisical run` anywhere: no probe");
  assert.equal(run({ ...BASE, baselineChecks: ["infisical run --env=dev -- npm run build"] }).length, 1);
  assert.equal(run(BASE, [{ id: "1", checks: ["infisical run -- vitest"] }]).length, 1);
  assert.equal(run(BASE, [], ).length, 0);
  assert.equal(preflightBlockers({ config: INFISICAL, checkAuth: () => true, infisicalProbe: () => ({ status: 0 }) }).length, 0);
});

test("a UI ticket on darwin runs the macOS automation session and a failed one blocks with the grant line", () => {
  let sessions = 0;
  const fail = () => { sessions += 1; return { ok: false, status: null, stderr: "ETIMEDOUT" }; };
  const args = { config: BASE, checkAuth: () => true, macAutomationProbe: fail, platform: "darwin" };
  const blockers = preflightBlockers({ ...args, tasks: [UI_TASK] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /^macOS automation not granted: approve the Accessibility\/Screen Recording prompt, then rerun/);
  for (const body of ["uses XCUITest", "run `xcodebuild test -scheme X`"])
    assert.equal(preflightBlockers({ ...args, tasks: [{ id: "2", body }] }).length, 1, body);
  assert.equal(sessions, 3);
  // Skipped: no UI ticket, a non-darwin host, or switched off in config.
  assert.deepEqual(preflightBlockers({ ...args, tasks: [TASK] }), []);
  assert.deepEqual(preflightBlockers({ ...args, tasks: [UI_TASK], platform: "linux" }), []);
  assert.deepEqual(preflightBlockers({ ...args, tasks: [UI_TASK], config: { ...BASE, preflight: { macAutomation: false } } }), []);
  assert.equal(sessions, 3);
  assert.deepEqual(preflightBlockers({ ...args, tasks: [UI_TASK], macAutomationProbe: () => ({ ok: true }) }), []);
  assert.deepEqual(preflightConfigErrors({ preflight: { macAutomation: "no" } }).length, 1);
});

test("the macOS session passes on a snapshot with refs, fails on a timeout, and always closes", () => {
  const calls = [];
  const exec = (outcomes) => (command) => {
    calls.push(command);
    for (const [re, result] of outcomes) if (re.test(command)) return result;
    if (/pgrep/.test(command)) return { status: 1, stdout: "" }; // TextEdit not running before the probe
    return { status: 0, stdout: "" };
  };
  assert.equal(auto.macAutomationSession({ root: "/", exec: exec([[/snapshot/, { status: 0, stdout: '@e1 [window] "Untitled"' }]]) }).ok, true);
  assert.match(calls.join("\n"), /open TextEdit --platform macos[\s\S]*snapshot -i[\s\S]*close[\s\S]*quit app "TextEdit"/);
  calls.length = 0;
  assert.equal(auto.macAutomationSession({ root: "/", exec: exec([[/snapshot/, { status: null, signal: "SIGTERM", stdout: "" }]]) }).ok, false);
  assert.equal(auto.macAutomationSession({ root: "/", exec: exec([[/snapshot/, { status: 0, stdout: "AX unavailable" }]]) }).ok, false);
  assert.ok(calls.some((c) => /quit app/.test(c)), "TextEdit is quit even when the snapshot fails");
});

test("UI tickets get the Keychain warning in `runPreflight`, and other tickets do not", (t) => {
  const { repo } = makeRepo(t, BASE);
  const report = runPreflight({ root: repo, config: BASE, checkAuth: () => true, tasks: [UI_TASK], probes: { macAutomationProbe: () => ({ ok: true }) } });
  assert.equal(report.ok, true, report.blockers.join("\n"));
  assert.match(report.warnings.join("\n"), /401 drive the screen: .*Keychain prompt.*fallback/);
  assert.deepEqual(runPreflight({ root: repo, config: BASE, checkAuth: () => true, tasks: [TASK] }).warnings, []);
});

test("a logged-out gh blocks with `gh auth login`; a logged-in one passes", () => {
  const args = { config: BASE, checkAuth: () => true };
  const blockers = preflightBlockers({ ...args, ghAuthProbe: () => ({ status: 1, stderr: "You are not logged into any GitHub hosts." }) });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /^gh is not logged in: run `gh auth login`, then rerun\./);
  assert.deepEqual(preflightBlockers({ ...args, ghAuthProbe: () => ({ status: 0 }) }), []);
});

test("a ticket naming an npm package the base lacks is a warning, not a blocker", (t) => {
  assert.deepEqual(npmPackagesNamed("Run `npm install -D vitest @scope/pkg@2 zod`."), ["vitest", "@scope/pkg", "zod"]);
  const packageJson = { dependencies: { zod: "1" }, devDependencies: { vitest: "1" } };
  const tasks = [{ id: "7", body: "First `npm i left-pad zod`." }, { id: "8", body: "npm install -D vitest" }];
  const warnings = missingPackageWarnings({ tasks, packageJson });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^task 7 names npm package\(s\) left-pad missing from the base's package.json/);
  const { repo } = makeRepo(t, BASE);
  writeFileSync(join(repo, "package.json"), JSON.stringify(packageJson));
  const report = runPreflight({ root: repo, config: BASE, checkAuth: () => true, tasks });
  assert.equal(report.ok, true);
  assert.match(report.warnings.join("\n"), /left-pad/);
});

test("only tasks that will get a lane this run count: passed, gate:after and gate:before tasks do not", () => {
  const ui = (id, extra = {}) => ({ ...UI_TASK, id, ...extra });
  const dag = { tasks: [ui("1"), ui("2", { gateAfter: true }), ui("3", { humanGated: true }), ui("4")] };
  const state = { tasks: { 4: { lifecycle: "passed" } } };
  assert.equal(typeof scheduler.laneTasks, "function", "scheduler exports laneTasks");
  assert.deepEqual(scheduler.laneTasks(dag, state).map((t) => t.id), ["1"]);
  assert.deepEqual(scheduler.laneTasks(dag, state, "3").map((t) => t.id), ["3"]);
  assert.deepEqual(scheduler.laneTasks(dag, { tasks: { 1: { lifecycle: "passed" }, 4: { lifecycle: "passed" } } }), []);
});

test("a run whose only UI ticket gets no lane does not run the macOS probe", async (t) => {
  const { repo } = makeRepo(t, BASE);
  let sessions = 0;
  const dag = { branch: "main", tasks: [{ ...UI_TASK, id: "400", gateAfter: true }, TASK] };
  const { builder } = countingBuilder();
  await runIn(repo, { dag, explicitTaskId: "401", builder, preflightProbeOverrides: { macAutomationProbe: () => { sessions += 1; return { ok: true }; }, ghAuthProbe: null } });
  assert.equal(sessions, 0, logOf(repo));
});

test("a device claimed by another session is reported as DEVICE_IN_USE with the daemon fix, not as a missing grant", () => {
  const busy = { status: 1, stdout: "", stderr: "Error (DEVICE_IN_USE): Device is already in use by session abc" };
  const calls = [];
  const result = auto.macAutomationSession({ root: "/", exec: (c) => { calls.push(c); return /open TextEdit/.test(c) ? busy : { status: 0, stdout: "" }; } });
  assert.equal(result.ok, false);
  assert.equal(result.deviceInUse, true);
  const warnings = [];
  const blockers = preflightBlockers({ config: BASE, checkAuth: () => true, platform: "darwin", tasks: [UI_TASK], macAutomationProbe: () => result, warnings });
  assert.deepEqual(blockers, []);
  assert.match(warnings.join("\n"), /DEVICE_IN_USE[\s\S]*agent-device/);
  assert.doesNotMatch(warnings.join("\n"), /not granted/);
});

test("the probe only quits TextEdit when it was not already running", () => {
  const run = (running) => {
    const calls = [];
    auto.macAutomationSession({ root: "/", exec: (c) => { calls.push(c); if (/pgrep/.test(c)) return { status: running ? 0 : 1 }; return /snapshot/.test(c) ? { status: 0, stdout: "@e1" } : { status: 0, stdout: "" }; } });
    return calls.some((c) => /quit app/.test(c));
  };
  assert.equal(run(true), false, "owner's TextEdit left alone");
  assert.equal(run(false), true);
});

test("atlas's `npm run infisical -- -- ...` gate counts as an Infisical gate", () => {
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run infisical -- -- npx vitest run"] }), true);
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run test"] }), false);
});

test("a dependency-blocked task counts as a lane: deriveBlocked may flip it to pending after preflight", () => {
  const dag = { tasks: [{ ...UI_TASK, id: "1", dependsOn: [] }, { ...UI_TASK, id: "2", dependsOn: ["1"] }, { ...UI_TASK, id: "3", dependsOn: [] }] };
  const state = { tasks: { 1: { lifecycle: "pending" }, 2: { lifecycle: "blocked", blockedBy: "1" }, 3: { lifecycle: "blocked" } } };
  assert.deepEqual(scheduler.laneTasks(dag, state).map((t) => t.id), ["1", "2"], "no-change `blocked` (no blockedBy) stays out");
});

test("tasks awaiting integration still run their checks: Infisical counts them, the macOS probe does not", () => {
  const dag = { tasks: [{ ...UI_TASK, id: "1", checks: ["infisical run -- npm test"] }, { ...UI_TASK, id: "2", checks: ["infisical run -- npm test"] }] };
  const state = { tasks: { 1: { lifecycle: "ready_to_integrate" }, 2: { lifecycle: "integrating" } } };
  assert.equal(typeof scheduler.checkTasks, "function", "scheduler exports checkTasks");
  assert.deepEqual(scheduler.checkTasks(dag, state).map((t) => t.id), ["1", "2"]);
  assert.deepEqual(scheduler.laneTasks(dag, state), []);
  let infisical = 0, mac = 0;
  const blockers = preflightBlockers({ config: {}, checkAuth: () => true, platform: "darwin", tasks: scheduler.laneTasks(dag, state), checkTasks: scheduler.checkTasks(dag, state),
    infisicalProbe: () => { infisical += 1; return { status: 1 }; }, macAutomationProbe: () => { mac += 1; return { ok: true }; } });
  assert.equal(infisical, 1);
  assert.equal(mac, 0);
  assert.match(blockers.join("\n"), /Infisical login/);
});

test("`npm run infisical:sync` is not an Infisical gate", () => {
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run infisical:sync"] }), false);
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run infisical-pull"] }), false);
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run infisical -- -- npx vitest run"] }), true);
  assert.equal(scheduler.usesInfisical({ defaultChecks: ["npm run infisical"] }), true);
});

// --- Permissions probe for a chief-of-staff run (#227) -----------------------

test("`afk preflight --cos`: a planned verb with no standing allow line exits 1 and prints the line to add", () => {
  const home = mkdtempSync(join(tmpdir(), "afk-preflight-cos-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  const run = () => spawnSync(process.execPath, [afkBin, "preflight", "--cos"], { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" });

  writeFileSync(settings, JSON.stringify({ autoMode: { allow: ["$defaults", "Running `afk cos` (any subcommand) is allowed."] } }));
  const missing = run();
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /PREFLIGHT: no standing allow line names `afk cos stop`/);
  assert.match(missing.stdout, /PREFLIGHT: no standing allow line names `afk land`/);
  assert.doesNotMatch(missing.stdout, /names `afk cos`[^ ]/, "`afk cos` is allowed and not reported");
  // The exact lines to add, as JSON strings ready to paste.
  assert.match(missing.stdout, /^ {2}"Running `afk cos stop` .*",?$/m);
  assert.match(missing.stdout, /^ {2}"Running `afk land[` ].*",?$/m);

  // The owner's file counts as well as the user's settings.
  mkdirSync(join(home, ".afk-claude", "orchestrators"), { recursive: true });
  writeFileSync(join(home, ".afk-claude", "orchestrators", "owner-settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(afk land:*)"] },
    autoMode: { allow: ["Running `afk cos stop` is allowed."] },
  }));
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PREFLIGHT: permissions ok/);
});

// --- `afk preflight --baseline`: the whole baseline gate, ahead of a launch ---
//
// Before harbour#583 the base was checked by hand with `test:e2e` alone, green,
// while `test:db` was red on `main` too. The gate ran every command and the
// epic launched five times. These hold the preflight that runs them all.

const fakeBaseline = ({ red = {} } = {}) => {
  const calls = [];
  const lockKinds = [];
  let inLock = false;
  return {
    calls,
    lockKinds,
    lock: (options, gate) => {
      lockKinds.push(options.kind);
      inLock = true;
      return Promise.resolve(gate({ lockWaitS: 0 })).finally(() => { inLock = false; });
    },
    quietHost: async () => 0,
    runChecks: async ({ commands, cwd, label }) => {
      const [command] = commands;
      calls.push({ commands, cwd, label, inLock, sawFeature: existsSync(join(cwd, "feature.txt")), sawBase: existsSync(join(cwd, "a.txt")) });
      return red[command]
        ? { ok: false, command, result: { status: 4, stdout: "", stderr: red[command] } }
        : { ok: true, skipped: [], ran: [] };
    },
  };
};

test("--baseline runs every baselineChecks command on the base in a throwaway worktree, past a red, under the gate lock", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["npm run test:e2e", "npm run test:db", "npm run lint"] });
  // The checkout sits on a feature branch: the baseline must read `main`, not it.
  git(repo, "checkout", "-qb", "feat/x");
  writeFileSync(join(repo, "feature.txt"), "not on main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "feature");
  const { calls, lockKinds, ...seams } = fakeBaseline({ red: { "npm run test:db": "line 1\nError: too many connections (max 512)\n" } });
  const report = await runBaselinePreflight({ root: repo, config: readConfig(repo), base: "main", ...seams });

  assert.deepEqual(calls.map((call) => call.commands), [["npm run test:e2e"], ["npm run test:db"], ["npm run lint"]],
    "every command runs, one at a time, and a red does not stop the rest");
  const cwd = calls[0].cwd;
  assert.notEqual(cwd, repo);
  assert.ok(calls.every((call) => call.cwd === cwd && call.inLock && call.sawBase && !call.sawFeature),
    `ran outside the lock or not on main: ${JSON.stringify(calls)}`);
  assert.deepEqual(lockKinds, ["preflight baseline"]);
  assert.equal(existsSync(cwd), false, "the throwaway worktree is removed");
  assert.doesNotMatch(git(repo, "worktree", "list"), /preflight-baseline/);

  assert.equal(report.ok, false);
  assert.deepEqual(report.results.map((entry) => [entry.command, entry.ok]),
    [["npm run test:e2e", true], ["npm run test:db", false], ["npm run lint", true]]);
  const text = renderBaselinePreflight(report);
  assert.match(text, /PREFLIGHT: baseline pass: `npm run test:e2e`/);
  assert.match(text, /PREFLIGHT: baseline FAIL \(exit 4\): `npm run test:db`\n {4}line 1\n {4}Error: too many connections \(max 512\)/);
  assert.match(text, /baseline red — 1 of 3 baselineChecks command\(s\) failed on a clean worktree of `main` @ [0-9a-f]{12}/);
});

test("--baseline reads the gate's list: baselineChecks, else defaultChecks; an empty list runs nothing", async (t) => {
  const { repo } = makeRepo(t, { maxParallel: 1, defaultChecks: ["npm test"] });
  const { calls, lockKinds: _unused, ...seams } = fakeBaseline();
  const report = await runBaselinePreflight({ root: repo, config: readConfig(repo), ...seams });
  assert.deepEqual(calls.map((call) => call.commands[0]), ["npm test"]);
  assert.equal(report.ok, true);
  assert.match(renderBaselinePreflight(report), /baseline ok — all 1 baselineChecks command\(s\) passed/);

  const none = fakeBaseline();
  const empty = await runBaselinePreflight({
    root: repo, config: { defaultChecks: ["npm test"], baselineChecks: [] }, lock: none.lock, quietHost: none.quietHost, runChecks: none.runChecks,
  });
  assert.deepEqual(none.calls, []);
  assert.deepEqual(none.lockKinds, [], "nothing to run takes no lock");
  assert.equal(empty.ok, true);
  assert.match(renderBaselinePreflight(empty), /nothing to run/);
});

test("--baseline refuses before the lock on an expired Infisical session, as the gate does", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["infisical run -- npm run test:db"] });
  const { calls, lockKinds, ...seams } = fakeBaseline();
  const report = await runBaselinePreflight({ root: repo, config: readConfig(repo), infisicalProbe: () => false, ...seams });
  assert.equal(report.ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(lockKinds, []);
  assert.match(renderBaselinePreflight(report), /PREFLIGHT: baseline: Infisical login expired: run `infisical login --domain=.*`, then rerun\. The baseline was not run\./);

  const live = fakeBaseline();
  const ok = await runBaselinePreflight({
    root: repo, config: readConfig(repo), infisicalProbe: () => true, lock: live.lock, quietHost: live.quietHost, runChecks: live.runChecks,
  });
  assert.equal(ok.ok, true);
  assert.equal(live.calls.length, 1);
});

test("--baseline on a base that does not exist says so and runs nothing", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["npm test"] });
  const { calls, lockKinds: _unused, ...seams } = fakeBaseline();
  const report = await runBaselinePreflight({ root: repo, config: readConfig(repo), base: "no-such-branch", ...seams });
  assert.equal(report.ok, false);
  assert.deepEqual(calls, []);
  assert.match(renderBaselinePreflight(report), /could not create a worktree of `no-such-branch`/);
});

test("--baseline with a worktreeSetup that fails removes the worktree and says why", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["npm test"] });
  const { calls, lockKinds: _unused, ...seams } = fakeBaseline();
  const config = { ...readConfig(repo), worktreeSetup: { run: ["echo pnpm-install-broke >&2; exit 3"] } };
  const report = await runBaselinePreflight({ root: repo, config, ...seams });
  assert.equal(report.ok, false);
  assert.deepEqual(calls, [], "nothing runs on a half-set-up worktree");
  const text = renderBaselinePreflight(report);
  assert.match(text, /worktreeSetup\.run failed/);
  assert.match(text, /pnpm-install-broke/, "the setup's own error reaches the report");
  assert.doesNotMatch(git(repo, "worktree", "list"), /preflight-baseline/, "the added worktree is removed");
});

test("--baseline copies worktreeSetup.copy files and says a red was proven on a clean worktree, not that the gate would halt", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["test -f .env"] });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n.env\n");
  git(repo, "commit", "-qam", "ignore .env");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  const { lock, quietHost } = fakeBaseline();
  const lockDir = mkdtempSync(join(tmpdir(), "afk-preflight-copy-"));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));

  const copied = await runBaselinePreflight({ root: repo, config: { ...readConfig(repo), worktreeSetup: { copy: [".env"] } }, lock, quietHost });
  assert.equal(copied.ok, true, JSON.stringify(copied));

  const bare = await runBaselinePreflight({ root: repo, config: readConfig(repo), lock, quietHost });
  assert.equal(bare.ok, false);
  const text = renderBaselinePreflight(bare);
  assert.doesNotMatch(text, /would halt/, "the root checkout the gate runs in may differ; preflight cannot claim the gate's verdict");
  assert.match(text, /baseline red — 1 of 1 baselineChecks command\(s\) failed on a clean worktree of `main` @ [0-9a-f]{12} \(gitignored files not listed in worktreeSetup\.copy are absent\)/);
});

test("--baseline waits for another epic's gate lock before running anything (#178)", async (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["npm test"] });
  const lockDir = mkdtempSync(join(tmpdir(), "afk-preflight-lock-"));
  const previous = process.env.AFK_GATE_LOCK_DIR;
  process.env.AFK_GATE_LOCK_DIR = lockDir;
  const holder = holdGateLock(join(lockDir, "gate.lock"), { ms: 1_500 });
  t.after(async () => {
    await holder.stop();
    if (previous === undefined) delete process.env.AFK_GATE_LOCK_DIR;
    else process.env.AFK_GATE_LOCK_DIR = previous;
    rmSync(lockDir, { recursive: true, force: true });
  });
  await holder.held;
  let holderGone = null;
  holder.exited.then(() => { holderGone = Date.now(); });
  const said = [];
  let ranAt = null;
  const { runChecks, quietHost } = fakeBaseline();
  const report = await runBaselinePreflight({
    root: repo, config: readConfig(repo), say: (line) => said.push(line), quietHost,
    runChecks: async (args) => { ranAt = Date.now(); return runChecks(args); },
  });
  assert.equal(report.ok, true);
  assert.match(said.join("\n"), /preflight baseline gate waiting for the gate lock held by other-repo #928/);
  assert.ok(holderGone && ranAt >= holderGone, "the checks ran while another gate held the lock");
});

test("`afk preflight --baseline` runs each command for real and exits 1 when one is red", (t) => {
  const { repo } = makeRepo(t, { ...BASE, baselineChecks: ["true", "echo 'too many connections' >&2; exit 4"] });
  const lockDir = mkdtempSync(join(tmpdir(), "afk-preflight-cli-lock-"));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${fakeClaude}:${process.env.PATH}`, AFK_GATE_LOCK_DIR: lockDir, AFK_QUIET_HOST_LOAD: "off" };
  const red = spawnSync(process.execPath, [afkBin, "preflight", "--baseline"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /PREFLIGHT: ok — every probe passed\./, "the probes still run and report");
  assert.match(red.stdout, /PREFLIGHT: baseline pass: `true`/);
  assert.match(red.stdout, /PREFLIGHT: baseline FAIL \(exit 4\): `echo 'too many connections' >&2; exit 4`\n {4}too many connections/);
  assert.match(red.stdout, /baseline red — 1 of 2/);

  const without = spawnSync(process.execPath, [afkBin, "preflight"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(without.status, 0, without.stdout + without.stderr);
  assert.doesNotMatch(without.stdout, /baseline/, "without --baseline nothing of the gate runs");

  const stray = spawnSync(process.execPath, [afkBin, "preflight", "--base=main"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(stray.status, 1);
  assert.match(stray.stdout, /--base= picks the branch `--baseline` runs on; add --baseline/);
});
