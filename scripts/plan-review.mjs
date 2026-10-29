// scripts/plan-review.mjs — the semantic tier of validation (`plan-reviewer`).
//
// docs/epic-schema.md, "Validation": the deterministic tier proves the block is
// well-formed — YAML parses, no cycles, every task is a real open sub-issue, the
// branch does not diverge. It cannot read English. This tier does, and asks the
// five questions a graph cannot answer:
//
//   1. does a child issue need an artifact from a task it does not depend on
//   2. do two parallel-eligible tasks claim overlapping file surfaces
//   3. does a stated acceptance criterion have no task that could satisfy it
//   4. does a child issue need a human decision, approval or secret mid-run
//   5. does a child issue contradict itself — a ruling, waiver or note that
//      says one thing and a criterion or red test that still says another
//
// The fifth also runs alone, on one issue, as `afk review ticket` (the
// `ticket-reviewer` prompt): the cheap check after a mid-run ticket edit.
// atlas#1237 is why: one ruling line was edited, two criteria still said
// "fails closed", and the first four questions passed it twice.
//
// The fourth never refuses: a kept `needs_human` finding becomes a stop in the
// stop forecast (scripts/forecast.mjs), which the human answers in `stops:`.
//
// The governing sentence is "a contradiction aborts before any branch or
// worktree exists". This role's entire value is being the last cheap "no", so it
// runs inside `afk epic` before `git branch`, before the draft PR, before any
// worktree. It is read-only: it cannot repair the DAG and cannot write a file.
//
// ## The division of labour, which is the whole design
//
// The model supplies the *semantic claim*. Code supplies the *graph fact*.
//
// A model asked "does 208 need something from 206 that it does not depend on?"
// reliably reads the two issues correctly and then gets the transitive closure
// wrong — 208 → 205 → 206 looks like a missing edge if you only read
// `depends_on`. So the model is never asked for the verdict. It returns findings
// naming task ids and quoting text; `auditFindings` below re-derives reachability
// from the runner's own DAG and *drops* any finding the graph refutes, and
// `verdictOf` computes abort-or-proceed in code. The runner never greps prose,
// and the LLM never decides whether a run starts.
//
// Dropped findings are reported, not silently discarded — a reviewer that is
// consistently refuted is a signal about the reviewer.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  atomicWrite,
  buildAgentCommand,
  ensureDir,
  looksLikeAuthDeath,
  normalizeId,
  runAsync,
} from './lib.mjs';
import { parseStream, reportText } from './agent-stats.mjs';
import { modelCheck, modelSwitchLine } from './model-check.mjs';
import { preflightSettings, roleAgent, roleFor, rolePrompt } from './roles.mjs';
import { promptFor } from './prompts.mjs';

// Bodies go into the prompt verbatim. An epic with a 200KB body is a runaway,
// not a spec; truncate loudly rather than paying for it or silently dropping it.
const EPIC_BODY_BUDGET = 24_000;
const TASK_BODY_BUDGET = 9_000;

// The only two kinds that can stop a run. See `verdictOf` for the argument.
export const ABORT_KINDS = new Set(['missing_dependency', 'unsatisfied_criterion', 'inconsistent_ticket']);
export const KNOWN_KINDS = new Set([...ABORT_KINDS, 'scope_overlap', 'needs_human']);

export class PlanReviewFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanReviewFormatError';
  }
}

const clip = (text, budget) => {
  const value = String(text ?? '').trim();
  return value.length <= budget
    ? value
    : `${value.slice(0, budget)}\n\n[truncated: ${value.length - budget} more characters — read the issue on GitHub]`;
};

// ---------------------------------------------------------------------------
// The prompt: what the reviewer is given
// ---------------------------------------------------------------------------

// Stated as a schema, in the prompt, so the contract lives next to the thing
// that must satisfy it. `severity` is the model's *confidence* dial, not its
// authority: `verdictOf` lets it downgrade a finding and never lets it upgrade
// one, so a reviewer cannot make a scope overlap fatal by asserting harder.
export const PLAN_REVIEW_CONTRACT = `{
  "findings": [
    {
      "kind": "missing_dependency" | "scope_overlap" | "unsatisfied_criterion" | "needs_human" | "inconsistent_ticket",
      "tasks": ["<issue number>", ...],                // exactly one for needs_human and inconsistent_ticket
      "criterion": "<verbatim quote from the EPIC body; required for unsatisfied_criterion>",
      "evidence": "<verbatim quote from the issue text that made you say this>",   // for needs_human and inconsistent_ticket, from the named task's body
      "contradicts": "<inconsistent_ticket only: the second passage, verbatim from the same task's body, that disagrees with evidence>",
      "severity": "contradiction" | "warning",   // ignored on unsatisfied_criterion: that kind always blocks while the tasks it names are still pending
      "message": "<one sentence a human can act on>"
    }
  ]
}`;

