// scripts/integration-merge.test.mjs — the two ways a finished lane failed to
// reach a human, from the six-epic overnight run.
//
// Both findings are about the same seam — what the runner does once a lane's
// work is good — so they are tested together:
//
//   1. `runIntegration` refused the FIRST merge of every epic, because a branch
//      still at its own base can only fast-forward. Epic #4 lost four of five
//      tasks to it; epic #5 lost its fastest root task.
//   2. `ensureDraftPr` rendered a PR body describing commits it had not pushed.
//      Epic #4's PR #43 claimed tasks #27 and #28 passed while its diff
//      contained neither.
//
// Nothing here touches the network. The merge tests run real `git` in a
// throwaway repo and spawn no agent at all — which is itself the point of §1.
// The PR tests drive `ensureDraftPr` entirely through its injected `exec`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeConfig } from "./test-helpers.mjs";
import { buildAgentCommand } from "./lib.mjs";
import { ROLES, roleAgent, roleFor } from "./roles.mjs";
import { postMergeChecks, runIntegration } from "./integrate.mjs";
import { gitMetadataDirs } from "./worktree.mjs";
import { ensureDraftPr, renderPrBody } from "./pr.mjs";

// ---------------------------------------------------------------------------
// 1. The first merge onto a fresh epic branch
// ---------------------------------------------------------------------------

const CONFIG = { maxParallel: 1, defaultChecks: ["true"] };

/**
 * A repo whose `main` is exactly where the task branch forked from — the state
 * of every epic branch before its first lane integrates, and the state in which
 * `git merge` can only fast-forward.
 */
