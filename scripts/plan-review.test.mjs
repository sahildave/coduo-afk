// scripts/plan-review.test.mjs — the semantic tier of validation.
//
// **No test in this file calls a real model or reaches the network.** There are
// two ways an agent is faked here and no third:
//
//   1. the injected `exec` seam on `runPlanReview`, which returns a canned exit
//      code and writes a canned JSONL transcript where the real command would;
//   2. a fake `claude` and a fake `gh` on PATH ahead of anything real, in a
//      throwaway git repo — the same fixture shape scripts/pr.test.mjs uses.
//
// The property under test is the one the whole role exists for: a contradiction
// aborts before any branch or worktree exists. `an epic whose plan review finds
// a contradiction creates nothing` at the bottom is what holds it, and it
// asserts on the repository's state, not on a log line.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./test-helpers.mjs";
import {
  ABORT_KINDS,
  PlanReviewFormatError,
  auditFindings,
  extractFindings,
  planReviewAgent,
  planReviewPrompt,
  renderPlanReview,
  runPlanReview,
  severityOf,
  verdictOf,
} from "./plan-review.mjs";
import { preflightSettings, roleFor } from "./roles.mjs";
import { buildAgentCommand } from "./lib.mjs";

// 204 → 205 → 208, and 206 parallel to 205. 208 reaches 206 only through 205.
const DAG = {
  epic: { id: "203", title: "Stripe" },
  branch: "feat/203-stripe",
  tasks: [
    { id: "204", title: "Schema", body: "Create the Price table.", dependsOn: [], checks: [], allowedPaths: ["**"] },
    { id: "205", title: "Lookup", body: "Resolve Price by lookup_key.", dependsOn: ["204"], checks: [], allowedPaths: ["**"] },
    { id: "206", title: "Webhook", body: "Handle invoice.paid.", dependsOn: ["204"], checks: [], allowedPaths: ["**"] },
    { id: "208", title: "Checkout", body: "Use the lookup helper.", dependsOn: ["205"], checks: [], allowedPaths: ["**"] },
  ],
};
const EPIC_BODY =
  "## Acceptance criteria\n- Checkout resolves prices by lookup_key.\n- The dashboard shows churn.\n";
const METRICS = {
  total: 4,
  rows: [
    { id: "204", depth: 0, blastRadius: 3, total: 4, dependsOn: [], dependents: ["205", "206", "208"] },
    { id: "205", depth: 1, blastRadius: 1, total: 4, dependsOn: ["204"], dependents: ["208"] },
    { id: "206", depth: 1, blastRadius: 0, total: 4, dependsOn: ["204"], dependents: [] },
    { id: "208", depth: 2, blastRadius: 0, total: 4, dependsOn: ["205"], dependents: [] },
  ],
};

const finding = (over = {}) => ({
  kind: "missing_dependency",
  tasks: ["208", "206"],
  criterion: "",
  evidence: "Use the webhook's receipt id.",
  severity: null,
  message: "208 needs 206's receipt id.",
  ...over,
});

// ---------------------------------------------------------------------------
// Seam 1 — the prompt: what the reviewer is actually given
// ---------------------------------------------------------------------------

