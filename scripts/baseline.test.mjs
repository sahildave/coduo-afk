import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASELINE_TIMEOUT_MS, onlyStatusFlushSince, runAuto, runBaselineChecks, sameGreenBaseline,
} from "./auto.mjs";
import { holdGateLock, readConfig, writeConfig } from "./test-helpers.mjs";
import { runCloseoutGate } from "./fixer.mjs";
import * as lib from "./lib.mjs";
// Namespaces, so a missing export fails its own test rather than the file.
import * as auto from "./auto.mjs";
import { sweepRunArtefacts } from "./sweep.mjs";
import { freePort } from "./free-port.mjs";

test("a baseline command is killed at its configured timeout and named", async () => {
  const lines = [];
  const started = Date.now();
  const result = await runBaselineChecks({
    commands: [`${process.execPath} -e "setTimeout(() => {}, 5000)"`],
    cwd: process.cwd(),
    timeoutMs: 80,
    heartbeatMs: 20,
    say: (line) => lines.push(line),
  });
  assert.equal(result.ok, false);
  assert.equal(result.result.timedOut, true);
  assert.ok(Date.now() - started < 1000, "the sub-second timeout was not enforced");
  assert.match(result.command, /setTimeout/);
});

test("a slow baseline emits heartbeat lines while it runs", async () => {
  const lines = [];
  const result = await runBaselineChecks({
    commands: [`${process.execPath} -e "setTimeout(() => {}, 90)"`],
    cwd: process.cwd(),
    timeoutMs: 1000,
    heartbeatMs: 20,
    say: (line) => lines.push(line),
  });
  assert.equal(result.ok, true);
  assert.ok(lines.some((line) => /baseline check still running/.test(line)));
});

test("the baseline timeout default is ten minutes", () => {
  assert.equal(DEFAULT_BASELINE_TIMEOUT_MS, 600_000);
});

// ---------------------------------------------------------------------------
// #145: a restart over the same head and the same commands skips the baseline.
// Epic #760 paid for three full baselines across three launches, ~28 of 160
// minutes, and nothing had been committed between the second and the third.
// ---------------------------------------------------------------------------

process.setMaxListeners(60);

const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-baseline-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

// A repo whose only task already passed, and a baseline command that counts
// its own runs in a file OUTSIDE the repo, so running it leaves the tree clean.
const baselineRepo = ({ pendingStatusUpdates, rust = false } = {}) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-baseline-skip-")));
  const counter = join(realpathSync(mkdtempSync(join(tmpdir(), "afk-baseline-count-"))), "runs");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  const command = `echo run >> ${counter}`;
  // Spelled like a project's npm script, so `isRustCheck` reads it as Rust.
  const rustCounter = `${counter}-rust`;
  const rustCommand = `echo rust:test >> ${rustCounter}`;
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: rust ? [command, rustCommand] : [command] });
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify({
    version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
    tasks: { 204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 } },
    ...(pendingStatusUpdates ? { pendingStatusUpdates } : {}),
  }));
  const count = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);
  const runs = () => count(counter);
  const rustRuns = () => count(rustCounter);
  const head = () => git("rev-parse", "HEAD").stdout.trim();
  const state = () => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
  const log = () => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
  return { repo, git, command, rustCommand, runs, rustRuns, head, state, log, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
};

const DAG = {
  epic: { id: "203", title: "Stripe subscriptions" },
  branch: "main",
  tasks: [{ id: "204", title: "task 204", dependsOn: [], checks: ["true"], allowedPaths: ["**"] }],
};

// A solo `node --test` run gets no isolation from `afk.mjs selftest`, so the
// machine-wide state a start touches is moved to temp paths here: the gate lock
// (a real epic's gate would hold this test up), and the transcripts and lanes
// cache the dashboard's warm-up reads and rewrites, and the chief of staff
// store, where a run without a dashboard records its root for the hub (#279).
const ISOLATED = ["AFK_GATE_LOCK_DIR", "AFK_TRANSCRIPTS_ROOT", "AFK_LANES_CACHE", "AFK_COS_ROOT"];

