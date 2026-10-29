// scripts/fixer.mjs — the bounded fixer the verifier's report earns.
//
// docs/epic-schema.md, "Rejected: librarian", rejected an agent that RENDERS the
// verifier's report (templating, so the runner does it in code) and named what
// that forwent: "a bounded fixer — a fresh agent handed an explicit must-fix
// list with its own retry limit. Must-fix items instead land on the epic
// closeout for the human." This is that agent, and it is deliberately not the
// rejected one:
//
//   - it renders nothing and writes to no issue or pull request; the runner
//     still owns every word that reaches GitHub.
//   - it does not review its own work. The verifier judged, this fixes, and the
//     two are separate agents with separate permissions — so the safety
//     property the rejection protected ("a reviewer that can write to what it
//     gates is honor-system") is intact. What it gates, it did not judge.
//   - it is ADVISORY in the same sense the verifier is: it cannot change the
//     epic's outcome, cannot mark anything passed, and cannot halt the run.
//
// Bounded means bounded: ONE attempt. A fixer that retried would be a second
// agent editing a merged branch nobody has read yet, and the failure mode it
// protects against — a finding that is simply wrong — does not get better on a
// second pass. What it cannot fix is `deferred` with a reason, which is exactly
// the list that used to be the whole closeout.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWrite, buildAgentCommand, CHECK_TIMEOUT_EXIT_CODE, withTimeBudget, checkFailed, details, ensureDir, headSha, isStatusFlushPath, lifecycleOf, normalizeId, onlyStatusFlushSince, runAsync } from "./lib.mjs";
import { reportText } from "./agent-stats.mjs";
import { modelCheck } from "./model-check.mjs";
import { recordGate } from "./measure.mjs";
import { withGateLock } from "./gate-lock.mjs";
import { roleAgent, roleFor, rolePrompt, settingsArg } from "./roles.mjs";
import { lastJsonBlock, readVerifierReport, verifierReportCounts } from "./verifier.mjs";
import { gitMetadataDirs, taskBranch } from "./worktree.mjs";

export const FIXER_REPORT_VERSION = 1;

export const FIXER_JSON_SCHEMA = `{
  "summary": "one paragraph, what you changed and what you left",
  "fixed": [{ "id": "F1", "detail": "what you changed and why it resolves it",
              "files": ["path/one.ts"],
              "duplicateOf": "F0 — optional, only if this IS another item restated",
              "lesson": { "class": "rule", "id": "<rule id>", "file": "<rule file>", "redOn": "<fixture path>" }
                     | { "class": "standard", "line": "<the line appended to the coding-standards doc>" }
                     | { "class": "none", "reason": "<one line>" } }],
  "deferred": [{ "id": "F2", "reason": "one line, why not",
                 "duplicateOf": "F1 — optional, only if this IS another item restated" }],
  "noLessonsHome": true  // optional — include only if this repo has no lessons home to add a rule to
}`;

// ---------------------------------------------------------------------------
// Seam 1 — the work list, derived from the verifier's report
// ---------------------------------------------------------------------------

/**
 * What this pass is asked to fix, as a numbered list with stable ids.
 *
 * Three sources, in the order a human would work them: the must-fix list the
 * verifier wrote by hand, then its blocker and major findings, then the
 * acceptance criteria it could not call met. `minor` findings are left out on
 * purpose — this runs on a branch that is already merged and already reviewed,
 * and a pass that also tidies is a pass nobody can read the diff of.
 *
 * `unknown` criteria are included ONLY as check-only items, and only when the
 * verifier's evidence says its sandbox could not run the check (#143) — see
 * `checkOnlyCriterion`. Every other `unknown` is a gap in the review that needs
 * a person or a device, and belongs in front of the human rather than in front
 * of an agent that would have to guess what "fixed" meant.
 *
 * A task that never passed contributes no criteria at all (#145): its feature
 * is not on this branch, and a fix pass that builds it anyway writes a lane's
 * worth of unreviewed code outside any lane's scope. #803's fixer hand-wrote
 * task 809's whole UI that way and shipped a regression. The task's branch is
 * named in the closeout instead (`unpassedLanes`).
 *
 * Pure, so the whole of "is there anything to do" is testable without a model.
 */
/** `path/to/file.ext:123`, wherever it hides — a `file` field or the prose. */
const FILE_LINE = /[\w./\\-]+\.[A-Za-z]\w*:\d+/;
/** Any file-ish token, so the prose key is not split by where the path was quoted. */
const FILE_REF = /[\w./\\-]+\.[A-Za-z]\w*(?::\d+)?/g;

/** file:line if anything in the entry carries one, else the bare `file` field. */
const targetKey = (item) => {
  const hit = `${item.file ?? ""} ${item.title ?? ""} ${item.detail ?? ""}`.match(FILE_LINE);
  return hit ? hit[0] : (pickString(item.file) ?? null);
};

/**
 * Two targets that can be the same defect: the same file, and at most one of
 * them pinned to a line. `a.ts:1` and `a.ts:9` are two defects; `a.ts` and
 * `a.ts:9` are one seen from a must-fix line and from a finding's `file` field.
 */
const compatibleTargets = (a, b) => {
  if (a === b) return true;
  const file = (t) => t.replace(/:\d+$/, "");
  return file(a) === file(b) && (a === file(a) || b === file(b));
};

/** The defect as words: no paths, no punctuation, no case. Never null. */
const textKey = (item) =>
  String(item.title ?? "")
    .replace(FILE_REF, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Collapse the same defect reported by three sources into one item.
 *
 * A defect routinely arrives as a must-fix line, a `major` finding and a
 * `partial` criterion, and counting it three times made "fixed 9 of 13" read as
 * three times the work it was. Two entries are the same defect when they name
 * the same `file:line` OR the same words with the paths stripped — either match
 * merges, because the must-fix line usually carries the location and the
 * criterion never does.
 *
 * The survivor keeps the first non-null detail and file and the UNION of the
 * sources, so the prompt still says every place the defect was raised.
 *
 * Its TITLE is the must-fix line whenever the defect was raised as one, however
 * much richer a finding's wording is. scripts/verifier.mjs renders
 * `report.mustFix` verbatim as `- [ ] <line>`, and scripts/auto.mjs ticks those
 * lines off by matching the fixed item's title against them — so the must-fix
 * title is the only one guaranteed to appear in the rendered markdown, and a
 * merge that replaced it silently stopped the closeout ticking. The titles it
 * displaced survive as `aliases`, which is what auto.mjs also matches on.
 */
const dedupeItems = (entries) => {
  const groups = [];
  const byKey = new Map();
  for (const entry of entries) {
    const target = targetKey(entry);
    const keys = [target, textKey(entry)].filter(Boolean);
    let group = keys.map((k) => byKey.get(k)).find(Boolean);
    // `textKey` strips every path, so two must-fix lines about different places
    // in the code key identically. Merging them loses the second `- [ ]` line.
    if (group && target && group.targets.size && ![...group.targets].some((t) => compatibleTargets(t, target)))
      group = null;
    if (!group) {
      const fresh = { ...entry, sources: [entry.source], variants: [entry], targets: new Set(target ? [target] : []) };
      groups.push(fresh);
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, fresh);
      continue;
    }
    group.sources.push(entry.source);
    group.detail = group.detail ?? entry.detail;
    group.file = group.file ?? entry.file;
    group.howToShowItFails = group.howToShowItFails ?? entry.howToShowItFails;
    // Check-only survives a merge only if every source was check-only: one
    // finding that needs a fix makes the whole item a fix.
    if (group.checkOnly && !entry.checkOnly) delete group.checkOnly;
    group.variants.push(entry);
    if (target) group.targets.add(target);
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, group);
  }
  const richness = (e) => (e.detail ? 2 : 0) + (e.file ? 1 : 0);
  return groups.map(({ variants, targets: _t, ...group }, index) => {
    const best =
      variants.find((v) => v.source === "must-fix")
      ?? variants.reduce((a, b) => (richness(b) > richness(a) ? b : a));
    const aliases = [...new Set(variants.map((v) => v.title).filter((t) => t && t !== best.title))];
    return {
      ...group,
      title: best.title,
      ...(aliases.length ? { aliases } : {}),
      id: `F${index + 1}`,
      source: group.sources.join("; "),
    };
  });
};

