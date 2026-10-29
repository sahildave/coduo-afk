// scripts/closeout-gate.test.mjs — the gate over the closeout fix pass's commit.
//
// Issue #78, measured on `owner/quillnote` wave-34 (2026-09-04, the last
// wave of the night). A wave runs lanes, passes their gates, integrates,
// reviews — and then the fix pass commits. That commit is the branch tip and no
// check in the wave ever ran over it: wave-34's five gates ran at `f2e2fa1`,
// the merge two commits below `18cdd44`. Normally the next wave's baseline
// covers it within minutes. The last wave of a run has no next wave.
//
// Three layers, in dependence order:
//
//   1. `runCloseoutGate` itself — does the chain run, and only when HEAD moved.
//   2. `runAuto`'s close actually reaching it, with the fixer's agent injected
//      so the pass produces a real commit without an agent call.
//   3. the wave digest saying which way it went, over the two-wave fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeoutGatePath,
  readCloseoutGate,
  runCloseoutGate,
} from "./fixer.mjs";
import { runAuto } from "./auto.mjs";
import { measurePath } from "./measure.mjs";
import { renderCloseoutGateLine, renderDigest } from "./wave-driver.mjs";
import { cliWaveRun } from "./wave.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import { freePort } from "./free-port.mjs";

// Each runAuto below installs its own exit/signal handlers.
process.setMaxListeners(60);

const gitIn = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

const headOf = (cwd) => gitIn(cwd, "rev-parse", "HEAD").trim();

const seedRepo = (root) => {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "one\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "one");
  return root;
};

// ---------------------------------------------------------------------------
// 1. The gate itself
// ---------------------------------------------------------------------------

test("the chain re-runs over the fix pass's commit and the record names that sha", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);

  // The fix pass, as prompts/fixer.md step 4 leaves the tree: a commit.
  writeFileSync(join(root, "repair.txt"), "repaired\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "fix: closeout findings for #wave-34");
  const fixSha = headOf(root);

  const seen = [];
  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["swift build", "swift test"] },
    epicId: "wave-34",
    headBefore: before,
    runChecks: async ({ commands, cwd }) => {
      seen.push({ commands, cwd });
      return { ok: true };
    },
  });

  assert.equal(gate.status, "passed");
  assert.equal(gate.fixSha, fixSha, "the gate must record WHICH commit it checked");
  assert.equal(gate.headBefore, before);
  assert.deepEqual(gate.checks, ["swift build", "swift test"]);
  assert.deepEqual(seen, [{ commands: ["swift build", "swift test"], cwd: root }]);
  // On disk, next to the fix report, so the wave can read it before archiving.
  assert.deepEqual(JSON.parse(readFileSync(closeoutGatePath(root, "wave-34"), "utf8")), gate);
  assert.deepEqual(readCloseoutGate(root, "wave-34"), gate);
  assert.match(renderCloseoutGateLine(gate), /gated: \*\*yes\*\*/);
  assert.match(renderCloseoutGateLine(gate), new RegExp(fixSha));
});

test("a fix pass that committed nothing costs no checks at all", async (t) => {
  // The cost control the issue asks for: "run it only when the fix pass actually
  // committed something — most closeouts commit nothing". A tip that has not
  // moved is still the commit the wave's own gates ran over, and re-running them
  // would buy a second identical green per wave.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-noop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);

  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["swift test"] },
    epicId: "wave-01",
    headBefore: before,
    runChecks: async () => assert.fail("no commit, so nothing may be re-run"),
  });

  assert.equal(gate.status, "no_commit");
  assert.equal(gate.fixSha, null);
  assert.equal(gate.head, before);
  assert.deepEqual(gate.checks, []);
  // Recorded either way — "gated: n/a" is a fact about the wave, not silence.
  assert.equal(existsSync(closeoutGatePath(root, "wave-01")), true);
  assert.match(renderCloseoutGateLine(gate), /committed nothing/);
});

