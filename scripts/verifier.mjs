// scripts/verifier.mjs — the epic's closeout review, as a structured artifact.
//
// docs/epic-schema.md, roles table: "`verifier` | once, at epic end | writes
// nothing | Run `/code-review` over the integrated branch, check it against the
// epic's acceptance criteria, produce the structured closeout."
//
// The constraint that shapes every line below:
//
//   THE VERIFIER CANNOT MARK THE EPIC COMPLETE.
//
// So this module has no state transition in it. It produces a report; a caller
// decides what the report means, in code, via `verifierDecision` — which returns
// a *recommendation* and deliberately does not return a lifecycle. The report
// schema has no `passed`, `approved` or `complete` field for the model to fill
// in, and `verifierReportCounts` recomputes every number the recommendation
// rests on from the arrays themselves rather than trusting a model-supplied
// total. docs/epic-schema.md, "Rejected: librarian", argues the position: a gate
// that can write to the thing it gates is honor-system.
//
// Three seams, in dependence order:
//
//   1. `extractAcceptanceCriteria` — pure. Child issue bodies in, criteria out.
//   2. `parseVerifierOutput`       — pure. Agent text in, report out. Never throws.
//   3. `runVerifier`               — the one impure function; `runAgent` injected.
//
// and two consumers, both pure: `verifierDecision` (report → recommendation) and
// `renderVerifierMarkdown` (report → the section the runner writes to the issue
// and the PR).
//
// ## What is NOT wired
//
// Nothing calls `runVerifier` automatically. The runner has no concept of an
// epic completing — that lifecycle is Lane L, Phase 4 (docs/epic-schema.md
// failure mode 5). Building a second epic-close here would guarantee a conflict
// with the one that is coming, so this module is an idempotent, independently
// invocable unit with a CLI (`afk verify <issue>`) and nothing else. Wiring it
// is one call from wherever the epic actually closes.
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  atomicWrite,
  buildAgentCommand,
  ensureDir,
  isMainModule,
  loadConfig,
  looksLikeAuthDeath,
  configPath,
  details,
  isStatusFlushPath,
  normalizeId,
  run,
  runAsync,
  DEFAULT_BACKEND,
  shellQuote,
  currentRepo,
  headSha,
} from "./lib.mjs";
import { finalText, reportMessages, reportText, sessionIdOf } from "./agent-stats.mjs";
import { modelCheck } from "./model-check.mjs";
import { preflightSettings, roleAgent, roleFor, rolePrompt, settingsArg } from "./roles.mjs";
import { createRoleCwd, readLaneVerification, removeRoleCwd, roleCwd, taskBranch } from "./worktree.mjs";
import {
  filesByTask,
  newUnusedExports,
  parseKnipReport,
  seamFiles,
  undeclaredWrites,
  untouchedAllowed,
} from "./reach.mjs";
import { describeFate, findingId, readFates } from "./fate.mjs";

export const VERIFIER_REPORT_VERSION = 1;

const VERDICTS = ["met", "partial", "unmet", "unknown"];
// Standards and Spec are both diff-vs-document. Reach is the third comparison
// neither makes — the diff against the rest of the codebase, against the call
// graph, and against the OTHER lanes. scripts/reach.mjs carries the three
// failures that bought it (#563, #365, #642). Appended rather than inserted:
// `pickEnum`'s fallback below is `"spec"` by name, so order is only about how
// the markdown renders.
const AXES = ["standards", "spec", "reach"];
const AXIS_NAME = { standards: "Standards", spec: "Spec", reach: "Reach" };
const SEVERITIES = ["blocker", "major", "minor"];

/**
 * The JSON contract, as the agent is shown it. Kept as a string rather than a
 * JSON Schema object because it is prompt text, and because a validator is not
 * what makes this safe — `normalizeReport` below discards anything off-schema
 * whatever the model emits.
 */
export const VERIFIER_JSON_SCHEMA = `{
  "summary": "one paragraph, what this epic delivered and what is wrong with it",
  "criteria": [
    { "id": "204.1", "verdict": "met|partial|unmet|unknown",
      "evidence": "file path, symbol or test name that shows it" }
  ],
  "findings": [
    { "axis": "standards|spec|reach", "severity": "blocker|major|minor",
      "title": "one line", "detail": "why it is wrong", "file": "path:line or null",
      "howToShowItFails": "the command, test or input that demonstrates the defect — required for blocker and major" }
  ],
  "mustFix": ["one line per problem you would block the merge for"],
  "seams": [
    { "file": "path two or more tasks both wrote", "tasks": ["657", "661"],
      "read": true, "note": "what the merged file actually does now" }
  ],
  "unwired": [
    { "symbol": "resolveSetting", "file": "path where it is exported" }
  ],
  "skipped": [
    { "tool": "lint|tests|build|typecheck|ast-grep",
      "reason": "why it could not run here — denied, unavailable, unwritable tree" }
  ]
}
// "seams" is the Reach axis's lane-vs-lane list. The runner hands you the files
// two or more tasks both wrote; you open each merged file and say what it does
// now. \`read: false\` means you did not open it, and the runner treats that as a
// must-fix — the file went through no review at all, which is #642.
// "unwired" is a symbol this epic added that has no non-test caller: a control
// wired to nothing. Every entry is a must-fix. [] when you found none, and say
// in \`summary\` that you looked — a search that finds nothing is an answer.
// "skipped" is every gate you could NOT run in this sandbox — an unwritable
// tree so lint or the tests never started, a tool that returned 403. gh is not
// a gate: the issue text is in your prompt.
// Name it even when you judged the criterion met from other evidence; a "met"
// resting on a gate that never ran is the failure this report exists to catch.
// [] only if every gate ran.`;

// ---------------------------------------------------------------------------
// Seam 1 — acceptance criteria, extracted rather than assumed
// ---------------------------------------------------------------------------
//
// Checked against the format that is actually written, not an imagined one:
//
// - The EPIC body has no acceptance criteria. It is a `/to-spec` PRD, whose
//   headings are Problem Statement / Solution / User Stories / Implementation
//   Decisions / Testing Decisions / Out of Scope / Further Notes, plus the
//   `afk:` block that `coduo-epic` appends. There is no such section to read,
//   so "the epic's acceptance criteria" in docs/build-prompt.md is, taken
//   literally, a format nobody writes.
// - The CHILD issues do have them. PLANNER.md Part 4 mandates a fixed heading
//   order for every child issue body, including `## Acceptance criteria`, "each
//   line mechanically checkable by a test or a type/compile check".
//
// So the epic's acceptance criteria are the union of its children's, which the
// DAG already carries: `epicToDag` puts each child issue body on `task.body`.
// The epic body is still scanned when one is supplied, because an epic that
// happens to carry the heading should not have it ignored — but nothing depends
// on it being there.

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/;
const CRITERIA_HEADING_RE = /^acceptance\s+criteria\b/i;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;

/**
 * The criteria lines under an `## Acceptance criteria` heading in one body.
 *
 * Stops at the next heading of the same or higher level, so a `### Notes`
 * nested under the criteria section keeps its bullets in and a following
 * `## Allowed paths` does not. Non-bullet prose inside the section is ignored:
 * PLANNER.md requires one criterion per line, and a paragraph is a preamble.
 *
 * "Per line" is per BULLET, not per physical line. A criterion that soft-wraps
 * used to lose everything after its first line, silently and with no marker:
 * epic #388's 384.2 reached the Spec axis ending at "an allow/deny" and the
 * fixer queued that half sentence as an item title. An indented continuation
 * line folds back into the bullet it belongs to. A BLANK line ends the fold,
 * which is what keeps the preamble rule above true — a paragraph separated
 * from the bullet is prose about the section, not the rest of the criterion.
 *
 * @returns {string[]}
 */
export const criteriaLinesIn = (body) => {
  const lines = String(body ?? "").split("\n");
  const out = [];
  let depth = null;
  let open = false; // a bullet is still accepting continuation lines
  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      open = false;
      const level = heading[1].length;
      if (depth !== null && level <= depth) {
        depth = null;
        continue;
      }
      if (depth === null && CRITERIA_HEADING_RE.test(heading[2])) depth = level;
      continue;
    }
    if (depth === null) continue;
    const bullet = BULLET_RE.exec(line);
    if (bullet && bullet[1]) {
      out.push(bullet[1]);
      open = true;
      continue;
    }
    const text = line.trim();
    if (!text) {
      open = false;
      continue;
    }
    // Indented, so it is inside the bullet's block per Markdown's own rule.
    // A flush-left paragraph is a preamble: still ignored as before, and it
    // ENDS the fold too, so a later indented line cannot be glued onto the
    // bullet above a paragraph the parser just said it was ignoring.
    if (!/^\s/.test(line)) open = false;
    else if (open) out[out.length - 1] += ` ${text}`;
  }
  return out;
};

/**
 * Every acceptance criterion this epic can be checked against, with a stable id.
 *
 * The id is `<taskId>.<n>` (`epic.<n>` for the epic body). Stable ids are what
 * let the model answer per criterion without echoing the text back, and what let
 * `normalizeReport` reject a verdict for a criterion nobody asked about.
 *
 * @param {{tasks?: object[], epic?: object}} dag the in-memory DAG
 * @param {string|null} epicBody the epic issue body, if the caller has it
 * @returns {{id: string, taskId: string, source: string, text: string}[]}
 */