const start = async (repo, config = readConfig(repo), extra = {}, { port } = {}) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  const previous = Object.fromEntries(ISOLATED.map((key) => [key, process.env[key]]));
  const scratch = mkdtempSync(join(tmpdir(), "afk-baseline-env-"));
  process.env.AFK_GATE_LOCK_DIR ??= join(scratch, "gate-lock");
  process.env.AFK_TRANSCRIPTS_ROOT ??= join(scratch, "transcripts");
  process.env.AFK_LANES_CACHE ??= join(scratch, "lanes-cache.json");
  process.env.AFK_COS_ROOT ??= join(scratch, "cos");
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(port ?? (await freePort()));
  try {
    return await runAuto({
      config, dag: DAG, root: repo, interactive: false,
      // A quiet host unless a test says otherwise: the real load is not this suite's.
      hostLoad: () => 0,
      verify: async () => ({ version: 1, status: "ok", summary: "Reviewed.", criteria: [], findings: [], mustFix: [], problems: [], outstanding: [] }),
      commentOnEpic: () => ({ status: 0 }),
      ...extra,
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
};

test("a cold start runs the baseline and records the green head and commands (#145)", async () => {
  const fx = baselineRepo();
  try {
    const head = fx.head();
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "no record, so the baseline ran");
    assert.equal(fx.state().lastGreenBaseline.headSha, head);
    assert.deepEqual(fx.state().lastGreenBaseline.commands, [fx.command]);
  } finally {
    fx.cleanup();
  }
});

test("a dashboard that cannot start does not stop the epic: one warning, then the baseline", async () => {
  const fx = baselineRepo();
  // Something that is not a dashboard holds the port on 127.0.0.1: /health
  // answers 404, so the probe calls it free, and the spawned dashboard, bound
  // to the same 127.0.0.1, fails to bind and exits 98. The port was named, so
  // there is no walk: the start fails as a bind failure, not a /health timeout.
  const squatter = createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((done) => squatter.listen(0, "127.0.0.1", done));
  try {
    // The baseline also snapshots state.json mid-run: the run clears its
    // dashboard fields when it ends, and the snapshot is what `afk start` saw.
    const snapshot = join(fx.repo, "state-mid-run.json");
    const config = readConfig(fx.repo);
    config.baselineChecks = [...config.baselineChecks, `cp .afk/state.json ${snapshot}`];
    const code = await start(fx.repo, config, {}, { port: squatter.address().port });
    assert.equal(code, 0, fx.log());
    assert.equal(fx.runs(), 1, "the baseline ran");
    assert.match(fx.log(), /warning: the dashboard did not start; carrying on without it\. Dashboard failed to start on http:\/\/127\.0\.0\.1:\d+; see .*dashboard\.log/);
    assert.doesNotMatch(fx.log(), /did not answer \/health/);
    // The signal `afk start` reads as "the run is up" when no dashboard is.
    const midRun = JSON.parse(readFileSync(snapshot, "utf8"));
    assert.match(midRun.dashboardSkipped?.reason ?? "", /Dashboard failed to start/);
    assert.equal(midRun.dashboard, null);
    assert.equal(fx.state().dashboardSkipped, undefined, "the ended run left dashboardSkipped behind");
  } finally {
    squatter.close();
    fx.cleanup();
  }
});

test("an Infisical refusal before the baseline leaves no dashboardSkipped behind for `afk start` to read as up", async () => {
  const fx = baselineRepo();
  // The same 127.0.0.1 squatter as above, so the dashboard start fails and the
  // run records dashboardSkipped. Then the gate's Infisical probe refuses.
  const squatter = createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((done) => squatter.listen(0, "127.0.0.1", done));
  try {
    const config = readConfig(fx.repo);
    config.baselineChecks = [...config.baselineChecks, "infisical run -- true"];
    const code = await start(fx.repo, config, {
      // Live at preflight, gone by the baseline gate.
      preflightProbeOverrides: { infisicalProbe: () => ({ status: 0 }) },
      infisicalProbe: () => false,
    }, { port: squatter.address().port });
    assert.equal(code, 1, fx.log());
    assert.match(fx.log(), /warning: the dashboard did not start; carrying on without it/, "fixture precondition: the dashboard start failed");
    assert.match(fx.log(), /baseline gate not run; no builders were spawned/, "fixture precondition: the Infisical refusal ran");
    assert.equal(fx.runs(), 0);
    const state = fx.state();
    assert.equal(state.dashboardSkipped, undefined, "the refused run left dashboardSkipped behind");
    assert.equal(state.dashboard ?? null, null, "the refused run left a dashboard behind");
  } finally {
    squatter.close();
    fx.cleanup();
  }
});

test("a throw between the dashboard step and the scheduler clears every field `afk start` reads as up (#279)", async () => {
  const fx = baselineRepo();
  // The same 127.0.0.1 squatter, so the run records dashboardSkipped; then the
  // baseline gate throws instead of returning a verdict.
  const squatter = createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((done) => squatter.listen(0, "127.0.0.1", done));
  try {
    await assert.rejects(
      start(fx.repo, readConfig(fx.repo), {
        baselineGate: async () => { throw new Error("the gate could not run"); },
      }, { port: squatter.address().port }),
      /the gate could not run/,
    );
    assert.match(fx.log(), /warning: the dashboard did not start; carrying on without it/, "fixture precondition: the dashboard start failed");
    const state = fx.state();
    assert.equal("dashboardSkipped" in state, false, "the thrown run left dashboardSkipped behind");
    assert.equal(state.dashboard ?? null, null, "the thrown run left a dashboard behind");
    assert.equal(state.orchestratorPid ?? null, null, "the thrown run left its pid behind");
  } finally {
    squatter.close();
    fx.cleanup();
  }
});

test("a run without a dashboard is in the machine's no-dashboard record while it runs, and off it after (#279)", async () => {
  const fx = baselineRepo();
  const squatter = createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((done) => squatter.listen(0, "127.0.0.1", done));
  const cos = mkdtempSync(join(tmpdir(), "afk-baseline-cos-"));
  const previous = process.env.AFK_COS_ROOT;
  process.env.AFK_COS_ROOT = cos;
  try {
    // As the dashboard-start test copies state.json: what the hub read mid-run.
    const record = join(cos, "no-dashboard.json");
    const snapshot = join(fx.repo, "record-mid-run.json");
    const config = readConfig(fx.repo);
    config.baselineChecks = [...config.baselineChecks, `cp ${record} ${snapshot}`];
    const code = await start(fx.repo, config, {}, { port: squatter.address().port });
    assert.equal(code, 0, fx.log());
    assert.match(fx.log(), /warning: the dashboard did not start; carrying on without it/, "fixture precondition: the dashboard start failed");
    assert.deepEqual(JSON.parse(readFileSync(snapshot, "utf8")), [fx.repo]);
    assert.equal(JSON.parse(readFileSync(record, "utf8")).includes(fx.repo), false, "the ended run left its root in the record");
  } finally {
    if (previous === undefined) delete process.env.AFK_COS_ROOT;
    else process.env.AFK_COS_ROOT = previous;
    rmSync(cos, { recursive: true, force: true });
    squatter.close();
    fx.cleanup();
  }
});

test("a restart at the same head with the same commands skips the baseline and says so (#145)", async () => {
  const fx = baselineRepo();
  try {
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1);
    const green = fx.state().lastGreenBaseline.headSha;
    assert.equal(fx.head(), green, "fixture precondition: the first run left the head where it went green");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "the second start re-ran a baseline nothing had changed");
    assert.match(fx.log(), /baseline check skipped — it went green at [0-9a-f]{12} with these 1 command\(s\)/);
  } finally {
    fx.cleanup();
  }
});

