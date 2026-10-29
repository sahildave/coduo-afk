// scripts/wave-driver.test.mjs — the driver's judgments, with no repo.
//
// `docs/wave-mode.md` §4 is five decisions wrapped in git commands. Every one
// of them is a pure function in `wave-driver.mjs` precisely so it can be
// exercised here, in milliseconds, instead of once at 3am by nobody. The two
// that matter most are the ancestor assertion — the whole safety mechanism of
// the fast-forward — and the halt rule, which decides whether the rest of the
// night is worth running.
//
// The last third of the file drives the real loop end to end over a real git
// repository with the agent run faked out, which is as far as the CLI surface
// goes without an overnight epic.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTEMPT_BUDGET,
  dirtyBlockers,
  doneFileMoves,
  WAVE_CAP,
  deadTasks,
  emptyWaveLog,
  fastForwardDecision,
  followUpFiles,
  haltDecision,
  isDead,
  planReviewDecision,
  recordWave,
  renderDigest,
  resumePlan,
  taskLedger,
  unreachableTasks,
  verifierStatus,
  waveBranchDecision,
  waveFrontier,
  waveHasMergedWork,
  waveId,
} from "./wave-driver.mjs";
import { removeWaveRefs } from "./teardown.mjs";
import { parseStatusPaths } from "./lib.mjs";
import { builderRunDir } from "./worker.mjs";
import { cliWaveRun, collectBrokerDenials, collectFailureEvidence, readWaveLog, waveLogPath, waveTaskResults } from "./wave.mjs";
import { writeConfig } from "./test-helpers.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const afk = join(repoRoot, "afk.mjs");
const afkCodex = join(repoRoot, "afk-codex.mjs");
const fixture = fileURLToPath(new URL("./fixtures/wave/accepted", import.meta.url));

/** A chain: a → b → c, plus an independent d. */
const chainDag = {
  epic: { id: "wave", title: "t" },
  branch: "wave",
  tasks: [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
    { id: "d", dependsOn: [] },
  ],
};

const logOf = (...waves) => ({ version: 1, base: "main", waves });

// ---------------------------------------------------------------------------
// The wave log, folded
// ---------------------------------------------------------------------------

test("attempts accumulate across waves and the last outcome wins", () => {
  // §3: "attempts crosses the boundary on purpose: without it a task that
  // burned two grounded retries in wave 3 gets a fresh two in wave 4, and
  // 'two retries' silently becomes unlimited."
  const ledger = taskLedger(
    logOf(
      { id: "wave-01", outcome: "failed", tasks: { a: { outcome: "failed", attempts: 2 } } },
      { id: "wave-02", outcome: "merged", tasks: { a: { outcome: "passed", attempts: 1 }, d: { outcome: "passed", attempts: 1 } } },
    ),
  );
  assert.deepEqual(ledger.a, { outcome: "passed", attempts: 3 });
  assert.deepEqual(ledger.d, { outcome: "passed", attempts: 1 });
  assert.deepEqual(taskLedger(emptyWaveLog("main")), {});
});

test("a failed task with attempts left is re-runnable; one at the budget is dead", () => {
  // The difference between "a wave crashed at 3am" and "this ticket cannot be
  // built". Only the budget decides, never the outcome word.
  const ledger = taskLedger(
    logOf({ id: "wave-01", outcome: "failed", tasks: {
      a: { outcome: "failed", attempts: 1 },
      b: { outcome: "failed", attempts: ATTEMPT_BUDGET },
      c: { outcome: "passed", attempts: ATTEMPT_BUDGET },
    } }),
  );
  assert.equal(isDead(ledger, "a"), false);
  assert.equal(isDead(ledger, "b"), true);
  assert.equal(isDead(ledger, "c"), false, "a passed task is never dead, whatever it spent");
  assert.equal(isDead(ledger, "never-run"), false);
  assert.deepEqual([...deadTasks(chainDag, ledger)], ["b"]);
});

test("dead tasks orphan their dependents transitively, and are not themselves orphans", () => {
  const orphaned = unreachableTasks(chainDag, new Set(["a"]));
  assert.deepEqual([...orphaned].sort(), ["b", "c"], "c is behind b is behind dead a");
  assert.ok(!orphaned.has("a"), "a is dead, which is a different fact with a different cause");
  assert.ok(!orphaned.has("d"), "d depends on nothing dead");
});

// ---------------------------------------------------------------------------
// The frontier and the cap
// ---------------------------------------------------------------------------

test("the frontier is deps-passed only, skips passed and dead, and caps in DAG order", () => {
  assert.deepEqual(waveFrontier({ dag: chainDag, ledger: {} }), ["a", "d"]);
  const afterFirst = taskLedger(logOf({ id: "wave-01", tasks: { a: { outcome: "passed", attempts: 1 }, d: { outcome: "passed", attempts: 1 } } }));
  assert.deepEqual(waveFrontier({ dag: chainDag, ledger: afterFirst }), ["b"]);
  const withDead = taskLedger(logOf({ id: "wave-01", tasks: { a: { outcome: "failed", attempts: ATTEMPT_BUDGET } } }));
  assert.deepEqual(waveFrontier({ dag: chainDag, ledger: withDead }), ["d"], "b is behind dead a; a has no attempts left");
  assert.deepEqual(waveFrontier({ dag: chainDag, ledger: {}, cap: 1 }), ["a"]);
  assert.equal(WAVE_CAP, 12);
});

test("a wave never contains an edge, so its tasks are independent by construction", () => {
  // The property the fast-forward gate leans on: a dependent's edge is only
  // satisfied once its dependency has PASSED, which happens in an earlier wave.
  const wave = waveFrontier({ dag: chainDag, ledger: {} });
  for (const id of wave) {
    const task = chainDag.tasks.find((candidate) => candidate.id === id);
    assert.equal(task.dependsOn.some((edge) => wave.includes(edge)), false, `${id} depends on a sibling in its own wave`);
  }
});

// ---------------------------------------------------------------------------
// The halt rule (§4)
// ---------------------------------------------------------------------------

test("the halt rule fires when dead tasks orphan more than a quarter of what is left", () => {
  // a is dead, so b and c can never run: 2 of the 3 outstanding tasks (b, c and
  // the dead a) are unreachable — 67%, well over the quarter.
  const ledger = taskLedger(
    logOf({ id: "wave-01", tasks: {
      a: { outcome: "failed", attempts: ATTEMPT_BUDGET },
      d: { outcome: "passed", attempts: 1 },
    } }),
  );
  const decision = haltDecision({ dag: chainDag, ledger });
  assert.equal(decision.halt, true, JSON.stringify(decision));
  assert.deepEqual(decision.orphaned.sort(), ["b", "c"]);
  assert.equal(decision.remaining, 3);
  assert.match(decision.reason, /unreachable behind dead task\(s\) a/);
});

test("a dead leaf orphans nobody, and the night carries on", () => {
  // §4: "the driver carries on with whatever else is still reachable." d is a
  // leaf, so its death costs exactly itself.
  const ledger = taskLedger(
    logOf({ id: "wave-01", tasks: {
      a: { outcome: "passed", attempts: 1 },
      d: { outcome: "failed", attempts: ATTEMPT_BUDGET },
    } }),
  );
  const decision = haltDecision({ dag: chainDag, ledger });
  assert.equal(decision.halt, false, JSON.stringify(decision));
  assert.deepEqual(decision.orphaned, []);
  assert.deepEqual(waveFrontier({ dag: chainDag, ledger }), ["b"], "the rest of the graph is still runnable");
});

test("the halt threshold is `more than` a quarter, not `at least`", () => {
  // Four in flight behind one dead task out of sixteen outstanding is exactly
  // 25% and must NOT halt; one more orphan must.
  const dag = {
    tasks: [
      { id: "dead", dependsOn: [] },
      ...Array.from({ length: 3 }, (unused, n) => ({ id: `orphan-${n}`, dependsOn: ["dead"] })),
      ...Array.from({ length: 12 }, (unused, n) => ({ id: `fine-${n}`, dependsOn: [] })),
    ],
  };
  const ledger = { dead: { outcome: "failed", attempts: ATTEMPT_BUDGET } };
  const at = haltDecision({ dag, ledger });
  assert.equal(at.remaining, 16);
  assert.equal(at.share, 0.1875);
  assert.equal(at.halt, false);
  const over = haltDecision({ dag, ledger, ratio: 0.1 });
  assert.equal(over.halt, true);
});

test("an empty remaining graph never halts", () => {
  const ledger = Object.fromEntries(chainDag.tasks.map((task) => [task.id, { outcome: "passed", attempts: 1 }]));
  assert.equal(haltDecision({ dag: chainDag, ledger }).halt, false);
});

// ---------------------------------------------------------------------------
// The fast-forward (§4) — the ancestor assertion is the whole safety mechanism
// ---------------------------------------------------------------------------

const ledgerFor = (entries) => Object.fromEntries(
  Object.entries(entries).map(([id, outcome]) => [
    id,
    typeof outcome === "string" ? { outcome, attempts: outcome === "passed" ? 1 : ATTEMPT_BUDGET } : outcome,
  ]),
);

test("the fast-forward is refused when the base is not an ancestor of the wave branch", () => {
  // Something moved the base during the wave. §4: "stop, write the digest,
  // leave the branch for a human." There is no --force path to reach.
  const decision = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "passed", d: "passed" }),
    isAncestor: false,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.verdict, "halted", "a moved base is a human's problem, not a resumable wave");
  assert.match(decision.reason, /not an ancestor/);
  assert.match(decision.reason, /never --force/);
});

test("the fast-forward is allowed only when the wave finished AND the base is an ancestor", () => {
  const allowed = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "passed", d: "passed" }),
    isAncestor: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.verdict, "merged");

  // A task still pending or running means the wave did not finish. Resumable,
  // not halted — so the two refusals get different mornings.
  const unfinished = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "passed", d: { outcome: "failed", attempts: 1 } }),
    isAncestor: true,
  });
  assert.equal(unfinished.allowed, false);
  assert.equal(unfinished.verdict, "failed");
  assert.match(unfinished.reason, /d did not reach a terminal outcome/);

  // A dead task does NOT hold its passing siblings off the base. If it did, the
  // first dead task of the night would strand every later wave.
  const withDead = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "passed", d: "failed" }),
    isAncestor: true,
  });
  assert.equal(withDead.allowed, true);
  assert.equal(withDead.verdict, "merged");

  // Nothing passed: there is nothing on the branch to move.
  const allDead = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "failed", d: "failed" }),
    isAncestor: true,
  });
  assert.equal(allDead.allowed, false);
  assert.equal(allDead.verdict, "failed");
});

test("a terminal no-op does not hold a wave off the base", () => {
  const decision = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({ a: "passed", d: { outcome: "no-op", attempts: 1 } }),
    isAncestor: true,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.verdict, "merged");
});

