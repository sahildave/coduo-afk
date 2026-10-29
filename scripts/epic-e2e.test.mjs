// scripts/epic-e2e.test.mjs — the whole epic lifecycle, offline, through the
// real `afk epic` CLI.
//
// Every other test file takes one seam. This one takes the WALK: validate →
// branch → a `gate: before` that actually blocks → release it → parallel lanes →
// serialized integration → a ledger entry that survives as a branch artifact →
// a `gate: after` that holds the epic open → acceptance → verifier → closeout →
// draft PR. It exists because the first live epic (#3) failed five times in a
// row on things every unit test was green about: an env variable leaking into a
// check, a transcript bound by recency, and a PR that could never open.
//
// Nothing here touches the network or a model. `gh` and `claude` are shell
// scripts on PATH ahead of the real ones, `origin` is a bare repo on disk, and
// the worktree root is a temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig } from "./test-helpers.mjs";
import { runAuto } from "./auto.mjs";
import { LEDGER_RELATIVE } from "./ledger.mjs";
import { freePort } from "./free-port.mjs";

// One port for this file's spawned children, taken from the OS at load.
// The call sites are synchronous `spawnSync` helpers, so the await is hoisted.
const SPAWNED_CHILD_PORT = String(await freePort());

const EPIC_NUMBER = 300;
const BRANCH = "feat/300-e2e";

// 301 is human-gated, so a plain `afk epic` must run NOTHING until it is
// released. 302 and 303 fan out from it. 303 carries `gate: after`, so the epic
// cannot close until a human accepts it.
const EPIC_BODY = [
  "```yaml",
  "afk:",
  "  version: 1",
  `  branch: ${BRANCH}`,
  "  max_parallel: 2",
  "  tasks:",
  "    301:",
  "      depends_on: []",
  "      gate: before",
  "    302:",
  "      depends_on: [301]",
  "    303:",
  "      depends_on: [301]",
  "      gate: after",
  "```",
].join("\n");

const CHILD = (number, title) => ({
  number,
  title,
  state: "OPEN",
  body: `## Acceptance criteria\n\n- \`file-${number}.txt\` exists.\n`,
});

const payloadFor = (body, children) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          number: EPIC_NUMBER,
          title: "End to end",
          state: "OPEN",
          body,
          subIssues: { totalCount: children.length, nodes: children },
        },
      },
    },
  });

const GH_PAYLOAD = payloadFor(EPIC_BODY, [
  CHILD(301, "Provision"),
  CHILD(302, "Widget"),
  CHILD(303, "Rollout"),
]);

// The same epic with no gates at all, so a single `afk epic` invocation carries
// it from empty branch to closed.
const UNGATED_BODY = [
  "```yaml",
  "afk:",
  "  version: 1",
  `  branch: ${BRANCH}`,
  "  max_parallel: 2",
  "  tasks:",
  "    301:",
  "      depends_on: []",
  "    302:",
  "      depends_on: [301]",
  "```",
].join("\n");

// A builder that behaves: it writes the one file its ticket asks for. The
// integrator branch is recognised by the merge instruction in its prompt, the
// same way scripts/selftest.mjs's happy path does it.
const FAKE_CLAUDE = `#!/usr/bin/env node
// Which agent am I? Decided by the CWD and the prompt's merge instruction, never
// by fuzzy text matching. An earlier draft sniffed for the word "contradiction"
// to spot the plan-reviewer, and the LEDGER's own prompt block contains that
// word — so lane 302 emitted a review instead of doing its work and was marked
// "produced no source change". Deterministic discriminators only.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const emit = (text) => {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: text || 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\\n');
  };
  // A builder is the only agent whose cwd is a task worktree — since worktrees
  // gained a private parent, \`<issue number>/<repo name>\`. The \`.git\` test is
  // what keeps the reflector out: its workspace is \`.afk/reflect/<epic>/workspace\`,
  // so its parent is bare digits too, and it is not a checkout.
  const segments = process.cwd().split(path.sep);
  segments.pop();
  const id = segments.pop();

  if (/^\\d+$/.test(id) && fs.existsSync('.git')) {
    fs.writeFileSync('file-' + id + '.txt', 'built by ' + id + '\\n');
    emit();
    return;
  }
  // A merger is the only agent handed a branch to merge.
  const branch = input.match(/Task branch: ([^\\n]+)/)?.[1];
  if (branch) {
    const merged = cp.spawnSync('git', ['merge', '--no-ff', '--no-edit', branch.trim()], { encoding: 'utf8' });
    if (merged.status !== 0) { process.stderr.write(merged.stderr); process.exit(1); }
    emit();
    return;
  }
  // The reflector is the only agent whose prompt names the file it must write,
  // and the only one whose output is a document rather than a JSON block.
  const reflection = input.match(/as \\\`(epic-[^\\\`]+\\.md)\\\`/)?.[1];
  if (reflection) {
    // Proves the staging: the runner copied these in, and the cwd is the only
    // place this agent can read from.
    const staged = fs.readdirSync('.').sort().join(',');
    fs.writeFileSync(reflection, '# Reflection — written by the fake\\n\\nRead: ' + staged + '\\n');
    emit('wrote ' + reflection);
    return;
  }
  // Everything else reads and reports: plan-reviewer, verifier, supervisor. All
  // three want a fenced JSON object and all three treat an empty one as clean.
  // The report goes in the assistant message AND in \`result\`: scripts/agent-stats.mjs
  // prefers the result field, so emitting the JSON only in the message left the
  // reader seeing the literal string "done" and refusing the review.
  const fence = String.fromCharCode(96, 96, 96);
  const report = fence + 'json\\n' + JSON.stringify({ findings: [], mustFix: [], problems: [], criteria: [], summary: 'clean' }) + '\\n' + fence;
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: report }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: report }) + '\\n');
});
`;

