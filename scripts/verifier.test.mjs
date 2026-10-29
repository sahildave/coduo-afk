// scripts/verifier.test.mjs — the epic's closeout review.
//
// **No test in this file reaches a model or the network.** Three layers, all
// offline:
//
//   1. the pure functions (extraction, parsing, counting, decision, rendering)
//      take strings and return values, and touch no process at all;
//   2. `runVerifier` takes its agent spawn as an injected `runAgent`, so every
//      test here supplies its own and the real `claude` is never built into a
//      command line, let alone executed;
//   3. one end-to-end test puts a fake `claude` shell script on PATH ahead of
//      anything real, in a throwaway directory, following the fixture pattern in
//      scripts/pr.test.mjs and scripts/epic.test.mjs.
//
// The property most worth holding is the authority split: the verifier produces
// a report and cannot mark the epic complete. "the schema has no field for a
// verdict" and "the decision is the runner's arithmetic" below are what hold it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkRules, preflightSettings, roleFor, rolePrompt } from "./roles.mjs";
import { buildAgentCommand } from "./lib.mjs";
import { renderCloseoutReview } from "./finish.mjs";
import {
  VERIFIER_REPORT_VERSION,
  verifierScratchReportPath,
  collectReach,
  criteriaLinesIn,
  detectSkippedGates,
  extractAcceptanceCriteria,
  lastJsonBlock,
  markStaleEvidence,
  normalizeReport,
  parseVerifierOutput,
  readVerifierReport,
  renderVerifierMarkdown,
  renderVerifierOutcome,
  runVerifier,
  spawnVerifier,
  verifierAgent,
  verifierDecision,
  verifierReportCounts,
  verifierReportPath,
  verifierSettingsArg,
  verifierSpawnPlan,
} from "./verifier.mjs";

// A child issue body in the exact shape PLANNER.md Part 4 mandates. The whole
// question "are acceptance criteria machine-extractable today" is answered by
// whether this parses, so the fixture is the real heading set, in order.
const CHILD_BODY = `## Objective
Parse the keymap file.

## Read first
- AGENTS.md

## Acceptance criteria
- \`parseKeymap("")\` returns \`[]\`
- [ ] a duplicate binding throws \`DuplicateBinding\`
1. the parser is pure

## Allowed paths
- src/keymap/**

## Prohibited
- no new dependencies
`;

const DAG = {
  epic: { id: "255", title: "Keymap" },
  branch: "feat/255-keymap",
  tasks: [
    { id: "256", title: "Parser", dependsOn: [], body: CHILD_BODY },
    { id: "257", title: "Renderer", dependsOn: ["256"], body: "## Objective\nDraw it.\n" },
  ],
};

const CRITERIA = extractAcceptanceCriteria(DAG);

// ---------------------------------------------------------------------------
// Seam 1 — acceptance criteria, extracted from the format that is actually written
// ---------------------------------------------------------------------------

test("criteria come from the child issues' `## Acceptance criteria` section", () => {
  assert.deepEqual(
    CRITERIA.map((entry) => entry.id),
    ["256.1", "256.2", "256.3"],
  );
  assert.equal(CRITERIA[0].taskId, "256");
  assert.equal(CRITERIA[0].text, '`parseKeymap("")` returns `[]`');
  // Every bullet dialect PLANNER.md's template invites: dash, task checkbox,
  // and an ordered list.
  assert.equal(CRITERIA[1].text, "a duplicate binding throws `DuplicateBinding`");
  assert.equal(CRITERIA[2].text, "the parser is pure");
});

test("the section ends at the next heading, so neighbouring sections stay out", () => {
  const texts = CRITERIA.map((entry) => entry.text);
  assert.ok(!texts.some((text) => text.includes("src/keymap")), "Allowed paths excluded");
  assert.ok(!texts.some((text) => text.includes("dependencies")), "Prohibited excluded");
  assert.ok(!texts.some((text) => text.includes("AGENTS.md")), "Read first excluded");
});

test("a task with no criteria section contributes none, and does not throw", () => {
  assert.equal(CRITERIA.filter((entry) => entry.taskId === "257").length, 0);
  assert.deepEqual(extractAcceptanceCriteria({ tasks: [{ id: "9", body: null }] }), []);
  assert.deepEqual(extractAcceptanceCriteria({}), []);
  assert.deepEqual(criteriaLinesIn(undefined), []);
});

test("a `/to-spec` epic body yields nothing — the criteria are not on the epic", () => {
  // The honest finding behind this lane's design: `coduo-epic` produces a
  // `/to-spec` PRD, whose headings are Problem Statement / Solution / User
  // Stories / Implementation Decisions / Testing Decisions / Out of Scope /
  // Further Notes, plus the `afk:` block. No acceptance-criteria section exists
  // to read, so "the epic's acceptance criteria" means its children's.
  const epicBody = [
    "## Problem Statement",
    "Keymaps are hand-rolled.",
    "## Solution",
    "- parse them",
    "## Out of Scope",
    "- rebinding UI",
  ].join("\n");
  assert.deepEqual(extractAcceptanceCriteria({ tasks: [] }, epicBody), []);
  // But an epic that does carry the heading is not ignored.
  const withCriteria = extractAcceptanceCriteria(
    { epic: { id: "255" }, tasks: [] },
    "## Acceptance criteria\n- the CLI exits 0\n",
  );
  assert.deepEqual(withCriteria, [
    { id: "epic.1", taskId: "255", source: "epic", text: "the CLI exits 0" },
  ]);
});

test("a nested subheading inside the section keeps its bullets", () => {
  const lines = criteriaLinesIn(
    "## Acceptance criteria\n- one\n### Edge cases\n- two\n## Prohibited\n- three\n",
  );
  assert.deepEqual(lines, ["one", "two"]);
});

test("a soft-wrapped criterion folds into one line instead of being cut at the break", () => {
  // Epic #388's criterion 384.2 reached the Spec axis as "…rather than an
  // allow/deny" and the fixer queued that half sentence as the item title. The
  // parser read one criterion per LINE, so the continuation was non-bullet
  // prose and was dropped, silently, on every ticket written with a soft wrap.
  const body = [
    "## Acceptance criteria",
    "",
    "- The permission payload carries an option id rather than an allow/deny",
    "  boolean, and the store's reducer maps it to the filled primary.",
    "- `npm run check:all` is green.",
  ].join("\n");
  assert.deepEqual(criteriaLinesIn(body), [
    "The permission payload carries an option id rather than an allow/deny boolean, and the store's reducer maps it to the filled primary.",
    "`npm run check:all` is green.",
  ]);
});

test("a blank line ends a continuation, so a following paragraph stays a preamble", () => {
  const body = [
    "## Acceptance criteria",
    "",
    "- one criterion that",
    "  wraps once",
    "",
    "  This paragraph is prose about the section, not part of the bullet.",
    "- two",
  ].join("\n");
  assert.deepEqual(criteriaLinesIn(body), ["one criterion that wraps once", "two"]);
});

test("a flush-left paragraph ends the fold, so nothing jumps over it", () => {
  // Without this, an indented line AFTER an intervening preamble paragraph was
  // glued onto the bullet above the paragraph — a criterion assembled from two
  // sides of prose the parser had just declared it was ignoring.
  const body = [
    "## Acceptance criteria",
    "- a criterion",
    "flush-left prose the section ignores",
    "  an indented line that belongs to that prose, not to the bullet",
  ].join("\n");
  assert.deepEqual(criteriaLinesIn(body), ["a criterion"]);
});

test("a nested bullet stays its own criterion, and a heading still closes the section", () => {
  const body = [
    "## Acceptance criteria",
    "- one",
    "  - one point five",
    "    still one point five",
    "## Allowed paths",
    "  src/a.ts continued",
  ].join("\n");
  assert.deepEqual(criteriaLinesIn(body), ["one", "one point five still one point five"]);
});

// ---------------------------------------------------------------------------
// Seam 2 — prose in, structure out
// ---------------------------------------------------------------------------

const GOOD_BLOCK = {
  summary: "Two lanes landed; the parser is solid, the renderer is not.",
  criteria: [
    { id: "256.1", verdict: "met", evidence: "src/keymap/parse.test.ts" },
    { id: "256.2", verdict: "unmet", evidence: "no DuplicateBinding anywhere" },
    { id: "256.3", verdict: "met", evidence: "parseKeymap is pure" },
  ],
  findings: [
    { axis: "standards", severity: "minor", title: "Mysterious Name `k`", file: "src/a.ts" },
    { axis: "spec", severity: "blocker", title: "Duplicate detection missing", detail: "Spec line 12." },
  ],
  mustFix: ["Implement DuplicateBinding before shipping."],
};

const agentText = (block = GOOD_BLOCK, prose = "## Standards\nAll fine.\n\n## Spec\nMostly.\n") =>
  `${prose}\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

const parsed = (overrides = {}) =>
  parseVerifierOutput({
    text: agentText(),
    raw: agentText(),
    criteria: CRITERIA,
    agentStatus: 0,
    ...overrides,
  });

test("the last fenced json block wins, so prose may quote json freely", () => {
  const text = [
    "The reviewer found this config wrong:",
    "```json",
    '{ "summary": "THIS IS QUOTED PROSE, NOT THE REPORT" }',
    "```",
    "Report:",
    "```json",
    '{ "summary": "the real one" }',
    "```",
  ].join("\n");
  assert.equal(lastJsonBlock(text).summary, "the real one");
});

test("a trailing block that is not json falls back to the one above it", () => {
  const text = "```json\n{ \"summary\": \"real\" }\n```\n\n```\nnot json at all\n```\n";
  assert.equal(lastJsonBlock(text).summary, "real");
  assert.equal(lastJsonBlock("no fences here"), null);
  assert.equal(lastJsonBlock("```json\n[1,2,3]\n```"), null, "an array is not a report");
});