test("a blocked task without a no-op verdict still holds the wave", () => {
  const decision = fastForwardDecision({
    waveTasks: ["a", "d"],
    ledger: ledgerFor({
      a: "passed",
      d: { outcome: "blocked", attempts: ATTEMPT_BUDGET },
    }),
    isAncestor: true,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.verdict, "failed");
  assert.match(decision.reason, /d did not reach a terminal outcome/);
});

test("a verifier objection never touches the fast-forward decision", () => {
  // §4: advisory. It is recorded in the digest and leads the morning report; it
  // does not hold the wave off the base branch.
  assert.equal(verifierStatus(null), "unavailable");
  assert.equal(verifierStatus({ recommendation: "inconclusive", blocking: [], notes: [] }), "unavailable");
  assert.equal(verifierStatus({ recommendation: "accept", blocking: [], notes: [] }), "clean");
  assert.equal(verifierStatus({ recommendation: "accept", blocking: ["1 must-fix item"], notes: [] }), "disputed");
  assert.equal(verifierStatus({ recommendation: "accept", blocking: [], notes: ["2 criteria not met"] }), "disputed");
  // `fastForwardDecision` takes no verifier argument at all, which is the
  // strongest form this property can be held in.
  assert.equal(fastForwardDecision.length, 1, "one destructured argument bag");
  assert.doesNotMatch(fastForwardDecision.toString(), /verifier/i);
});

// ---------------------------------------------------------------------------
// Resume (§3)
// ---------------------------------------------------------------------------

test("resume skips merged waves and replays the first that is not", () => {
  const plan = resumePlan(
    logOf(
      { id: "wave-01", outcome: "merged", baseSha: "aaa" },
      { id: "wave-02", outcome: "failed", baseSha: "bbb" },
      { id: "wave-03", outcome: "merged", baseSha: "ccc" },
    ),
  );
  assert.deepEqual(plan.mergedWaves.map((wave) => wave.id), ["wave-01"]);
  assert.equal(plan.replay.id, "wave-02");
  assert.equal(plan.replay.baseSha, "bbb", "§3: anything not merged re-runs from its recorded baseSha");
  assert.equal(plan.nextIndex, 2, "the replayed wave keeps its own number");

  const clean = resumePlan(logOf({ id: "wave-01", outcome: "merged" }, { id: "wave-02", outcome: "merged" }));
  assert.equal(clean.replay, null);
  assert.equal(clean.nextIndex, 3);
  assert.equal(resumePlan(emptyWaveLog("main")).nextIndex, 1);
  assert.equal(waveId(1), "wave-01");
  assert.equal(waveId(12), "wave-12");
});

test("recording a replayed wave replaces its entry rather than double-counting it", () => {
  // The property that makes the command idempotent: re-running must converge,
  // not accumulate. Appending instead would credit `a` six attempts after two
  // runs of three and kill it a wave early.
  const first = recordWave(emptyWaveLog("main"), { id: "wave-01", outcome: "failed", tasks: { a: { outcome: "failed", attempts: 3 } } });
  const second = recordWave(first, { id: "wave-01", outcome: "merged", tasks: { a: { outcome: "passed", attempts: 1 } } });
  assert.equal(second.waves.length, 1);
  assert.deepEqual(taskLedger(second).a, { outcome: "passed", attempts: 1 });
  const next = recordWave(second, { id: "wave-02", outcome: "merged", tasks: {} });
  assert.deepEqual(next.waves.map((wave) => wave.id), ["wave-01", "wave-02"]);
});

test("the dirty-tree guard names tracked changes only, and exempts the driver's own records", () => {
  // The fast-forward moves the ref under this checkout and the driver brings it
  // back with `reset --hard`. AGENTS.md failure mode 1 is this runner
  // destroying a user's files once already.
  //
  // Paths, not porcelain: `parseStatusPaths` is the one parser, and the
  // untracked lines are dropped before this ever sees them.
  const paths = parseStatusPaths([
    " M src/app.ts",
    "M  src/other.ts",
    "?? scratch.md",
    " M tasks/.wave-log.json",
    " M docs/afk-runs/wave-01.md",
  ].join("\n"), { includeUntracked: false });
  assert.deepEqual(
    dirtyBlockers(paths, ["tasks/.wave-log.json", "docs/afk-runs/"]),
    ["src/app.ts", "src/other.ts"],
  );
  // Untracked files are never blockers: `reset --hard` does not touch them, and
  // treating them as failures is failure mode 2.
  assert.deepEqual(parseStatusPaths("?? scratch.md", { includeUntracked: false }), []);
  assert.deepEqual(parseStatusPaths("", { includeUntracked: false }), []);
  assert.deepEqual(dirtyBlockers([], []), []);
  // A rename is ONE pathspec git will accept, never the literal `old -> new`
  // the second parser produced — that string matched no file and failed the
  // boundary stash, which fails closed and stranded the whole wave.
  assert.deepEqual(
    parseStatusPaths("R  tasks/tasks-todo/old.md -> tasks/tasks-todo/new.md", { includeUntracked: false }),
    ["tasks/tasks-todo/new.md"],
  );
});

// ---------------------------------------------------------------------------
// The digest (§4)
// ---------------------------------------------------------------------------

test("follow-up task files written during a wave are named, not scheduled", () => {
  assert.deepEqual(
    followUpFiles(["task-01.md", "task-02.md"], ["task-02.md", "task-01.md", "task-99-followup.md"]),
    ["task-99-followup.md"],
  );
  assert.deepEqual(followUpFiles(["task-01.md"], ["task-01.md"]), []);
});

test("the digest carries the dead task's reason, the undo command and the disputed criteria", () => {
  const digest = renderDigest({
    id: "wave-02",
    base: "main",
    baseSha: "deadbee",
    headSha: null,
    tasks: [
      { id: "a", outcome: "passed", attempts: 1, dead: false },
      { id: "d", outcome: "failed", attempts: 3, dead: true },
    ],
    failures: [{ id: "d", attempt: 3, command: "swift test", output: "error: no such module 'Foo'" }],
    verifier: { status: "disputed", disputed: ["criterion 2 is not met"] },
    followUps: ["task-99-followup.md"],
    fastForward: { allowed: false, verdict: "failed", reason: "d did not reach a terminal outcome" },
    halt: { halt: true, reason: "3 of 4 remaining are unreachable", orphaned: ["b", "c"] },
    archive: "/repo/.afk/archive/wave-02",
  });
  // The reason a dead task died is ON the base branch, not only in an archive
  // directory nobody opens.
  assert.match(digest, /swift test/);
  assert.match(digest, /no such module 'Foo'/);
  assert.match(digest, /\(dead: no attempts left\)/);
  // The checkpoint sha as a command, because that is what makes an advisory
  // verifier objection safe to wave through.
  assert.match(digest, /git update-ref refs\/heads\/main deadbee/);
  assert.match(digest, /criterion 2 is not met/);
  assert.match(digest, /advisory/);
  assert.match(digest, /task-99-followup\.md/);
  assert.match(digest, /## Halted/);
  assert.match(digest, /not moved onto the base/);
  // Never a --force anywhere in the record an operator is invited to copy from.
  assert.doesNotMatch(digest, /--force/);
});

test("a clean digest says so rather than leaving the section blank", () => {
  const digest = renderDigest({
    id: "wave-01",
    base: "main",
    baseSha: "aaa",
    headSha: "bbb",
    tasks: [{ id: "a", outcome: "passed", attempts: 1, dead: false }],
    fastForward: { allowed: true, verdict: "merged", reason: "1 of 1 task(s) passed" },
  });
  assert.match(digest, /Nothing failed\./);
  assert.match(digest, /nothing disputed/);
  assert.match(digest, /base moved to `bbb`/);
  assert.match(digest, /outcome: \*\*merged\*\*/);
});

// ---------------------------------------------------------------------------
// The CLI edge — as far as the driver goes without an overnight epic
// ---------------------------------------------------------------------------

const runAfk = (...argv) =>
  spawnSync(process.execPath, [afk, ...argv], { cwd: repoRoot, encoding: "utf8" });

test("`afk wave run` refuses without --base rather than defaulting to main", () => {
  // The runner's hardcoded `main` default is how a run lands on a stale base
  // without saying so; the driver has no default at all.
  const result = runAfk("wave", "run", "scripts/fixtures/wave/accepted");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /needs --base=<branch>/);
  assert.doesNotMatch(result.stdout, /not built yet/, "the driver exists; the placeholder refusal must be gone");
});

test("`afk wave run` refuses a directory that does not load, before touching git", () => {
  const result = runAfk("wave", "run", "scripts/fixtures/wave/duplicate_id", "--base=main");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /duplicate_id/);
});

test("`afk wave --help` documents run, --base and --cap", () => {
  const result = runAfk("wave", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /wave run <dir>/);
  assert.match(result.stdout, /--base=<branch>/);
  assert.match(result.stdout, /--cap=<n>/);
});

// The backend choice crosses two process boundaries in wave mode: the selected
// executable starts wave.mjs, then wave.mjs starts a fresh `auto` dispatcher.
// Record the role of every fake agent invocation so this cannot pass merely
// because both CLIs happen to be logged in on the machine running the suite.
const FAKE_WAVE_AGENT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cli = path.basename(process.argv[1]);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const role = input.startsWith('You are the plan-reviewer')
    ? 'plan-review'
    : input === 'Reply with the single word: OK\\n'
      ? 'preflight'
      : input.startsWith('You are the builder')
        ? 'builder'
        : 'other';
  fs.appendFileSync(process.env.AFK_WAVE_AGENT_LOG, cli + ':' + role + '\\n');
  const fence = String.fromCharCode(96, 96, 96);
  const report = fence + 'json\\n' + JSON.stringify({ findings: [] }) + '\\n' + fence;
  const text = role === 'plan-review' ? report : role === 'preflight' ? 'OK' : 'done';
  if (cli === 'codex') {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text }) + '\\n');
  }
});
`;

const backendWaveFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-wave-backend-"));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const tasks = join(repo, "tasks", "tasks-todo");
  const log = join(dir, "agents.log");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), FAKE_WAVE_AGENT, { mode: 0o755 });
  writeFileSync(join(bin, "claude"), FAKE_WAVE_AGENT, { mode: 0o755 });
  writeFileSync(join(repo, "tasks", "GOAL.md"), "# Backend proof\n\nRun one task.\n");
  writeFileSync(join(tasks, "task-68.md"), [
    "---",
    'id: "task-68"',
    "blocked_by: []",
    "owns:",
    "  - backend-proof.txt",
    "status: ready-for-agent",
    "---",
    "",
    "# Prove the backend",
    "",
    "## Acceptance criteria",
    "",
    "Create backend-proof.txt.",
    "",
  ].join("\n"));
  writeConfig(repo, {
    maxParallel: 1,
    defaultChecks: ["test -f backend-proof.txt"],
    baselineChecks: [],
    agent: { command: "claude", runtime: "direct", timeoutMs: 10_000 },
  });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { dir, repo, bin, log };
};

const runBackendWave = (entry) => {
  const fx = backendWaveFixture();
  const result = spawnSync(process.execPath, [entry, "wave", "run", "tasks", "--base=main", "--cap=1"], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      AFK_WAVE_AGENT_LOG: fx.log,
      AFK_WORKTREE_ROOT: join(fx.dir, "worktrees"),
      AFK_EPIC_ROOT: join(fx.dir, "epics"),
    },
  });
  const agents = existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n") : [];
  rmSync(fx.dir, { recursive: true, force: true });
  return { result, agents };
};

test("`afk-codex wave run` keeps Codex for nested auto preflight and builders", () => {
  const { result, agents } = runBackendWave(afkCodex);
  assert.ok(agents.includes("codex:plan-review"), `${result.stdout}\n${result.stderr}`);
  assert.ok(agents.includes("codex:preflight"), `nested auto selected the wrong backend: ${agents.join(", ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(agents.includes("codex:builder"), `Codex never reached a builder: ${agents.join(", ")}\n${result.stdout}\n${result.stderr}`);
  assert.equal(agents.some((entry) => entry.startsWith("claude:")), false, agents.join(", "));
});

