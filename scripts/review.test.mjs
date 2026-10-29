// scripts/review.test.mjs — the fifth plan-review question (`inconsistent_ticket`)
// and the `afk review plan` / `afk review ticket` verbs.
//
// No test here calls a real model or reaches the network. The fakes are the two
// scripts/plan-review.test.mjs uses: the injected `exec` seam on `runPlanReview`,
// and a fake `claude` and `gh` on PATH in a throwaway directory.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./test-helpers.mjs";
import {
  auditFindings,
  carriedFindings,
  extractFindings,
  findingKey,
  planReviewPrompt,
  renderPlanReview,
  runPlanReview,
  severityOf,
  verdictOf,
} from "./plan-review.mjs";

// Modelled on atlas#1237 after the 2026-10-13 edit: The owner withdrew "refuse
// past 50", the chief of staff changed the ruling line, and two acceptance
// criteria still say the seat add "fails closed".
const RULING = "Ruling (owner, 2026-10-13): past 50 seats the account keeps working and each extra seat is billed; nothing is refused.";
const STALE_A = "Adding a 51st seat fails closed: the request is refused with 402 and nothing is billed.";
const STALE_B = "If the seat-count check errors, the seat add fails closed and no invoice line is written.";
const TICKET_1237 = [
  "Enforce the seat cap on the Team plan.",
  "",
  RULING,
  "",
  "## Acceptance criteria",
  "",
  `- ${STALE_A}`,
  `- ${STALE_B}`,
  "- The seat counter in Settings shows 50/50 when the plan is full.",
  "",
  "## Red tests",
  "",
  "- `seat_cap.test.ts` adds 51 seats and expects the 51st to be billed.",
  "",
].join("\n");

const DAG = {
  tasks: [
    { id: "1236", title: "Seat model", body: "Add a seats column.\n\n## Acceptance criteria\n\n- seats exists\n", dependsOn: [] },
    { id: "1237", title: "Seat cap", body: TICKET_1237, dependsOn: ["1236"] },
  ],
};

const inconsistent = (over = {}) => ({
  kind: "inconsistent_ticket",
  tasks: ["1237"],
  criterion: "",
  evidence: RULING,
  contradicts: STALE_A,
  severity: null,
  message: "#1237's ruling bills past 50 seats; a criterion still refuses the 51st.",
  ...over,
});

const report = (findings) => "```json\n" + JSON.stringify({ findings }) + "\n```";
const BOTH = report([
  { kind: "inconsistent_ticket", tasks: ["1237"], evidence: RULING, contradicts: STALE_A, message: "the ruling bills past 50; this criterion refuses the 51st seat" },
  { kind: "inconsistent_ticket", tasks: ["1237"], evidence: RULING, contradicts: STALE_B, message: "the ruling refuses nothing; this criterion fails closed" },
]);

// ---------------------------------------------------------------------------
// The question is asked
// ---------------------------------------------------------------------------

test("the plan review asks the fifth question, and the contract carries `contradicts`", () => {
  const text = planReviewPrompt({ epic: { id: "1", body: "" }, dag: DAG, metrics: { rows: [] } });
  assert.match(text, /Answer exactly five questions/);
  assert.match(text, /5\. `inconsistent_ticket` — does any one child issue contradict itself\?/);
  assert.match(text, /"contradicts":/);
  assert.match(text, /"kind": "missing_dependency" \| "scope_overlap" \| "unsatisfied_criterion" \| "needs_human" \| "inconsistent_ticket"/);
});