test("a well-formed review parses into the schema", () => {
  const report = parsed();
  assert.equal(report.version, VERIFIER_REPORT_VERSION);
  assert.equal(report.status, "ok");
  assert.deepEqual(report.problems, []);
  assert.equal(report.criteria.length, 3);
  assert.equal(report.criteria[0].verdict, "met");
  assert.equal(report.criteria[1].verdict, "unmet");
  assert.equal(report.findings.length, 2);
  assert.equal(report.mustFix.length, 1);
  assert.match(report.prose, /## Standards/, "the prose review is kept, not discarded");
});

test("the schema has no field for a verdict, and a model-supplied one is dropped", () => {
  // The authority split, enforced at the boundary: even if the model claims the
  // epic is done, nothing downstream can read that claim.
  const report = parsed({
    text: agentText({ ...GOOD_BLOCK, passed: true, complete: true, approved: "yes" }),
  });
  assert.ok(!("passed" in report), "no `passed` survives normalisation");
  assert.ok(!("complete" in report), "no `complete` survives normalisation");
  assert.ok(!("approved" in report), "no `approved` survives normalisation");
});

test("a criterion the model did not answer is `unknown`, not dropped and not met", () => {
  const report = parsed({
    text: agentText({ ...GOOD_BLOCK, criteria: [{ id: "256.1", verdict: "met" }] }),
  });
  assert.equal(report.criteria.length, 3, "the runner's list, not the model's");
  assert.equal(report.criteria[1].verdict, "unknown");
  assert.equal(report.criteria[1].evidence, null);
});

test("a verdict for a criterion nobody asked about is discarded", () => {
  const report = parsed({
    text: agentText({
      ...GOOD_BLOCK,
      criteria: [...GOOD_BLOCK.criteria, { id: "999.1", verdict: "met", evidence: "invented" }],
    }),
  });
  assert.deepEqual(
    report.criteria.map((entry) => entry.id),
    ["256.1", "256.2", "256.3"],
  );
});

test("out-of-range enums degrade rather than crash", () => {
  const report = normalizeReport(
    {
      criteria: [{ id: "256.1", verdict: "PROBABLY" }],
      findings: [{ axis: "vibes", severity: "catastrophic", title: "" }],
      mustFix: [null, "  ", "real one"],
    },
    CRITERIA,
  );
  assert.equal(report.criteria[0].verdict, "unknown");
  assert.equal(report.findings[0].axis, "spec");
  assert.equal(report.findings[0].severity, "minor");
  assert.equal(report.findings[0].title, "(untitled finding)");
  assert.deepEqual(report.mustFix, ["real one"]);
});

// --- the four ways a review fails to arrive ---------------------------------

test("no json block at all is `unparseable`, and the prose survives", () => {
  const report = parsed({ text: "## Standards\nI read the diff and here is prose.\n" });
  assert.equal(report.status, "unparseable");
  assert.match(report.problems[0], /no fenced `json` report block/);
  assert.match(report.prose, /here is prose/);
  assert.equal(report.criteria.length, 3, "every criterion still listed, all unknown");
  assert.ok(report.criteria.every((entry) => entry.verdict === "unknown"));
});

test("a non-zero exit is `agent_failed`, and a timeout says so specifically", () => {
  assert.equal(parsed({ agentStatus: 7 }).status, "agent_failed");
  assert.match(parsed({ agentStatus: 7 }).problems[0], /exited 7/);
  assert.match(parsed({ agentStatus: 1, timedOut: true }).problems[0], /timeout/);
});

test("an expired login is `auth_failed` and names the same fix auto.mjs names", () => {
  // One auth-death policy, not two: scripts/auto.mjs halts the loop and prints
  // `claude auth login`. This module owns no loop, so it reports and stops.
  const report = parsed({
    agentStatus: 1,
    raw: '{"type":"result","error":"OAuth session expired"}',
  });
  assert.equal(report.status, "auth_failed");
  assert.match(report.problems[0], /claude auth login/);
  assert.equal(verifierDecision(report).recommendation, "inconclusive");
});

test("an empty-but-valid block is called out rather than read as clean", () => {
  const report = parsed({ text: agentText({ criteria: [], findings: [], mustFix: [] }) });
  assert.equal(report.status, "ok");
  assert.match(report.problems[0], /treat it as no review, not as a clean one/);
});

// --- gates that could not run -----------------------------------------------
//
// Four separate live runs produced the same artifact: a review whose prose says
// `gh` was denied and lint/tests could not run, whose criteria are all `met`
// anyway, and whose report.json reads `"status":"ok","problems":[]`. The prose
// caveat never reached the structured artifact, so the closeout comment posted
// to the issue described a clean review of gates that never executed.

test("a skipped gate the model declares is kept in the report", () => {
  const report = parsed({
    text: agentText({
      ...GOOD_BLOCK,
      skipped: [
        { tool: "gh", reason: "denied by the sandbox; issue bodies unread" },
        "lint",
      ],
    }),
  });
  assert.deepEqual(report.skipped, [
    { tool: "gh", reason: "denied by the sandbox; issue bodies unread" },
    { tool: "lint", reason: null },
  ]);
});

test("a `gates` list is honoured too, and gates that ran are not listed", () => {
  const report = parsed({
    text: agentText({
      ...GOOD_BLOCK,
      gates: [
        { tool: "build", ran: true },
        { tool: "tests", ran: false, reason: "node_modules is unwritable" },
      ],
    }),
  });
  assert.deepEqual(report.skipped, [
    { tool: "tests", reason: "node_modules is unwritable" },
  ]);
});

test("an undeclared skip is recovered from the prose, conservatively", () => {
  // Every report on disk today was written by an agent that was never asked for
  // the field, so the fallback is what makes those reviews readable.
  const report = parsed({
    text: agentText(
      { ...GOOD_BLOCK, criteria: [] },
      "`gh` is not available in this sandbox, so I could not read the issue bodies.\nI also could not run lint: bun install fails on a read-only tree.\n`npx ast-grep` returned 403.\n",
    ),
  });
  assert.deepEqual(
    report.skipped.map((entry) => entry.tool),
    ["gh", "lint", "ast-grep"],
  );
  assert.match(report.skipped[0].reason, /not available in this sandbox/);
});

test("prose that says the gates ran produces no skips", () => {
  const report = parsed({
    text: agentText(
      GOOD_BLOCK,
      "I ran lint, the test suite and the build; all three pass. `gh` read every child issue.\n",
    ),
  });
  assert.deepEqual(report.skipped, []);
  // And the JSON block itself is not scanned as prose: a finding that quotes the
  // word "tests" inside the report block must not invent a skip.
  assert.deepEqual(parsed().skipped, []);
});

test("a declared list turns the prose detector off, rather than doubling it", () => {
  const report = parsed({
    text: agentText(
      { ...GOOD_BLOCK, skipped: [{ tool: "gh", reason: "denied" }] },
      "I could not run lint either.\n",
    ),
  });
  assert.deepEqual(report.skipped, [{ tool: "gh", reason: "denied" }]);
});

test("a declared EMPTY `skipped` turns the prose detector off too", () => {
  // The schema asks for `"skipped": []` when every gate ran, and that is the one
  // declaration that matters: an agent saying "nothing was skipped" must not be
  // overridden by a guess at its own prose.
  const report = parsed({
    text: agentText(
      { ...GOOD_BLOCK, skipped: [] },
      "I could not run lint: the temp directory is not writable.\n",
    ),
  });
  assert.deepEqual(report.skipped, []);
});

// The detector's boundary, pinned from both sides. This repo's subject matter IS
// gates, lanes and skipping, so a review OF it is the hardest input the detector
// sees: every false positive here was produced by a real self-review, and a
// caveat that is usually wrong is worse than no caveat at all.

test("the prose detector does not fire on review prose about gates", () => {
  for (const line of [
    "The runner skipped the lint step when the tree was dirty.",
    "One test is skipped with it.skip and should be enabled.",
    "Task 3 cannot build the report without the ledger.",
  ]) {
    assert.deepEqual(detectSkippedGates(line), [], `false positive on: ${line}`);
  }
});

test("the prose detector still fires on the reviewer's own un-run gates", () => {
  for (const [line, tool] of [
    ["`gh` is not available in this sandbox, so I could not read the issue bodies", "gh"],
    ["I could not run lint: the temp directory is not writable", "lint"],
    ["`npx ast-grep` returned 403, so the structural check did not run", "ast-grep"],
    [
      "node_modules is not writable in the verifier checkout, so I could not run the test suite",
      "tests",
    ],
  ]) {
    assert.deepEqual(
      detectSkippedGates(line).map((entry) => entry.tool),
      [tool],
      `missed: ${line}`,
    );
  }
});

test("a skipped gate is visible in the verdict surface, not only in the prose", () => {
  const report = parsed({
    text: agentText(
      { summary: "All good.", criteria: [], findings: [], mustFix: [] },
      "`gh` is not available in this sandbox.\n",
    ),
    criteria: [],
  });
  const decision = verifierDecision(report);
  assert.ok(
    decision.notes.some((note) => /could not run/.test(note) && /gh/.test(note)),
    `expected a gate note, got ${JSON.stringify(decision.notes)}`,
  );
  const markdown = renderVerifierMarkdown(report);
  assert.match(markdown, /gh/);
  assert.match(markdown, /did not run/i);
  assert.match(renderVerifierOutcome(report), /gh/);
});

// ---------------------------------------------------------------------------
// Report → decision. In code, by arithmetic.
// ---------------------------------------------------------------------------

test("the decision is the runner's arithmetic over the model's observations", () => {
  const report = parsed();
  // The model claimed nothing about totals; these are recomputed here.
  assert.deepEqual(report.counts.criteria, { met: 2, partial: 0, unmet: 1, unknown: 0 });
  assert.equal(report.counts.findings.blocker, 1);
  assert.equal(report.counts.mustFix, 1);
  const decision = verifierDecision(report);
  assert.equal(decision.recommendation, "must-fix");
  assert.ok(decision.blocking.some((item) => /1 blocker finding/.test(item)));
  assert.ok(decision.blocking.some((item) => /1 must-fix item/.test(item)));
});

test("a lying total cannot move the decision", () => {
  const report = parsed({
    text: agentText({ ...GOOD_BLOCK, counts: { findings: { blocker: 0 } }, mustFix: [] }),
  });
  assert.equal(report.counts.findings.blocker, 1, "recounted from findings[]");
  assert.equal(verifierDecision(report).recommendation, "must-fix");
});

test("`verifierDecision` returns a recommendation, never a lifecycle", () => {
  const decision = verifierDecision(parsed());
  assert.deepEqual(Object.keys(decision).sort(), ["blocking", "notes", "recommendation"]);
  for (const key of ["lifecycle", "passed", "complete", "status", "closed"]) {
    assert.ok(!(key in decision), `no \`${key}\` — this function closes nothing`);
  }
  // And the whole module contains no lifecycle write.
  const source = readFileSync(
    fileURLToPath(new URL("./verifier.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /saveState|lifecycle\s*=|queueStatus/);
});

test("clean, criteria-unmet and inconclusive are each reachable", () => {
  const clean = parsed({
    text: agentText({
      summary: "All good.",
      criteria: CRITERIA.map((entry) => ({ id: entry.id, verdict: "met", evidence: "x" })),
      findings: [{ axis: "standards", severity: "minor", title: "nit" }],
      mustFix: [],
    }),
  });
  assert.equal(verifierDecision(clean).recommendation, "clean");

  const unmet = parsed({
    text: agentText({
      summary: "Half done.",
      criteria: [
        { id: "256.1", verdict: "met", evidence: "x" },
        { id: "256.2", verdict: "partial", evidence: "y" },
        { id: "256.3", verdict: "met", evidence: "z" },
      ],
      findings: [],
      mustFix: [],
    }),
  });
  assert.equal(verifierDecision(unmet).recommendation, "criteria-unmet");

  assert.equal(verifierDecision(null).recommendation, "inconclusive");
  assert.equal(
    verifierDecision(parsed({ text: "no block" })).recommendation,
    "inconclusive",
  );
});

// ---------------------------------------------------------------------------
// The Reach axis (scripts/reach.mjs carries the three failures it was built for)
// ---------------------------------------------------------------------------

const CLEAN_BLOCK = {
  summary: "Everything landed.",
  criteria: CRITERIA.map((entry) => ({ id: entry.id, verdict: "met", evidence: "x" })),
  findings: [],
  mustFix: [],
};

test("an unwired symbol is a must-fix decided in code, not by the model", () => {
  // #365: the spec said add a toggle, a toggle existed and was tested, and its
  // resolver had zero non-test callers. The model here reports a clean review
  // with an empty `mustFix` — and the runner still blocks.
  const report = parsed({
    text: agentText({
      ...CLEAN_BLOCK,
      unwired: [{ symbol: "FieldKindIcon", file: "src/features/shared/components/FieldGlyph.tsx" }],
    }),
  });
  assert.equal(report.counts.mustFix, 0, "the model asked for nothing");
  assert.equal(report.counts.unwired, 1);
  const decision = verifierDecision(report);
  assert.equal(decision.recommendation, "must-fix");
  assert.ok(decision.blocking.some((item) => /no non-test caller/.test(item)));
});

test("a seam the review did not open is a must-fix; one it read is not", () => {
  // #642: two lanes wrote one file and every gate was green. `read: false` and
  // `read: true` must not collapse into one outcome.
  const unread = parsed({
    text: agentText({
      ...CLEAN_BLOCK,
      seams: [
        { file: "src/features/filters/components/FilterBar.tsx", tasks: ["657", "661"], read: false },
      ],
    }),
  });
  assert.equal(unread.counts.seams, 1);
  assert.equal(unread.counts.seamsUnread, 1);
  assert.equal(verifierDecision(unread).recommendation, "must-fix");

  const read = parsed({
    text: agentText({
      ...CLEAN_BLOCK,
      seams: [
        {
          file: "src/features/filters/components/FilterBar.tsx",
          tasks: ["657", "661"],
          read: true,
          note: "661 re-skinned the chips 657 had just made; the merged render is coherent.",
        },
      ],
    }),
  });
  assert.equal(read.counts.seamsUnread, 0);
  assert.equal(verifierDecision(read).recommendation, "clean");
});

test("a seam that does not say it was read counts as unread", () => {
  // Fails closed on purpose: the whole of #642 is an unreviewed join reading as
  // reviewed, so anything other than an explicit `true` is "nobody opened it".
  for (const value of [undefined, null, "yes", 1]) {
    const report = parsed({
      text: agentText({ ...CLEAN_BLOCK, seams: [{ file: "a.ts", tasks: ["1", "2"], read: value }] }),
    });
    assert.equal(report.seams[0].read, false, `read: ${JSON.stringify(value)}`);
    assert.equal(verifierDecision(report).recommendation, "must-fix");
  }
});

test("a reach finding keeps its axis instead of being filed under spec", () => {
  const report = parsed({
    text: agentText({
      ...CLEAN_BLOCK,
      findings: [
        { axis: "reach", severity: "major", title: "The version guard covers 3 of 5 call sites" },
      ],
    }),
  });
  assert.equal(report.findings[0].axis, "reach");
  assert.match(renderVerifierMarkdown(report), /Reach — 1 finding\(s\)/);
});

test("the Reach lists render, and an epic with neither gets no empty section", () => {
  const report = parsed({
    text: agentText({
      ...CLEAN_BLOCK,
      seams: [{ file: "src/domain/filter.ts", tasks: ["657", "661"], read: false }],
      unwired: [{ symbol: "FieldKindIcon", file: "src/features/shared/components/FieldGlyph.tsx" }],
    }),
  });
  const markdown = renderVerifierMarkdown(report);
  assert.match(markdown, /Reach — 1 unwired, 1 lane seam\(s\)/);
  assert.match(markdown, /1 unread/);
  assert.match(markdown, /FieldKindIcon/);
  assert.match(markdown, /not opened by this review/);
  assert.doesNotMatch(renderVerifierMarkdown(parsed({ text: agentText(CLEAN_BLOCK) })), /lane seam/);
});

test("the runner's Reach evidence reaches the prompt the verifier reads", () => {
  // `render` blanks any mark the role's value set does not name, so a
  // `{{reachBlock}}` nobody supplied is erased silently — the trap
  // `VERIFIER_REPORT_PATH_MARK` exists to dodge. This is the test that the
  // wiring in roles.mjs is present at all.
  const prompt = rolePrompt(roleFor("verifier"), null, {
    epic: { id: 654 },
    branch: "feat/654",
    schema: "{}",
    criteria: [],
    tasks: [],
    reach: {
      seams: [{ file: "src/features/filters/components/FilterBar.tsx", tasks: ["657", "661"] }],
      undeclaredWrites: [{ taskId: "657", paths: ["src/components/ui/dropdown-menu.tsx"] }],
      untouchedAllowed: [{ taskId: "658", paths: ["src/features/board/**"] }],
    },
  });
  assert.match(prompt, /Step 1c — The Reach axis/);
  assert.match(prompt, /src\/features\/filters\/components\/FilterBar\.tsx` — #657, #661/);
  assert.match(prompt, /#657: `src\/components\/ui\/dropdown-menu\.tsx`/);
  assert.match(prompt, /#658: `src\/features\/board\/\*\*`/);
});

test("the computed unwired list reaches the prompt as fact, and its absence as absence", () => {
  // The list is a set-diff the runner already made. Handing the model the same
  // question by grep AND the answer invites it to argue with the answer, so the
  // prompt has to say which one this is.
  const withList = rolePrompt(roleFor("verifier"), null, {
    epic: { id: 654 }, branch: "feat/654", schema: "{}", criteria: [], tasks: [],
    reach: {
      seams: [], undeclaredWrites: [], untouchedAllowed: [],
      unwired: [{ file: "src/features/shared/components/FieldGlyph.tsx", symbol: "FieldKindIcon" }],
    },
  });
  assert.match(withList, /`FieldKindIcon` — `src\/features\/shared\/components\/FieldGlyph\.tsx`/);
  // An epic that wired everything it exported: a stated zero, which is a real
  // finding and not the same sentence as the absence below.
  const empty = rolePrompt(roleFor("verifier"), null, {
    epic: { id: 654 }, branch: "feat/654", schema: "{}", criteria: [], tasks: [],
    reach: { seams: [], undeclaredWrites: [], untouchedAllowed: [], unwired: [] },
  });
  assert.match(empty, /Unwired exports: none/);
  // And a project that declares no `reachReport` gets the grep fallback named,
  // because "the runner did not look" must not render as "nothing was found".
  const absent = rolePrompt(roleFor("verifier"), null, {
    epic: { id: 654 }, branch: "feat/654", schema: "{}", criteria: [], tasks: [],
    reach: { seams: [], undeclaredWrites: [], untouchedAllowed: [], unwired: null },
  });
  assert.match(absent, /Unwired exports: not computed/);
});

test("no Reach evidence says so rather than rendering an empty section", () => {
  // "nobody computed the seams" and "there are no seams" are different facts,
  // and a blank section is read as the second.
  const prompt = rolePrompt(roleFor("verifier"), null, {
    epic: { id: 654 },
    branch: "feat/654",
    schema: "{}",
    criteria: [],
    tasks: [],
  });
  assert.match(prompt, /the runner computed none for this epic/);
  assert.doesNotMatch(prompt, /\{\{reachBlock\}\}/);
});

test("`unknown` criteria surface as a note, not as a silent pass", () => {
  const report = parsed({
    text: agentText({
      summary: "Could not check much.",
      criteria: [{ id: "256.1", verdict: "met", evidence: "x" }],
      findings: [],
      mustFix: [],
    }),
  });
  const decision = verifierDecision(report);
  assert.equal(decision.recommendation, "clean");
  assert.ok(
    decision.notes.some((note) => /could not be checked — unknown is not met/.test(note)),
    "clean never means 'close the epic'; the unchecked count is stated",
  );
});

test("a diff-only review says so instead of reporting a full pass", () => {
  const report = parseVerifierOutput({
    text: agentText({ summary: "Diff looks fine.", criteria: [], findings: [], mustFix: [] }),
    criteria: [],
    agentStatus: 0,
  });
  assert.ok(
    verifierDecision(report).notes.some((note) => /no acceptance criteria were extractable/.test(note)),
  );
});

// ---------------------------------------------------------------------------
// Report → markdown. Templating, deterministic, token-free.
// ---------------------------------------------------------------------------

test("the rendering is deterministic and states that it is advisory", () => {
  const report = parsed({ meta: { ranAt: "2026-08-18T09:00:00.000Z" } });
  const markdown = renderVerifierMarkdown(report);
  assert.equal(markdown, renderVerifierMarkdown(report), "byte-identical on rerun");
  assert.match(markdown, /\*\*Recommendation: `must-fix`\*\* — advisory/);
  assert.match(markdown, /a human does\./);
  assert.match(markdown, /<b>Acceptance criteria — 2\/3 met<\/b>/);
  assert.match(markdown, /### Must fix before this ships/);
  assert.match(markdown, /- \[ \] Implement DuplicateBinding/);
  assert.match(markdown, /<b>Standards — 1 finding\(s\)<\/b>/);
  assert.match(markdown, /<b>Spec — 1 finding\(s\)<\/b>/);
  assert.match(markdown, /❌ \| a duplicate binding throws/);
});

// The collapsed state has to answer the question on its own, or collapsing has
// just hidden the review. Every `<summary>` carries its own counts, and the two
// things a human opens a closeout FOR — an unmet criterion and a blocker — are
// rendered `<details open>` so they need no click.
test("a collapsed section still says what it contains", () => {
  const markdown = renderVerifierMarkdown(parsed());
  assert.match(markdown, /<summary><b>Acceptance criteria — 2\/3 met<\/b> &nbsp; ✅ 2 met · ❌ 1 unmet/);
  assert.match(markdown, /<summary><b>Standards — 1 finding\(s\)<\/b> &nbsp; ⚪ 1 minor<\/summary>/);
  // GitHub renders nothing inside <details> without the blank line after
  // </summary>; losing it shows the reader raw HTML.
  for (const block of markdown.split("<details").slice(1))
    assert.match(block, /<\/summary>\n\n/, "every details block needs a blank line after its summary");
});

// The `<details>` that owns a given summary line, so the assertion is about
// that block's own `open` and not whichever one happened to be nearby.
const blockFor = (markdown, needle) => {
  const at = markdown.indexOf(needle);
  assert.notEqual(at, -1, `no section named ${needle}`);
  return markdown.slice(markdown.lastIndexOf("<details", at), at);
};

// Folding is only a win if it folds the LONG documents, and the long ones are
// exactly the ones with unmet criteria and blockers. An earlier cut opened any
// section containing either, which on Lumina #203 (36 criteria, 13 not met)
// opened everything and rendered 140 visible lines against the old 115 — worse
// than not folding at all. So everything folds, and the summary carries what
// the open table was for: which criteria to chase, and the blocker titles.
test("every section folds, including the ones with unmet criteria", () => {
  const markdown = renderVerifierMarkdown(parsed());
  assert.match(blockFor(markdown, "Acceptance criteria — 2/3"), /^<details>/);
  assert.doesNotMatch(markdown, /<details open>/);
});

test("the collapsed summary names what to chase, so folding hides nothing actionable", () => {
  const markdown = renderVerifierMarkdown(parsed());
  const criteria = markdown.split("\n").find((line) => line.includes("Acceptance criteria — 2/3"));
  assert.match(criteria, /<b>chase:<\/b> 256\.2/, "the unmet criterion's id is on the summary line");
  // The fixture's blocker is on the Spec axis; Standards carries the minor.
  const spec = markdown.split("\n").find((line) => line.includes("Spec — 1 finding"));
  assert.match(spec, /<b>blocker:<\/b> Duplicate detection missing/, "the blocker's title is on the summary line");
  const standards = markdown.split("\n").find((line) => line.includes("Standards — 1 finding"));
  assert.doesNotMatch(standards, /blocker:/, "an axis with no blocker names none");
});

test("a clean review names nothing to chase", () => {
  const clean = parseVerifierOutput({
    text: agentText({ criteria: [{ id: "1.1", verdict: "met", evidence: "ok" }], findings: [] }),
    criteria: [{ id: "1.1", taskId: "1", source: "task", text: "it works" }],
    agentStatus: 0,
  });
  const markdown = renderVerifierMarkdown(clean);
  assert.match(blockFor(markdown, "Acceptance criteria — 1/1"), /^<details>/);
  assert.doesNotMatch(markdown, /chase:/);
});

test("an unparseable review renders the raw prose rather than losing it", () => {
  const markdown = renderVerifierMarkdown(parsed({ text: "prose only, no block" }));
  assert.match(markdown, /Raw review output/);
  assert.match(markdown, /prose only, no block/);
  assert.match(markdown, /⚠️ the verifier produced no fenced/);
});

test("a pipe in a criterion cannot break the markdown table", () => {
  const report = parseVerifierOutput({
    text: agentText({ criteria: [{ id: "1.1", verdict: "met", evidence: "a|b" }] }),
    criteria: [{ id: "1.1", taskId: "1", source: "task", text: "x | y" }],
    agentStatus: 0,
  });
  assert.match(renderVerifierMarkdown(report), /\| x \\\| y \| #1 \| a\\\|b \|/);
});

test("the one-line outcome says plainly that it marks nothing complete", () => {
  const outcome = renderVerifierOutcome(parsed());
  assert.match(outcome, /VERIFY: ok — recommendation `must-fix`\./);
  assert.match(outcome, /2\/3 criteria met, 2 findings \(1 blocker\), 1 must-fix/);
  assert.match(outcome, /does not mark the epic complete/);
});

// --- a review that predates the branch's current HEAD -----------------------
//
// `afk finish` prints whatever report is on disk. On epic #391 that report was
// eight commits old and the operator quoted a blocker deleted hours earlier.
// The report always knew which commit it read; nothing compared it to the one
// the branch is on now.

const reviewedAt = (head) =>
  parsed({ head, meta: { epic: { id: 391, title: "Closeout" }, ranAt: "2026-08-24T09:15:00.000Z" } });

test("a review recorded against an older head renders a staleness line", () => {
  const outcome = renderVerifierOutcome(reviewedAt("aaaaaaa1"), "bbbbbbb2");
  const line = outcome.split("\n").find((entry) => /stale/i.test(entry));
  assert.ok(line, `no staleness line in:\n${outcome}`);
  assert.match(line, /aaaaaaa1/);
  assert.match(line, /2026-08-24T09:15:00\.000Z/);
  assert.match(line, /bbbbbbb2/);
  assert.match(line, /afk verify 391/);
});

test("a review recorded against the current head renders no staleness line", () => {
  const outcome = renderVerifierOutcome(reviewedAt("aaaaaaa1"), "aaaaaaa1");
  assert.doesNotMatch(outcome, /stale/i);
});

test("the finish closeout print carries the staleness line for an older review", () => {
  const printed = renderCloseoutReview(reviewedAt("aaaaaaa1"), 391, "bbbbbbb2");
  assert.match(printed, /VERIFY: stale review/);
  assert.match(printed, /afk verify 391/);
  assert.doesNotMatch(
    renderCloseoutReview(reviewedAt("aaaaaaa1"), 391, "aaaaaaa1"),
    /stale/i,
  );
});

test("rendering survives a report with nothing in it", () => {
  assert.match(renderVerifierMarkdown(null), /No verifier report/);
  const empty = parseVerifierOutput({ text: "", criteria: [], agentStatus: 0 });
  assert.match(renderVerifierMarkdown(empty), /None extractable/);
});

// ---------------------------------------------------------------------------
// Read-only, as rendered into the invocation
// ---------------------------------------------------------------------------

test("the verifier's sandbox grants no write to the repository it judges", () => {
  const role = roleFor("verifier");
  const settings = preflightSettings(role, "/some/project");
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ]);
  assert.ok(
    !settings.sandbox.filesystem.allowWrite.includes("/some/project"),
    "the role carries no <cwd> token, so no cwd can be substituted in",
  );
  assert.equal(settings.sandbox.enabled, true);
});

test("the editing tools and the ref-moving verbs are denied", () => {
  const deny = preflightSettings(roleFor("verifier"), null).permissions.deny;
  for (const rule of ["Edit", "Write", "NotebookEdit"]) assert.ok(deny.includes(rule), rule);
  for (const rule of [
    "Bash(git commit:*)",
    "Bash(git push:*)",
    "Bash(git merge:*)",
    "Bash(gh issue:*)",
    "Bash(gh pr:*)",
  ]) {
    assert.ok(deny.includes(rule), rule);
  }
  assert.ok(deny.includes("Read(~/.ssh/**)"), "credential denies still apply");
});

test("Skill(herdr) is denied, as the non-supervisor roles table requires", () => {
  const deny = preflightSettings(roleFor("verifier"), null).permissions.deny;
  assert.ok(deny.includes("Skill(herdr)"), "bare invocation");
  assert.ok(deny.includes("Skill(herdr *)"), "invocation with arguments");
});

test("the profile travels with the invocation, not with a file on disk", () => {
  const role = roleFor("verifier");
  const settings = JSON.parse(verifierSettingsArg(role));
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(settings.permissions.deny.includes("Write"));
  assert.ok(settings.permissions.deny.includes("Skill(herdr)"));
});

test("declared gates run outside the sandbox and are allowed, nothing else changes", () => {
  const role = roleFor("verifier");
  const config = { roles: { verifier: { gates: ["xcodebuild", "xcrun simctl "] } } };
  const settings = preflightSettings(role, null, config);
  assert.deepEqual(settings.permissions.allow, ["Bash(xcodebuild:*)", "Bash(xcrun simctl:*)"]);
  assert.deepEqual(settings.sandbox.excludedCommands, [
    "xcodebuild", "xcodebuild *", "xcrun simctl", "xcrun simctl *",
  ]);
  // The cap is untouched: the same deny list, the same writable paths.
  assert.deepEqual(settings.permissions.deny, preflightSettings(role, null).permissions.deny);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/tmp", "/private/tmp", "/var/tmp"]);
  // And it reaches the invocation, which is the only place a read-only role's
  // profile travels.
  const agent = verifierAgent(role, { ...config, agent: { model: "claude-opus-5" } });
  const carried = JSON.parse(agent.settings);
  assert.deepEqual(carried.permissions.allow, settings.permissions.allow);
  assert.deepEqual(carried.sandbox.excludedCommands, settings.sandbox.excludedCommands);
});

test("a project that declares no gates renders no allow rule and no excluded command", () => {
  const settings = preflightSettings(roleFor("verifier"), null, { defaultChecks: ["npm test"] });
  assert.equal("allow" in settings.permissions, false);
  assert.equal("excludedCommands" in settings.sandbox, false);
});

test("a malformed gates list is refused naming the field", () => {
  for (const gates of ["xcodebuild", [""], [{ cmd: "x" }], [1]]) {
    assert.throws(
      () => preflightSettings(roleFor("verifier"), null, { roles: { verifier: { gates } } }),
      /roles\.verifier\.gates must be a list of command prefixes/,
    );
  }
});

test("the command line carries the profile and never --dangerously-skip-permissions", () => {
  const role = roleFor("verifier");
  const agent = verifierAgent(role, { agent: { model: "claude-opus-5" } });
  assert.equal(agent.bypassPermissions, false);
  const command = buildAgentCommand(agent, {
    nodeBin: "/n",
    promptPath: "/p",
    streamPath: "/s",
    taskId: "verify-255",
    processName: role.processName("255"),
  });
  assert.doesNotMatch(command, /--dangerously-skip-permissions/);
  assert.match(command, /--permission-mode 'default'/);
  assert.match(command, /--settings '/);
  assert.match(command, /agent-verify-255/);
});

test("adding this role did not disturb the two that existed before it", () => {
  for (const name of ["implementer", "integrator"]) {
    const role = roleFor(name);
    assert.equal(role.permissions.bypassPermissions, undefined, `${name} unchanged`);
    assert.deepEqual(role.permissions.denySkills, ["herdr"]);
  }
  assert.deepEqual(preflightSettings(roleFor("integrator"), "/x").sandbox, undefined);
  assert.deepEqual(
    preflightSettings(roleFor("implementer"), "/x").sandbox.filesystem.allowWrite,
    ["/x", "/tmp", "/private/tmp", "/var/tmp"],
  );
});

// ---------------------------------------------------------------------------
// Seam 3 — running it, through the injected spawn
// ---------------------------------------------------------------------------

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-verify-"));
  return dir;
};

const fakeAgent = (write) => async ({ streamPath, ...rest }) => {
  writeFileSync(streamPath, write(rest));
  return { status: 0, timedOut: false };
};

// One `result` line is all `finalText` needs; the real stream is far larger, and
// reproducing it here would test agent-stats.mjs rather than this module.
const streamWith = (text) => `${JSON.stringify({ type: "result", result: text })}\n`;

test("runVerifier writes prompt, transcript, report and markdown under .afk", async () => {
  const root = workspace();
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    branch: "feat/255-keymap",
    baseBranch: "main",
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  assert.equal(report.status, "ok");
  const dir = resolve(root, ".afk", "verifier", "255");
  for (const name of ["prompt.md", "stream.jsonl", "review.md", "report.json", "report.md"]) {
    assert.ok(existsSync(join(dir, name)), `${name} written`);
  }
  const onDisk = JSON.parse(readFileSync(verifierReportPath(root, "255"), "utf8"));
  assert.equal(onDisk.counts.criteria.met, 2);
  assert.match(readFileSync(join(dir, "report.md"), "utf8"), /Recommendation/);
  rmSync(root, { recursive: true, force: true });
});

test("a review answered on another model records the switch on its report", async () => {
  // The wiring, not the pure reading (scripts/model-check.test.mjs has that):
  // a verifier whose session starts on one model and answers on another.
  const root = workspace();
  const turn = (model) => JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "x" }] }, parent_tool_use_id: null });
  const report = await runVerifier({
    root,
    config: { roles: { verifier: { model: "claude-opus-5-5" } } },
    dag: DAG,
    runAgent: fakeAgent(() => [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
      turn("claude-opus-5-5"),
      turn("claude-opus-4-6"),
      streamWith(agentText()).trim(),
    ].join("\n") + "\n"),
  });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.modelCheck, {
    started: "claude-opus-5-5",
    observed: { "claude-opus-5-5": 1, "claude-opus-4-6": 1 },
    status: "switched",
  });
  assert.equal(readVerifierReport(root, "255").modelCheck.status, "switched", "and it is on the report on disk");
  rmSync(root, { recursive: true, force: true });
});

test("the report survives a restart, and --reuse costs no second review", async () => {
  const root = workspace();
  let spawned = 0;
  const runAgent = fakeAgent(() => {
    spawned += 1;
    return streamWith(agentText());
  });
  await runVerifier({ root, config: {}, dag: DAG, runAgent });
  assert.equal(spawned, 1);
  // A fresh process would read it exactly this way — nothing is held in memory.
  assert.equal(readVerifierReport(root, "255").status, "ok");
  const reused = await runVerifier({ root, config: {}, dag: DAG, reuse: true, runAgent });
  assert.equal(spawned, 1, "no agent was started the second time");
  assert.equal(reused.status, "ok");
  // Says so, so the caller does not re-announce what that earlier session recorded.
  assert.equal(reused.reused, true);
  assert.equal(readVerifierReport(root, "255").reused, undefined, "the flag is never written to disk");
  // Without --reuse it re-reviews, so the unit stays independently re-runnable.
  await runVerifier({ root, config: {}, dag: DAG, runAgent });
  assert.equal(spawned, 2);
  rmSync(root, { recursive: true, force: true });
});

test("the prompt carries the extracted criteria and the read-only rules", async () => {
  const root = workspace();
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    branch: "feat/255-keymap",
    baseBranch: "main",
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  const prompt = readFileSync(resolve(root, ".afk", "verifier", "255", "prompt.md"), "utf8");
  assert.match(prompt, /You are READ-ONLY/);
  assert.match(prompt, /\[256\.1\] \(task #256\)/);
  assert.match(prompt, /\/code-review/);
  assert.match(prompt, /fixed point `main`/);
  assert.match(prompt, /LAST thing in your final message/);
  assert.match(prompt, /you do not decide whether this epic is done/);
  rmSync(root, { recursive: true, force: true });
});

test("the prompt carries the issue text itself, so gh is not a gate", async () => {
  const root = workspace();
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    epicBody: "## Goal\nOne keymap parser.\n",
    branch: "feat/255-keymap",
    baseBranch: "main",
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  const prompt = readFileSync(resolve(root, ".afk", "verifier", "255", "prompt.md"), "utf8");
  // The epic body and every child body, verbatim — the sections the criteria
  // extractor does not lift (Objective, Read first) are what the Spec axis of
  // /code-review reads, and what it used to reach for gh to fetch.
  assert.match(prompt, /### Epic #255\n\n## Goal\nOne keymap parser\./);
  assert.match(prompt, /### Task #256 Parser\n\n## Objective\nParse the keymap file\./);
  assert.match(prompt, /### Task #257 Renderer\n\n## Objective\nDraw it\./);
  assert.match(prompt, /`gh` is denied to you and is not a gate/);
  assert.doesNotMatch(prompt, /"tool": "gh\|/, "the skipped schema no longer offers gh as a gate name");
  rmSync(root, { recursive: true, force: true });
});

test("the prompt names the project's declared checks, and says nothing when there are none", async () => {
  const root = workspace();
  const run = (config) => runVerifier({
    root, config, dag: DAG, branch: "feat/255-keymap", baseBranch: "main",
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  const promptPath = resolve(root, ".afk", "verifier", "255", "prompt.md");
  await run({ defaultChecks: ["swift build", "swift test"] });
  let prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Step 1b — Run the project's declared checks[^]*- `swift build`\n- `swift test`/);
  assert.match(prompt, /goes in `skipped` with the reason/);
  rmSync(resolve(root, ".afk", "verifier"), { recursive: true, force: true });
  await run({});
  prompt = readFileSync(promptPath, "utf8");
  assert.doesNotMatch(prompt, /Step 1b/);
  assert.doesNotMatch(prompt, /\{\{#?\/?checks\}\}/, "the section marks do not leak");
  rmSync(root, { recursive: true, force: true });
});

test("an epic with no extractable criteria tells the agent so, not nothing", async () => {
  const root = workspace();
  await runVerifier({
    root,
    config: {},
    dag: { epic: { id: "300" }, tasks: [{ id: "301", title: "x", body: "## Objective\ny" }] },
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  const prompt = readFileSync(resolve(root, ".afk", "verifier", "300", "prompt.md"), "utf8");
  assert.match(prompt, /none were extractable/);
  assert.match(prompt, /do not invent criteria/);
  rmSync(root, { recursive: true, force: true });
});

test("a throwing spawn is contained: a report, never an exception", async () => {
  const root = workspace();
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    runAgent: async () => {
      throw new Error("spawnSync claude ENOENT");
    },
  });
  assert.equal(report.status, "agent_failed");
  assert.equal(verifierDecision(report).recommendation, "inconclusive");
  assert.ok(existsSync(verifierReportPath(root, "255")), "the failure is still recorded");
  rmSync(root, { recursive: true, force: true });
});

test("a stale transcript from a previous run cannot be read as this run's", async () => {
  const root = workspace();
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  // Second run: the agent writes nothing at all. Without the pre-run removal the
  // old transcript would be parsed as a fresh clean review.
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    runAgent: async () => ({ status: 1, timedOut: false, stderr: "died" }),
  });
  assert.equal(report.status, "agent_failed");
  assert.equal(report.counts.criteria.met, 0);
  rmSync(root, { recursive: true, force: true });
});

test("runVerifier writes nowhere but .afk/verifier/<epic>/", async () => {
  const root = workspace();
  writeFileSync(join(root, "sentinel.txt"), "untouched\n");
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  assert.equal(readFileSync(join(root, "sentinel.txt"), "utf8"), "untouched\n");
  const entries = spawnSync("ls", ["-A", root], { encoding: "utf8" }).stdout.trim().split("\n");
  assert.deepEqual(entries.sort(), [".afk", "sentinel.txt"]);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// End to end, offline: a fake `claude` on PATH ahead of anything real
// ---------------------------------------------------------------------------

test("`afk verify` runs a whole review with a fake claude and reaches no network", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-verify-e2e-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "work");
  const seen = join(dir, "claude-argv.txt");
  const seenCwd = join(dir, "claude-cwd.txt");
  spawnSync("mkdir", ["-p", bin, repo]);

  // A real repository on a real branch, because the verifier no longer runs in
  // the project: it runs in a disposable detached checkout of the branch it is
  // reviewing (scripts/worktree.mjs `roleCwd`, docs/findings.md 3.2), and a bare
  // directory would silently exercise the fallback instead of the fix.
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "src.txt"), "code\n");
  git("add", "src.txt");
  git("commit", "-m", "base");
  git("branch", "feat/255-keymap");

  // The fake agent records its own argv — which is how the read-only profile
  // reaching the real invocation is proved without a real model — and emits a
  // single `result` line carrying a schema-shaped review.
  const review = agentText({
    summary: "Reviewed offline.",
    criteria: [{ id: "256.1", verdict: "met", evidence: "src/keymap/parse.ts" }],
    findings: [{ axis: "spec", severity: "blocker", title: "Renderer missing" }],
    mustFix: ["Write the renderer."],
  });
  const canned = join(dir, "review.jsonl");
  writeFileSync(canned, streamWith(review));
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > ${JSON.stringify(seen)}`,
      `pwd > ${JSON.stringify(seenCwd)}`,
      "cat > /dev/null",
      `cat ${JSON.stringify(canned)}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  // A `gh` that answers nothing: the CLI is given --repo, and this test drives
  // runVerifier directly, so any `gh` call at all would be a bug worth failing on.
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const { runVerifier, renderVerifierOutcome, verifierDecision } = await import(${JSON.stringify(fileURLToPath(new URL("./verifier.mjs", import.meta.url)))});`,
        `const dag = ${JSON.stringify(DAG)};`,
        `const report = await runVerifier({ root: ${JSON.stringify(repo)}, config: {}, dag, branch: "feat/255-keymap", baseBranch: "main" });`,
        "console.log(renderVerifierOutcome(report));",
        "console.log('RECOMMENDATION=' + verifierDecision(report).recommendation);",
      ].join("\n"),
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AFK_WORKTREE_ROOT: join(dir, "worktrees"),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VERIFY: ok — recommendation `must-fix`\./);
  assert.match(result.stdout, /RECOMMENDATION=must-fix/);
  assert.match(result.stdout, /does not mark the epic complete/);

  // The read-only profile actually reached the process that ran.
  const argv = readFileSync(seen, "utf8").trim();
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  assert.match(argv, /--permission-mode default/);
  // The standing instruction (prompts/_unattended.md) follows the profile.
  const settings = JSON.parse(/--settings (\{.*\}) --append-system-prompt A standing instruction/.exec(argv)?.[1] ?? "{}");
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/tmp", "/private/tmp", "/var/tmp"]);
  assert.ok(settings.permissions.deny.includes("Skill(herdr)"));
  assert.ok(settings.permissions.deny.includes("Write"));

  // Where it ran is the cap that matters: not the project, and gone afterwards.
  // `allowWrite` cannot take back the default grant of the agent's own cwd, so
  // a verifier at the project root can write the branch it is gating.
  const agentCwd = readFileSync(seenCwd, "utf8").trim();
  assert.notEqual(agentCwd, realpathSync(repo));
  assert.match(agentCwd, /role-cwd-verify-255$/);
  assert.equal(existsSync(agentCwd), false, "the review copy does not outlive the review");

  // Nothing was created in the project it reviewed but `.afk/`.
  assert.deepEqual(
    spawnSync("ls", ["-A", repo], { encoding: "utf8" }).stdout.trim().split("\n").sort(),
    [".afk", ".git", "src.txt"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a report followed by post-answer chatter is still the report", async () => {
  // docs/failure-modes.md R1. `runVerifier` harvested the agent's FINAL message.
  // A review finished, then two stale wait timers re-woke the agent, and the
  // throwaway line it emitted in reply replaced the deliverable: the runner
  // recorded `inconclusive`, rendered `0 of 37 acceptance criteria met` — zero
  // findings on both axes — and posted that to the epic issue as if it were a
  // clean review. The real report, a full criteria array and five must-fix
  // items, was sitting in the transcript one file away.
  //
  // An empty report is not obviously wrong, which is what makes this worse than
  // a parsing bug: `0 of N` reads as bad news rather than as NO news. Anything
  // that can wake an agent after it answers can overwrite the answer, so the
  // fix is to stop treating the last message as the deliverable.
  const root = workspace();
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    runAgent: fakeAgent(() => [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: agentText() }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Same again — a stale wait timer draining. Review is complete; no change to the findings.",
          }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    ].join("\n") + "\n"),
  });
  assert.equal(report.status, "ok", JSON.stringify(report.problems));
  assert.equal(report.counts.criteria.met, 2);
  // And the transcript kept for a human holds the review, not just the chatter.
  assert.match(
    readFileSync(resolve(root, ".afk", "verifier", "255", "review.md"), "utf8"),
    /stale wait timer/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a review is reused only for the commit it reviewed", () => {
  // Epic #23: the epic closed three times. The first two failed and reviewed an
  // empty branch; the third built both tasks, merged them, and REUSED the first
  // review — so "the epic delivered nothing" was posted onto a pull request
  // that had delivered everything. Existence is not the test; the commit is.
  const reviewed = parseVerifierOutput({ head: "aaaa1111", text: "```json\n{}\n```" });
  assert.equal(reviewed.head, "aaaa1111");
  // And a report written before this field existed must never satisfy the
  // check: re-reviewing costs a session, trusting a stale review costs a wrong
  // verdict on the thing a human is about to merge.
  const legacy = parseVerifierOutput({ text: "```json\n{}\n```" });
  assert.equal(legacy.head, null);
});

test("a code block earlier in the prose does not swallow the report", () => {
  // Epic #23, every run: the verifier's review ended in a well-formed report
  // block and the runner said "the verifier produced no fenced `json` report
  // block" about it. The opener pattern only recognised ```json, so a ```js
  // block earlier in the prose desynchronised the pairing for the whole
  // document — its CLOSER became an opener, and the report's opener was
  // consumed as a closer.
  const review = [
    "Here is the offending code:",
    "```js",
    "const x = 1;",
    "```",
    "and here is a shell transcript:",
    "```bash",
    "$ npm test",
    "```",
    "My report:",
    "```json",
    '{"summary":"the real one","findings":[]}',
    "```",
  ].join("\n");
  const block = lastJsonBlock(review);
  assert.ok(block, "the report block must survive any number of other fences");
  assert.equal(block.summary, "the real one");
});

test("the LAST parseable object wins, and unparseable blocks are skipped", () => {
  const text = [
    "```json", '{"summary":"a draft"}', "```",
    "```yaml", "not: json", "```",
    "```json", '{"summary":"final"}', "```",
  ].join("\n");
  assert.equal(lastJsonBlock(text).summary, "final");
  // Nothing parseable at all is still null, not a throw.
  assert.equal(lastJsonBlock("```js\nconst x = 1;\n```"), null);
  assert.equal(lastJsonBlock(""), null);
});

// --- a `met` that rests on a stale runner artifact --------------------------

const staleCriteria = (evidence) => [
  { id: "169.3", taskId: "169", source: "issue", text: "check:all passes", verdict: "met", evidence },
];

test("a met resting on a runner artifact from an older commit renders unverified", () => {
  // Epic #391 marked two `check:all` criteria met on the strength of
  // `runs/169/integration-verification.json` at 2fdd0795 — a commit that
  // predated the branch tip 0517da3d. The review sandbox could run none of its
  // six gates, so this artifact WAS the evidence, and it described a different
  // tree. A tick that rests on that is not the same claim as a tick that rests
  // on a gate, and only this tells them apart.
  const marked = markStaleEvidence(
    staleCriteria("runs/169/integration-verification.json — all nine checks at code 0"),
    { head: "0517da3d", artifactCommit: () => "2fdd0795" },
  );
  assert.equal(marked[0].verdict, "met", "the reviewer's judgement is not overwritten");
  assert.match(marked[0].unverified, /2fdd0795/);
  assert.match(marked[0].unverified, /0517da3d/);
});

test("a met resting on a current artifact is left alone", () => {
  const marked = markStaleEvidence(
    staleCriteria("runs/169/integration-verification.json"),
    { head: "0517da3d", artifactCommit: () => "0517da3d" },
  );
  assert.equal(marked[0].unverified, undefined);
});

test("evidence that is not a runner artifact is never called stale", () => {
  // The overwhelmingly common case: a file, a symbol, a test name. There is no
  // commit to compare and inventing one would caveat every criterion in the
  // report — noise that would train a reader to skip the column.
  for (const evidence of ["src/services/query-keys.ts:42", "the scope test in issue-reference-cache.test.ts", null]) {
    const marked = markStaleEvidence(staleCriteria(evidence), {
      head: "0517da3d",
      artifactCommit: () => { throw new Error("must not be consulted for non-artifact evidence"); },
    });
    assert.equal(marked[0].unverified, undefined, `${evidence} is not a runner artifact`);
  }
});

test("an unreadable artifact makes no claim either way", () => {
  // The house rule everywhere else in this file: no evidence is not evidence.
  const marked = markStaleEvidence(staleCriteria("runs/169/verification.json"), {
    head: "0517da3d",
    artifactCommit: () => null,
  });
  assert.equal(marked[0].unverified, undefined);
});

test("the runner's own bookkeeping commit does not make evidence stale", () => {
  // `flushStatuses` commits docs/progress.md, runs/<id>/integration-verification.json
  // and the ledger immediately after EVERY merge, so the artifact commit is
  // essentially never the head. Comparing SHAs caveated three criteria on epic
  // #389 against a branch whose source tree had not moved at all.
  const marked = markStaleEvidence(staleCriteria("runs/19/integration-verification.json"), {
    head: "cf5b4208",
    artifactCommit: () => "38109186",
    changedPaths: () => ["docs/progress.md", "runs/19/integration-verification.json", ".afk/epic-ledger.yaml"],
  });
  assert.equal(marked[0].unverified, undefined, "no source file changed between the two commits");
});

test("a real source change between the artifact and the head is still stale", () => {
  const marked = markStaleEvidence(staleCriteria("runs/19/integration-verification.json"), {
    head: "cf5b4208",
    artifactCommit: () => "38109186",
    changedPaths: () => ["docs/progress.md", "src/services/query-keys.ts"],
  });
  assert.match(marked[0].unverified, /38109186/);
  assert.match(marked[0].unverified, /cf5b4208/);
});

test("git that cannot answer falls back to comparing the SHAs", () => {
  // An unknown commit or no repo at all. An unanswerable question is not
  // evidence of freshness, so the old, noisier behaviour is what it degrades
  // to — never a silent tick.
  for (const changedPaths of [() => null, undefined]) {
    const marked = markStaleEvidence(staleCriteria("runs/19/integration-verification.json"), {
      head: "cf5b4208",
      artifactCommit: () => "38109186",
      changedPaths,
    });
    assert.match(marked[0].unverified, /38109186/, "an unanswerable diff keeps the caveat");
  }
});

test("only a met is worth caveating; an unmet already says the worst", () => {
  const criteria = [{ id: "169.4", taskId: "169", text: "t", verdict: "unmet", evidence: "runs/169/verification.json" }];
  const marked = markStaleEvidence(criteria, { head: "aaa", artifactCommit: () => "bbb" });
  assert.equal(marked[0].unverified, undefined);
});

test("the criteria heading and the decision both count the unverified ticks", () => {
  const report = {
    status: "ok",
    summary: "s",
    criteria: [
      { id: "1.1", taskId: "1", text: "a", verdict: "met", evidence: "runs/1/verification.json", unverified: "written at aaa, this review read bbb" },
      { id: "1.2", taskId: "1", text: "b", verdict: "met", evidence: "src/x.ts" },
    ],
    findings: [], mustFix: [], problems: [], skipped: [],
  };
  const markdown = renderVerifierMarkdown(report);
  assert.match(markdown, /2\/2 met, 1 unverified/);
  assert.match(markdown, /⚠️/, "the unverified tick does not render as a plain ✅");
  assert.doesNotMatch(markdown.split("| 1.2")[0] ?? markdown, /^\| ✅.*runs\/1/m);
  const decision = verifierDecision(report);
  assert.ok(
    decision.notes.some((note) => /1 .*met.*unverified|unverified/.test(note)),
    `the decision says so too: ${JSON.stringify(decision.notes)}`,
  );
});

// ---------------------------------------------------------------------------
// The report as a FILE, with the harvested prose as the fallback
// ---------------------------------------------------------------------------
//
// docs/failure-modes.md R1 again, one layer lower. "a report followed by
// post-answer chatter is still the report" above fixed the harvest by reading
// the whole transcript instead of the final message. It did not change the fact
// that the verdict travels as prose: anything that can wake an agent after it
// answers can still overwrite the answer, and an empty report reads as clean.
//
// So the runner now hands the agent a writable scratch path and asks for the
// fenced block to be written there as well. The file is the channel; the prose
// is the fallback, because losing a review to a missing file would be worse
// than reading one out of prose. Which channel actually carried it is recorded
// in `problems`, so a fallback is visible rather than silent.

const scratchPath = (root) => join(root, "scratch-report.md");

test("an absent report file falls back to harvested text", async () => {
  // The fail-open guarantee, and the reason this test was written before the
  // prompt asked for a file at all: with nothing at the scratch path, the
  // review still has to come back.
  const root = workspace();
  const scratch = scratchPath(root);
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  assert.ok(!existsSync(scratch), "the fake agent wrote no file");
  assert.equal(report.status, "ok", JSON.stringify(report.problems));
  assert.equal(report.counts.criteria.met, 2);
  assert.ok(
    report.problems.some((problem) => /harvested/.test(problem) && problem.includes(scratch)),
    `the fallback is named: ${JSON.stringify(report.problems)}`,
  );
  rmSync(root, { recursive: true, force: true });
});

test("a written report file beats the harvested text", async () => {
  const root = workspace();
  const scratch = scratchPath(root);
  const fileBlock = {
    ...GOOD_BLOCK,
    summary: "from the file",
    findings: [{ axis: "spec", severity: "blocker", title: "only the file knows this" }],
  };
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: fakeAgent(({ }) => {
      // The agent writes the file, then a stale timer overwrites its final
      // message with something else entirely. The file wins.
      writeFileSync(scratch, agentText(fileBlock, "written by the agent\n"));
      return streamWith(agentText({ ...GOOD_BLOCK, summary: "from the chatter", findings: [] }));
    }),
  });
  assert.equal(report.status, "ok", JSON.stringify(report.problems));
  assert.equal(report.summary, "from the file");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].title, "only the file knows this");
  // And the prose the human reads is still the transcript, not the file.
  assert.match(report.prose, /from the chatter/);
  rmSync(root, { recursive: true, force: true });
});