test("the runner's own status commit between two starts does not cost a second baseline (#145)", async () => {
  // #760's actual pattern: every run that decides anything ends by committing
  // the progress table, so the next start's head is never the head that went
  // green. Keyed on the sha alone, the skip never fired.
  const fx = baselineRepo({ pendingStatusUpdates: { 204: "passed" } });
  try {
    const green = fx.head();
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1);
    assert.notEqual(fx.head(), green, "fixture precondition: the first run committed its status flush");
    assert.deepEqual(
      fx.git("diff", "--name-only", green, "HEAD").stdout.trim().split("\n"),
      ["docs/progress/203.md"],
      "fixture precondition: and nothing else",
    );
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "a status-flush commit re-ran the baseline");
    assert.match(fx.log(), /baseline check skipped — .*only the runner's status commits have landed since/);
  } finally {
    fx.cleanup();
  }
});

test("a moved head or a changed check list still runs the baseline (#145)", async () => {
  const fx = baselineRepo();
  try {
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1);

    writeFileSync(join(fx.repo, "more.txt"), "a commit after the green baseline\n");
    fx.git("add", ".");
    fx.git("commit", "-m", "moved");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 2, "the head moved, so the baseline ran");

    // Same head as the green record, one more command: handed to this start
    // directly, because committing the config would move the head too.
    assert.equal(fx.state().lastGreenBaseline.headSha, fx.head());
    await start(fx.repo, { ...readConfig(fx.repo), baselineChecks: [fx.command, "true"] });
    assert.equal(fx.runs(), 3, "the check list changed, so the baseline ran");
  } finally {
    fx.cleanup();
  }
});

