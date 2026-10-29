// scripts/plan-review-gate.test.mjs — the plan reviewer's findings have
// consequences, which is the thing six live epics proved they did not.
//
// Sibling to scripts/plan-review.test.mjs, which covers the prompt, the parse,
// the audit and the transport. This file covers only the two properties added
// after the overnight run:
//
//   1. an `unsatisfied_criterion` naming a task that has not started BLOCKS, and
//      the model's `severity` dial cannot talk it down;
//   2. every finding that does not block leaves a written decision behind.
//
// Nothing here spawns a process or reaches the network: the pure seams are
// called directly, and `runPlanReview` is driven through its injected `exec`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDecisions,
  renderPlanReview,
  runPlanReview,
  severityOf,
  verdictOf,
} from "./plan-review.mjs";

// Epic #5's shape, reduced: a shared module, then two screens repointed at it,
// and no task that deletes the originals.
const DAG = {
  epic: { id: "5", title: "One session lifecycle" },
  tasks: [
    { id: "34", title: "Shared module", body: "Create the shared machine.", dependsOn: [] },
    { id: "37", title: "Passage screen", body: "Repoint the passage screen.", dependsOn: ["34"] },
    { id: "38", title: "Freestyle screen", body: "Repoint the freestyle screen.", dependsOn: ["34"] },
  ],
};
const EPIC_BODY =
  "## Acceptance criteria\n" +
  "- the lifecycle that both session hooks duplicate is lifted into one place they share\n";
const METRICS = { total: 3, rows: [] };

const criterionFinding = (over = {}) => ({
  kind: "unsatisfied_criterion",
  tasks: ["34", "37", "38"],
  criterion: "the lifecycle that both session hooks duplicate is lifted into one place they share",
  evidence: "#34 only creates the shared module.",
  severity: null,
  message: "No task strips the duplicated logic out of the two session hooks.",
  ...over,
});

const overlapFinding = (over = {}) => ({
  kind: "scope_overlap",
  tasks: ["37", "38"],
  criterion: "",
  evidence: "both edit SessionTopBar.tsx",
  severity: null,
  message: "#37 and #38 both edit SessionTopBar.tsx.",
  ...over,
});

// ---------------------------------------------------------------------------
// 1 — the gate
// ---------------------------------------------------------------------------

test("an unsatisfied criterion on a task that has not started blocks the run", () => {
  const verdict = verdictOf([criterionFinding()], new Set());
  assert.equal(verdict.abort, true);
  assert.equal(verdict.contradictions.length, 1);
});

test("the reviewer cannot downgrade an unsatisfied criterion to a warning", () => {
  // Epic #5 verbatim: this exact finding arrived as advisory, was correct, and
  // changed nothing. `severity` is the model's confidence, not its authority.
  const verdict = verdictOf([criterionFinding({ severity: "warning" })], new Set());
  assert.equal(verdict.abort, true, "a warning severity does not buy a pass");
  assert.equal(severityOf(criterionFinding({ severity: "warning" }), new Set()), "contradiction");
});

test("the model keeps its downgrade on every other abort kind", () => {
  const missing = {
    kind: "missing_dependency",
    tasks: ["37", "38"],
    criterion: "",
    evidence: "",
    severity: "warning",
    message: "#37 may need #38's helper.",
  };
  assert.equal(verdictOf([missing], new Set()).abort, false);
});

test("a criterion naming only tasks that have already run is advisory again", () => {
  // The repair is "put the criterion back on the task". Once every task it names
  // has run, that repair does not exist, and this project has no plan-review
  // override — blocking forever would leave a restart with no move at all.
  const started = new Set(["34", "37", "38"]);
  const verdict = verdictOf([criterionFinding({ severity: "warning" })], started);
  assert.equal(verdict.abort, false);
  assert.equal(verdict.warnings.length, 1);
});

test("one pending task among finished ones is enough to keep the block", () => {
  const verdict = verdictOf([criterionFinding({ severity: "warning" })], new Set(["34", "37"]));
  assert.equal(verdict.abort, true, "#38 is still pending, so the criterion can still land on it");
});

test("a criterion no task at all could satisfy blocks — the repair is to add one", () => {
  assert.equal(verdictOf([criterionFinding({ tasks: [] })], new Set(["34"])).abort, true);
});