/**
 * Everything the reviewer is given: the epic body (which carries the acceptance
 * criteria), every child issue body, the edges, and the depth/blast-radius math
 * the deterministic tier already computed. No repo tour is requested — the
 * questions are about the tickets, and paying an agent to wander a codebase on
 * every `afk epic` is the cost this role cannot justify. It keeps Read/Grep/Glob
 * so it *can* check a file surface claim, but the prompt does not ask it to.
 */
export const planReviewPrompt = ({ epic, dag, metrics, customInstructions = null, skills = null, projectRoot = null, template = 'plan-reviewer' }) => {
  const rows = new Map((metrics?.rows ?? []).map((row) => [normalizeId(row.id), row]));
  const tasks = (dag?.tasks ?? []).map((task) => {
    const row = rows.get(normalizeId(task.id));
    return [
      `### Task #${task.id} — ${task.title || '(no title)'}`,
      `depends_on: ${(task.dependsOn ?? []).join(', ') || 'nothing (it is a root)'}`,
      row
        ? `depth ${row.depth}; blast radius ${row.blastRadius} of ${row.total} (tasks stranded if this one fails: ${row.dependents.join(', ') || 'none'})`
        : '',
      task.humanGated ? 'gate: before — a human provisions this before it runs' : '',
      task.gateAfter ? 'gate: after — a human accepts this before its dependants run' : '',
      '',
      clip(task.body, TASK_BODY_BUDGET) || '(this issue has an empty body)',
    ]
      .filter(Boolean)
      .join('\n');
  });

  // `template` is `ticket-reviewer` for `afk review ticket`: the same profile,
  // contract and audit, asked only the fifth question.
  return promptFor(template, projectRoot, {
    contract: PLAN_REVIEW_CONTRACT,
    epic: { id: epic?.id ?? epic?.number ?? '?', title: epic?.title ?? '(no title)' },
    epicBody: clip(epic?.body, EPIC_BODY_BUDGET) || '(this epic has an empty body)',
    taskCount: tasks.length,
    tasks: tasks.join('\n'),
    customInstructions,
    skills,
  });
};

// ---------------------------------------------------------------------------
// The contract: parsing the reviewer's output
// ---------------------------------------------------------------------------

// Candidate JSON strings, best first: fenced blocks (last one wins, because the
// contract says the report ends with it), then the whole message, then a
// balanced-brace scan back from the last `"findings"`. Each is tried in turn.
const jsonCandidates = (text) => {
  const value = String(text ?? '');
  const out = [];
  const fences = [...value.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  out.push(...fences.reverse());
  out.push(value.trim());
  const at = value.lastIndexOf('"findings"');
  if (at !== -1) {
    const open = value.lastIndexOf('{', at);
    if (open !== -1) {
      let depth = 0;
      for (let i = open; i < value.length; i += 1) {
        if (value[i] === '{') depth += 1;
        else if (value[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            out.push(value.slice(open, i + 1));
            break;
          }
        }
      }
    }
  }
  return out.filter((candidate) => candidate && candidate.includes('{'));
};

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Structured and machine-checkable, or rejected. A finding that is missing a
 * kind, a task list or a message is not a weaker finding — it is unusable, and
 * treating it as "probably fine" is how a semantic gate becomes decoration.
 *
 * @param {string} text the agent's final message
 * @returns {{kind: string, tasks: string[], message: string, severity: string|null, evidence: string, criterion: string}[]}
 * @throws {PlanReviewFormatError} when nothing in the message satisfies the contract
 */
export const extractFindings = (text) => {
  let lastError = 'no JSON object in the reviewer\'s final message';
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastError = error.message;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      lastError = 'the reviewer returned a value that is not a JSON object';
      continue;
    }
    if (!Array.isArray(parsed.findings)) {
      lastError = 'the reviewer\'s JSON has no `findings` array';
      continue;
    }
    return parsed.findings.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new PlanReviewFormatError(`finding ${index} is not an object`);
      }
      const kind = asText(raw.kind);
      const message = asText(raw.message);
      if (!kind) throw new PlanReviewFormatError(`finding ${index} has no \`kind\``);
      if (!message) throw new PlanReviewFormatError(`finding ${index} (${kind}) has no \`message\``);
      if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) {
        throw new PlanReviewFormatError(`finding ${index} (${kind}) has a \`tasks\` that is not an array`);
      }
      const severity = asText(raw.severity).toLowerCase();
      return {
        kind,
        tasks: (raw.tasks ?? []).map((id) => normalizeId(id)).filter(Boolean),
        criterion: asText(raw.criterion),
        evidence: asText(raw.evidence),
        contradicts: asText(raw.contradicts),
        severity: severity === 'warning' || severity === 'contradiction' ? severity : null,
        message,
      };
    });
  }
  throw new PlanReviewFormatError(lastError);
};