/**
 * The only severities this pass is allowed to queue. See `fixerItems` for why.
 * `unknown` is only ever a finding recovered from the prose of a review that
 * returned no block (scripts/verifier.mjs, `recoverFindingsFromProse`): the
 * prose did not say how bad it is, and dropping it as if it said minor is the
 * failure #142 describes.
 *
 * FAIL DIRECTION: OPEN. An ungraded finding is queued: a wrong one costs the
 * fixer one deferral with a reason, a dropped real one costs a defect nobody
 * is ever handed.
 */
const FIXABLE_SEVERITIES = new Set(["blocker", "major", "unknown"]);

/**
 * The review statuses the fix pass works from. `unparseable` is here because
 * its prose still carries findings and structured entries (#142); an
 * `agent_failed` or `auth_failed` transcript is a session that died.
 */
const FIXABLE_REVIEW = new Set(["ok", "unparseable"]);

// Evidence that names a person, or a thing the fixer cannot get to either.
// Phrases, not bare nouns: the subject of a test ("human-readable",
// "phone-number", "sign-in", "Visual regression") is not a person, and the
// review's own sandbox ("the sandbox", "this sandbox") is exactly what the
// fixer can get past — a vendor's sandbox is not.
const OUT_OF_REACH_RE = new RegExp(
  [
    // a person
    String.raw`\b(?:needs?|requires?|requiring|waits? (?:for|on)|waiting (?:for|on)) (?:a |an |the |some )?(?:human|person|people|reviewer|someone|manual|browser)\b(?!-)`,
    String.raw`\ba (?:human|person) (?:has|needs|must)\b`,
    String.raw`\bsign-?off\b`,
    String.raw`\bmanual(?:ly)? (?:check|test|testing|verification|step|qa|review)\b`,
    String.raw`\bby hand\b`,
    String.raw`\beyeball`,
    String.raw`\b(?:the |an? )?owner\b`,
    // a device
    String.raw`\b(?:physical|real) (?:device|phone|iphone|ipad|hardware|machine)\b`,
    String.raw`\b(?:needs?|requires?) (?:a |an )?(?:physical |real )?(?:device|iphone|ipad|phone)\b`,
    String.raw`\b(?:ios|ipados|android|watchos|macos) \d+(?:\.\d+)? (?:device|phone|hardware)\b`,
    String.raw`\bsimulator\b`,
    String.raw`\bemulator\b`,
    String.raw`\btestflight\b`,
    // a live system, a vendor, a signed build
    String.raw`\bproduction\b`,
    String.raw`\blive (?:db|database|data|webhooks?|environment|site|service)\b`,
    String.raw`\b(?:stripe|paypal|braintree|adyen|vendor|apple|google|payment[- ]provider)\b[^.;]{0,30}\bsandbox\b`,
    String.raw`\bsandbox (?:account|environment of)\b`,
    String.raw`\bpayment[- ]provider\b`,
    String.raw`\btest account\b`,
    String.raw`\bentitlements?\b`,
    String.raw`\bnotari[sz](?:ed|ation)\b`,
    String.raw`\bsigned build\b`,
    String.raw`\bcode[- ]?sign`,
    String.raw`\bcredentials?\b`,
    String.raw`\bsecrets?\b`,
    String.raw`\bapi[_ ]key\b`,
    String.raw`\bpublickey\b`,
    String.raw`\brate[- ]limited\b`,
    String.raw`\bstaging\b`,
    String.raw`\bdeployed\b`,
    String.raw`\bpreview url\b`,
    String.raw`\bnetwork access\b`,
    String.raw`\b(?:needs?|requires?|over) (?:the )?(?:network|internet)\b`,
    String.raw`\band network\b`,
  ].join("|"),
  "i",
);
// A secret named in the evidence ("needs STAGING_API_KEY") is a credential.
const SECRET_NAME_RE = /\b[A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET)\b/;

/**
 * An `unknown` criterion the fixer can settle by running its check (#143).
 *
 * Every `unknown` the verifier gave a reason for is queued as check-only,
 * UNLESS that reason names a person or a thing the fixer cannot get either:
 * a sign-off, a device, TestFlight or an owner, production, a vendor's
 * sandbox, a signed build, credentials, staging, the network. A match there
 * wins over any mention of the review's own sandbox. An `unknown` with no
 * evidence at all is a criterion the review never answered (an unparseable
 * review leaves every one that way), and handing those to the fixer would be
 * asking it to do the review.
 *
 * FAIL DIRECTION: OPEN. A wrong queue costs one fixer check that reports it
 * could not run; a wrong drop loses a teeth check nobody else will run. So
 * nothing has to prove it was the sandbox — only the drop needs words. Every
 * `unknown` left out is counted (`unqueuedUnknownCriteria`) on the outcome
 * line.
 */
export const checkOnlyCriterion = (criterion) => {
  if (criterion?.verdict !== "unknown") return false;
  const evidence = String(criterion.evidence ?? "").trim();
  return Boolean(evidence) && !OUT_OF_REACH_RE.test(evidence) && !SECRET_NAME_RE.test(evidence);
};

/** Task lifecycles that put the task's work on the run branch. */
const LANDED = new Set(["passed", "no-op"]);

/** The DAG's tasks that did not land, as ids. The fixer's `skipTasks`. */
export const unpassedTaskIds = (dag, state) =>
  (dag?.tasks ?? []).filter((task) => !LANDED.has(lifecycleOf(task, state))).map((task) => String(task.id));

/**
 * How many findings the severity filter above dropped on the floor.
 *
 * Not queueing them is the policy and stays the policy; reporting `0 left for
 * you` while six of them are open is the defect. The number is derived from the
 * verifier's own report so it cannot drift from what was actually filtered.
 */
export const neverQueuedFindings = (report) =>
  (report?.findings ?? []).filter((finding) => !FIXABLE_SEVERITIES.has(finding?.severity));

export const unqueuedFindings = (report) => neverQueuedFindings(report).length;

/**
 * `unknown` criteria the fix pass was never handed: every `unknown` that is not
 * check-only, plus a check-only one whose task never passed. The #143 count,
 * printed next to the never-queued minors.
 */
export const unqueuedUnknownCriteria = (report, { skipTasks = [] } = {}) => {
  const skip = new Set(skipTasks.map(String));
  return (report?.criteria ?? []).filter(
    (criterion) =>
      criterion?.verdict === "unknown" && (!checkOnlyCriterion(criterion) || skip.has(String(criterion.taskId))),
  ).length;
};