const repoWithFirstLane = () => {
  const root = mkdtempSync(join(tmpdir(), "afk-first-merge-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  // `.afk/` is the runner's own scratch space; untracked, it would read as dirt.
  writeFileSync(join(root, ".gitignore"), ".afk/\n");
  writeConfig(root, CONFIG);
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();

  git("checkout", "-b", "task/300");
  writeFileSync(join(root, "roulette.js"), "export const spin = () => 4;\n");
  git("add", ".");
  git("commit", "-m", "task 300: daily challenge roulette");
  git("checkout", "main");
  return { root, git, base };
};

const TASK = {
  id: "300",
  title: "Daily challenge roulette",
  body: "spin the wheel",
  checks: ["true"],
};

test("the first merge onto an untouched epic branch is a real merge, not integration_failed", async () => {
  const { root, git, base } = repoWithFirstLane();
  try {
    assert.equal(
      git("merge-base", "--is-ancestor", "main", "task/300").status,
      0,
      "fixture precondition: main is an ancestor of the lane, so git can only fast-forward",
    );

    const result = await runIntegration({
      root,
      config: CONFIG,
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });

    // The regression, in one line. This returned "integration_failed" with
    // `merge commit is a fast-forward, not a real merge`, twice per task,
    // and took the failed root's whole blast radius with it.
    assert.equal(
      result.outcome,
      "passed",
      `first merge must integrate (${result.failureReason})`,
    );
    assert.equal(result.verification.failureReason, null);
    assert.equal(result.verification.fastForward, true, "and it says so on the record");

    // A REAL merge commit, because that is the runner's rollback anchor: HEAD
    // plus two parents is three tokens from `rev-list --parents -n 1`.
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD")
      .stdout.trim().split(/\s+/);
    assert.equal(parents.length, 3, `expected a two-parent merge, got ${parents.join(" ")}`);
    assert.equal(parents[1], base, "first parent is where the epic branch was");
    assert.equal(
      git("merge-base", "--is-ancestor", "task/300", "HEAD").status,
      0,
      "and the lane's tip is in the history",
    );
    assert.equal(
      readFileSync(join(root, "roulette.js"), "utf8"),
      "export const spin = () => 4;\n",
      "the lane's code is actually on the branch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fast-forward merge spends no agent session, so there is nothing to retry", async () => {
  const { root, base } = repoWithFirstLane();
  try {
    const result = await runIntegration({
      root,
      config: CONFIG,
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.outcome, "passed");

    // No prompt was written and no stream came back, which is the proof no
    // merger was invoked: there is no conflict for one to resolve. This also
    // retires the retry that epic #5 paid for — a deterministic condition
    // re-run 60 seconds later, unchanged, failing identically.
    const runDir = join(root, ".afk", "runs", "300", "integration-1");
    assert.equal(existsSync(join(runDir, "prompt.md")), false, "no merger prompt");
    assert.equal(existsSync(join(runDir, "stream.jsonl")), false, "no merger session");
    assert.match(
      readFileSync(join(runDir, "agent-output.log"), "utf8"),
      /fast-forward onto .*--no-ff/s,
      "the log says who made the commit and why",
    );
    assert.equal(JSON.parse(readFileSync(join(runDir, "verification.json"), "utf8")).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lane whose base has advanced still goes to the merger, untouched", async () => {
  // The guard on the fix: `--no-ff` is only reached when there is genuinely
  // nothing to reconcile. Once the epic branch carries a commit the lane lacks,
  // a real merge is required and the merger owns it as before. Here that means
  // the agent path — which this fixture has no agent for, so the integration
  // fails. Failing for "the merger did not run" rather than merging in-process
  // is exactly the behaviour under test.
  const { root, git, base } = repoWithFirstLane();
  try {
    writeFileSync(join(root, "unrelated.txt"), "another lane landed first\n");
    git("add", ".");
    git("commit", "-m", "another lane");
    assert.notEqual(
      git("merge-base", "--is-ancestor", "main", "task/300").status,
      0,
      "fixture precondition: main has moved, so this is not a fast-forward",
    );

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { timeoutMs: 5_000 } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.verification.fastForward, false);
    assert.equal(
      existsSync(join(root, ".afk", "runs", "300", "integration-1", "prompt.md")),
      true,
      "the merger was prompted, as it always was for a real merge",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The PR body is never rendered ahead of the push
// ---------------------------------------------------------------------------

const EPIC = { id: "4", title: "Daily challenge roulette" };
const DAG = {
  epic: EPIC,
  branch: "feat/4-daily-challenge-roulette",
  tasks: [
    { id: "27", title: "Wheel", dependsOn: [] },
    { id: "28", title: "Prizes", dependsOn: ["27"] },
  ],
};
const STATE = { tasks: { 27: { lifecycle: "passed" }, 28: { lifecycle: "passed" } } };
const AT = "2026-08-20T02:00:00.000Z";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr) => ({ status: 1, stdout: "", stderr });

// Records commands in order and answers from [matcher, result] pairs; anything
// unmatched succeeds silently.
const fakeExec = (answers = []) => {
  const calls = [];
  const exec = (command) => {
    calls.push(command);
    for (const [pattern, result] of answers) {
      if (pattern.test(command)) return typeof result === "function" ? result(command) : result;
    }
    return ok();
  };
  exec.calls = calls;
  exec.at = (pattern) => calls.findIndex((command) => pattern.test(command));
  return exec;
};

const AHEAD = [/git rev-list --count/, ok("6\n")];

const ensure = (answers, overrides = {}) => {
  const exec = fakeExec(answers);
  const outcome = ensureDraftPr({
    root: "/tmp/nowhere",
    repo: "owner/voice-studio",
    branch: DAG.branch,
    baseBranch: "main",
    epic: EPIC,
    dag: DAG,
    state: STATE,
    verifierReport: null,
    renderedAt: AT,
    exec,
    ...overrides,
  });
  return { outcome, exec };
};

test("refreshing an existing PR pushes the branch first, in the same step", () => {
  // Epic #4: `origin/feat/4-daily-challenge-roulette` was six commits behind at
  // close — including the merge commits for tasks #27 and #28 — while the log
  // said `EPIC: refreshed draft PR #43 from run state` and the body claimed both
  // had passed. The old code pushed only when the remote branch was ABSENT, so
  // every render after the first described commits GitHub had never seen.
  const { outcome, exec } = ensure([
    AHEAD,
    [/gh pr list/, ok(JSON.stringify([{ number: 43, state: "OPEN", isDraft: true }]))],
  ]);
  assert.equal(outcome.action, "updated");
  assert.equal(outcome.number, 43);
  const pushed = exec.at(/git push -u origin/);
  const edited = exec.at(/gh pr edit 43 /);
  assert.ok(pushed !== -1, "the refresh pushed");
  assert.ok(pushed < edited, `push (${pushed}) must precede the render (${edited})`);
  assert.ok(
    outcome.notes.some((note) => /pushed `feat\/4-daily-challenge-roulette` to origin/.test(note)),
    `the push is reported, not silent: ${JSON.stringify(outcome.notes)}`,
  );
});

test("opening a PR pushes the branch first, in the same step", () => {
  const { outcome, exec } = ensure([
    AHEAD,
    [/gh pr list/, ok("[]")],
    [/gh pr create/, ok("https://github.com/owner/voice-studio/pull/43\n")],
  ]);
  assert.equal(outcome.action, "created");
  assert.ok(exec.at(/git push -u origin/) < exec.at(/gh pr create/));
});

test("a failed push renders no body at all, rather than one the remote cannot back", () => {
  // The load-bearing half. If the push cannot happen, the alternative to "no
  // render" is a PR that actively lies about its own diff — so the render is
  // abandoned, and the warning says which of the two happened.
  for (const [answers, where] of [
    [[/gh pr list/, ok(JSON.stringify([{ number: 43, state: "OPEN", isDraft: true }]))], "gh pr edit"],
    [[/gh pr list/, ok("[]")], "gh pr create"],
  ]) {
    const { outcome, exec } = ensure([
      AHEAD,
      [/git push/, fail("! [rejected] non-fast-forward")],
      answers,
    ]);
    assert.equal(outcome.action, "failed");
    assert.equal(exec.at(new RegExp(where)), -1, `${where} must not run after a failed push`);
    assert.match(outcome.warnings[0], /could not push/);
    assert.match(
      outcome.warnings[0],
      /body was NOT rendered/,
      "and says why, so the operator knows the PR is not merely stale",
    );
  }
});

test("a branch with nothing to push is still not a failure", () => {
  // The freshly-branched epic. Zero commits ahead: nothing to push, and GitHub
  // cannot open a PR against a branch identical to its base. A note, not a
  // warning — and unchanged by the push-first reordering.
  const { outcome, exec } = ensure([
    [/git rev-list --count/, ok("0\n")],
    [/gh pr list/, ok("[]")],
  ]);
  assert.equal(outcome.action, "skipped");
  assert.deepEqual(outcome.warnings, []);
  assert.equal(exec.at(/git push/), -1, "nothing to send");
  assert.match(outcome.notes[0], /no commits on .* yet/);
});

// ---------------------------------------------------------------------------
// 3. The body says what the epic itself is doing
// ---------------------------------------------------------------------------

test("an epic parked on a human gate says so, and names who it is waiting for", () => {
  // Epic #2: PR #41 read "4 tasks — 4 pending" while all four had merged and
  // three were long integrated, and the body had no vocabulary for the gate at
  // all — `passed` on a device-acceptance ticket reads as though the device
  // pass happened. The epic-level line makes the table safe to read alone.
  const text = renderPrBody({
    epic: EPIC,
    branch: DAG.branch,
    baseBranch: "main",
    dag: { ...DAG, tasks: [...DAG.tasks, { id: "32", title: "Device acceptance", dependsOn: ["28"] }] },
    state: {
      tasks: { ...STATE.tasks, 32: { lifecycle: "awaiting_acceptance" } },
      epicClose: { lifecycle: "awaiting_acceptance", reason: "32 awaits a human" },
    },
    renderedAt: AT,
  });
  assert.match(text, /\*\*Epic status:\*\* `awaiting_acceptance`/);
  assert.match(text, /task 32 needs a human/);
  assert.match(text, /--accept=32/);
  // The task-level lifecycle the scheduler now writes renders as itself, and
  // leads the summary because it is the only one this reader can clear.
  assert.match(text, /\| 32 \| Device acceptance \| awaiting_acceptance \| 28 \|/);
  assert.match(text, /\*\*3 tasks\*\* — 1 awaiting_acceptance, 2 passed\./);
});

test("a run still going, and a closed one, each say which they are", () => {
  const at = (state) =>
    /\*\*Epic status:\*\*.*/.exec(
      renderPrBody({ epic: EPIC, branch: DAG.branch, dag: DAG, state, renderedAt: AT }),
    )[0];
  assert.match(at(STATE), /`open` — the run is still going/);
  assert.match(
    at({ ...STATE, epicClose: { lifecycle: "closed", outcome: "completed" } }),
    /closed `completed`/,
  );
});

// ---------------------------------------------------------------------------
// 4. The Codex integrator, and the Git metadata directory it cannot merge without
// ---------------------------------------------------------------------------
//
// Ported from the Codex fork, where it was found after the port rather than
// before it: the merger edited files happily and then died on
// `Unable to create '<gitdir>/index.lock': Operation not permitted`. Codex's
// `workspace-write` sandbox grants the working tree; Git's index and refs live
// in the metadata directory beside it, which the sandbox does not grant.
//
// The fake below enforces that boundary rather than assuming it: it refuses to
// run `git merge` unless the metadata directory was passed as `--add-dir`. So
// removing the grant from `runIntegration` turns this test red with the real
// error, which is the only way a test of a permission fix has teeth.

const FAKE_CODEX_MERGER = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const addDirs = argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
const dir = flag('--cd');
fs.writeFileSync(process.env.AFK_FAKE_ARGV, JSON.stringify(argv));
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!dir) { process.stderr.write('a Codex invocation named no --cd\\n'); process.exit(2); }
  const gitDir = cp.spawnSync('git', ['rev-parse', '--absolute-git-dir'],
    { cwd: dir, encoding: 'utf8' }).stdout.trim();
  // What the sandbox does when the metadata directory was not granted.
  if (!addDirs.includes(gitDir)) {
    process.stderr.write("fatal: Unable to create '" + gitDir + "/index.lock': Operation not permitted\\n");
    process.exit(1);
  }
  const branch = (input.match(/Task branch: ([^\\n]+)/) || [])[1];
  const merged = cp.spawnSync('git', ['merge', '--no-ff', '--no-edit', branch],
    { cwd: dir, encoding: 'utf8' });
  if (merged.status !== 0) { process.stderr.write(merged.stderr); process.exit(merged.status || 1); }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'merged' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

// A repo whose `main` has moved on, so the merge is a real one and the merger
// actually runs — the fast-forward path spends no agent and would prove nothing.
const codexMergeFixture = () => {
  const { root, git, base } = repoWithFirstLane();
  writeFileSync(join(root, "unrelated.txt"), "another lane landed first\n");
  git("add", ".");
  git("commit", "-m", "another lane");

  const bin = mkdtempSync(join(tmpdir(), "afk-codex-merge-bin-"));
  writeFileSync(join(bin, "codex"), FAKE_CODEX_MERGER);
  chmodSync(join(bin, "codex"), 0o755);
  const argvPath = join(bin, "argv.json");
  const saved = {
    PATH: process.env.PATH,
    AFK_BACKEND: process.env.AFK_BACKEND,
    AFK_FAKE_ARGV: process.env.AFK_FAKE_ARGV,
  };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.AFK_BACKEND = "codex";
  process.env.AFK_FAKE_ARGV = argvPath;
  return {
    root,
    git,
    base,
    argv: () => JSON.parse(readFileSync(argvPath, "utf8")),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const dir of [root, bin]) rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("a Codex integrator merges and runs the post-merge checks, given the Git metadata directory", async () => {
  const { root, git, base, argv, restore } = codexMergeFixture();
  try {
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" })
      .stdout.trim();
    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.outcome, "passed", `merge must not die on a lock file (${result.failureReason})`);
    assert.equal(result.verification.fastForward, false, "fixture precondition: a real merge, so an agent ran");
    assert.equal(
      git("rev-list", "--parents", "-n", "1", "HEAD").stdout.trim().split(/\s+/).length,
      3,
      "a two-parent merge commit",
    );
    assert.deepEqual(result.verification.checks.map((c) => c.code), [0], "post-merge checks ran on the merged tree");

    // Exactly one extra writable directory in a plain checkout, and it is the
    // one git named — not an assumed `<root>/.git`. In a plain checkout the
    // per-worktree gitdir and the common dir are the same path, so the deduped
    // grant is a single entry; a linked worktree splits them (own test below).
    const args = argv();
    assert.deepEqual(args.filter((a) => a === "--add-dir").length, 1);
    assert.equal(args[args.indexOf("--add-dir") + 1], gitDir);
    assert.deepEqual(result.verification.gitMetadataDirs, [gitDir]);
    assert.equal(args[args.indexOf("--cd") + 1], root);
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.equal(args[args.indexOf("-c") + 1], "model_reasoning_effort=medium");

    assert.deepEqual(result.verification.agent,
      { backend: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" });
  } finally {
    restore();
  }
});

test("a merger that fast-forwards gets its merge redone with --no-ff and reaches its checks (#145)", async () => {
  // Epic #841 task 849: the merger exited 0, the history held the task tip, the
  // tree was clean, nothing conflicted, and the head had ONE parent. It was
  // rejected as "a fast-forward, not a real merge" with `checks: []` and
  // requeued for 27 minutes. Here the fake merger moves main onto the lane's
  // tip, which is exactly that shape.
  const { root, git, base, restore } = codexMergeFixture();
  try {
    const bin = dirname(process.env.AFK_FAKE_ARGV);
    writeFileSync(join(bin, "codex"), FAKE_CODEX_MERGER
      .replace("['merge', '--no-ff', '--no-edit', branch]", "['reset', '--hard', branch]"));
    chmodSync(join(bin, "codex"), 0o755);
    const before = git("rev-parse", "HEAD").stdout.trim();

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.verification.fastForward, false, "fixture precondition: an agent ran");
    assert.equal(result.outcome, "passed", `${result.failureReason}`);
    assert.equal(result.verification.redoneNoFf?.exitCode, 0, "the record says the runner redid it");
    assert.deepEqual(result.verification.checks.map((c) => c.code), [0], "and the checks ran");
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").stdout.trim().split(/\s+/);
    assert.equal(parents.length, 3, "a two-parent merge commit");
    assert.equal(parents[1], before, "whose first parent is where main was");
    assert.equal(existsSync(join(root, "unrelated.txt")), true, "the other lane's work survived");
  } finally {
    restore();
  }
});

test("a merger whose merge has the task tip as first parent is rolled back", async () => {
  // `integrationChecks` reads the task's change set as `HEAD^1...HEAD`, and the
  // rollback anchor is HEAD^1 too. A two-parent merge built from the task side
  // has the task tip there, so that diff would be every OTHER lane's work and
  // none of this task's: a gate that passes over the wrong files, silently.
  const { root, git, base, restore } = codexMergeFixture();
  try {
    const bin = dirname(process.env.AFK_FAKE_ARGV);
    writeFileSync(join(bin, "codex"), FAKE_CODEX_MERGER.replace(
      "if (merged.status !== 0) { process.stderr.write(merged.stderr); process.exit(merged.status || 1); }",
      "if (merged.status !== 0) { process.stderr.write(merged.stderr); process.exit(merged.status || 1); }\n"
      + "  const swapped = cp.spawnSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD^2', '-p', 'HEAD^1', '-m', 'swapped'], { cwd: dir, encoding: 'utf8' }).stdout.trim();\n"
      + "  cp.spawnSync('git', ['reset', '--hard', swapped], { cwd: dir });",
    ));
    chmodSync(join(bin, "codex"), 0o755);
    const before = git("rev-parse", "HEAD").stdout.trim();

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.verification.fastForward, false, "fixture precondition: an agent ran");
    assert.equal(result.outcome, "integration_failed");
    assert.match(result.failureReason, /first parent/);
    assert.equal(git("rev-parse", "HEAD").stdout.trim(), before, "main is back where it was");
  } finally {
    restore();
  }
});

test("a merger that linearised a conflicting merge is rolled back, and the reason says what it did (#145)", async () => {
  // The redo can only succeed when the merge was clean. Here main and the lane
  // both wrote roulette.js, the fake merger "resolved" it by moving main onto
  // the lane's tip, and the --no-ff redo conflicts. Calling that a
  // fast-forward would send a reader looking for the wrong thing.
  const { root, git, base, restore } = codexMergeFixture();
  try {
    writeFileSync(join(root, "roulette.js"), "export const spin = () => 7;\n");
    git("add", ".");
    git("commit", "-m", "main spins differently");
    const before = git("rev-parse", "HEAD").stdout.trim();
    const bin = dirname(process.env.AFK_FAKE_ARGV);
    writeFileSync(join(bin, "codex"), FAKE_CODEX_MERGER
      .replace("['merge', '--no-ff', '--no-edit', branch]", "['reset', '--hard', branch]"));
    chmodSync(join(bin, "codex"), 0o755);

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.outcome, "integration_failed");
    assert.notEqual(result.verification.redoneNoFf?.exitCode, 0, "fixture precondition: the redo conflicted");
    assert.doesNotMatch(result.failureReason, /fast-forward/);
    assert.match(result.failureReason, /one-parent commit instead of a merge .*--no-ff redo exited/);
    assert.equal(git("rev-parse", "HEAD").stdout.trim(), before, "main is back where it was");
  } finally {
    restore();
  }
});

test("a linked worktree grants the common git dir too, not just the per-worktree gitdir", () => {
  // The integrator runs in an epic/lane worktree, which is a LINKED worktree:
  // `--absolute-git-dir` is `.git/worktrees/<name>` (holds index.lock) but a real
  // merge also writes objects to the common `.git`. Granting only the first — as
  // the code did before this test — leaves a Codex merger failing one directory
  // over on the object write, the same `Operation not permitted` the grant exists
  // to prevent. Both must be granted.
  const { root } = repoWithFirstLane();
  const linked = mkdtempSync(join(tmpdir(), "afk-linked-wt-"));
  rmSync(linked, { recursive: true, force: true }); // `git worktree add` wants a fresh path
  try {
    spawnSync("git", ["worktree", "add", "--detach", linked], { cwd: root, encoding: "utf8" });
    const perWorktree = resolve(linked, spawnSync("git", ["rev-parse", "--absolute-git-dir"],
      { cwd: linked, encoding: "utf8" }).stdout.trim());
    const common = resolve(linked, spawnSync("git", ["rev-parse", "--git-common-dir"],
      { cwd: linked, encoding: "utf8" }).stdout.trim());
    assert.notEqual(perWorktree, common,
      "fixture precondition: a linked worktree separates the per-worktree gitdir from the common dir");

    const dirs = gitMetadataDirs(linked);
    assert.ok(dirs.includes(perWorktree), "the per-worktree gitdir (index.lock) is granted");
    assert.ok(dirs.includes(common), "the common dir (objects, refs) is granted — the fix");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", linked], { cwd: root, encoding: "utf8" });
    rmSync(linked, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Claude integrator is unchanged, and its evidence names claude", async () => {
  // The regression control for the merge half: same fixture, same real merge,
  // the Claude executable — which takes its working directory from the shell
  // and must be handed no Codex flag at all.
  const { root, git, base, argv, restore } = codexMergeFixture();
  try {
    process.env.AFK_BACKEND = "claude";
    const bin = dirname(process.env.AFK_FAKE_ARGV);
    // Claude gets no `--cd` and no `--add-dir`, so the fake must merge from the
    // shell's own cwd and must not demand the grant.
    writeFileSync(join(bin, "claude"), FAKE_CODEX_MERGER
      .replace("const dir = flag('--cd');", "const dir = flag('--cd') || process.cwd();")
      .replace("if (!addDirs.includes(gitDir)) {", "if (false) {"));
    chmodSync(join(bin, "claude"), 0o755);

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { command: "claude", model: "claude-opus-5", reasoningEffort: "low", timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.outcome, "passed", `${result.failureReason}`);
    assert.equal(
      git("rev-list", "--parents", "-n", "1", "HEAD").stdout.trim().split(/\s+/).length,
      3,
    );
    const args = argv();
    for (const flag of ["--add-dir", "--cd", "--sandbox", "--ask-for-approval"])
      assert.equal(args.includes(flag), false, `a Claude merger carried ${flag}`);
    assert.deepEqual(result.verification.agent,
      { backend: "claude", model: "claude-opus-5", reasoningEffort: "low" });
  } finally {
    restore();
  }
});

test("a Claude integrator that merged on another model records the switch", async () => {
  // The wiring into `runIntegration`'s verification record: same real merge as
  // above, but the fake starts on one model and answers its one turn on another.
  const { root, base, restore } = codexMergeFixture();
  try {
    process.env.AFK_BACKEND = "claude";
    const bin = dirname(process.env.AFK_FAKE_ARGV);
    writeFileSync(join(bin, "claude"), FAKE_CODEX_MERGER
      .replace("const dir = flag('--cd');", "const dir = flag('--cd') || process.cwd();")
      .replace("if (!addDirs.includes(gitDir)) {", "if (false) {")
      .replace(
        "emit({ type: 'item.completed'",
        "emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });\n"
          + "  emit({ type: 'assistant', message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'merged' }] }, parent_tool_use_id: null });\n"
          + "  emit({ type: 'item.completed'",
      ));
    chmodSync(join(bin, "claude"), 0o755);

    const result = await runIntegration({
      root,
      config: { ...CONFIG, agent: { command: "claude", model: "claude-opus-5-5", timeoutMs: 20_000, runtime: "direct" } },
      task: TASK,
      branch: "task/300",
      baseSha: base,
      attempt: 1,
      taskVerification: {},
    });
    assert.equal(result.outcome, "passed", `${result.failureReason}`);
    assert.equal(result.verification.fastForward, false, "fixture precondition: an agent ran");
    // Not failed — recorded.
    assert.deepEqual(result.verification.modelCheck, {
      started: "claude-opus-5-5",
      observed: { "claude-opus-4-6": 1 },
      status: "switched",
    });
  } finally {
    restore();
  }
});

test("role records never carry writable directories beyond their own", async () => {
  // External grants are call-site supplied only where a role needs them. A
  // default on the agent record would leak those paths into every invocation.
  // Assert the unadorned command for every role stays free of add-dir flags.
  const paths = { nodeBin: "/runtime/bin", promptPath: "p.md", streamPath: "s.jsonl", cwd: "/wt/43" };
  for (const name of Object.keys(ROLES)) {
    const command = buildAgentCommand(roleAgent(roleFor(name), {}, "codex"), paths);
    assert.doesNotMatch(command, /--add-dir/, `${name} was granted an extra writable directory`);
    // And the read/write split the Claude permission profile carried, rendered
    // as the sandbox mode Codex enforces.
    const writer = ["implementer", "integrator", "fixer", "reflector"].includes(name);
    assert.match(command, new RegExp(`--sandbox '${writer ? "workspace-write" : "read-only"}'`), name);
  }
});

// ---------------------------------------------------------------------------
// 3. Which chain the post-merge gate runs
// ---------------------------------------------------------------------------

test("`integrationChecks` replaces the baseline chain at integration, and is not added to it", () => {
  const task = { checks: ["tsc", "eslint"] };
  const config = { defaultChecks: ["tsc", "eslint"], baselineChecks: ["pnpm run check", "pnpm run test:e2e"] };
  // Unset: the baseline chain rides along, as it always has.
  assert.deepEqual(postMergeChecks(task, config), ["tsc", "eslint", "pnpm run check", "pnpm run test:e2e"]);
  // Set: the merged tree gets the task's checks plus the lighter list, never the baseline.
  assert.deepEqual(
    postMergeChecks(task, { ...config, integrationChecks: ["vitest run --changed HEAD^1", "tsc"] }),
    ["tsc", "eslint", "vitest run --changed HEAD^1"],
  );
  // `[]` is honoured: only the task's own checks run on the merged tree.
  assert.deepEqual(postMergeChecks(task, { ...config, integrationChecks: [] }), ["tsc", "eslint"]);
});