test("the prompt carries the epic body, every child body, the edges and the graph math", () => {
  const text = planReviewPrompt({
    epic: { id: "203", title: "Stripe", body: EPIC_BODY },
    dag: DAG,
    metrics: METRICS,
  });
  assert.match(text, /Epic #203 — Stripe/);
  assert.match(text, /The dashboard shows churn/, "the acceptance criteria reach the reviewer");
  for (const task of DAG.tasks) {
    assert.ok(text.includes(`Task #${task.id}`), `#${task.id} is in the prompt`);
    assert.ok(text.includes(task.body), `#${task.id}'s body is in the prompt`);
  }
  assert.match(text, /depends_on: 205/);
  assert.match(text, /depends_on: nothing \(it is a root\)/);
  assert.match(text, /depth 0; blast radius 3 of 4/);
  assert.match(text, /```json/, "the output contract is stated as a schema");
});

test("the prompt states the five questions and nothing else, and says read-only", () => {
  const text = planReviewPrompt({ epic: { id: "203", body: "" }, dag: DAG, metrics: METRICS });
  assert.match(text, /Answer exactly five questions/);
  assert.match(text, /`missing_dependency`/);
  assert.match(text, /`scope_overlap`/);
  assert.match(text, /`unsatisfied_criterion`/);
  assert.match(text, /3\. `unsatisfied_criterion` — [^\n]*Every numbered user story in the epic body counts as a stated criterion/);
  assert.match(text, /4\. `needs_human` — does any criterion or instruction in a child issue need a human decision, approval or secret \(a key, a token, a login\) during the run\?/);
  assert.match(text, /"kind": "missing_dependency" \| "scope_overlap" \| "unsatisfied_criterion" \| "needs_human"/, "the contract carries the kind");
  assert.match(text, /READ-ONLY/);
  assert.match(text, /\{"findings": \[\]\}` is a complete and correct answer/);
});

test("an oversized issue body is truncated loudly, not silently dropped", () => {
  const huge = "x".repeat(12000);
  const text = planReviewPrompt({
    epic: { id: "1", body: "" },
    dag: { tasks: [{ id: "9", title: "Big", body: huge, dependsOn: [] }] },
    metrics: { rows: [] },
  });
  assert.ok(!text.includes(huge), "the whole body did not go into the prompt");
  assert.match(text, /\[truncated: 3000 more characters/);
});

test("custom instructions are context, and are placed after the five questions", () => {
  const text = planReviewPrompt({
    epic: { id: "1", body: "" },
    dag: DAG,
    metrics: METRICS,
    customInstructions: "be conservative with migrations",
  });
  assert.ok(
    text.indexOf("be conservative with migrations") > text.indexOf("unsatisfied_criterion"),
    "instructions cannot displace the questions",
  );
  assert.match(text, /it does not change the five questions above/);
});

// ---------------------------------------------------------------------------
// Seam 2 — the output contract
// ---------------------------------------------------------------------------

test("a clean review is an empty findings array, not silence", () => {
  assert.deepEqual(extractFindings('```json\n{"findings": []}\n```'), []);
});

test("the last fenced block wins, so a worked example earlier cannot be mistaken for the report", () => {
  const text = [
    "Here is the shape I will use:",
    '```json\n{"findings": [{"kind": "scope_overlap", "tasks": ["1","2"], "message": "example"}]}\n```',
    "And here is my actual report:",
    '```json\n{"findings": []}\n```',
  ].join("\n");
  assert.deepEqual(extractFindings(text), []);
});

test("an unfenced JSON object is still read, so a stray fence is not a failure", () => {
  const found = extractFindings(
    'My report:\n{"findings": [{"kind": "scope_overlap", "tasks": [205, 206], "message": "both touch checkout.ts"}]}',
  );
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].tasks, ["205", "206"], "numeric ids are normalized to strings");
});

test("a finding missing kind or message is a format error, not a weaker finding", () => {
  assert.throws(
    () => extractFindings('```json\n{"findings": [{"tasks": ["1"], "message": "x"}]}\n```'),
    PlanReviewFormatError,
  );
  assert.throws(
    () => extractFindings('```json\n{"findings": [{"kind": "scope_overlap"}]}\n```'),
    PlanReviewFormatError,
  );
});

test("prose with no JSON at all is a format error", () => {
  assert.throws(
    () => extractFindings("I found no contradictions in this plan. Looks good!"),
    PlanReviewFormatError,
  );
});

test("a JSON object with no findings array is a format error", () => {
  assert.throws(() => extractFindings('```json\n{"verdict": "ok"}\n```'), PlanReviewFormatError);
});