test("a whole-file JSON report uses the file channel without requiring fences", async () => {
  // Live Codex smoke #45 wrote the dedicated scratch report as a plain JSON
  // object. The content was valid, but the parser only searched for fenced
  // blocks and silently fell back to the transcript.
  const root = workspace();
  const scratch = scratchPath(root);
  const fileBlock = { ...GOOD_BLOCK, summary: "raw JSON from the file" };
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: fakeAgent(() => {
      writeFileSync(scratch, `${JSON.stringify(fileBlock)}\n`);
      return streamWith(agentText({ ...GOOD_BLOCK, summary: "from the transcript" }));
    }),
  });
  assert.equal(report.status, "ok", JSON.stringify(report.problems));
  assert.equal(report.reportChannel, "file");
  assert.equal(report.summary, "raw JSON from the file");
  assert.deepEqual(report.problems, []);
  rmSync(root, { recursive: true, force: true });
});

test("only the dedicated file accepts unfenced JSON", () => {
  const raw = JSON.stringify(GOOD_BLOCK);
  const report = parseVerifierOutput({
    file: "not JSON",
    text: raw,
    raw,
    criteria: CRITERIA,
    meta: { reportPath: "/tmp/report.md" },
  });
  assert.equal(report.status, "unparseable");
  assert.equal(report.summary, "");
  assert.ok(report.problems.some((problem) => /no fenced `json` report block/.test(problem)));
});