test("with a lighter `integrationChecks`, an unmoved tip still gets the full chain", async (t) => {
  // `no_commit` is only free because the last integration ran the full chain
  // over the tip. A project that set `integrationChecks` to something lighter
  // has no full gate anywhere after the baseline unless this one runs, and its
  // pre-push e2e proof has no tree to stand on.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-light-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);
  const seen = [];

  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["pnpm run check", "pnpm run test:e2e"], integrationChecks: ["tsc"] },
    epicId: "545",
    headBefore: before,
    runChecks: async (args) => { seen.push(args); return { ok: true }; },
  });

  assert.equal(gate.status, "passed");
  assert.equal(gate.fixSha, before);
  assert.deepEqual(seen, [{ commands: ["pnpm run check", "pnpm run test:e2e"], cwd: root }]);
  // Not "re-run over the fix commit": there is none, and the line says why it ran.
  assert.match(renderCloseoutGateLine(gate), /gated: \*\*yes\*\*/);
  assert.match(renderCloseoutGateLine(gate), /integrationChecks/);
  assert.doesNotMatch(renderCloseoutGateLine(gate), /fix pass/);
});

test("a re-close after only status commits reuses the tip gate instead of re-running it", async (t) => {
  // The runner commits task status between a close and a re-close (a restart,
  // --redo-close). Under `integrationChecks` an unmoved tip runs the full chain,
  // so without this tolerance every re-close paid it again for no new code.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-reclose-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const config = { baselineChecks: ["pnpm run check"], integrationChecks: ["tsc"] };
  let runs = 0;
  const runChecks = async () => { runs += 1; return { ok: true }; };
  const first = await runCloseoutGate({ root, config, epicId: "545", headBefore: headOf(root), runChecks });
  assert.equal(first.status, "passed");
  mkdirSync(join(root, "docs", "progress"), { recursive: true });
  writeFileSync(join(root, "docs", "progress", "545.md"), "status\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "afk: update task status");

  const again = await runCloseoutGate({ root, config, epicId: "545", headBefore: headOf(root), runChecks });
  assert.equal(runs, 1, "the status commit added no code, so the chain is not re-run");
  assert.equal(again.status, "passed");
});

test("an `integrationChecks` that already holds the full chain adds no closeout run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-gate-same-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["swift test"], integrationChecks: ["swift test", "swift build"] },
    epicId: "wave-02",
    headBefore: headOf(root),
    runChecks: async () => assert.fail("integration already ran every baseline command over the tip"),
  });
  assert.equal(gate.status, "no_commit");
});

test("a red chain is recorded loudly and still returns — it never sinks the close", async (t) => {
  // FAIL DIRECTION, asserted rather than described. `runCloseoutFixer`'s
  // contract is that the fix pass never throws and never changes the epic's
  // outcome; a gate that could throw would break it, and would hand the fixer
  // the lifecycle authority docs/epic-schema.md refuses it.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-red-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);
  writeFileSync(join(root, "repair.txt"), "repaired\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "fix: closeout findings");

  const gate = await runCloseoutGate({
    root,
    config: { defaultChecks: ["swift test"] },
    epicId: "wave-34",
    headBefore: before,
    runChecks: async () => ({
      ok: false,
      command: "swift test",
      result: { status: 1, stdout: "AppearanceContrastTests failed\n", stderr: "" },
    }),
  });

  assert.equal(gate.status, "failed");
  assert.equal(gate.failingCommand, "swift test");
  assert.equal(gate.failingCode, 1);
  assert.match(gate.output, /AppearanceContrastTests failed/);
  assert.match(renderCloseoutGateLine(gate), /gated: \*\*yes\*\*, and it FAILED/);
});

test("a chain that could not run leaves an `unavailable` record on disk, not silence", async (t) => {
  // The one case #78's criterion names that fell on the unsafe side. An
  // unavailable gate was set into `close.fixGate` in state and never written to
  // `gate.json` — and the wave digest reads `gate.json` and nothing else, so
  // `readCloseoutGate` returned null and the digest printed "n/a — no fix pass
  // ran" over a tip that ran a pass and gated none of it.
  const root = mkdtempSync(join(tmpdir(), "afk-gate-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);
  writeFileSync(join(root, "repair.txt"), "repaired\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "fix: closeout findings");
  const fixSha = headOf(root);

  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: ["swift test"] },
    epicId: "wave-34",
    headBefore: before,
    runChecks: async () => { throw new Error("xcodebuild is not installed"); },
  });

  assert.equal(gate.status, "unavailable");
  assert.equal(gate.problem, "xcodebuild is not installed");
  assert.equal(gate.fixSha, fixSha, "the commit nothing checked must still be named");
  // The assertion that matters: on disk, where the digest looks.
  assert.equal(existsSync(closeoutGatePath(root, "wave-34")), true);
  assert.deepEqual(readCloseoutGate(root, "wave-34"), gate);
  const line = renderCloseoutGateLine(readCloseoutGate(root, "wave-34"));
  assert.match(line, /gated: \*\*no\*\*/);
  assert.match(line, /xcodebuild is not installed/);
  // And it never reads as the "no fix pass ran" line, which is a different claim.
  assert.equal(line.includes("no fix pass ran"), false);
});

test("a project with no chain reports an ungated tip, never an empty green", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-gate-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);
  writeFileSync(join(root, "repair.txt"), "x\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "fix: closeout findings");

  const gate = await runCloseoutGate({
    root,
    config: { baselineChecks: [] },
    epicId: "wave-34",
    headBefore: before,
    runChecks: async () => assert.fail("there is no chain to run"),
  });
  assert.equal(gate.status, "unavailable");
  assert.equal(gate.fixSha, headOf(root));
  assert.match(renderCloseoutGateLine(gate), /gated: \*\*no\*\*/);
});