// ---------------------------------------------------------------------------
// Seam 3 — the audit: code refutes what the graph can refute
// ---------------------------------------------------------------------------

const audit = (findings, epicBody = EPIC_BODY) =>
  auditFindings({ findings, dag: DAG, epicBody });

test("a missing dependency the graph already satisfies transitively is dropped", () => {
  // 208 → 205 → 204. The reviewer only read `depends_on: 205` and missed 204.
  const { kept, dropped } = audit([finding({ tasks: ["208", "204"] })]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /already depends on #204 transitively/);
});

test("a genuine missing dependency survives the audit", () => {
  // 208 does not reach 206 at all: 206 is a sibling of 205, not an ancestor.
  const { kept, dropped } = audit([finding({ tasks: ["208", "206"] })]);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test("a finding naming a task that is not in this epic is dropped", () => {
  const { kept, dropped } = audit([finding({ tasks: ["208", "999"] })]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /#999, which is not a task in this epic/);
});

test("a scope overlap between tasks the graph orders is dropped — they never run together", () => {
  const { kept, dropped } = audit([
    finding({ kind: "scope_overlap", tasks: ["204", "208"], message: "both touch price.ts" }),
  ]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /ordered by the graph/);
});

test("a scope overlap between genuinely parallel tasks survives", () => {
  const { kept } = audit([
    finding({ kind: "scope_overlap", tasks: ["205", "206"], message: "both touch price.ts" }),
  ]);
  assert.equal(kept.length, 1);
});

test("an invented acceptance criterion is dropped — the quote must be in the epic body", () => {
  const { kept, dropped } = audit([
    finding({
      kind: "unsatisfied_criterion",
      tasks: [],
      criterion: "The system must support Apple Pay",
      message: "nothing does Apple Pay",
    }),
  ]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /does not appear in the epic body/);
});

test("a real criterion survives even when the reviewer reflows its whitespace", () => {
  const { kept } = audit([
    finding({
      kind: "unsatisfied_criterion",
      tasks: [],
      criterion: "The   dashboard\n  shows CHURN",
      message: "no task builds a dashboard",
    }),
  ]);
  assert.equal(kept.length, 1);
});

test("a criterion finding with no quote to check is dropped", () => {
  const { kept, dropped } = audit([
    finding({ kind: "unsatisfied_criterion", tasks: [], criterion: "", message: "something" }),
  ]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /no verbatim `criterion` quote/);
});

const humanFinding = (over = {}) =>
  finding({
    kind: "needs_human",
    tasks: ["206"],
    evidence: "Handle   invoice.paid.",
    message: "#206 needs the live webhook secret.",
    ...over,
  });

test("a needs_human finding quoting its task's body survives the audit", () => {
  const { kept, dropped } = audit([humanFinding()]);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 1);
});

test("a needs_human finding whose evidence is not in the named task's body is dropped", () => {
  // The sentence is #204's, not #206's.
  const { kept, dropped } = audit([humanFinding({ evidence: "Create the Price table." })]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /the quoted evidence does not appear in #206's body/);
  const short = audit([humanFinding({ evidence: "invoice" })]);
  assert.equal(short.kept.length, 0, "a quote under 12 characters proves nothing");
});

test("a needs_human finding names exactly one task", () => {
  for (const tasks of [[], ["205", "206"]]) {
    const { kept, dropped } = audit([humanFinding({ tasks })]);
    assert.equal(kept.length, 0);
    assert.match(dropped[0].reason, new RegExp(`names exactly one task, not ${tasks.length}`));
  }
});

test("a needs_human finding on a gated task is dropped: the gate already covers it", () => {
  for (const gate of [{ humanGated: true }, { gateAfter: true }]) {
    const dag = { ...DAG, tasks: DAG.tasks.map((task) => (task.id === "206" ? { ...task, ...gate } : task)) };
    const { kept, dropped } = auditFindings({ findings: [humanFinding()], dag, epicBody: EPIC_BODY });
    assert.equal(kept.length, 0);
    assert.equal(dropped[0].reason, "the gate already covers it");
  }
});

test("a needs_human finding never aborts the review, whatever severity it claims", () => {
  assert.equal(verdictOf([humanFinding({ severity: "contradiction" })]).abort, false);
});

// ---------------------------------------------------------------------------
// Seam 4 — the verdict, decided in code
// ---------------------------------------------------------------------------

test("the abort set is exactly the three kinds nothing downstream recovers from", () => {
  assert.deepEqual([...ABORT_KINDS].sort(), ["inconsistent_ticket", "missing_dependency", "unsatisfied_criterion"]);
});

test("a scope overlap warns and proceeds — v1 scope is advisory", () => {
  const verdict = verdictOf([finding({ kind: "scope_overlap", severity: "contradiction" })]);
  assert.equal(verdict.abort, false, "the reviewer cannot upgrade a warn-kind by asserting harder");
  assert.equal(verdict.warnings.length, 1);
});

test("a missing dependency aborts", () => {
  assert.equal(verdictOf([finding()]).abort, true);
});

test("the reviewer may downgrade an abort-kind to a warning to express low confidence", () => {
  assert.equal(verdictOf([finding({ severity: "warning" })]).abort, false);
  assert.equal(severityOf(finding({ severity: "warning" })), "warning");
});

test("a kind the runner has never heard of warns — it cannot stop a run", () => {
  assert.equal(verdictOf([finding({ kind: "vibes_mismatch" })]).abort, false);
});

test("no findings is no abort", () => {
  assert.equal(verdictOf([]).abort, false);
});

// ---------------------------------------------------------------------------
// Seam 5 — read-only enforcement, as rendered onto the invocation
// ---------------------------------------------------------------------------

test("the role's rendered settings permit no write anywhere and deny the write tools", () => {
  const role = roleFor("plan-reviewer");
  const settings = preflightSettings(role, "/some/worktree");
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [], "an empty allowWrite, deliberately");
  assert.equal(settings.sandbox.enabled, true);
  for (const rule of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch"]) {
    assert.ok(settings.permissions.deny.includes(rule), `${rule} is denied`);
  }
});

test("Skill(herdr) is denied, in both the bare and the argument form", () => {
  const deny = preflightSettings(roleFor("plan-reviewer"), "/x").permissions.deny;
  assert.ok(deny.includes("Skill(herdr)"));
  assert.ok(deny.includes("Skill(herdr *)"));
});

test("the invocation never carries --dangerously-skip-permissions, and does carry the sandbox", () => {
  const role = roleFor("plan-reviewer");
  const agent = planReviewAgent(role, { agent: { model: "m" } });
  const command = buildAgentCommand(agent, {
    nodeBin: "/n",
    promptPath: "/p",
    streamPath: "/s",
    taskId: "plan-review-203",
    processName: role.processName("203"),
  });
  assert.ok(
    !command.includes("--dangerously-skip-permissions"),
    "docs/epic-schema.md: only implementer and integrator get bypass",
  );
  assert.match(command, /--settings /);
  const settings = JSON.parse(command.match(/--settings '(.*?)' --append-system-prompt /s)[1].replaceAll("'\\''", "'"));
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, []);
  assert.ok(settings.permissions.deny.includes("Skill(herdr)"));
});

test("the role pins a short timeout rather than inheriting the 15-minute lane ceiling", () => {
  assert.equal(roleFor("plan-reviewer").timeoutMs, 300_000);
});

// ---------------------------------------------------------------------------
// Seam 6 — runPlanReview, driven entirely through its injected `exec`
// ---------------------------------------------------------------------------

// A fake agent: writes the transcript the real command would have written, then
// returns an exit code. Nothing spawns; nothing resolves a hostname.
const fakeAgent = (turns) => {
  const calls = [];
  let turn = 0;
  return {
    calls,
    exec: async (command) => {
      calls.push(command);
      const streamPath = command.match(/> '([^']*stream-\d+\.jsonl)'/)[1];
      const script = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      writeFileSync(
        streamPath,
        script.transcript ??
          `${JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: script.text ?? "" }], usage: { input_tokens: 900, output_tokens: 120 } },
          })}\n`,
      );
      return { status: script.status ?? 0, stdout: "", stderr: script.stderr ?? "", timedOut: false };
    },
  };
};

const review = async (turns, over = {}) => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-test-"));
  const agent = fakeAgent(turns);
  const outcome = await runPlanReview({
    root: runDir,
    config: {},
    epic: { id: "203", title: "Stripe", body: EPIC_BODY },
    dag: DAG,
    metrics: METRICS,
    runDir,
    exec: agent.exec,
    ...over,
  });
  return { outcome, runDir, calls: agent.calls };
};