test("invalid or empty report files fall back to the fenced transcript", async () => {
  for (const [label, contents] of [["invalid", "not JSON"], ["empty", ""]]) {
    const root = workspace();
    const scratch = scratchPath(root);
    const report = await runVerifier({
      root,
      config: {},
      dag: DAG,
      scratchReportPath: scratch,
      runAgent: fakeAgent(() => {
        writeFileSync(scratch, contents);
        return streamWith(agentText({ ...GOOD_BLOCK, summary: `${label} file fallback` }));
      }),
    });
    assert.equal(report.status, "ok", `${label}: ${JSON.stringify(report.problems)}`);
    assert.equal(report.reportChannel, "transcript", label);
    assert.equal(report.summary, `${label} file fallback`, label);
    assert.ok(report.problems.some((problem) => /harvested/.test(problem)), label);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report names the channel it came from", async () => {
  const root = workspace();
  const scratch = scratchPath(root);
  const fallback = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: fakeAgent(() => streamWith(agentText())),
  });
  const fromFile = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: fakeAgent(() => {
      writeFileSync(scratch, agentText());
      return streamWith("nothing useful here");
    }),
  });
  assert.equal(fallback.reportChannel, "transcript");
  assert.equal(fromFile.reportChannel, "file");
  const named = (report) => report.problems.filter((problem) => problem.includes(scratch));
  // The fallback is a degradation and says so. The healthy path is NOT a
  // problem: `problems` renders as ⚠️ and becomes `verifierDecision`'s
  // `blocking` list on a non-ok run, so a line filed there for the channel that
  // worked warned on every clean review and blocked on every failed one.
  assert.equal(named(fallback).length, 1, JSON.stringify(fallback.problems));
  assert.equal(named(fromFile).length, 0, JSON.stringify(fromFile.problems));
  assert.deepEqual(fromFile.problems, [], "a healthy review has nothing to warn about");
  rmSync(root, { recursive: true, force: true });
});