test("a close that happens twice does not re-run the chain over a commit it already gated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-gate-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRepo(root);
  const before = headOf(root);
  writeFileSync(join(root, "repair.txt"), "x\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "fix: closeout findings");

  let runs = 0;
  const args = {
    root,
    config: { baselineChecks: ["swift test"] },
    epicId: "wave-34",
    headBefore: before,
    runChecks: async () => { runs += 1; return { ok: true }; },
  };
  const first = await runCloseoutGate(args);
  const again = await runCloseoutGate(args);
  assert.equal(runs, 1, "a restart must not re-pay for a commit already gated");
  assert.equal(again.ranAt, first.ranAt);
});

// ---------------------------------------------------------------------------
// 2. `runAuto`'s close reaching the gate
// ---------------------------------------------------------------------------

const gateHeadsTail = (heads) => heads[heads.length - 1] ?? null;


const fakeClaude = (() => {
  // The auth preflight is the only agent this file spawns through PATH: the
  // task is pre-seeded passed and the verifier and fixer are both injected.
  const bin = mkdtempSync(join(tmpdir(), "afk-gate-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

const verifierReport = (over = {}) => ({
  version: 1,
  status: "ok",
  summary: "It shipped.",
  criteria: [],
  findings: [],
  mustFix: [],
  problems: [],
  ranAt: "2026-09-04T01:00:00.000Z",
  head: "aaaa111",
  branch: "feat/203-stripe",
  baseBranch: "main",
  artifacts: { report: "/tmp/report.json" },
  ...over,
});

/**
 * A closed epic in a real repository, with the two closeout agents faked.
 *
 * Copied from `epic-close.test.mjs`'s harness rather than rewritten. The
 * deltas: `baselineChecks` is a command that APPENDS THE HEAD IT SAW to a file,
 * which is the only way to prove the chain ran over the fix commit rather than
 * merely being recorded as having, and the fixer's agent is injected so the
 * pass leaves a real commit.
 */
const closedEpic = async ({ mustFix, commit, before = null, fixAgent = null, config = {} }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-close-")));
  const marker = join(repo, "..", `${repo.split("/").pop()}-gates.txt`);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, {
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [`git rev-parse HEAD >> '${marker}'`],
    ...config,
  });
  writeFileSync(join(repo, "docs", "progress.md"), "# Progress\n");
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(
    join(repo, ".afk", "state.json"),
    JSON.stringify({
      version: 1,
      orchestratorPid: null,
      startedAt: "2026-09-04T00:00:00.000Z",
      activeWorkers: {},
      integrationQueue: [],
      activeIntegrator: null,
      epic: { id: "203", title: "Stripe subscriptions" },
      tasks: { 204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 } },
    }),
  );

  const dag = {
    epic: { id: "203", title: "Stripe subscriptions" },
    branch: "feat/203-stripe",
    tasks: [{ id: "204", title: "task 204", dependsOn: [], checks: ["true"], allowedPaths: ["**"] }],
  };

  // Whatever an interrupted earlier close left on disk and on the branch.
  before?.({ repo, git });

  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    await runAuto({
      config: readConfig(repo),
      dag,
      root: repo,
      interactive: false,
      // A fixture may give the repo a github.com origin; the suite must not
      // depend on the host's own `gh` login (#214).
      preflightProbeOverrides: { ghAuthProbe: null },
      verify: async () => verifierReport({ mustFix }),
      commentOnEpic: () => ({ status: 0 }),
      fixAgent: fixAgent ?? (async ({ streamPath }) => {
        writeFileSync(
          streamPath,
          "```json\n"
          + JSON.stringify({ summary: "repaired", fixed: [{ id: "F1", detail: "rerouted the test" }], deferred: [] })
          + "\n```\n",
        );
        if (commit) {
          writeFileSync(join(repo, "repair.txt"), "repaired\n");
          git("add", "-A");
          assert.equal(git("commit", "-qm", "fix: closeout findings for #203").status, 0);
        }
        return { status: 0 };
      }),
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }

  const state = JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));
  const gateHeads = existsSync(marker)
    ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { repo, state, gateHeads, head: git("rev-parse", "HEAD").stdout.trim(), cleanup: () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(marker, { force: true });
  } };
};