test("sameGreenBaseline matches only a recorded sha and an identical command list", () => {
  const record = { headSha: "abc", commands: ["npm test", "npm run lint"], at: "t" };
  assert.equal(sameGreenBaseline(record, { headSha: "abc", commands: ["npm test", "npm run lint"] }), true);
  assert.equal(sameGreenBaseline(undefined, { headSha: "abc", commands: ["npm test"] }), false, "cold start");
  assert.equal(sameGreenBaseline(record, { headSha: "def", commands: record.commands }), false, "moved head");
  assert.equal(sameGreenBaseline(record, { headSha: "abc", commands: ["npm test"] }), false, "changed commands");
  assert.equal(sameGreenBaseline({ ...record, headSha: null }, { headSha: null, commands: record.commands }), false, "no git");
  const flushOnly = (from, to) => from === "abc" && to === "def";
  assert.equal(sameGreenBaseline(record, { headSha: "def", commands: record.commands }, flushOnly), true, "status commits only");
});

test("onlyStatusFlushSince passes status commits only, and fails closed on anything else", () => {
  const fx = baselineRepo();
  try {
    const commit = (path, text) => {
      mkdirSync(join(fx.repo, path, ".."), { recursive: true });
      writeFileSync(join(fx.repo, path), text);
      fx.git("add", "-f", path);
      fx.git("commit", "-m", path);
      return fx.head();
    };
    const base = fx.head();
    assert.equal(onlyStatusFlushSince(fx.repo, base, base), true, "same commit");
    const flushed = commit("docs/progress/203.md", "| 204 | passed |\n");
    const ledger = commit(".afk/ledger.jsonl", "{}\n");
    assert.equal(onlyStatusFlushSince(fx.repo, base, ledger), true, "progress table, then ledger");
    const real = commit("src/app.js", "export {};\n");
    assert.equal(onlyStatusFlushSince(fx.repo, base, real), false, "a real commit");
    assert.equal(onlyStatusFlushSince(fx.repo, real, flushed), false, "not an ancestor");
    assert.equal(onlyStatusFlushSince(fx.repo, null, real), false, "no record");
    // `git log --name-only` names only a rename's destination, so moving a
    // source file under `.afk/` read as a status commit.
    fx.git("mv", "src/app.js", ".afk/app.js");
    fx.git("commit", "-m", "move a source file into .afk");
    assert.equal(onlyStatusFlushSince(fx.repo, real, fx.head()), false, "a rename out of the source tree");
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #176 W2: a green closeout fix gate counts as a green baseline. It runs the
// same command list over the fixer's commit and used to record nothing the
// next start read, so a relaunch re-ran the whole baseline over a tree the
// gate had just passed. Read from `gate.json` itself — the record the fixer
// already keys its own reuse on — not copied into a second record.
// ---------------------------------------------------------------------------

const commitFile = (fx, path, text) => {
  mkdirSync(join(fx.repo, path, ".."), { recursive: true });
  writeFileSync(join(fx.repo, path), text);
  fx.git("add", "-f", path);
  fx.git("commit", "-m", path);
  return fx.head();
};

// The fixer's commit, then its gate, exactly as the closeout runs them.
const passFixGate = async (fx, path = "src/fixed.js") => {
  const headBefore = fx.head();
  commitFile(fx, path, "export const fixed = true;\n");
  const gate = await runCloseoutGate({
    root: fx.repo,
    config: readConfig(fx.repo),
    epicId: "203",
    headBefore,
    runChecks: ({ commands, cwd }) => runBaselineChecks({ commands, cwd, say: () => {} }),
  });
  assert.equal(gate.status, "passed", "fixture precondition: the fix gate went green");
  assert.equal(gate.fixSha, fx.head());
  return gate;
};

test("a relaunch at the head a closeout fix gate passed skips the baseline (#176 W2)", async () => {
  const fx = baselineRepo();
  try {
    await passFixGate(fx);
    assert.equal(fx.runs(), 1, "fixture precondition: the gate ran the chain once");
    assert.equal(fx.state().lastGreenBaseline, undefined, "fixture precondition: no baseline has ever gone green");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "the baseline re-ran over the tree the fix gate had just passed");
    assert.match(fx.log(), /baseline check skipped — the closeout fix gate went green at [0-9a-f]{12}/);
  } finally {
    fx.cleanup();
  }
});

test("the runner's own artefact sweep after a green fix gate does not cost a baseline (#176 W2)", async () => {
  const fx = baselineRepo();
  try {
    await passFixGate(fx, ".agents/evidence/204/01-after.png");
    const swept = sweepRunArtefacts({ root: fx.repo, epicId: "203", ids: ["204"] });
    assert.ok(swept.commit, "fixture precondition: the sweep committed");
    assert.deepEqual(
      fx.git("show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n"),
      [".agents/evidence/204/01-after.png"],
      "fixture precondition: the sweep commit touches only .agents/evidence/",
    );
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "the runner's own sweep commit re-ran the baseline");
    assert.match(fx.log(), /baseline check skipped — .*only the runner's status commits have landed since/);
  } finally {
    fx.cleanup();
  }
});

test("a red fix gate, or a real commit after a green one, still runs the baseline (#176 W2)", async () => {
  const fx = baselineRepo();
  try {
    await passFixGate(fx);
    commitFile(fx, "src/later.js", "export {};\n");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 2, "a real commit after the gate must run the baseline");
  } finally {
    fx.cleanup();
  }
  const red = baselineRepo();
  try {
    const headBefore = red.head();
    commitFile(red, "src/fixed.js", "export {};\n");
    const gate = await runCloseoutGate({
      root: red.repo, config: readConfig(red.repo), epicId: "203", headBefore,
      runChecks: async () => ({ ok: false, command: red.command, result: { status: 1, stdout: "", stderr: "" } }),
    });
    assert.equal(gate.status, "failed");
    assert.equal(await start(red.repo), 0);
    assert.equal(red.runs(), 1, "a red fix gate is no green baseline");
  } finally {
    red.cleanup();
  }
});

test("onlyStatusFlushSince keeps its own path list unless the caller widens it (#176 W2)", () => {
  // The baseline skip widens it with the sweep's paths; branch deletion and
  // stale evidence (wave.mjs, verifier.mjs) read `isStatusFlushPath` directly
  // and must not see `.agents/evidence/` as bookkeeping.
  const fx = baselineRepo();
  try {
    const base = fx.head();
    const swept = commitFile(fx, ".agents/evidence/204/01.png", "png");
    assert.equal(onlyStatusFlushSince(fx.repo, base, swept), false, "the default predicate is unchanged");
    assert.equal(onlyStatusFlushSince(fx.repo, base, swept, auto.isBaselineInertPath), true, "the baseline's predicate admits the sweep");
    assert.equal(lib.isStatusFlushPath(".agents/evidence/204/01.png"), false);
    assert.equal(auto.isBaselineInertPath("src/app.js"), false);
    assert.equal(auto.isBaselineInertPath("docs/progress/203.md"), true);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #176 W3: a baseline skips the Rust checks when nothing Rust-relevant changed
// since the last green baseline. Lanes already did; baselines never did.
// ---------------------------------------------------------------------------

test("a baseline skips the Rust checks only when nothing Rust-relevant changed since the last green (#176 W3)", async () => {
  const fx = baselineRepo({ rust: true });
  try {
    // No prior green: everything runs.
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1);
    assert.equal(fx.rustRuns(), 1, "with no prior green the Rust checks must run");

    // A frontend-only commit: the Rust check is recorded as skipped, with why.
    commitFile(fx, "src/app.js", "export {};\n");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 2, "the non-Rust check still runs");
    assert.equal(fx.rustRuns(), 1, "nothing Rust-relevant changed, so the Rust check must not run");
    const skipped = fx.state().lastGreenBaseline.skipped;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].command, fx.rustCommand);
    assert.equal(skipped[0].skipped, true);
    assert.equal(skipped[0].code, null);
    assert.match(skipped[0].reason, /no Rust-relevant change since the green baseline at [0-9a-f]{12}/);
    assert.match(fx.log(), /baseline check skipped: echo rust:test .* — no Rust-relevant change/);

    // `.cargo/config.toml` is Rust-relevant though `isRustPath` does not list it.
    commitFile(fx, ".cargo/config.toml", "[build]\n");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.rustRuns(), 2, "a .cargo/ change must run the Rust checks");
  } finally {
    fx.cleanup();
  }
});

