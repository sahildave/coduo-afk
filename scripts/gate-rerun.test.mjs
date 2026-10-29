// scripts/gate-rerun.test.mjs — #179: a red gate the runner can pin on the
// environment reruns once instead of halting, and a refused push is state.
//
// harbour #489 ran 18.5 hours for four tasks, 11 of them an overnight halt on a
// baseline whose code was never the cause. Its closeout push was refused by a
// pre-push hook and written to one log line; the epic read as finished.
//
// The baseline commands append to a file OUTSIDE the repo, so the assertions are
// on runs that really happened and running them leaves the tree clean.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuto } from "./auto.mjs";
import { applyPrDelivery, persistPrDelivery } from "./pr.mjs";
import { freePort } from "./free-port.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";
// Namespaces, so a missing export fails its own test rather than the file.
import * as supervisor from "./supervisor.mjs";
import * as scheduler from "./scheduler.mjs";
import * as status from "./status.mjs";

const { onEpicEnded, supervisorNotification } = supervisor;
const { epicCloseSummary, supervisorAdvice, supervisorRecord } = scheduler;
const classifyGateFailure = (...args) => supervisor.classifyGateFailure(...args);
const deliveryLine = (...args) => status.deliveryLine(...args);
const gateRerunLines = (...args) => status.gateRerunLines(...args);

process.setMaxListeners(60);

const fakeBin = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-gate-rerun-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

// A fake `gh` that names a repository and finds no PR, so the closeout reaches
// the push. Only the push test puts it on PATH.
const fakeGh = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-gate-rerun-gh-"));
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "repo view") echo owner/repo ;;',
    '  "pr list") echo "[]" ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
})();

const PORT_HELD = "Error: listen EADDRINUSE: address already in use :::5173";

/**
 * A repo whose only task already passed, and a baseline command that fails
 * with `failOutput` on its first `failRuns` runs and passes after.
 */
const repoWith = ({ failRuns, failOutput }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-rerun-")));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-rerun-count-")));
  const counter = join(scratch, "runs");
  const script = join(scratch, "baseline.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `echo run >> ${counter}`,
    `if [ $(wc -l < ${counter}) -le ${failRuns} ]; then echo ${JSON.stringify(failOutput)} >&2; exit 1; fi`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [script] });
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(repo, ".afk"), { recursive: true });
  writeFileSync(join(repo, ".afk", "state.json"), JSON.stringify({
    version: 1, orchestratorPid: null, activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
    tasks: { 204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 } },
  }));
  return {
    repo, git, script,
    runs: () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0),
    head: () => git("rev-parse", "HEAD").stdout.trim(),
    state: () => JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8")),
    log: () => readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8"),
    gateEvents: () => readFileSync(join(repo, ".afk", "runs", "gate-events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => { rmSync(repo, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); },
  };
};

const DAG = {
  epic: { id: "203", title: "Stripe subscriptions" },
  branch: "main",
  tasks: [{ id: "204", title: "task 204", dependsOn: [], checks: ["true"], allowedPaths: ["**"] }],
};