test("`afk wave run` keeps Claude for nested auto preflight and builders", () => {
  const { result, agents } = runBackendWave(afk);
  assert.ok(agents.includes("claude:plan-review"), `${result.stdout}\n${result.stderr}`);
  assert.ok(agents.includes("claude:preflight"), `nested auto selected the wrong backend: ${agents.join(", ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(agents.includes("claude:builder"), `Claude never reached a builder: ${agents.join(", ")}\n${result.stdout}\n${result.stderr}`);
  assert.equal(agents.some((entry) => entry.startsWith("codex:")), false, agents.join(", "));
});

// --- the loop, over a real repository, with the agent run faked out ---------

const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const isAncestor = (repo, ancestor, descendant) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo }).status === 0;

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-wave-driver-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, ".afk-setup"), { recursive: true });
  writeFileSync(join(repo, ".afk-setup", "config.yaml"), "defaultChecks:\n  - swift test\nmaxParallel: 3\n");
  cpSync(fixture, join(repo, "tasks"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "scaffold\n");
  // Every repo the runner drives gitignores `.afk/`; the wave archive lands there.
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return { dir, repo };
};

/**
 * Stand in for `afk auto`. Does what a real wave does to the branch — commits
 * work on it — and writes the `.afk/state.json` the driver reads back, so the
 * fast-forward, the digest and the log are exercised against real shas.
 */
const fakeRun = ({ passed = null, attempts = 1, work = true } = {}) => ({ runRoot, taskIds }) => {
  const won = passed ?? taskIds;
  if (work) {
    for (const id of won) {
      writeFileSync(join(runRoot, `${id}.txt`), "work\n");
      git(runRoot, ["add", "-A"]);
      git(runRoot, ["commit", "-qm", `${id} done`]);
    }
  }
  mkdirSync(join(runRoot, ".afk"), { recursive: true });
  writeFileSync(
    join(runRoot, ".afk", "state.json"),
    JSON.stringify({
      tasks: Object.fromEntries(taskIds.map((id) => [id, {
        lifecycle: won.includes(id) ? "passed" : "failed",
        builderAttempt: won.includes(id) ? 1 : attempts,
      }])),
    }),
  );
  return { status: 0 };
};

const driverIo = (dir, run, planReview) => ({
  runWave: run,
  // The reviewer is faked at its seam, exactly like `afk auto` above: these
  // tests are about the driver's loop, and a real plan review would be an API
  // call per wave. A clean verdict is the default so every pre-existing case
  // reads unchanged; the refusal cases below pass their own.
  planReview: planReview ?? (() => ({ ok: true, status: "clean", message: "no contradiction between the DAG and the issues" })),
  makeWorktree: ({ root, branch, epicId }) => {
    const worktree = join(dir, "worktrees", epicId);
    git(root, ["worktree", "add", "-q", worktree, branch]);
    return { worktree, reused: false };
  },
  removeWorktree: ({ root, worktree }) => { git(root, ["worktree", "remove", "--force", worktree]); },
});

// ---------------------------------------------------------------------------
// The plan-review gate (§2)
// ---------------------------------------------------------------------------

test("a plan-review verdict blocks a wave on exactly the epic path's rule", () => {
  // `cliEpic` blocks on `!outcome.ok` and does not discriminate between a
  // contradiction, a dead login and a reviewer that returned nothing usable.
  // The wave must not invent a second, quieter policy for the same question.
  assert.equal(planReviewDecision({ ok: true, status: "clean", message: "fine" }).allowed, true);
  assert.equal(
    planReviewDecision({ ok: true, status: "clean", warnings: [{}], message: "fine" }).allowed,
    true,
    "a warning is a decision the human already made by starting the run; it does not block",
  );
  for (const status of ["contradiction", "auth_failure", "unusable"]) {
    const decision = planReviewDecision({ ok: false, status, message: `refused: ${status}` });
    assert.equal(decision.allowed, false, `${status} must block`);
    assert.equal(decision.status, status);
    assert.match(decision.reason, new RegExp(status));
  }
  // Fail closed: "no review ran" is not "a review found nothing".
  const missing = planReviewDecision(null);
  assert.equal(missing.allowed, false);
  assert.equal(missing.status, "unavailable");
  assert.match(missing.reason, /did not run/);
});

test("a plan review that refuses a multi-wave graph cuts no branch and creates no worktree", async () => {
  // THE ORDERING TEST, over a graph that takes more than one wave.
  // `plan-review.mjs`'s governing sentence is "a contradiction aborts before any
  // branch or worktree exists", and `cliEpic` keeps it by running the review
  // above `git branch`. A run that reviewed after cutting would leave a
  // `wave-01` ref behind on every refusal — and the next run reuses an existing
  // wave branch rather than re-cutting it, so the refused graph would be
  // silently adopted as if it had been approved.
  //
  // AND the reviewer must have been shown the WHOLE graph when it refused. The
  // first live wave run refused wave 1 with "no child task builds the CLI wire"
  // for a CLI that was `task-06-cli` in wave 3: correct about the three root
  // tasks it was handed, wrong about the project. The fixture has the same
  // shape — GOAL.md is "Repo picker" and `task-02-picker` is in wave 2 — so a
  // refusal that only ever saw wave 1 is a refusal for work wave 2 does.
  const { dir, repo } = makeRepo();
  const said = [];
  const seen = [];
  let ran = 0;
  let worktrees = 0;
  const io = driverIo(dir, (...args) => { ran += 1; return fakeRun()(...args); }, (args) => {
    seen.push(args);
    return {
      ok: false,
      status: "contradiction",
      message: "1 contradiction between the DAG and the issues",
      contradictions: [{ kind: "unsatisfied_criterion", tasks: [], message: "nothing builds the picker" }],
    };
  });
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: { ...io, makeWorktree: (args) => { worktrees += 1; return io.makeWorktree(args); } },
    say: (line) => said.push(line),
  });

  assert.equal(status, 1);
  assert.equal(seen.length, 1, "the refusing review must be the run's one review, not wave 1's");
  assert.deepEqual(
    seen[0].dag.tasks.map((task) => task.id).sort(),
    ["task-01-model", "task-02-picker", "task-03-docs"],
    "the reviewer refused while holding only part of the graph — the wave-01 false refusal",
  );
  assert.match(said.join("\n"), /plan review refused tasks \(contradiction\)/);
  assert.match(said.join("\n"), /no branch, worktree or lane was created/);
  assert.equal(ran, 0, "no lane may run after a refusal");
  assert.equal(worktrees, 0, "no worktree may be created after a refusal");
  assert.equal(git(repo, ["branch", "--list", "wave-*"]), "", "a refused wave left a branch behind");
  assert.equal(
    spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.match(/^worktree /gm).length,
    1,
    "a refused wave left a worktree behind",
  );
  // Nothing recorded, nothing committed: the repository is as it was.
  assert.equal(existsSync(waveLogPath(join(repo, "tasks"))), false);
  assert.equal(existsSync(join(repo, "docs", "afk-runs")), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(dir, { recursive: true, force: true });
});

test("the reviewer is given GOAL.md and EVERY task in the directory, once, with real edges", async () => {
  // §2's guarantee, end to end: "GOAL.md becomes the epic body handed to the
  // plan reviewer — the thing a wave is checked against. Without it, review has
  // only the tasks, and comparing tasks to tasks produces confident nonsense."
  //
  // THE TEST THAT MATTERS. The fixture is a two-wave graph whose SECOND wave
  // carries the task GOAL.md is named after: wave 1 is {task-01-model,
  // task-03-docs} and the picker is wave 2. Show the reviewer wave 1 alone and
  // it is entitled to refuse — nothing in front of it builds a picker — which
  // is exactly how the first live run died on `unsatisfied_criterion` for a CLI
  // sitting in wave 3. The review must therefore hold all three tasks at once,
  // and must run once for the run rather than once per wave: §4 freezes the
  // graph at t0, so the second ask would be the same question with less shown.
  const { dir, repo } = makeRepo();
  const goal = readFileSync(join(repo, "tasks", "GOAL.md"), "utf8");
  const seen = [];
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun(), (args) => {
      // No wave branch exists yet at the moment the reviewer is called.
      assert.equal(
        git(repo, ["branch", "--list", "wave-*"]),
        "",
        "a wave branch already existed when the reviewer ran",
      );
      seen.push(args);
      return { ok: true, status: "clean", message: "no contradiction between the DAG and the issues" };
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  assert.equal(seen.length, 1, "the review runs once per run, not once per wave");
  // The epic body is GOAL.md itself, not the title and not a task body.
  assert.equal(seen[0].dag.epic.body, goal);
  assert.equal(seen[0].dag.epic.title, "Repo picker");
  assert.deepEqual(
    seen[0].dag.tasks.map((task) => task.id).sort(),
    ["task-01-model", "task-02-picker", "task-03-docs"],
    "every task in the directory is in front of the reviewer, including the later waves' ones",
  );
  // Real edges, not the stripped ones the run is handed: telling the reviewer
  // that task-02 is a root invites a `missing_dependency` for a model that is
  // already merged onto the branch the wave it depends on was cut from.
  assert.deepEqual(
    seen[0].dag.tasks.find((task) => task.id === "task-02-picker").dependsOn,
    ["task-01-model"],
  );
  // Full task text, which is what the three questions are asked about.
  assert.match(seen[0].dag.tasks[0].body, /^# /);
  assert.equal(seen[0].runDir, join(repo, ".afk", "plan-review", "wave"));
  // Recorded on the log, top-level: the run reviewed its graph, not a wave.
  const reviewed = readWaveLog(join(repo, "tasks"), "main").planReview;
  assert.equal(reviewed.status, "clean");
  assert.equal(reviewed.tasks, 3);
  assert.ok(reviewed.reviewedAt, "the review must record when it happened");
  // The reviewer's own rendering — accepted warnings, findings the graph
  // refuted, and where the decision record was appended — has somewhere to go.
  // Only `ok`/`status`/`message` reach the verdict; the rest is the operator's
  // only account of what was reviewed, and `cliEpic` prints all of it.
  assert.equal(typeof seen[0].say, "function");
  rmSync(dir, { recursive: true, force: true });
});

test("a resumed run does not review a second time", async () => {
  // The graph is frozen at t0 (§4), so a run resuming a crashed wave is resuming
  // a decomposition that has already been reviewed and cannot have changed. A
  // second review is one paid agent session that can only re-derive the first
  // verdict. `log.planReview` is the memory, and the wave log is the only state
  // that crosses a wave boundary (§3).
  const { dir, repo } = makeRepo();
  let reviews = 0;
  const review = () => { reviews += 1; return { ok: true, status: "clean", message: "fine" }; };

  // Wave 1 crashes: task-03 passes, task-01 fails with attempts still on the
  // clock, so the wave is withheld and the log is written but not committed.
  await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun({ passed: ["task-03-docs"], attempts: 1 }), review),
    say: () => {},
  });
  assert.equal(reviews, 1, "the first run reviews once");
  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.equal(log.waves[0].outcome, "failed");
  assert.equal(log.planReview.status, "clean", "the review must survive a withheld wave");

  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun(), review),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.equal(reviews, 1, "a resumed run must not pay for a second review of a frozen graph");
  assert.match(said.join("\n"), /plan review already recorded \(clean/);
  // And the resumed run still ran: this is not a test that passes by doing
  // nothing. Both remaining waves landed on the base branch.
  const after = readWaveLog(join(repo, "tasks"), "main");
  assert.deepEqual(after.waves.map((wave) => wave.outcome), ["merged", "merged"]);
  rmSync(dir, { recursive: true, force: true });
});

test("the driver runs the graph in waves, fast-forwards the base, and records every one", async () => {
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun()), say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  // Two waves: {task-01, task-03} then {task-02}, because task-02's edge is
  // only satisfied once task-01 has passed.
  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.deepEqual(log.waves.map((wave) => wave.id), ["wave-01", "wave-02"]);
  assert.deepEqual(Object.keys(log.waves[0].tasks).sort(), ["task-01-model", "task-03-docs"]);
  assert.deepEqual(Object.keys(log.waves[1].tasks), ["task-02-picker"]);
  assert.deepEqual(log.waves.map((wave) => wave.outcome), ["merged", "merged"]);
  assert.equal(log.base, "main");

  // The base branch really moved, and it moved to the wave branch. `main` is one
  // commit further on: the log and the digest are committed to it afterwards.
  assert.equal(log.waves[1].headSha, git(repo, ["rev-parse", "wave-02"]));
  assert.ok(isAncestor(repo, "wave-02", "main"), "main is not descended from the wave it fast-forwarded to");
  // Every task's work is on the base branch.
  for (const id of ["task-01-model", "task-02-picker", "task-03-docs"]) {
    assert.ok(existsSync(join(repo, `${id}.txt`)), `${id} is not on main`);
  }
  // The digests and the log are committed, not left dirty.
  assert.match(readFileSync(join(repo, "docs", "afk-runs", "wave-01.md"), "utf8"), /outcome: \*\*merged\*\*/);
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the driver left the tree dirty");
  assert.match(git(repo, ["log", "-1", "--format=%s"]), /afk wave: wave-02 merged/);
  rmSync(dir, { recursive: true, force: true });
});

test("re-running the driver skips merged waves and does nothing else", async () => {
  // The 3am-crash property: idempotent. The second run must converge, not
  // repeat work whose commits are already on the base branch.
  const { dir, repo } = makeRepo();
  await cliWaveRun({ root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: () => {} });
  const head = git(repo, ["rev-parse", "main"]);
  const before = readFileSync(waveLogPath(join(repo, "tasks")), "utf8");

  const said = [];
  let ran = 0;
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (...args) => { ran += 1; return fakeRun()(...args); }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.equal(ran, 0, "a merged wave must not be run again");
  assert.match(said.join("\n"), /wave-01, wave-02 already merged and skipped/);
  assert.equal(git(repo, ["rev-parse", "main"]), head, "the base branch moved on a no-op re-run");
  assert.equal(readFileSync(waveLogPath(join(repo, "tasks")), "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("a wave whose base moved underneath it is refused, and the base is left where it is", async () => {
  // The ancestor assertion, end to end. A commit lands on `main` while the wave
  // is running; `git merge-base --is-ancestor main wave-01` then fails and the
  // driver stops rather than discarding it.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      const result = fakeRun()(args);
      // A human pushed to main during the wave.
      writeFileSync(join(repo, "hotfix.txt"), "urgent\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "hotfix"]);
      return result;
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  assert.match(said.join("\n"), /not an ancestor/);
  // The record is written but NOT committed: committing it would move `main`
  // past the sha a replay resumes from, and the ancestor assertion would then
  // fail forever against a base the driver moved itself.
  assert.match(git(repo, ["log", "-1", "--format=%s", "main"]), /hotfix/);
  assert.match(readFileSync(join(repo, "docs", "afk-runs", "wave-01.md"), "utf8"), /not an ancestor/);
  assert.match(git(repo, ["status", "--porcelain", "-uall"]), /docs\/afk-runs\/wave-01\.md/);
  // The hotfix survived: nothing was forced over it.
  assert.ok(existsSync(join(repo, "hotfix.txt")));
  assert.ok(!existsSync(join(repo, "task-01-model.txt")), "the wave's work must not be on main");
  // And the wave branch is left in place for a human.
  assert.equal(git(repo, ["rev-parse", "--verify", "wave-01"]).length, 40);
  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.equal(log.waves[0].outcome, "halted");
  assert.equal(log.waves[0].headSha, null);
  rmSync(dir, { recursive: true, force: true });
});

test("a dead task's evidence reaches the digest, and the halt rule stops the night", async () => {
  // task-01 dies with its attempts spent, which orphans task-02. Two of the
  // three outstanding tasks are then unreachable, so the driver halts — and the
  // reason task-01 died is on the base branch, copied out of `.afk/` before it
  // was archived.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      const result = fakeRun({ passed: ["task-03-docs"], attempts: ATTEMPT_BUDGET })(args);
      const runDir = join(args.runRoot, ".afk", "runs", "task-01-model", `builder-${ATTEMPT_BUDGET}`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "verification.json"), JSON.stringify({
        attempt: ATTEMPT_BUDGET,
        checks: [{ command: "swift test", code: 1, output: "error: cannot find 'Repository' in scope" }],
      }));
      return result;
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  assert.match(said.join("\n"), /halting/);

  const digest = readFileSync(join(repo, "docs", "afk-runs", "wave-01.md"), "utf8");
  assert.match(digest, /cannot find 'Repository' in scope/, "the dead task's reason is only in the archive");
  assert.match(digest, /task-01-model` — \*\*failed\*\* after 3 attempts \(dead: no attempts left\)/);
  assert.match(digest, /## Halted/);
  // The passing sibling still landed: a dead task does not strand its siblings.
  assert.ok(isAncestor(repo, "wave-01", "main"));
  assert.ok(existsSync(join(repo, "task-03-docs.txt")));
  // And the run's artifacts survived the worktree's removal.
  assert.ok(existsSync(join(repo, ".afk", "archive", "wave-01", "runs")));
  assert.ok(!existsSync(join(dir, "worktrees", "wave-01")));
  rmSync(dir, { recursive: true, force: true });
});

test("a crashed wave is replayed from its recorded sha, and only its unfinished tasks re-run", async () => {
  const { dir, repo } = makeRepo();
  // Wave 1: task-03 passes, task-01 fails with attempts still on the clock —
  // the shape of a run that died rather than a ticket that cannot be built.
  await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun({ passed: ["task-03-docs"], attempts: 1 })),
    say: () => {},
  });
  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.equal(log.waves[0].outcome, "failed", "an unfinished wave is not merged");
  assert.equal(log.waves[0].headSha, null, "an unfinished wave records no head");
  assert.ok(!isAncestor(repo, "wave-01", "main"), "an unfinished wave must not reach the base branch");
  assert.ok(!existsSync(join(repo, "task-03-docs.txt")), "its work must not be on the base branch");

  const seen = [];
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => { seen.push([...args.taskIds]); return fakeRun()(args); }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.deepEqual(seen[0], ["task-01-model"], "task-03 passed in the crashed wave and must not run again");
  const after = readWaveLog(join(repo, "tasks"), "main");
  assert.deepEqual(after.waves.map((wave) => wave.id), ["wave-01", "wave-02"], "the replayed wave keeps its number");
  assert.deepEqual(after.waves.map((wave) => wave.outcome), ["merged", "merged"]);
  // Attempts crossed the boundary: task-01 spent one in the crashed wave.
  assert.equal(taskLedger(after)["task-01-model"].attempts, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("the driver refuses to start over a dirty checkout, before creating anything", async () => {
  const { dir, repo } = makeRepo();
  writeFileSync(join(repo, "README.md"), "edited by a human\n");
  const said = [];
  assert.equal(await cliWaveRun({ root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: (line) => said.push(line) }), 1);
  assert.match(said.join("\n"), /uncommitted tracked changes/);
  assert.match(said.join("\n"), /README\.md/);
  assert.equal(git(repo, ["branch", "--list", "wave-*"]), "", "no branch may exist after a refusal");
  rmSync(dir, { recursive: true, force: true });
});

test("the driver refuses a checkout that is not on the base branch", async () => {
  const { dir, repo } = makeRepo();
  git(repo, ["checkout", "-q", "-b", "somewhere-else"]);
  const said = [];
  assert.equal(await cliWaveRun({ root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: (line) => said.push(line) }), 1);
  assert.match(said.join("\n"), /this checkout is on `somewhere-else`/);
  rmSync(dir, { recursive: true, force: true });
});

test("a log recorded against another base is refused rather than replayed onto this one", async () => {
  const { dir, repo } = makeRepo();
  writeFileSync(waveLogPath(join(repo, "tasks")), JSON.stringify(emptyWaveLog("release/2.0")));
  const said = [];
  assert.equal(await cliWaveRun({ root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: (line) => said.push(line) }), 1);
  assert.match(said.join("\n"), /records base `release\/2\.0`/);
  rmSync(dir, { recursive: true, force: true });
});

test("the digest names a check that hit its bound as a timeout, not as a red check", () => {
  // #70's criterion, on the surface a human actually reads in the morning.
  // `collectFailureEvidence` copied only `command` and `output` off the failed
  // check, so a check killed at its bound rendered as ``First failing check:
  // `swift test` `` — the flat string that sends the reader after a broken
  // assertion for a command that never returned.
  const runRoot = mkdtempSync(join(tmpdir(), "afk-wave-evidence-"));
  const dir = builderRunDir(runRoot, "task-09-panel", 1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verification.json"), JSON.stringify({
    taskId: "task-09-panel",
    attempt: 1,
    checks: [
      { command: "swift build", code: 0, output: "ok" },
      { command: "swift test", code: 124, timedOut: true, timeoutMs: 1_800_000, output: "" },
    ],
  }));

  const [evidence] = collectFailureEvidence(runRoot, {
    "task-09-panel": { outcome: "failed", attempts: 1 },
  });
  assert.equal(evidence.command, "swift test");
  assert.equal(evidence.reason, "check timed out after 1800s: swift test");

  const digest = renderDigest({
    id: "wave-09",
    base: "main",
    baseSha: "deadbee",
    tasks: [{ id: "task-09-panel", outcome: "failed", attempts: 1, dead: true }],
    failures: [evidence],
    fastForward: { allowed: false, verdict: "failed", reason: "task-09-panel did not reach a terminal outcome" },
  });
  assert.match(digest, /check timed out after 1800s: swift test/);
  assert.equal(
    digest.includes("First failing check: `swift test`"),
    false,
    "the digest still calls a killed check a failing one",
  );
  rmSync(runRoot, { recursive: true, force: true });
});