test("a clean review proceeds and reports token cost", async () => {
  const { outcome, runDir } = await review([{ text: '```json\n{"findings": []}\n```' }]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "clean");
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.tokens, { contextTokens: 900, outputTokens: 120 });
  assert.ok(existsSync(join(runDir, "prompt.md")), "the prompt is kept for debugging");
  rmSync(runDir, { recursive: true, force: true });
});

test("a contradiction refuses, and names the tasks in the rendering", async () => {
  const { outcome } = await review([
    {
      text: `\`\`\`json
{"findings": [{"kind": "missing_dependency", "tasks": ["208", "206"], "evidence": "the receipt id", "message": "208 consumes 206's receipt id but does not depend on it"}]}
\`\`\``,
    },
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "contradiction");
  assert.equal(outcome.contradictions.length, 1);
  const text = renderPlanReview(outcome);
  assert.match(text, /✗ missing_dependency \[#208 → #206\]/);
  assert.match(text, /No branch, worktree or pull request was created/);
});

test("a finding the graph refutes proceeds, and the drop is reported rather than hidden", async () => {
  const { outcome } = await review([
    {
      text: '```json\n{"findings": [{"kind": "missing_dependency", "tasks": ["208", "204"], "message": "208 needs the Price table"}]}\n```',
    },
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.dropped.length, 1);
  assert.match(renderPlanReview(outcome), /· dropped missing_dependency: .*already depends on #204/);
});

test("an auth failure refuses with the same words the runner already uses, and never retries", async () => {
  const { outcome, calls } = await review([
    { status: 1, transcript: '{"type":"result","subtype":"error","result":"OAuth session expired"}\n' },
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "auth_failure");
  assert.match(outcome.message, /claude auth login/);
  assert.equal(calls.length, 1, "a dead login is not a transient — do not pay for a second call");
});

test("unparseable output is retried once, then refuses; it is never read as clean", async () => {
  const { outcome, calls } = await review([{ text: "Looks fine to me!" }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "unusable");
  assert.equal(calls.length, 2, "one retry, bounded");
  assert.match(outcome.message, /did not return a usable report/);
});

test("a transient bad turn followed by a good one proceeds", async () => {
  const { outcome, calls } = await review([
    { text: "sorry, thinking out loud" },
    { text: '```json\n{"findings": []}\n```' },
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
});

test("an agent that exits non-zero with no output is retried, then refuses", async () => {
  const { outcome } = await review([{ status: 127, transcript: "", stderr: "claude: not found" }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "unusable");
  assert.match(outcome.message, /exited 127/);
});

test("a corrupt carry-forward store refuses before the reviewer session is paid for", async () => {
  const storeDir = mkdtempSync(join(tmpdir(), "afk-plan-review-store-"));
  const storePath = join(storeDir, "203.json");
  writeFileSync(storePath, "{ not json");
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-test-"));
  try {
    const agent = fakeAgent([{ text: '```json\n{"findings": []}\n```' }]);
    await assert.rejects(
      runPlanReview({
        root: runDir, config: {}, epic: { id: "203", title: "Stripe", body: EPIC_BODY },
        dag: DAG, metrics: METRICS, runDir, storePath, exec: agent.exec,
      }),
      /plan-review store .* is not valid JSON/,
    );
    assert.equal(agent.calls.length, 0, "no reviewer session ran");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a store whose findings is not an array refuses and is left as it was", async () => {
  const storeDir = mkdtempSync(join(tmpdir(), "afk-plan-review-store-"));
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-test-"));
  try {
    for (const contents of ["{}", '{"findings":null}']) {
      const storePath = join(storeDir, "203.json");
      writeFileSync(storePath, contents);
      const agent = fakeAgent([{ text: '```json\n{"findings": []}\n```' }]);
      await assert.rejects(
        runPlanReview({
          root: runDir, config: {}, epic: { id: "203", title: "Stripe", body: EPIC_BODY },
          dag: DAG, metrics: METRICS, runDir, storePath, exec: agent.exec,
        }),
        /plan-review store .* has no findings array/,
        contents,
      );
      assert.equal(agent.calls.length, 0, `no reviewer session ran for ${contents}`);
      assert.equal(readFileSync(storePath, "utf8"), contents, "the store was not overwritten");
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Seam 7 — end to end: a contradiction aborts before anything exists
// ---------------------------------------------------------------------------

const EPIC_YAML = [
  "```yaml",
  "afk:",
  "  version: 1",
  "  branch: feat/203-stripe",
  "  tasks:",
  "    204:",
  "      depends_on: []",
  "    205:",
  "      depends_on: [204]",
];
const SCHEMA_BODY = "Create the Price table.\n\n## Acceptance criteria\n\n- The Price table exists\n";
const epicJson = ({ yaml = [], schemaBody = SCHEMA_BODY } = {}) => JSON.stringify({
  data: {
    repository: {
      issue: {
        number: 203,
        title: "Stripe subscriptions",
        state: "OPEN",
        body: [
          "## Acceptance criteria",
          "- Checkout resolves prices by lookup_key.",
          "",
          ...EPIC_YAML,
          ...yaml,
          "```",
        ].join("\n"),
        subIssues: {
          totalCount: 2,
          nodes: [
            // The criteria sections are load-bearing: a child that states none
            // is a `no_acceptance_criteria` error and this epic never validates.
            { number: 204, title: "Schema", state: "OPEN", body: schemaBody },
            { number: 205, title: "Lookup", state: "OPEN", body: "Resolve Price by lookup_key.\n\n## Acceptance criteria\n\n- A price resolves by lookup_key\n" },
          ],
        },
      },
    },
  },
});

// `claude` here is a shell script that ignores its prompt and prints one
// stream-json line. It cannot reach a model; `gh` is a shell script too, and
// `origin` never exists. The whole fixture is a directory under $TMPDIR.
const fixture = (reviewOutput, epic = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-plan-review-e2e-"));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin, repo]);
  writeFileSync(join(dir, "epic.json"), epicJson(epic));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, "gh.log"))}`,
      'case "$1 $2" in',
      `  "api graphql") cat ${JSON.stringify(join(dir, "epic.json"))} ;;`,
      '  "pr list") echo "[]" ;;',
      '  "pr create") echo "https://github.com/x/y/pull/1" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The transcript is `cat`ed from a file, never interpolated into the script:
  // a review report contains ``` fences, and a backtick inside a double-quoted
  // shell string is command substitution.
  writeFileSync(
    join(dir, "review.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: reviewOutput }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`,
  );
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, "claude.log"))}`,
      "cat > /dev/null",
      `cat ${JSON.stringify(join(dir, "review.jsonl"))}`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(
    repo,
    ({ maxParallel: 1, defaultChecks: ["true"] }),
  );
  git("add", ".");
  git("commit", "-m", "base");
  return { dir, repo, bin, git };
};

const afk = (fx, args) => {
  // The outer runner may have an explicit dashboard PORT. These fixtures are
  // separate projects and must use their own derived ports, especially when
  // the suite runs as an active epic's baseline check and that port is bound.
  // Each fixture has its own carry-forward store, outside its repository.
  const env = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, AFK_PLAN_REVIEW_STORE: join(fx.dir, "store") };
  delete env.PORT;
  return spawnSync(process.execPath, [fileURLToPath(new URL("./epic.mjs", import.meta.url)), ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
};

const CONTRADICTION = `\`\`\`json
{"findings": [{"kind": "unsatisfied_criterion", "tasks": [], "criterion": "Checkout resolves prices by lookup_key.", "evidence": "no task mentions checkout", "message": "no task in this epic builds checkout"}]}
\`\`\``;

test("an epic whose plan review finds a contradiction creates nothing", () => {
  const fx = fixture(CONTRADICTION);
  const branchesBefore = fx.git("branch", "--list").stdout;
  const result = afk(fx, ["epic", "203", "--repo=owner/afk"]);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /✗ unsatisfied_criterion/);
  assert.match(result.stderr, /plan review refused/);

  // The assertion that matters is the repository's, not the log's.
  assert.equal(fx.git("branch", "--list").stdout, branchesBefore, "no feature branch");
  assert.equal(
    fx.git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(),
    "main",
    "still on the base branch",
  );
  assert.equal(fx.git("status", "--porcelain").stdout.trim(), "", "working tree untouched");
  assert.equal(existsSync(join(fx.repo, ".afk", "state.json")), false, "no run state");
  const calls = existsSync(join(fx.dir, "gh.log"))
    ? readFileSync(join(fx.dir, "gh.log"), "utf8").trim().split("\n")
    : [];
  assert.ok(!calls.some((call) => /^pr /.test(call)), "no draft pull request was opened");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("the plan review really ran, read-only, with the sandbox on the invocation", () => {
  const fx = fixture(CONTRADICTION);
  afk(fx, ["epic", "203", "--repo=owner/afk"]);
  const invocation = readFileSync(join(fx.dir, "claude.log"), "utf8");
  assert.ok(invocation.includes("--settings"), "the fake claude really was invoked, with a profile");
  assert.ok(
    !invocation.includes("--dangerously-skip-permissions"),
    "the reviewer is not given bypass",
  );
  assert.ok(invocation.includes("Skill(herdr)"), "herdr is denied on the invocation");
  assert.ok(invocation.includes('"allowWrite":[]'), "and it may write nowhere");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk validate` alone starts no agent at all", () => {
  const fx = fixture(CONTRADICTION);
  const result = afk(fx, ["validate", "203", "--repo=owner/afk"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VALIDATE: ok\. Nothing was created\./);
  assert.equal(
    existsSync(join(fx.dir, "claude.log")),
    false,
    "the deterministic tier must stay usable with no model and no login",
  );
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk validate --plan-review` opts in, refuses, and still creates nothing in the repo", () => {
  const fx = fixture(CONTRADICTION);
  const result = afk(fx, ["validate", "203", "--repo=owner/afk", "--plan-review"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ unsatisfied_criterion/);
  assert.ok(existsSync(join(fx.dir, "claude.log")), "the flag really started the reviewer");
  assert.equal(existsSync(join(fx.repo, ".afk")), false, "and wrote nothing into the repository");
  assert.equal(fx.git("status", "--porcelain").stdout.trim(), "");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("a clean plan review lets `afk epic` get as far as creating the branch", () => {
  const fx = fixture('```json\n{"findings": []}\n```');
  // The run itself will not get far — `claude` is a stub and there is no
  // remote — but the branch is the first thing downstream of the review, and its
  // existence is what proves the gate opened rather than silently held.
  afk(fx, ["epic", "203", "--repo=owner/afk"]);
  assert.match(fx.git("branch", "--list").stdout, /feat\/203-stripe/);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seam 8 — needs_human: a forecast stop, never a refusal of its own
// ---------------------------------------------------------------------------

const NEEDS_HUMAN_BODY = `Create the Price table.\n\nAsk the owner to paste the live Stripe secret key into Infisical before running the migration.\n\n## Acceptance criteria\n\n- The Price table exists\n`;
const NEEDS_HUMAN = "```json\n" + JSON.stringify({
  findings: [{
    kind: "needs_human",
    tasks: ["204"],
    evidence: "Ask the owner to paste the live Stripe secret key into Infisical before running the migration.",
    message: "#204 needs a human to provision the live Stripe key mid-run.",
  }],
}) + "\n```";

test("a needs_human finding passes the review and becomes a forecast stop over its task and dependants", () => {
  const fx = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY });
  const result = afk(fx, ["validate", "203", "--repo=owner/afk", "--plan-review", "--json"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.planReview.ok, true, "a needs_human finding never refuses the review");
  const stop = report.forecast.stops.find((entry) => entry.kind === "needs_human");
  assert.equal(stop.task, "204");
  assert.deepEqual(stop.blocks, ["204", "205"], "the task and its dependant");
  assert.match(stop.note, /paste the live Stripe secret key into Infisical/, "the forecast line quotes the evidence");
  assert.equal(report.forecast.unanswered, 1);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("the human rendering prints the raised stop after the plan review", () => {
  const fx = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY });
  const result = afk(fx, ["validate", "203", "--repo=owner/afk", "--plan-review"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /- stop: needs_human \[#204\]/);
  assert.match(result.stdout, /^ {2}#204 needs_human\. Parks 2 of 2 tasks \(#204, #205\)\. Needs a human: "Ask the owner to paste .*"\. Answer: none\.$/m);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk validate --unattended` refuses an unanswered needs_human stop by name, and is ready once it is parked", () => {
  const open = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY });
  const refused = afk(open, ["validate", "203", "--repo=owner/afk", "--unattended"]);
  assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
  assert.equal(refused.stdout.trim().split("\n").at(-1), "UNATTENDED: refused: 1 stop unanswered (#204). Nothing was created.");
  rmSync(open.dir, { recursive: true, force: true });

  const parked = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY, yaml: ["  stops:", "    204: park"] });
  const ready = afk(parked, ["validate", "203", "--repo=owner/afk", "--unattended"]);
  assert.equal(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.equal(ready.stdout.trim().split("\n").at(-1), "UNATTENDED: ready. 1 stop, all answered.");
  rmSync(parked.dir, { recursive: true, force: true });
});

test("`afk validate --plan-review` writes its carry-forward store only where AFK_PLAN_REVIEW_STORE points", () => {
  const fx = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY });
  const result = afk(fx, ["validate", "203", "--repo=owner/afk", "--plan-review"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const stored = JSON.parse(readFileSync(join(fx.dir, "store", "owner-afk", "203.json"), "utf8"));
  assert.deepEqual(stored.findings.map((entry) => [entry.kind, entry.tasks]), [["needs_human", ["204"]]]);
  assert.ok(!Number.isNaN(Date.parse(stored.findings[0].raisedAt)), "each entry records when it was raised");
  assert.equal(fx.git("status", "--porcelain").stdout, "", "nothing inside the repository");
  assert.equal(existsSync(join(fx.repo, ".afk")), false);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("`afk epic --unattended` refuses an unanswered needs_human stop before the branch exists", () => {
  const fx = fixture(NEEDS_HUMAN, { schemaBody: NEEDS_HUMAN_BODY });
  const result = afk(fx, ["epic", "203", "--repo=owner/afk", "--unattended"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /UNATTENDED: refused: 1 stop unanswered \(#204\)\. No branch, worktree or pull request was created\./);
  assert.doesNotMatch(fx.git("branch", "--list").stdout, /feat\/203-stripe/);
  rmSync(fx.dir, { recursive: true, force: true });
});