const fixture = (payload_ = GH_PAYLOAD) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-e2e-"));
  const repo = join(dir, "work");
  const remote = join(dir, "remote.git");
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  const payload = join(dir, "epic.json");
  const prState = join(dir, "pr.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "--bare", "-b", "main", remote]);
  writeFileSync(payload, payload_);
  writeFileSync(prState, "[]");

  // `gh pr list` answers from a file the fake `pr create` writes, so "does the
  // PR already exist" behaves the way GitHub does across separate runs — which
  // is the property `ensureDraftPr` relies on instead of remembering a number.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1 $2" in',
      `  "api graphql") cat ${JSON.stringify(payload)} ;;`,
      `  "repo view") echo "owner/e2e" ;;`,
      `  "pr list") cat ${JSON.stringify(prState)} ;;`,
      `  "pr create")`,
      `    printf '%s' '[{"number":77,"state":"OPEN","isDraft":true}]' > ${JSON.stringify(prState)}`,
      '    echo "https://github.com/owner/e2e/pull/77" ;;',
      '  "pr edit") echo "https://github.com/owner/e2e/pull/77" ;;',
      '  "issue comment") echo "https://github.com/owner/e2e/issues/300#c1" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });

  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "AGENTS.md"), "# rules\n");
  writeConfig(
    repo,
    ({
      maxParallel: 2,
      defaultChecks: ["true"],
      baselineChecks: [],
      agent: { command: "claude", timeoutMs: 30_000, runtime: "direct" },
    }),
  );
  git("add", ".");
  git("commit", "-m", "base");
  git("remote", "add", "origin", remote);
  return { dir, repo, bin, log, git, prState, worktrees: join(dir, "worktrees"), epics: join(dir, "epics"),
    reflections: join(dir, "reflections") };
};

const afk = (fx, args) =>
  spawnSync(process.execPath, [fileURLToPath(new URL("./epic.mjs", import.meta.url)), ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      PORT: SPAWNED_CHILD_PORT,
      AFK_WORKTREE_ROOT: fx.worktrees,
      AFK_EPIC_ROOT: fx.epics,
      AFK_REFLECTIONS_ROOT: fx.reflections,
    },
  });

const epic = (fx, extra = []) =>
  afk(fx, ["epic", String(EPIC_NUMBER), "--repo=owner/e2e", "--runtime=direct", ...extra]);

const ghCalls = (fx) =>
  existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean) : [];
const stateOf = (fx) => JSON.parse(readFileSync(join(fx.repo, ".afk", "state.json"), "utf8"));
const onBranch = (fx, path) => fx.git("show", `${BRANCH}:${path}`);