test("a check that genuinely failed still reads as the first failing check", () => {
  // The regression control on the wording every other surface shares.
  const runRoot = mkdtempSync(join(tmpdir(), "afk-wave-evidence-red-"));
  const dir = builderRunDir(runRoot, "task-09-panel", 1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verification.json"), JSON.stringify({
    checks: [{ command: "swift test", code: 1, output: "error: no such module 'Foo'" }],
  }));
  const [evidence] = collectFailureEvidence(runRoot, {
    "task-09-panel": { outcome: "failed", attempts: 1 },
  });
  assert.equal(evidence.reason, null);
  const digest = renderDigest({
    id: "wave-09", base: "main", baseSha: "deadbee",
    tasks: [{ id: "task-09-panel", outcome: "failed", attempts: 1, dead: true }],
    failures: [evidence],
    fastForward: { allowed: false, verdict: "failed", reason: "it did not finish" },
  });
  assert.match(digest, /First failing check: `swift test`/);
  rmSync(runRoot, { recursive: true, force: true });
});

test("state read back off a run reports pending for a task the run never touched", () => {
  const { dir, repo } = makeRepo();
  assert.deepEqual(waveTaskResults(repo, ["nope"]), { nope: { outcome: "pending", attempts: 0 } });
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Filing a passed task's file under tasks-done/ (§1)
// ---------------------------------------------------------------------------

const filedDag = {
  epic: { id: "wave", title: "t" },
  branch: "wave",
  tasks: [{ id: "task-01-a", dependsOn: [] }, { id: "task-02-b", dependsOn: ["task-01-a"] }],
};

test("only a passed task's file is filed, and a failed one stays in tasks-todo/", () => {
  // ONE BIT, DONE OR NOT. There is no tasks-failed/: a third directory would be
  // a second lifecycle vocabulary competing with the wave log.
  assert.deepEqual(
    doneFileMoves({
      dag: filedDag,
      ledger: { "task-01-a": { outcome: "passed", attempts: 1 }, "task-02-b": { outcome: "failed", attempts: 3 } },
      todoFiles: ["task-01-a.md", "task-02-b.md"],
      doneFiles: [],
    }),
    ["task-01-a.md"],
  );
});

test("filing is idempotent: an already-filed task yields no move", () => {
  assert.deepEqual(
    doneFileMoves({
      dag: filedDag,
      ledger: { "task-01-a": { outcome: "passed", attempts: 1 } },
      todoFiles: ["task-02-b.md"],
      doneFiles: ["task-01-a.md"],
    }),
    [],
  );
  // And a file present on BOTH sides moves nothing: that is corruption this
  // cannot repair, and the loader refuses the directory for it with
  // `duplicate_id`. Deleting one here would destroy the evidence.
  assert.deepEqual(
    doneFileMoves({
      dag: filedDag,
      ledger: { "task-01-a": { outcome: "passed", attempts: 1 } },
      todoFiles: ["task-01-a.md"],
      doneFiles: ["task-01-a.md"],
    }),
    [],
  );
});

test("the ledger decides, not the wave: a task that passed waves ago is still filed", () => {
  // State is authoritative and the files are a rendering of it, so a tree that
  // fell behind — a crash between the fast-forward and the commit — converges
  // on the next merged wave rather than staying stale forever.
  assert.deepEqual(
    doneFileMoves({
      dag: filedDag,
      ledger: {
        "task-01-a": { outcome: "passed", attempts: 1 },
        "task-02-b": { outcome: "passed", attempts: 1 },
      },
      todoFiles: ["task-01-a.md", "task-02-b.md"],
      doneFiles: [],
    }),
    ["task-01-a.md", "task-02-b.md"],
  );
});

test("a merged wave files its passed tasks' files in the bookkeeping commit, not the merge", async () => {
  // The bug a live run found: `docs/wave-mode.md` §1 promised tasks-done/ and
  // nothing implemented it, so seven task files sat in tasks-todo/ across two
  // merged waves and the tree reported that nothing had happened.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun()), say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  const done = join(repo, "tasks", "tasks-done");
  assert.deepEqual(
    readdirSync(done).sort(),
    ["task-01-model.md", "task-02-picker.md", "task-03-docs.md"],
    "every passed task's file must be filed under tasks-done/",
  );
  assert.deepEqual(
    existsSync(join(repo, "tasks", "tasks-todo")) ? readdirSync(join(repo, "tasks", "tasks-todo")) : [],
    [],
    "nothing may be left behind in tasks-todo/",
  );
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the moves must be committed, not left dirty");

  // A BOOKKEEPING commit, not the integration merge. The commit that carries
  // the moves is the same one that carries the log and the digest, and it is
  // not a merge commit — so `git show` of a lane merge is still only the diff a
  // reviewer cares about.
  const head = git(repo, ["log", "-1", "--format=%s%n%P"]).split("\n");
  assert.match(head[0], /afk wave: wave-02 merged/);
  assert.equal(head[1].split(" ").length, 1, "the bookkeeping commit must not be a merge commit");
  const names = git(repo, ["show", "--name-status", "--format=", "HEAD"]);
  assert.match(names, /R\d*\s+tasks\/tasks-todo\/task-02-picker\.md\s+tasks\/tasks-done\/task-02-picker\.md/);
  assert.match(names, /tasks\/\.wave-log\.json/);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed task's file stays in tasks-todo/ while its passing siblings are filed", async () => {
  // task-01 dies with its attempts spent; task-03 passes. The wave still merges
  // — a dead task must not strand a passing sibling — and the tree must say
  // exactly that: one file filed, one still to do, and no third directory.
  const { dir, repo } = makeRepo();
  const said = [];
  await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun({ passed: ["task-03-docs"], attempts: ATTEMPT_BUDGET })),
    say: (line) => said.push(line),
  });
  assert.deepEqual(readdirSync(join(repo, "tasks", "tasks-done")), ["task-03-docs.md"]);
  assert.deepEqual(
    readdirSync(join(repo, "tasks", "tasks-todo")).sort(),
    ["task-01-model.md", "task-02-picker.md"],
    "a failed task keeps its file in tasks-todo/",
  );
  assert.ok(!existsSync(join(repo, "tasks", "tasks-failed")), "there is no tasks-failed/");
  rmSync(dir, { recursive: true, force: true });
});