// ---------------------------------------------------------------------------
// The audit: code refutes what the graph can refute
// ---------------------------------------------------------------------------

// Transitive `dependsOn` closure. The deterministic tier proved acyclicity, so
// the `seen` set is belt-and-braces against a caller that skipped it.
const closureOf = (dag) => {
  const direct = new Map(
    (dag?.tasks ?? []).map((task) => [normalizeId(task.id), (task.dependsOn ?? []).map(normalizeId)]),
  );
  const memo = new Map();
  const walk = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return new Set();
    seen.add(id);
    const out = new Set();
    for (const dependency of direct.get(id) ?? []) {
      out.add(dependency);
      for (const deep of walk(dependency, seen)) out.add(deep);
    }
    memo.set(id, out);
    return out;
  };
  for (const id of direct.keys()) walk(id);
  return { ids: new Set(direct.keys()), dependsOn: (id) => memo.get(id) ?? new Set() };
};

// Whitespace-insensitive, case-insensitive containment. A model that quotes a
// criterion it invented fails this; a model that reflows a quote does not.
const flatten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Drop every finding the runner's own data refutes, and say why.
 *
 * This is the check that makes the tier trustworthy enough to abort on. Each
 * rule refutes the specific mistake that kind of finding is prone to:
 *
 * - `missing_dependency`: the model reads `depends_on` and misses transitive
 *   reachability. Recompute the closure; if the consumer already reaches the
 *   producer, there is no missing edge.
 * - `scope_overlap`: "parallel-eligible" is a graph property, not a reading.
 *   If one task reaches the other, they never run at the same time.
 * - `unsatisfied_criterion`: the failure mode is inventing a criterion. Require
 *   the quote to appear in the epic body.
 * - `needs_human`: the same invention, on a task. Require exactly one task, the
 *   quote in that task's body, and no gate already on it.
 * - `inconsistent_ticket`: the invention is a passage, or a paraphrase that
 *   reads as a conflict the ticket never states. Require exactly one task, both
 *   quotes (`evidence` and `contradicts`) in that task's body, and two
 *   different passages. Whether they really disagree stays the model's claim;
 *   code checks only that the ticket says both things.
 *
 * A finding naming a task that is not in the DAG is dropped for every kind.
 *
 * @returns {{kept: object[], dropped: {finding: object, reason: string}[]}}
 */