test("the whole epic lifecycle: gates, lanes, ledger, PR and close", { timeout: 600_000 }, async (t) => {
  const fx = fixture();
  // Registered before the first assertion, never after the last: a test that
  // fails half way through must not leave a repo, a worktree tree and a herdr
  // workspace behind. That is exactly how 1.7GB of /tmp accumulated unnoticed
  // (docs/findings.md 3.7).
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  await t.test("1 — a `gate: before` task blocks the run without a human", () => {
    const result = epic(fx);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);

    // The branch exists, but the gated root ran nothing and its dependants
    // cannot have started either.
    assert.match(fx.git("branch", "--list").stdout, /feat\/300-e2e/, "the branch was created");
    assert.match(output, /human-gated task\(s\) ready: 301/, output);
    const state = stateOf(fx);
    assert.equal(state.tasks["301"].lifecycle, "pending");
    assert.equal(state.tasks["302"].lifecycle, "pending");
    assert.equal(state.tasks["303"].lifecycle, "pending");
    assert.equal(existsSync(join(fx.repo, "file-301.txt")), false, "nothing was built");
  });

  await t.test("2 — releasing that one gate runs it, and only it", () => {
    const result = epic(fx, ["--task=301"]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);

    const state = stateOf(fx);
    assert.equal(state.tasks["301"].lifecycle, "passed", output);
    // 302 and 303 were unblocked by 301 passing, but `--task=` narrows the run
    // to the released gate: they must not have been dragged in behind it.
    assert.equal(state.tasks["302"].lifecycle, "pending");
    // 303 is `gate: after` — human work, never a lane. The moment the work it
    // gates lands it resolves to `awaiting_acceptance` rather than being
    // dispatched to a builder that cannot satisfy it.
    assert.equal(state.tasks["303"].lifecycle, "awaiting_acceptance");
    assert.equal(state.tasks["303"].builderAttempt ?? 0, 0, "a gate costs no lane");
    assert.equal(onBranch(fx, "file-301.txt").status, 0, "301's work is on the branch");
  });

  await t.test("3 — a ledger entry reaches the branch and the right lane's prompt", () => {
    const ledger = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./ledger.mjs", import.meta.url)),
        "add",
        "--type=constraint",
        "--source=301",
        "--applies-to=302",
        "--text=resolve Price by lookup_key, never a raw id",
      ],
      { cwd: fx.repo, encoding: "utf8" },
    );
    assert.equal(ledger.status, 0, `${ledger.stdout}\n${ledger.stderr}`);
    assert.equal(existsSync(join(fx.repo, LEDGER_RELATIVE)), true);
  });

  await t.test("4 — the remaining lanes fan out, integrate, and carry the ledger", () => {
    const result = epic(fx);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);

    const state = stateOf(fx);
    assert.equal(state.tasks["302"].lifecycle, "passed", output);
    assert.equal(state.tasks["303"].lifecycle, "awaiting_acceptance", output);
    assert.equal(onBranch(fx, "file-302.txt").status, 0);
    // Nothing built for 303, because nothing was asked of an agent.
    assert.notEqual(onBranch(fx, "file-303.txt").status, 0);

    // The ledger is a BRANCH artifact, not just a working-tree file. `.afk/` is
    // gitignored in this fixture, which is the hostile half.
    const committed = onBranch(fx, LEDGER_RELATIVE);
    assert.equal(committed.status, 0, "the gitignored ledger was force-added");
    assert.match(committed.stdout, /lookup_key/);

    // And it reached the lane it was tagged for, and no other.
    const prompt302 = readFileSync(
      join(fx.repo, ".afk", "runs", "302", "builder-1", "prompt.md"),
      "utf8",
    );
    assert.match(prompt302, /lookup_key/, "302 was told");
    // 303 has no prompt to read: a `gate: after` task is never given a lane, so
    // `applies_to` narrowing is moot for it and the absence is the assertion.
    assert.equal(
      existsSync(join(fx.repo, ".afk", "runs", "303", "builder-1", "prompt.md")),
      false,
      "303 is human work and was never prompted",
    );
  });

  await t.test("5 — an unaccepted `gate: after` holds the epic open, reviewed first", () => {
    const state = stateOf(fx);
    assert.equal(state.epicClose.lifecycle, "awaiting_acceptance", JSON.stringify(state.epicClose));
    assert.equal(state.epicClose.outcome, null, "a review cannot close an epic");
    assert.match(state.epicClose.reason, /303/);
    // The review runs when the epic STOPS, and an epic parked on a human's
    // acceptance has stopped. It runs BEFORE the acceptance on purpose: that is
    // the only order in which it can inform the person doing the accepting.
    assert.equal(
      existsSync(join(fx.repo, ".afk", "verifier", String(EPIC_NUMBER), "report.json")),
      true,
      "the human must be able to read the review before they accept",
    );
    assert.deepEqual(state.epicClose.verifier.outstanding, ["303 awaits human acceptance"]);
  });

  await t.test("6 — acceptance closes the epic, runs the verifier, and posts the closeout", () => {
    const result = epic(fx, ["--accept=303"]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);

    const state = stateOf(fx);
    assert.equal(state.tasks["303"].lifecycle, "passed", "the human's acceptance is the gate's verdict");
    assert.equal(state.epicClose.lifecycle, "closed", JSON.stringify(state.epicClose));
    assert.ok(
      ["completed", "completed_with_findings"].includes(state.epicClose.outcome),
      state.epicClose.outcome,
    );
    assert.equal(
      existsSync(join(fx.repo, ".afk", "epic-close", String(EPIC_NUMBER), "closeout.md")),
      true,
    );
    assert.ok(
      ghCalls(fx).some((call) => call.startsWith("issue comment")),
      "the closeout reached the epic issue",
    );
  });

  await t.test("7 — the draft PR exists by the time the epic closes", () => {
    // The regression this pins: the PR hook used to run ONLY at feature-branch
    // creation, where the branch is identical to its base and GitHub refuses to
    // open a PR. For an epic that finishes without a restart that was the only
    // attempt, so epic #3 closed having never opened a PR at all.
    const created = ghCalls(fx).filter((call) => call.startsWith("pr create"));
    assert.equal(created.length, 1, `expected exactly one PR to be opened:\n${created.join("\n")}`);
    assert.match(created[0], /--draft/);
    assert.match(created[0], new RegExp(`--base main --head ${BRANCH}`));
  });
});