test("the ticket prompt asks only the fifth question, over the one issue's body", () => {
  const text = planReviewPrompt({
    epic: { id: "ticket-1237", body: "" },
    dag: { tasks: [DAG.tasks[1]] },
    metrics: { rows: [] },
    template: "ticket-reviewer",
  });
  assert.match(text, /Answer exactly one question/);
  assert.match(text, /`inconsistent_ticket` — does this issue contradict itself\?/);
  assert.ok(text.includes(STALE_B), "the ticket body reaches the reviewer");
  assert.ok(!text.includes("`missing_dependency` —"), "the DAG questions are not asked");
  assert.match(text, /```json/);
});

test("extractFindings reads the second passage", () => {
  const [found] = extractFindings(report([{ kind: "inconsistent_ticket", tasks: [1237], evidence: RULING, contradicts: STALE_A, message: "m" }]));
  assert.equal(found.contradicts, STALE_A);
});

// ---------------------------------------------------------------------------
// Code verifies what it can
// ---------------------------------------------------------------------------

test("a conflict whose two passages are both in the ticket survives the audit", () => {
  const { kept, dropped } = auditFindings({ findings: [inconsistent()], dag: DAG });
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 1);
});

test("a passage the ticket does not contain is a paraphrase, and the finding is dropped naming it", () => {
  const { kept, dropped } = auditFindings({
    findings: [inconsistent({ contradicts: "The 51st seat must be refused outright." })],
    dag: DAG,
  });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /the quoted `contradicts` does not appear in #1237's body/);
  const both = auditFindings({ findings: [inconsistent({ evidence: "", contradicts: "" })], dag: DAG });
  assert.match(both.dropped[0].reason, /`evidence` and `contradicts` do not appear/);
});

test("a passage quoted from a different ticket does not count", () => {
  const { dropped } = auditFindings({ findings: [inconsistent({ tasks: ["1236"] })], dag: DAG });
  assert.match(dropped[0].reason, /not appear in #1236's body/);
});

test("an inconsistent_ticket finding names exactly one task", () => {
  const { dropped } = auditFindings({ findings: [inconsistent({ tasks: ["1237", "1236"] })], dag: DAG });
  assert.match(dropped[0].reason, /exactly one task, not 2/);
});

test("the same passage quoted twice cannot disagree with itself", () => {
  const { dropped } = auditFindings({ findings: [inconsistent({ contradicts: STALE_A, evidence: STALE_A })], dag: DAG });
  assert.match(dropped[0].reason, /same text/);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("an inconsistent ticket refuses while its task has not started", () => {
  assert.equal(severityOf(inconsistent()), "contradiction");
  assert.equal(verdictOf([inconsistent()]).abort, true);
});

test("the reviewer may downgrade it to a warning, as on missing_dependency", () => {
  assert.equal(severityOf(inconsistent({ severity: "warning" })), "warning");
});

test("once its task has started it warns: the lane already read the ticket", () => {
  assert.equal(severityOf(inconsistent(), new Set(["1237"])), "warning");
});

test("one edited ruling against two stale criteria is two findings, not one", () => {
  assert.notEqual(findingKey(inconsistent()), findingKey(inconsistent({ contradicts: STALE_B })));
});

test("a stored inconsistent_ticket is not carried: only a fresh review raising it again refuses", () => {
  // A store written before this rule, holding one, must not refuse either.
  const stored = [{ ...inconsistent(), raisedAt: "2026-10-13T22:00:00.000Z" }];
  assert.equal(carriedFindings({ stored, dag: DAG }).length, 0);
});

test("a refusal raised by this review is still not written to the carry-forward store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-review-store-"));
  try {
    const storePath = join(dir, "store.json");
    const outcome = await runPlanReview({
      root: dir,
      config: {},
      epic: { id: "1230", title: "Seats", body: "" },
      dag: DAG,
      metrics: { rows: [] },
      runDir: dir,
      storePath,
      exec: fakeAgent(BOTH).exec,
    });
    assert.equal(outcome.status, "contradiction", "it still refuses the review that raised it");
    assert.equal(existsSync(storePath), false, "and nothing is remembered for the next launch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runPlanReview through its `exec` seam
// ---------------------------------------------------------------------------

const fakeAgent = (text) => {
  const calls = [];
  return {
    calls,
    exec: async (command) => {
      calls.push(command);
      const streamPath = command.match(/> '([^']*stream-\d+\.jsonl)'/)[1];
      writeFileSync(
        streamPath,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } } })}\n`,
      );
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
};

test("the #1237 fixture refuses the plan review, and the rendering quotes both passages of each pair", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-review-test-"));
  try {
    const agent = fakeAgent(BOTH);
    const outcome = await runPlanReview({ root: runDir, config: {}, epic: { id: "1230", body: "" }, dag: DAG, metrics: { rows: [] }, runDir, exec: agent.exec });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.contradictions.length, 2, "both stale criteria are reported");
    const text = renderPlanReview(outcome);
    assert.ok(text.includes(`"${RULING}"`));
    assert.ok(text.includes(`vs "${STALE_A}"`));
    assert.ok(text.includes(`vs "${STALE_B}"`));
    assert.match(text, /afk review ticket 1237/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the ticket review drops every finding of a kind it did not ask about", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "afk-review-test-"));
  try {
    const agent = fakeAgent(report([
      { kind: "needs_human", tasks: ["1237"], evidence: STALE_A, message: "someone decides" },
    ]));
    const outcome = await runPlanReview({
      root: runDir, config: {}, epic: { id: "ticket-1237", body: "" }, dag: { tasks: [DAG.tasks[1]] },
      metrics: { rows: [] }, runDir, exec: agent.exec, template: "ticket-reviewer", onlyKinds: new Set(["inconsistent_ticket"]),
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.findings, []);
    assert.match(outcome.dropped[0].reason, /asks only about inconsistent_ticket/);
    assert.ok(readFileSync(join(runDir, "prompt.md"), "utf8").includes("Answer exactly one question"), "the ticket prompt was the one sent");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The verbs, end to end through afk.mjs, with a fake gh and a fake claude
// ---------------------------------------------------------------------------

const EPIC_BODY = [
  "## Acceptance criteria",
  "- The Team plan caps seats.",
  "",
  "```yaml",
  "afk:",
  "  version: 1",
  "  branch: feat/1230-seats",
  "  tasks:",
  "    1236:",
  "      depends_on: []",
  "    1237:",
  "      depends_on: [1236]",
  "```",
].join("\n");

const issueJson = (number, title, body, children = []) => JSON.stringify({
  data: { repository: { issue: { number, title, state: "OPEN", body, subIssues: { totalCount: children.length, nodes: children } } } },
});

const cli = (reviewOutput) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-review-cli-"));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin, repo]);
  writeFileSync(join(dir, "1230.json"), issueJson(1230, "Seats", EPIC_BODY, DAG.tasks.map((task) => ({ number: Number(task.id), title: task.title, state: "OPEN", body: task.body }))));
  writeFileSync(join(dir, "1237.json"), issueJson(1237, "Seat cap", TICKET_1237));
  // The GraphQL query names the issue number; answer with that issue's file.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, "gh.log"))}`,
      'case "$*" in',
      `  *"number:1230"*) cat ${JSON.stringify(join(dir, "1230.json"))} ;;`,
      `  *"number:1237"*) cat ${JSON.stringify(join(dir, "1237.json"))} ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "review.jsonl"),
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reviewOutput }], usage: { input_tokens: 10, output_tokens: 5 } } })}\n`,
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
  writeConfig(repo, { maxParallel: 1, defaultChecks: ["true"] });
  git("add", ".");
  git("commit", "-m", "base");
  const afk = (...args) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AFK_PLAN_REVIEW_STORE: join(dir, "store") };
    delete env.PORT;
    return spawnSync(process.execPath, [fileURLToPath(new URL("../afk.mjs", import.meta.url)), "review", ...args], {
      cwd: repo, encoding: "utf8", timeout: 60_000, env,
    });
  };
  const untouched = () => {
    assert.equal(git("status", "--porcelain").stdout, "", "the working tree is untouched");
    assert.equal(git("branch", "--list").stdout.trim(), "* main", "no branch was created");
    assert.equal(existsSync(join(repo, ".afk")), false, "no .afk/ in the repository");
  };
  return { dir, repo, git, afk, untouched, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("`afk review ticket` exits 1 on the #1237 fixture, prints both passages, and writes nothing", () => {
  const fx = cli(BOTH);
  try {
    const result = fx.afk("ticket", "1237", "--repo=owner/atlas");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /✗ inconsistent_ticket/);
    assert.ok(result.stdout.includes(`vs "${STALE_B}"`));
    assert.match(result.stdout, /TICKET REVIEW: #1237 contradicts itself/);
    assert.ok(readFileSync(join(fx.dir, "claude.log"), "utf8").includes("--settings"), "the reviewer really ran, with its read-only profile");
    assert.equal(existsSync(join(fx.dir, "store")), false, "the ticket review keeps no carry-forward store");
    fx.untouched();
  } finally {
    fx.done();
  }
});

test("`afk review ticket` exits 0 on a ticket that agrees with itself", () => {
  const fx = cli(report([]));
  try {
    const result = fx.afk("ticket", "#1237", "--repo", "owner/atlas");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /✓ #1237 does not contradict itself/);
    fx.untouched();
  } finally {
    fx.done();
  }
});

test("`afk review plan` runs the whole plan review standalone and refuses on the inconsistent ticket", () => {
  const fx = cli(BOTH);
  try {
    const result = fx.afk("plan", "1230", "--repo=owner/atlas");
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Plan review \(semantic tier\):/);
    assert.match(result.stdout, /✗ inconsistent_ticket \[#1237\]/);
    assert.ok(readFileSync(join(fx.dir, "claude.log"), "utf8").length > 0);
    // A model-only claim refuses only when a fresh review raises it again: one
    // sample must not refuse every later launch, so nothing is stored for it.
    assert.equal(existsSync(join(fx.dir, "store", "owner-atlas", "1230.json")), false, "an inconsistent_ticket refusal is not carried to the next launch");
    fx.untouched();
  } finally {
    fx.done();
  }
});

// The normal multi-epic night: the epic's branch was cut, then another epic
// merged into main. Base is no longer an ancestor of the branch, which refuses a
// launch (branch_divergent) but must not stop a mid-run plan review.
const mainMovedOn = (fx) => {
  fx.git("branch", "trunk");
  fx.git("branch", "feat/1230-seats");
  writeFileSync(join(fx.repo, "other.txt"), "another epic merged\n");
  fx.git("add", "other.txt");
  fx.git("commit", "-m", "another epic merged");
};

test("`afk review plan` warns, not refuses, when main has moved past the epic's branch", () => {
  const fx = cli(report([]));
  try {
    mainMovedOn(fx);
    const result = fx.afk("plan", "1230", "--repo=owner/atlas");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /warning: branch_divergent/);
    assert.match(result.stdout, /✓ no contradiction/, "the plan review ran");
  } finally {
    fx.done();
  }
});

test("`afk review plan --base=` names the base the branch is checked against", () => {
  const fx = cli(report([]));
  try {
    mainMovedOn(fx);
    const result = fx.afk("plan", "1230", "--repo=owner/atlas", "--base=trunk");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /branch_divergent/);
    assert.match(result.stdout, /✓ no contradiction/);
  } finally {
    fx.done();
  }
});

test("`afk review plan` defaults to the epic's recorded base when the run state has one", () => {
  const fx = cli(report([]));
  try {
    mainMovedOn(fx);
    spawnSync("mkdir", ["-p", join(fx.repo, ".afk")]);
    writeFileSync(join(fx.repo, ".afk", "state.json"), JSON.stringify({ epic: { id: "1230" }, epicBase: "trunk", tasks: {} }));
    const result = fx.afk("plan", "1230", "--repo=owner/atlas");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /branch_divergent/);
  } finally {
    fx.done();
  }
});

test("`afk review plan` exits 0 on a clean review", () => {
  const fx = cli(report([]));
  try {
    const result = fx.afk("plan", "1230", "--repo=owner/atlas");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /✓ no contradiction/);
    fx.untouched();
  } finally {
    fx.done();
  }
});

test("`afk review` with no verb prints its usage and exits 1, starting no agent", () => {
  const fx = cli(report([]));
  try {
    const result = fx.afk("1237");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /afk review ticket <issue>/);
    assert.equal(existsSync(join(fx.dir, "claude.log")), false);
  } finally {
    fx.done();
  }
});
