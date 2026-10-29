// scripts/pr.test.mjs — the epic's draft PR.
//
// Two things are under test, and the split matters:
//
//   1. `renderPrBody` — pure. State and DAG in, markdown out. Exhaustively
//      testable with no process, which is the point of keeping the `gh` half thin.
//   2. `ensureDraftPr` — the `gh` half, driven entirely through its injected
//      `exec` seam. **No test in this file touches the network.** Every `gh` and
//      `git` invocation is either a recorded fake function or a fake `gh` script
//      on PATH in a throwaway repo with a local bare remote.
//
// The load-bearing property is direction: run state renders *into* the PR body
// and never back out. `never asks GitHub for a PR body` below is what holds it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./test-helpers.mjs";
import {
  ensureDraftPr,
  findEpicPr,
  prMarker,
  renderPrBody,
  renderPrOutcome,
  renderPrTitle,
} from "./pr.mjs";
import { parseVerifierOutput } from "./verifier.mjs";
import { prMode, PR_OFF, PR_ONCE, PR_EACH } from "./pr.mjs";
import { freePort } from "./free-port.mjs";

// One port for this file's spawned children, taken from the OS at load.
// The call sites are synchronous `spawnSync` helpers, so the await is hoisted.
const SPAWNED_CHILD_PORT = String(await freePort());

// ---------------------------------------------------------------------------
// prMode — the `pr:` config knob (#130)
// ---------------------------------------------------------------------------

test("prMode defaults to once when absent", () => {
  assert.equal(prMode({}), "once");
  assert.equal(prMode(null), "once");
  assert.equal(prMode(undefined), "once");
});

test("prMode accepts off, once, each", () => {
  assert.equal(prMode({ pr: "off" }), "off");
  assert.equal(prMode({ pr: "once" }), "once");
  assert.equal(prMode({ pr: "each" }), "each");
});

test("prMode rejects unknown values with a named error", () => {
  assert.throws(() => prMode({ pr: "always" }), /`pr: always` .* is not a valid mode/);
  assert.throws(() => prMode({ pr: true }), /is not a valid mode/);
});

// ---------------------------------------------------------------------------

const EPIC = { id: "255", title: "Keymap" };
const DAG = {
  epic: EPIC,
  branch: "feat/255-keymap",
  tasks: [
    { id: "256", title: "Parser", dependsOn: [], humanGated: true },
    { id: "257", title: "Renderer", dependsOn: ["256"] },
  ],
};
const STATE = {
  tasks: { 256: { lifecycle: "passed" }, 257: { lifecycle: "running" } },
};
const AT = "2026-08-18T09:00:00.000Z";