test("a closeout that commits a repair leaves the chain re-run over that commit", async (t) => {
  // The measured failure, reproduced: the fix commit is the branch tip, and
  // before this existed the last check of the run had been run two commits below
  // it. `gateHeads` is what each chain run saw as HEAD, so the assertion is that
  // a check REALLY executed against the fix commit — not that a record says so.
  const run = await closedEpic({ mustFix: ["reroute the appearance test"], commit: true });
  t.after(run.cleanup);

  const gate = run.state.epicClose.fixGate;
  assert.ok(gate, "the close recorded no gate at all: the tip is ungated");
  assert.equal(gate.status, "passed");
  assert.equal(gate.fixSha, run.head, "the gate must be recorded against the FIX sha");
  assert.equal(
    gateHeadsTail(run.gateHeads),
    run.head,
    `the chain never ran over the fix commit; it saw ${JSON.stringify(run.gateHeads)}`,
  );
  assert.equal(run.gateHeads.length, 2, "exactly one extra chain run: the run's baseline, then the gate");
  // The artifact the wave digest reads, in the run's own `.afk/`.
  assert.equal(readCloseoutGate(run.repo, "203").fixSha, run.head);
  // Advisory, as the fix pass is: a gated close is still a close.
  assert.equal(run.state.epicClose.lifecycle, "closed");
});