test("baselineRustRelevant covers .cargo, the toolchain, rust:* script files and rust:* script text (#176 W3)", () => {
  const scripts = { "rust:test": "cd src-tauri && cargo test", "rust:build": "bash ./scripts/build-sidecar.sh --release", lint: "eslint ." };
  const relevant = (changed, before = scripts, after = scripts) => lib.baselineRustRelevant({ changed, scriptsBefore: before, scriptsAfter: after });
  assert.equal(relevant(["src/app.ts", "README.md"]), false);
  assert.equal(relevant(["src-tauri/src/main.rs"]), true, "isRustPath");
  assert.equal(relevant(["crates/x/Cargo.toml"]), true, "isRustPath");
  assert.equal(relevant([".cargo/config.toml"]), true);
  assert.equal(relevant(["rust-toolchain.toml"]), true);
  assert.equal(relevant(["rust-toolchain"]), true);
  assert.equal(relevant(["scripts/build-sidecar.sh"]), true, "a script a rust:* script invokes");
  assert.equal(relevant(["package.json"]), false, "package.json changed, rust:* scripts did not");
  assert.equal(relevant(["package.json"], scripts, { ...scripts, "rust:test": "cargo test --workspace" }), true, "rust:* text changed");
  assert.equal(relevant(["package.json"], scripts, { ...scripts, "rust:new": "cargo doc" }), true, "rust:* script added");
  assert.equal(relevant(["package.json"], null, scripts), true, "unreadable before: fail toward running");
});