test("an epic that finishes in ONE run still opens its draft PR", { timeout: 300_000 }, (t) => {
  // The exact shape that broke the first live epic (#3). The PR hook ran only at
  // feature-branch creation, where the branch is byte-identical to its base and
  // GitHub refuses to open a PR — it printed "it will be opened on the next run"
  // and there was no next run. Every gate here is absent on purpose: one
  // invocation goes from an empty branch to a closed epic, so if the PR is only
  // attempted at the start, it is never opened at all.
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const result = epic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  const state = stateOf(fx);
  assert.equal(state.tasks["301"].lifecycle, "passed", output);
  assert.equal(state.tasks["302"].lifecycle, "passed", output);
  assert.equal(state.epicClose.lifecycle, "closed", JSON.stringify(state.epicClose));

  const created = ghCalls(fx).filter((call) => call.startsWith("pr create"));
  assert.equal(created.length, 1, `no PR was opened in a single-run epic:\n${output}`);
  assert.match(created[0], /--draft/);
});

test("--worktree runs the whole epic without touching the checkout", { timeout: 300_000 }, (t) => {
  // The point of the flag, end to end: the branch, `.afk/` and every merge move
  // into a worktree of the epic's own, and the checkout the operator is sitting
  // in is on the same branch, with the same content, as before the run.
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const before = fx.git("rev-parse", "HEAD").stdout.trim();
  // A dirty checkout, because staying out of the operator's way is the promise:
  // the run must not refuse over it, and must not carry it onto the branch.
  writeFileSync(join(fx.repo, "scratch.txt"), "mid-edit\n");

  const result = epic(fx, ["--worktree"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  // The checkout is exactly where it was.
  assert.equal(fx.git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "main", output);
  assert.equal(fx.git("rev-parse", "HEAD").stdout.trim(), before, output);
  assert.equal(readFileSync(join(fx.repo, "scratch.txt"), "utf8"), "mid-edit\n");
  assert.equal(existsSync(join(fx.repo, ".afk", "state.json")), false, "run state landed in the checkout");

  // The run happened, in the epic's worktree.
  // In a private parent of its own, so a build path the project writes as
  // `../something` cannot be shared with a second epic running beside this one.
  const privateParent = join(fx.epics, readdirSync(fx.epics)[0]);
  assert.match(privateParent, new RegExp(`-${EPIC_NUMBER}$`));
  assert.deepEqual(readdirSync(privateParent), [basename(fx.repo)]);
  const runRoot = join(privateParent, basename(fx.repo));
  const state = JSON.parse(readFileSync(join(runRoot, ".afk", "state.json"), "utf8"));
  assert.equal(state.tasks["301"].lifecycle, "passed", output);
  assert.equal(state.tasks["302"].lifecycle, "passed", output);
  assert.equal(state.epicClose.lifecycle, "closed", JSON.stringify(state.epicClose));

  // Both tasks' work is on the branch, merged in the worktree, visible from the
  // checkout — one repository, two places to stand.
  assert.equal(onBranch(fx, "file-301.txt").status, 0, output);
  assert.equal(onBranch(fx, "file-302.txt").status, 0, output);
});

test("the PR is pushed and re-rendered on every merge, not only at the close", { timeout: 300_000 }, (t) => {
  // The branch used to stay unpushed for the whole run: a human opening the PR
  // mid-epic saw "2 pending" and no commits, on a run that was half done. Two
  // lanes here, so a per-merge render is visible as a count — one render per
  // merge, then one more at the close.
  //
  // The FIRST of those renders is what opens the PR. Branch creation has no
  // commits yet and GitHub will not open a PR on an empty diff, so before this
  // the epic's PR could not exist until the close.
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  // `pr: each` opts into the per-merge push that this test checks (#130).
  writeConfig(fx.repo, { maxParallel: 2, defaultChecks: ["true"], baselineChecks: [], agent: { command: "claude", timeoutMs: 30_000, runtime: "direct" }, pr: "each" });
  fx.git("add", ".");
  fx.git("commit", "-m", "pr-each config");
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const result = epic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  const renders = ghCalls(fx).filter((call) => /^pr (create|edit)/.test(call));
  assert.ok(
    renders.length >= 3,
    `expected a render per merge plus the close, got ${renders.length}:\n${renders.join("\n")}`,
  );
  // Opened at the first merge, not at the close: everything after it is an edit.
  assert.match(renders[0], /^pr create/);
  assert.ok(renders.slice(1).every((call) => call.startsWith("pr edit")), renders.join("\n"));

  // And the commits are actually on the remote, which is what CI would read.
  const remote = spawnSync("git", ["ls-remote", "--heads", "origin", BRANCH], {
    cwd: fx.repo, encoding: "utf8",
  });
  assert.match(remote.stdout, new RegExp(BRANCH), `branch never reached origin:\n${output}`);
});

test("default config (pr: once) pushes exactly once, at close", { timeout: 300_000 }, (t) => {
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const result = epic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  const pushes = ghCalls(fx).filter((call) => /^pr (create|edit)/.test(call));
  assert.equal(
    pushes.length, 1,
    `expected exactly 1 push (at close) under pr: once, got ${pushes.length}:\n${pushes.join("\n")}`,
  );
  assert.match(pushes[0], /^pr create/, "the single push opens the PR at close");

  const remote = spawnSync("git", ["ls-remote", "--heads", "origin", BRANCH], {
    cwd: fx.repo, encoding: "utf8",
  });
  assert.match(remote.stdout, new RegExp(BRANCH), `branch never reached origin:\n${output}`);
});

test("the run account is posted as a PR comment, not left in the body", { timeout: 300_000 }, (t) => {
  // The body is re-rendered from run state on every refresh and never read
  // back, so a closeout written there is overwritten with nothing to show it
  // existed. Five epic reflections reached that separately.
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const result = epic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  const comments = ghCalls(fx).filter((call) => call.startsWith("pr comment"));
  // Two: this one, and the reflection that follows it.
  assert.equal(comments.length, 2, `expected the run account and the reflection:\n${ghCalls(fx).join("\n")}`);
  assert.match(comments[0], /--body-file/);

  const body = readFileSync(join(fx.repo, ".afk", "epic-close", "300", "pr-comment.md"), "utf8");
  assert.match(body, /<!-- afk:run-account:300 -->/);
  assert.match(body, /## Closeout fixes/, body);
  // The issue comment still happens; the PR comment is additional, not a swap.
  assert.equal(ghCalls(fx).filter((call) => call.startsWith("issue comment")).length, 1);
});

test("the reflection is written to the runner's docs and posted as its own comment", { timeout: 300_000 }, (t) => {
  // Reflections live in the RUNNER's repository, one folder per project, which
  // is where the operator already keeps them — not on the project's branch.
  // They are also their own comment: the run account above is about the CODE
  // and is read before merging, this is about the RUN and is read when the same
  // thing goes wrong again.
  const fx = fixture(payloadFor(UNGATED_BODY, [CHILD(301, "Provision"), CHILD(302, "Widget")]));
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const result = epic(fx);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);

  // Written where the operator keeps them, under the REPO's name, not the
  // checkout's directory name — those differ once `--worktree` is in play.
  const path = join(fx.reflections, "e2e", `epic-${EPIC_NUMBER}.md`);
  assert.ok(existsSync(path), `no reflection at ${path}:\n${output}`);
  const written = readFileSync(path, "utf8");
  assert.match(written, /# Reflection/);
  // It read the evidence the runner staged, not the project — the run state and
  // the orchestrator log are there under their plain names.
  assert.match(written, /state\.json/, written);
  assert.match(written, /run\.log/, written);

  // Nothing of it reached the project's branch or its working tree.
  assert.equal(fx.git("status", "--porcelain").stdout.trim(), "", "the reflection dirtied the project");

  const comments = ghCalls(fx).filter((call) => call.startsWith("pr comment"));
  assert.equal(comments.length, 2, `expected the account AND the reflection:\n${comments.join("\n")}`);
  const posted = readFileSync(join(fx.repo, ".afk", "epic-close", "300", "pr-reflection.md"), "utf8");
  assert.match(posted, /<!-- afk:reflection:300 -->/);
  assert.match(posted, /commit it there if you want to keep it/);
});

// --- #292: per-task builder routing, in-process ------------------------------
// runAuto against the fake fixture with the env the spawned runs get, and a
// builder seam, so no test reaches a real provider or the real quota service.
// The routing assignment is seeded into `.afk/state.json`, which is where the
// router writes it.
const withFixtureEnv = async (fx, body) => {
  const previous = { PATH: process.env.PATH, PORT: process.env.PORT, AFK_BACKEND: process.env.AFK_BACKEND, AFK_WORKTREE_ROOT: process.env.AFK_WORKTREE_ROOT, AFK_REFLECTIONS_ROOT: process.env.AFK_REFLECTIONS_ROOT };
  process.env.PATH = `${fx.bin}:${process.env.PATH}`;
  process.env.PORT = SPAWNED_CHILD_PORT;
  process.env.AFK_BACKEND = "claude";
  process.env.AFK_WORKTREE_ROOT = fx.worktrees;
  process.env.AFK_REFLECTIONS_ROOT = fx.reflections;
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
};
const seedRouting = (fx, assignments) => {
  mkdirSync(join(fx.repo, ".afk"), { recursive: true });
  writeFileSync(join(fx.repo, ".afk", "state.json"), JSON.stringify({
    version: 1, activeWorkers: {}, integrationQueue: [], activeIntegrator: null, tasks: {},
    builderRouting: { assignments },
  }));
};
const CODEX_ASSIGNMENT = { preferredBackend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", reason: "bounded edit" };
const FAILED_BUILD = { outcome: "failed", verification: { agentExitCode: 1, producedFiles: [], checks: [], tokens: { input: 1, output: 1 } } };
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
// `jevKey` defaults to none, so these runs never reach the real Jev even when
// the shell running them holds a key; #294's tests pass a fake transport.
const routedRun = (fx, { maxParallel = 1, retries = 0, tasks, quotaProbe, builder, jevKey = null, jevFetch, jevTimeoutMs, providerQuotaProbe, routing }) => withFixtureEnv(fx, () => runAuto({
  root: fx.repo,
  config: { ...readConfig(fx.repo), maxParallel, supervisor: false, agent: { ...readConfig(fx.repo).agent, maxBuilderRetries: retries }, ...(routing ? { routing } : {}) },
  dag: { branch: "main", tasks: tasks.map(([id, scope]) => ({ id, title: `ticket ${id}`, body: `body of ${id}`, dependsOn: [], checks: ["true"], allowedPaths: scope })) },
  epic: { id: "400", title: "routing epic" },
  interactive: false,
  quotaProbe,
  builder,
  jevKey,
  ...(jevFetch ? { jevFetch } : {}),
  ...(jevTimeoutMs ? { jevTimeoutMs } : {}),
  ...(providerQuotaProbe ? { providerQuotaProbe } : {}),
}));

// #292 defect 1. The quota read never answers while the test watches; only
// after the window closes does the test release it. A waiting task keeps
// winning its own pick, so the leak shows only when an EARLIER task becomes
// runnable mid-wait: here 397's rate-limit retry comes due one second in.
for (const [label, maxParallel, tasks, expectedDuringWait] of [
  ["builder slot", 1, [["397", ["**"]], ["401", ["**"]]], ["397"]],
  ["scope claim", 3, [["397", ["src/shared"]], ["401", ["src/shared"]], ["398", ["src/other"]]], ["397", "398"]],
]) {
  test(`a task waiting on its quota read holds its ${label}`, { timeout: 120_000 }, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    seedRouting(fx, { 401: CODEX_ASSIGNMENT });
    const started = [];
    let releaseProbe = null;
    let probed = false;
    let first397 = true;
    const run = routedRun(fx, {
      maxParallel,
      tasks,
      quotaProbe: () => new Promise((resolveProbe) => { probed = true; releaseProbe = resolveProbe; }),
      builder: async ({ task, backend }) => {
        started.push(task.id);
        if (task.id === "397" && first397) {
          first397 = false;
          // Due again after the runner's 1s minimum: inside 401's wait.
          return { outcome: "rate_limited", verification: { rateLimited: true, agentExitCode: 1, producedFiles: [], checks: [] }, rateLimit: { resetsAt: (Date.now() - 29_500) / 1000 } };
        }
        if (task.id === "398") await sleep(6_000);
        return { ...FAILED_BUILD, backend };
      },
    });
    for (let waited = 0; waited < 8_000 && !probed; waited += 100) await sleep(100);
    await sleep(3_000);
    const duringWait = [...started];
    releaseProbe?.({ allowed: true, reason: "fresh" });
    await run;
    assert.equal(probed, true, "a Codex-assigned task reads its quota before it dispatches");
    assert.deepEqual(duringWait, expectedDuringWait, `nothing may take 401's ${label} while it waits on its quota read`);
  });
}

// #292 defect 2: a failed read decides that one lane; the next lane reads again.
test("a failed quota read sends that lane to Claude Opus and the next Codex lane reads again", { timeout: 120_000 }, async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  seedRouting(fx, { 401: CODEX_ASSIGNMENT, 402: CODEX_ASSIGNMENT });
  const launched = [];
  let probes = 0;
  await routedRun(fx, {
    tasks: [["401", ["**"]], ["402", ["**"]]],
    quotaProbe: async () => (++probes === 1
      ? { allowed: false, reason: "quota-axi timed out after 20 seconds" }
      : { allowed: true, reason: "fresh" }),
    builder: async ({ task, backend, model }) => { launched.push([task.id, backend, model]); return FAILED_BUILD; },
  });
  assert.deepEqual(launched, [["401", "claude", "claude-opus-5-5"], ["402", "codex", "gpt-5.6-luna"]]);
  assert.equal(probes, 2, "the second lane read its own quota");
  const state = stateOf(fx);
  assert.match(state.tasks["401"].builderRuns[0].reason, /quota-axi timed out/);
  assert.equal(state.tasks["402"].codexFallbackReason, undefined, "nothing turned Codex off");
});

// #292: exhaustion or a dead login on a Codex lane is retried on Claude Opus
// within the ordinary builder retry budget; both attempts' models are kept.
for (const [label, failure, reason] of [
  ["reports exhaustion", { outcome: "rate_limited", quotaRejected: true, verification: { rateLimited: true, quotaRejected: true } }, /usage limit exhausted/],
  ["fails its login", { outcome: "failed", verification: { authFailure: true } }, /codex login/],
]) {
  test(`a Codex lane that ${label} is retried on Claude Opus and run state keeps both attempts' models`, { timeout: 120_000 }, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    seedRouting(fx, { 401: CODEX_ASSIGNMENT });
    const launched = [];
    await routedRun(fx, {
      retries: 1,
      tasks: [["401", ["**"]], ["402", ["**"]]],
      quotaProbe: async () => ({ allowed: true, reason: "fresh" }),
      builder: async ({ task, backend, model }) => {
        launched.push([task.id, backend ?? "default", model ?? "default"]);
        if (task.id === "401" && backend === "codex") {
          return { ...failure, verification: { agentExitCode: 1, producedFiles: [], checks: [], agent: { backend: "codex", model, reasoningEffort: "max" }, ...failure.verification } };
        }
        return { ...FAILED_BUILD, verification: { ...FAILED_BUILD.verification, agent: { backend: backend ?? "claude", model: model ?? "claude-opus-5-5" } } };
      },
    });
    assert.deepEqual(launched.filter(([id]) => id === "401").slice(0, 2), [["401", "codex", "gpt-5.6-luna"], ["401", "claude", "claude-opus-5-5"]]);
    assert.deepEqual(launched.find(([id]) => id === "402"), ["402", "default", "default"], "an unassigned task launches exactly as before routing");
    const runs = stateOf(fx).tasks["401"].builderRuns;
    assert.deepEqual(runs.slice(0, 2).map(({ attempt, backend, model }) => ({ attempt, backend, model })), [
      { attempt: 1, backend: "codex", model: "gpt-5.6-luna" },
      { attempt: 2, backend: "claude", model: "claude-opus-5-5" },
    ], "the fallback spends a normal retry, and both attempts' actual models are recorded");
    assert.match(runs[1].reason, reason);
  });
}

// --- #294: the tier router, in-process ---------------------------------------
// A fake Jev that answers every ticket with one set of probabilities, and a
// fake two-provider quota read. Nothing reaches the network.
const ROUTINE_ANSWERS = { sensitive: 0.05, format: 0.05, shared_interface: 0.1, unknown_cause: 0.05, pattern_named: 0.9, concrete_criteria: 0.9, scope: 0, scopeConfidence: 0.9 };
const fakeJev = (answers = ROUTINE_ANSWERS, respond = null) => {
  const calls = [];
  const jevFetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (respond) return respond(calls.length);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.14.2",
        answers: {
          ...Object.fromEntries(Object.entries(answers).filter(([id]) => id !== "scope" && id !== "scopeConfidence").map(([id, value]) => [id, { noul: value }])),
          scope: { score: answers.scope, confidence: answers.scopeConfidence },
        },
      }),
    };
  };
  return { calls, jevFetch };
};
const quotaRead = (claude, codex) => async () => ({
  claude: claude === null ? { allowed: false, reason: "Claude quota state is stale or not fresh" } : { allowed: true, percent: claude },
  codex: codex === null ? { allowed: false, reason: "Codex quota semantics are unknown" } : { allowed: true, percent: codex },
});
const recordLaunches = (launched, outcome = () => FAILED_BUILD) => async ({ task, backend, model, attempt }) => {
  launched.push([task.id, backend ?? "default", model ?? "default"]);
  return outcome(task, attempt, backend, model);
};