// The scratch path is where the verdict comes from, so it must not be a fixed
// location shared by every run and every user on the host: two runs of one epic
// id — ordinary under `afk epic --worktree` — would otherwise read each other's
// report, and any local user could write one.
test("the derived scratch report path is unique per run", () => {
  const first = verifierScratchReportPath("255");
  const second = verifierScratchReportPath("255");
  assert.notEqual(first, second, "two runs of one epic id must not share a path");
  assert.ok(first.startsWith("/tmp/"), "the verifier sandbox only grants /tmp");
  assert.match(first, /report\.md$/);
  assert.match(
    first,
    new RegExp(`/afk-verifier-${process.getuid?.() ?? "user"}/`),
    "the root is per-user",
  );
});

// prompts/verifier.md tells the agent that the scratch report path is writable
// and to write it with a heredoc. Under Codex nothing enforced that: the role
// renders to `--sandbox read-only`, the heredoc fails, and the review silently
// degrades to harvesting the final prose — the outcome AGENTS.md records as
// "an empty report reads as clean". These pin the enforcement.
test("a Codex verifier can write the report path its prompt names", () => {
  const reportPath = verifierScratchReportPath("255");
  const plan = verifierSpawnPlan({
    agent: { backend: "codex", command: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium", sandbox: "read-only" },
    cwd: "/tmp/afk-verify-255",
    reportPath,
    backend: "codex",
  });
  // The disposable checkout is the cap, so writing inside it is what Claude
  // Code already grants by granting the cwd. The scratch directory is the one
  // path beyond it.
  assert.equal(plan.agent.sandbox, "workspace-write");
  assert.deepEqual(plan.addDirs, [dirname(reportPath)]);
  const command = buildAgentCommand(plan.agent, {
    nodeBin: "/n",
    promptPath: "/p",
    streamPath: "/s",
    taskId: "verify-255",
    processName: "agent-verify-255",
    cwd: "/tmp/afk-verify-255",
    addDirs: plan.addDirs,
  });
  assert.match(command, /--sandbox 'workspace-write'/);
  assert.ok(command.includes(`--add-dir '${dirname(reportPath)}'`), command);
});

test("without a disposable checkout the Codex verifier stays read-only", () => {
  // The fallback cwd is the project this role is gating (`spawnVerifier` says so
  // on stderr). A lost report is recoverable; a verifier that can edit the
  // branch it is reviewing is not.
  const plan = verifierSpawnPlan({
    agent: { backend: "codex", command: "codex", sandbox: "read-only" },
    cwd: null,
    reportPath: verifierScratchReportPath("255"),
    backend: "codex",
  });
  assert.equal(plan.agent.sandbox, "read-only");
});

test("the Claude verifier invocation is unchanged by the Codex grant", () => {
  const agent = verifierAgent(roleFor("verifier"), { agent: { model: "claude-opus-5" } });
  const plan = verifierSpawnPlan({ agent, cwd: "/tmp/afk-verify-255", reportPath: "/tmp/s/report.md", backend: "claude" });
  assert.equal(plan.agent, agent, "no sandbox key is added to a Claude agent record");
  const command = buildAgentCommand(plan.agent, {
    nodeBin: "/n",
    promptPath: "/p",
    streamPath: "/s",
    taskId: "verify-255",
    processName: "agent-verify-255",
    addDirs: plan.addDirs,
  });
  assert.doesNotMatch(command, /--add-dir/);
});

test("the transport adds no status value", () => {
  // `ok` / `unparseable` / `agent_failed` / `auth_failed` covers every failure a
  // transport can have: the file was there or it was not, and the fallback
  // behind it already has a name for every way it can come back empty. A fifth
  // value would mean every consumer's `status !== "ok"` branch is now wrong.
  const allowed = new Set(["ok", "unparseable", "agent_failed", "auth_failed"]);
  const source = readFileSync(new URL("./verifier.mjs", import.meta.url), "utf8");
  const assigned = [...source.matchAll(/\bstatus = "([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(assigned.length >= 4, "the parser still decides status by assignment");
  for (const value of assigned) assert.ok(allowed.has(value), `unexpected status ${value}`);
});

test("the prompt names the scratch path the runner will read back", async () => {
  const root = workspace();
  const scratch = scratchPath(root);
  // Through the injected seam, not by guessing the path: whatever `runVerifier`
  // hands `runAgent` is what the real agent is launched with.
  let handed = null;
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratch,
    runAgent: async (args) => {
      handed = args;
      return fakeAgent(() => streamWith(agentText()))(args);
    },
  });
  assert.ok(handed?.promptPath, "the agent is launched with a prompt file");
  const prompt = readFileSync(handed.promptPath, "utf8");
  assert.equal(
    handed.promptPath,
    resolve(root, ".afk", "verifier", "255", "prompt.md"),
    "and it is the prompt this run wrote",
  );
  assert.ok(prompt.includes(scratch), "the agent is told where to write its report");
  assert.ok(!/@@[A-Z_]+@@/.test(prompt), "no substitution mark survives into the prompt");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Network egress — opt-in by host, and the destructive deny that rides with it
// ---------------------------------------------------------------------------
//
// Granting the reviewer network access is what turns `supabase db reset` from
// "could not start a local stack" into "dropped the developer's database". The
// cwd cap is a filesystem cap; it protects nothing about a local Postgres. So
// the two land together and these tests hold them together.

test("a project that names no host gets no network key at all", () => {
  const sandbox = preflightSettings(roleFor("verifier"), "/tmp/wt", {}).sandbox;
  assert.equal(sandbox.network, undefined, "byte-identical to before this existed");
});

test("named hosts render as sandbox.network.allowedDomains", () => {
  // The key name is load-bearing and was wrong once: an earlier cut wrote
  // `network.allow`, which the runtime does not read, so the payload would
  // have been accepted in silence with every gate as denied as before.
  const config = { roles: { verifier: { network: ["eu.infisical.com", "fonts.googleapis.com"] } } };
  const sandbox = preflightSettings(roleFor("verifier"), "/tmp/wt", config).sandbox;
  assert.deepEqual(sandbox.network, { allowedDomains: ["eu.infisical.com", "fonts.googleapis.com"] });
});

test("there is no allow-everything value", () => {
  for (const bad of [true, "*", "all", 1]) {
    assert.throws(
      () => networkRules({ roles: { verifier: { network: bad } } }, "verifier", roleFor("verifier")),
      /must be a list of hosts/,
      `network: ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("the destructive commands are denied whatever the project configures", () => {
  const config = { roles: { verifier: { network: ["registry.npmjs.org"], gates: ["pnpm"] } } };
  const deny = preflightSettings(roleFor("verifier"), "/tmp/wt", config).permissions.deny;
  for (const command of ["supabase db reset", "prisma migrate reset", "docker volume rm", "xcrun simctl erase"])
    assert.ok(deny.some((rule) => rule.includes(command)), `${command} must stay denied`);
});

test("a declared gate cannot re-enable a destructive command", () => {
  // Deny outranks allow in Claude Code, so listing `supabase` as a gate grants
  // `supabase start` and still cannot grant `supabase db reset`.
  const config = { roles: { verifier: { gates: ["supabase"] } } };
  const settings = preflightSettings(roleFor("verifier"), "/tmp/wt", config).permissions;
  assert.ok(settings.allow.includes("Bash(supabase:*)"), "the gate is allowed");
  assert.ok(settings.deny.includes("Bash(supabase db reset:*)"), "and the reset is still denied");
});

test("gh reaches no default allowlist, so the reviewer cannot write to what it gates", () => {
  const hosts = networkRules({}, "verifier", roleFor("verifier"));
  assert.deepEqual(hosts, [], "the role default is empty");
  for (const host of ["api.github.com", "github.com"])
    assert.equal(hosts.includes(host), false, `${host} must not be granted by default`);
});

// ---------------------------------------------------------------------------
// The Reach axis's `unwired` list — computed, not asked of the model
// ---------------------------------------------------------------------------

test("collectReach computes unwired from the project's reachReport at both commits", () => {
  // A real repository and two real commits, because the whole mechanic is that
  // the runner can produce the base payload and the review sandbox cannot: the
  // command has to run in a checkout of the merge-base, which needs a second
  // worktree. `cat` stands in for `knip --production --reporter json` so the
  // test stays offline; what it exercises is the two checkouts, not knip.
  const dir = mkdtempSync(join(tmpdir(), "afk-reach-"));
  const repo = join(dir, "work");
  spawnSync("mkdir", ["-p", repo]);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  const base = { issues: [{ file: "src/old.ts", exports: [{ name: "alreadyDead" }] }] };
  writeFileSync(join(repo, "knip-out.json"), `${JSON.stringify(base)}\n`);
  git("add", "knip-out.json");
  git("commit", "-m", "base");
  git("checkout", "-b", "feat/654-filters");
  const head = {
    issues: [
      { file: "src/old.ts", exports: [{ name: "alreadyDead" }] },
      { file: "src/features/shared/components/FieldGlyph.tsx", exports: [{ name: "FieldKindIcon" }] },
    ],
  };
  writeFileSync(join(repo, "knip-out.json"), `${JSON.stringify(head)}\n`);
  git("commit", "-am", "task 654: add the glyph");

  const reach = collectReach({
    root: repo,
    branch: "feat/654-filters",
    baseBranch: "main",
    dag: { epic: { id: "654" }, tasks: [{ id: "654", allowedPaths: ["knip-out.json"] }] },
    config: { reachReport: "cat knip-out.json" },
  });
  // The ratchet: `alreadyDead` is unused at BOTH commits and must not appear.
  assert.deepEqual(reach.unwired, [
    { file: "src/features/shared/components/FieldGlyph.tsx", symbol: "FieldKindIcon" },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("collectReach leaves unwired null when the project declares no reachReport", () => {
  // Absence, not `[]`. An empty list renders as "this epic wired everything it
  // exported", which is a claim no project without the command has earned.
  const dir = mkdtempSync(join(tmpdir(), "afk-reach-off-"));
  const repo = join(dir, "work");
  spawnSync("mkdir", ["-p", repo]);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "src.txt"), "code\n");
  git("add", "src.txt");
  git("commit", "-m", "base");
  git("checkout", "-b", "feat/1-x");
  writeFileSync(join(repo, "src.txt"), "more\n");
  git("commit", "-am", "task 1: edit");

  const reach = collectReach({ root: repo, branch: "feat/1-x", baseBranch: "main", dag: { tasks: [] }, config: {} });
  assert.equal(reach.unwired, null);
  // A command that cannot produce a payload is the same answer, not a crash.
  const broken = collectReach({
    root: repo, branch: "feat/1-x", baseBranch: "main", dag: { tasks: [] },
    config: { reachReport: "echo 'Error: Cannot find module' >&2; exit 1" },
  });
  assert.equal(broken.unwired, null);
  rmSync(dir, { recursive: true, force: true });
});

test("a computed unwired list replaces the model's, and the runner blocks on it", () => {
  // The authority split, applied to this list. The model is asked for `unwired`
  // by grep as a fallback, and a model that answered `[]` — the easy answer, and
  // the one #365 got away with — must not be able to erase a set-diff the runner
  // computed from two knip payloads.
  const report = parseVerifierOutput({
    text: agentText({ summary: "Nothing unwired here.", unwired: [] }),
    criteria: [],
    meta: { unwired: [{ symbol: "FieldKindIcon", file: "src/features/shared/components/FieldGlyph.tsx" }] },
  });
  assert.deepEqual(report.unwired, [
    { symbol: "FieldKindIcon", file: "src/features/shared/components/FieldGlyph.tsx" },
  ]);
  assert.equal(report.counts.unwired, 1);
  assert.match(
    verifierDecision(report).blocking.join(" "),
    /1 symbol this epic added with no non-test caller/,
  );
});

// ---------------------------------------------------------------------------
// #142 — a review with no block still reaches the record
// ---------------------------------------------------------------------------
//
// Five atlas-workspace closeouts reviewed in prose, emitted no block, and the
// runner kept none of it. #865's prose held seven numbered findings; the record
// said `findingsTotal: 0` and every axis rendered `(0)` / `_No findings._`.

const PROSE_ONLY = [
  "## Criteria walk",
  "1. **MET** — `src/keymap/parse.ts:12` returns [] for empty input.",
  "2. **PARTIAL** — duplicates are only caught on the second pass.",
  "",
  "## Standards review",
  "1. **Hardcoded strings** — `src/ui/Settings.tsx:40` bypasses i18n.",
  "2. A bare `catch` turns a network failure into \"no such repo\".",
  "",
  "## Spec deviations",
  "1. **Overdue is off by one** — a task due today reads as overdue.",
  "",
  "```ts",
  "1. this numbered line is quoted code, not a finding",
  "```",
  "",
  "`StoredMarker` (`src/markers.ts`) has no non-test caller.",
].join("\n");

test("a review with no block recovers its numbered findings from prose, each marked recovered", () => {
  const report = parsed({ text: PROSE_ONLY, raw: PROSE_ONLY });
  assert.equal(report.status, "unparseable");
  assert.ok(report.findings.length > 0, "the prose findings reached the record");
  assert.deepEqual(
    report.findings.map((entry) => [entry.axis, entry.title]),
    [
      ["standards", "Hardcoded strings"],
      ["standards", "A bare `catch` turns a network failure into \"no such repo\"."],
      ["spec", "Overdue is off by one"],
    ],
    "the criteria walk and the fenced line are not findings; the axis is the nearest heading's",
  );
  for (const entry of report.findings) {
    assert.equal(entry.recovered, "prose");
    assert.equal(entry.severity, "unknown", "the prose never said how bad; the runner does not guess");
  }
  assert.equal(report.findings[0].file, "src/ui/Settings.tsx:40");
  assert.equal(report.counts.findingsTotal, 3);
});

test("a review with no block keeps the unwired export its prose names", () => {
  const report = parsed({ text: PROSE_ONLY, raw: PROSE_ONLY });
  assert.deepEqual(report.unwired, [{ symbol: "StoredMarker", file: "src/markers.ts", recovered: "prose" }]);
  // A list the runner computed still wins over anything read out of prose.
  const computed = parsed({ text: PROSE_ONLY, raw: PROSE_ONLY, meta: { unwired: [{ symbol: "Real", file: "a.ts" }] } });
  assert.deepEqual(computed.unwired, [{ symbol: "Real", file: "a.ts" }]);
});

test("an ok review is never second-guessed from its prose", () => {
  const report = parsed({ text: agentText(GOOD_BLOCK, PROSE_ONLY) });
  assert.equal(report.status, "ok");
  assert.ok(report.findings.every((entry) => !entry.recovered));
  assert.equal(report.findings.length, GOOD_BLOCK.findings.length);
});

test("an unparseable review renders its finding counts as unknown, never as zero", () => {
  const markdown = renderVerifierMarkdown(parsed({ text: "I read the diff; no numbered list here." }));
  assert.doesNotMatch(markdown, /^### \w+ \(0\)$/m);
  assert.doesNotMatch(markdown, /_No findings\._/);
  for (const axis of ["Standards", "Spec", "Reach"]) {
    assert.match(markdown, new RegExp(`### ${axis} — unknown \\(review unparseable\\)`));
  }
  const recovered = renderVerifierMarkdown(parsed({ text: PROSE_ONLY, raw: PROSE_ONLY }));
  assert.doesNotMatch(recovered, /_No findings\._/);
  assert.match(recovered, /Standards — unknown \(review unparseable\); 2 recovered from prose/);
  assert.match(recovered, /Hardcoded strings \(`src\/ui\/Settings\.tsx:40`\) _\(recovered from prose\)_/);
  assert.match(recovered, /`StoredMarker` \(`src\/markers\.ts`\) — added by this epic, no non-test caller _\(recovered from prose\)_/);
});

// A transcript that ended on a promise to look later. #878: "The waiter is
// armed. I'll pick up the test summary when it fires." #896: "Still running.
// I'll check again when it finishes." Both were harvested as the review.
const initLine = (session) => `${JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5" })}\n`;
const waiting = (session) => `${initLine(session)}${streamWith("Still running. I'll check again when it finishes.")}`;

test("a transcript ending in a wait gets exactly one nudge, resuming its session, before harvest", async () => {
  const root = workspace();
  const calls = [];
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent((args) => {
      calls.push(args);
      return calls.length === 1 ? waiting("sess-878") : streamWith(agentText());
    }),
  });
  assert.equal(calls.length, 2, "one nudge");
  assert.equal(calls[0].resume, undefined);
  assert.equal(calls[1].resume, "sess-878", "the nudge resumes the session that was waiting");
  assert.match(readFileSync(calls[1].promptPath, "utf8"), /foreground of THIS turn/);
  assert.equal(report.status, "ok", JSON.stringify(report.problems));
  assert.equal(report.counts.criteria.met, 2);
  assert.deepEqual(report.nudge, { sent: true, status: 0 });
  rmSync(root, { recursive: true, force: true });
});

test("a session that answers the nudge with another wait is harvested, not nudged twice", async () => {
  const root = workspace();
  let calls = 0;
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent(() => {
      calls += 1;
      return waiting("sess-896");
    }),
  });
  assert.equal(calls, 2);
  assert.equal(report.status, "unparseable");
  rmSync(root, { recursive: true, force: true });
});

test("a transcript that ends in its report is never nudged", async () => {
  const root = workspace();
  let calls = 0;
  await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent(() => {
      calls += 1;
      return `${initLine("sess-1")}${streamWith(agentText())}`;
    }),
  });
  assert.equal(calls, 1);
  rmSync(root, { recursive: true, force: true });
});

test("a wait with no session to resume is harvested and says so", async () => {
  const root = workspace();
  let calls = 0;
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent(() => {
      calls += 1;
      return streamWith("The waiter is armed. I'll pick up the test summary when it fires.");
    }),
  });
  assert.equal(calls, 1);
  assert.ok(report.problems.some((problem) => /could not be nudged/.test(problem)), JSON.stringify(report.problems));
  rmSync(root, { recursive: true, force: true });
});