export const auditFindings = ({ findings = [], dag, epicBody = '' }) => {
  const graph = closureOf(dag);
  const taskOf = new Map((dag?.tasks ?? []).map((task) => [normalizeId(task.id), task]));
  const body = flatten(epicBody);
  const kept = [];
  const dropped = [];
  const drop = (finding, reason) => dropped.push({ finding, reason });

  for (const finding of findings) {
    const unknown = finding.tasks.filter((id) => !graph.ids.has(id));
    if (unknown.length > 0) {
      drop(finding, `names ${unknown.map((id) => `#${id}`).join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not a task in this epic`);
      continue;
    }
    if (finding.kind === 'missing_dependency') {
      const [consumer, producer] = finding.tasks;
      if (!consumer || !producer) {
        drop(finding, 'a missing dependency needs both a consumer and a producer in `tasks`');
        continue;
      }
      if (consumer === producer) {
        drop(finding, `#${consumer} cannot depend on itself`);
        continue;
      }
      if (graph.dependsOn(consumer).has(producer)) {
        drop(finding, `#${consumer} already depends on #${producer} transitively — the edge the reviewer says is missing exists`);
        continue;
      }
    }
    if (finding.kind === 'scope_overlap') {
      const [left, right] = finding.tasks;
      if (!left || !right) {
        drop(finding, 'a scope overlap needs two tasks in `tasks`');
        continue;
      }
      if (graph.dependsOn(left).has(right) || graph.dependsOn(right).has(left)) {
        drop(finding, `#${left} and #${right} are ordered by the graph — they are never eligible to run at the same time`);
        continue;
      }
    }
    if (finding.kind === 'unsatisfied_criterion') {
      const quote = flatten(finding.criterion);
      if (quote.length < 12) {
        drop(finding, 'no verbatim `criterion` quote, so there is nothing to check it against the epic body');
        continue;
      }
      if (!body.includes(quote)) {
        drop(finding, 'the quoted criterion does not appear in the epic body');
        continue;
      }
    }
    if (finding.kind === 'needs_human') {
      if (finding.tasks.length !== 1) {
        drop(finding, `a needs_human finding names exactly one task, not ${finding.tasks.length}`);
        continue;
      }
      const task = taskOf.get(finding.tasks[0]);
      const quote = flatten(finding.evidence);
      // Fails open: a needs_human finding whose quote does not check out is
      // dropped, and the run proceeds without that stop. A stop invented by the
      // reviewer would park a task nobody needs to see; the drop is reported.
      if (quote.length < 12 || !flatten(task.body).includes(quote)) {
        drop(finding, `the quoted evidence does not appear in #${task.id}'s body`);
        continue;
      }
      if (task.humanGated || task.gateAfter) {
        drop(finding, 'the gate already covers it');
        continue;
      }
    }
    if (finding.kind === 'inconsistent_ticket') {
      if (finding.tasks.length !== 1) {
        drop(finding, `an inconsistent_ticket finding names exactly one task, not ${finding.tasks.length}`);
        continue;
      }
      const task = taskOf.get(finding.tasks[0]);
      const ticket = flatten(task.body);
      const missing = [['evidence', finding.evidence], ['contradicts', finding.contradicts]]
        .filter(([, quote]) => flatten(quote).length < 12 || !ticket.includes(flatten(quote)))
        .map(([field]) => `\`${field}\``);
      // Fails open, like needs_human: a conflict whose passages the ticket does
      // not contain is the reviewer's paraphrase, and refusing on it would send
      // a human to fix text that is not there. The drop is reported.
      if (missing.length) {
        drop(finding, `the quoted ${missing.join(' and ')} ${missing.length > 1 ? 'do' : 'does'} not appear in #${task.id}'s body`);
        continue;
      }
      const [left, right] = [flatten(finding.evidence), flatten(finding.contradicts)];
      if (left.includes(right) || right.includes(left)) {
        drop(finding, 'the two quoted passages are the same text, so they cannot disagree');
        continue;
      }
    }
    kept.push(finding);
  }
  return { kept, dropped };
};

// ---------------------------------------------------------------------------
// The verdict: abort or proceed, decided in code
// ---------------------------------------------------------------------------

/**
 * Where the abort line sits, and why.
 *
 * **Aborts.** `missing_dependency` — the runner will schedule the consumer
 * against a tree that does not contain the artifact, so the lane fails or, worse,
 * reinvents it. Nothing downstream recovers from this; the scheduler has no
 * concept of "wait, actually". `unsatisfied_criterion` — the alternative is
 * running the whole epic and discovering at the verifier that it never could
 * have satisfied the ask. Both are refuted by code above when the model is
 * wrong, so the false-positive cost is already paid down.
 *
 * **Warns.** `scope_overlap` — docs/epic-schema.md failure mode 2 is explicit
 * that v1 ships repo-wide advisory scope: the worker keeps out-of-scope edits for
 * review rather than failing, and the integrator resolves conflicts semantically.
 * Aborting on a *predicted* overlap would refuse epics that run fine today, and
 * the prediction is about code that does not exist yet — the highest
 * false-positive surface of the three. It costs merge time, not correctness.
 *
 * **Unknown kinds warn.** A future reviewer inventing a category must not be
 * able to stop a run with a string the runner has never heard of.
 *
 * The model may downgrade an abort-kind to a warning to express low confidence.
 * It may not upgrade a warn-kind. Confidence is its job; authority is not.
 *
 * **Except on `unsatisfied_criterion`, where it may not downgrade either.**
 * Six live epics: the reviewer emitted this kind as a warning three times and was
 * right all three times, and nothing revisited it. Epic #5's warning named the
 * exact outcome — "no task explicitly says it strips the duplicated logic out of
 * the two hooks" — and the run ended green with the duplication intact and a
 * third copy added. This is the one class that predicts a green run producing the
 * wrong artifact, and it arrives at the only moment when the repair is free.
 * Confidence is not the useful dial here: a reviewer unsure whether any task
 * covers a criterion is describing the same cheap question as one that is sure.
 *
 * `started` is what keeps that absolute rule from becoming a trap. The repair is
 * "put the criterion back on the task", which only exists while the task is still
 * pending — on a restart of a half-run epic a criterion naming only merged work
 * cannot be actioned, and refusing forever would leave a human with no move,
 * because this project deliberately has no plan-review override. So the block
 * holds exactly while at least one named task has not started; past that the
 * model's own severity applies again and the finding gets a recorded decision
 * like any other warning. A finding naming no task at all is "nothing here
 * satisfies this" — still actionable, by adding a task, so it blocks.
 */
export const repairIsStillFree = (finding, started = new Set()) =>
  finding.tasks.length === 0 || finding.tasks.some((id) => !started.has(id));

/*
 * `inconsistent_ticket` refuses, on the `missing_dependency` terms: the model
 * may downgrade it to express low confidence, and code has already checked both
 * quoted passages are in the ticket. It refuses rather than warns because what
 * it predicts is question 3's failure — a green lane that built the wrong thing,
 * the builder satisfying one passage and the verifier holding it to the other —
 * and because the repair, editing one ticket, is free until that lane starts. It
 * is not question 2's prediction about code that does not exist yet: both
 * passages are on the page. Unlike `unsatisfied_criterion` the model keeps its
 * downgrade, because "do these two lines disagree" can turn on a condition the
 * ticket states elsewhere, and confidence is the honest dial there.
 *
 * Once the named task has started the refusal has nothing left to protect — the
 * lane already read the ticket — so it warns, and the decision is recorded.
 */
export const severityOf = (finding, started = new Set()) => {
  if (!ABORT_KINDS.has(finding.kind)) return 'warning';
  if (finding.kind === 'inconsistent_ticket' && !repairIsStillFree(finding, started)) return 'warning';
  if (finding.kind === 'unsatisfied_criterion' && repairIsStillFree(finding, started)) {
    return 'contradiction';
  }
  return finding.severity === 'warning' ? 'warning' : 'contradiction';
};

export const verdictOf = (findings = [], started = new Set()) => {
  const contradictions = findings.filter((f) => severityOf(f, started) === 'contradiction');
  const warnings = findings.filter((f) => severityOf(f, started) !== 'contradiction');
  return { abort: contradictions.length > 0, contradictions, warnings };
};

// ---------------------------------------------------------------------------
// Carry-forward: a refusing finding outlives the sample that raised it
// ---------------------------------------------------------------------------

/**
 * One model session per review means one sample per review, and a sample can
 * miss what the last one saw: one epic body was refused, passed two minutes
 * later, and refused again with the same correct finding. So every kept finding
 * that refused the run, and every `needs_human` stop, is written to a store
 * outside the repository and raised again by the next review for as long as
 * the text it quoted is still there and its tasks are still in the graph.
 *
 * Carried findings go back through `auditFindings` with the new DAG, because
 * not every repair is an edit to the quoted text: a missing dependency is
 * repaired by adding the edge, a `needs_human` stop by adding a gate.
 *
 * There is no override flag. The price is that a false positive stays until the
 * ticket is reworded.
 *
 * `inconsistent_ticket` is the exception: it is never stored or carried. Whether
 * two passages disagree is the model's claim alone (code checks only that both
 * are quoted), so one sample must not refuse every later launch. It refuses
 * only the review that raises it, and again only when a fresh review does.
 */
export const UNCARRIED_KINDS = new Set(['inconsistent_ticket']);
export const planReviewStorePath = ({ repo, epicId, env = process.env }) =>
  join(
    env.AFK_PLAN_REVIEW_STORE || join(homedir(), '.afk-claude', 'plan-review'),
    String(repo ?? 'unknown').replace(/\//g, '-'),
    `${normalizeId(epicId)}.json`,
  );

// Same kind, same tasks, same evidence is one finding. An inconsistent ticket
// adds its second passage: one edited ruling against two stale criteria is two
// findings that share their `evidence`, and both must be reported.
export const findingKey = (finding) =>
  [
    finding.kind,
    [...finding.tasks].sort().join(','),
    flatten(finding.evidence),
    ...(finding.contradicts ? [flatten(finding.contradicts)] : []),
  ].join('|');

// Fails closed: a store that will not parse, or parses without a findings array,
// throws, and the run stops rather than forget a finding it was told to remember.
// `runPlanReview` reads it before the reviewer session, so the refusal costs no tokens.
export const readStore = (storePath) => {
  if (!storePath || !existsSync(storePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storePath, 'utf8'));
  } catch (error) {
    throw new Error(`the plan-review store at ${storePath} is not valid JSON (${error.message})`);
  }
  if (!Array.isArray(parsed?.findings)) {
    throw new Error(`the plan-review store at ${storePath} has no findings array`);
  }
  return parsed.findings;
};

/**
 * The stored findings that still stand: every task still in the DAG, and every
 * quote (`evidence`, plus `criterion` on `unsatisfied_criterion`) still in the
 * epic or a child body. A finding that quotes nothing has nothing to stand on.
 */
export const carriedFindings = ({ stored = [], dag, epicBody = '' }) => {
  const tasks = dag?.tasks ?? [];
  const ids = new Set(tasks.map((task) => normalizeId(task.id)));
  const text = flatten([epicBody, ...tasks.map((task) => task.body)].join('\n'));
  return stored
    .filter((entry) => entry && !UNCARRIED_KINDS.has(entry.kind))
    .filter((entry) => Array.isArray(entry.tasks) && entry.tasks.every((id) => ids.has(normalizeId(id))))
    .filter((entry) => {
      const quotes = [
        entry.evidence,
        entry.kind === 'unsatisfied_criterion' ? entry.criterion : '',
      ]
        .map(flatten)
        .filter(Boolean);
      return quotes.length > 0 && quotes.every((quote) => text.includes(quote));
    })
    .map((entry) => ({
      kind: entry.kind,
      tasks: entry.tasks.map(normalizeId),
      criterion: asText(entry.criterion),
      evidence: asText(entry.evidence),
      contradicts: asText(entry.contradicts),
      severity: entry.severity ?? null,
      message: asText(entry.message),
      carried: entry.raisedAt,
    }));
};

export const writeStore = (storePath, findings, { epicId = null, raisedAt = new Map(), now = new Date() } = {}) => {
  const entries = findings.map((finding) => ({
    kind: finding.kind,
    tasks: finding.tasks,
    criterion: finding.criterion,
    evidence: finding.evidence,
    ...(finding.contradicts ? { contradicts: finding.contradicts } : {}),
    severity: finding.severity,
    message: finding.message,
    raisedAt: finding.carried ?? raisedAt.get(findingKey(finding)) ?? now.toISOString(),
  }));
  atomicWrite(storePath, `${JSON.stringify({ epic: epicId, findings: entries }, null, 2)}\n`);
};

const carriedNote = (finding) => (finding.carried ? ` (carried from the review at ${finding.carried})` : '');

/**
 * The decision record: every finding leaves with a verdict attached, and the
 * verdict outlives the process.
 *
 * The complaint this answers is epic #4's — the reviewer flagged two things, both
 * turned out harmless, "noted, accepted" was the right response, "but that was
 * luck, not judgement, and nothing recorded the call". A warning that only ever
 * existed in stdout scrollback is indistinguishable afterwards from one nobody
 * read.
 *
 * Two decisions, because two are all that are observable from here. `blocked` is
 * the run this refused. `accepted` is a human reading the printed warning and
 * starting the run anyway — that is a choice, and writing it down is the fix.
 * There is no `actioned` value: a finding that was actioned is one the next
 * review does not raise, so it leaves the record by disappearing from it.
 *
 * Appended rather than overwritten, so a restart adds to the history instead of
 * erasing what the previous attempt decided.
 */
export const renderDecisions = (findings = [], started = new Set(), at = new Date()) =>
  [
    `## ${at.toISOString()}`,
    '',
    ...(findings.length === 0
      ? ['- nothing to decide: the reviewer raised no finding the graph did not refute.']
      : findings.map((finding) => {
          const blocked = severityOf(finding, started) === 'contradiction';
          const decision = blocked ? 'blocked' : finding.kind === 'needs_human' ? 'stop' : 'accepted';
          const tasks = finding.tasks.length
            ? ` [${finding.tasks.map((id) => `#${id}`).join(' → ')}]`
            : '';
          return `- **${decision}** — ${finding.kind}${tasks}: ${finding.message}${carriedNote(finding)}`;
        })),
    '',
  ].join('\n');

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * The role's permission profile as a `--settings` payload.
 *
 * `roleAgent`'s own `settingsArg` renders only the skill denials, because the
 * two roles that existed before this one get their sandbox from a preflight file
 * in a worktree the runner owns. `plan-reviewer` has no worktree — it runs at the
 * project root, where `.claude/` is the project's and the runner must not write
 * it. So the *whole* profile, sandbox included, travels on the invocation.
 * `preflightSettings` already renders exactly that object; it is reused rather
 * than reimplemented so a change to the profile shape reaches both paths.
 *
 * `bypassPermissions: false` is the other half: docs/epic-schema.md says only
 * `implementer` and `integrator` need `--dangerously-skip-permissions`.
 */
export const planReviewAgent = (role, config) => roleAgent(role, config);

/**
 * One agent session. Read-only, direct runtime only — this runs before any herdr
 * workspace exists, and before `runAuto`'s auth probe, so it is also the first
 * thing in an `afk epic` to notice a dead login.
 *
 * Failure policy, deliberately matched to the one this runner already has rather
 * than invented alongside it:
 *
 * - **auth death** → refuse, with the same words `auto.mjs` uses. A run whose
 *   login has expired dies at the auth probe seconds later anyway; failing here
 *   costs the human nothing and saves a confusing second failure.
 * - **unparseable or empty output** → one retry, then refuse. A reviewer that
 *   silently no-ops is the honor-system shape this project rejects for task
 *   completion; a reviewer that blocks a six-hour run over one bad sample is
 *   worse. One retry buys the transient and bounds the cost.
 * - **findings** → `verdictOf` decides, in code, above.
 *
 * @param {{root: string, config: object, epic: object, dag: object, metrics: object,
 *          runDir: string, customInstructions?: string|null, exec?: Function}} input
 * @returns {Promise<object>} outcome; `ok` is the proceed decision
 */
export const runPlanReview = async ({
  root,
  config,
  epic,
  dag,
  metrics,
  runDir,
  customInstructions = null,
  started = new Set(),
  // The carry-forward store (`planReviewStorePath`); null keeps no memory.
  storePath = null,
  exec = runAsync,
  attempts: maxAttempts = 2,
  // `afk review ticket` (scripts/review.mjs): the `ticket-reviewer` prompt, and
  // only the kinds it asks about. A finding of any other kind is dropped and
  // reported, so a reviewer that answers the wrong question cannot refuse.
  template = 'plan-reviewer',
  onlyKinds = null,
}) => {
  const role = roleFor('plan-reviewer');
  const agent = planReviewAgent(role, config);
  const stored = readStore(storePath);
  const prompt = rolePrompt(role, config, { epic, dag, metrics, customInstructions, template });
  ensureDir(runDir);
  const promptPath = resolve(runDir, 'prompt.md');
  atomicWrite(promptPath, prompt);

  const base = {
    role: role.name,
    runDir,
    findings: [],
    dropped: [],
    contradictions: [],
    warnings: [],
    attempts: 0,
  };
  let formatError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const streamPath = resolve(runDir, `stream-${attempt}.jsonl`);
    const command = buildAgentCommand(agent, {
      nodeBin: process.execPath.replace(/\/node$/, ''),
      promptPath,
      streamPath,
      taskId: `plan-review-${epic?.id ?? ''}`,
      processName: role.processName(epic?.id ?? ''),
      // Where `exec` below runs it. Read-only under Codex, so this is the
      // directory it may read, not one it may write.
      cwd: root,
    });
    const startedAt = Date.now();
    const result = await exec(command, { cwd: root, timeout: agent.timeoutMs });
    const durationMs = Date.now() - startedAt;
    let raw = '';
    try {
      raw = existsSync(streamPath) ? readFileSync(streamPath, 'utf8') : '';
    } catch {}
    const stats = parseStream(raw);
    const text = reportText(raw) || '';
    atomicWrite(resolve(runDir, 'review.md'), text || raw.slice(0, 4000));
    // Cost telemetry, in the same two numbers scripts/agent-stats.mjs reports
    // for a lane, so `verification.tokens` and this are comparable.
    const tokens = { contextTokens: stats.contextTokens, outputTokens: stats.outputTokens };
    // Which model(s) answered; printed by `renderPlanReview`, never a refusal.
    // scripts/model-check.mjs.
    const carry = {
      ...base, attempts: attempt, durationMs, tokens,
      modelCheck: modelCheck(raw),
    };

    if (looksLikeAuthDeath(raw) || looksLikeAuthDeath(result.stderr)) {
      return {
        ...carry,
        ok: false,
        status: 'auth_failure',
        message:
          'the claude login has expired, so the plan review could not run (run `claude auth login`, then rerun)',
      };
    }
    if (result.status !== 0 && !text) {
      formatError = result.timedOut
        ? `the reviewer timed out after ${agent.timeoutMs}ms`
        : `the reviewer exited ${result.status}${result.stderr ? `: ${String(result.stderr).trim().slice(0, 400)}` : ''}`;
      continue;
    }
    try {
      const findings = extractFindings(text);
      const epicBody = epic?.body ?? '';
      const asked = onlyKinds ? findings.filter((finding) => onlyKinds.has(finding.kind)) : findings;
      const audited = auditFindings({ findings: asked, dag, epicBody });
      const dropped = [
        ...findings
          .filter((finding) => !asked.includes(finding))
          .map((finding) => ({ finding, reason: `this review asks only about ${[...onlyKinds].join(', ')}` })),
        ...audited.dropped,
      ];
      const kept = [];
      const seen = new Set();
      for (const finding of audited.kept) {
        if (!seen.has(findingKey(finding))) kept.push(finding);
        seen.add(findingKey(finding));
      }
      const carried = auditFindings({
        findings: carriedFindings({ stored, dag, epicBody }).filter(
          (finding) => !seen.has(findingKey(finding)) && (!onlyKinds || onlyKinds.has(finding.kind)),
        ),
        dag,
        epicBody,
      });
      for (const finding of carried.kept) {
        if (!seen.has(findingKey(finding))) kept.push(finding);
        seen.add(findingKey(finding));
      }
      for (const entry of carried.dropped) {
        dropped.push({ ...entry, reason: `carried from the review at ${entry.finding.carried}, no longer holds: ${entry.reason}` });
      }
      const verdict = verdictOf(kept, started);
      // A review with nothing to remember, over a store with nothing in it,
      // writes no file: a clean epic leaves nothing behind in the home directory.
      const remember = kept.filter(
        (finding) =>
          !UNCARRIED_KINDS.has(finding.kind) &&
          (finding.kind === 'needs_human' || severityOf(finding, started) === 'contradiction'),
      );
      if (storePath && (remember.length || stored.length)) {
        writeStore(storePath, remember, {
          epicId: epic?.id ?? null,
          raisedAt: new Map(stored.map((entry) => [findingKey(entry), entry.raisedAt])),
        });
      }
      // The decision, on disk, next to the transcript that produced it. Appended
      // so restarts stack rather than overwrite.
      const decisionsPath = resolve(runDir, 'decisions.md');
      appendFileSync(decisionsPath, renderDecisions(kept, started));
      return {
        ...carry,
        decisionsPath,
        storePath,
        ok: !verdict.abort,
        status: verdict.abort ? 'contradiction' : 'clean',
        findings: kept,
        dropped,
        contradictions: verdict.contradictions,
        warnings: verdict.warnings,
        message: verdict.abort
          ? `${verdict.contradictions.length} contradiction${verdict.contradictions.length === 1 ? '' : 's'} between the DAG and the issues`
          : 'no contradiction between the DAG and the issues',
      };
    } catch (error) {
      if (!(error instanceof PlanReviewFormatError)) throw error;
      formatError = error.message;
    }
  }

  return {
    ...base,
    ok: false,
    attempts: maxAttempts,
    status: 'unusable',
    message: `the plan reviewer did not return a usable report after ${maxAttempts} attempts (${formatError}). Nothing was created; rerun, or fix the reviewer.`,
  };
};