for (const [label, claude, codex, expected] of [
  ["Claude reports more quota", 80, 30, ["claude", "claude-sonnet-5-5"]],
  ["Codex reports more quota", 20, 65, ["codex", "gpt-6.1-sol"]],
  ["neither provider is available", null, null, ["claude", "claude-opus-5-5"]],
]) {
  test(`a routine task launches on the right model when ${label}`, { timeout: 120_000 }, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const jev = fakeJev();
    const launched = [];
    let quotaReads = 0;
    await routedRun(fx, {
      tasks: [["401", ["**"]]],
      jevKey: "test-key",
      jevFetch: jev.jevFetch,
      providerQuotaProbe: () => { quotaReads += 1; return quotaRead(claude, codex)(); },
      quotaProbe: async () => { throw new Error("a routine lane reads both providers at once, not the Codex-only probe"); },
      builder: recordLaunches(launched),
    });
    assert.equal(jev.calls.length, 1, "one Jev request per ticket");
    assert.equal(quotaReads, 1);
    assert.deepEqual(launched, [["401", ...expected]]);
    const state = stateOf(fx);
    assert.equal(state.builderRouting.assignments["401"].tier, "routine");
    assert.equal(state.builderRouting.assignments["401"].jev.model, "jev-1.14.2");
    assert.equal(state.tasks["401"].builderRuns[0].tier, expected[1] === "claude-opus-5-5" ? "critical" : "routine");
  });
}