test("a restart inside the crash window gates the fix commit instead of calling it absent", async (t) => {
  // THE CRASH WINDOW: the fixer commits, then the runner dies before the gate
  // is written. On the way back up the fixer's `reuse` returns its report and
  // commits nothing, so a `headBefore` read here is the fix commit itself,
  // `head === headBefore`, and the gate records "the fix pass committed
  // nothing" — over the one commit on the branch nothing has ever checked. That
  // is quillnote wave-34 again, this time with an artifact asserting it is fine.
  let fixAgentCalls = 0;
  const run = await closedEpic({
    mustFix: ["reroute the appearance test"],
    commit: false,
    fixAgent: async () => { fixAgentCalls += 1; return { status: 0 }; },
    before: ({ repo, git }) => {
      const headBeforeFix = git("rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(repo, "repair.txt"), "the repair the crash interrupted\n");
      git("add", "-A");
      assert.equal(git("commit", "-qm", "fix: closeout findings for #203").status, 0);
      // The fixer's report as the interrupted pass left it: keyed on the review
      // it answered, and carrying the head as it was BEFORE the commit above.
      mkdirSync(join(repo, ".afk", "fixer", "203"), { recursive: true });
      writeFileSync(
        join(repo, ".afk", "fixer", "203", "report.json"),
        `${JSON.stringify({
          version: 1,
          ranAt: "2026-09-04T01:05:00.000Z",
          reviewHead: "aaaa111",
          head: headBeforeFix,
          durationMs: 1000,
          status: "ok",
          problems: [],
          items: [{ id: "M1", title: "reroute the appearance test" }],
          summary: "repaired",
          fixed: [{ id: "M1", title: "reroute the appearance test", detail: "rerouted the test", files: ["repair.txt"] }],
          deferred: [],
          rawPath: null,
        })}\n`,
      );
      // No `gate.json`: that is what "killed before the gate" means here.
    },
  });
  t.after(run.cleanup);

  assert.equal(fixAgentCalls, 0, "fixture precondition: the fixer reused its report rather than running again");
  const gate = run.state.epicClose.fixGate;
  assert.equal(gate.status, "passed", `the ungated fix commit was recorded as ${gate.status}`);
  assert.equal(gate.fixSha, run.head);
  assert.equal(
    gateHeadsTail(run.gateHeads),
    run.head,
    `the chain never ran over the fix commit; it saw ${JSON.stringify(run.gateHeads)}`,
  );
});

test("a closeout that commits nothing pays for no second chain run", async (t) => {
  const run = await closedEpic({ mustFix: [], commit: false });
  t.after(run.cleanup);

  const gate = run.state.epicClose.fixGate;
  assert.ok(gate, "the close recorded no gate at all");
  assert.equal(gate.status, "no_commit");
  assert.equal(gate.fixSha, null);
  assert.equal(run.gateHeads.length, 1, "only the run's own baseline may have run");
});

// ---------------------------------------------------------------------------
// 2b. The artefact sweep at close (#110)
// ---------------------------------------------------------------------------

// The run branch as Lumina's Futari v2 close found it: this epic's lane
// artefacts under both prefixes, and a sibling epic's beside them.
const seedArtefacts = ({ repo, git }) => {
  for (const [relative, body] of [
    [".afk-runs/204/verification.json", "{}\n"],
    [".afk-runs/204/integration-verification.json", "{}\n"],
    [".agents/evidence/204/01-home.png", "png\n"],
    [".afk-runs/999/verification.json", "{}\n"],
    [".agents/evidence/999/01.png", "png\n"],
  ]) {
    mkdirSync(join(repo, relative, ".."), { recursive: true });
    writeFileSync(join(repo, relative), body);
  }
  git("add", "-A");
  assert.equal(git("commit", "-qm", "lanes: run artefacts").status, 0);
};

const trackedIn = (repo) =>
  spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n").sort();

test("closing an epic sweeps its own run artefacts off the branch, after the fix gate, and not a sibling's", async (t) => {
  const run = await closedEpic({ mustFix: ["reroute the appearance test"], commit: true, before: seedArtefacts });
  t.after(run.cleanup);

  assert.deepEqual(trackedIn(run.repo), [
    ".afk-runs/999/verification.json",
    ".afk-setup/config.yaml",
    ".agents/evidence/999/01.png",
    ".gitignore",
    "docs/progress.md",
    "repair.txt",
  ]);
  assert.equal(existsSync(join(run.repo, ".afk-runs", "204")), false);
  const sweep = run.state.epicClose.sweep;
  assert.equal(sweep.removed.length, 3);
  assert.equal(sweep.commit, run.head, "the sweep is the last commit of the close");
  const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: run.repo, encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "afk: sweep run artefacts for epic 203");
  // ORDER: the gate ran over the fix commit, which is the sweep's parent — so
  // the sweep came after the gate, and the gate never ran over the sweep.
  const gate = run.state.epicClose.fixGate;
  assert.equal(gate.status, "passed");
  const parent = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: run.repo, encoding: "utf8" }).stdout.trim();
  assert.equal(gate.fixSha, parent);
  assert.equal(gateHeadsTail(run.gateHeads), parent);
  assert.equal(run.state.epicClose.lifecycle, "closed");
  // The closeout's own head is the swept tip, so a re-entry compares like with like.
  assert.equal(run.state.epicClose.closeout.head, run.head);
});