const start = async (repo, { path = fakeBin, ...args } = {}) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${path}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await runAuto({
      config: readConfig(repo), dag: DAG, root: repo, interactive: false,
      // A quiet host unless a test says otherwise: the real load is not this suite's.
      hostLoad: () => 0,
      verify: async () => ({ version: 1, status: "ok", summary: "Reviewed.", criteria: [], findings: [], mustFix: [], problems: [], outstanding: [] }),
      commentOnEpic: () => ({ status: 0 }),
      ...args,
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

test("an environment-classed red baseline reruns once and the run goes on (#179)", async () => {
  const fx = repoWith({ failRuns: 1, failOutput: PORT_HELD });
  try {
    const head = fx.head();
    assert.equal(await start(fx.repo), 0, fx.log());
    assert.equal(fx.runs(), 2, "the red baseline ran exactly once more");
    const [rerun, ...more] = fx.state().gateReruns ?? [];
    assert.equal(more.length, 0);
    assert.equal(rerun.kind, "baseline");
    assert.equal(rerun.classification, "environment");
    assert.equal(rerun.confidence, "high");
    assert.match(rerun.evidence.join("\n"), /EADDRINUSE/, "the evidence that drove it is recorded");
    assert.equal(rerun.headSha, head);
    assert.equal(rerun.passed, true);
    assert.equal(fx.state().lastGreenBaseline.headSha, head, "the green is this tree's");
    // Both runs went through the gate lock and are recorded as gate events.
    const baselines = fx.gateEvents().filter((event) => event.kind === "baseline");
    assert.equal(baselines.length, 2);
    assert.ok(baselines.every((event) => typeof event.lockWaitS === "number"), "each run took the gate lock");
    assert.match(fx.log(), /failed on the environment, not the code/);
  } finally {
    fx.cleanup();
  }
});

test("an environment-classed red baseline that fails twice halts with no third run (#179)", async () => {
  const fx = repoWith({ failRuns: 99, failOutput: PORT_HELD });
  try {
    assert.equal(await start(fx.repo), 1);
    assert.equal(fx.runs(), 2, "one rerun, never a second");
    const [rerun] = fx.state().gateReruns;
    assert.equal(rerun.passed, false);
    assert.equal(fx.state().lastGreenBaseline, undefined);
    assert.match(fx.log(), /baseline rerun failed again on the same tree; halting/);
    assert.match(fx.log(), /baseline check failed before scheduling/);
  } finally {
    fx.cleanup();
  }
});

test("a ticket-classed red baseline halts with no rerun (#179)", async () => {
  const fx = repoWith({ failRuns: 99, failOutput: "AssertionError: expected 1 to equal 2" });
  try {
    assert.equal(await start(fx.repo), 1);
    assert.equal(fx.runs(), 1, "no rerun");
    assert.equal(fx.state().gateReruns, undefined);
    assert.doesNotMatch(fx.log(), /Rerunning the baseline/);
  } finally {
    fx.cleanup();
  }
});

test("an unclear red baseline halts with no rerun (#179)", async () => {
  const fx = repoWith({ failRuns: 99, failOutput: "1 test failed" });
  try {
    assert.equal(await start(fx.repo), 1);
    assert.equal(fx.runs(), 1, "no rerun");
    assert.equal(fx.state().gateReruns, undefined);
  } finally {
    fx.cleanup();
  }
});

test("classifyGateFailure: environment only on a named sign, never on a killed command (#179)", () => {
  assert.equal(classifyGateFailure({ output: PORT_HELD }).classification, "environment");
  assert.equal(classifyGateFailure({ output: "connect ECONNREFUSED 127.0.0.1:54321" }).classification, "environment");
  assert.equal(classifyGateFailure({ output: "Could not find the table 'public.users' in the schema cache" }).classification, "environment");
  assert.equal(classifyGateFailure({ output: "Test timed out after 5000ms" }).classification, "environment");
  assert.equal(classifyGateFailure({ output: "AssertionError: 1 !== 2" }).classification, "ticket");
  assert.equal(classifyGateFailure({ output: "src/a.ts(3,1): error TS2322: nope" }).classification, "ticket");
  assert.equal(classifyGateFailure({ output: "1 failing" }).classification, "unclear");
  assert.equal(classifyGateFailure({ output: PORT_HELD, timedOut: true }).classification, "unclear",
    "a command killed at its bound would hold the gate for another full bound");
});

// ---------------------------------------------------------------------------
// #223: GitHub 5xx and timeouts outside the epic's diff, read as the environment
// ---------------------------------------------------------------------------

// harbour #545 launch-545f, verbatim: a roadmap read during `next build`.
const GITHUB_502 = "[roadmap] owner/brightpath open: Roadmap read failed (http): GitHub returned HTTP 502";

// harbour #545 launch-545g, trimmed: a Playwright locator inside vitest.
const VITEST_LOCATOR_TIMEOUT = [
  " FAIL  src/lib/dev-personas/support-round-trip.test.ts > the Support round trip > mails the End User",
  "TimeoutError: locator.waitFor: Timeout 90000ms exceeded.",
  " ❯ src/lib/dev-personas/support-round-trip.test.ts:179:41",
].join("\n");

// A Playwright test-runner timeout, the shape launch-545i's first red carried.
const PLAYWRIGHT_TIMEOUT = [
  "  1) [chromium] › e2e/board.spec.ts:12:3 › a Board loads",
  "    Test timeout of 30000ms exceeded.",
].join("\n");

test("classifyGateFailure: a GitHub 5xx is the environment, a 4xx is not (#223)", () => {
  const reading = classifyGateFailure({ output: GITHUB_502 });
  assert.equal(reading.classification, "environment");
  assert.equal(reading.confidence, "high");
  assert.match(reading.evidence.join("\n"), /GitHub returned HTTP 502/);
  assert.equal(classifyGateFailure({ output: "GET https://api.github.com/repos/a/b/issues 503 Service Unavailable" }).classification, "environment");
  assert.notEqual(classifyGateFailure({ output: "GitHub returned HTTP 404" }).classification, "environment");
  assert.notEqual(classifyGateFailure({ output: "GET https://api.github.com/repos/a/b/issues/512 404" }).classification, "environment",
    "an issue number in the URL is not a status");
});

test("classifyGateFailure: a timeout outside the epic's diff is the environment, inside it a code red (#223)", () => {
  const outside = ["src/app/page.tsx", "src/lib/analytics.test.ts"];
  assert.equal(classifyGateFailure({ output: VITEST_LOCATOR_TIMEOUT, changedFiles: outside }).classification, "environment",
    "a Playwright locator timeout in an untouched vitest file");
  assert.equal(classifyGateFailure({ output: PLAYWRIGHT_TIMEOUT, changedFiles: outside }).classification, "environment");

  const inside = classifyGateFailure({ output: VITEST_LOCATOR_TIMEOUT, changedFiles: ["src/lib/dev-personas/support-round-trip.test.ts"] });
  assert.equal(inside.classification, "ticket");
  assert.match(inside.evidence.join("\n"), /support-round-trip\.test\.ts/);
  assert.equal(classifyGateFailure({ output: PLAYWRIGHT_TIMEOUT, changedFiles: ["e2e/board.spec.ts"] }).classification, "ticket");
  // Playwright prints a path relative to its testDir; the diff is repo-relative.
  assert.equal(classifyGateFailure({ output: PLAYWRIGHT_TIMEOUT.replace("e2e/", ""), changedFiles: ["e2e/board.spec.ts"] }).classification, "ticket");
  // A timeout inside the diff outranks a dropped connection beside it.
  assert.equal(classifyGateFailure({ output: `${PLAYWRIGHT_TIMEOUT}\n[WebServer]   code: 'ECONNRESET'`, changedFiles: ["e2e/board.spec.ts"] }).classification, "ticket");
});

const withQuietThreshold = async (value, body) => {
  const previous = process.env.AFK_QUIET_HOST_LOAD;
  process.env.AFK_QUIET_HOST_LOAD = value;
  try { return await body(); } finally {
    if (previous === undefined) delete process.env.AFK_QUIET_HOST_LOAD;
    else process.env.AFK_QUIET_HOST_LOAD = previous;
  }
};

test("a baseline red on a GitHub 5xx waits for a quiet host and reruns once (#223)", async () => {
  const fx = repoWith({ failRuns: 1, failOutput: GITHUB_502 });
  try {
    // Quiet for the first run; busy for three reads after it, then quiet.
    let reads = 0;
    const hostLoad = () => { reads += 1; return reads >= 2 && reads <= 4 ? 30 : 2; };
    const code = await withQuietThreshold("20", () => start(fx.repo, { hostLoad, quietPollMs: 10 }));
    assert.equal(code, 0, fx.log());
    assert.equal(fx.runs(), 2, "the red baseline ran exactly once more");
    const [rerun] = fx.state().gateReruns;
    assert.equal(rerun.classification, "environment");
    assert.match(rerun.evidence.join("\n"), /HTTP 502/);
    assert.equal(rerun.passed, true);
    assert.match(fx.log(), /baseline gate waiting for a quiet host: load 30\.0, threshold 20/);
    assert.ok(fx.log().indexOf("waiting for a quiet host") > fx.log().indexOf("failed on the environment"),
      "the wait comes before the rerun");
  } finally {
    fx.cleanup();
  }
});

test("a GitHub 5xx red that fails again on a quiet host is a code red (#223)", async () => {
  const fx = repoWith({ failRuns: 99, failOutput: GITHUB_502 });
  try {
    const code = await withQuietThreshold("20", () => start(fx.repo, { hostLoad: () => 2, quietPollMs: 10 }));
    assert.equal(code, 1);
    assert.equal(fx.runs(), 2, "one rerun, never a second");
    assert.equal(fx.state().gateReruns.length, 1);
    assert.match(fx.log(), /baseline rerun failed again on the same tree; halting/);
  } finally {
    fx.cleanup();
  }
});

test("a baseline timeout in a test the epic's diff touches halts with no rerun (#223)", async () => {
  const fx = repoWith({ failRuns: 1, failOutput: PLAYWRIGHT_TIMEOUT });
  try {
    // The epic's branch adds the very spec that timed out.
    fx.git("checkout", "-q", "-b", "feat/203");
    mkdirSync(join(fx.repo, "e2e"), { recursive: true });
    writeFileSync(join(fx.repo, "e2e", "board.spec.ts"), "// the epic's own test\n");
    fx.git("add", ".");
    fx.git("commit", "-q", "-m", "the epic's spec");
    const code = await start(fx.repo, { dag: { ...DAG, branch: "feat/203" }, baseBranch: "feat/203", epicBase: "main" });
    assert.equal(code, 1, fx.log());
    assert.equal(fx.runs(), 1, "no rerun");
    assert.equal(fx.state().gateReruns, undefined);
  } finally {
    fx.cleanup();
  }
});

test("a baseline timeout in a test outside the epic's diff reruns once (#223)", async () => {
  const fx = repoWith({ failRuns: 1, failOutput: PLAYWRIGHT_TIMEOUT });
  try {
    fx.git("checkout", "-q", "-b", "feat/203");
    writeFileSync(join(fx.repo, "other.txt"), "the epic touches something else\n");
    fx.git("add", ".");
    fx.git("commit", "-q", "-m", "unrelated");
    const code = await start(fx.repo, { dag: { ...DAG, branch: "feat/203" }, baseBranch: "feat/203", epicBase: "main" });
    assert.equal(code, 0, fx.log());
    assert.equal(fx.runs(), 2);
    assert.equal(fx.state().gateReruns[0].classification, "environment");
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `afk status`
// ---------------------------------------------------------------------------

test("afk status shows each gate rerun with its classification and evidence (#179)", () => {
  const lines = gateRerunLines({
    gateReruns: [
      { kind: "baseline", command: "npm test", firstExitCode: 1, classification: "environment", confidence: "high", evidence: ["a port was already held: EADDRINUSE"], passed: true },
      { kind: "integration", taskId: "7", command: "npm run e2e", firstExitCode: 1, classification: "unclear", confidence: "low", evidence: [], passed: false },
    ],
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /gate rerun · baseline · `npm test` exited 1 · environment \(high\) · passed on rerun — a port was already held: EADDRINUSE/);
  assert.match(lines[1], /post-merge #7 .* unclear \(low\) · red again/);
  assert.deepEqual(gateRerunLines({}), []);
});

// ---------------------------------------------------------------------------
// A refused push at closeout
// ---------------------------------------------------------------------------

test("a push refused by the pre-push hook at closeout lands in state and in afk status, not as finished (#179)", async () => {
  const fx = repoWith({ failRuns: 0, failOutput: "" });
  const remote = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-rerun-remote-")));
  try {
    spawnSync("git", ["init", "--bare", "-b", "main", remote]);
    fx.git("remote", "add", "origin", remote);
    // The epic's base sits one commit behind, so the branch has work to push.
    fx.git("branch", "epic-base");
    writeFileSync(join(fx.repo, "work.txt"), "the epic's work\n");
    fx.git("add", ".");
    fx.git("commit", "-m", "work");
    writeFileSync(join(fx.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\necho 'pre-push: lint failed in src/email.ts' >&2\nexit 1\n");
    chmodSync(join(fx.repo, ".git", "hooks", "pre-push"), 0o755);

    await start(fx.repo, { path: `${fakeGh}:${fakeBin}`, epicBase: "epic-base" });
    const state = fx.state();
    assert.equal(state.prDelivery?.status, "failed", fx.log());
    assert.equal(state.prDelivery.step, "push");
    assert.match(state.prDelivery.message, /pre-push: lint failed in src\/email\.ts/, "the hook's own message");
    assert.equal(state.epicClose.lifecycle, "closed", "fixture precondition: the closeout ran");
    const close = epicCloseSummary(state);
    assert.equal(close.lifecycle, "not_delivered");
    assert.match(close.summary, /^epic: not_delivered .*push refused: .*pre-push: lint failed/);
    assert.equal(spawnSync("git", ["--git-dir", remote, "branch", "--list", "main"], { encoding: "utf8" }).stdout.trim(), "",
      "fixture precondition: nothing reached the remote");
  } finally {
    fx.cleanup();
    rmSync(remote, { recursive: true, force: true });
  }
});

test("a mid-run PR failure is its own line in afk status until a delivery clears it (#179)", () => {
  const failed = { prDelivery: { status: "failed", step: "create", at: "t", message: "HTTP 422" } };
  assert.equal(deliveryLine(failed), "PR not delivered · PR create failed at t: HTTP 422");
  // One wording with the epic summary's: only a push is refused; a thrown step is not "error refused".
  const push = { prDelivery: { status: "failed", step: "push", at: "t", message: "pre-push: lint failed" } };
  assert.equal(deliveryLine(push), "PR not delivered · push refused at t: pre-push: lint failed");
  const thrown = { prDelivery: { status: "failed", step: "error", at: "t", message: "spawn gh ENOENT" } };
  assert.equal(deliveryLine(thrown), "PR not delivered · PR delivery failed at t: spawn gh ENOENT");
  assert.equal(deliveryLine({ ...failed, epicClose: { lifecycle: "closed" } }), null, "the epic summary carries it once closed");
  assert.equal(deliveryLine({}), null);
});

test("only a refused push or a failed PR creation is undelivered; a failed body refresh is not (#183 closeout)", () => {
  const closed = { epicClose: { lifecycle: "closed" }, tasks: {} };
  const edit = { action: "failed", number: 7, failure: { step: "edit", message: "HTTP 502" }, notes: [], warnings: [] };
  assert.equal(applyPrDelivery(closed, edit), false);
  assert.equal(closed.prDelivery, undefined, "branch and PR #7 are both on GitHub");
  assert.notEqual(epicCloseSummary(closed).lifecycle, "not_delivered");
  const compare = { action: "failed", failure: { step: "compare", message: "bad ref" }, notes: [], warnings: [] };
  assert.equal(applyPrDelivery(closed, compare), false);
  assert.equal(closed.prDelivery, undefined);
  const push = { action: "failed", failure: { step: "push", message: "pre-push: lint" }, notes: [], warnings: [] };
  assert.equal(applyPrDelivery(closed, push, "t"), true);
  assert.equal(epicCloseSummary(closed).lifecycle, "not_delivered");
  assert.equal(applyPrDelivery(closed, edit), true, "the PR exists, so a later refresh failure still clears the push refusal");
  assert.equal(closed.prDelivery, undefined);
});

test("afk finish --push and afk epic clear a recorded refusal through persistPrDelivery (#183 closeout)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-rerun-persist-")));
  try {
    mkdirSync(join(root, ".afk"));
    const path = join(root, ".afk", "state.json");
    writeFileSync(path, JSON.stringify({ epicClose: { lifecycle: "closed" }, prDelivery: { status: "failed", step: "push", at: "t", message: "x" } }));
    assert.equal(persistPrDelivery(root, { action: "created", number: 9, notes: [], warnings: [] }), true);
    const state = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(state.prDelivery, undefined);
    assert.equal(epicCloseSummary(state).lifecycle, "closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an epic that ended undelivered is read as partial and wakes a human (#179)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-gate-rerun-sup-")));
  try {
    const decision = await onEpicEnded({
      root, consult: "never", epic: { id: "489" }, halted: null,
      delivery: { step: "push", message: "pre-push: lint failed" },
      tally: { status: "complete", passed: ["1"], failed: [] },
    });
    assert.equal(decision.classification, "partial");
    assert.equal(decision.recommendation, "wake-human");
    assert.equal(supervisorNotification(decision).title, "epic NOT delivered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The end-of-epic text cannot outlive the failure it describes
// ---------------------------------------------------------------------------

test("an end-of-epic note expires once a task it saw has moved (#179)", () => {
  const decision = {
    event: "epic_ended", classification: "halted", confidence: "high", recommendation: "wake-human",
    answer: "halted on a flaky email test in #2", evidence: {},
  };
  const record = supervisorRecord(decision, [], { runLifecycles: { 1: "passed", 2: "failed" } });
  const state = (two) => ({ supervisor: record, tasks: { 1: { lifecycle: "passed" }, 2: { lifecycle: two } } });
  assert.match(supervisorAdvice(state("failed")).join("\n"), /flaky email test/);
  assert.deepEqual(supervisorAdvice(state("passed")), [], "#2 passed since; the note describes a failure that no longer exists");
});