test("a withheld wave files nothing", async () => {
  // The move is bound by the same "only when the wave merged" rule as the log
  // and the digest: a commit here would move the base past the `baseSha` the
  // replay resumes from, and the wave could never land.
  const { dir, repo } = makeRepo();
  await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun({ passed: ["task-03-docs"], attempts: 1 })),
    say: () => {},
  });
  assert.equal(readWaveLog(join(repo, "tasks"), "main").waves[0].outcome, "failed");
  assert.ok(!existsSync(join(repo, "tasks", "tasks-done")), "a withheld wave must file nothing");
  assert.ok(existsSync(join(repo, "tasks", "tasks-todo", "task-03-docs.md")));
  rmSync(dir, { recursive: true, force: true });
});

test("a run resumes across a split directory: the graph reloads and the remaining waves land", async () => {
  // THE TEST THIS CHANGE EXISTS FOR. After wave 1 merges, task-01-model's file
  // is in tasks-done/ and task-02-picker's `blocked_by` still names it. A
  // loader scoped to tasks-todo/ alone reads that as `dangling_edge`, refuses
  // the WHOLE directory, and the run can never be resumed — a night that merged
  // two waves lost to a file move.
  const { dir, repo } = makeRepo();
  // Wave 1 merges {task-01-model, task-03-docs}; the run then stops as if the
  // machine had died, before wave 2.
  const first = driverIo(dir, fakeRun());
  let worktrees = 0;
  await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: {
      ...first,
      // The machine dies at the wave-02 boundary, before anything for it is
      // created — so what the resume opens is exactly the tree wave 1 left.
      makeWorktree: (args) => {
        worktrees += 1;
        if (worktrees > 1) throw new Error("the machine died");
        return first.makeWorktree(args);
      },
    },
    say: () => {},
  }).catch(() => {});
  assert.deepEqual(readdirSync(join(repo, "tasks", "tasks-done")).sort(), ["task-01-model.md", "task-03-docs.md"]);
  assert.deepEqual(readdirSync(join(repo, "tasks", "tasks-todo")), ["task-02-picker.md"]);
  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.equal(log.waves[0].outcome, "merged");

  // The directory the resume opens is the split one. It must load, produce the
  // same graph, and run only what is left.
  const seen = [];
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => { seen.push([...args.taskIds]); return fakeRun()(args); }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.deepEqual(seen, [["task-02-picker"]], "the resumed run must schedule only the unfinished task");
  assert.deepEqual(
    readWaveLog(join(repo, "tasks"), "main").waves.map((wave) => wave.outcome),
    ["merged", "merged"],
  );
  assert.deepEqual(
    readdirSync(join(repo, "tasks", "tasks-done")).sort(),
    ["task-01-model.md", "task-02-picker.md", "task-03-docs.md"],
  );
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The bookkeeping commit: it discards nothing and it adopts nothing (#72)
// ---------------------------------------------------------------------------

test("an uncommitted edit made DURING a wave survives every boundary", async () => {
  // THE DATA LOSS. `reset --hard HEAD` after the ref move destroyed any tracked
  // modification a human made while the wave was running, with no error. On
  // quillnote two edits vanished in one night, and one of them was the
  // `blocked_by` edge that repaired an `owns` collision — so losing it also put
  // the task directory back into a state `afk wave validate` refuses, which
  // stops the next cut. There is no window to commit in instead: a commit on
  // the base mid-wave breaks the ancestor assertion and strands the wave.
  const { dir, repo } = makeRepo();
  const edit = "edited by a human at 2am, mid-wave\n";
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      // The human edits a tracked file in the base checkout while a lane runs.
      if (!readFileSync(join(repo, "README.md"), "utf8").includes("2am")) writeFileSync(join(repo, "README.md"), edit);
      return fakeRun()(args);
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), edit, "the edit was discarded by the fast-forward");
  assert.match(git(repo, ["status", "--porcelain"]), /M README\.md/, "the edit must still be the human's to commit");
  assert.match(said.join("\n"), /carried 1 uncommitted change\(s\) across the wave-01 boundary: README\.md/);
  // And it is NOT in the driver's commit: the runner commits what it wrote.
  assert.equal(git(repo, ["show", "--name-only", "--format=", "HEAD"]).includes("README.md"), false);
  assert.equal(git(repo, ["stash", "list"]), "", "the stash must be popped, not left behind");
  rmSync(dir, { recursive: true, force: true });
});