export const extractAcceptanceCriteria = (dag = {}, epicBody = null) => {
  const out = [];
  const epicId = normalizeId(dag.epic?.id ?? null);
  criteriaLinesIn(epicBody).forEach((text, index) => {
    out.push({ id: `epic.${index + 1}`, taskId: epicId, source: "epic", text });
  });
  for (const task of dag.tasks ?? []) {
    const id = normalizeId(task.id);
    criteriaLinesIn(task.body).forEach((text, index) => {
      out.push({ id: `${id}.${index + 1}`, taskId: id, source: "task", text });
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Seam 2 — prose in, structure out
// ---------------------------------------------------------------------------

// ANY info string, not just `json`. The old pattern only recognised ```` ```json ````
// as an OPENER, so a ```` ```js ```` block earlier in the prose desynchronised the
// pairing for the whole document: the js block's CLOSER was read as an opener,
// the real report's opener was consumed as a closer, and the report itself was
// never seen. `afk verify` then said "the verifier produced no fenced `json`
// report block" about a review whose last 80 lines are exactly that.
//
// Measured on epic #23, where every verifier run came back `unparseable` and
// the reviews on disk each ended in a well-formed report block. The verifier
// was doing its job the whole time and the runner was throwing the answer away.
//
// `lastJsonBlock` below already tries each block and keeps the last that parses
// as an object, so widening the opener costs nothing: a ```` ```js ```` block simply
// fails JSON.parse and is skipped, which is what it was always meant to do.
const FENCE_RE = /```[^\n]*\n([\s\S]*?)\n?```/g;

/**
 * The last fenced block in the text that parses as a JSON object.
 *
 * Last, not first, because the prose half of the review legitimately quotes
 * JSON — a finding about a config file, a schema excerpt — and the contract the
 * prompt states is that the report block comes last. Parsing is attempted on
 * every fenced block from the end backwards, so an unlabelled fence or a stray
 * trailing snippet degrades to "try the next one up" rather than to a failure.
 *
 * @returns {object|null}
 */
export const lastJsonBlock = (text) => {
  const blocks = [...String(text ?? "").matchAll(FENCE_RE)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(blocks[i]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Not this one. A block that does not parse is not an error; it is prose.
    }
  }
  return null;
};

/**
 * A block that is a review: it carries a summary, findings or criteria. The
 * same line `parseVerifierOutput` draws when it calls a block "empty of both a
 * summary and findings".
 */
const looksLikeReview = (block) =>
  Boolean(block) && (
    (typeof block.summary === "string" && block.summary.trim() !== "")
    || (Array.isArray(block.findings) && block.findings.length > 0)
    || (Array.isArray(block.criteria) && block.criteria.length > 0)
  );

/** A dedicated report file may be the JSON object itself, with no Markdown. */
const wholeJsonObject = (text) => {
  try {
    const value = JSON.parse(String(text ?? "").trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Gates that could not run
// ---------------------------------------------------------------------------
//
// The verifier agent runs sandboxed, and in four separate live runs it said so
// in prose — "`gh` is not available in this sandbox", "could not run lint",
// "ast-grep returned 403" — then marked the criteria `met` from the runner's own
// integration checks. `report.json` recorded `"status":"ok","problems":[]`, so
// the closeout comment posted to the issue read as a clean review of gates that
// never executed.
//
// Two sources, in that order of trust. The block's own `skipped`/`gates` key is
// the reliable one and the schema above now asks for it; the prose detector
// below is the fallback for every report already on disk, written by an agent
// that was never asked.
//
// The detector is deliberately dumb: a fixed set of tool names, a fixed set of
// negation phrases, and both must appear on the SAME line. It will miss skips
// phrased any other way, which is the correct trade — a missed caveat leaves the
// artifact exactly as bad as it is today, while a general-NLP guess would put
// invented caveats onto an issue comment and teach the reader to ignore them.

// `build` and `test` are ordinary English verbs, and a review OF this repo is
// full of them — "cannot build the report", "one test is skipped". So those two
// gates only count when the word reads as a COMMAND: backticked, or next to a
// run/execute/invoke verb. `gh`, `lint`, `ast-grep` and `tsc` are already names
// nobody writes by accident.
const RUN_VERB = "(?:re-?)?(?:run|runs|ran|running|execute[sd]?|executing|invoke[sd]?|invoking)";
const commandish = (word) =>
  new RegExp(
    `\`[^\`]*\\b${word}\\b[^\`]*\`` +
      `|\\b${RUN_VERB}\\b[^.]{0,20}?\\b${word}\\b` +
      `|\\b${word}\\b[^.]{0,20}?\\b${RUN_VERB}\\b`,
    "i",
  );

const SKIPPABLE_GATES = [
  ["gh", /\bgh\b/i],
  ["lint", /\blint(?:ing|er)?\b/i],
  ["ast-grep", /\bast-grep\b/i],
  ["tests", commandish("(?:tests?|test suite)")],
  ["build", commandish("build")],
  ["typecheck", /\btype-?check\b|\btsc\b/i],
];

const GATE_NEGATION_RE =
  /\b(?:could not|couldn['’]t|cannot|can['’]t|unable to|did not run|didn['’]t run|never ran|was not run|were not run|not available|unavailable|denied|not permitted|returned 403)\b/i;

/**
 * Gates the prose says did not run, as `{tool, reason}`.
 *
 * Fenced blocks are stripped first: the report block legitimately contains the
 * word "tests" and a finding may quote a failing command, and neither is the
 * agent telling us a gate was skipped.
 *
 * @returns {{tool: string, reason: string|null}[]}
 */
export const detectSkippedGates = (text) => {
  const prose = String(text ?? "").replace(FENCE_RE, "\n");
  const seen = new Map();
  for (const line of prose.split("\n")) {
    if (!GATE_NEGATION_RE.test(line)) continue;
    const reason = line.trim().replace(/^[-*+]\s*/, "").slice(0, 300);
    for (const [tool, re] of SKIPPABLE_GATES) {
      if (re.test(line) && !seen.has(tool)) seen.set(tool, { tool, reason });
    }
  }
  return [...seen.values()];
};

// ---------------------------------------------------------------------------
// Findings recovered from prose, when no block arrived
// ---------------------------------------------------------------------------
//
// Five atlas-workspace closeouts (#665, #790, #865, #878, #896) did real review
// work in prose, emitted no block, and the runner kept none of it: every axis
// rendered `(0)` / `_No findings._` and the fixer was handed nothing. #865's
// prose held seven numbered findings.
//
// FAIL DIRECTION: OPEN. A loosely parsed finding a human can dismiss beats a
// real one nobody sees. What bounds "loosely" (two #149 reviews: a numbered
// plan, a 400-line list and a bailing agent's asks all became fixer items, and
// then reading only the final message recovered 28 findings from 70 archived
// streams where reading everything had recovered 190):
//
//   - the caller walks the messages backwards and takes the LAST one that
//     yields any finding. Real verifiers keep numbered findings in the axis
//     messages and close with a synthesis, or with "Report above."
//   - a numbered line counts anywhere, and so does a paragraph that opens with
//     a bold title ending in a full stop, or with `**→ Title**`. A bullet or a
//     table row counts only under a heading that names findings, violations,
//     deviations, issues or gaps (or in a table whose header does). An axis
//     heading alone is not enough: criteria tables, files-changed tables and
//     "Sources read" lists sit under those.
//   - skipped: lines inside a fence; a criteria walk (a line opening with a
//     verdict or a criterion id, a table row with a verdict cell, anything
//     under a criteria heading); a request to the reader ("Grant Bash
//     permission…", "Point me at…", anything ending in "?"); a clean result
//     ("none found", "no findings", "npm test — 120 pass").
//   - deduplicated on their words, and capped at RECOVERED_FINDINGS_CAP by the
//     caller, which states the overflow in `problems`.
//
// Every entry says it was recovered. Its severity is the one the line states
// in lead position ("Blocker —", "**Major**:") or trailing ("— major.",
// "(minor)"), else `unknown`. A mid-sentence word ("a minor refactor in #12")
// is not a severity: the runner does not grade a finding the prose did not.

export const RECOVERED_FINDINGS_CAP = 25;

const NUMBERED_LINE_RE = /^\s{0,3}\d+[.)]\s+(.+?)\s*$/;
const BULLET_LINE_RE = /^\s{0,3}[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const PSEUDO_HEADING_RE = /^\s*\*\*([^*]+?)\*\*:?\s*$/;
const FINDINGS_HEADING_RE = /finding|violation|deviation|issue|gap|bug|defect|problem|concern|regression/i;
// A criteria walk, not a defect: a line opening with a verdict word or with a
// criterion id ("818.3 — ..."), and everything under a criteria heading.
const VERDICT_LEAD_RE = /^[*_\s]*(?:(?:met|partial|unmet|unknown)\b|\d+\.\d+\b)/i;
const CRITERIA_SECTION_RE = /\bcriteri(?:on|a)\b/i;
const REQUEST_RE =
  /^(?:please|grant|point me|confirm|let me know|tell me|give me|allow|approve|provide|share|send me|(?:can|could|would|will) you|should i|do you)\b/i;
const LEAD_SEVERITY_RE = /^(?:\*\*)?(blocker|major|minor)(?:\*\*)?\s*[:—–-]+\s*(.*)$/i;
const TRAILING_SEVERITY_RE = /(?:\s[—–-]\s*(blocker|major|minor)|\((blocker|major|minor)\))\.?\s*$/i;
const NOTHING_FOUND_RE =
  /^(?:none|nothing|n\/a)\b|\b(?:none found|no findings?|nothing found|no issues?(?: found)?|nothing to report)\b/i;
const CLEAN_RESULT_RE = /[—–-]\s*(?:\d+\s+)?(?:pass(?:ed|es|ing)?|clean|green|ok|succeeded)\b\.?\s*$/i;
const VERDICT_CELL_RE = /^[✅❌🟡❓\s*]*(?:met|partial|unmet|unknown|pass|fail)[*\s]*$/i;
// A paragraph that opens with a bold title: `**→ Title.** detail` or
// `**Title.** detail`. The full stop (or the arrow) is what tells it from a
// bold pseudo-heading (`**Spec**`).
const BOLD_PARAGRAPH_RE = /^\*\*(→\s*)?([^*]+?)\*\*\s*(.*)$/;
const NOT_A_FINDING_TITLE_RE =
  /^(?:summary|verdict|recommendation|overall|conclusion|notes?|context|scope|method|approach|result|status|bottom line|tl;?dr|what|where|how|why|the (?:one|two|three|\w+) things?\b|\d+ of \d+)\b/i;
const BACKTICKED_PATH_RE = /`([\w./\\-]+\.[A-Za-z]\w*(?::\d+(?:-\d+)?)?)`/;
const BOLD_LEAD_RE = /^\*\*(.+?)\*\*\s*[:.\-—–]*\s*(.*)$/;

/** The axis a heading names, or null when it names none. */
const axisOfHeading = (text) => {
  if (/\bstandards?\b/i.test(text)) return "standards";
  if (/\breach\b|\bunwired\b|\bseams?\b/i.test(text)) return "reach";
  if (/\bspec\b/i.test(text)) return "spec";
  return null;
};

/** A finding out of one line's text, or null when the line is not one. */
const findingOfLine = (body, axis) => {
  // "Blocker — the webhook…", "**Major**: the token…": the lead is the
  // severity, not the title.
  const lead = LEAD_SEVERITY_RE.exec(body);
  const rest = lead ? lead[2] : body;
  const bold = BOLD_LEAD_RE.exec(rest);
  const title = bold ? bold[1] : rest;
  const detail = bold && bold[2] ? bold[2] : null;
  const trailing = TRAILING_SEVERITY_RE.exec(body);
  const severity = (lead?.[1] ?? trailing?.[1] ?? trailing?.[2] ?? "unknown").toLowerCase();
  const plain = title.replace(/\*\*/g, "").trim();
  if (
    !plain || VERDICT_LEAD_RE.test(body) || REQUEST_RE.test(plain) || /\?\s*$/.test(body) || /\?\**$/.test(plain)
    || NOTHING_FOUND_RE.test(plain) || CLEAN_RESULT_RE.test(body)
  ) return null;
  return {
    axis,
    severity,
    title: title.slice(0, 200),
    detail,
    file: body.match(BACKTICKED_PATH_RE)?.[1] ?? null,
    howToShowItFails: null,
    recovered: "prose",
  };
};

/** The table row's title cell: the first that is not a row number. */
const tableTitle = (cells) => cells.find((cell) => cell && !/^#?\d*$/.test(cell)) ?? null;

const wordsOf = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Findings out of one message of a review that emitted no block, deduplicated
 * and uncapped (the caller walks the messages and caps).
 *
 * The axis is the nearest heading that names one, and a sub-heading that names
 * none inherits its parent's (`## Standards` → `### Hard violations` is still
 * standards). A bold line on its own (`**Spec**`) is a heading below every `#`.
 *
 * @returns {object[]} findings in the normalized shape, each `recovered: "prose"`
 */
export const recoverFindingsFromProse = (text) => {
  const prose = String(text ?? "").replace(FENCE_RE, "\n");
  const out = [];
  const seen = new Set();
  const stack = [];
  let previousWasRow = false;
  let tableIsFindings = false;
  let previousBlank = true;
  const add = (finding) => {
    const key = finding && wordsOf(finding.title);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(finding);
  };
  for (const line of prose.split("\n")) {
    const heading = HEADING_RE.exec(line);
    // `**Summary.**` alone is a bold paragraph, not a heading: the full stop.
    const pseudo = heading ? null : PSEUDO_HEADING_RE.exec(line);
    if (pseudo && /[.!]$/.test(pseudo[1].trim())) {
      previousBlank = false;
      continue;
    }
    if (heading || pseudo) {
      const level = heading ? heading[1].length : 7;
      const name = heading ? heading[2] : pseudo[1];
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const parent = stack.at(-1);
      const named = axisOfHeading(name);
      stack.push({
        level,
        // "## Criteria gaps" or "### Spec — unmet criteria" is a findings list.
        criteria: (CRITERIA_SECTION_RE.test(name) || Boolean(parent?.criteria))
          && !named && !FINDINGS_HEADING_RE.test(name),
        axis: named ?? parent?.axis ?? null,
        findings: FINDINGS_HEADING_RE.test(name) || Boolean(parent?.findings),
      });
      previousWasRow = false;
      previousBlank = true;
      continue;
    }
    if (stack.at(-1)?.criteria) continue;
    const axis = stack.at(-1)?.axis ?? "spec";
    const inFindings = Boolean(stack.at(-1)?.findings);
    const row = TABLE_ROW_RE.exec(line);
    if (row) {
      const cells = row[1].split("|").map((cell) => cell.trim());
      const separator = cells.every((cell) => /^:?-+:?$/.test(cell));
      // The first row of a table is its header; a header that names findings
      // makes the table a findings table under any heading (#865's spec
      // deviations were one, under `**Spec**`).
      if (!previousWasRow) tableIsFindings = cells.some((cell) => FINDINGS_HEADING_RE.test(cell));
      else if ((inFindings || tableIsFindings) && !separator && !cells.some((cell) => VERDICT_CELL_RE.test(cell))) {
        const title = tableTitle(cells);
        const finding = title ? findingOfLine(title, axis) : null;
        if (finding) add({ ...finding, file: line.match(BACKTICKED_PATH_RE)?.[1] ?? null });
      }
      previousWasRow = true;
      previousBlank = false;
      continue;
    }
    previousWasRow = false;
    const paragraphStart = previousBlank;
    previousBlank = !line.trim();
    const numbered = NUMBERED_LINE_RE.exec(line);
    if (numbered) {
      add(findingOfLine(numbered[1], axis));
      continue;
    }
    const bullet = inFindings ? BULLET_LINE_RE.exec(line) : null;
    if (bullet) {
      add(findingOfLine(bullet[1], axis));
      continue;
    }
    const boldParagraph = paragraphStart ? BOLD_PARAGRAPH_RE.exec(line.trim()) : null;
    if (boldParagraph && (boldParagraph[1] || /[.!]$/.test(boldParagraph[2].trim()))) {
      const title = boldParagraph[2].trim();
      if (NOT_A_FINDING_TITLE_RE.test(title)) continue;
      const finding = findingOfLine(title, axis);
      if (finding) add({ ...finding, detail: boldParagraph[3] || null, file: line.match(BACKTICKED_PATH_RE)?.[1] ?? null });
    }
  }
  return out;
};

const UNWIRED_PHRASE_RE =
  /\bunwired\b|\bno (?:non-test |production )?callers?\b|\bnever called\b|\bnothing (?:outside (?:a |the )?tests? )?calls\b/i;
const BACKTICKED_SYMBOL_RE = /`([A-Za-z_$][\w$]*)(?:\(\))?`/;

/**
 * Unwired exports named in prose: a line that says a backticked symbol has no
 * caller. Same fail direction as `recoverFindingsFromProse`, and only used when
 * the runner computed no `unwired` list of its own.
 */
export const recoverUnwiredFromProse = (text) => {
  const prose = String(text ?? "").replace(FENCE_RE, "\n");
  const seen = new Map();
  for (const line of prose.split("\n")) {
    if (!UNWIRED_PHRASE_RE.test(line)) continue;
    const symbol = line.match(BACKTICKED_SYMBOL_RE)?.[1];
    if (!symbol || seen.has(symbol)) continue;
    seen.set(symbol, { symbol, file: line.match(BACKTICKED_PATH_RE)?.[1] ?? null, recovered: "prose" });
  }
  return [...seen.values()];
};

/**
 * The model's own declaration of un-run gates, from `skipped` or `gates`.
 *
 * A `gates` list describes every gate, so an entry that says it RAN is dropped;
 * a `skipped` list is already only the un-run ones. An entry with no nameable
 * tool is dropped, because a reason with nothing attached to it is not a caveat
 * anyone can act on.
 */
const pickString = (value, fallback = null) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

/**
 * Did the block ANSWER the question, as opposed to leaving the key out?
 *
 * `"skipped": []` is the declaration that matters most — every gate ran — and it
 * is indistinguishable from "absent" once the array is normalised, so presence
 * is read off the block itself rather than off the length of the result.
 */
const declaresSkipped = (value) =>
  Array.isArray(value?.skipped) || Array.isArray(value?.gates);

const normalizeSkipped = (value) => {
  const declared = [
    ...(Array.isArray(value?.skipped) ? value.skipped : []),
    ...(Array.isArray(value?.gates) ? value.gates : []).filter(
      (entry) => !(entry?.ran === true || /^(?:ran|passed|ok)$/i.test(String(entry?.status ?? ""))),
    ),
  ];
  const seen = new Map();
  for (const entry of declared) {
    const tool =
      typeof entry === "string"
        ? pickString(entry)
        : pickString(entry?.tool ?? entry?.gate ?? entry?.name);
    if (!tool || seen.has(tool)) continue;
    const reason =
      typeof entry === "string" ? null : pickString(entry?.reason ?? entry?.detail ?? entry?.why);
    seen.set(tool, { tool, reason });
  }
  return [...seen.values()];
};

const pickEnum = (value, allowed, fallback) =>
  allowed.includes(String(value).toLowerCase()) ? String(value).toLowerCase() : fallback;

/**
 * Coerce whatever the model emitted into the schema, dropping the rest.
 *
 * Every criterion the runner asked about appears in the output exactly once,
 * whether or not the model answered it — an unanswered criterion is `unknown`,
 * which is what the report should say, rather than silently shrinking the list.
 * A verdict for a criterion id nobody asked about is dropped, because it is
 * either a hallucination or a stale id, and neither is evidence.
 */
export const normalizeReport = (value, criteria = []) => {
  const answers = new Map(
    (Array.isArray(value?.criteria) ? value.criteria : [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => [String(entry.id), entry]),
  );
  return {
    summary: pickString(value?.summary, ""),
    criteria: criteria.map((criterion) => {
      const answer = answers.get(criterion.id);
      return {
        id: criterion.id,
        taskId: criterion.taskId,
        source: criterion.source,
        text: criterion.text,
        verdict: answer ? pickEnum(answer.verdict, VERDICTS, "unknown") : "unknown",
        evidence: answer ? pickString(answer.evidence) : null,
      };
    }),
    findings: (Array.isArray(value?.findings) ? value.findings : [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        axis: pickEnum(entry.axis, AXES, "spec"),
        severity: pickEnum(entry.severity, SEVERITIES, "minor"),
        title: pickString(entry.title, "(untitled finding)"),
        detail: pickString(entry.detail),
        file: pickString(entry.file),
        // Null on a report written before the field existed, and on a minor
        // finding, where it was never asked for. `verifierDecision` notes a
        // blocker or major that arrived without one.
        howToShowItFails: pickString(entry.howToShowItFails),
      })),
    mustFix: (Array.isArray(value?.mustFix) ? value.mustFix : [])
      .map((entry) => pickString(entry))
      .filter(Boolean),
    // `read` defaults to FALSE on anything the model left out or sent as
    // something other than `true`. A seam the report cannot positively say was
    // opened is a seam nobody read, and this fails that way on purpose: the
    // whole of #642 is that an unreviewed join reads as reviewed.
    seams: (Array.isArray(value?.seams) ? value.seams : [])
      .filter((entry) => entry && typeof entry === "object" && pickString(entry.file))
      .map((entry) => ({
        file: pickString(entry.file),
        tasks: (Array.isArray(entry.tasks) ? entry.tasks : []).map((id) => String(id)),
        read: entry.read === true,
        note: pickString(entry.note),
      })),
    unwired: (Array.isArray(value?.unwired) ? value.unwired : [])
      .filter((entry) => entry && typeof entry === "object" && pickString(entry.symbol))
      .map((entry) => ({ symbol: pickString(entry.symbol), file: pickString(entry.file) })),
    skipped: normalizeSkipped(value),
  };
};

/** A path under `.afk-runs/` (or the pre-rename `runs/`) ending in `.json` — a
 * runner artifact, not a source file. Both are matched so closeout evidence
 * committed before the rename still resolves. */
const RUNNER_ARTIFACT = /(?:\.afk-runs|\bruns)\/[\w.-]+\/[\w./-]*\.json\b/;

/**
 * The commit a runner artifact describes, or null when it cannot say.
 *
 * `resultingHead` first: an integration artifact records both the commit it
 * started from and the one it produced, and the second is what its checks
 * actually ran against.
 */
export const artifactCommitAt = (root, relativePath) => {
  try {
    const record = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
    return pickString(record.resultingHead) ?? pickString(record.baseSha) ?? null;
  } catch {
    return null;
  }
};

/**
 * The paths that changed between two commits, or null when git cannot say.
 *
 * Null, never `[]`, on an unknown commit or a missing repo: an empty diff and
 * an unanswerable one mean opposite things to the caller below, and collapsing
 * them would read "I could not check" as "nothing changed".
 */
export const changedPathsBetween = (root, from, to) => {
  // `--` because both arguments are SHAs read out of a JSON artifact: without
  // it a value that happens to name a path is resolved as one, git exits 0 with
  // an empty diff, and "I could not check" reads as "nothing changed".
  //
  // `--no-renames` because rename detection reports only the DESTINATION, so a
  // source file moved into `runs/` or `.afk/` would be the whole diff and the
  // caveat would be suppressed on a commit that removed a source file. The
  // caller only ever asks "did a path outside the runner's own change", and for
  // that question both ends of a rename have to be named.
  const result = run(
    `git diff --name-only --no-renames ${shellQuote(from)} ${shellQuote(to)} --`,
    { cwd: root },
  );
  if (result.status !== 0) return null;
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
};

/**
 * Caveat a `met` whose evidence is a runner artifact from a different commit.
 *
 * Epic #391's review sandbox could run none of its six gates, so for two
 * `check:all` criteria the artifact WAS the evidence —
 * `runs/169/integration-verification.json`, written at `2fdd0795`, against a
 * branch whose tip was `0517da3d`. Both rendered as a plain ✅. A tick resting
 * on a green suite from a commit ago is not the claim a reader takes it for,
 * and nothing on the report said which kind it was.
 *
 * Three deliberate narrownesses, because a caveat on everything is a caveat on
 * nothing:
 *
 *  - only `met`. An `unmet` already says the worst thing about itself.
 *  - only evidence naming a `.afk-runs/**.json` artifact. Ordinary evidence is a
 *    file, a symbol or a test name, with no commit to compare.
 *  - only when the artifact can be read AND names a commit. Unreadable is no
 *    evidence, and no evidence is not evidence — the rule the rest of this
 *    file holds.
 *
 * The verdict is never rewritten. The reviewer judged; this says what the
 * judgement rests on. Downgrading to `unknown` would also inflate the not-met
 * count, which is the arithmetic epic #93 already got burned by.
 *
 * A fourth narrowness, added after epic #389 caveated three criteria against a
 * branch that had not moved: the question is whether anything the REVIEWER read
 * changed between the artifact's commit and the head, not whether the two SHAs
 * differ. `flushStatuses` commits the epic's progress table, the integration
 * verification and the ledger immediately after every merge, so the artifact
 * commit is essentially never the head and a SHA comparison fires on every
 * epic. `changedPaths` answers the real question; when it cannot answer —
 * unknown commit, no repo, no seam injected — this falls back to the SHA
 * comparison, because an unanswerable question is not evidence of freshness.
 *
 * @param {object[]} criteria normalized criteria
 * @param {{head: string|null, artifactCommit: (path: string) => string|null,
 *          changedPaths?: (from: string, to: string) => string[]|null}} lookup
 */
export const markStaleEvidence = (criteria, { head, artifactCommit, changedPaths }) =>
  (criteria ?? []).map((entry) => {
    if (entry.verdict !== "met" || !head) return entry;
    const hit = String(entry.evidence ?? "").match(RUNNER_ARTIFACT);
    if (!hit) return entry;
    const at = artifactCommit(hit[0]);
    if (!at || at === head) return entry;
    const changed = changedPaths?.(at, head) ?? null;
    if (changed && changed.every(isStatusFlushPath)) return entry;
    return {
      ...entry,
      unverified: `${hit[0]} was written at ${at}; this review read ${head}`,
    };
  });

/**
 * Counts, recomputed from the arrays by this runner.
 *
 * Never read off the model's own summary. The whole point of the structure is
 * that the numbers the decision rests on are the runner's arithmetic over the
 * model's observations, not the model's arithmetic over its own.
 */
export const verifierReportCounts = (report) => {
  const criteria = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const entry of report?.criteria ?? []) {
    criteria[entry.verdict] = (criteria[entry.verdict] ?? 0) + 1;
  }
  const findings = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const entry of report?.findings ?? []) {
    findings[entry.severity] = (findings[entry.severity] ?? 0) + 1;
  }
  return {
    criteria,
    criteriaTotal: (report?.criteria ?? []).length,
    // Ticks that rest on a runner artifact from another commit. Counted beside
    // `criteria.met` rather than subtracted from it: the reviewer did judge
    // them met, and this says what that judgement rests on.
    criteriaUnverified: (report?.criteria ?? []).filter((entry) => entry.unverified).length,
    findings,
    findingsTotal: (report?.findings ?? []).length,
    mustFix: (report?.mustFix ?? []).length,
    // The Reach arithmetic, recomputed here for the same reason as every number
    // above it: `verifierDecision` blocks on these two, so a model-supplied
    // total would be a model deciding its own verdict.
    seams: (report?.seams ?? []).length,
    seamsUnread: (report?.seams ?? []).filter((entry) => !entry.read).length,
    unwired: (report?.unwired ?? []).length,
  };
};

/**
 * The whole of "prose in, report out". Pure, total, and never throws.
 *
 * `status` is about whether a report was OBTAINED, never about whether the epic
 * is good:
 *
 *   ok           a schema-shaped block was found and normalised
 *   unparseable  the agent exited 0 and emitted no usable block
 *   agent_failed the agent process exited non-zero or timed out
 *   auth_failed  the transcript says the claude login expired
 *
 * The raw text is kept on all four paths. An unparseable review still contains
 * a human-readable `/code-review`, and throwing it away to punish a formatting
 * miss would cost the human the only artifact that ran.
 */
export const parseVerifierOutput = ({
  head = null,
  text = "",
  // What the agent wrote to the scratch path the runner handed it, when it
  // wrote anything. The file is the channel; `text` is the fallback behind it.
  file = "",
  raw = "",
  criteria = [],
  agentStatus = 0,
  timedOut = false,
  meta = {},
}) => {
  const problems = [];
  let status = "ok";
  if (looksLikeAuthDeath(raw) || looksLikeAuthDeath(text)) {
    status = "auth_failed";
    // The same sentence scripts/auto.mjs prints when a builder dies this way.
    // One policy for auth death, not two: report it, name the fix, and let the
    // caller halt. This module halts nothing because it owns no loop.
    problems.push(
      "the claude login expired (run `claude auth login`, then rerun `afk verify`)",
    );
  } else if (timedOut) {
    status = "agent_failed";
    problems.push("the verifier agent hit its timeout before it reported");
  } else if (agentStatus !== 0) {
    status = "agent_failed";
    problems.push(`the verifier agent exited ${agentStatus}`);
  }

  // The file first, the harvested prose second. A stale timer can wake an agent
  // after it answers and overwrite its final message; it cannot overwrite a file
  // the agent already closed. But a missing file must never cost a review that
  // ran — losing one to a transport is worse than reading one out of prose — so
  // this falls back rather than failing, and says which channel it used.
  // The scratch file is a dedicated machine channel, so a whole-file JSON
  // object is unambiguous. The transcript stays fenced-only because its prose
  // may quote arbitrary JSON that is not the final report.
  const fileBlock = lastJsonBlock(file) ?? wholeJsonObject(file);
  const block = fileBlock ?? lastJsonBlock(text);
  // Which channel the report came from is recorded either way, but only the
  // fallback is a `problem`: `problems` renders as ⚠️ in the markdown and is
  // copied wholesale into `verifierDecision`'s `blocking` on any non-ok run, so
  // filing the healthy path there put a warning on every clean review and a
  // spurious blocker on every failed one.
  const reportChannel = meta.reportPath ? (fileBlock ? "file" : "transcript") : null;
  if (meta.reportPath && !fileBlock) {
    problems.push(
      `nothing usable at ${meta.reportPath} — the report was harvested from the agent's transcript instead`,
    );
  }
  if (status === "ok" && !block) {
    status = "unparseable";
    problems.push(
      "the verifier produced no fenced `json` report block; its prose review is kept verbatim below",
    );
  }
  const normalized = normalizeReport(block ?? {}, criteria);
  // After normalizing, because it reads the verdicts the runner settled on
  // rather than whatever the model emitted. `meta.root` is absent in the pure
  // parse tests, where there is no checkout to resolve an artifact against.
  if (meta.root) {
    normalized.criteria = markStaleEvidence(normalized.criteria, {
      head,
      artifactCommit: (path) => artifactCommitAt(meta.root, path),
      changedPaths: (from, to) => changedPathsBetween(meta.root, from, to),
    });
  }
  // Computed beats reported, and this one is not symmetrical with `skipped`
  // below: a declared empty `unwired` does NOT win. The model is asked for this
  // list by grep only as the fallback for a project that declares no
  // `reachReport`; where the runner set-diffed two knip payloads, that is the
  // answer, and `[]` — the easy answer, and the one #365 got away with — must
  // not be able to erase it. Same authority split as `verifierReportCounts`.
  if (Array.isArray(meta.unwired)) {
    normalized.unwired = meta.unwired.map((entry) => ({
      symbol: pickString(entry?.symbol),
      file: pickString(entry?.file),
    }));
  }
  // No block, so nothing structured to keep but what the prose says. Only on
  // `unparseable`: an `agent_failed` or `auth_failed` transcript is a dying
  // session, not a finished review. A computed `unwired` still wins, as above.
  if (status === "unparseable") {
    // The last message that yields findings, walking back from the end: see
    // `recoverFindingsFromProse`. A raw that is not a stream (the pure tests)
    // has no messages, and then the whole text is the one message.
    const messages = reportMessages(String(raw ?? ""));
    let recovered = [];
    for (const message of [...(messages.length ? messages : [text])].reverse()) {
      recovered = recoverFindingsFromProse(message);
      if (recovered.length) break;
    }
    normalized.findings = recovered.slice(0, RECOVERED_FINDINGS_CAP);
    if (recovered.length > RECOVERED_FINDINGS_CAP) {
      normalized.recoveredOverflow = recovered.length - RECOVERED_FINDINGS_CAP;
      problems.push(
        `${normalized.recoveredOverflow} more numbered line(s) were recovered from the prose and dropped past the cap of ${RECOVERED_FINDINGS_CAP}; read the raw review below`,
      );
    }
    if (!Array.isArray(meta.unwired)) normalized.unwired = recoverUnwiredFromProse(text);
    // #142 names seams beside unwired: the files two or more lanes both wrote
    // are the runner's own evidence, and with no block nobody said they read
    // them — so they are unread, which is what `read: false` means (#642).
    if (Array.isArray(meta.seams)) {
      normalized.seams = meta.seams
        .filter((entry) => pickString(entry?.file))
        .map((entry) => ({
          file: pickString(entry.file),
          tasks: (Array.isArray(entry.tasks) ? entry.tasks : []).map((id) => String(id)),
          read: false,
          note: null,
        }));
    }
  }
  // Declared beats detected, INCLUDING a declared empty list. An agent that
  // answered the question is not second-guessed, and the fallback never doubles
  // a caveat it already made; it runs only when the key is absent entirely.
  if (!declaresSkipped(block)) normalized.skipped = detectSkippedGates(text);
  if (status === "ok" && !normalized.summary && normalized.findings.length === 0) {
    problems.push(
      "the report block was empty of both a summary and findings — treat it as no review, not as a clean one",
    );
  }

  const report = {
    version: VERIFIER_REPORT_VERSION,
    status,
    epic: meta.epic ?? { id: null, title: null },
    branch: meta.branch ?? null,
    baseBranch: meta.baseBranch ?? null,
    // The commit this review actually looked at. `runVerifier`'s `reuse` path
    // compares it to the branch's current HEAD, because a review is valid for
    // the tree it read and for no other.
    head: head ?? null,
    ranAt: meta.ranAt ?? new Date().toISOString(),
    durationMs: meta.durationMs ?? null,
    // "file" — the agent wrote the scratch path the runner handed it;
    // "transcript" — nothing usable was there and the prose was harvested;
    // null — no scratch path was in play (the pure parse tests).
    reportChannel,
    // What the epic still owed when this review ran. Empty on a complete epic;
    // populated when the review happened because the epic STOPPED — failed,
    // never-ran or parked on a human's acceptance. A review of a partial branch
    // is still worth having, but it must say so on its face.
    outstanding: meta.outstanding ?? [],
    ...normalized,
    problems,
    prose: String(text ?? "").trim(),
    artifacts: meta.artifacts ?? {},
  };
  report.counts = verifierReportCounts(report);
  return report;
};

// ---------------------------------------------------------------------------
// Report → decision. In code. This is the whole authority split.
// ---------------------------------------------------------------------------

/**
 * What the runner should do about a report — as a RECOMMENDATION, not a state.
 *
 * This function deliberately returns no lifecycle, no `passed`, and no boolean
 * called `complete`. It returns one of four words plus the reasons behind it,
 * and the caller — today a human reading `afk verify`, later whatever Lane L
 * builds for epic close — decides what that word is worth. Making this return a
 * transition is exactly the design docs/epic-schema.md rejects, so the type is
 * the guard rail.
 *
 *   inconclusive     no usable report; the review did not happen
 *   must-fix         blockers, or an explicit must-fix list
 *   criteria-unmet   the review is clean but stated criteria are not met
 *   clean            no blockers, no must-fix, no unmet criterion
 *
 * `clean` never means "close the epic". `unknown` criteria are surfaced in
 * `notes` rather than folded into the recommendation, because "nobody checked"
 * is a fact for the human and not a verdict this function is entitled to take a
 * side on.
 *
 * @returns {{recommendation: string, blocking: string[], notes: string[]}}
 */
export const verifierDecision = (report) => {
  const counts = report?.counts ?? verifierReportCounts(report ?? {});
  const blocking = [];
  const notes = [];
  if (!report || report.status !== "ok") {
    return {
      recommendation: "inconclusive",
      blocking: [...(report?.problems ?? ["no verifier report"])],
      notes,
    };
  }
  if (counts.findings.blocker > 0) {
    blocking.push(
      `${counts.findings.blocker} blocker finding${counts.findings.blocker === 1 ? "" : "s"}`,
    );
  }
  if (counts.mustFix > 0) {
    blocking.push(`${counts.mustFix} must-fix item${counts.mustFix === 1 ? "" : "s"}`);
  }
  // The two Reach blockers, decided here rather than by the model. An export
  // this epic added with no non-test caller is #365 — a control wired to
  // nothing, which every other axis reads as delivered. A seam the review did
  // not open is #642 — a file two lanes both wrote that went through no review,
  // and "the reviewer forgot" and "the join is fine" must not collapse into one
  // outcome. Neither is left to `mustFix`, which is the model's own list.
  if (counts.unwired > 0) {
    blocking.push(
      `${counts.unwired} symbol${counts.unwired === 1 ? "" : "s"} this epic added with no non-test caller`,
    );
  }
  if (counts.seamsUnread > 0) {
    blocking.push(
      `${counts.seamsUnread} shared file${counts.seamsUnread === 1 ? "" : "s"} written by two or more lanes that this review did not open`,
    );
  }
  // Ahead of the criteria arithmetic, because it qualifies all of it: a `met`
  // resting on a gate that never ran is not the same claim as a `met` resting on
  // a gate that passed, and only this line tells the two apart.
  if (report.skipped?.length) {
    notes.push(
      `${report.skipped.length} gate(s) could not run in the review sandbox (${report.skipped
        .map((entry) => entry.tool)
        .join(", ")}) — verdicts resting on them are unverified`,
    );
  }
  // Beside the skipped-gates note above, and for the same reason: this is the
  // other way a tick can be worth less than it looks.
  if (counts.criteriaUnverified > 0) {
    notes.push(
      `${counts.criteriaUnverified} criteri${counts.criteriaUnverified === 1 ? "on" : "a"} marked met from a runner artifact written at a different commit — unverified against the branch this review read`,
    );
  }
  // A note, not a blocker: the finding may still be right, and a missing field
  // must not sink a verdict. It tells the human which findings to prove first.
  const unshown = (report.findings ?? []).filter(
    (entry) => (entry.severity === "blocker" || entry.severity === "major") && !entry.howToShowItFails,
  ).length;
  if (unshown > 0) {
    notes.push(
      `${unshown} blocker/major finding${unshown === 1 ? "" : "s"} came with no way to show ${unshown === 1 ? "it fails" : "they fail"} — confirm before acting on ${unshown === 1 ? "it" : "them"}`,
    );
  }
  const unmet = counts.criteria.unmet + counts.criteria.partial;
  if (unmet > 0) notes.push(`${unmet} acceptance criteria not fully met`);
  if (counts.criteria.unknown > 0) {
    notes.push(
      `${counts.criteria.unknown} acceptance criteria could not be checked — unknown is not met`,
    );
  }
  if (counts.criteriaTotal === 0) {
    notes.push(
      "no acceptance criteria were extractable from the child issues; this review is diff-only",
    );
  }
  if (blocking.length > 0) return { recommendation: "must-fix", blocking, notes };
  if (unmet > 0) {
    return { recommendation: "criteria-unmet", blocking: [`${unmet} unmet`], notes };
  }
  return { recommendation: "clean", blocking, notes };
};

// ---------------------------------------------------------------------------
// Report → markdown. Also in code, also token-free.
// ---------------------------------------------------------------------------

const VERDICT_MARK = { met: "✅", partial: "🟡", unmet: "❌", unknown: "❓" };

// Severity's own marks, deliberately NOT reusing the verdict palette above: a
// 🟡 that means "partial criterion" in one line and "major finding" in the next
// is worse than no colour at all. Red / orange / white reads as a ramp at a
// glance, which is the whole job of a summary line nobody expands.
const SEVERITY_MARK = { blocker: "🔴", major: "🟠", minor: "⚪", unknown: "❔" };

/**
 * The section the runner writes to the epic issue and the PR body.
 *
 * Templating, deterministic, no tokens — docs/epic-schema.md, "Rejected:
 * librarian": "Rendering is templating, so the runner does it in code."
 *
 * Injecting this into the draft PR body is a **data change, not a rewrite**:
 * `renderPrBody` in scripts/pr.mjs builds an array of markdown chunks and joins
 * it, so the wiring is one `lines.push(...)` guarded on a `verifierReport`
 * argument. That edit is not made here — Lane H may read scripts/pr.mjs and may
 * not change it. See the follow-up note in this lane's report.
 */
export const renderVerifierMarkdown = (report, { heading = "## Verifier" } = {}) => {
  if (!report) return `${heading}\n\n_No verifier report._\n`;
  const decision = verifierDecision(report);
  const counts = report.counts ?? verifierReportCounts(report);
  const lines = [
    heading,
    "",
    `**Recommendation: \`${decision.recommendation}\`** — advisory. The runner does not close an epic on this line; a human does.`,
    "",
    `Ran ${report.ranAt} over \`${report.branch ?? "?"}\` against \`${report.baseBranch ?? "?"}\` (status: \`${report.status}\`).`,
  ];
  // The review runs whenever the epic stops, not only when it succeeds, so a
  // reader must be able to tell a review of the finished thing from a review of
  // whatever managed to integrate.
  if (report.outstanding?.length) {
    lines.push(
      "",
      `> ⏳ Reviewed an epic that had stopped short: ${report.outstanding.join("; ")}. Findings below cover what integrated, not what was never built.`,
    );
  }
  if (report.problems.length > 0) {
    lines.push("", ...report.problems.map((problem) => `> ⚠️ ${problem}`));
  }
  // Above the summary, because a reader who stops after the first screen must
  // not leave believing every gate ran. `status` stays `ok` — a report WAS
  // obtained, which is all `status` has ever meant — so this is the only place
  // the qualification exists.
  if (report.skipped?.length) {
    // Collapsed, but the headline is the summary line itself: a reader who
    // never clicks still learns the count and that verdicts rest on it. The
    // reasons are what fold away — they run to a paragraph each.
    lines.push(
      "",
      details({
        summary: `🚧 <b>${report.skipped.length} gate(s) did not run in the review sandbox</b> — `
          + `${report.skipped.map((entry) => entry.tool).join(", ")}. Any verdict below that rests on one is unverified.`,
        body: report.skipped
          .map((entry) => `- \`${entry.tool}\`${entry.reason ? ` — ${entry.reason}` : ""}`)
          .join("\n"),
      }),
    );
  }
  if (report.summary) lines.push("", report.summary);

  if (counts.criteriaTotal > 0) {
    // A 48-row criteria table is the single longest thing in a closeout and the
    // reader who needs its verdict needs four numbers, not 48 rows.
    const tally = ["met", "partial", "unmet", "unknown"]
      .map((verdict) => ({ verdict, n: report.criteria.filter((entry) => entry.verdict === verdict).length }))
      .filter((entry) => entry.n)
      .map((entry) => `${VERDICT_MARK[entry.verdict]} ${entry.n} ${entry.verdict}`)
      .join(" · ");
    // ALWAYS collapsed, including when something is unmet. The first cut opened
    // this section whenever a criterion was unmet or partial, which on a real
    // epic is nearly always — Lumina #203 has 36 criteria, 13 of them not met —
    // so the "collapsed" closeout rendered LONGER than the one it replaced
    // (140 visible lines against 115). Folding only the already-short documents
    // is not a brevity win, it is a no-op with extra markup.
    //
    // What makes that safe is the summary: the ids of what is NOT met go on the
    // summary line, so the reader who never clicks still learns which criteria
    // to chase, which is the only thing the open table was giving them.
    const failing = report.criteria.filter((entry) => entry.verdict === "unmet" || entry.verdict === "partial");
    const named = failing.slice(0, 6).map((entry) => entry.id).join(", ");
    const overflow = failing.length > 6 ? ` +${failing.length - 6} more` : "";
    lines.push(
      "",
      details({
        summary: `<b>Acceptance criteria — ${counts.criteria.met}/${counts.criteriaTotal} met${
          counts.criteriaUnverified ? `, ${counts.criteriaUnverified} unverified` : ""
        }</b> &nbsp; ${tally}${failing.length ? ` &nbsp; — <b>chase:</b> ${named}${overflow}` : ""}`,
        body: [
      "| | Criterion | Task | Evidence |",
      "| --- | --- | --- | --- |",
      ...report.criteria.map(
        (entry) =>
          `| ${entry.unverified ? "⚠️" : (VERDICT_MARK[entry.verdict] ?? "❓")} | ${entry.text.replace(/\|/g, "\\|")} | #${entry.taskId ?? "?"} | ${(entry.evidence ?? "—").replace(/\|/g, "\\|")}${
            entry.unverified ? ` — **unverified**: ${entry.unverified.replace(/\|/g, "\\|")}` : ""
          } |`,
      ),
        ].join("\n"),
      }),
    );
  } else {
    lines.push(
      "",
      "### Acceptance criteria",
      "",
      "_None extractable — no child issue body carries an `## Acceptance criteria` section, so this review is diff-only._",
    );
  }

  if (report.mustFix.length > 0) {
    lines.push(
      "",
      "### Must fix before this ships",
      "",
      ...report.mustFix.map((item) => `- [ ] ${item}`),
    );
  }

  // The Reach evidence, above the per-axis findings because both blocking
  // conditions live here and a reader who stops at the first screen must see
  // them. Rendered whenever either list is non-empty; an epic with one lane and
  // no new exports legitimately has neither.
  if (report.seams?.length || report.unwired?.length) {
    const reachLines = [];
    if (report.unwired?.length) {
      reachLines.push(
        ...report.unwired.map(
          (entry) => `- 🔌 \`${entry.symbol}\`${entry.file ? ` (\`${entry.file}\`)` : ""} — added by this epic, no non-test caller${entry.recovered ? " _(recovered from prose)_" : ""}`,
        ),
      );
    }
    if (report.seams?.length) {
      reachLines.push(
        ...report.seams.map(
          (entry) =>
            `- ${entry.read ? "👁️" : "⚠️"} \`${entry.file}\` — written by ${
              entry.tasks.length ? entry.tasks.map((id) => `#${id}`).join(", ") : "two or more lanes"
            }${entry.read ? (entry.note ? `: ${entry.note}` : "") : " — **not opened by this review**"}`,
        ),
      );
    }
    lines.push(
      "",
      details({
        summary: `<b>Reach — ${counts.unwired} unwired, ${counts.seams} lane seam(s)</b>`
          + (counts.seamsUnread ? ` &nbsp; — <b>${counts.seamsUnread} unread</b>` : ""),
        body: reachLines.join("\n"),
      }),
    );
  }

  // A review that returned no block has no count to give. `(0)` and `_No
  // findings._` under a criteria table that says `unknown` was the same
  // document contradicting itself (#142): the count is unknown, and says so.
  const unreviewed = report.status !== "ok" ? `unknown (review ${report.status})` : null;
  for (const axis of AXES) {
    const found = report.findings.filter((entry) => entry.axis === axis);
    const name = AXIS_NAME[axis] ?? axis;
    if (found.length === 0) {
      if (unreviewed) lines.push("", `### ${name} — ${unreviewed}`);
      else lines.push("", `### ${name} (0)`, "", "_No findings._");
      continue;
    }
    // `unknown` is only ever a finding recovered from prose (#142).
    const bySeverity = ["blocker", "major", "minor", "unknown"]
      .map((severity) => ({ severity, n: found.filter((entry) => entry.severity === severity).length }))
      .filter((entry) => entry.n);
    const blockers = found.filter((entry) => entry.severity === "blocker");
    lines.push(
      "",
      details({
        // Same rule as the criteria above: folded always, with the blockers
        // NAMED on the summary line. A blocker that needs a click is hidden;
        // a blocker whose title is in the summary is not, and costs one line
        // instead of the whole list.
        summary: (unreviewed
          ? `<b>${name} — ${unreviewed}; ${found.length} recovered from prose</b> &nbsp; `
          : `<b>${name} — ${found.length} finding(s)</b> &nbsp; `)
          + bySeverity.map((entry) => `${SEVERITY_MARK[entry.severity] ?? "·"} ${entry.n} ${entry.severity}`).join(" · ")
          + (blockers.length
            ? ` &nbsp; — <b>blocker:</b> ${blockers.map((entry) => entry.title).join("; ")}`
            : ""),
        body: found
          .map((entry) =>
            `- **${entry.severity}** — ${entry.title}${entry.file ? ` (\`${entry.file}\`)` : ""}${entry.recovered ? " _(recovered from prose)_" : ""}${entry.detail ? `\n  ${entry.detail}` : ""}${entry.howToShowItFails ? `\n  Shows it fails: ${entry.howToShowItFails}` : ""}`,
          )
          .join("\n"),
      }),
    );
  }
  if (decision.notes.length > 0) {
    lines.push("", ...decision.notes.map((note) => `_Note: ${note}._`));
  }
  if (report.status !== "ok" && report.prose) {
    lines.push(
      "",
      "<details><summary>Raw review output (no structured block was returned)</summary>",
      "",
      report.prose.slice(0, 8000),
      "",
      "</details>",
    );
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

/**
 * The one-line report `afk verify` prints, matching the house `EPIC:` style.
 *
 * `currentHead` is the branch's HEAD at render time, passed in rather than
 * resolved here so this stays a pure function. When it differs from the commit
 * the review actually read, the outcome says so on its face: `afk finish`
 * printed a report eight commits old on epic #391 and the operator quoted a
 * blocker that had been deleted hours earlier. Omit it and nothing changes.
 */
export const renderVerifierOutcome = (report, currentHead = null) => {
  const decision = verifierDecision(report);
  const counts = report.counts ?? verifierReportCounts(report);
  const recordedHead = report.head ?? null;
  const isStale = Boolean(currentHead && recordedHead && currentHead !== recordedHead);
  return [
    `VERIFY: ${report.status} — recommendation \`${decision.recommendation}\`.`,
    ...(isStale
      ? [
          `VERIFY: stale review — it read \`${recordedHead}\` at ${report.ranAt}, but the branch is now at \`${currentHead}\`. Re-run \`afk verify ${report.epic?.id ?? "<epic>"}\`.`,
        ]
      : []),
    `VERIFY: ${counts.criteria.met}/${counts.criteriaTotal} criteria met, ${counts.findingsTotal} findings (${counts.findings.blocker} blocker), ${counts.mustFix} must-fix.`,
    ...(report.skipped ?? []).map(
      (entry) => `VERIFY: gate not run — \`${entry.tool}\`${entry.reason ? `: ${entry.reason}` : ""}`,
    ),
    ...decision.blocking.map((item) => `VERIFY: blocking — ${item}`),
    ...decision.notes.map((note) => `VERIFY: ${note}`),
    "VERIFY: advisory only. This does not mark the epic complete; nothing here changes run state.",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Seam 3 — running it
// ---------------------------------------------------------------------------

export const verifierDir = (root, epicId) =>
  resolve(root, ".afk", "verifier", String(epicId));
export const verifierReportPath = (root, epicId) =>
  resolve(verifierDir(root, epicId), "report.json");

/**
 * Where the verifier agent is asked to write its fenced report.
 *
 * Not under `.afk/`: the agent runs in a disposable detached checkout and the
 * project's own tree is outside every `allowWrite` entry its sandbox enforces
 * (scripts/roles.mjs, `verifier.permissions`). `/tmp` is one of the three paths
 * that profile does grant, and it is the same on every host the runner runs on
 * — `os.tmpdir()` on macOS is a per-user `/var/folders/**` path the sandbox
 * does not name. The runner copies the content back and removes the file.
 *
 * Per RUN, not per epic. Whatever sits at this path becomes the verdict, so a
 * fixed `/tmp/afk-verifier/<epicId>/report.md` is a path any local user can
 * write and two runs of one epic id — which `afk epic --worktree` makes
 * ordinary — collide on. The uid segment keeps one user's runs out of another's
 * directory, the uuid keeps a run out of its own earlier one, and `runVerifier`
 * chmods the directory to 0700 and removes it when the review is parsed.
 */
export const verifierScratchReportPath = (epicId) =>
  resolve(
    "/tmp",
    `afk-verifier-${process.getuid?.() ?? "user"}`,
    `${String(epicId ?? "epic")}-${randomUUID().slice(0, 8)}`,
    "report.md",
  );

// The mark `prompts/verifier.md` carries for that path. Not a `{{...}}`
// template mark: the value set for this role's marks is assembled in
// scripts/roles.mjs `verifierPrompt`, and `render` blanks any mark that set
// does not name — so a `{{reportPath}}` would be erased before this module
// could fill it. Substituted after `rolePrompt` returns, on the rendered text.
export const VERIFIER_REPORT_PATH_MARK = "@@AFK_REPORT_PATH@@";

// The reviewer's memory (#228): the previous review's findings and every fate
// recorded with `afk fate`, filled the same way as the report path. A project
// prompt without the mark gets the block appended.
export const VERIFIER_PRIOR_FINDINGS_MARK = "@@AFK_PRIOR_FINDINGS@@";

/**
 * The prior-findings section of the reviewer's prompt: each finding of the
 * last closeout review, and each fated one from the ledger, with its id, its
 * fate and the review it was fated at. Review stays whole-branch; this list
 * only stops a decided finding coming back unchanged. On #545 about six of 17
 * must-fix items were findings already decided.
 */
export const renderPriorFindings = ({ previous = null, ledger = { fates: new Map(), problems: [] } }) => {
  const rows = new Map();
  const add = (title, from) => {
    if (!title) return;
    const id = findingId(title);
    if (!rows.has(id)) rows.set(id, { id, title: String(title), from });
  };
  const reviewed = previous?.head ? String(previous.head).slice(0, 12) : null;
  for (const line of previous?.mustFix ?? []) add(line, reviewed);
  for (const finding of previous?.findings ?? []) add(finding?.title, reviewed);
  for (const entry of ledger.fates.values()) add(entry.title, entry.reviewHead ? String(entry.reviewHead).slice(0, 12) : null);
  if (!rows.size && !ledger.problems.length) return "Previous closeout findings: none. This is the first closeout review of this epic, or no earlier review left a finding.";
  const lines = [...rows.values()].map((row) => {
    const fate = ledger.fates.get(row.id);
    const at = fate?.reviewHead ? String(fate.reviewHead).slice(0, 12) : row.from;
    const head = `- ${row.id} — ${describeFate(fate)}${at ? ` (review ${at})` : ""}: ${row.title}`;
    return fate?.reason ? `${head}\n  reason: ${fate.reason}` : head;
  });
  return [
    "Previous closeout findings for this epic, with the fate each was given by `afk fate` (accepted, fixed or dropped, by the owner or the chief of staff):",
    "",
    ...lines,
    ...ledger.problems.map((problem) => `- (${problem}; treat the findings it held as unfated)`),
    "",
    "You must not raise a fated finding again unless the lines it names changed since the review it was fated at: check with `git diff <that review>..HEAD -- <file>`. If they changed and the problem is still there, raise it with a fresh one-line wording that says what changed, and quote the changed hunk in `detail`. A finding listed with no fate may be raised again if it still holds. Review the whole branch as before; this list is not your scope and is not a reason to skip any other code.",
  ].join("\n");
};

/**
 * A previously written report, or null. This is what makes `runVerifier`
 * idempotent across a restart: `.afk/` outlives the process, so a caller that
 * closes an epic twice does not pay for two reviews.
 */
export const readVerifierReport = (root, epicId) => {
  const path = verifierReportPath(root, epicId);
  if (!existsSync(path)) return null;
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    return report?.version === VERIFIER_REPORT_VERSION ? report : null;
  } catch {
    return null;
  }
};

/**
 * The verifier's permission profile as a `--settings` payload.
 *
 * Kept as a named export for this module's tests; `settingsArg` in
 * scripts/roles.mjs now renders the whole profile for any role whose sandbox
 * names no cwd, which is every read-only role. Lane H and Lane G had each
 * written this same workaround locally before that rule existed.
 */
export const verifierSettingsArg = (role, config = null) => settingsArg(role, config);

/**
 * The effective agent invocation. `roleAgent` deliberately does not know about
 * `permissions.bypassPermissions`; applying it here keeps the implementer's and
 * integrator's command lines byte-identical to what Lane F shipped, which was
 * the whole point of that refactor.
 */
export const verifierAgent = (role, config) => ({
  ...roleAgent(role, config),
  bypassPermissions: role.permissions.bypassPermissions ?? true,
  permissionMode: "default",
  settings: verifierSettingsArg(role, config),
});

/**
 * The filesystem boundary this role's Codex command needs, and the scratch
 * directory it must be able to write.
 *
 * `prompts/verifier.md` tells the agent that the report path is writable and to
 * write it with a heredoc; nothing enforced that under Codex, where the role
 * renders to `--sandbox read-only` and can write nothing at all — so every
 * `afk-codex` closeout lost the file channel and fell back to harvesting the
 * final prose, which AGENTS.md records as the failure that reads as clean.
 *
 * Two parts, and the second is what makes the first safe:
 *
 *   - the scratch directory holding the report is passed as `--add-dir`, the
 *     one narrow path beyond the workspace this role needs.
 *   - the sandbox is `workspace-write` ONLY when the agent got its disposable
 *     checkout. That checkout is the cap (see below): it is thrown away when
 *     the review ends and nothing in it is ever committed, so writing there is
 *     exactly what Claude Code already grants this role by granting its cwd.
 *     Without the checkout the cwd is the project this role is gating, and the
 *     sandbox stays `read-only` — a lost report is recoverable, a verifier that
 *     edits the branch it is reviewing is not.
 *
 * Claude's command builder ignores `addDirs`, so this changes nothing there.
 */
export const verifierSpawnPlan = ({ agent, cwd, reportPath = null, backend = undefined }) => {
  const scratchDir = reportPath ? dirname(reportPath) : null;
  // Same source `buildAgentCommand` reads, so the plan and the command line
  // cannot disagree about which CLI is being built.
  const codex = (backend ?? agent.backend ?? DEFAULT_BACKEND) === "codex";
  return {
    agent: codex && cwd ? { ...agent, sandbox: "workspace-write" } : agent,
    addDirs: scratchDir ? [scratchDir] : [],
  };
};

/**
 * Spawn the verifier agent. The default `runAgent` for `runVerifier`; every test
 * injects its own, so no test in this repo can reach a model.
 */
export const spawnVerifier = async ({ root, agent, promptPath, streamPath, epicId, branch = null, setup = null, reportPath = null, backend = undefined, resume = null, keepCwd = false }) => {
  const role = roleFor("verifier");
  // The agent runs in a disposable checkout, not the project (scripts/worktree.mjs
  // `roleCwd`). Its cwd is the one directory Claude Code grants unconditionally,
  // so the cwd is what decides whether this role can write the branch it gates.
  // Resolved BEFORE the command is built, because Codex takes the same boundary
  // from `--cd` and would otherwise be pointed at the project it is reviewing.
  const key = verifierCwdKey(epicId);
  // `resume` is the nudge (`endsWaiting`). It runs in the checkout the first
  // session left behind (`keepCwd`), so the session resumes where it ran and
  // no `worktreeSetup` is paid twice. Recreated only if that checkout is gone.
  const kept = resume && branch && existsSync(roleCwd(root, key)) ? roleCwd(root, key) : null;
  const cwd = kept ?? (branch ? createRoleCwd({ root, key, ref: branch, setup }) : null);
  const plan = verifierSpawnPlan({ agent, cwd, reportPath, backend });
  const command = buildAgentCommand(resume ? { ...plan.agent, resume } : plan.agent, {
    nodeBin: process.execPath.replace(/\/node$/, ""),
    promptPath,
    streamPath,
    taskId: `verify-${epicId}`,
    processName: role.processName(epicId),
    cwd: cwd ?? root,
    addDirs: plan.addDirs,
  });
  if (!cwd) {
    // Said out loud, because the review still runs and the reader deserves to
    // know it ran with the weaker cap. Silence here would be the exact failure
    // docs/findings.md keeps warning about: "nothing happened" read as "it held".
    process.stderr.write(
      `VERIFY: no disposable checkout${branch ? ` of ${branch}` : " (no branch known)"} — reviewing from the project root, where this role can write what it is gating.\n`,
    );
  }
  try {
    return await runAsync(command, { cwd: cwd ?? root, timeout: plan.agent.timeoutMs });
  } finally {
    if (cwd && !keepCwd) removeRoleCwd({ root, key });
  }
};

/** The role-cwd key `spawnVerifier` runs one epic's review under. */
export const verifierCwdKey = (epicId) => `verify-${epicId}`;

/**
 * One run of the project's `reachReport` command, in a throwaway checkout of
 * `ref`, as a parsed knip payload — or `null`.
 *
 * Why a checkout rather than the project root: the answer is a set-diff over
 * two commits, and the base payload can only be produced by a tree that IS the
 * base. The runner is the only participant that can make one. The closeout
 * reviewer cannot: it already runs in a disposable detached worktree whose
 * `node_modules` is a symlink into the main checkout, readable but outside the
 * sandbox's writable roots — every closeout on atlas-workspace since
 * 2026-09-09 reports its tests skipped for exactly that (`EPERM` writing
 * `node_modules/.vite-temp`), and `git worktree add` from in there would write
 * to a `.git` it may not touch either. So this is the same shape as
 * `keptOutsideDeclaredPaths`: computed where the tooling exists, read later by
 * the axis.
 *
 * `setup` is the project's own `worktreeSetup`, so the checkout gets whatever a
 * lane gets — on atlas-workspace that is the `node_modules` symlink the command
 * needs to resolve `knip` at all.
 */
const reachReportAt = ({ root, key, ref, command, setup, timeout }) => {
  let cwd = null;
  try {
    cwd = createRoleCwd({ root, key, ref, setup });
    if (!cwd) return null;
    // The status is deliberately ignored: knip exits non-zero whenever it finds
    // an unused export, which on a red baseline is every run. `parseKnipReport`
    // answering null is the only failure signal this needs.
    return parseKnipReport(run(command, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }).stdout);
  } catch {
    return null;
  } finally {
    // Unconditionally, including the `createRoleCwd === null` path: a setup hook
    // that threw leaves the worktree added, and `removeRoleCwd` never throws.
    removeRoleCwd({ root, key });
  }
};

// Two of these run per closeout, back to back, and each is a whole static
// analysis of the project. Bounded well above knip's ~1 min on atlas-workspace
// and well below the closeout review it sits inside, because the failure to
// avoid is the six-hour stall, not a slow tool.
const REACH_REPORT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The Reach axis's evidence for one epic — the only impure thing in this axis.
 *
 * Three of the four lists in scripts/reach.mjs are computable from artifacts the
 * runner already holds: the branch's own log, the git note each lane left, and
 * the `allowedPaths` on the DAG. The fourth, `newUnusedExports`, needs two runs
 * of a project-specific tool at two commits, so it is opt-in: a project that
 * sets `reachReport` in `.afk-setup/config.yaml` to a command printing a
 * `knip --reporter json` payload gets `unwired` computed here, and one that does
 * not gets `null` — which the prompt states as an absence, and Step 1c in
 * prompts/verifier.md then falls back to grep for.
 *
 * The base is the MERGE-BASE, not the base branch's tip. A branch cut a week
 * ago is being compared against what it was cut from; anything merged into the
 * base since is neither this epic's doing nor its business, and reading the tip
 * would quietly excuse an export this epic added that landed on the base too.
 *
 * **Never throws**, matching `runVerifier`'s own contract: a closeout must not
 * die because the log could not be read. `null` is the answer when it could
 * not, and the prompt renders that as an absence rather than as "none found".
 */
export const collectReach = ({ root, branch, baseBranch = "main", dag = { tasks: [] }, config = {} }) => {
  if (!branch) return null;
  try {
    const log = run(
      `git log --format=%s --name-only ${shellQuote(baseBranch)}..${shellQuote(branch)}`,
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    if (log.status !== 0) return null;
    const byTask = filesByTask(log.stdout);
    const seams = seamFiles(log.stdout);
    const verifications = {};
    const untouched = [];
    for (const task of dag.tasks ?? []) {
      const verification = readLaneVerification(root, task.id, taskBranch(task.id));
      if (verification) verifications[task.id] = verification;
      const files = byTask.get(String(task.id)) ?? [];
      // No attributed files means this lane never committed, not that it
      // declared scope it did not use — every glob would be "untouched", which
      // is noise, not a finding.
      if (files.length === 0) continue;
      const paths = untouchedAllowed(task.allowedPaths ?? [], files);
      if (paths.length) untouched.push({ taskId: String(task.id), paths });
    }
    return {
      seams,
      undeclaredWrites: undeclaredWrites(verifications),
      untouchedAllowed: untouched,
      unwired: collectUnwired({ root, branch, baseBranch, dag, config }),
    };
  } catch {
    return null;
  }
};

/**
 * `newUnusedExports` over the project's own tool at the merge-base and at head.
 *
 * `null` on every path that is not a real answer — no command declared, no
 * merge-base, either payload missing. Only two payloads that both parsed can
 * produce a list, because a missing base reads as "knip found nothing there"
 * and would charge this epic with every unused export the repository already
 * had (495 of them on atlas-workspace).
 */
const collectUnwired = ({ root, branch, baseBranch, dag, config }) => {
  const command = config?.reachReport;
  if (!command) return null;
  const mergeBase = run(
    `git merge-base ${shellQuote(baseBranch)} ${shellQuote(branch)}`,
    { cwd: root },
  );
  if (mergeBase.status !== 0) return null;
  const epicId = normalizeId(dag?.epic?.id ?? null) ?? "epic";
  const at = (key, ref) =>
    reachReportAt({
      root,
      key: `reach-${key}-${epicId}`,
      ref,
      command,
      setup: config?.worktreeSetup,
      timeout: REACH_REPORT_TIMEOUT_MS,
    });
  const base = at("base", mergeBase.stdout.trim());
  const head = at("head", branch);
  if (!base || !head) return null;
  return newUnusedExports(base, head);
};

// ---------------------------------------------------------------------------
// The one nudge, for a transcript that ended waiting
// ---------------------------------------------------------------------------
//
// On #878 and #896 the verifier's last message was "The waiter is armed. I'll
// pick up the test summary when it fires." and "Still running. I'll check again
// when it finishes." Nothing wakes a `-p` session once it ends its turn, so the
// runner harvested a promise as the final report. prompts/verifier.md asks for
// the foreground; this is the harness-side half, for when that is not followed.

// Waiting on a COMMAND: something is running and the agent means to come back.
const WAITING_RE = new RegExp(
  [
    String.raw`\bstill (?:running|executing|in progress)\b`,
    String.raw`\b(?:is|are) (?:still |now )?(?:running|executing)\b`,
    String.raw`\bwaiter is armed\b`,
    String.raw`\blet me wait\b`,
    String.raw`\bwait(?:ing)? (?:for|on|until) (?:the |it |them |this )?(?:build|suite|tests?|run|command|job|process|checks?|gates?|script|output|results?|summary|lint|typecheck|compile)`,
    String.raw`\b(?:I'll|I will|will)\b[^.]{0,80}\b(?:once|when|after) (?:it|they|this|that|the \w+) (?:fires?|finish(?:es)?|completes?|returns?|(?:is|are) done)\b`,
  ].join("|"),
  "i",
);
// Waiting on a PERSON, or saying nothing is running, is a finished review.
const NOT_WAITING_RE = /\bnothing (?:is )?(?:still )?running\b|\bwaiting (?:on|for) (?:a |the )?(?:human|person|reviewer|sign-?off)|\bsign-?off\b/i;

/** True when the transcript's LAST message is a wait on a command, not a report. */
export const endsWaiting = (raw) => {
  const last = finalText(String(raw ?? ""));
  return Boolean(last) && WAITING_RE.test(last) && !NOT_WAITING_RE.test(last) && !lastJsonBlock(last);
};

/**
 * The nudge's own bound. The first session already did the review; the nudge
 * only has to re-run what it was waiting on and write the report, so it gets
 * ten minutes — or the role's own timeout, if that is shorter.
 */
export const VERIFIER_NUDGE_TIMEOUT_MS = 10 * 60 * 1000;

// Moved to agent-stats.mjs so the builder's checklist continuation can share it.
export { sessionIdOf };

export const verifierNudge = (reportPath) =>
  [
    "Your last message said you were waiting on a background command. Nothing will wake this session when it finishes: once this turn ends, what you have said is harvested as your review.",
    "",
    "Finish in the foreground of THIS turn. Run whatever you were waiting on again, in the foreground, and wait for it here. Start nothing in the background.",
    "",
    `Then write the report now: the fenced \`json\` block to ${reportPath}, and the same block as the last thing in your final message. If a check still cannot finish, say so in \`skipped\` and write the report anyway.`,
  ].join("\n");

/**
 * Run the epic's closeout review and write the structured report.
 *
 * Idempotent in two senses. It writes only under `.afk/verifier/<epic>/`, so
 * calling it twice cannot corrupt anything; and with `reuse: true` it returns
 * the report already on disk without spawning an agent, so an epic-close that
 * happens twice across a restart costs one review.
 *
 * `reuse` is keyed on the reviewed COMMIT, not on the file existing. Epic #23
 * closed three times: the first two failed and reviewed an empty branch, the
 * third built both tasks and merged them — and reused the first review, so "the
 * epic delivered nothing" was posted onto a pull request that had delivered
 * everything. A cached artifact is valid for the tree it described and for no
 * other; existence is not that test.
 *
 * **Never throws.** A caller closing an epic must not die because a review did;
 * the failure arrives as `status` and `problems`, exactly as `parseVerifierOutput`
 * describes. That is the same contract scripts/pr.mjs holds for the draft PR,
 * and the opposite of `fetchEpic`, which aborts because the DAG is an input.
 *
 * @param {object} args
 * @param {string} args.root project root
 * @param {object} args.config .afk-setup/config.yaml
 * @param {{tasks: object[], epic?: object, branch?: string}} args.dag in-memory DAG
 * @param {string|null} args.epicBody epic issue body, when the caller has it
 * @param {string} args.baseBranch the fixed point to review against
 * @param {string[]} args.outstanding what the epic still owed when this ran
 * @param {boolean} args.reuse return an existing report instead of re-reviewing
 * @param {Function} args.runAgent injected spawn seam
 * @returns {Promise<object>} the report
 */
export const runVerifier = async ({
  root,
  config,
  dag = { tasks: [] },
  epicBody = null,
  branch = null,
  baseBranch = "main",
  outstanding = [],
  reuse = false,
  ranAt = null,
  scratchReportPath = null,
  runAgent = spawnVerifier,
}) => {
  const epic = {
    id: normalizeId(dag.epic?.id ?? null),
    title: dag.epic?.title ?? null,
  };
  const featureBranch = branch ?? dag.branch ?? null;
  const head = headSha(root);
  if (reuse) {
    const existing = readVerifierReport(root, epic.id);
    // One rule: the commit then must equal the commit now. Two consequences
    // worth naming, because both are deliberate —
    //   - a report written before `head` existed has null, a live checkout has
    //     a sha, so it does not match and is re-reviewed. Re-reviewing costs a
    //     session; trusting a stale review costs a wrong verdict on the thing a
    //     human is about to merge.
    //   - outside a git repository both sides are null, which matches. Nothing
    //     can have moved, so there is nothing to invalidate.
    // `reused` tells the caller no agent ran this time (the supervisor's cache
    // says the same), so nothing it recorded is announced again.
    if (existing && (existing.head ?? null) === (head ?? null)) return { ...existing, reused: true };
  }

  const criteria = extractAcceptanceCriteria(dag, epicBody);
  // Held, not inlined into the prompt call: the same evidence goes to the model
  // as prose AND to `parseVerifierOutput` as the computed `unwired` list, and
  // collecting it twice would run the project's tool four times.
  const reach = collectReach({ root, branch: featureBranch, baseBranch, dag, config });
  const role = roleFor("verifier");
  const dir = verifierDir(root, epic.id);
  ensureDir(dir);
  const promptPath = resolve(dir, "prompt.md");
  const streamPath = resolve(dir, "stream.jsonl");
  // A caller-supplied path is the caller's to clean up; only the one this
  // module derived is removed with its directory below.
  const derivedScratch = !scratchReportPath;
  const reportPath = scratchReportPath ?? verifierScratchReportPath(epic.id);
  // Read before this review overwrites the report it replaces.
  const priorFindings = renderPriorFindings({ previous: readVerifierReport(root, epic.id), ledger: readFates(root, epic.id) });
  const withPrior = (text) => (text.includes(VERIFIER_PRIOR_FINDINGS_MARK)
    ? text.replaceAll(VERIFIER_PRIOR_FINDINGS_MARK, priorFindings)
    : `${text.trimEnd()}\n\n${priorFindings}\n`);
  atomicWrite(
    promptPath,
    withPrior(rolePrompt(role, config, {
      epic,
      epicBody,
      branch: featureBranch,
      baseBranch,
      criteria,
      tasks: dag.tasks ?? [],
      checks: config?.defaultChecks ?? [],
      schema: VERIFIER_JSON_SCHEMA,
      reach,
    }).replaceAll(VERIFIER_REPORT_PATH_MARK, reportPath)),
  );
  // A stale transcript from a previous run would be read as this run's, and the
  // auth check below reads it. Remove it before the agent starts, not after.
  rmSync(streamPath, { force: true });
  // Same rule for the scratch report, and it matters more: a leftover file is a
  // whole previous verdict, and preferring the file over the prose would make
  // this run report the last run's review.
  rmSync(reportPath, { force: true });
  ensureDir(dirname(reportPath));
  // The report becomes the verdict, so nobody else on the host gets to write it.
  if (derivedScratch) chmodSync(dirname(reportPath), 0o700);

  const agent = verifierAgent(role, config);
  const startedAt = Date.now();
  const spawnArgs = {
    root,
    agent,
    // Kept for the nudge, if one is needed, and removed below if not.
    keepCwd: true,
    promptPath,
    streamPath,
    epicId: epic.id,
    branch: featureBranch,
    setup: config.worktreeSetup,
    // The path prompts/verifier.md tells the agent to write. Under Codex it
    // is only writable because the spawn grants it.
    reportPath,
  };
  const spawnAndRead = async (args) => {
    let outcome;
    try {
      outcome = await runAgent(args);
    } catch (error) {
      outcome = { status: 1, timedOut: false, stderr: error.message };
    }
    try {
      return { result: outcome, raw: readFileSync(args.streamPath, "utf8") };
    } catch {
      return { result: outcome, raw: `${outcome?.stdout ?? ""}${outcome?.stderr ?? ""}` };
    }
  };
  let { result, raw } = await spawnAndRead(spawnArgs);
  // One nudge, never two: a session that answers a nudge with another wait is
  // harvested as it stands. It resumes the SAME session, so the agent keeps
  // everything it already read; a stream with no session id to resume (Codex)
  // is harvested as it stands too, and the report says so. Fails open either
  // way — a review is never lost for want of a nudge.
  let nudge = null;
  // A report already in hand, by either channel, is never nudged: the wait is
  // then chatter after the answer, and a nudge would buy a second session.
  const alreadyReported = () => {
    let scratch = "";
    try {
      scratch = readFileSync(reportPath, "utf8");
    } catch { /* nothing written */ }
    // A REVIEW, not any fenced JSON: a quoted verification.json parses too.
    return [lastJsonBlock(scratch) ?? wholeJsonObject(scratch), lastJsonBlock(reportText(raw))].some(looksLikeReview);
  };
  let cwdHeld = true;
  if (result?.status === 0 && !result?.timedOut && endsWaiting(raw) && !alreadyReported()) {
    const sessionId = sessionIdOf(raw);
    if (!sessionId) {
      nudge = { sent: false, reason: "no session id in the transcript to resume" };
    } else {
      const nudgePromptPath = resolve(dir, "nudge.md");
      const nudgeStreamPath = resolve(dir, "stream-nudge.jsonl");
      atomicWrite(nudgePromptPath, `${verifierNudge(reportPath)}\n`);
      rmSync(nudgeStreamPath, { force: true });
      const second = await spawnAndRead({
        ...spawnArgs,
        agent: { ...agent, timeoutMs: Math.min(agent.timeoutMs ?? Infinity, VERIFIER_NUDGE_TIMEOUT_MS) },
        promptPath: nudgePromptPath,
        streamPath: nudgeStreamPath,
        resume: sessionId,
        keepCwd: false,
      });
      cwdHeld = false;
      const status = second.result?.status ?? 1;
      const timedOut = Boolean(second.result?.timedOut);
      // A nudge that died adds nothing and must not take the first session's
      // review down with it: an auth death in its stream would otherwise turn
      // the whole report `auth_failed`. Its transcript stays on disk.
      const problem = timedOut
        ? `the nudge timed out after ${Math.round(Math.min(agent.timeoutMs ?? Infinity, VERIFIER_NUDGE_TIMEOUT_MS) / 1000)}s (exit ${status})`
        : looksLikeAuthDeath(second.raw)
          ? `the nudge exited ${status}: the claude login expired`
          : status !== 0
            ? `the nudge exited ${status}`
            : null;
      if (problem) nudge = { sent: true, status, ...(timedOut ? { timedOut } : {}), problem };
      else {
        raw = `${raw}\n${second.raw}`;
        nudge = { sent: true, status };
      }
    }
  }
  // The default spawn keeps its checkout for a nudge that did not happen.
  if (cwdHeld && runAgent === spawnVerifier && featureBranch) removeRoleCwd({ root, key: verifierCwdKey(epic.id) });
  const durationMs = Date.now() - startedAt;
  const text = reportText(raw) || raw;
  atomicWrite(resolve(dir, "review.md"), `${text}\n`);
  // Copied back under `.afk/` before the scratch copy goes, so the artifact a
  // human reads is the one the agent actually handed over.
  let fileText = "";
  try {
    fileText = readFileSync(reportPath, "utf8");
  } catch {
    fileText = "";
  }
  if (fileText) atomicWrite(resolve(dir, "report-block.md"), fileText);
  rmSync(reportPath, { force: true });
  if (derivedScratch) rmSync(dirname(reportPath), { recursive: true, force: true });

  const report = parseVerifierOutput({
    head,
    text,
    file: fileText,
    raw,
    criteria,
    agentStatus: result?.status ?? 1,
    timedOut: Boolean(result?.timedOut),
    meta: {
      epic,
      // The project, for resolving a `.afk-runs/**.json` the review cited as
      // evidence. Not written into the report — only read while parsing.
      root,
      branch: featureBranch,
      baseBranch,
      // Present only here, never in the pure parse tests: it is what makes the
      // channel line say a path rather than "a file, somewhere".
      reportPath,
      // The Reach axis's one computed list, when the project declared the
      // command that produces it. `null` leaves the model's grep in place.
      unwired: reach?.unwired ?? null,
      // Used only when no block arrived; see the `unparseable` branch.
      seams: reach?.seams ?? null,
      ranAt: ranAt ?? new Date(startedAt).toISOString(),
      durationMs,
      outstanding,
      artifacts: {
        prompt: promptPath,
        stream: streamPath,
        review: resolve(dir, "review.md"),
        report: verifierReportPath(root, epic.id),
      },
    },
  });
  if (nudge) {
    report.nudge = nudge;
    if (!nudge.sent)
      report.problems.push(`the review ended waiting on a background command and could not be nudged (${nudge.reason}); harvested as it stood`);
    else if (nudge.problem)
      report.problems.push(`the review ended waiting on a background command; ${nudge.problem}, so the first session's review is kept as it stood`);
  }
  // Which model(s) answered this review; scripts/model-check.mjs.
  report.modelCheck = modelCheck(raw);
  atomicWrite(verifierReportPath(root, epic.id), `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(resolve(dir, "report.md"), renderVerifierMarkdown(report));
  return report;
};

// ---------------------------------------------------------------------------
// CLI — `afk verify <issue>`
// ---------------------------------------------------------------------------
//
// A hand-runnable surface, because there is no epic-close event to hang off yet.
// It re-fetches the epic exactly the way `afk validate` does, so it needs no
// local copy of the spec and inherits refuse-on-nonsense for free.

const usage = `Usage:
  node scripts/verifier.mjs <issue> [--repo=<owner/name>] [--base=<branch>]
                                    [--reuse] [--json] [--markdown] [--full]`;

// A closeout review is hundreds of lines, and printing it whole floods the
// session that called `afk verify` for one verdict. The head carries the
// verdict, so keep the head and say what was cut — naming the flag, because a
// truncation the reader cannot undo is just a shorter report. `--json` is
// exempt: that path is parsed, not read.
export const REPORT_LINE_BUDGET = 60;

export const truncateReport = (
  text,
  { full = false, budget = REPORT_LINE_BUDGET } = {},
) => {
  const body = String(text ?? "");
  const lines = body.split("\n");
  if (full || lines.length <= budget) return body;
  return [
    ...lines.slice(0, budget),
    "",
    `VERIFY: ${lines.length - budget} more lines withheld of ${lines.length} — pass --full to print the whole report.`,
  ].join("\n");
};

const cli = async () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    if (hit !== undefined) return hit.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at !== -1 && args[at + 1] && !args[at + 1].startsWith("--")) return args[at + 1];
    return null;
  };
  const root = process.cwd();
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const number = normalizeId(String(positional[0] ?? "").replace(/^#/, ""));
  if (!/^\d+$/.test(number ?? "")) {
    console.error(usage);
    return 1;
  }
  if (!existsSync(configPath(root))) {
    console.error(
      `VERIFY: no .afk-setup/config.yaml at ${configPath(root)} — it says how this stack is verified and the runner will not guess.`,
    );
    return 1;
  }
  const config = loadConfig(root);
  const repoFlag = flag("repo");
  const repo =
    repoFlag ??
    currentRepo(root) ?? "";
  if (!repo) {
    console.error("VERIFY: cannot tell which repository this is. Pass --repo=<owner/name>.");
    return 1;
  }
  const baseBranch = flag("base") || "main";

  const { fetchEpic, epicToDag } = await import("./epic.mjs");
  const { parseEpicBlock } = await import("./epic-spec.mjs");
  const fetched = fetchEpic({ repo, number });
  const spec = parseEpicBlock(fetched.body ?? "");
  const dag = epicToDag(spec, fetched.children ?? [], config, fetched);

  const report = await runVerifier({
    root,
    config,
    dag,
    epicBody: fetched.body ?? "",
    branch: dag.branch,
    baseBranch,
    reuse: args.includes("--reuse"),
  });
  const full = args.includes("--full");
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (args.includes("--markdown"))
    console.log(truncateReport(renderVerifierMarkdown(report), { full }));
  else console.log(truncateReport(renderVerifierOutcome(report), { full }));
  // Exit code reports whether a REVIEW was obtained, never whether the epic is
  // good. `must-fix` exits 0: the review succeeded, and turning a finding into a
  // non-zero exit would be this module deciding an outcome it does not own.
  return report.status === "ok" ? 0 : 1;
};

// Not a top-level await: scripts/epic.mjs documents at length why one deadlocks
// a dynamic import in this repo, and this file dynamically imports epic.mjs.
if (isMainModule(import.meta.url)) {
  cli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`VERIFY: ${error.message}`);
      process.exitCode = 1;
    });
}