test("the close row is written before the artefact sweep commits (#177 story 2)", async (t) => {
  // A post-commit hook records, at each commit, whether the close row is on
  // disk yet. The sweep is the close's last commit, so its line must say yes.
  const measure = mkdtempSync(join(tmpdir(), "afk-gate-measure-"));
  const seen = join(measure, "seen.txt");
  const previous = process.env.AFK_MEASURE_ROOT;
  process.env.AFK_MEASURE_ROOT = measure;
  const rowPath = measurePath("afk-order");
  t.after(() => {
    if (previous === undefined) delete process.env.AFK_MEASURE_ROOT;
    else process.env.AFK_MEASURE_ROOT = previous;
    rmSync(measure, { recursive: true, force: true });
  });
  const run = await closedEpic({
    mustFix: [],
    commit: false,
    config: { pr: "off" },
    before: ({ repo, git }) => {
      git("remote", "add", "origin", "https://github.com/acme/afk-order.git");
      const hook = join(repo, ".git", "hooks", "post-commit");
      writeFileSync(hook, `#!/bin/sh\nif grep -q '"type":"close"' '${rowPath}' 2>/dev/null; then echo row >> '${seen}'; else echo none >> '${seen}'; fi\n`);
      chmodSync(hook, 0o755);
      seedArtefacts({ repo, git });
    },
  });
  t.after(run.cleanup);
  const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: run.repo, encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "afk: sweep run artefacts for epic 203");
  const rows = readFileSync(rowPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const close = rows.filter((row) => row.type === "close");
  assert.equal(close.length, 1);
  assert.equal(close[0].outcome, "completed");
  assert.equal(close[0].times.closed, run.state.epicClose.closedAt);
  assert.deepEqual(close[0].stops, []);
  assert.equal(readFileSync(seen, "utf8").trim().split("\n").at(-1), "row", "the sweep commit found the close row already written");
});

test("`sweepRunArtefacts: false` keeps every artefact where it was", async (t) => {
  const run = await closedEpic({
    mustFix: [],
    commit: false,
    before: seedArtefacts,
    config: { sweepRunArtefacts: false },
  });
  t.after(run.cleanup);

  assert.equal(run.state.epicClose.sweep, null);
  assert.ok(trackedIn(run.repo).includes(".afk-runs/204/verification.json"));
  assert.ok(trackedIn(run.repo).includes(".agents/evidence/204/01-home.png"));
  const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: run.repo, encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "lanes: run artefacts");
});

// ---------------------------------------------------------------------------
// 3. The digest, and the last wave of a run
// ---------------------------------------------------------------------------

const digestFor = (closeoutGate) =>
  renderDigest({
    id: "wave-34",
    base: "main",
    baseSha: "f2e2fa1",
    headSha: "18cdd44",
    tasks: [],
    fastForward: { verdict: "merged", reason: "1 of 1 task(s) passed" },
    closeoutGate,
  });