test("the baseline waits for another epic's gate lock and records the wait (#178)", async () => {
  const fx = baselineRepo();
  const lockDir = mkdtempSync(join(tmpdir(), "afk-gate-lock-baseline-"));
  const previous = process.env.AFK_GATE_LOCK_DIR;
  process.env.AFK_GATE_LOCK_DIR = lockDir;
  let holder = null;
  try {
    holder = holdGateLock(join(lockDir, "gate.lock"));
    await holder.held;
    // Released ~1.2s after the baseline is seen waiting: the start's own setup
    // takes seconds, so a timed holder can be gone before the baseline begins.
    const logPath = join(fx.repo, ".afk", "agent-auto.log");
    const watch = setInterval(() => {
      if (existsSync(logPath) && readFileSync(logPath, "utf8").includes("waiting for the gate lock")) {
        clearInterval(watch);
        setTimeout(() => holder.kill("SIGTERM"), 1_200);
      }
    }, 50);
    watch.unref();
    const code = await start(fx.repo);
    clearInterval(watch);
    assert.equal(code, 0);
    assert.equal(fx.runs(), 1, "the baseline never ran");
    assert.match(fx.log(), /baseline gate waiting for the gate lock held by other-repo #928 \(baseline, pid \d+, since /);
    const events = readFileSync(join(fx.repo, ".afk", "runs", "gate-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const baseline = events.find((event) => event.kind === "baseline");
    assert.ok(baseline.lockWaitS >= 1, `the baseline event did not carry the wait: ${JSON.stringify(baseline)}`);
  } finally {
    await holder?.stop();
    if (previous === undefined) delete process.env.AFK_GATE_LOCK_DIR;
    else process.env.AFK_GATE_LOCK_DIR = previous;
    fx.cleanup();
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #223: a relaunch's baseline waits like a first launch, and skips over merges
// ---------------------------------------------------------------------------

/** Green once, then a real commit, so the next start is a relaunch that must run. */
const relaunchThatRuns = async (fx) => {
  assert.equal(await start(fx.repo), 0);
  assert.equal(fx.runs(), 1);
  writeFileSync(join(fx.repo, "more.txt"), "a commit after the green baseline\n");
  fx.git("add", ".");
  fx.git("commit", "-m", "moved");
};

test("a relaunch's baseline waits for another epic's gate lock (#223)", async () => {
  const fx = baselineRepo();
  const lockDir = mkdtempSync(join(tmpdir(), "afk-gate-lock-relaunch-"));
  const previous = process.env.AFK_GATE_LOCK_DIR;
  process.env.AFK_GATE_LOCK_DIR = lockDir;
  let holder = null;
  try {
    await relaunchThatRuns(fx);
    holder = holdGateLock(join(lockDir, "gate.lock"), { holder: { project: "atlas", epic: "1184", kind: "integration" } });
    await holder.held;
    const logPath = join(fx.repo, ".afk", "agent-auto.log");
    const before = readFileSync(logPath, "utf8").length;
    const watch = setInterval(() => {
      if (readFileSync(logPath, "utf8").slice(before).includes("waiting for the gate lock")) {
        clearInterval(watch);
        setTimeout(() => holder.kill("SIGTERM"), 1_200);
      }
    }, 50);
    watch.unref();
    const code = await start(fx.repo);
    clearInterval(watch);
    assert.equal(code, 0);
    assert.equal(fx.runs(), 2, "the relaunch ran its baseline");
    assert.match(fx.log().slice(before), /baseline gate waiting for the gate lock held by atlas #1184 \(integration, pid \d+/);
    const events = readFileSync(join(fx.repo, ".afk", "runs", "gate-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.filter((event) => event.kind === "baseline").at(-1).lockWaitS >= 1, "the relaunch's event carries the wait");
  } finally {
    await holder?.stop();
    if (previous === undefined) delete process.env.AFK_GATE_LOCK_DIR;
    else process.env.AFK_GATE_LOCK_DIR = previous;
    fx.cleanup();
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("a relaunch's baseline waits for load under the threshold before it starts (#223)", async () => {
  const fx = baselineRepo();
  const previous = process.env.AFK_QUIET_HOST_LOAD;
  try {
    await relaunchThatRuns(fx);
    process.env.AFK_QUIET_HOST_LOAD = "20";
    let reads = 0;
    let runsWhileBusy = null;
    const hostLoad = () => {
      reads += 1;
      if (reads === 3) runsWhileBusy = fx.runs();
      return reads <= 3 ? 24 : 4;
    };
    assert.equal(await start(fx.repo, readConfig(fx.repo), { hostLoad, quietPollMs: 10 }), 0);
    assert.equal(runsWhileBusy, 1, "the baseline started while the host was busy");
    assert.equal(fx.runs(), 2);
    assert.match(fx.log(), /baseline gate waiting for a quiet host: load 24\.0, threshold 20/);
    assert.match(fx.log(), /baseline gate: the host is quiet \(load 4\.0\) after \d+s/);
  } finally {
    if (previous === undefined) delete process.env.AFK_QUIET_HOST_LOAD;
    else process.env.AFK_QUIET_HOST_LOAD = previous;
    fx.cleanup();
  }
});

/** A task branch merged `--no-ff` onto the head, as `runIntegration` lands one. */
const integrateTask = (fx, id) => {
  fx.git("checkout", "-q", "-b", `afk/task-${id}`);
  writeFileSync(join(fx.repo, `task-${id}.txt`), `task ${id}'s work\n`);
  fx.git("add", ".");
  fx.git("commit", "-q", "-m", `task ${id}`);
  fx.git("checkout", "-q", "main");
  fx.git("merge", "--no-ff", "--no-edit", "-q", "-m", `Merge task ${id}`, `afk/task-${id}`);
  return fx.head();
};

const recordIntegrated = (fx, id, integratedHead) => {
  const path = join(fx.repo, ".afk", "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.tasks[id] = { ...(state.tasks[id] ?? {}), lifecycle: "passed", integratedHead };
  writeFileSync(path, JSON.stringify(state));
};

test("a relaunch whose tree differs from the green baseline only by integrated task merges skips it (#223)", async () => {
  const fx = baselineRepo({ pendingStatusUpdates: { 204: "passed" } });
  try {
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1);
    const green = fx.state().lastGreenBaseline.headSha;
    recordIntegrated(fx, "204", integrateTask(fx, "204"));
    // And a runner status commit on top, as `flushStatuses` writes one.
    mkdirSync(join(fx.repo, "docs", "progress"), { recursive: true });
    writeFileSync(join(fx.repo, "docs", "progress", "203.md"), "# progress\n204 passed\n");
    fx.git("add", "docs/progress/203.md");
    fx.git("commit", "-q", "-m", "chore(afk): status");
    assert.notEqual(fx.head(), green, "fixture precondition: the head moved past the green baseline");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 1, "an integrated merge re-ran the baseline");
    assert.match(fx.log(), /baseline check skipped — it went green at [0-9a-f]{12} .*only integrated task merges \(204\) and the runner's status commits have landed since/);
  } finally {
    fx.cleanup();
  }
});

test("a merge no passed task integrated, or a commit after an integrated merge, still runs the baseline (#223)", async () => {
  const fx = baselineRepo();
  try {
    assert.equal(await start(fx.repo), 0);
    integrateTask(fx, "204");
    // Merged, but state names no integration for it: not the runner's merge.
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 2, "an unrecorded merge skipped the baseline");

    recordIntegrated(fx, "204", integrateTask(fx, "205"));
    writeFileSync(join(fx.repo, "hand-edit.txt"), "a real commit after the merge\n");
    fx.git("add", ".");
    fx.git("commit", "-q", "-m", "hand edit");
    assert.equal(await start(fx.repo), 0);
    assert.equal(fx.runs(), 3, "a real commit after an integrated merge skipped the baseline");
  } finally {
    fx.cleanup();
  }
});