export const fixerItems = (report, { skipTasks = [] } = {}) => {
  if (!report || !FIXABLE_REVIEW.has(report.status)) return [];
  const skip = new Set(skipTasks.map(String));
  const entries = [];
  const push = (source, title, detail = null, file = null, howToShowItFails = null, extra = {}) =>
    entries.push({ id: null, source, title, detail, file, howToShowItFails, ...extra });
  // Only an `ok` review has a must-fix list; an `unparseable` one wrote none.
  if (report.status === "ok") for (const line of report.mustFix ?? []) push("must-fix", line);
  for (const finding of report.findings ?? []) {
    if (!FIXABLE_SEVERITIES.has(finding.severity)) continue;
    const recovered = finding.recovered ? ", recovered from prose" : "";
    push(`${finding.severity} finding (${finding.axis}${recovered})`, finding.title, finding.detail, finding.file, finding.howToShowItFails ?? null);
  }
  // On an `ok` review the verifier is told to put every unwired export in
  // `mustFix`, so these would restate it. On an `unparseable` one nothing did,
  // and #878's `StoredMarker` reached structure and still reached nobody.
  if (report.status !== "ok") {
    for (const entry of report.unwired ?? []) {
      push(
        `unwired export (reach${entry.recovered ? ", recovered from prose" : ""})`,
        `\`${entry.symbol}\` has no non-test caller`,
        "added by this epic and never called outside a test: wire it in or remove it",
        entry.file ?? null,
      );
    }
    // Same for the files two or more lanes wrote: with no block, nobody said
    // they read the merged result (#642).
    for (const seam of report.seams ?? []) {
      if (seam.read) continue;
      const by = seam.tasks?.length ? `, written by ${seam.tasks.map((id) => `#${id}`).join(" and ")},` : "";
      push(
        "unreviewed seam (reach)",
        `\`${seam.file}\`${by} was not reviewed after the merge`,
        "read the merged file: fix what the join broke, or defer it as already correct with what you checked",
        seam.file,
      );
    }
  }
  for (const criterion of report.criteria ?? []) {
    if (skip.has(String(criterion.taskId))) continue;
    if (checkOnlyCriterion(criterion)) {
      push(
        `acceptance criterion ${criterion.id} (unknown — check only)`,
        criterion.text,
        `the verifier could not run this check: ${criterion.evidence}`,
        null,
        null,
        { checkOnly: true, criterionId: criterion.id },
      );
      continue;
    }
    if (criterion.verdict !== "unmet" && criterion.verdict !== "partial") continue;
    push(`acceptance criterion ${criterion.id} (${criterion.verdict})`, criterion.text);
  }
  return dedupeItems(entries);
};