const body = (overrides = {}) =>
  renderPrBody({
    epic: EPIC,
    branch: "feat/255-keymap",
    baseBranch: "main",
    dag: DAG,
    state: STATE,
    renderedAt: AT,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Seam 1 — the renderer, pure
// ---------------------------------------------------------------------------

test("the body renders the DAG's shape and state.json's lifecycles", () => {
  const text = body();
  assert.match(text, /\| 256 \| Parser 🔒 \| passed \| - \|/);
  assert.match(text, /\| 257 \| Renderer \| running \| 256 \|/);
  assert.match(text, /\*\*2 tasks\*\* — 1 passed, 1 running\./);
  assert.match(text, /Epic #255 — Keymap/);
  assert.match(text, /Branch `feat\/255-keymap` into `main`/);
});

test("a task state.json has never heard of renders pending, not blank", () => {
  const text = body({ state: {} });
  assert.match(text, /\| 256 \| Parser 🔒 \| pending \| - \|/);
  assert.match(text, /\*\*2 tasks\*\* — 2 pending\./);
});

test("the body carries the marker and says it is a view, not the source", () => {
  const text = body();
  assert.ok(text.startsWith(prMarker("255")), "self-identifies as runner-owned");
  assert.match(text, /never reads it back/);
  assert.match(text, /Edits here will be lost/);
  assert.match(text, new RegExp(AT.replace(/[.]/g, "\\.")));
});

test("the renderer is deterministic — same inputs, byte-identical body", () => {
  assert.equal(body(), body(), "no clock, no ordering, no randomness leaks in");
});

test("epic-wide custom instructions surface when set, and cost nothing when not", () => {
  assert.match(
    body({ state: { ...STATE, customInstructions: "Be conservative." } }),
    /### Epic-wide instructions\n\n> Be conservative\./,
  );
  assert.doesNotMatch(body(), /Epic-wide instructions/);
});

test("an empty epic renders a body rather than a crash", () => {
  const text = renderPrBody({ epic: {}, dag: { tasks: [] }, renderedAt: AT });
  assert.match(text, /No tasks in this epic's `afk:` block\./);
  assert.equal(renderPrTitle({ epic: {}, branch: "feat/x" }), "Epic — feat/x");
});

// ---------------------------------------------------------------------------
// Seam 2 — create-or-update, through the injected exec
// ---------------------------------------------------------------------------

// Records every command and answers from a table of [matcher, result] pairs.
// Anything unmatched succeeds silently, so a test only states what it cares about.
const fakeExec = (answers = []) => {
  const calls = [];
  const exec = (command) => {
    calls.push(command);
    for (const [pattern, result] of answers) {
      if (pattern.test(command)) {
        return typeof result === "function" ? result(command) : result;
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  exec.saw = (pattern) => calls.some((command) => pattern.test(command));
  return exec;
};

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr) => ({ status: 1, stdout: "", stderr });

const NO_PR = [/gh pr list/, ok("[]")];
const AHEAD = [/git rev-list --count/, ok("3\n")];
const HAS_REMOTE_BRANCH = [/git rev-parse --verify/, ok("abc\n")];

const ensure = (answers, overrides = {}) => {
  const exec = fakeExec(answers);
  const outcome = ensureDraftPr({
    root: "/tmp/nowhere",
    repo: "owner/afk",
    branch: "feat/255-keymap",
    baseBranch: "main",
    epic: EPIC,
    dag: DAG,
    state: STATE,
    renderedAt: AT,
    exec,
    ...overrides,
  });
  return { outcome, exec };
};

test("with no PR and commits on the branch, it opens a draft PR", () => {
  const { outcome, exec } = ensure([
    NO_PR,
    AHEAD,
    HAS_REMOTE_BRANCH,
    [/gh pr create/, ok("https://github.com/owner/afk/pull/42\n")],
  ]);
  assert.equal(outcome.action, "created");
  assert.equal(outcome.number, 42);
  assert.deepEqual(outcome.warnings, []);
  assert.ok(exec.saw(/gh pr create .*--draft/), "draft, never a ready PR");
  assert.ok(exec.saw(/--base 'main' --head 'feat\/255-keymap'/));
  // Was `!exec.saw(/git push/)` — "the branch was already on the remote". That
  // is exactly the assumption that let epic #4 close six commits behind: a
  // remote branch existing says nothing about it being current. The push is now
  // unconditional whenever the branch is ahead of its base.
  assert.ok(exec.saw(/git push -u origin 'feat\/255-keymap'/), "pushed anyway");
});

test("the body handed to gh is the rendered view, passed as a file", () => {
  let written = null;
  ensure([
    NO_PR,
    AHEAD,
    HAS_REMOTE_BRANCH,
    [
      /gh pr create/,
      (command) => {
        written = readFileSync(/--body-file '([^']+)'/.exec(command)[1], "utf8");
        return ok("https://github.com/owner/afk/pull/42\n");
      },
    ],
  ]);
  assert.equal(written, body(), "byte-identical to the pure renderer's output");
});

test("an existing open PR is re-rendered, never duplicated", () => {
  const { outcome, exec } = ensure([
    [/gh pr list/, ok(JSON.stringify([{ number: 42, state: "OPEN", isDraft: true }]))],
  ]);
  assert.equal(outcome.action, "updated");
  assert.equal(outcome.number, 42);
  assert.ok(exec.saw(/gh pr edit 42 /), "restart updates the same PR");
  assert.ok(!exec.saw(/gh pr create/), "and opens no second one");
  assert.ok(!exec.saw(/git push/), "and pushes nothing");
});

test("'does it exist' is asked of GitHub, so no PR number is ever persisted", () => {
  // The restart story: `.afk/` could be wiped entirely and the second call still
  // finds the same PR, because the branch → number mapping is GitHub's, not ours.
  const first = ensure([
    [/gh pr list/, ok(JSON.stringify([{ number: 42, state: "OPEN", isDraft: true }]))],
  ]);
  const second = ensure(
    [[/gh pr list/, ok(JSON.stringify([{ number: 42, state: "OPEN", isDraft: true }]))]],
    { state: {} },
  );
  assert.equal(first.outcome.number, 42);
  assert.equal(second.outcome.number, 42);
  assert.ok(second.exec.saw(/gh pr edit 42 /));
});

test("never asks GitHub for a PR body — the flow is one-directional", () => {
  const exec = fakeExec([[/gh pr list/, ok("[]")]]);
  findEpicPr({ repo: "owner/afk", branch: "feat/255-keymap", exec });
  assert.match(exec.calls[0], /--json number,state,isDraft\b/);
  assert.doesNotMatch(exec.calls[0], /body/);
  // And the module as a whole never reads one back.
  const source = readFileSync(fileURLToPath(new URL("./pr.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /gh pr view/);
});

test("a freshly branched epic with no commits is a note, not a warning", () => {
  const { outcome, exec } = ensure([NO_PR, [/git rev-list --count/, ok("0\n")]]);
  assert.equal(outcome.action, "skipped");
  assert.deepEqual(outcome.warnings, []);
  assert.match(outcome.notes[0], /no commits on `feat\/255-keymap` yet/);
  // Not "on the next run": since the close-time refresh, the PR opens as soon as
  // a lane integrates and at the latest when this epic closes. The old wording
  // sent an operator away to wait for a run that, for a single-run epic, was
  // never coming (docs/findings.md 3.9).
  assert.match(outcome.notes[0], /at the latest when the epic closes/);
  assert.doesNotMatch(outcome.notes[0], /next `afk epic` run/);
  assert.ok(!exec.saw(/gh pr create/));
  assert.ok(!exec.saw(/git push/), "nothing is pushed for a PR that cannot exist");
});

test("a branch missing from the remote is pushed before the PR is opened", () => {
  const { outcome, exec } = ensure([
    NO_PR,
    AHEAD,
    [/git rev-parse --verify/, fail("")],
    [/gh pr create/, ok("https://github.com/owner/afk/pull/7\n")],
  ]);
  assert.equal(outcome.action, "created");
  assert.ok(exec.saw(/git push -u origin 'feat\/255-keymap'/));
  assert.match(outcome.notes[0], /pushed `feat\/255-keymap` to origin/);
});

// --- failure is always a warning, never a halt ------------------------------

test("an unauthenticated gh warns and names the fix; the run is not failed", () => {
  const { outcome } = ensure([
    [/gh pr list/, fail("gh: To get started with GitHub CLI, please run: gh auth login")],
  ]);
  assert.equal(outcome.action, "failed");
  assert.match(outcome.warnings[0], /gh auth login/);
  assert.match(outcome.warnings[0], /The run continues/);
});

test("a repo with no origin remote warns with the git command that fixes it", () => {
  const { outcome, exec } = ensure([
    NO_PR,
    AHEAD,
    [/git remote get-url origin/, fail("error: No such remote 'origin'")],
  ]);
  assert.equal(outcome.action, "skipped");
  assert.match(outcome.warnings[0], /git remote add origin/);
  assert.ok(!exec.saw(/gh pr create/));
});

test("a failing gh pr create warns; the caller still runs the epic", () => {
  const { outcome } = ensure([
    NO_PR,
    AHEAD,
    HAS_REMOTE_BRANCH,
    [/gh pr create/, fail("HTTP 503")],
  ]);
  assert.equal(outcome.action, "failed");
  assert.match(outcome.warnings[0], /HTTP 503/);
});

test("an exec that throws — gh absent from PATH — is contained, not propagated", () => {
  const outcome = ensureDraftPr({
    root: "/tmp/nowhere",
    repo: "owner/afk",
    branch: "feat/255-keymap",
    dag: DAG,
    exec: () => {
      throw new Error("spawnSync gh ENOENT");
    },
  });
  assert.equal(outcome.action, "failed");
  assert.match(outcome.warnings[0], /ENOENT/);
  assert.match(outcome.warnings[0], /nothing reads the PR body/);
});

test("a closed or merged PR is reported, not silently reopened", () => {
  const { outcome, exec } = ensure([
    [/gh pr list/, ok(JSON.stringify([{ number: 9, state: "MERGED", isDraft: false }]))],
  ]);
  assert.equal(outcome.action, "skipped");
  assert.match(outcome.warnings[0], /PR #9 .* is merged; not reopening/);
  assert.ok(!exec.saw(/gh pr create/));
  assert.ok(!exec.saw(/gh pr edit/));
});

test("renderPrOutcome prints something for every outcome that has news", () => {
  assert.match(renderPrOutcome({ action: "created", number: 42, notes: [], warnings: [] }), /opened draft PR #42/);
  assert.match(renderPrOutcome({ action: "updated", number: 42, notes: [], warnings: [] }), /refreshed draft PR #42/);
  assert.equal(renderPrOutcome({ action: "skipped", number: null, notes: [], warnings: [] }), "");
});

// ---------------------------------------------------------------------------
// End to end, offline: `afk validate` creates nothing; `afk epic` opens the PR
// ---------------------------------------------------------------------------

const EPIC_BODY = [
  "```yaml",
  "afk:",
  "  version: 1",
  "  branch: feat/255-keymap",
  "  max_parallel: 1",
  "  tasks:",
  "    256:",
  "      depends_on: []",
  "      gate: before",
  "```",
].join("\n");

const GH_PAYLOAD = JSON.stringify({
  data: {
    repository: {
      issue: {
        number: 255,
        title: "Keymap",
        state: "OPEN",
        body: EPIC_BODY,
        subIssues: {
          totalCount: 1,
          // A child without criteria is a `no_acceptance_criteria` error, so this
          // fixture states them or nothing here validates.
          nodes: [{ number: 256, title: "Parser", state: "OPEN", body: "spec\n\n## Acceptance criteria\n\n- The parser reads the block\n" }],
        },
      },
    },
  },
});

// A fake `gh` and a fake `claude`, both on PATH ahead of anything real. Nothing
// in this fixture can reach the network: `gh` is a shell script, and `origin` is
// a bare repository on the local filesystem.
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-pr-"));
  const repo = join(dir, "work");
  const remote = join(dir, "remote.git");
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  const payload = join(dir, "epic.json");
  spawnSync("git", ["init", "--bare", "-b", "main", remote]);
  spawnSync("mkdir", ["-p", bin, repo]);
  writeFileSync(payload, GH_PAYLOAD);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1 $2" in',
      `  "api graphql") cat ${JSON.stringify(payload)} ;;`,
      '  "pr list") echo "[]" ;;',
      '  "pr create") echo "https://github.com/x/y/pull/42" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // `afk epic` runs the read-only plan-reviewer before it creates the branch
  // (scripts/plan-review.mjs), and a reviewer that returns nothing refuses the
  // run. So the fake agent emits the one thing that contract accepts as "clean":
  // an empty findings array. Still a shell script; still offline.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(join(dir, "clean-review.jsonl"))}\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "clean-review.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: '```json\n{"findings": []}\n```' }] },
    })}\n`,
  );

  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(
    repo,
    ({ maxParallel: 1, defaultChecks: ["true"] }),
  );
  git("add", ".");
  git("commit", "-m", "base");
  git("remote", "add", "origin", remote);
  return { dir, repo, bin, log, git };
};

const afk = (fx, args) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./epic.mjs", import.meta.url)), ...args],
    {
      cwd: fx.repo,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${fx.bin}:${process.env.PATH}`,
        PORT: SPAWNED_CHILD_PORT,
      },
    },
  );

const ghCalls = (fx) =>
  existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean) : [];

test("`afk validate` opens no PR, and creates nothing at all", () => {
  const fx = fixture();
  const before = fx.git("branch", "--list").stdout;
  const result = afk(fx, ["validate", "255", "--repo=owner/afk"]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VALIDATE: ok\. Nothing was created\./);

  // The proof, not the assertion: every `gh` invocation validate made, in full.
  const calls = ghCalls(fx);
  assert.ok(calls.length > 0, "validate did call gh — this fake is really in use");
  for (const call of calls) {
    assert.ok(
      call.startsWith("api graphql") || call.startsWith("repo view"),
      `validate made a non-read-only gh call: ${call}`,
    );
  }
  assert.ok(!calls.some((call) => /^pr /.test(call)), "no pull-request call at all");

  // And nothing on disk moved either.
  assert.equal(fx.git("branch", "--list").stdout, before, "no branch was created");
  assert.equal(existsSync(join(fx.repo, ".afk")), false, "no .afk/ was created");
  assert.equal(
    fx.git("status", "--porcelain").stdout.trim(),
    "",
    "no file was written into the repository",
  );
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk epic` opens the draft PR once the branch has a commit, then runs", () => {
  const fx = fixture();
  // `pr: each` reproduces the old push-at-start behaviour this test checks.
  writeConfig(fx.repo, { maxParallel: 1, defaultChecks: ["true"], pr: "each" });
  fx.git("add", ".");
  fx.git("commit", "-m", "pr-each config");
  // A branch with a commit main lacks: the shape a real epic reaches after its
  // first lane integrates, and the only shape GitHub will open a PR for.
  fx.git("checkout", "-b", "feat/255-keymap");
  writeFileSync(join(fx.repo, "note.txt"), "work\n");
  fx.git("add", ".");
  fx.git("commit", "-m", "first lane");
  fx.git("checkout", "main");

  const result = afk(fx, ["epic", "255", "--repo=owner/afk", "--runtime=direct"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /EPIC: opened draft PR #42\./);

  const created = ghCalls(fx).find((call) => call.startsWith("pr create"));
  assert.ok(created, "the hook reached gh pr create");
  assert.match(created, /--draft/);
  assert.match(created, /--base main --head feat\/255-keymap/);

  // The PR is opened before the run starts, not after it ends.
  assert.ok(
    result.stdout.indexOf("opened draft PR") < result.stdout.indexOf("AUTO:"),
    "the hook runs at branch creation, ahead of the handover to runAuto",
  );
  // Regression, found by this test: scripts/auto.mjs imports scripts/epic.mjs,
  // so a top-level `await` in epic.mjs's CLI deadlocked the dynamic import back
  // into it — `afk epic` died with ERR_UNSETTLED_TOP_LEVEL_AWAIT (exit 13) and
  // runAuto never ran a line. Exit 0 with AUTO output is what proves it fixed.
  assert.match(result.stdout, /AUTO: continuous scheduler started/);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `pr:` config — minimal pushes to origin (#130)
// ---------------------------------------------------------------------------

test("default config (pr: once) skips the start push, the run still starts", () => {
  const fx = fixture();
  fx.git("checkout", "-b", "feat/255-keymap");
  writeFileSync(join(fx.repo, "note.txt"), "work\n");
  fx.git("add", ".");
  fx.git("commit", "-m", "first lane");
  fx.git("checkout", "main");

  const result = afk(fx, ["epic", "255", "--repo=owner/afk", "--runtime=direct"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /opened draft PR/);
  assert.ok(!ghCalls(fx).some((call) => call.startsWith("pr create")), "no PR created at start");
  assert.ok(!ghCalls(fx).some((call) => call.startsWith("pr edit")), "no PR edited at start");
  assert.match(result.stdout, /AUTO: continuous scheduler started/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("an invalid pr: value refuses the run at epic time", () => {
  const fx = fixture();
  writeConfig(fx.repo, { maxParallel: 1, defaultChecks: ["true"], pr: "always" });
  fx.git("add", ".");
  fx.git("commit", "-m", "bad pr config");

  const result = afk(fx, ["epic", "255", "--repo=owner/afk", "--runtime=direct"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /`pr: always` .* is not a valid mode/);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `afk epic <id> --task=<id>` — releasing a human gate from the epic path
// ---------------------------------------------------------------------------
//
// These live here rather than in epic.test.mjs because this is where the fake
// `gh` and fake `claude` fixture is, and `cliEpic` cannot be exercised without
// both. The gap they close: `afk epic` never passed `explicitTaskId` to
// `runAuto`, so releasing a gate meant dumping `afk validate --json`'s `dag` key
// to a temp file and running `afk run --task= --dag=` against it — a workaround
// for the fact that the epic path deliberately writes no spec file to disk.

test("`afk epic --task=` releases that one gate, having re-validated the epic", () => {
  const fx = fixture();
  const result = afk(fx, ["epic", "255", "--repo=owner/afk", "--runtime=direct", "--task=256"]);
  const output = `${result.stdout}\n${result.stderr}`;

  // Re-validated: the epic was fetched and its graph printed before anything ran.
  assert.match(result.stdout, /Graph \(1 tasks\)/, output);
  // And handed to runAuto narrowed to the released task. Task 256 is `gate:
  // before` in this fixture, so without the flag the scheduler refuses to run it
  // at all — this line is only reachable when explicitTaskId arrives.
  assert.match(output, /explicit task 256/, output);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk epic --task=` naming a task the epic does not have creates nothing", () => {
  const fx = fixture();
  const before = fx.git("branch", "--list").stdout;
  const result = afk(fx, ["epic", "255", "--repo=owner/afk", "--task=999"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--task=999 is not a task in epic #255 \(256\)/);
  // Refused before the plan review spends a session and before anything exists.
  assert.equal(fx.git("branch", "--list").stdout, before, "no branch");
  assert.equal(existsSync(join(fx.repo, ".afk")), false, "no .afk/");
  assert.ok(!ghCalls(fx).some((call) => /^pr /.test(call)), "no pull-request call");
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seam 4 — the verifier's report, rendered into the body
// ---------------------------------------------------------------------------
//
// Lane H built `renderVerifierMarkdown` and Lane K built this body; neither lane
// owned both files, so the two halves shipped unconnected. The wiring is a data
// change: a `verifierReport` argument and one `lines.push`. What needs testing
// is not the markdown — verifier.test.mjs owns that — but the two ends of the
// argument: absent renders nothing at all, and present reaches `gh` from disk.

const verifierFixture = () =>
  parseVerifierOutput({
    text: [
      "```json",
      JSON.stringify({
        summary: "The parser landed. The renderer has no undo path.",
        criteria: [{ id: "256.1", verdict: "met", evidence: "scripts/parser.mjs:41" }],
        findings: [
          {
            axis: "spec",
            severity: "blocker",
            title: "no undo path",
            detail: "the spec asks for it",
            file: "scripts/render.mjs",
          },
        ],
        mustFix: ["wire the undo path before this ships"],
      }),
      "```",
    ].join("\n"),
    criteria: [
      { id: "256.1", taskId: "256", source: "issue", text: "parses a keymap file" },
    ],
    meta: { epic: EPIC, branch: "feat/255-keymap", baseBranch: "main", ranAt: AT },
  });

test("with no verifier report the body is byte-identical to before the wiring", () => {
  const text = body();
  assert.ok(!text.includes("## Verifier"), "no empty section");
  assert.ok(!text.includes("No verifier report"), "and no placeholder either");
  // `renderVerifierMarkdown(null)` renders a placeholder on purpose, for
  // `afk verify --markdown`. The PR body must not inherit it: for most of a
  // run's life there is nothing to say, and a placeholder reads as a verifier
  // that ran and found nothing rather than one that never ran.
  assert.equal(body({ verifierReport: null }), text);
  assert.equal(body({ verifierReport: undefined }), text);
});

test("a verifier report renders into the body, after the progress a human scans", () => {
  const text = body({ verifierReport: verifierFixture() });
  assert.match(text, /## Verifier/);
  assert.match(text, /Recommendation: `must-fix`/);
  assert.match(text, /parses a keymap file/, "the criterion, with its verdict");
  assert.match(text, /wire the undo path before this ships/);
  assert.ok(
    text.indexOf("## Progress") < text.indexOf("## Verifier"),
    "the closeout goes last; mid-run, progress is what the human is looking for",
  );
  // Still one trailing newline and no run of blank lines, like every other body.
  assert.ok(text.endsWith("\n") && !text.includes("\n\n\n"));
});

test("ensureDraftPr picks the report up off disk, so no caller has to know the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-pr-verifier-"));
  mkdirSync(join(dir, ".afk", "verifier", "255"), { recursive: true });
  writeFileSync(
    join(dir, ".afk", "verifier", "255", "report.json"),
    JSON.stringify(verifierFixture()),
  );
  const bodyWrittenTo = (root) => {
    let written = null;
    ensure(
      [
        NO_PR,
        AHEAD,
        HAS_REMOTE_BRANCH,
        [
          /gh pr create/,
          (command) => {
            written = readFileSync(/--body-file '([^']+)'/.exec(command)[1], "utf8");
            return ok("https://github.com/owner/afk/pull/42\n");
          },
        ],
      ],
      { root },
    );
    return written;
  };
  assert.match(bodyWrittenTo(dir), /## Verifier/);
  assert.match(bodyWrittenTo(dir), /Recommendation: `must-fix`/);
  // A root with no report writes exactly the body it always did.
  assert.equal(bodyWrittenTo(join(dir, "empty")), body());
  rmSync(dir, { recursive: true, force: true });
});