test("a routine task whose first attempt fails its gate retries on Opus, and state records both attempts", { timeout: 120_000 }, async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const launched = [];
  await routedRun(fx, {
    retries: 1,
    tasks: [["401", ["**"]]],
    jevKey: "test-key",
    jevFetch: fakeJev().jevFetch,
    providerQuotaProbe: quotaRead(10, 90),
    builder: recordLaunches(launched, (task, attempt, backend, model) => ({
      ...FAILED_BUILD,
      verification: { ...FAILED_BUILD.verification, agent: { backend, model } },
    })),
  });
  assert.deepEqual(launched.slice(0, 2), [["401", "codex", "gpt-6.1-sol"], ["401", "claude", "claude-opus-5-5"]]);
  const runs = stateOf(fx).tasks["401"].builderRuns;
  assert.deepEqual(runs.slice(0, 2).map(({ attempt, backend, model, tier }) => ({ attempt, backend, model, tier })), [
    { attempt: 1, backend: "codex", model: "gpt-6.1-sol", tier: "routine" },
    { attempt: 2, backend: "claude", model: "claude-opus-5-5", tier: "critical" },
  ]);
  assert.match(runs[1].reason, /retry runs on critical/);
});

test("a resumed run reuses the stored tier and makes no Jev request", { timeout: 120_000 }, async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  seedRouting(fx, { 401: { tier: "routine", reason: "routine: stored", routerSkipped: null, jev: { model: "jev-1.14.2", answers: ROUTINE_ANSWERS, deciding: ["pattern_named", "concrete_criteria"] } } });
  const jev = fakeJev();
  const launched = [];
  await routedRun(fx, {
    tasks: [["401", ["**"]]],
    jevKey: "test-key",
    jevFetch: jev.jevFetch,
    providerQuotaProbe: quotaRead(70, 10),
    builder: recordLaunches(launched),
  });
  assert.equal(jev.calls.length, 0, "the fake Jev was not called");
  assert.deepEqual(launched, [["401", "claude", "claude-sonnet-5-5"]]);
});