/** The findings block the prompt renders. One numbered item per line group. */
export const renderFixerItems = (items) =>
  items
    .map((item) =>
      [
        `${item.id}. **${item.title}**`,
        `   - source: ${item.source}`,
        item.file ? `   - file: \`${item.file}\`` : null,
        item.detail ? `   - detail: ${item.detail}` : null,
        item.howToShowItFails ? `   - shows it fails: ${item.howToShowItFails}` : null,
        item.checkOnly
          ? "   - check only: run this criterion's check and report what it printed; change code only if the check fails; write no new test for it"
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

// ---------------------------------------------------------------------------
// Seam 2 — prose in, report out. Pure, total, never throws.
// ---------------------------------------------------------------------------

const pickString = (value, fallback = null) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

/**
 * The `noLessonsHome` flag, coerced fail-open (#155).
 *
 * The schema shows a boolean, so a model that copies it verbatim emits `true`.
 * A model that stringifies its answer emits `"true"`, and the old `=== true`
 * test dropped that silently — the whole notice vanished with no trace. The flag
 * is advisory, so the safe error is to render the notice, not to swallow it:
 * accept the boolean and the string. Anything else stays absent and says nothing.
 */
const isNoLessonsHome = (value) =>
  value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");

/**
 * Coerce the model's block into the schema, keyed by the ids the runner asked
 * about.
 *
 * An item the model did not mention is `deferred` with "the fixer did not
 * report on this item" — not dropped, and never `fixed`. Silence is the one
 * answer that must not read as success, because the branch is about to be
 * presented to a human as reviewed and repaired.
 */
/**
 * Reasons that mean "there is nothing here for anyone to do".
 *
 * Deliberately narrow. Everything unrecognised is `needs_human`, because a
 * defect miscounted as no-op vanishes from the only number the human reads,
 * while a no-op miscounted as work costs them one line of reading.
 */
const NO_OP_REASONS = [
  /\balready\s+(met|fixed|done|satisfied|addressed|handled|resolved|correct|present|implemented|in place|true|the case)\b/,
  /\bno[-\s]?op\b/,
  /\bnothing\s+to\s+(do|fix|change)\b/,
  /\bno\s+(change|action|work|fix)\s+(is\s+)?(needed|required)\b/,
  /\bnot\s+applicable\b/,
  // "no permission" is NOT here: a fixer blocked from touching a file is the
  // clearest case of work that needs a human, not work that vanished.
];

/** `needs_human` unless the reason is recognisably a no-op. */
export const deferralKind = (reason) => {
  const text = String(reason ?? "").toLowerCase();
  return NO_OP_REASONS.some((re) => re.test(text)) ? "no_op" : "needs_human";
};

/**
 * `kind` if the report carries one, else classify the reason here — a report
 * written before this field existed, or built by a caller, still counts right.
 */
const kindOf = (entry) => entry.kind ?? deferralKind(entry.reason);
/**
 * The deferrals that are actually work for a human — the ONE definition of
 * "left for you". Exported because scripts/auto.mjs prints the same number on
 * the epic closeout minutes before the PR run account prints it here, and the
 * two were counting differently.
 */
/**
 * Every id this report actually carries. A `duplicateOf` naming anything else
 * is DANGLING and is ignored — a typo must never make a defect vanish from the
 * only number the human reads.
 */
const reportIds = (report) =>
  new Set(
    [...(report?.items ?? []), ...(report?.fixed ?? []), ...(report?.deferred ?? [])]
      .map((entry) => (entry?.id == null ? null : String(entry.id)))
      .filter(Boolean),
  );

/** The id this entry declares itself a restatement of, or null. Self-reference is null. */
const declaredDuplicate = (entry, ids) => {
  const target = pickString(entry?.duplicateOf);
  return target && target !== String(entry?.id) && ids.has(target) ? target : null;
};

/**
 * True when this deferral is the same defect as another item in this report,
 * so counting it again would inflate "left for you".
 *
 * Follows the chain, so F3 → F2 → F1 all collapse onto F1. In a CYCLE
 * (F1 → F4 → F1, which is what a pair of mutual restatements looks like)
 * exactly one member must survive: the LOWEST id in the cycle by string order
 * wins and every other member is a restatement. Deterministic, and it can
 * neither hang nor swallow both.
 */
const isRestatement = (entry, byId, ids) => {
  let target = declaredDuplicate(entry, ids);
  if (!target) return false;
  const seen = new Set([String(entry.id)]);
  while (target) {
    if (seen.has(target)) {
      const cycle = [];
      let node = target;
      do {
        cycle.push(node);
        node = declaredDuplicate(byId.get(node), ids);
      } while (node && node !== target);
      return String(entry.id) !== cycle.sort()[0];
    }
    seen.add(target);
    target = declaredDuplicate(byId.get(target), ids);
  }
  return true;
};

/**
 * The deferrals in their three buckets, which together are all of them — so
 * `fixed` + these still sums to `items.length` however they are rendered.
 *
 * `no_op` is decided FIRST: an item the branch already satisfies is not work
 * whether or not it also restates another one.
 */
/**
 * Every entry that can DECLARE a restatement, keyed by id — both branches.
 *
 * A `duplicateOf` chain crosses them freely: epic 56 fixed F3 as a restatement
 * of a FIXED F1, and a deferral may equally point at something that was fixed.
 * One map, so the chain and cycle rules are the same wherever the entry sits.
 */
const declarantsById = (report) =>
  new Map(
    [...(report?.fixed ?? []), ...(report?.deferred ?? [])].map((entry) => [String(entry?.id), entry]),
  );

/**
 * The fixed entries split into the DISTINCT defects and the ones the fixer
 * declared restatements of another item.
 *
 * Same machinery as `partitionDeferred`, because it is the same claim: epic 56
 * fixed five items that were two defects, said so in its prose ("Same README
 * change as F1") and had nowhere to say it in the schema, so the run reported
 * five fixes. Both are listed; only the distinct ones are counted.
 */
export const partitionFixed = (report) => {
  const entries = report?.fixed ?? [];
  const ids = reportIds(report);
  const byId = declarantsById(report);
  const distinct = [];
  const duplicates = [];
  for (const entry of entries) {
    if (isRestatement(entry, byId, ids)) duplicates.push(entry);
    else distinct.push(entry);
  }
  return { distinct, duplicates };
};

export const partitionDeferred = (report) => {
  const entries = report?.deferred ?? [];
  const ids = reportIds(report);
  const byId = declarantsById(report);
  const open = [];
  const noOp = [];
  const duplicates = [];
  for (const entry of entries) {
    if (kindOf(entry) === "no_op") noOp.push(entry);
    else if (isRestatement(entry, byId, ids)) duplicates.push(entry);
    else open.push(entry);
  }
  return { open, noOp, duplicates };
};

export const needsHuman = (report) => partitionDeferred(report).open;

/**
 * The fields each lesson class must carry, all non-empty strings (#153).
 *
 * A lesson that is not exactly one of these is ABSENT, never repaired or
 * defaulted — the same rule `duplicateOf` follows. An invented lesson would
 * read as a guard the repo does not have; an absent one renders as
 * `Lesson: missing`, which is the truth.
 */
export const LESSON_FIELDS = { rule: ["id", "file", "redOn"], standard: ["line"], none: ["reason"] };

export const coerceLesson = (value) => {
  if (!value || typeof value !== "object" || !Object.hasOwn(LESSON_FIELDS, value.class)) return null;
  const fields = LESSON_FIELDS[value.class];
  const lesson = { class: value.class };
  for (const field of fields) {
    const text = pickString(value[field]);
    if (!text) return null;
    lesson[field] = text;
  }
  return lesson;
};

/**
 * The command-line spelling of a lesson (#215), one per `LESSON_FIELDS` class:
 * `rule:<id>:<file>:<redOn>`, `standard:"<line>"`, `none:"<reason>"`. Quotes
 * the shell left in place are stripped. Anything else is null, through the same
 * `coerceLesson` a fixer report goes through — never a lesson guessed at.
 */
export const lessonFlagUsage = () => Object.entries(LESSON_FIELDS)
  .map(([kind, fields]) => (kind === "rule"
    ? `--lesson=rule:${fields.map((field) => `<${field}>`).join(":")}`
    : `--lesson=${kind}:"<${fields[0]}>"`))
  .join(", ")
  .replace(/, (?=[^,]*$)/, " or ");

export const parseLessonFlag = (text) => {
  if (typeof text !== "string") return null;
  const colon = text.indexOf(":");
  if (colon === -1) return null;
  const kind = text.slice(0, colon).trim();
  if (!Object.hasOwn(LESSON_FIELDS, kind)) return null;
  const rest = text.slice(colon + 1);
  const fields = LESSON_FIELDS[kind];
  const unquote = (value) => value.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  const parts = fields.length === 1 ? [rest] : rest.split(":");
  if (parts.length !== fields.length) return null;
  return coerceLesson(Object.fromEntries([["class", kind], ...fields.map((field, i) => [field, unquote(parts[i])])]));
};

export const normalizeFixerReport = (value, items = []) => {
  const claimed = new Map();
  for (const entry of Array.isArray(value?.fixed) ? value.fixed : []) {
    if (entry && typeof entry === "object" && entry.id) claimed.set(String(entry.id), entry);
  }
  const excused = new Map();
  for (const entry of Array.isArray(value?.deferred) ? value.deferred : []) {
    if (entry && typeof entry === "object" && entry.id) excused.set(String(entry.id), entry);
  }
  const fixed = [];
  const deferred = [];
  for (const item of items) {
    const hit = claimed.get(item.id);
    if (hit) {
      fixed.push({
        id: item.id,
        title: item.title,
        // Carried so the closeout can tick a `- [ ]` line rendered from any of
        // the titles this item was merged from, not only the surviving one.
        ...(item.aliases?.length ? { aliases: item.aliases } : {}),
        detail: pickString(hit.detail),
        files: (Array.isArray(hit.files) ? hit.files : []).map((f) => pickString(f)).filter(Boolean),
        // Carried raw; whether it POINTS at anything is decided in
        // `partitionFixed`, exactly as it is for a deferral.
        ...(pickString(hit.duplicateOf) ? { duplicateOf: pickString(hit.duplicateOf) } : {}),
        ...(coerceLesson(hit.lesson) ? { lesson: coerceLesson(hit.lesson) } : {}),
      });
      continue;
    }
    const miss = excused.get(item.id);
    const reason = pickString(miss?.reason, "the fixer did not report on this item");
    const duplicateOf = pickString(miss?.duplicateOf);
    deferred.push({
      id: item.id,
      title: item.title,
      reason,
      kind: deferralKind(reason),
      ...(duplicateOf ? { duplicateOf } : {}),
    });
  }
  return {
    summary: pickString(value?.summary, ""),
    fixed,
    deferred,
    // A boolean or the string "true" (#155); absent is the default, says nothing.
    ...(isNoLessonsHome(value?.noLessonsHome) ? { noLessonsHome: true } : {}),
  };
};

/**
 * `status` answers whether a PASS HAPPENED, never whether the branch is good:
 *
 *   ok            a schema-shaped block was found
 *   nothing_to_do the verifier found nothing this pass is allowed to fix
 *   unparseable   the agent exited 0 and emitted no usable block
 *   agent_failed  the agent exited non-zero or timed out
 *
 * On every failing status every item is `deferred`, so the comment the runner
 * posts says "not fixed" rather than saying nothing. A fixer that fell over
 * silently would be indistinguishable from a clean branch.
 */
/**
 * The stream is already on disk; the report points at it.
 *
 * It used to carry the whole session JSONL, which made a 200-line artifact
 * 380KB of which ~97% was transcript — unreadable by `head`, `jq` or a human.
 * What debugging a parse failure actually needs is the END of the stream, so
 * that is what stays, bounded.
 */
export const RAW_TAIL_BYTES = 8192;
const rawTailOf = (raw) => (raw.length > RAW_TAIL_BYTES ? raw.slice(-RAW_TAIL_BYTES) : raw);

export const parseFixerOutput = ({
  text = "",
  raw = "",
  items = [],
  notQueued = 0,
  unknownNotQueued = 0,
  agentStatus = 0,
  timedOut = false,
  durationMs = null,
  ranAt = null,
  head = null,
  reviewHead = null,
  streamPath = null,
}) => {
  const base = {
    version: FIXER_REPORT_VERSION,
    ranAt: ranAt ?? new Date().toISOString(),
    // The commit the REVIEW this pass answered was written about — the reuse
    // key. See the note above `runFixer`'s `reuse` for why it is not `head`.
    reviewHead,
    // The commit the branch was on when this pass started, for reading the
    // report later. Never the reuse key: the fixer commits, so by the time the
    // report is written this is already the PREVIOUS commit.
    head,
    durationMs,
    items,
    // Absent when nothing was dropped, so a report from before this field
    // existed and a report with nothing to report are byte-identical.
    ...(notQueued ? { notQueued } : {}),
    ...(unknownNotQueued ? { unknownNotQueued } : {}),
    rawPath: streamPath,
    rawTail: rawTailOf(raw || text),
  };
  const fail = (status, problem) => ({
    ...base,
    status,
    problems: [problem],
    ...normalizeFixerReport(null, items),
  });
  if (timedOut) return fail("agent_failed", "the fixer timed out; nothing it may have changed is reported");
  if (agentStatus !== 0) return fail("agent_failed", `the fixer exited ${agentStatus}`);
  const block = lastJsonBlock(text);
  if (!block) return fail("unparseable", "the fixer produced no fenced `json` report block");
  return { ...base, status: "ok", problems: [], ...normalizeFixerReport(block, items) };
};

// ---------------------------------------------------------------------------
// Seam 3 — rendering, in code, token-free
// ---------------------------------------------------------------------------

/**
 * "N minor finding(s) never queued and still open; M unknown criteria never
 * queued and still unchecked", or null.
 */
const unattemptedNote = (report) => {
  const parts = [
    report?.notQueued ? `${report.notQueued} minor finding(s) never queued and still open` : null,
    report?.unknownNotQueued
      ? `${report.unknownNotQueued} unknown criteri${report.unknownNotQueued === 1 ? "on" : "a"} never queued and still unchecked`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
};

/**
 * The files the fix pass touched, as a shallow tree.
 *
 * The fixer's commit is by construction the newest and least-reviewed code on
 * the branch — it lands AFTER every check in the run has passed — so "which
 * files did it touch" is the single most useful question about it, and it was
 * previously answerable only by reading a paren at the end of every bullet.
 * A tree answers it in one glance and shows the blast radius by directory.
 *
 * Deliberately shallow: directories, then the files in each. A real tree of a
 * five-file change is taller than the list it replaces.
 */
export const renderFixedFileTree = (report) => {
  const files = [...new Set((report?.fixed ?? []).flatMap((entry) => entry.files ?? []))].sort();
  if (!files.length) return "";
  const byDir = new Map();
  for (const file of files) {
    const cut = file.lastIndexOf("/");
    const dir = cut === -1 ? "." : file.slice(0, cut);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file.slice(cut + 1));
  }
  const dirs = [...byDir.keys()].sort();
  const lines = [];
  dirs.forEach((dir, d) => {
    const last = d === dirs.length - 1;
    lines.push(`${last ? "└── " : "├── "}${dir === "." ? "(repo root)" : `${dir}/`}`);
    const names = byDir.get(dir);
    names.forEach((name, n) => {
      const lastFile = n === names.length - 1;
      lines.push(`${last ? "    " : "│   "}${lastFile ? "└── " : "├── "}${name}`);
    });
  });
  return ["```text", ...lines, "```"].join("\n");
};

/**
 * The lesson a fixed entry is judged by: its own, or — for a restatement — the
 * lesson of the item it restates, found by following the chain to the entry
 * that is nobody's restatement. A primary that was deferred has no lesson to
 * lend, so the entry keeps its own.
 */
const lessonOf = (entry, report) => {
  const ids = reportIds(report);
  const byId = declarantsById(report);
  const fixedIds = new Set((report?.fixed ?? []).map((e) => String(e?.id)));
  const seen = new Set();
  let node = entry;
  while (node && isRestatement(node, byId, ids) && !seen.has(String(node.id))) {
    seen.add(String(node.id));
    node = byId.get(declaredDuplicate(node, ids));
  }
  return node && node !== entry && fixedIds.has(String(node.id)) ? node.lesson ?? null : entry.lesson ?? null;
};

export const renderLesson = (lesson) => {
  if (lesson?.class === "rule") return `Lesson: rule ${lesson.id} (red fixture ${lesson.redOn})`;
  if (lesson?.class === "standard") return `Lesson: standard — ${oneLine(lesson.line)}`;
  if (lesson?.class === "none") return `Lesson: none — ${oneLine(lesson.reason)}`;
  return "Lesson: missing";
};

/**
 * How many DISTINCT fixes ended in a rule or a standard, for the closeout's
 * fix-pass summary. Restatements are left out: they carry their primary's
 * lesson, and counting it again would count one lesson twice. `reported` says
 * whether any fix carried a lesson at all — a report from before #153 did not,
 * and its summary line should read exactly as it did.
 */
export const lessonCounts = (report) => {
  const lessons = partitionFixed(report).distinct.map((entry) => entry.lesson).filter(Boolean);
  return {
    reported: lessons.length > 0,
    rule: lessons.filter((lesson) => lesson.class === "rule").length,
    standard: lessons.filter((lesson) => lesson.class === "standard").length,
  };
};

export const renderFixerMarkdown = (report, { heading = "## Closeout fixes" } = {}) => {
  if (!report) return `${heading}\n\n_No fix pass ran._`;
  const unattempted = unattemptedNote(report);
  if (report.status === "nothing_to_do")
    return `${heading}\n\n_The review found nothing a fix pass is allowed to change._${
      unattempted ? `\n\n_Not attempted — ${unattempted}._` : ""
    }`;
  const lines = [heading, ""];
  if (report.summary) lines.push(report.summary, "");
  for (const problem of report.problems ?? []) lines.push(`> ⚠️ ${problem}`, "");
  const fixedParts = partitionFixed(report);
  lines.push(`**Fixed ${fixedParts.distinct.length} of ${report.items.length}.**`, "");
  const tree = renderFixedFileTree(report);
  // Above the fold and never collapsed: this is the diff a human is about to
  // merge without having reviewed it.
  if (tree) lines.push("What this pass changed:", "", tree, "");
  if (report.fixed.length) {
    // Every fixed item is listed. A restatement is marked as one and points at
    // what it restates, which is why the count above is lower than this list.
    lines.push(details({
      summary: `<b>What was fixed — ${fixedParts.distinct.length} item(s)</b>`
        + (fixedParts.duplicates.length ? ` (+${fixedParts.duplicates.length} restating another)` : ""),
      body: report.fixed
        .map((entry) => {
          const restates = fixedParts.duplicates.includes(entry) ? ` — restates ${entry.duplicateOf}` : "";
          return `- ${restates ? "🔁" : "✅"} **${entry.title}**${restates}${entry.detail ? ` — ${entry.detail}` : ""}`
            + (entry.files.length ? ` (${entry.files.map((f) => `\`${f}\``).join(", ")})` : "")
            + `\n  ${renderLesson(lessonOf(entry, report))}`;
        })
        .join("\n"),
    }), "");
  }
  // Once, not per fix, and whether or not anything was fixed (#155): the notice
  // is about the run producing no rule, which is equally true of a pass that
  // fixed nothing but flagged the missing home. Its population is `lessonCounts`'
  // — DISTINCT fixes only — so it can never disagree with the count that says
  // how many rules the pass produced: a restatement's own rule lesson is not a
  // rule this pass produced, and must not silence the notice while the count is
  // zero.
  if (report.noLessonsHome && lessonCounts(report).rule === 0)
    lines.push("> ℹ️ This repo has no lessons home, so no fix could become a rule. `setup-coduo-toolchain` adds one.", "");
  const { open, noOp, duplicates } = partitionDeferred(report);
  if (open.length) {
    lines.push("", `**Not fixed — ${open.length} left for you.**`, "");
    for (const entry of open) lines.push(`- ⬜ **${entry.title}** — ${entry.reason}`);
  }
  // Collapsed, both of them: neither is work for anyone. The counts stay in
  // the summary so nothing is hidden, only folded — "0 left for you" hiding
  // five unqueued findings is the bug this whole section grew out of.
  if (noOp.length) {
    lines.push("", details({
      summary: `<b>Not fixed — ${noOp.length} needed no change</b> (the branch already satisfies them)`,
      body: noOp.map((entry) => `- ➖ **${entry.title}** — ${entry.reason}`).join("\n"),
    }));
  }
  if (duplicates.length) {
    lines.push("", details({
      summary: `<b>Not fixed — ${duplicates.length} restating another item</b>`,
      body: duplicates
        .map((entry) => `- 🔁 **${entry.title}** — restates ${entry.duplicateOf} — ${entry.reason}`)
        .join("\n"),
    }));
  }
  if (unattempted) {
    // The findings this pass is not allowed to queue. Out of scope for the
    // agent, still open for the reader — the one thing "0 left for you" hid.
    lines.push("", `**Not attempted — ${unattempted}.**`, "");
    if (report.notQueued) lines.push("Minor findings are out of this pass's scope; they stay in the verifier's report.");
    if (report.unknownNotQueued)
      lines.push("An unknown criterion reaches this pass only when the review's sandbox is why it could not be checked; the rest need a person, a device, or a task that never passed.");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

export const renderFixerOutcome = (report) => {
  if (!report) return null;
  // Appended to every completed status: "nothing to fix" and "0 left for you"
  // are both false while findings the pass never queued are open.
  const unattempted = unattemptedNote(report);
  const tail = unattempted ? `; ${unattempted}.` : ".";
  if (report.status === "nothing_to_do") return `FIX: nothing the review found is fixable here${tail}`;
  if (report.status !== "ok")
    return `FIX: the fix pass did not complete (${report.problems?.[0] ?? report.status}); all ${report.items.length} item(s) left for you${tail}`;
  // All four numbers, so the skimmed one-liner sums to the total the way the
  // markdown does: "fixed 1 of 3; 0 left for you" reads as arithmetic nobody
  // can check.
  const { open, noOp, duplicates } = partitionDeferred(report);
  const fixed = partitionFixed(report);
  // Restatements from BOTH branches are one number: the reader cares that N of
  // the items were the same defect said twice, not which bucket each sat in.
  const restating = fixed.duplicates.length + duplicates.length;
  const uncounted = [
    noOp.length ? `${noOp.length} needed no change` : null,
    restating ? `${restating} restating another item` : null,
  ].filter(Boolean);
  return `FIX: fixed ${fixed.distinct.length} of ${report.items.length} closeout item(s); ${open.length} left for you${uncounted.length ? ` (${uncounted.join(", ")})` : ""}${tail}`;
};

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * The never-queued minor findings as ONE uncollapsed checklist, for a comment
 * on the epic issue at close (#145), or null when there are none.
 *
 * Not queueing them is the policy (`FIXABLE_SEVERITIES`) and stays the policy.
 * The gap was the record: #782 closed with five minors — stale link status
 * after unlink, an unmemoized `detectPlatform`, an edit outside a ticket's
 * allowed paths — whose only home was a collapsed `<details>` on a PR that
 * gets merged and forgotten. The epic issue outlives the PR, and a checklist
 * there is something a person can tick.
 */
export const renderMinorsComment = (report) => {
  const minors = neverQueuedFindings(report);
  if (!minors.length) return null;
  return `${[
    `### ${minors.length} minor finding(s) from the closeout review, never queued`,
    "",
    "The closeout fix pass takes blocker and major findings only, so these were left open. Tick one when it is fixed or dismissed.",
    "",
    ...minors.map(
      (finding) =>
        `- [ ] **${oneLine(finding.title)}**${finding.file ? ` (\`${finding.file}\`)` : ""} — ${finding.axis}${
          finding.detail ? `: ${oneLine(finding.detail)}` : ""
        }`,
    ),
  ].join("\n")}\n`;
};

/** The highest-numbered `<kind>-<n>` attempt directory under `.afk/runs/<id>/`, or null. */
const latestAttempt = (root, taskId, kind) => {
  let names;
  try {
    names = readdirSync(resolve(root, ".afk", "runs", String(taskId)));
  } catch {
    return null;
  }
  const numbers = names
    .map((name) => new RegExp(`^${kind}-(\\d+)$`).exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  return numbers.length ? Math.max(...numbers) : null;
};

/**
 * Every task that did not land, with its retained branch and what its last
 * attempt's checks said (#145) — the other half of leaving its criteria out of
 * the fix pass. #803's task 809 failed twice on a leaked port with every other
 * check green; its branch was a near-green diff a human or a targeted
 * `afk reset` could have finished, and the closeout never named it.
 *
 * Reads `.afk/runs/<id>/{builder,integration}-<n>/verification.json`, the
 * newest attempt of the stage that failed. Never throws: an unreadable record
 * is a lane with no checks to show, not a closeout that dies.
 */
export const unpassedLanes = ({ root, dag, state }) =>
  unpassedTaskIds(dag, state).map((id) => {
    const lifecycle = lifecycleOf(id, state);
    const kinds = lifecycle === "integration_failed" ? ["integration", "builder"] : ["builder"];
    let record = null;
    let stage = null;
    let attempt = null;
    for (const kind of kinds) {
      const n = latestAttempt(root, id, kind);
      if (n == null) continue;
      try {
        record = JSON.parse(readFileSync(resolve(root, ".afk", "runs", id, `${kind}-${n}`, "verification.json"), "utf8"));
        stage = kind;
        attempt = n;
        break;
      } catch { /* try the earlier stage */ }
    }
    return {
      taskId: id,
      lifecycle,
      // No attempt on disk is a task that never started (a failed dependency
      // blocked it), and it has no branch worth naming.
      branch: record ? (pickString(record.branch) ?? state?.tasks?.[id]?.branch ?? taskBranch(id)) : null,
      stage,
      attempt,
      checks: (Array.isArray(record?.checks) ? record.checks : []).map((check) => ({
        command: check.command,
        code: check.code ?? null,
        ...(check.timedOut ? { timedOut: true } : {}),
        ...(check.skipped ? { skipped: true } : {}),
      })),
      failureReason: pickString(record?.failureReason),
    };
  });

/** The closeout section for `unpassedLanes`, or "" when every task landed. */
export const renderUnpassedLanes = (lanes) => {
  if (!lanes?.length) return "";
  const mark = (check) =>
    check.skipped ? `➖ \`${check.command}\` (skipped)`
      : checkFailed(check) ? `❌ \`${check.command}\` (${check.timedOut ? "timed out" : `exit ${check.code ?? "?"}`})`
      : `✅ \`${check.command}\``;
  return [
    "## Tasks that did not pass",
    "",
    "Their acceptance criteria were left out of the closeout fix pass: building a failed lane's feature on the run branch is not that pass's job. Each branch below is retained; finish it by hand, or `afk reset <id>` to rebuild it.",
    "",
    ...lanes.map((lane) => {
      if (lane.lifecycle === "awaiting_acceptance")
        return `- **${lane.taskId}** \`${lane.lifecycle}\` — waiting on a human's acceptance (\`--accept=${lane.taskId}\`); there is no lane to build.`;
      if (!lane.branch) return `- **${lane.taskId}** \`${lane.lifecycle}\` — never built, so there is no branch.`;
      const checks = lane.checks.length ? lane.checks.map(mark).join(" · ") : "no checks recorded";
      return `- **${lane.taskId}** \`${lane.lifecycle}\` — branch \`${lane.branch}\`, ${lane.stage} attempt ${lane.attempt}: ${checks}`
        + (lane.failureReason ? ` — ${lane.failureReason}` : "");
    }),
  ].join("\n");
};

/**
 * The verifier's report with every check-only criterion the fix pass found
 * already met written back as `met`, its output as the evidence (#143).
 *
 * For rendering the closeout only: the verifier's own report on disk is never
 * rewritten, the recommendation and the epic's outcome are computed before the
 * fix pass ran, and the evidence says whose word it is. A check the fixer could
 * not run, or that failed and became a fix, stays `unknown`.
 */
export const withCheckedCriteria = (report, fixReport) => {
  if (!report || !Array.isArray(fixReport?.items)) return report;
  const byItem = new Map(fixReport.items.filter((item) => item.checkOnly && item.criterionId).map((item) => [item.id, item.criterionId]));
  const checked = new Map();
  for (const entry of fixReport.deferred ?? []) {
    const criterionId = byItem.get(entry.id);
    const reason = pickString(entry.reason);
    if (!criterionId || !reason || !/^already met\b/i.test(reason)) continue;
    checked.set(criterionId, reason.replace(/^already met\s*[—–:-]*\s*/i, "").trim());
  }
  if (!checked.size) return report;
  const criteria = (report.criteria ?? []).map((criterion) =>
    checked.has(criterion.id) && criterion.verdict === "unknown"
      ? {
          ...criterion,
          verdict: "met",
          evidence: `met by the closeout fix pass, not re-reviewed: ${checked.get(criterion.id) || "no output given"}`,
        }
      : criterion,
  );
  const merged = { ...report, criteria };
  return { ...merged, counts: verifierReportCounts(merged) };
};

/**
 * The fix pass as `.afk/state.json` records it — the same numbers, in fields.
 *
 * `close.fixer` used to be `{fixed: report.fixed.length, deferred:
 * report.deferred.length}`. Both renderers above had already been moved onto
 * the partitions and this one surface was missed, so state.json — the surface a
 * later tool reads, and the only one nobody proofreads — carried `{fixed: 6,
 * deferred: 4}` for the report the log line calls "fixed 4 of 10; 2 left for
 * you (1 needed no change, 3 restating another item)", and omitted `notQueued`
 * altogether. Epic #388's "`deferred: 0` while five findings were never
 * queued" is the same miss.
 *
 * Every number comes from the partitions, never from a `.length` counted here:
 * each surface that recounted locally has drifted from the others at least
 * once. `restating` sums BOTH branches exactly as `renderFixerOutcome` does —
 * the reader cares that N items were one defect said twice, not which array
 * each sat in.
 */
export const fixerStateRecord = (report) => {
  if (!report) return null;
  const fixed = partitionFixed(report);
  const { open, noOp, duplicates } = partitionDeferred(report);
  return {
    status: report.status,
    items: report.items?.length ?? (report.fixed?.length ?? 0) + (report.deferred?.length ?? 0),
    distinct: fixed.distinct.length,
    restating: fixed.duplicates.length + duplicates.length,
    open: open.length,
    noOp: noOp.length,
    notQueued: report.notQueued ?? 0,
    unknownNotQueued: report.unknownNotQueued ?? 0,
    ranAt: report.ranAt ?? null,
  };
};

// ---------------------------------------------------------------------------
// Seam 4 — the one impure function
// ---------------------------------------------------------------------------

export const fixerDir = (root, epicId) => resolve(root, ".afk", "fixer", String(epicId ?? "epic"));
export const fixerReportPath = (root, epicId) => resolve(fixerDir(root, epicId), "report.json");

export const readFixerReport = (root, epicId) => {
  const path = fixerReportPath(root, epicId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Seam 5 — the gate over the fix pass's own commit
// ---------------------------------------------------------------------------

/**
 * A wave runs lanes, passes their gates, integrates, reviews — and THEN the fix
 * pass commits. That commit lands after the gates that just passed, so nothing
 * in the wave ever ran a check over it. Normally the next wave's baseline closes
 * the gap by accident within minutes; the LAST wave of a run has no next wave,
 * and quillnote wave-34 (2026-09-04) shipped `18cdd44` as the branch tip while
 * its five gates had run two commits below it, at the merge. Running the chain
 * by hand afterwards passed, but that was a human choosing to check.
 *
 * The irony the issue states is the reason this exists: the fix pass repairs the
 * most safety-relevant findings of the run, and its output was the least
 * verified code on the branch.
 */
export const CLOSEOUT_GATE_VERSION = 1;

// The failing check's output, bounded exactly as the wave digest bounds a
// failing lane's. A suite stops at its first failure and carrying the rest is
// AGENTS.md failure mode 5.
export const GATE_OUTPUT_BYTES = 4_000;

export const closeoutGatePath = (root, epicId) => resolve(fixerDir(root, epicId), "gate.json");

// The one writer of `gate.json`. Exported because `auto.mjs`'s own catch has a
// record to persist and no other way to reach the path — a second `resolve(...)`
// there is the drift AGENTS.md warns about.
export const writeCloseoutGate = (root, epicId, record) =>
  atomicWrite(closeoutGatePath(root, normalizeId(epicId ?? null)), `${JSON.stringify(record, null, 2)}\n`);

export const readCloseoutGate = (root, epicId) => {
  const path = closeoutGatePath(root, epicId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Re-run the project's check chain over whatever the fix pass committed.
 *
 * Cheap by construction: the chain only runs when HEAD actually moved. Most
 * closeouts commit nothing (`nothing_to_do`, or a pass that only deferred), and
 * for those the tip is still the commit the wave's own gates ran over — so
 * there is nothing new to check and the record says so rather than buying a
 * second identical green per wave.
 *
 * HEAD, not the fix report's status, is the question asked. An `agent_failed`
 * pass can still have committed before it died, and a report that says the pass
 * did not complete says nothing about the tree.
 *
 * FAIL DIRECTION (AGENTS.md): OPEN, and this is the whole design constraint.
 * `runCloseoutFixer`'s contract is that the fix pass "never throws and never
 * changes the epic's outcome" — it is advisory precisely because the agent that
 * wrote the commit is not allowed to grade it. A red gate here therefore
 * records `failed`, loudly, in state, in the log and in the digest, and closes
 * the epic exactly as it would have. Letting it sink a close would hand the
 * fixer the lifecycle authority docs/epic-schema.md refuses it, and would give
 * the runner an incentive to skip the gate rather than pay for it. The worse
 * error is an ungated tip nobody can see; a gated-and-red tip is visible, which
 * is the entire point.
 *
 * `reuse` keys on the resulting HEAD for the same reason the fixer keys on the
 * review: a close that happens twice across a restart must not re-run the chain
 * over a commit it already gated.
 *
 * @param {object} args
 * @param {string} args.headBefore HEAD as it was before the fix pass started
 * @param {(args: {commands: string[], cwd: string}) => Promise<{ok: boolean, command?: string, result?: object}>} args.runChecks
 *   the chain runner, injected — `runBaselineChecks` in auto.mjs, which is the
 *   same chain `integrate.mjs` re-runs after a merge
 */
export const runCloseoutGate = async ({
  root,
  config,
  epicId,
  headBefore,
  runChecks,
  ranAt = null,
  reuse = true,
  say = console.log,
}) => {
  const id = normalizeId(epicId ?? null);
  const head = headSha(root);
  const commands = config?.baselineChecks ?? config?.defaultChecks ?? [];
  // A lighter `integrationChecks` means no integration ran the full chain over
  // the tip, so an unmoved head is not "already gated" and this is the only
  // full gate after the baseline. Lighter = it lacks a baseline command; `[]`
  // counts. Without it, no commit means nothing to run.
  const integration = config?.integrationChecks;
  const tipUngated = Array.isArray(integration) && commands.some((command) => !integration.includes(command));
  if (reuse) {
    const existing = readCloseoutGate(root, id);
    if (existing && (existing.head ?? null) === (head ?? null)) return existing;
    // A passed chain over this same list stays good across the runner's own
    // status commits, so a re-close does not pay the full chain again.
    if (tipUngated && existing?.status === "passed"
      && JSON.stringify(existing.checks ?? null) === JSON.stringify(commands)
      && onlyStatusFlushSince(root, existing.fixSha ?? null, head ?? null, isStatusFlushPath)) return existing;
  }
  const record = {
    version: CLOSEOUT_GATE_VERSION,
    ranAt: ranAt ?? new Date().toISOString(),
    headBefore: headBefore ?? null,
    head,
    // The commit the checks below ran over, or null when none did. Named
    // separately from `head` so a reader never has to infer "was anything
    // gated?" from two shas being different.
    fixSha: null,
    status: "no_commit",
    checks: [],
    failingCommand: null,
    failingCode: null,
    // Whether the failure below is the BOUND firing rather than the check going
    // red. Carried because the outcome knows and the record used to throw it
    // away: `baselineTimeoutMs` killing a check printed "and it FAILED — exited
    // non-zero", which is verbatim the misdiagnosis ccae24b removed from the
    // other two check call sites, sending a reader to look for a broken
    // assertion that does not exist.
    timedOut: false,
    output: null,
    problem: null,
  };
  if (headBefore && head && (head !== headBefore || tipUngated)) {
    if (!commands.length) {
      // A project with `baselineChecks: []` has opted out of a chain, so there
      // is nothing to run and the tip is genuinely ungated. Say that, rather
      // than reporting an empty pass as green.
      record.fixSha = head;
      record.status = "unavailable";
      record.problem = "this project declares no checks to re-run";
    } else {
      record.fixSha = head;
      try {
        // (#178) A full gate: it waits for the machine-wide gate lock, and the
        // chain's own time bounds start once it holds it.
        const outcome = await withGateLock({ root, config, epic: id, kind: "fix", say },
          ({ lockWaitS }) => recordGate({ root, kind: "fix", commands, lockWaitS }, () => runChecks({ commands, cwd: root })));
        // The chain as it was asked for, in order — never a per-command exit code
        // reconstructed here. The runner stops at the first failure and reports
        // only that one, and inventing zeroes for the rest would say a check ran
        // when it did not.
        record.checks = [...commands];
        record.status = outcome.ok ? "passed" : "failed";
        if (!outcome.ok) {
          record.failingCommand = outcome.command ?? null;
          // A killed process has no exit status of its own, so the raw `status`
          // is null and renders as "non-zero". 124 is what `timeout(1)` reports
          // and what `checkResult` in lib.mjs already writes for the same event.
          record.timedOut = outcome.result?.timedOut === true;
          record.failingCode = record.timedOut
            ? CHECK_TIMEOUT_EXIT_CODE
            : outcome.result?.status ?? null;
          record.output = `${outcome.result?.stdout ?? ""}${outcome.result?.stderr ?? ""}`
            .trim()
            .slice(-GATE_OUTPUT_BYTES);
        }
      } catch (error) {
        // A chain that could not RUN is an ungated tip, and it has to reach the
        // disk like every other verdict: `readCloseoutGate` returning null is
        // rendered "n/a — no fix pass ran", which is a claim about a pass that
        // did run, over a commit nothing has checked (#78). Recorded here rather
        // than only in the caller's catch, because the caller's record never
        // reached `gate.json` at all.
        record.status = "unavailable";
        record.problem = error.message;
      }
    }
  }
  writeCloseoutGate(root, id, record);
  return record;
};

/**
 * The fixer runs in the PROJECT'S OWN CHECKOUT, not a disposable copy.
 *
 * That is the whole difference from the verifier, and it is deliberate rather
 * than an oversight: its output is a commit on the integrated branch, so it has
 * to be standing in the checkout that holds it. The cap that matters here is
 * therefore the deny list (`git push`, `git merge`, `gh pr`, `gh issue`), not
 * the cwd — see the `fixer` role in scripts/roles.mjs.
 */
export const fixerAgent = (role, config) => ({
  ...roleAgent(role, config),
  bypassPermissions: role.permissions.bypassPermissions ?? true,
  permissionMode: "default",
  settings: settingsArg(role, config),
});

export const spawnFixer = async ({ root, agent, promptPath, streamPath, epicId }) => {
  const role = roleFor("fixer");
  // A linked worktree keeps index.lock in its per-worktree Git directory and
  // objects and refs in the shared common directory, both outside Codex's
  // workspace-write root. The fixer commits, so it needs the same narrow Git
  // metadata grant as the integrator. Claude ignores Codex add-dir flags, but
  // keeping the grant off that path makes the unchanged command explicit.
  const addDirs = agent.backend === "codex" ? (gitMetadataDirs(root) ?? []) : [];
  const command = buildAgentCommand(agent, {
    nodeBin: process.execPath.replace(/\/node$/, ""),
    promptPath,
    streamPath,
    taskId: `fix-${epicId}`,
    processName: role.processName(epicId),
    cwd: root,
    addDirs,
  });
  return runAsync(command, { cwd: root, timeout: agent.timeoutMs });
};

/**
 * Run one bounded fix pass over the verifier's findings.
 *
 * **Never throws**, for the same reason `runVerifier` does not: a caller
 * closing an epic must not die because a fix pass did. Returns null only when
 * there is no verifier report at all — there is nothing to fix from.
 */
export const runFixer = async ({
  root,
  config,
  dag = { tasks: [] },
  branch = null,
  baseBranch = "main",
  verifierReport = undefined,
  // Ids of tasks that did not pass; their criteria are never queued (#145).
  // FAIL DIRECTION: CLOSED. A criterion of a lane that never landed is left
  // out even when it looks fixable: building that feature here writes a
  // lane's worth of code outside every lane's scope (#803). It is not lost —
  // the closeout names the task's retained branch and its last checks.
  skipTasks = [],
  reuse = false,
  ranAt = null,
  runAgent = spawnFixer,
}) => {
  const epic = { id: normalizeId(dag.epic?.id ?? null), title: dag.epic?.title ?? null };
  const head = headSha(root);
  const review = verifierReport === undefined ? readVerifierReport(root, epic.id) : verifierReport;
  if (reuse) {
    const existing = readFixerReport(root, epic.id);
    // Same question the verifier and the reflector ask — "is this artifact
    // still about the thing in hand?" — but NOT the same key, and the
    // difference is the fixer's alone: it COMMITS (prompts/fixer.md step 4).
    // Keying on the working HEAD would compare a pre-fix sha against a tree the
    // pass itself moved, never match, and buy a second attempt at every restart
    // — for an agent this module gets exactly one attempt by design.
    //
    // So the key is the REVIEW this pass answered. A fix pass is done when the
    // findings it was handed are the findings on the table; the verifier's
    // report is already commit-keyed, so a moved branch reaches here as a new
    // review and this correctly misses. Existence alone was the test until epic
    // #391 closed twice and the second close replayed the first pass's report —
    // identical counts, a two-hour-stale `ranAt` — over a branch where the
    // finding it described had been reverted.
    if (existing && review && (existing.reviewHead ?? null) === (review.head ?? null)) return existing;
  }
  if (!review) return null;

  const items = fixerItems(review, { skipTasks });
  const notQueued = unqueuedFindings(review);
  const unknownNotQueued = unqueuedUnknownCriteria(review, { skipTasks });
  const dir = fixerDir(root, epic.id);
  ensureDir(dir);
  if (!items.length) {
    const report = {
      version: FIXER_REPORT_VERSION,
      ranAt: ranAt ?? new Date().toISOString(),
      reviewHead: review.head ?? null,
      head,
      durationMs: 0,
      status: "nothing_to_do",
      problems: [],
      items,
      ...(notQueued ? { notQueued } : {}),
      ...(unknownNotQueued ? { unknownNotQueued } : {}),
      summary: "",
      fixed: [],
      deferred: [],
      rawPath: null,
      rawTail: "",
    };
    atomicWrite(fixerReportPath(root, epic.id), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const role = roleFor("fixer");
  const promptPath = resolve(dir, "prompt.md");
  const streamPath = resolve(dir, "stream.jsonl");
  atomicWrite(
    promptPath,
    rolePrompt(role, config, {
      epic,
      branch: branch ?? dag.branch ?? null,
      baseBranch,
      findingsBlock: renderFixerItems(items),
      checks: (config?.defaultChecks ?? []).join("\n") || "(this project declares no default checks)",
      schema: FIXER_JSON_SCHEMA,
    }),
  );
  rmSync(streamPath, { force: true });

  const agent = withTimeBudget(fixerAgent(role, config), dir);
  const startedAt = Date.now();
  let result;
  try {
    result = await runAgent({ root, agent, promptPath, streamPath, epicId: epic.id });
  } catch (error) {
    result = { status: 1, timedOut: false, stderr: error.message };
  }
  let raw = "";
  try {
    raw = readFileSync(streamPath, "utf8");
  } catch {
    raw = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
  }
  const report = parseFixerOutput({
    text: reportText(raw) || raw,
    raw,
    items,
    notQueued,
    unknownNotQueued,
    agentStatus: result?.status ?? 1,
    timedOut: Boolean(result?.timedOut),
    durationMs: Date.now() - startedAt,
    ranAt,
    head,
    reviewHead: review.head ?? null,
    streamPath,
  });
  // Which model(s) answered this pass; scripts/model-check.mjs.
  report.modelCheck = modelCheck(raw);
  atomicWrite(fixerReportPath(root, epic.id), `${JSON.stringify(report, null, 2)}\n`);
  return report;
};