test("the digest says which way the tip went, and can say it three ways", () => {
  // Before this section the digest could not distinguish a wave whose tip was
  // gated from one whose tip was not — the sentence the issue asks for.
  const gated = digestFor({
    status: "passed",
    head: "18cdd44",
    fixSha: "18cdd44",
    checks: ["swift build", "swift test"],
  });
  assert.match(gated, /## Closeout fix gate/);
  assert.match(gated, /closeout fix `18cdd44` gated: \*\*yes\*\*/);

  const untouched = digestFor({ status: "no_commit", head: "f2e2fa1", fixSha: null, checks: [] });
  assert.match(untouched, /gated: \*\*n\/a\*\* — the fix pass committed nothing/);

  const red = digestFor({
    status: "failed",
    head: "18cdd44",
    fixSha: "18cdd44",
    checks: ["swift test"],
    failingCommand: "swift test",
    failingCode: 1,
    output: "AppearanceContrastTests failed",
  });
  assert.match(red, /gated: \*\*yes\*\*, and it FAILED/);
  assert.match(red, /AppearanceContrastTests failed/);

  // No fix pass ran at all — a verifier that could not produce a usable report.
  assert.match(digestFor(null), /gated: \*\*n\/a\*\* — no fix pass ran/);
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const waveFixture = fileURLToPath(new URL("./fixtures/wave/accepted", import.meta.url));

const wgit = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

test("the last wave of a run does not end on an ungated tip", async (t) => {
  // THE TWO-WAVE FIXTURE. `tasks/` here is wave-01 = {task-01-model,
  // task-03-docs}, wave-02 = {task-02-picker}, so wave-02 is the last wave of
  // the run and there is no later baseline to cover it. Its closeout commits a
  // repair — quillnote wave-34's shape exactly — and the run must end with the
  // base branch sitting on a commit a check chain has actually seen.
  const dir = mkdtempSync(join(tmpdir(), "afk-gate-wave-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  wgit(repo, ["init", "-q", "-b", "main"]);
  wgit(repo, ["config", "user.email", "t@t"]);
  wgit(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, ".afk-setup"), { recursive: true });
  writeFileSync(join(repo, ".afk-setup", "config.yaml"), "defaultChecks:\n  - true\nmaxParallel: 3\n");
  cpSync(waveFixture, join(repo, "tasks"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "scaffold\n");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  wgit(repo, ["add", "-A"]);
  wgit(repo, ["commit", "-qm", "init"]);

  // `io.runWave` is SYNCHRONOUS — the real one is a `spawnSync` of `afk auto`,
  // and the driver does not await it. A promise-returning fake is therefore
  // still running when the digest is written, which is a fake bug, not a
  // finding. So the closeout stand-in runs where the real one does: in a child
  // process, which is also the only way it can be async and still be finished
  // when the driver looks.
  //
  // AND IT CALLS `runAuto`, not `runCloseoutGate`. This is #78's flagship
  // property, and while the stand-in invoked the gate itself the whole of
  // `auto.mjs`'s wiring could be deleted and this test stayed green — it
  // asserted everything about the gate except that anything reaches it.
  // `verify` and the fixer's agent are injected so no agent is spawned; the
  // path from the close to the gate is the production one.
  const chainLog = join(dir, "chain-saw.txt");
  const closeout = join(dir, "closeout.mjs");
  writeFileSync(closeout, [
    'import { execFileSync } from "node:child_process";',
    'import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    `import { runAuto } from ${JSON.stringify(join(repoRoot, "scripts", "auto.mjs"))};`,
    "const [runRoot, branch, commit, log] = process.argv.slice(2);",
    'const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a],',
    '  { cwd: runRoot, encoding: "utf8" }).trim();',
    // The auth preflight is the only agent that would reach PATH.
    'const bin = mkdtempSync(join(tmpdir(), "afk-gate-wave-bin-"));',
    'writeFileSync(join(bin, "claude"), "#!/bin/sh\\nexit 0\\n");',
    'chmodSync(join(bin, "claude"), 0o755);',
    "process.env.PATH = `${bin}:${process.env.PATH}`;",
    // Picked in the parent. Left to itself the child derives a port from its
    // own pid, which is the collision the rest of this file just stopped doing.
    `process.env.PORT = ${JSON.stringify(String(await freePort()))};`,
    'mkdirSync(join(runRoot, ".afk"), { recursive: true });',
    "const tasks = JSON.parse(process.argv[6]);",
    'writeFileSync(join(runRoot, ".afk", "state.json"), JSON.stringify({',
    "  version: 1, orchestratorPid: null, startedAt: new Date().toISOString(),",
    "  activeWorkers: {}, integrationQueue: [], activeIntegrator: null,",
    "  epic: { id: branch, title: branch },",
    '  tasks: Object.fromEntries(tasks.map((id) => [id, { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 }])),',
    "}));",
    "await runAuto({",
    // `baselineChecks` APPENDS THE HEAD IT SAW, which is the only way to prove
    // a check really executed over the fix commit rather than being recorded as
    // having. The lanes are pre-seeded passed, so this chain runs twice at most:
    // the run's own baseline, and the gate.
    '  config: { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [`git rev-parse HEAD >> \'${log}\'`] },',
    "  dag: { epic: { id: branch, title: branch }, branch,",
    '    tasks: tasks.map((id) => ({ id, title: id, dependsOn: [], checks: ["true"], allowedPaths: ["**"] })) },',
    "  root: runRoot, interactive: false, baseBranch: branch, epicBase: branch,",
    '  verify: async () => ({ version: 1, status: "ok", summary: "shipped", criteria: [], findings: [],',
    '    mustFix: commit === "yes" ? ["repair the appearance test"] : [], problems: [],',
    '    ranAt: new Date().toISOString(), head: git("rev-parse", "HEAD"), branch,',
    '    baseBranch: "main", artifacts: { report: "/tmp/report.json" } }),',
    "  commentOnEpic: () => ({ status: 0 }),",
    "  fixAgent: async ({ streamPath }) => {",
    '    writeFileSync(streamPath, "```json\\n" + JSON.stringify({ summary: "repaired",',
    '      fixed: [{ id: "M1", title: "repair the appearance test", detail: "rerouted it", files: ["repair.txt"] }],',
    '      deferred: [] }) + "\\n```\\n");',
    '    if (commit === "yes") {',
    '      writeFileSync(join(runRoot, "repair.txt"), "the closeout\'s repair\\n");',
    '      git("add", "-A");',
    '      git("commit", "-qm", `fix: closeout findings for #${branch}`);',
    "    }",
    "    return { status: 0 };",
    "  },",
    "}).then((status) => { if (status) { console.log(`runAuto exited ${status}`); process.exit(1); } });",
  ].join("\n"));

  // Stands in for `afk auto`: it does what a real wave does to the branch, then
  // what its closeout does after the gates have passed. Only the LAST wave's
  // fix pass commits, which is quillnote wave-34's shape exactly.
  const runWave = ({ runRoot, branch, taskIds }) => {
    for (const id of taskIds) {
      writeFileSync(join(runRoot, `${id}.txt`), "work\n");
      wgit(runRoot, ["add", "-A"]);
      wgit(runRoot, ["commit", "-qm", `${id} done`]);
    }
    // `.afk/state.json` is written by the child, which is where `runAuto` reads
    // it: the lanes are pre-seeded passed so the close is all that runs.
    const closed = spawnSync(
      process.execPath,
      [closeout, runRoot, branch, branch === "wave-02" ? "yes" : "no", chainLog, JSON.stringify(taskIds)],
      { encoding: "utf8" },
    );
    assert.equal(closed.status, 0, `${closed.stdout}${closed.stderr}`);
    return { status: 0 };
  };

  const said = [];
  const status = await cliWaveRun({
    root: repo,
    dir: "tasks",
    base: "main",
    io: {
      runWave,
      planReview: () => ({ ok: true, status: "clean", message: "no contradiction" }),
      makeWorktree: ({ root, branch, epicId }) => {
        const worktree = join(dir, "worktrees", epicId);
        wgit(root, ["worktree", "add", "-q", worktree, branch]);
        return { worktree, reused: false };
      },
      removeWorktree: ({ root, worktree }) => {
        wgit(root, ["worktree", "remove", "--force", worktree]);
      },
    },
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  const digest = (id) => readFileSync(join(repo, "docs", "afk-runs", `${id}.md`), "utf8");
  // Wave 1's closeout commits nothing, which the digest says rather than
  // leaving the reader to assume.
  assert.match(digest("wave-01"), /gated: \*\*n\/a\*\* — the fix pass committed nothing/);
  // Wave 2's does, and the chain saw it.
  const gate = JSON.parse(
    readFileSync(join(repo, ".afk", "archive", "wave-02", "fixer", "wave-02", "gate.json"), "utf8"),
  );
  assert.equal(gate.status, "passed");
  assert.match(digest("wave-02"), new RegExp(`closeout fix \`${gate.fixSha}\` gated: \\*\\*yes\\*\\*`));

  // THE PROPERTY: the run ended with every code commit on the base branch
  // having been seen by a check chain. quillnote wave-34 ended one code commit
  // past its last check. The driver's own bookkeeping commit sits above the fix
  // commit — it carries the log, the digest and the filed task files and no
  // code, which is why it is named here rather than gated.
  const tip = wgit(repo, ["rev-parse", "wave-02"]);
  assert.equal(gate.fixSha, tip, "the last wave's gate must be about its branch tip");
  assert.deepEqual(
    wgit(repo, ["log", "--format=%s", `${tip}..main`]).split("\n").filter(Boolean),
    ["afk wave: wave-02 merged"],
    "something other than the driver's bookkeeping landed above the gated commit",
  );
  const chainHeads = readFileSync(chainLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(
    chainHeads[chainHeads.length - 1],
    tip,
    `the chain never executed against the final tip; it saw ${JSON.stringify(chainHeads)}`,
  );
});