test("the nudge's command line resumes the session; no other command line changes", () => {
  const agent = verifierAgent(roleFor("verifier"), { agent: { model: "claude-opus-5" } });
  const paths = { nodeBin: "/n", promptPath: "/p", streamPath: "/s", taskId: "verify-255", processName: "agent-verify-255" };
  assert.match(buildAgentCommand({ ...agent, resume: "sess-878" }, paths), / --resume 'sess-878' /);
  assert.doesNotMatch(buildAgentCommand(agent, paths), /--resume/);
});

// ---------------------------------------------------------------------------
// #142 review follow-up — recovery reads the final message, and reads it well
// ---------------------------------------------------------------------------

const assistantLine = (text) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
const transcriptOf = (...messages) =>
  `${initLine("sess-r")}${messages.map(assistantLine).join("")}${streamWith(messages.at(-1))}`;
const recoveredFrom = (raw, meta = {}) => {
  const text = messages(raw);
  return parseVerifierOutput({ text, raw, criteria: CRITERIA, meta });
};
// Everything the agent said, as `runVerifier` hands it to the parser.
const messages = (raw) =>
  raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((e) => e.type === "assistant").map((e) => e.message.content[0].text).join("\n\n");

test("recovery reads the final message only, so a numbered plan earlier in the session is not a finding", () => {
  const raw = transcriptOf(
    "Plan:\n1. Read the diff\n2. Run the tests\n3. Walk the criteria\n4. Write the report",
    "## Spec\n1. **Overdue is off by one** — a task due today reads as overdue.",
  );
  const report = recoveredFrom(raw);
  assert.deepEqual(report.findings.map((entry) => entry.title), ["Overdue is off by one"]);
});