test("a file RENAMED during a wave crosses the boundary instead of stranding the wave", async () => {
  // A real `git mv`, because a hand-written porcelain string is how this was
  // missed. `R  old -> new` was turned into the pathspec `old -> new`, git
  // matched no file, `stash push` exited non-zero — and the stash guard fails
  // closed, so the fast-forward was refused and a human renaming a task file at
  // 2am lost the whole night. That is #72's outcome through a different door.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      if (existsSync(join(repo, "README.md")))
        git(repo, ["mv", "README.md", "READINGS.md"]);
      return fakeRun()(args);
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  assert.equal(existsSync(join(repo, "READINGS.md")), true, "the renamed file was lost at the boundary");
  assert.equal(existsSync(join(repo, "README.md")), false, "the rename was undone at the boundary");
  assert.match(said.join("\n"), /carried 1 uncommitted change\(s\) across the wave-01 boundary: READINGS\.md/);
  assert.equal(
    said.join("\n").includes("could not be stashed first"),
    false,
    "the boundary stash must not refuse a rename",
  );
  // Still the human's to commit, and not swept into the driver's own commit.
  assert.match(git(repo, ["status", "--porcelain"]), /READINGS\.md/);
  assert.equal(git(repo, ["log", "--all", "--format=", "--name-only"]).includes("READINGS.md"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("an edit the wave itself changed is kept in a named stash, not lost and not left conflicting", async () => {
  // The other half of the fail direction. A stash that cannot be POPPED leaves
  // the tree clean at the new HEAD rather than in conflict — a conflicted base
  // checkout would refuse every remaining wave of the night — and the edit is a
  // real commit in the object store either way, so it is named, not dropped.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      const result = fakeRun()(args);
      // The wave touches the same file the human is editing.
      writeFileSync(join(repo, "README.md"), `the human's line, ${args.branch}\n`);
      writeFileSync(join(args.runRoot, "README.md"), `the wave's line, ${args.branch}\n`);
      git(args.runRoot, ["commit", "-qam", `${args.branch} edits README`]);
      return result;
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  assert.match(said.join("\n"), /conflict with wave-01 and were NOT re-applied/);
  assert.match(said.join("\n"), /afk wave: wave-01 boundary/);
  assert.match(git(repo, ["stash", "list"]), /afk wave: wave-01 boundary/, "the edit must survive as a stash");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "the wave's line, wave-02\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the base checkout must be left clean, never conflicted");
  // Recoverable, and it is the human's line that comes back.
  git(repo, ["stash", "show", "-p", "stash@{0}"]);
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked file written during a wave is not swept into the driver's commit", async () => {
  // THE ADOPTION. `git add tasks/tasks-todo` swept every untracked file under
  // it into a commit authored by the human whose message says only that a wave
  // merged: quillnote 45add77 carries two unreviewed agent-authored draft task
  // files that way. The driver commits what the driver wrote.
  const { dir, repo } = makeRepo();
  const draft = join(repo, "tasks", "tasks-todo", "task-99-draft.md");
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      if (!existsSync(draft)) writeFileSync(draft, "# task-99\n\nan agent's follow-up, not reviewed by anyone\n");
      return fakeRun()(args);
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  const stat = git(repo, ["show", "--stat", "--format=%s", "HEAD"]);
  assert.match(stat, /afk wave: wave-02 merged/);
  assert.equal(stat.includes("task-99-draft"), false, `the draft was adopted by the merge commit:\n${stat}`);
  assert.equal(
    git(repo, ["log", "--all", "--format=", "--name-only"]).includes("task-99-draft"),
    false,
    "the draft reached the history under the human's name",
  );
  assert.match(git(repo, ["status", "--porcelain", "-uall"]), /^\?\? tasks\/tasks-todo\/task-99-draft\.md$/m);
  assert.ok(existsSync(draft), "an untracked file must be left where it was written, not removed either");
  // The driver's own records still landed.
  const names = git(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["docs/afk-runs/wave-02.md", "tasks/.wave-log.json", "tasks/tasks-done/task-02-picker.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked file at a path the wave tip also tracks survives the boundary (#91)", async () => {
  // THE CLOBBER. `reset --hard` leaves untracked files alone — but only where
  // the target tree does NOT track the path. A human and a lane both working
  // from the same task list write the same new path; the wave tip then tracks
  // it, and the reset overwrote the human's copy with the wave's, silently.
  // #72 stashed only tracked edits, so this one path fell straight through.
  const { dir, repo } = makeRepo();
  const human = "the human's own draft at 2am, mid-wave\n";
  const said = [];
  let collidePath = null;
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      // On the first wave, the human writes an untracked file at the SAME path
      // this lane is about to commit (`fakeRun` writes `<id>.txt`).
      if (collidePath === null) {
        collidePath = `${args.taskIds[0]}.txt`;
        writeFileSync(join(repo, collidePath), human);
      }
      return fakeRun()(args);
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));

  // The wave's version is on the branch — the reset materialised it, as before.
  assert.equal(git(repo, ["log", "--all", "--format=", "--name-only"]).includes(collidePath), true);
  // The human's copy is NOT destroyed: it is carried into the named stash, and
  // the boundary says so rather than overwriting in silence.
  assert.match(said.join("\n"), /conflict with wave-01 and were NOT re-applied/);
  assert.match(said.join("\n"), new RegExp(`afk wave: wave-01 boundary`));
  assert.match(git(repo, ["stash", "list"]), /afk wave: wave-01 boundary/, "the human's untracked file must survive as a stash");
  assert.match(git(repo, ["stash", "show", "-p", "--include-untracked", "stash@{0}"]), /2am, mid-wave/, "the stash carries the human's own content");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A cut never adopts an existing wave branch (#74)
// ---------------------------------------------------------------------------

test("the branch decision recreates what carries nothing and refuses what might", () => {
  // `-B` is not the fix and never was: an existing wave branch can carry a
  // replayed wave's lane merges. `waveHasMergedWork` is the distinguishing
  // fact, because `passed` is the only outcome that puts a commit there.
  assert.equal(waveHasMergedWork(undefined), false);
  assert.equal(waveHasMergedWork({ tasks: { a: { outcome: "pending", attempts: 0 } } }), false);
  assert.equal(waveHasMergedWork({ tasks: { a: { outcome: "failed", attempts: 3 } } }), false);
  assert.equal(waveHasMergedWork({ tasks: { a: { outcome: "no-op" }, b: { outcome: "passed" } } }), true);

  const cut = waveBranchDecision({ id: "wave-31", branchSha: null, baseSha: "aaaaaaaa", hasRecord: false, hasMergedWork: false });
  assert.equal(cut.action, "cut");

  // quillnote wave-31: baseline died before any lane ran, branch survived at
  // its original base, and the next cut adopted it silently.
  const stale = waveBranchDecision({ id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb", hasRecord: true, hasMergedWork: false, baseIsAncestor: false });
  assert.equal(stale.action, "recreate");
  assert.match(stale.reason, /wave-31/);
  assert.match(stale.reason, /cc58a9d/, "the refusal must name the branch's sha");

  // A branch that DOES carry lane merges is never discarded by the driver.
  const diverged = waveBranchDecision({ id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb", hasRecord: true, hasMergedWork: true, baseIsAncestor: false });
  assert.equal(diverged.action, "refuse");
  assert.match(diverged.reason, /cc58a9d/);
  assert.match(diverged.reason, /bbbbbbb/);
  assert.match(diverged.reason, /git branch -D wave-31/);

  const replay = waveBranchDecision({ id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb", hasRecord: true, hasMergedWork: true, baseIsAncestor: true });
  assert.equal(replay.action, "reuse");
  assert.match(replay.reason, /earlier lane merges are kept/);

  // NO RECORD AT ALL is the third case, and it is not the first one. Both
  // arguments below are the `recreate` case above with the record taken away —
  // which is the salvage procedure's tree, and used to delete the branch.
  const salvaged = waveBranchDecision({ id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb", hasRecord: false, hasMergedWork: false, branchAheadOfBase: true, baseIsAncestor: false });
  assert.equal(salvaged.action, "refuse");
  assert.match(salvaged.reason, /no record of it/);
  assert.match(salvaged.reason, /cc58a9d/, "the refusal must name the branch's sha");
  assert.match(salvaged.reason, /git branch -D wave-31/);

  // The one no-record branch that is safe to clear: a driver killed between the
  // cut and the record, so git itself says there is nothing on it. Refusing
  // here would strand every crash-resume.
  const halfCut = waveBranchDecision({ id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb", hasRecord: false, hasMergedWork: false, branchAheadOfBase: false, baseIsAncestor: true });
  assert.equal(halfCut.action, "recreate");
  assert.match(halfCut.reason, /no commit the base branch does not already have/);

  // `salvaged` above answers only "ahead of base" and never "whose commits" —
  // an unanswered question must read as somebody's work, never as safe to
  // delete. That is what makes `branchWorkAheadOfBase` default to true.
  assert.equal(salvaged.action, "refuse");
});

test("a wave branch carrying nothing but the runner's own bookkeeping is resumed, not refused", () => {
  // THE CRASH-RESUME, which the arm above refused outright. `flushStatuses`
  // commits `docs/progress.md`, the ledger and
  // `.afk-runs/<id>/integration-verification.json` with `--no-verify` from the
  // FAILURE paths too, so a driver killed after any lane failed leaves a wave
  // branch ahead of its base with no record — and "ahead of base" was read as
  // "somebody's work", ending the night and advising `git branch -D` on the
  // only copy of that night's evidence.
  const resumed = waveBranchDecision({
    id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb",
    hasRecord: false, hasMergedWork: false,
    branchAheadOfBase: true, branchWorkAheadOfBase: false, baseIsAncestor: true,
  });
  assert.equal(resumed.action, "reuse");
  assert.match(resumed.reason, /the runner's own bookkeeping/);
  assert.match(resumed.reason, /cc58a9d/);

  // Bookkeeping only, but the base has moved out from under it: reuse can never
  // end in a fast-forward, and there is nothing on the branch worth halting a
  // night for, so the run carries on from the base as it stands — #74's answer.
  const stranded = waveBranchDecision({
    id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb",
    hasRecord: false, hasMergedWork: false,
    branchAheadOfBase: true, branchWorkAheadOfBase: false, baseIsAncestor: false,
  });
  assert.equal(stranded.action, "recreate");
  assert.match(stranded.reason, /is not an ancestor of it/);

  // One commit touching one reviewed path puts it straight back in the refusal
  // arm, whatever bookkeeping rode along with it.
  const mixed = waveBranchDecision({
    id: "wave-31", branchSha: "cc58a9da", baseSha: "bbbbbbbb",
    hasRecord: false, hasMergedWork: false,
    branchAheadOfBase: true, branchWorkAheadOfBase: true, baseIsAncestor: true,
  });
  assert.equal(mixed.action, "refuse");
});

test("a stale wave branch left by a died-at-baseline attempt is recreated at the current base", async () => {
  // THE END-TO-END #74. wave-01 is recorded `failed` with nothing attempted and
  // its branch survives at the sha it was cut from. Two repair commits then
  // land on `main` — which is the whole reason the wave is being re-run. The
  // old cut adopted the branch AND replayed the recorded baseSha, so the wave
  // ran at a base predating the repairs and could never be fast-forwarded.
  const { dir, repo } = makeRepo();
  const stale = git(repo, ["rev-parse", "main"]);
  writeFileSync(waveLogPath(join(repo, "tasks")), `${JSON.stringify({
    version: 1, base: "main", planReview: { status: "clean", reviewedAt: "2026-09-04T00:00:00Z", tasks: 3 },
    waves: [{
      id: "wave-01", branch: "wave-01", baseSha: stale, headSha: null, outcome: "failed",
      digest: "docs/afk-runs/wave-01.md",
      tasks: { "task-01-model": { outcome: "pending", attempts: 0 }, "task-03-docs": { outcome: "pending", attempts: 0 } },
    }],
  }, null, 2)}\n`);
  git(repo, ["branch", "wave-01", stale]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "the repair the wave needs"]);
  writeFileSync(join(repo, "repair.txt"), "the second repair\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "the second repair"]);
  const repaired = git(repo, ["rev-parse", "main"]);

  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.match(said.join("\n"), /recorded no passed task, so its recorded base/);
  assert.match(said.join("\n"), /Recreating it at/);

  const log = readWaveLog(join(repo, "tasks"), "main");
  assert.equal(log.waves[0].baseSha, repaired, "the replay must be cut from the base as it stands, not the stale record");
  assert.deepEqual(log.waves.map((wave) => wave.outcome), ["merged", "merged"]);
  // The repairs are underneath the wave, which is the point: an adopted branch
  // made `main` a non-ancestor and the wave could not be landed at all.
  assert.ok(isAncestor(repo, repaired, "main"));
  assert.ok(existsSync(join(repo, "repair.txt")));
  assert.ok(existsSync(join(repo, "task-02-picker.txt")));
  rmSync(dir, { recursive: true, force: true });
});

test("a wave branch that carries lane merges is refused, never recreated, and named", async () => {
  // The other path the acceptance asks for. The record says a task passed, so
  // there is work on that branch the driver is not entitled to discard — and
  // the sha this cut wants is not in its history, so it is not the branch this
  // replay resumes either. Stop, and name both shas.
  const { dir, repo } = makeRepo();
  const stale = git(repo, ["rev-parse", "main"]);
  git(repo, ["branch", "wave-01", stale]);
  writeFileSync(waveLogPath(join(repo, "tasks")), `${JSON.stringify({
    version: 1, base: "main", planReview: { status: "clean", reviewedAt: "2026-09-04T00:00:00Z", tasks: 3 },
    waves: [{
      id: "wave-01", branch: "wave-01", baseSha: "0000000000000000000000000000000000000000", headSha: null, outcome: "failed",
      digest: "docs/afk-runs/wave-01.md",
      tasks: { "task-01-model": { outcome: "passed", attempts: 1 }, "task-03-docs": { outcome: "failed", attempts: 1 } },
    }],
  }, null, 2)}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "record a wave that merged a lane"]);

  const said = [];
  let ran = 0;
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (...args) => { ran += 1; return fakeRun()(...args); }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  assert.equal(ran, 0, "no lane may run once the cut is refused");
  assert.match(said.join("\n"), /`wave-01` already exists at/);
  assert.match(said.join("\n"), /is not an ancestor of it/);
  assert.match(said.join("\n"), /git branch -D wave-01/);
  assert.equal(git(repo, ["rev-parse", "wave-01"]), stale, "a refused cut must leave the branch exactly as it found it");
  rmSync(dir, { recursive: true, force: true });
});

test("a wave branch with no record at all is refused, and its commits survive", async () => {
  // The salvage procedure, end to end: wave state is wiped ON PURPOSE and the
  // `wave-NN` / `afk/task-*` branches are kept so finished builds are
  // re-integrated instead of rebuilt. `waveHasMergedWork(undefined)` is false,
  // so the cut used to read the missing record as "nothing passed", take the
  // `recreate` branch and DELETE the salvage — lane merges included. A human's
  // own branch called `wave-01` went the same way.
  const { dir, repo } = makeRepo();
  const base = git(repo, ["rev-parse", "main"]);
  git(repo, ["branch", "wave-01", base]);
  git(repo, ["checkout", "-q", "wave-01"]);
  writeFileSync(join(repo, "salvaged-lane.txt"), "a merged lane nobody can reconstruct\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "the lane merge the salvage exists to keep"]);
  const salvaged = git(repo, ["rev-parse", "wave-01"]);
  git(repo, ["checkout", "-q", "main"]);
  // No wave log is written: that is what "the state was wiped" means here.

  const said = [];
  let ran = 0;
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (...args) => { ran += 1; return fakeRun()(...args); }),
    say: (line) => said.push(line),
  });
  // The data loss first, so it is asserted whichever way the run went.
  assert.equal(git(repo, ["rev-parse", "wave-01"]), salvaged, "the branch and its lane merges must still be there");
  assert.equal(
    git(repo, ["show", "wave-01:salvaged-lane.txt"]),
    "a merged lane nobody can reconstruct",
    "the commit the salvage was protecting must still be reachable",
  );
  assert.equal(status, 1);
  assert.equal(ran, 0, "no lane may run once the cut is refused");
  assert.match(said.join("\n"), /`wave-01` already exists at/);
  assert.match(said.join("\n"), /no record of it/);
  rmSync(dir, { recursive: true, force: true });
});

test("a driver killed after a lane failed resumes its branch instead of ending the night", async () => {
  // THE PRIMARY RESUME PATH, end to end, and the one the refusal above broke.
  // The commits below are exactly what `flushStatuses` puts on a wave branch
  // from its FAILURE paths — `docs/progress.md`, the ledger and
  // `.afk-runs/<id>/integration-verification.json` — with the wave log record
  // never written because the driver was killed before it got that far. The
  // branch is ahead of `main` and nobody can say from the log whose commits
  // they are; git can, and they are the runner's own.
  const { dir, repo } = makeRepo();
  const base = git(repo, ["rev-parse", "main"]);
  git(repo, ["branch", "wave-01", base]);
  git(repo, ["checkout", "-q", "wave-01"]);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "progress.md"), "# Progress\n\n- task-01-model: failed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "afk: task-01-model integration_failed"]);
  mkdirSync(join(repo, ".afk-runs", "task-01-model"), { recursive: true });
  writeFileSync(
    join(repo, ".afk-runs", "task-01-model", "integration-verification.json"),
    `${JSON.stringify({ outcome: "integration_failed" })}\n`,
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "afk: task-01-model evidence"]);
  const evidence = git(repo, ["rev-parse", "wave-01"]);
  git(repo, ["checkout", "-q", "main"]);
  // No wave log: the driver never reached `recordWave`.

  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main", io: driverIo(dir, fakeRun()), say: (line) => said.push(line),
  });
  assert.equal(status, 0, said.join("\n"));
  assert.match(said.join("\n"), /every commit it carries above .* is the runner's own bookkeeping/);
  assert.doesNotMatch(said.join("\n"), /git branch -D wave-01/, "the night must not end advising the deletion of its own evidence");

  // The evidence is not merely undeleted — it is underneath the wave that
  // resumed on it, so it reaches `main` with the run.
  assert.ok(isAncestor(repo, evidence, "main"));
  assert.equal(
    JSON.parse(readFileSync(join(repo, ".afk-runs", "task-01-model", "integration-verification.json"), "utf8")).outcome,
    "integration_failed",
  );
  assert.ok(existsSync(join(repo, "task-01-model.txt")), "the resumed wave must still run its tasks");
  rmSync(dir, { recursive: true, force: true });
});

test("a wave that reaches no terminal outcome leaves no worktree and no branch", async () => {
  // The upstream half of #74: nothing survives a zero-work wave for the next
  // cut to adopt. Only a `passed` lane puts a commit on the wave branch, so
  // there is nothing on this one to keep.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, fakeRun({ passed: [], attempts: 1, work: false })),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  assert.match(said.join("\n"), /reached no terminal task outcome; its worktree and branch are removed/);
  assert.equal(git(repo, ["branch", "--list", "wave-*"]), "", "a zero-work wave left a branch behind");
  assert.equal(
    spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.match(/^worktree /gm).length,
    1,
    "a zero-work wave left a worktree behind",
  );
  // The digest still exists — the night's record is not what is being cleaned.
  assert.match(readFileSync(join(repo, "docs", "afk-runs", "wave-01.md"), "utf8"), /# wave-01/);
  rmSync(dir, { recursive: true, force: true });
});

test("an all-failed wave's tracked run evidence survives the teardown that removes its branch (#96)", async () => {
  // THE EVIDENCE DELETION. `flushStatuses` commits `docs/progress.md` and the
  // per-task `.afk-runs/<id>/integration-verification.json` from the FAILURE
  // paths too, so a wave where every lane died still carries the forensics for
  // WHY on its branch. `archiveWaveRun` moves the `.afk/` artifacts but not
  // these — they are on the branch, not under `.afk/` — and the zero-work
  // teardown then removes branch and worktree, the only copy. The night's own
  // account of why it failed is deleted by the cleanup that runs because it did.
  const { dir, repo } = makeRepo();
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      // Every task dead on the spot: nothing terminal, so the branch is torn
      // down. `work: false`, so the only thing on the branch is the evidence.
      const result = fakeRun({ passed: [], attempts: ATTEMPT_BUDGET, work: false })(args);
      // Stand in for `flushStatuses` committing failure forensics on the branch.
      mkdirSync(join(args.runRoot, "docs"), { recursive: true });
      writeFileSync(join(args.runRoot, "docs", "progress.md"), "wave-01 forensics: every lane died here\n");
      for (const id of args.taskIds) {
        mkdirSync(join(args.runRoot, ".afk-runs", id), { recursive: true });
        writeFileSync(join(args.runRoot, ".afk-runs", id, "integration-verification.json"), JSON.stringify({ outcome: "integration_failed", task: id }));
      }
      git(args.runRoot, ["add", "-A"]);
      git(args.runRoot, ["commit", "-qm", "flush failure evidence"]);
      return result;
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  // The branch really is gone — the archive is the only copy from here on.
  assert.equal(git(repo, ["branch", "--list", "wave-*"]), "", "the all-failed wave's branch must be removed");
  assert.equal(existsSync(join(dir, "worktrees", "wave-01")), false, "its worktree must be removed too");

  // And the forensics survived, in the same archive dir `archiveWaveRun` uses.
  const archive = join(repo, ".afk", "archive", "wave-01");
  assert.ok(existsSync(join(archive, "docs", "progress.md")), "the failed wave's progress.md was deleted with its branch");
  assert.match(readFileSync(join(archive, "docs", "progress.md"), "utf8"), /forensics: every lane died/);
  assert.ok(
    existsSync(join(archive, ".afk-runs", "task-01-model", "integration-verification.json")),
    "the per-task integration-verification was deleted with its branch",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a wave that produced terminal work keeps its branch when the base moved under it", async () => {
  // The teardown must not eat the branch the ancestor refusal promises to a
  // human, and the refusal must print the diagnosis rather than the verdict:
  // "`main` is not an ancestor of `wave-01`; `wave-01` is based at `<sha>`,
  // `main` is at `<sha>` (1 commit ahead)".
  const { dir, repo } = makeRepo();
  const baseSha = git(repo, ["rev-parse", "main"]);
  const said = [];
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (args) => {
      const result = fakeRun()(args);
      writeFileSync(join(repo, "hotfix.txt"), "urgent\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "hotfix"]);
      return result;
    }),
    say: (line) => said.push(line),
  });
  assert.equal(status, 1);
  assert.equal(git(repo, ["rev-parse", "--verify", "wave-01"]).length, 40, "the branch is left in place for a human");
  const message = said.join("\n");
  assert.match(message, new RegExp(`\`main\` is not an ancestor of \`wave-01\`; \`wave-01\` is based at \`${baseSha.slice(0, 7)}\``));
  assert.match(message, new RegExp(`\`main\` is at \`${git(repo, ["rev-parse", "main"]).slice(0, 7)}\` \\(1 commit ahead\\)`));
  assert.match(readFileSync(join(repo, "docs", "afk-runs", "wave-01.md"), "utf8"), /\(1 commit ahead\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("removeWaveRefs verifies its removals instead of trusting the exit code", () => {
  // `git branch -D wave-NN` fails while a worktree still holds the branch and
  // its stderr is suppressed, so a teardown that reported success left a stale
  // branch behind — the ref the next cut then adopted.
  const { dir, repo } = makeRepo();
  const gitIo = (cwd, command) => spawnSync("sh", ["-c", `git ${command}`], { cwd, encoding: "utf8" });
  git(repo, ["branch", "wave-09"]);
  git(repo, ["worktree", "add", "-q", join(dir, "held"), "wave-09"]);

  // A removeWorktree that does nothing is the suppressed-stderr failure.
  const stuck = removeWaveRefs({ git: gitIo, root: repo, branch: "wave-09", removeWorktree: () => {} });
  assert.equal(stuck.worktreeGone, false);
  assert.equal(stuck.branchGone, false, "a branch a worktree still holds must never be reported gone");
  assert.match(stuck.notes.join("; "), /still registered as a worktree/);
  assert.match(stuck.notes.join("; "), /git branch -D wave-09` did not remove it/);
  assert.match(git(repo, ["branch", "--list", "wave-09"]), /wave-09/);

  // And the real order — worktree, prune, branch — clears both.
  const cleared = removeWaveRefs({
    git: gitIo, root: repo, branch: "wave-09",
    removeWorktree: ({ worktree }) => { git(repo, ["worktree", "remove", "--force", worktree]); },
  });
  assert.deepEqual(cleared, { worktreeGone: true, branchGone: true, notes: [] });
  assert.equal(git(repo, ["branch", "--list", "wave-*"]), "");
  rmSync(dir, { recursive: true, force: true });
});

test("the digest names a lane's broker denials on its row, and says nothing when there were none", () => {
  // #53: a denial is one refused tool call and the lane keeps going, so the
  // only place a human learns the broker said no is this row.
  const runRoot = mkdtempSync(join(tmpdir(), "afk-wave-broker-"));
  const write = (id, attempt, brokerDecisions) => {
    const dir = builderRunDir(runRoot, id, attempt);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verification.json"), JSON.stringify({ checks: [], ...(brokerDecisions ? { brokerDecisions } : {}) }));
  };
  const deny = (subjects) => ({ behavior: "deny", subjects });
  write("task-01", 1, { allowed: 0, denied: 1, entries: [deny(["src/secret.ts"])] });
  write("task-01", 2, { allowed: 1, denied: 1, entries: [{ behavior: "allow", subjects: ["package.json"] }, deny(["/etc/hosts", "src/secret.ts"])] });
  write("task-02", 1, { allowed: 2, denied: 0, entries: [] });
  write("task-03", 1, null);

  const denials = collectBrokerDenials(runRoot, {
    "task-01": { outcome: "passed", attempts: 2 },
    "task-02": { outcome: "passed", attempts: 1 },
    "task-03": { outcome: "failed", attempts: 1 },
  });
  assert.deepEqual(denials, { "task-01": { denied: 2, subjects: ["src/secret.ts", "/etc/hosts"] } });

  const digest = renderDigest({
    id: "wave-04",
    base: "main",
    baseSha: "deadbee",
    tasks: ["task-01", "task-02"].map((id) => ({ id, outcome: "passed", attempts: 1, dead: false, broker: denials[id] ?? null })),
    fastForward: { allowed: true, verdict: "merged", reason: "2 of 2 task(s) passed" },
  });
  const row = (id) => digest.split("\n").find((l) => l.startsWith(`- \`${id}\``));
  assert.match(row("task-01"), /broker: 2 denied \(src\/secret\.ts, \/etc\/hosts\)/);
  assert.doesNotMatch(row("task-02"), /broker/);
  rmSync(runRoot, { recursive: true, force: true });
});

test("broker denials are read from every builder-N dir, not only 1..attempts", () => {
  // An infra or auth failure zeroes builderAttempt, so a task can end with
  // attempts=1 while builder-2 from before the reset still holds denials.
  const runRoot = mkdtempSync(join(tmpdir(), "afk-wave-broker-reset-"));
  for (const [attempt, subject] of [[1, "src/a.ts"], [2, "src/b.ts"]]) {
    const dir = builderRunDir(runRoot, "task-01", attempt);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verification.json"), JSON.stringify({
      brokerDecisions: { allowed: 0, denied: 1, entries: [{ behavior: "deny", subjects: [subject] }] },
    }));
  }
  const denials = collectBrokerDenials(runRoot, {
    "task-01": { outcome: "passed", attempts: 1 },
    "task-02": { outcome: "pending", attempts: 0 },
  });
  assert.equal(denials["task-01"]?.denied, 2);
  assert.deepEqual(denials["task-01"]?.subjects.sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal("task-02" in denials, false, "a task with no run dir has no denials");
  rmSync(runRoot, { recursive: true, force: true });
});

test("a denial with no path subject renders without empty parentheses", () => {
  const digest = renderDigest({
    id: "wave-05",
    base: "main",
    baseSha: "deadbee",
    tasks: [{ id: "task-01", outcome: "passed", attempts: 1, dead: false, broker: { denied: 1, subjects: [] } }],
    fastForward: { allowed: true, verdict: "merged", reason: "1 of 1 task(s) passed" },
  });
  const row = digest.split("\n").find((l) => l.startsWith("- `task-01`"));
  assert.match(row, /; broker: 1 denied$/);
  assert.doesNotMatch(row, /\(\)/);
});

test("a wave branch whose only commits touch .agents/evidence/ still counts as work, and is refused (#176 W2)", async () => {
  // The baseline skip treats the closeout sweep's paths as inert through its
  // OWN predicate (`isBaselineInertPath` in auto.mjs). `branchWorkAheadOf` reads
  // `isStatusFlushPath`, and a wider one would read an evidence-only branch as
  // "the runner's own bookkeeping" and resume over, or recreate, somebody's
  // screenshots. This holds `isStatusFlushPath` where it was.
  const { dir, repo } = makeRepo();
  const base = git(repo, ["rev-parse", "main"]);
  git(repo, ["branch", "wave-01", base]);
  git(repo, ["checkout", "-q", "wave-01"]);
  mkdirSync(join(repo, ".agents", "evidence", "task-01-model"), { recursive: true });
  writeFileSync(join(repo, ".agents", "evidence", "task-01-model", "01-after.png"), "png\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "evidence for task-01-model"]);
  const evidence = git(repo, ["rev-parse", "wave-01"]);
  git(repo, ["checkout", "-q", "main"]);

  const said = [];
  let ran = 0;
  const status = await cliWaveRun({
    root: repo, dir: "tasks", base: "main",
    io: driverIo(dir, (...args) => { ran += 1; return fakeRun()(...args); }),
    say: (line) => said.push(line),
  });
  assert.equal(git(repo, ["rev-parse", "wave-01"]), evidence, "the evidence branch must survive");
  assert.doesNotMatch(said.join("\n"), /the runner's own bookkeeping/);
  assert.match(said.join("\n"), /no record of it/);
  assert.equal(status, 1);
  assert.equal(ran, 0);
  rmSync(dir, { recursive: true, force: true });
});