// ---------------------------------------------------------------------------
// 2 — the hand-back: what the runner refuses to do itself
// ---------------------------------------------------------------------------

test("the refusal names the repair and hands it to coduo-tickets rather than patching", () => {
  const text = renderPlanReview({
    status: "contradiction",
    contradictions: [criterionFinding()],
    warnings: [],
    dropped: [],
  });
  assert.match(text, /✗ unsatisfied_criterion \[#34 → #37 → #38\]/);
  assert.match(text, /No branch, worktree or pull request was created/);
  assert.match(text, /Put the criterion back on the named task/);
  assert.match(text, /coduo-tickets/);
  assert.match(text, /rendered Mermaid/, "the reason the runner does not hand-patch is stated");
});

test("a non-criterion refusal does not print the criterion hand-back", () => {
  const text = renderPlanReview({
    status: "contradiction",
    contradictions: [{ kind: "missing_dependency", tasks: ["37", "38"], message: "needs it" }],
    warnings: [],
    dropped: [],
  });
  assert.doesNotMatch(text, /coduo-tickets/);
});

// ---------------------------------------------------------------------------
// 3 — the decision record
// ---------------------------------------------------------------------------

test("every finding leaves the review with either accepted or blocked against it", () => {
  const text = renderDecisions([criterionFinding(), overlapFinding()], new Set(), new Date(0));
  assert.match(text, /## 1970-01-01T00:00:00\.000Z/);
  assert.match(text, /\*\*blocked\*\* — unsatisfied_criterion \[#34 → #37 → #38\]/);
  assert.match(text, /\*\*accepted\*\* — scope_overlap \[#37 → #38\]/);
});

test("a clean review still records that there was nothing to decide", () => {
  assert.match(renderDecisions([], new Set(), new Date(0)), /nothing to decide/);
});

test("a warning is printed as the decision it is, not as a mention", () => {
  const text = renderPlanReview({ status: "clean", contradictions: [], warnings: [overlapFinding()], dropped: [] });
  assert.match(text, /- accepted: scope_overlap \[#37 → #38\]/);
});

// ---------------------------------------------------------------------------
// 4 — end to end through runPlanReview's injected exec
// ---------------------------------------------------------------------------

const fakeExec = (text) => async (command) => {
  const streamPath = command.match(/> '([^']*stream-\d+\.jsonl)'/)[1];
  writeFileSync(
    streamPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } },
    })}\n`,
  );
  return { status: 0, stdout: "", stderr: "", timedOut: false };
};

const review = async (findings, started = new Set()) => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-gate-"));
  const outcome = await runPlanReview({
    root: runDir,
    config: {},
    epic: { id: "5", title: "One session lifecycle", body: EPIC_BODY },
    dag: DAG,
    metrics: METRICS,
    runDir,
    started,
    exec: fakeExec("```json\n" + JSON.stringify({ findings }) + "\n```"),
  });
  return { outcome, runDir };
};

test("epic #5's advisory warning would now refuse the run", async () => {
  const { outcome, runDir } = await review([
    {
      kind: "unsatisfied_criterion",
      tasks: ["34", "37", "38"],
      criterion:
        "the lifecycle that both session hooks duplicate is lifted into one place they share",
      severity: "warning",
      message: "No task strips the duplicated logic out of the two session hooks.",
    },
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "contradiction");
  assert.match(readFileSync(join(runDir, "decisions.md"), "utf8"), /\*\*blocked\*\* — unsatisfied_criterion/);
  rmSync(runDir, { recursive: true, force: true });
});

test("an accepted finding survives the run on disk, and restarts append rather than erase", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-gate-"));
  const body = "```json\n" + JSON.stringify({ findings: [overlapFinding()] }) + "\n```";
  const once = () =>
    runPlanReview({
      root: runDir,
      config: {},
      epic: { id: "5", title: "One session lifecycle", body: EPIC_BODY },
      dag: DAG,
      metrics: METRICS,
      runDir,
      exec: fakeExec(body),
    });
  const first = await once();
  await once();
  assert.equal(first.ok, true, "a scope overlap still does not block");
  const written = readFileSync(join(runDir, "decisions.md"), "utf8");
  assert.equal(
    written.match(/\*\*accepted\*\* — scope_overlap/g).length,
    2,
    "the second attempt appended its decision instead of overwriting the first",
  );
  rmSync(runDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5 — a stable verdict: a refusing finding is carried forward until its quoted
//     text is edited out or its task leaves the graph
// ---------------------------------------------------------------------------

const storeReview = ({ storePath, findings, epicBody = EPIC_BODY, dag = DAG }) => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-plan-review-carry-"));
  return runPlanReview({
    root: runDir,
    config: {},
    epic: { id: "5", title: "One session lifecycle", body: epicBody },
    dag,
    metrics: METRICS,
    runDir,
    storePath,
    exec: fakeExec("```json\n" + JSON.stringify({ findings }) + "\n```"),
  });
};

test("the flip: a refused epic stays refused while the quoted criterion stands, and passes once it is edited out", async () => {
  const store = mkdtempSync(join(tmpdir(), "afk-plan-review-store-"));
  const storePath = join(store, "owner-afk", "5.json");
  const raised = criterionFinding({ evidence: "Create the shared machine." });

  const run1 = await storeReview({ storePath, findings: [raised] });
  assert.equal(run1.ok, false, "run 1 refuses");

  // Same bodies, and this sample of the reviewer happens to say nothing.
  const run2 = await storeReview({ storePath, findings: [] });
  assert.equal(run2.ok, false, "run 2 still refuses: the finding is carried");
  assert.equal(run2.contradictions.length, 1, "carried once, not twice");
  assert.ok(run2.contradictions[0].carried, "marked carried");
  const rendered = renderPlanReview(run2);
  assert.match(rendered, /✗ unsatisfied_criterion \[#34 → #37 → #38\]: .* \(carried from the review at \d{4}-\d\d-\d\dT[^)]+\)/);
  assert.match(readFileSync(join(run2.runDir, "decisions.md"), "utf8"), /\*\*blocked\*\* — unsatisfied_criterion .* \(carried from the review at /);
  if (process.env.AFK_PLAN_REVIEW_PRINT) console.log(rendered);

  // The reviewer raising it again is the same finding, not a second one.
  const again = await storeReview({ storePath, findings: [raised] });
  assert.equal(again.contradictions.length, 1);

  // The criterion is edited out of the epic body: nothing left to carry.
  const run3 = await storeReview({
    storePath,
    findings: [],
    epicBody: "## Acceptance criteria\n- each screen keeps its own lifecycle\n",
  });
  assert.equal(run3.ok, true, "run 3 passes");
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).findings, [], "and the store forgets it");
  rmSync(store, { recursive: true, force: true });
});

test("a stored finding naming a task no longer in the DAG is not carried", async () => {
  const store = mkdtempSync(join(tmpdir(), "afk-plan-review-store-"));
  const storePath = join(store, "owner-afk", "5.json");
  await storeReview({ storePath, findings: [criterionFinding({ evidence: "Create the shared machine." })] });
  const smaller = { ...DAG, tasks: DAG.tasks.filter((task) => task.id !== "38") };
  const outcome = await storeReview({ storePath, findings: [], dag: smaller });
  assert.equal(outcome.ok, true, "#38 left the graph, so the finding is not carried");
  assert.equal(outcome.findings.length, 0);
  rmSync(store, { recursive: true, force: true });
});

test("a carried missing dependency stops once the edge is added, though its quote still stands", async () => {
  const store = mkdtempSync(join(tmpdir(), "afk-plan-review-store-"));
  const storePath = join(store, "owner-afk", "5.json");
  const missing = {
    kind: "missing_dependency",
    tasks: ["38", "37"],
    evidence: "Repoint the freestyle screen.",
    message: "#38 needs the passage screen's adapter.",
  };
  assert.equal((await storeReview({ storePath, findings: [missing] })).ok, false);
  assert.equal((await storeReview({ storePath, findings: [] })).ok, false, "carried while the edge is missing");
  const fixed = { ...DAG, tasks: DAG.tasks.map((task) => (task.id === "38" ? { ...task, dependsOn: ["34", "37"] } : task)) };
  assert.equal((await storeReview({ storePath, findings: [], dag: fixed })).ok, true, "the edge is the repair");
  rmSync(store, { recursive: true, force: true });
});