test("recovered findings are deduplicated on their words", () => {
  const raw = transcriptOf("## Standards\n1. Bare `catch` hides the error.\n\n## Summary\n1. Bare `catch` hides the error!");
  assert.equal(recoveredFrom(raw).findings.length, 1);
});

test("recovery is capped, and the overflow is counted where a reader sees it", () => {
  const list = Array.from({ length: 400 }, (_, i) => `${i + 1}. distinct problem number ${i + 1}`).join("\n");
  const report = recoveredFrom(transcriptOf(`## Spec\n${list}`));
  assert.equal(report.findings.length, 25);
  assert.equal(report.recoveredOverflow, 375);
  assert.ok(report.problems.some((problem) => /375 more numbered line\(s\)/.test(problem)), JSON.stringify(report.problems));
  assert.match(renderVerifierMarkdown(report), /⚠️ .*375 more numbered line\(s\)/);
});

test("a request to the human is not a finding", () => {
  // A bailing verifier's numbered asks became fixer items.
  const raw = transcriptOf([
    "I could not finish. To continue:",
    "1. Grant Bash permission for `npm test`.",
    "2. Point me at the staging URL.",
    "3. Please confirm the criteria list is current.",
    "4. Should I re-run with network access?",
    "5. **Duplicate detection is missing** — `src/keymap/parse.ts:40`.",
  ].join("\n"));
  assert.deepEqual(recoveredFrom(raw).findings.map((entry) => entry.title), ["Duplicate detection is missing"]);
});

// /tmp/s865.mjs from the #149 review: #865's real layout. Sub-headings under
// `## Standards` stay standards, a bold pseudo-heading switches axis, and the
// spec deviations were a markdown table.
const S865 = `## Standards
### Hard violations
1. Hardcoded English strings bypass the i18n rule at \`ItemCard.tsx:126\`.
2. Bare \`catch { repositoryId = null }\` in \`create-item.ts:75-79\`.
### Real bugs
3. \`.expect()\` in \`server.rs\` panics the sidecar.

**Spec**

| # | Deviation | Where |
|---|---|---|
| 1 | Stale instructions text | \`instructions.ts\` |
| 2 | \`list_items\` field gaps | \`tools.rs\` |
- A non-end-to-end refusal test in \`refusal.test.ts\`
`;