/**
 * The human rendering. Contradictions are the only thing printed with a ✗, so
 * the one line that decided the run is the one line that looks like a decision.
 */
export const renderPlanReview = (outcome) => {
  const lines = ['', 'Plan review (semantic tier):'];
  // An inconsistent ticket prints both passages: the human's repair is to pick
  // one, and they should not have to open the issue to see which two.
  const quotes = (finding) =>
    finding.kind === 'inconsistent_ticket' ? `\n      "${finding.evidence}"\n      vs "${finding.contradicts}"` : '';
  const line = (finding) =>
    `${finding.kind}${finding.tasks.length ? ` [${finding.tasks.map((id) => `#${id}`).join(' → ')}]` : ''}: ${finding.message}${carriedNote(finding)}${quotes(finding)}`;
  for (const finding of outcome.contradictions ?? []) lines.push(`  ✗ ${line(finding)}`);
  // A warning is not a mention; it is a decision the human is making by starting
  // the run. Say which decision it is, and where it was written down. A
  // `needs_human` finding is neither: it is a stop the forecast below carries.
  for (const finding of outcome.warnings ?? []) {
    lines.push(
      finding.kind === 'needs_human'
        ? `  - stop: ${line(finding)} "${finding.evidence}"`
        : `  - accepted: ${line(finding)}`,
    );
  }
  for (const entry of outcome.dropped ?? []) {
    lines.push(`  · dropped ${entry.finding.kind}: ${entry.reason}`);
  }
  if (outcome.status === 'clean' && (outcome.warnings ?? []).length === 0) {
    lines.push('  ✓ no contradiction between the DAG and the child issues.');
  }
  if (outcome.decisionsPath) lines.push(`  recorded in ${outcome.decisionsPath}`);
  const switched = modelSwitchLine('the plan reviewer', outcome.modelCheck);
  if (switched) lines.push(`  ! ${switched}`);
  if (outcome.status === 'auth_failure' || outcome.status === 'unusable') {
    lines.push(`  ✗ ${outcome.message}`);
  } else if (outcome.status === 'contradiction') {
    lines.push('', 'PLAN REVIEW: refused. No branch, worktree or pull request was created.');
    // The hand-back, and the design call it encodes. The runner does not repair
    // this itself — docs/epic-schema.md is explicit that this role "cannot mutate
    // the spec", and the repair spans three artifacts that are written together:
    // the child issue that carries the acceptance criteria, the epic's `tasks:`
    // block, and the Mermaid the block is rendered into. `coduo-tickets` is the
    // single writer of that set. A runner that patched one of the three would
    // leave the picture lying about the other two, which is the drift the epics
    // named. So: refuse, name the repair, and hand it back to the layer that owns
    // it — the same shape as every other "Nothing was created" in `afk epic`.
    if ((outcome.contradictions ?? []).some((f) => f.kind === 'unsatisfied_criterion')) {
      lines.push(
        'Put the criterion back on the named task, as an acceptance criterion its lane will be held to,',
        'then rerun. Do that through `coduo-tickets` rather than by hand: it writes the child issues, the',
        '`tasks:` block and the epic\'s rendered Mermaid together, and patching one of the three by hand is',
        'what makes the diagram lie about the other two.',
      );
    }
    const inconsistent = new Set(
      (outcome.contradictions ?? []).filter((f) => f.kind === 'inconsistent_ticket').map((f) => f.tasks[0]),
    );
    for (const id of inconsistent) {
      lines.push(`Edit #${id} so its passages agree, then check it alone with \`afk review ticket ${id}\`.`);
    }
  }
  return lines.join('\n');
};