test("routing.tiers overriding routine changes the launched model", { timeout: 120_000 }, async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const launched = [];
  await routedRun(fx, {
    tasks: [["401", ["**"]]],
    jevKey: "test-key",
    jevFetch: fakeJev().jevFetch,
    providerQuotaProbe: quotaRead(70, 10),
    routing: { tiers: { routine: ["claude/claude-haiku-5-5"] } },
    builder: recordLaunches(launched),
  });
  assert.deepEqual(launched, [["401", "claude", "claude-haiku-5-5"]]);
});

for (const [label, jevKey, respond, reason] of [
  ["no key", null, null, /no TYPESAFE_API_KEY/],
  ["a 429", "test-key", () => ({ ok: false, status: 429 }), /429/],
  ["a 529", "test-key", () => ({ ok: false, status: 529 }), /529/],
  ["a thrown error", "test-key", () => { throw new Error("getaddrinfo ENOTFOUND"); }, /could not be reached/],
  ["a timeout", "test-key", () => new Promise(() => {}), /did not answer within/],
]) {
  test(`with ${label} every ticket is critical, the reason is recorded, and the run continues`, { timeout: 120_000 }, async (t) => {
    const fx = fixture();
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const jev = fakeJev(ROUTINE_ANSWERS, respond);
    const launched = [];
    await routedRun(fx, {
      tasks: [["401", ["src/a"]], ["402", ["src/b"]]],
      jevKey,
      jevFetch: jev.jevFetch,
      jevTimeoutMs: 200,
      providerQuotaProbe: async () => { throw new Error("a critical task reads no quota"); },
      builder: recordLaunches(launched),
    });
    const state = stateOf(fx);
    assert.deepEqual(launched.map(([id]) => id).sort(), ["401", "402"], "both lanes still ran");
    if (!jevKey) {
      assert.equal(jev.calls.length, 0);
      assert.match(state.builderRouting.skipped.reason, reason);
      assert.deepEqual(state.builderRouting.assignments, {});
      assert.deepEqual(launched.map(([, backend, model]) => [backend, model]), [["default", "default"], ["default", "default"]], "a run with no key launches exactly as before routing");
    } else {
      for (const id of ["401", "402"]) {
        assert.equal(state.builderRouting.assignments[id].tier, "critical");
        assert.match(state.builderRouting.assignments[id].routerSkipped, reason);
      }
      assert.deepEqual(launched.map(([, backend, model]) => [backend, model]), [["claude", "claude-opus-5-5"], ["claude", "claude-opus-5-5"]]);
    }
  });
}