test("sub-headings inherit their parent's axis, bold pseudo-headings count, and tables and bullets are read", () => {
  const report = recoveredFrom(transcriptOf(S865));
  assert.deepEqual(report.findings.map((entry) => [entry.axis, entry.title]), [
    ["standards", "Hardcoded English strings bypass the i18n rule at `ItemCard.tsx:126`."],
    ["standards", "Bare `catch { repositoryId = null }` in `create-item.ts:75-79`."],
    ["standards", "`.expect()` in `server.rs` panics the sidecar."],
    ["spec", "Stale instructions text"],
    ["spec", "`list_items` field gaps"],
    ["spec", "A non-end-to-end refusal test in `refusal.test.ts`"],
  ]);
  assert.equal(report.findings[3].file, "instructions.ts");
});

test("a severity the prose states is kept; one it does not state stays unknown", () => {
  const raw = transcriptOf([
    "## Spec findings",
    "1. **blocker** — the webhook signature is never checked.",
    "2. The unsaved name edit is dropped on close — major.",
    "3. Copy says Save where the design says Done (minor)",
    "4. A minor-looking rename that is really a behaviour change.",
  ].join("\n"));
  assert.deepEqual(recoveredFrom(raw).findings.map((entry) => entry.severity), ["blocker", "major", "minor", "unknown"]);
});

test("on an unparseable review the runner's own seams reach the record, unread", () => {
  const report = recoveredFrom(transcriptOf("No block, sorry."), { seams: [{ file: "src/shared.ts", tasks: ["657", "661"] }] });
  assert.deepEqual(report.seams, [{ file: "src/shared.ts", tasks: ["657", "661"], read: false, note: null }]);
  assert.match(renderVerifierMarkdown(report), /`src\/shared\.ts` — written by #657, #661 — \*\*not opened by this review\*\*/);
  // An `ok` review keeps the seams its block reported.
  const ok = parsed({ meta: { seams: [{ file: "src/shared.ts", tasks: ["657", "661"] }] } });
  assert.deepEqual(ok.seams, []);
});

test("a criteria walk is not a list of findings, with or without verdict words", () => {
  const raw = transcriptOf([
    "## Acceptance criteria",
    "1. 818.3 — fail-first proof shown in runs/818",
    "2. 819.11 — the resolver test covers Cmd+2",
    "",
    "## Spec",
    "1. 820.4 — the drawer never closes on Escape",
    "2. **The drawer never closes on Escape** — `Drawer.tsx:88`.",
  ].join("\n"));
  assert.deepEqual(recoveredFrom(raw).findings.map((entry) => entry.title), ["The drawer never closes on Escape"]);
});

// ---------------------------------------------------------------------------
// #142 review follow-up — the nudge fires on a wait, and only on a wait
// ---------------------------------------------------------------------------

const lastSays = (text) => `${initLine("sess-w")}${assistantLine(text)}${streamWith(text)}`;

test("the nudge fires on waiting-on-a-background-command phrasing, and on nothing else", async () => {
  const { endsWaiting } = await import("./verifier.mjs");
  const table = [
    // #878 and #896, verbatim.
    ["The waiter is armed. I'll pick up the test summary when it fires.", true],
    ["Still running. I'll check again when it finishes.", true],
    ["Tests are running now; I'll report back once they complete.", true],
    ["Let me wait for the build to finish before writing the report.", true],
    ["The suite is still executing (bash id 3). Will write the report after.", true],
    // Finished reviews that mention running or waiting.
    ["Report written to /tmp/x/report.json. Every gate ran in the foreground; nothing is still running.", false],
    ["Review complete. Criterion 4.2 stays unknown: it is waiting on a human sign-off.", false],
    ["Done. The e2e suite runs in the background of CI, not here; the report is in the file.", false],
    ["Review complete; the report is at the path you gave me.", false],
  ];
  for (const [text, want] of table) assert.equal(endsWaiting(lastSays(text)), want, text);
});

test("a review that already reported, by file or by transcript, is never nudged", async () => {
  for (const channel of ["file", "transcript"]) {
    const root = workspace();
    const scratch = scratchPath(root);
    let calls = 0;
    const report = await runVerifier({
      root,
      config: {},
      dag: DAG,
      scratchReportPath: scratch,
      runAgent: fakeAgent(() => {
        calls += 1;
        if (channel === "file") writeFileSync(scratch, agentText());
        // The #149 review's case: a valid report file, then a closing line
        // that the old pattern read as a wait.
        return `${initLine("sess-f")}${channel === "transcript" ? assistantLine(agentText()) : ""}${streamWith("Still running. I'll check again when it finishes.")}`;
      }),
    });
    assert.equal(calls, 1, `${channel}: a parsed report needs no nudge`);
    assert.equal(report.status, "ok", channel);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the nudge is bounded: a shorter timeout, and the first session's checkout is kept for it", async () => {
  const { VERIFIER_NUDGE_TIMEOUT_MS } = await import("./verifier.mjs");
  const root = workspace();
  const calls = [];
  await runVerifier({
    root,
    config: { agent: { timeoutMs: 3_600_000 } },
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent((args) => {
      calls.push(args);
      return calls.length === 1 ? waiting("sess-b") : streamWith(agentText());
    }),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].keepCwd, true, "the first session's checkout survives for the nudge");
  assert.ok(!calls[1].keepCwd, "the nudge removes it");
  assert.equal(calls[1].agent.timeoutMs, VERIFIER_NUDGE_TIMEOUT_MS);
  assert.ok(VERIFIER_NUDGE_TIMEOUT_MS < calls[0].agent.timeoutMs);
  rmSync(root, { recursive: true, force: true });
});

test("the nudge resumes in the checkout the first session left, without recreating it", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "afk-nudge-cwd-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  git("branch", "feat/x");
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  // Prints its working directory's listing into the stream, which is how this
  // test sees which checkout the agent ran in.
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nls -a\n");
  spawnSync("chmod", ["+x", join(bin, "claude")]);
  const previous = { PATH: process.env.PATH, AFK_WORKTREE_ROOT: process.env.AFK_WORKTREE_ROOT };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.AFK_WORKTREE_ROOT = join(dir, "worktrees");
  t.after(() => {
    process.env.PATH = previous.PATH;
    if (previous.AFK_WORKTREE_ROOT === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = previous.AFK_WORKTREE_ROOT;
  });
  const { roleCwd } = await import("./worktree.mjs");
  const agent = { command: "claude", model: "x", timeoutMs: 10_000 };
  const args = { root: repo, agent, promptPath: join(dir, "p.md"), streamPath: join(dir, "s.jsonl"), epicId: "7", branch: "feat/x" };
  writeFileSync(args.promptPath, "p");
  await spawnVerifier({ ...args, keepCwd: true });
  const cwd = roleCwd(repo, "verify-7");
  assert.ok(existsSync(cwd), "kept for the nudge");
  writeFileSync(join(cwd, "left-by-session-one"), "x");
  await spawnVerifier({ ...args, resume: "sess-7" });
  // Recreating the checkout (`createRoleCwd`) removes it first, marker and all.
  assert.match(readFileSync(args.streamPath, "utf8"), /left-by-session-one/, "the nudge ran in the same checkout");
  assert.ok(!existsSync(cwd), "the nudge cleans up after itself");
});

test("a nudge that dies keeps the first session's review, and says why", async () => {
  const firstSession = `${initLine("sess-d")}${assistantLine("## Spec\n1. **Overdue is off by one** — due today reads as overdue.")}${streamWith("Still running. I'll check again when it finishes.")}`;
  const authDeath = `${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Failed to authenticate. API Error: 401 authentication_error OAuth session expired" })}\n`;
  for (const [second, outcome, problem] of [
    [authDeath, { status: 1, timedOut: false }, /nudge .*exited 1/],
    ["", { status: 124, timedOut: true }, /nudge timed out/],
  ]) {
    const root = workspace();
    let calls = 0;
    const report = await runVerifier({
      root,
      config: {},
      dag: DAG,
      scratchReportPath: scratchPath(root),
      runAgent: async ({ streamPath }) => {
        calls += 1;
        writeFileSync(streamPath, calls === 1 ? firstSession : second);
        return calls === 1 ? { status: 0, timedOut: false } : outcome;
      },
    });
    assert.equal(calls, 2);
    assert.equal(report.status, "unparseable", "the first session's result stands, not the nudge's");
    assert.ok(report.problems.some((line) => problem.test(line)), JSON.stringify(report.problems));
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #149 second review — recovery walks back to the message that has findings
// ---------------------------------------------------------------------------

test("recovery walks back from a final message with no findings to the last one that has them", () => {
  // /tmp/ra149.mjs: findings in one message, then "Report above."
  const raw = transcriptOf(
    "## Findings\n1. **Webhook double-charges on 502** — `src/pay.ts:40`\n2. **No idempotency key stored**",
    "Report above.",
  );
  assert.deepEqual(recoveredFrom(raw).findings.map((entry) => entry.title), ["Webhook double-charges on 502", "No idempotency key stored"]);
});

test("a closing synthesis of bold-lead paragraphs is read as findings", () => {
  // The dominant real shape: numbered findings in the axis messages, then a
  // closing synthesis of `**→ Title.** detail` paragraphs.
  const raw = transcriptOf(
    "## Standards\n1. Earlier numbered finding",
    [
      "Review complete. What matters:",
      "",
      "**→ The webhook double-charges on 502.** `src/pay.ts:40` retries without an idempotency key.",
      "",
      "**Stale link status after unlink.** The badge keeps the old state.",
      "",
      "**Summary.** Two real problems; everything else is clean.",
    ].join("\n"),
  );
  assert.deepEqual(recoveredFrom(raw).findings.map((entry) => entry.title), [
    "The webhook double-charges on 502.",
    "Stale link status after unlink.",
  ]);
});

// /tmp/over149.mjs and /tmp/sev149.mjs from the second review.
test("bullets and table rows count only under a findings heading, and never a verdict row or a clean result", async () => {
  const { recoverFindingsFromProse } = await import("./verifier.mjs");
  const titles = (text) => recoverFindingsFromProse(text).map((entry) => entry.title);
  assert.deepEqual(titles("## Spec\n\n| # | Criterion | Verdict |\n|---|---|---|\n| 1 | Webhook retries on 5xx | MET |\n| 2 | Idempotency key stored | UNMET |\n"), []);
  assert.deepEqual(titles("## Standards\n\n| File | Change |\n|---|---|\n| `src/a.ts` | +40 new handler |\n"), []);
  assert.deepEqual(titles("## Spec\n\n- Webhook retries on 5xx — met, see test\n- All tests pass\n- I read AGENTS.md in full\n"), []);
  assert.deepEqual(titles("## Standards review\n\nSources read:\n- AGENTS.md\n- docs/README.md\n"), []);
  assert.deepEqual(titles("## Spec\n\nChecks I ran:\n1. npm test — 120 pass\n2. npm run lint — clean\n"), []);
  assert.deepEqual(titles("## Findings\n1. blocker — nothing\n2. **Blocker**: none found\n3. No findings on the Reach axis.\n"), []);
  assert.deepEqual(
    titles("## Findings\n\n| # | Criterion | Verdict |\n|---|---|---|\n| 1 | retries | MET |\n\n- A bullet under a findings heading\n"),
    ["A bullet under a findings heading"],
  );
});

test("a severity is taken only in lead or trailing position, never from a mid-sentence word", async () => {
  const { recoverFindingsFromProse } = await import("./verifier.mjs");
  const found = recoverFindingsFromProse([
    "## Findings",
    "1. Delete endpoint (minor refactor in #12 broke it) lets any user delete accounts",
    "2. Retry loop — major rewrite not needed, but it double-charges on 502",
    "3. **Major**: the session token sits in localStorage",
    "4. Blocker — the webhook signature is never checked",
    "5. The unsaved name edit is dropped on close — major.",
  ].join("\n"));
  assert.deepEqual(found.map((entry) => entry.severity), ["unknown", "unknown", "major", "blocker", "major"]);
});

test("a quoted JSON file is not a report, so it does not stop the nudge", async () => {
  // A verifier that quotes a lane's verification.json and then waits: the
  // quoted block is not a review, and the nudge is what returns the blocker.
  const root = workspace();
  let calls = 0;
  const quoted = "The lane record:\n```json\n{ \"taskId\": \"204\", \"checks\": [{ \"command\": \"npm test\", \"code\": 0 }] }\n```";
  const report = await runVerifier({
    root,
    config: {},
    dag: DAG,
    scratchReportPath: scratchPath(root),
    runAgent: fakeAgent(() => {
      calls += 1;
      return calls === 1
        ? `${initLine("sess-q")}${assistantLine(quoted)}${streamWith("Still running. I'll check again when it finishes.")}`
        : streamWith(agentText());
    }),
  });
  assert.equal(calls, 2, "the quoted block did not count as a report");
  assert.equal(report.counts.findings.blocker, 1, "the nudge's review, with its blocker, is the one kept");
  rmSync(root, { recursive: true, force: true });
});
