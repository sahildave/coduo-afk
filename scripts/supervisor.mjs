// scripts/supervisor.mjs — judgment at the events, and none of the loop.
//
// docs/epic-schema.md, "`supervisor`": "An LLM with real authority over
// judgment, and none over the loop."
//
// The constraint that shapes every line below:
//
//   THE SUPERVISOR CANNOT MOVE A TASK, START A BUILDER, OR ORDER AN INTEGRATION.
//
// So this module has no state transition in it, no queue, no timer and no
// scheduler import beyond two pure classifiers. It produces a *decision*; the
// runner turns the decision into `afk` commands, in code, from a fixed
// allowlist that contains no lifecycle verb. `supervisorCommands` is the whole
// of "it acts through the same `afk` commands a human would" — the model
// proposes an action by name, the runner renders it to argv, and the model is
// denied `Bash(afk:*)` so it can never be the thing that executes.
//
// ## The shape
//
//   1. `supervisorEvidence`  — pure. Runner context in, a compact, bounded,
//                              secret-free evidence object out.
//   2. `supervisorPrior`     — pure. Evidence in, the runner's OWN deterministic
//                              reading out, with `locked` set when that reading
//                              rests on an observed fact rather than a signal.
//   3. `parseSupervisorOutput` — pure. Agent text in, decision out. Never throws.
//   4. `mergeDecision`       — pure. Prior + model decision out; a locked prior
//                              wins.
//   5. `supervisorCommands`  — pure. Decision in, argv arrays out, everything
//                              off the allowlist refused with a reason.
//   6. `runSupervisor`       — the one impure function; `runAgent` injected.
//
// and six thin event entry points over (6), one per event in the specification:
// `onLaneFailed`, `onIntegrationFailed`, `onLaneBlocked`, `onGateReached`,
// `onEpicEnded`, `onHumanAsked`.
//
// ## Why the prior exists, and why it comes first
//
// Two reasons, and both are about not making the run worse.
//
// **The model is not on the critical path.** Every event has a complete
// deterministic decision *before* any agent starts. If the model is unavailable,
// unauthenticated, slow or wrong, the prior stands and the runner is exactly as
// well off as it is today. A supervisor that could hang a run by being down
// would be a resident dependency, which is the thing docs/epic-schema.md
// refuses.
//
// **Most events do not need a model at all.** An expired login is not an
// ambiguous failure; it is a fact in the transcript, and `finishBuilder` already
// reads it. Consulting a model about it would be paying tokens to be told what
// the runner just observed. `shouldConsult` therefore skips the session whenever
// the prior is locked — which is what bounds the cost on the failure mode that
// fires most often.
//
// ## What is NOT wired
//
// Nothing calls any of these entry points. The events all fire inside
// `scripts/auto.mjs`, which belongs to another lane this wave, and inventing a
// second event source here — a poller, a timer, a watcher — is explicitly
// refused by the specification ("No timer, no polling"). So this module is an
// independently invocable unit with a CLI (`afk supervise <event>`) and a
// one-line call site per event, listed in this lane's report and in
// docs/deferred.md.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  atomicWrite,
  buildAgentCommand,
  ensureDir,
  isMainModule,
  loadConfig,
  looksLikeAuthDeath,
  configPath,
  normalizeId,
  runAsync,
} from "./lib.mjs";
import { reportText } from "./agent-stats.mjs";
import { modelCheck } from "./model-check.mjs";
// Two pure classifiers, reused rather than reimplemented. The runner already
// decides "is this cluster infra?" one way; a supervisor that decided it a
// second way would be the second source of truth this role is forbidden to be.
// Nothing else from scheduler.mjs is imported, and in particular nothing that
// touches `state` — see the structural test in scripts/supervisor.test.mjs.
import { INFRA_FAILURE_MS, isNoOpDecision, looksLikeInfra, neverReachedApi } from "./scheduler.mjs";
import { roleAgent, roleFor, rolePrompt, settingsArg } from "./roles.mjs";
import { createRoleCwd, removeRoleCwd } from "./worktree.mjs";

export const SUPERVISOR_DECISION_VERSION = 1;

// The prose a hard quota arrives as. AGENTS.md failure mode 4: `You've hit your
// usage limit ... try again at Aug 16th`. The regex below only says "this text
// is about a usage limit"; it deliberately does not try to parse the date, which
// is the exact job the specification hands to the model.
const LIMIT_RE = /usage limit|rate limit|quota/i;

export const SUPERVISOR_EVENTS = [
  "lane_failed",
  "integration_failed",
  "lane_blocked",
  "gate_reached",
  "epic_ended",
  "question",
];

/**
 * The classification each event may return. Per event, because "infra versus
 * bad ticket" is a lane question and a gate has no such axis; one shared enum
 * would let a model answer `bad-ticket` to "the epic ended".
 */
export const CLASSIFICATIONS = {
  lane_failed: ["infra", "quota", "bad-ticket", "flaky", "unclear"],
  integration_failed: ["conflict", "broken-base", "infra", "quota", "unclear"],
  lane_blocked: ["needs-human", "no-op-ticket", "unclear"],
  gate_reached: ["gate"],
  epic_ended: ["done", "partial", "halted"],
  question: ["answer"],
};

/**
 * What the supervisor may recommend. Note what is absent from every list:
 * `pass`, `fail`, `integrate`, `schedule`, `start`. Those are the four things
 * docs/epic-schema.md says it does not own, and they are not expressible.
 *
 *   retry-clean  throw the worktree away and let a fresh agent try again
 *   salvage      the work is worth keeping; a human should look at the branch
 *   halt         the cause is shared; starting more lanes wastes them
 *   leave        do nothing, this resolves itself or is already handled
 *   wake-human   this needs a person now
 *   answer       there is nothing to do; the output is the answer
 */
export const RECOMMENDATIONS = {
  lane_failed: ["retry-clean", "salvage", "halt", "leave"],
  integration_failed: ["retry-clean", "salvage", "halt", "leave"],
  lane_blocked: ["wake-human", "leave"],
  gate_reached: ["wake-human", "leave"],
  epic_ended: ["wake-human", "leave"],
  question: ["answer"],
};

const CONFIDENCE = ["high", "medium", "low"];

/**
 * The JSON contract, as the agent is shown it. A string, not a schema object,
 * for the same reason the verifier's is: it is prompt text, and what makes it
 * safe is `normalizeDecision` discarding anything off-schema, not a validator.
 */
export const SUPERVISOR_JSON_SCHEMA = `{
  "classification": "one of the values listed above",
  "confidence": "high|medium|low",
  "recommendation": "one of the values listed above",
  "reasoning": "why, naming the specific evidence that decided it",
  "answer": "two or three plain sentences for the human",
  "resetsAt": "ISO-8601 timestamp, or null",
  "wake": true,
  "actions": [
    { "command": "reset", "args": { "taskIds": ["207"] }, "why": "one line" }
  ]
}`;

// ---------------------------------------------------------------------------
// The action allowlist — "the same `afk` commands a human would"
// ---------------------------------------------------------------------------
//
// Every entry here is a command a human already types. There is deliberately no
// entry that moves a task to `passed` or `failed`, no entry that enqueues an
// integration, and no entry that starts a builder outside the queue: those are
// the runner's, and an allowlist that cannot express them is a stronger
// guarantee than a rule saying not to.
//
// `run --task=` is the one that looks like scheduling and is not: it is the
// documented way a HUMAN releases a `gate: before` task, and it is emitted only
// when the caller supplied the dag path a human would also have to supply.

const ids = (value) =>
  (Array.isArray(value) ? value : [value])
    .map((entry) => normalizeId(entry))
    .filter((entry) => entry !== null && /^[\w.-]+$/.test(entry));

export const SUPERVISOR_ACTIONS = {
  /** Throw a lane's worktree away and let it be picked up fresh. Retry-clean. */
  reset: ({ taskIds } = {}) => {
    const list = ids(taskIds);
    return list.length ? ["reset", ...list] : null;
  },
  /** Release a human gate, exactly as the human would. Needs the dag path. */
  run: ({ taskId, dagPath } = {}) => {
    const [id] = ids(taskId);
    return id && dagPath ? ["run", `--task=${id}`, `--dag=${dagPath}`] : null;
  },
  /** Record a cross-lane finding so a later lane inherits it. Triage. */
  ledger: ({ type, source, text, appliesTo } = {}) => {
    const [from] = ids(source);
    if (!type || !from || !text) return null;
    return [
      "ledger",
      "add",
      `--type=${String(type).replace(/[^\w-]/g, "")}`,
      `--source=${from}`,
      `--text=${String(text).slice(0, 500)}`,
      ...(ids(appliesTo).length ? [`--applies-to=${ids(appliesTo).join(",")}`] : []),
    ];
  },
  /** Read-only. Both exist so "go look" is expressible without prose. */
  status: () => ["status"],
  stats: ({ taskIds } = {}) => ["stats", ...ids(taskIds)],
};

// Words that mean the model tried to take the loop. Matched only to produce a
// better refusal message than "unknown command"; the allowlist above is what
// actually stops it.
const LOOP_VERBS = /^(pass|passed|fail|failed|integrate|merge|schedule|start|close|skip)$/i;

/**
 * The decision's actions, rendered to `afk` argv arrays.
 *
 * @returns {{commands: {argv: string[], why: string|null}[], refused: {command: string, why: string}[]}}
 */
export const supervisorCommands = (decision, { dagPath = null } = {}) => {
  const commands = [];
  const refused = [];
  for (const action of decision?.actions ?? []) {
    const name = String(action?.command ?? "").trim();
    const build = Object.prototype.hasOwnProperty.call(SUPERVISOR_ACTIONS, name)
      ? SUPERVISOR_ACTIONS[name]
      : null;
    if (!build) {
      refused.push({
        command: name || "(unnamed)",
        why: LOOP_VERBS.test(name)
          ? `\`${name}\` is a lifecycle transition; the supervisor does not own those and cannot ask for one`
          : `\`${name}\` is not an afk command the supervisor may propose`,
      });
      continue;
    }
    const argv = build({ ...(action?.args ?? {}), dagPath });
    if (!argv) {
      refused.push({ command: name, why: `\`${name}\` was proposed without the arguments it needs` });
      continue;
    }
    commands.push({ argv, why: typeof action?.why === "string" ? action.why.trim() : null });
  }
  return { commands, refused };
};

// ---------------------------------------------------------------------------
// Seam 1 — evidence
// ---------------------------------------------------------------------------

const clip = (value, budget) => {
  const text = String(value ?? "");
  return text.length > budget ? `${text.slice(0, budget)}\n…[${text.length - budget} more chars]` : text;
};

const CHECK_OUTPUT_BUDGET = 2_000;
const CHECK_OUTPUT_HEAD = 500;

// A check's output is clipped at BOTH ends, not just the head — the same split
// `clipOutput` uses in scripts/worker.mjs, and for the same reason. A test
// runner puts the assertion, the diff and the summary at the END of its output;
// head-only clipping fed the supervisor the compiler preamble and threw away
// the line that says what failed. The head is still kept because `tsc`, `eslint`
// and a Node stack trace put the FIRST diagnostic at the top.
const clipCheckOutput = (value) => {
  const text = String(value ?? "");
  if (text.length <= CHECK_OUTPUT_BUDGET) return text;
  const head = text.slice(0, CHECK_OUTPUT_HEAD);
  const tail = text.slice(text.length - (CHECK_OUTPUT_BUDGET - CHECK_OUTPUT_HEAD));
  return `${head}\n…[${text.length - CHECK_OUTPUT_BUDGET} more chars]\n${tail}`;
};

/**
 * What the supervisor is given, per event.
 *
 * Bounded on purpose. A failed lane's check output can be megabytes, and a
 * prompt that carries all of it reproduces AGENTS.md failure mode 5 (the merger
 * that died on a 1.3M-token prompt) in a new place. Only the FIRST failing check
 * is carried, tail-clipped: a suite stops at its first failure anyway, and the
 * later entries are noise.
 *
 * It is also deliberately not the codebase. docs/epic-schema.md: these sessions
 * read "logs, reports and state rather than the codebase". Paths are named so
 * the agent can read more if it decides to; nothing is inlined for it.
 */
export const supervisorEvidence = (event, context = {}) => {
  const base = {
    event,
    epic: context.epic ? { id: normalizeId(context.epic.id), title: context.epic.title ?? null } : null,
    branch: context.branch ?? null,
    at: context.at ?? new Date().toISOString(),
  };
  if (event === "question") {
    return {
      ...base,
      question: clip(context.question, 4_000),
      // The run as the runner sees it: lifecycle per task and what is in flight.
      // A snapshot, read by the caller; this module never reads state.json.
      run: context.run ?? null,
    };
  }
  if (event === "gate_reached") {
    return {
      ...base,
      gate: context.gate ?? "before",
      taskIds: ids(context.taskIds ?? context.taskId),
      titles: context.titles ?? null,
      run: context.run ?? null,
    };
  }
  if (event === "epic_ended") {
    return {
      ...base,
      halted: context.halted ?? null,
      // (#179) A refused push or failed PR creation at closeout, with the
      // refusing hook's own words. Clipped: a hook can print a whole log.
      delivery: context.delivery
        ? { step: context.delivery.step ?? null, message: clip(context.delivery.message, 1_000) }
        : null,
      tally: context.tally ?? null,
      run: context.run ?? null,
      verifier: context.verifier
        ? {
            status: context.verifier.status ?? null,
            recommendation: context.verifier.recommendation ?? null,
            mustFix: context.verifier.mustFix ?? [],
          }
        : null,
    };
  }

  const verification = context.verification ?? {};
  const failedCheck = (verification.checks ?? []).find(
    (check) => !check?.skipped && check?.code !== 0 && check?.code !== null,
  );
  return {
    ...base,
    taskId: normalizeId(context.taskId),
    title: context.task?.title ?? null,
    attempt: context.attempt ?? verification.attempt ?? null,
    ...(event === "integration_failed"
      ? {
          failureReason: clip(context.failureReason, 1_000),
          removed: context.removed ?? [],
          integrationBase: context.integrationBase ?? null,
        }
      : {}),
    agentExitCode: verification.agentExitCode ?? null,
    timedOut: Boolean(verification.timedOut),
    durationMs: verification.durationMs ?? null,
    authFailure: Boolean(verification.authFailure),
    agentDied: Boolean(verification.agentDied),
    rateLimited: Boolean(verification.rateLimited),
    producedFiles: (verification.producedFiles ?? []).length,
    tokens: verification.tokens ?? null,
    // Decided HERE, by the scheduler predicate, against the raw verification —
    // the prior reads the answer and never the counters. A second place that
    // asks "are the tokens zero?" is a second definition of an infra death, and
    // the counters are the half of it that lies (scheduler.neverReachedApi).
    neverReachedApi: neverReachedApi(verification),
    keptOutsideDeclaredPaths: verification.keptOutsideDeclaredPaths ?? [],
    failedCheck: failedCheck
      ? {
          command: failedCheck.command,
          code: failedCheck.code,
          // Carried because a check KILLED at its bound is a different event
          // from a red one, and the prior below said the same sentence about
          // both. `timeoutMs` is deliberately left behind: the prior needs to
          // know that the bound fired, not how long it was.
          timedOut: Boolean(failedCheck.timedOut),
          output: clipCheckOutput(failedCheck.output),
        }
      : null,
    checksRun: (verification.checks ?? []).length,
    // The cluster signal the breaker uses. Two unrelated near-instant failures
    // is the environment; one is not enough to say (which is the hole this role
    // exists to cover).
    recentFailures: (context.recentFailures ?? []).map((entry) => ({
      taskId: normalizeId(entry.taskId),
      durationMs: entry.durationMs ?? null,
    })),
    // Named, not inlined. The agent may read them; the prompt does not carry them.
    // The builder's phase checklist rides the verification record, so it is
    // named here for every lane event without each call site having to pass it.
    artifacts: {
      ...(verification.checklistPath ? { checklist: verification.checklistPath } : {}),
      ...(context.artifacts ?? {}),
    },
    // Free text the runner already printed, e.g. the agent's last message.
    tail: clip(context.tail, 4_000),
  };
};

// ---------------------------------------------------------------------------
// A red gate, read before the run halts on it (#179)
// ---------------------------------------------------------------------------

// A test that gave up waiting. `Timeout 90000ms exceeded` is Playwright's
// locator wording (harbour #545 launch-545g); the rest are vitest's and node's.
const TIMEOUT_SIGN = /timed out after \d+|timeout of \d+ ?ms exceeded|timeout \d+ ?ms exceeded|exceeded timeout of \d+/i;
const TIMEOUT_REASON = "a test gave up waiting rather than failing an assertion";

// A line naming a failed test's file: vitest's `FAIL` and `❯`, Playwright's
// numbered `1) [project] › file:line`, node's `not ok`. A passing file's `✓`
// line is not one.
const FAILED_TEST_LINE = /\bFAIL\b|❯|✘|×|\bnot ok\b|^\s*\d+\) /;
const TEST_FILE = /[\w@.\/-]*[\w@-]\.(?:test|spec)\.[cm]?[jt]sx?\b/g;

/** The test files the output says failed, as printed (relative to some root). */
const failedTestFiles = (lines) => [...new Set(lines
  .filter((line) => FAILED_TEST_LINE.test(line))
  .flatMap((line) => line.match(TEST_FILE) ?? [])
  .map((file) => file.replace(/^\.\//, "")))];

// Playwright prints a path relative to its testDir, the diff relative to the
// repo, so a printed path matches a changed one on a whole-segment suffix.
const inDiff = (file, changed) => changed.some((path) => path === file || path.endsWith(`/${file}`));

// Lines that say the machine, not the code, made a gate red. Each one is a
// failure the runner has paid for: a port another process held, a local
// service that was not up yet, a schema cache not ready, a dev server that
// compiled past a test's own wait. harbour #489 halted three times on these
// over 18.5 hours and its code was never the cause.
const ENVIRONMENT_SIGNS = [
  [/EADDRINUSE|address already in use|port \d+ is (?:already )?in use/i, "a port was already held"],
  [/ECONNREFUSED|ECONNRESET|socket hang up/i, "a local service refused or dropped the connection"],
  [/schema cache/i, "a schema cache was not ready"],
  // #223, harbour #545 launch-545f: a roadmap read during `next build` got a 502.
  // A 4xx is the request's fault and stays out; an issue number in the path is
  // not a status, so the 5xx must follow the URL after a space.
  [/GitHub returned HTTP 5\d\d\b|api\.github\.com\S*\s.*\b5\d\d\b/i, "GitHub returned a server error"],
  [TIMEOUT_SIGN, TIMEOUT_REASON],
];

// Only read when no environment sign matched: an assertion that failed BECAUSE
// a port was held is still the port.
const TICKET_SIGN = /AssertionError|SyntaxError|TypeError|ReferenceError|error TS\d+/;

/**
 * The deterministic reading of one red gate command: `environment` at high
 * confidence when its output carries a line from `ENVIRONMENT_SIGNS`, `ticket`
 * when it names a broken assertion or a compile error instead, `unclear`
 * otherwise. The runner reruns the gate once on `environment`/`high` and halts
 * on anything else, exactly as before.
 *
 * Fail direction: CLOSED. A command killed at its own bound is `unclear` even
 * when a sign is present, because a rerun would hold the gate for another full
 * bound and a hang is not a flake. A real regression misread as environment
 * costs one more gate run and still halts: the rerun must be green on the same
 * tree.
 *
 * `changedFiles` is the epic's diff, repo-relative (#223): a timeout in a test
 * file it names is `ticket`, not `environment`. Null means no diff was read.
 *
 * @param {{output?: string, timedOut?: boolean, changedFiles?: string[]|null}} failure
 * @returns {{classification: "environment"|"ticket"|"unclear", confidence: "high"|"medium"|"low", evidence: string[]}}
 */
export const classifyGateFailure = ({ output = "", timedOut = false, changedFiles = null } = {}) => {
  const lines = String(output ?? "").split("\n");
  const evidence = [];
  for (const [pattern, reason] of ENVIRONMENT_SIGNS) {
    const line = lines.find((candidate) => pattern.test(candidate));
    if (line) evidence.push(`${reason}: ${line.trim().slice(0, 200)}`);
  }
  // (#223) A timeout is the environment only in a test the epic did not touch.
  // One in a file its diff changed is the epic's own test, and outranks any
  // other sign beside it: a test this branch wrote that never finishes is the
  // branch's to fix. No diff to read keeps the #179 reading.
  if (Array.isArray(changedFiles) && !timedOut && lines.some((line) => TIMEOUT_SIGN.test(line))) {
    const own = failedTestFiles(lines).filter((file) => inDiff(file, changedFiles));
    if (own.length) {
      return { classification: "ticket", confidence: "medium", evidence: [`a test this epic's diff touches timed out: ${own.join(", ")}`] };
    }
  }
  if (timedOut) {
    return { classification: "unclear", confidence: "low", evidence: ["the command was killed at its time bound; a rerun would wait it out again", ...evidence] };
  }
  if (evidence.length) return { classification: "environment", confidence: "high", evidence };
  const broken = lines.find((candidate) => TICKET_SIGN.test(candidate));
  return broken
    ? { classification: "ticket", confidence: "medium", evidence: [`the code is wrong: ${broken.trim().slice(0, 200)}`] }
    : { classification: "unclear", confidence: "low", evidence: ["no line in the output names the environment"] };
};

/** Whether a reading earns the one automatic rerun. */
export const earnsGateRerun = (reading) =>
  reading?.classification === "environment" && reading?.confidence === "high";

// ---------------------------------------------------------------------------
// Seam 2 — the runner's own reading, before any model runs
// ---------------------------------------------------------------------------

const prior = (fields) => ({
  classification: "unclear",
  confidence: "low",
  recommendation: "leave",
  locked: false,
  why: [],
  ...fields,
});

/**
 * The deterministic decision, from the evidence alone.
 *
 * `locked: true` means this rests on a MECHANICALLY OBSERVED fact — a transcript
 * that says the login expired, a cluster the breaker already classified — and
 * not on an inference. A locked prior is not overturnable by the model
 * (`mergeDecision`), and it also skips the model entirely (`shouldConsult`).
 *
 * Everything else is `locked: false` and low or medium confidence, which is the
 * honest state of affairs: a single lane that failed after four minutes with a
 * failing test could be a bad ticket, a broken baseline, or a flake, and no
 * signal available to this function distinguishes them. That is precisely the
 * judgment docs/epic-schema.md hands to an LLM.
 */
export const supervisorPrior = (evidence = {}) => {
  const event = evidence.event;
  if (event === "question") {
    return prior({ classification: "answer", recommendation: "answer", why: ["a human asked"] });
  }
  if (event === "gate_reached") {
    return prior({
      classification: "gate",
      confidence: "high",
      recommendation: "wake-human",
      locked: true,
      why: ["a gate is by definition the human's decision; nothing else can release it"],
    });
  }
  if (event === "epic_ended" && evidence.delivery) {
    return prior({
      classification: "partial",
      confidence: "high",
      recommendation: "wake-human",
      locked: true,
      why: [`the epic's branch was not delivered: the ${evidence.delivery.step} step was refused — ${evidence.delivery.message}`],
    });
  }
  if (event === "epic_ended") {
    return prior({
      classification: evidence.halted ? "halted" : "done",
      confidence: evidence.halted ? "high" : "low",
      recommendation: "wake-human",
      locked: Boolean(evidence.halted),
      why: evidence.halted ? [`the run halted: ${evidence.halted}`] : ["the run reached its end"],
    });
  }
  if (event === "lane_blocked") {
    // `blocked` in this runner means "the agent produced no source change",
    // which is one observation covering two very different causes: an agent
    // sitting at a permission prompt, and a ticket that was already done. Both
    // want a human, so the recommendation is safe while the classification is
    // genuinely open.
    return prior({
      classification: "unclear",
      confidence: "low",
      recommendation: "wake-human",
      why: ["the lane produced no source change; the runner cannot tell waiting-for-input from nothing-to-do"],
    });
  }

  // lane_failed / integration_failed.
  // Above the auth branch on purpose. Both can hold at once, and they are two
  // different halts: an expired login says every later lane dies the same way,
  // a lane that never reached the API says THIS one never started. The narrower
  // fact is the one worth telling the human, and neither is overturnable.
  if (evidence.neverReachedApi) {
    return prior({
      classification: "infra",
      confidence: "high",
      recommendation: "halt",
      locked: true,
      why: ["the lane spent zero tokens and left no produced files, so it never reached the API and never saw the ticket"],
    });
  }
  if (evidence.authFailure || looksLikeAuthDeath(evidence.tail)) {
    return prior({
      classification: "infra",
      confidence: "high",
      recommendation: "halt",
      locked: true,
      why: ["the transcript says the claude login expired; every further lane dies the same way"],
    });
  }
  if (looksLikeInfra(evidence.recentFailures ?? [])) {
    return prior({
      classification: "infra",
      confidence: "high",
      recommendation: "halt",
      locked: true,
      why: [
        `${(evidence.recentFailures ?? []).length} unrelated tasks failed in under ${INFRA_FAILURE_MS / 1000}s each — the environment, not the tickets`,
      ],
    });
  }
  if (evidence.rateLimited || LIMIT_RE.test(evidence.tail ?? "")) {
    // Deliberately NOT locked, and this is the point of AGENTS.md failure mode
    // 4. The runner can see "a usage limit was hit" and cannot see whether the
    // reset is in five minutes or six days, because the provider says it in
    // prose when it says it at all. Reading that sentence is the model's job.
    return prior({
      classification: "quota",
      confidence: "low",
      recommendation: "leave",
      why: [
        "a usage limit was reported; whether it is a soft rate limit or a hard quota days out is not machine-readable and the runner will otherwise retry it on a 5-minute loop",
      ],
    });
  }
  if (evidence.timedOut) {
    return prior({
      classification: "unclear",
      confidence: "low",
      recommendation: "salvage",
      why: ["the agent hit its wall-clock timeout; whatever it built is on the branch and unjudged"],
    });
  }
  if (
    Number.isFinite(evidence.durationMs)
    && evidence.durationMs < INFRA_FAILURE_MS
    && evidence.agentExitCode !== 0
  ) {
    // One near-instant failure. The breaker needs two before it says anything,
    // so today this is silently retried as a bad ticket. It is the single most
    // valuable thing to ask about and it is not lockable, because a ticket CAN
    // fail this fast.
    return prior({
      classification: "unclear",
      confidence: "low",
      recommendation: "retry-clean",
      why: [
        `the agent exited ${evidence.agentExitCode} after ${evidence.durationMs}ms — too fast to have worked, but one task is not a cluster`,
      ],
    });
  }
  if (evidence.failedCheck) {
    return prior({
      classification: "unclear",
      confidence: "low",
      recommendation: "retry-clean",
      // A check killed at its bound is not a red one, and calling 124 an exit
      // code sends the reader after a broken assertion for a command that never
      // returned (#70). The set of causes is a different set, so it is named as
      // a different set.
      why: [
        evidence.failedCheck.timedOut
          ? `\`${evidence.failedCheck.command}\` never returned inside its bound and was killed; a check that hangs is a wedged toolchain, a prompt waiting on a human or genuinely slow work, and the runner cannot tell which`
          : `\`${evidence.failedCheck.command}\` exited ${evidence.failedCheck.code}; a failing check is a bad ticket, a broken baseline or a flake and the runner cannot tell which`,
      ],
    });
  }
  return prior({ why: ["no signal the runner can read decides this"] });
};

/**
 * Whether an event is worth a session.
 *
 * This is the cost bound, and it is one line of policy: **a locked prior needs
 * no model.** An expired login, a breaker cluster and a human gate are all
 * facts, and paying tokens to be told a fact is the failure mode that makes an
 * event-driven supervisor expensive. Everything ambiguous — which is the set the
 * role exists for — is consulted.
 *
 * `consult` overrides it: `'always'` for `afk supervise --ask`, `'never'` for a
 * dry run or an offline test.
 */
export const shouldConsult = (priorDecision, consult = "auto") => {
  if (consult === "never") return false;
  if (consult === "always") return true;
  return !priorDecision?.locked;
};

// ---------------------------------------------------------------------------
// Seam 3 — prose in, decision out
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/g;

/** The last fenced block that parses as a JSON object. See verifier.mjs. */
export const lastJsonBlock = (text) => {
  const blocks = [...String(text ?? "").matchAll(FENCE_RE)].map((match) => match[1]);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(blocks[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Not this one. A block that does not parse is prose, not an error.
    }
  }
  return null;
};

const pickString = (value, fallback = null) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;
const pickEnum = (value, allowed, fallback) =>
  allowed.includes(String(value).toLowerCase()) ? String(value).toLowerCase() : fallback;

const isoOrNull = (value) => {
  const text = pickString(value);
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/**
 * Coerce whatever the model emitted into the schema, dropping the rest.
 *
 * Actions survive as data only; they are not validated against the allowlist
 * here, because `supervisorCommands` is the single place that decides what may
 * reach a shell and two such places would eventually disagree.
 *
 * `fallback` is the runner's own prior. A classification or a recommendation
 * that is not in this event's enum is a value the model invented, and falling
 * back to the runner's reading is more honest than falling back to a constant —
 * "unclear" is not even a legal answer to "how did the epic end".
 */
export const normalizeDecision = (value, event, fallback = {}) => ({
  classification: pickEnum(
    value?.classification,
    CLASSIFICATIONS[event] ?? [],
    fallback.classification ?? "unclear",
  ),
  confidence: pickEnum(value?.confidence, CONFIDENCE, "low"),
  recommendation: pickEnum(
    value?.recommendation,
    RECOMMENDATIONS[event] ?? [],
    fallback.recommendation ?? "leave",
  ),
  reasoning: pickString(value?.reasoning, ""),
  answer: pickString(value?.answer, ""),
  resetsAt: isoOrNull(value?.resetsAt),
  wake: value?.wake === true,
  actions: (Array.isArray(value?.actions) ? value.actions : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      command: pickString(entry.command, ""),
      args: entry.args && typeof entry.args === "object" && !Array.isArray(entry.args) ? entry.args : {},
      why: pickString(entry.why),
    })),
});

/**
 * Prior + model output → the decision the runner acts on.
 *
 * The merge rule is the authority split in three lines:
 *
 * - a LOCKED prior keeps its classification and its recommendation whatever the
 *   model said, and the disagreement is recorded in `problems` rather than
 *   dropped, because a model arguing with an observed fact is worth seeing;
 * - an unlocked prior is fully overridable — that is what the session is for;
 * - the prior's `why` is always kept, so the human can see what the runner
 *   thought before the model spoke.
 */
export const mergeDecision = (priorDecision, model, event) => {
  const problems = [];
  if (!model) {
    return {
      classification: priorDecision.classification,
      confidence: priorDecision.confidence,
      recommendation: priorDecision.recommendation,
      reasoning: priorDecision.why.join("; "),
      answer: "",
      resetsAt: null,
      wake: priorDecision.recommendation === "wake-human",
      actions: [],
      problems,
      source: "runner",
    };
  }
  let { classification, recommendation } = model;
  if (priorDecision.locked) {
    if (model.classification !== priorDecision.classification) {
      problems.push(
        `the supervisor said \`${model.classification}\` against an observed \`${priorDecision.classification}\`; the observation stands`,
      );
      classification = priorDecision.classification;
    }
    if (model.recommendation !== priorDecision.recommendation) {
      problems.push(
        `the supervisor recommended \`${model.recommendation}\` against a locked \`${priorDecision.recommendation}\`; the locked reading stands`,
      );
      recommendation = priorDecision.recommendation;
    }
  }
  return {
    ...model,
    classification,
    recommendation,
    reasoning: [priorDecision.why.join("; "), model.reasoning].filter(Boolean).join(" — "),
    wake: model.wake || priorDecision.recommendation === "wake-human",
    problems,
    source: priorDecision.locked && problems.length ? "runner" : "supervisor",
  };
};

/**
 * The whole of "agent output in, decision out". Pure, total, never throws.
 *
 * `status` is about whether a JUDGMENT was obtained, never about the run:
 *
 *   ok            a schema-shaped block was found
 *   skipped       no session was run; the prior is the decision
 *   unparseable   the agent exited 0 and emitted no usable block
 *   agent_failed  the agent process exited non-zero or timed out
 *   auth_failed   the transcript says the claude login expired
 *
 * On every path other than `ok` the decision is the prior. A supervisor that
 * could not be reached costs the run nothing, which is the property that lets it
 * be wired into a hot loop at all.
 */
export const parseSupervisorOutput = ({
  event,
  prior: priorDecision,
  text = "",
  raw = "",
  agentStatus = 0,
  timedOut = false,
  skipped = false,
  meta = {},
}) => {
  const problems = [];
  let status = "ok";
  if (skipped) {
    status = "skipped";
  } else if (looksLikeAuthDeath(raw) || looksLikeAuthDeath(text)) {
    // The same policy scripts/auto.mjs and scripts/verifier.mjs hold: name it,
    // name the fix, halt nothing here. This module owns no loop to halt.
    status = "auth_failed";
    problems.push("the claude login expired (run `claude auth login`); the runner's own reading stands");
  } else if (timedOut) {
    status = "agent_failed";
    problems.push("the supervisor hit its timeout before it answered; the runner's own reading stands");
  } else if (agentStatus !== 0) {
    status = "agent_failed";
    problems.push(`the supervisor agent exited ${agentStatus}; the runner's own reading stands`);
  }

  const block = status === "ok" ? lastJsonBlock(text) : null;
  if (status === "ok" && !block) {
    status = "unparseable";
    problems.push("the supervisor produced no fenced `json` block; its prose is kept verbatim below");
  }
  const merged = mergeDecision(
    priorDecision,
    block ? normalizeDecision(block, event, priorDecision) : null,
    event,
  );
  return {
    version: SUPERVISOR_DECISION_VERSION,
    event,
    status,
    ...merged,
    prior: priorDecision,
    problems: [...merged.problems, ...problems],
    consulted: !skipped,
    evidence: meta.evidence ?? null,
    ranAt: meta.ranAt ?? new Date().toISOString(),
    durationMs: meta.durationMs ?? null,
    artifacts: meta.artifacts ?? {},
    prose: String(text ?? "").trim(),
  };
};

/**
 * The runner-owned lifecycle interpretation of a blocked-lane verdict.
 *
 * A supervisor may only make this one narrow recommendation actionable: a
 * high-confidence `no-op-ticket` with `leave` means the blocked lane is already
 * satisfied. The function is pure; `auto.mjs` owns the state mutation after it
 * has waited for the verdict.
 */
export const supervisorLifecycle = (decision, current = "blocked") => {
  if (current !== "blocked") return current;
  return isNoOpDecision(decision) ? "no-op" : current;
};

// ---------------------------------------------------------------------------
// Waking the human — through the notifier that already exists
// ---------------------------------------------------------------------------

/**
 * The notification for a decision, or null.
 *
 * This function deliberately does not notify. Two notifiers already exist
 * (`scripts/heartbeat.mjs` for stalls, `scripts/runtime-herdr.mjs` for blocked
 * lanes and auth death) and docs/notifications-and-agent-scope.md §1 is an open
 * plan to replace BOTH with one clickable `terminal-notifier` call. Adding a
 * third here would give that plan a third call site to migrate. So the
 * supervisor returns the words and the caller — which already holds a `notify`
 * — fires it:
 *
 *     const note = supervisorNotification(decision);
 *     if (note) notify(note.title, note.message);
 *
 * @returns {{title: string, message: string}|null}
 */
export const supervisorNotification = (decision) => {
  if (!decision?.wake) return null;
  const who = decision.evidence?.taskId ? `#${decision.evidence.taskId}` : "this run";
  const title = {
    lane_failed: `${who} failed — ${decision.classification}`,
    integration_failed: `${who} did not integrate — ${decision.classification}`,
    lane_blocked: `${who} is blocked`,
    gate_reached: `${who} is waiting on you`,
    epic_ended: decision.evidence?.delivery ? "epic NOT delivered" : "epic finished",
    question: "supervisor",
  }[decision.event] ?? "AFK supervisor";
  return {
    title,
    message: decision.answer || decision.reasoning || "The supervisor asked for you.",
  };
};

/** The one-line report `afk supervise` prints, matching the house style. */
export const renderSupervisorOutcome = (decision, { dagPath = null } = {}) => {
  const { commands, refused } = supervisorCommands(decision, { dagPath });
  return [
    `SUPERVISE: ${decision.event} — \`${decision.classification}\` (${decision.confidence} confidence), recommend \`${decision.recommendation}\`.`,
    `SUPERVISE: status ${decision.status}${decision.consulted ? "" : " (no session; the runner's own reading)"}.`,
    ...(decision.answer ? [`SUPERVISE: ${decision.answer}`] : []),
    ...(decision.reasoning ? [`SUPERVISE: because ${decision.reasoning}`] : []),
    ...(decision.resetsAt ? [`SUPERVISE: quota resets at ${decision.resetsAt}`] : []),
    ...commands.map((entry) => `SUPERVISE: proposes \`afk ${entry.argv.join(" ")}\`${entry.why ? ` — ${entry.why}` : ""}`),
    ...refused.map((entry) => `SUPERVISE: refused ${entry.command} — ${entry.why}`),
    ...decision.problems.map((problem) => `SUPERVISE: ⚠️ ${problem}`),
    ...(decision.wake ? ["SUPERVISE: this is worth waking you for."] : []),
    "SUPERVISE: advisory. Nothing here changed run state; the runner owns the queue and the passed/failed transitions.",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Seam 4 — running it
// ---------------------------------------------------------------------------

export const supervisorDir = (root, key) => resolve(root, ".afk", "supervisor", String(key));

/**
 * A stable name for "this exact event, again".
 *
 * A flaky suite that fails #207 three times in a row produces three identical
 * events. Without this, that is three sessions for one judgment. With it, it is
 * one session and two cache hits — and the moment anything material changes
 * (a different check fails, the attempt count moves, another task joins the
 * failure cluster) the signature changes and a fresh judgment is paid for.
 *
 * The attempt count is deliberately part of the signature only through the
 * evidence: two attempts that failed identically are the same question.
 */
export const eventSignature = (evidence) => {
  const material = {
    event: evidence.event,
    // The epic. Everything else in this hash describes a SHAPE — which event,
    // which task, what failed — and two epics with the same shape are common:
    // three tasks passed, nothing timed out, same close reason. Epic #12 closed
    // with exactly #7's shape and replayed #7's decision, so the runner
    // announced "Epic 7 is genuinely done" at the close of #12. Same failure as
    // docs/findings.md 3.12 one level up: that fix made two *outcomes* of one
    // epic distinct, and left two epics with one outcome identical.
    epic: normalizeId(evidence.epic?.id ?? evidence.epic ?? null),
    taskId: evidence.taskId ?? null,
    classification: [
      evidence.authFailure,
      evidence.timedOut,
      evidence.rateLimited,
      evidence.agentExitCode,
      evidence.failedCheck?.command ?? null,
      evidence.failedCheck?.code ?? null,
      (evidence.recentFailures ?? []).length,
      evidence.gate ?? null,
      evidence.halted ?? null,
      evidence.question ?? null,
      // The epic's outcome. Without it every `onEpicEnded` for one epic hashes
      // the same — taskId is null, no check failed, nothing timed out — so a
      // successful close REPLAYED the cached decision from an earlier failed
      // one. After the first live epic finally passed, the supervisor announced
      // "the epic closed with nothing merged... the merger never ran", which had
      // been true an hour earlier and was now the opposite of the truth
      // (docs/findings.md 3.12). A wrong summary from the component whose job is
      // explaining what happened is worse than no summary.
      evidence.tally?.status ?? null,
      evidence.tally?.reason ?? null,
      (evidence.tally?.passed ?? []).length,
      // (#179) Which tasks, not only how many. #489's end-of-epic text still
      // said "flaky email test" after that task passed: the count matched an
      // earlier failed end, so the earlier judgment was replayed. Every task's
      // lifecycle is in the key, so any move is a fresh judgment.
      evidence.tally?.failed ?? null,
      evidence.run?.tasks ?? null,
      evidence.delivery?.step ?? null,
    ],
  };
  return createHash("sha1").update(JSON.stringify(material)).digest("hex").slice(0, 12);
};

/**
 * The per-run session budget.
 *
 * docs/epic-schema.md estimates "roughly 10–20 such calls" for an 8-task epic.
 * A flaky suite can beat that estimate badly, and an epic that quietly spends
 * 200 sessions on the same failing test is the failure this cap exists for. On
 * exhaustion the supervisor does not error: it stops consulting and returns the
 * prior, which is exactly what it does when the model is down. Degraded, not
 * broken.
 */
export const SUPERVISOR_MAX_CALLS = 24;

const budgetPath = (root) => resolve(root, ".afk", "supervisor", "budget.json");

export const readBudget = (root) => {
  try {
    const value = JSON.parse(readFileSync(budgetPath(root), "utf8"));
    return { calls: Number(value?.calls) || 0, seen: value?.seen && typeof value.seen === "object" ? value.seen : {} };
  } catch {
    return { calls: 0, seen: {} };
  }
};

const maxCalls = (env = process.env) => {
  const raw = Number(env.AFK_SUPERVISOR_MAX_CALLS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SUPERVISOR_MAX_CALLS;
};

/**
 * The supervisor's permission profile as a `--settings` payload. `settingsArg`
 * renders the whole profile for any role whose sandbox names no cwd, which is
 * every read-only role — see the note on `verifierSettingsArg`.
 */
export const supervisorSettingsArg = (role, config = null) => settingsArg(role, config);

/** The effective agent invocation. `bypassPermissions: false` is the point. */
export const supervisorAgent = (role, config) => ({
  ...roleAgent(role, config),
  bypassPermissions: role.permissions.bypassPermissions ?? true,
  permissionMode: "default",
  settings: supervisorSettingsArg(role, config),
});

/**
 * Spawn the supervisor agent. The default `runAgent`; every test injects its
 * own, so no test in this repo can reach a model.
 */
export const spawnSupervisor = async ({ root, agent, promptPath, streamPath, key }) => {
  const role = roleFor("supervisor");
  // Not the project root. The cwd is the one directory Claude Code grants
  // unconditionally, and `allowWrite` cannot take that grant back — so an
  // advisory role that runs at the project root can write the run it is
  // advising on (scripts/worktree.mjs `roleCwd`, docs/findings.md 3.2). This
  // role reads logs, run state and panes, all by absolute path from its prompt,
  // so an empty directory costs it nothing. Resolved BEFORE the command is
  // built: Codex takes the same boundary from `--cd`.
  const cwdKey = `supervise-${key}`;
  const cwd = createRoleCwd({ root, key: cwdKey });
  const command = buildAgentCommand(agent, {
    nodeBin: process.execPath.replace(/\/node$/, ""),
    promptPath,
    streamPath,
    taskId: `supervise-${key}`,
    processName: role.processName(key),
    cwd: cwd ?? root,
  });
  try {
    return await runAsync(command, { cwd: cwd ?? root, timeout: agent.timeoutMs });
  } finally {
    if (cwd) removeRoleCwd({ root, key: cwdKey });
  }
};

/**
 * Judge one event.
 *
 * **Never throws**, and never blocks on the model: the prior is computed first
 * and is returned unchanged if anything at all goes wrong. A caller may treat
 * this as an ordinary function call in its hot path.
 *
 * @param {object} args
 * @param {string} args.root project root
 * @param {object} args.config .afk-setup/config.yaml
 * @param {string} args.event one of SUPERVISOR_EVENTS
 * @param {object} args.context the per-event context object (see the entry points)
 * @param {'auto'|'always'|'never'} args.consult override the cost gate
 * @param {Function} args.runAgent injected spawn seam
 * @returns {Promise<object>} the decision
 */
export const runSupervisor = async ({
  root,
  config = {},
  event,
  context = {},
  consult = "auto",
  ranAt = null,
  runAgent = spawnSupervisor,
}) => {
  if (!SUPERVISOR_EVENTS.includes(event)) {
    throw new Error(`Unknown supervisor event "${event}". Known: ${SUPERVISOR_EVENTS.join(", ")}.`);
  }
  const evidence = supervisorEvidence(event, context);
  const priorDecision = supervisorPrior(evidence);
  const signature = eventSignature(evidence);
  const key = `${evidence.taskId ?? evidence.epic?.id ?? "run"}-${signature}`;
  const meta = { evidence, ranAt: ranAt ?? new Date().toISOString() };

  const finish = (decision) => {
    try {
      ensureDir(supervisorDir(root, key));
      atomicWrite(
        resolve(supervisorDir(root, key), "decision.json"),
        `${JSON.stringify(decision, null, 2)}\n`,
      );
    } catch {
      // Writing the artifact is a convenience for the human, not part of the
      // decision. A read-only or full disk must not turn a judgment into a crash.
    }
    return decision;
  };

  // The three cheap exits, in order: cache, budget, cost gate. Each of them
  // returns a complete decision, so none of them is a failure path.
  const budget = readBudget(root);
  const cached = budget.seen?.[signature];
  if (cached && existsSync(resolve(supervisorDir(root, cached), "decision.json"))) {
    try {
      const previous = JSON.parse(readFileSync(resolve(supervisorDir(root, cached), "decision.json"), "utf8"));
      if (previous?.version === SUPERVISOR_DECISION_VERSION) {
        return { ...previous, reused: true, ranAt: meta.ranAt };
      }
    } catch {
      // A corrupt cache entry is not worth a second thought; pay for the judgment.
    }
  }
  const overBudget = budget.calls >= maxCalls();
  const willConsult = shouldConsult(priorDecision, consult) && !overBudget;
  if (!willConsult) {
    const decision = parseSupervisorOutput({ event, prior: priorDecision, skipped: true, meta });
    if (overBudget && consult !== "never") {
      decision.problems.push(
        `the supervisor's ${maxCalls()}-session budget for this run is spent; the runner's own reading stands (raise AFK_SUPERVISOR_MAX_CALLS to change that)`,
      );
    }
    return finish(decision);
  }

  const role = roleFor("supervisor");
  const dir = supervisorDir(root, key);
  ensureDir(dir);
  const promptPath = resolve(dir, "prompt.md");
  const streamPath = resolve(dir, "stream.jsonl");
  atomicWrite(
    promptPath,
    rolePrompt(role, config, {
      event,
      root,
      question: event === "question" ? evidence.question : null,
      evidence,
      prior: priorDecision,
      classifications: CLASSIFICATIONS[event] ?? [],
      recommendations: RECOMMENDATIONS[event] ?? [],
      actions: Object.keys(SUPERVISOR_ACTIONS),
      schema: SUPERVISOR_JSON_SCHEMA,
    }),
  );

  const agent = supervisorAgent(role, config);
  const startedAt = Date.now();
  let result;
  try {
    result = await runAgent({
      root,
      agent,
      promptPath,
      streamPath,
      key,
      event,
    });
  } catch (error) {
    result = { status: 1, timedOut: false, stderr: error.message };
  }
  let raw = "";
  try {
    raw = readFileSync(streamPath, "utf8");
  } catch {
    raw = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
  }
  const text = reportText(raw) || raw;

  const decision = parseSupervisorOutput({
    event,
    prior: priorDecision,
    text,
    raw,
    agentStatus: result?.status ?? 1,
    timedOut: Boolean(result?.timedOut),
    meta: {
      ...meta,
      durationMs: Date.now() - startedAt,
      artifacts: { prompt: promptPath, stream: streamPath, decision: resolve(dir, "decision.json") },
    },
  });
  // Which model(s) answered this judgment; scripts/model-check.mjs.
  decision.modelCheck = modelCheck(raw);
  try {
    ensureDir(resolve(root, ".afk", "supervisor"));
    atomicWrite(
      budgetPath(root),
      `${JSON.stringify({ calls: budget.calls + 1, seen: { ...budget.seen, [signature]: key } }, null, 2)}\n`,
    );
  } catch {
    // Same reasoning as the decision artifact: bookkeeping, not the judgment.
    // An unwritable budget file costs money, not correctness.
  }
  return finish(decision);
};

// ---------------------------------------------------------------------------
// The six event entry points
// ---------------------------------------------------------------------------
//
// One per event in docs/epic-schema.md. Each takes a plain context object of
// things the runner ALREADY HOLDS at the moment the event fires, and each is a
// single call the integrator adds at that site. None of them reads state.json,
// the DAG, or the queue; everything they know is passed in.

/**
 * A lane failed terminally (after its retries).
 *
 * Call site: `finishBuilder` in scripts/auto.mjs, in the final `else` — after
 * `recordOutcome(...)` has classified the cluster and the lifecycle has been
 * set. AFTER, so the supervisor never races the transition it does not own.
 *
 * @param {object} args
 * @param {string} args.root @param {object} args.config
 * @param {string} args.taskId @param {object} args.task the DAG task
 * @param {number} args.attempt @param {object} args.verification worker verification.json
 * @param {{taskId: string, durationMs: number}[]} args.recentFailures the breaker's window
 * @param {string} args.tail the agent's last message, if the caller has it
 */
export const onLaneFailed = ({ root, config, runAgent, consult, ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "lane_failed", context });

/**
 * An integration failed terminally.
 *
 * Call site: `finishIntegration` in scripts/auto.mjs, in the `else` branch of
 * the retry test, after `recordOutcome(taskId, true)`.
 */
export const onIntegrationFailed = ({ root, config, runAgent, consult, ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "integration_failed", context });

/**
 * A lane blocked — the builder produced no source change, or a herdr pane is
 * sitting at a prompt.
 *
 * Call site: `finishBuilder`'s `result.outcome === "blocked"` branch.
 */
export const onLaneBlocked = ({ root, config, runAgent, consult, ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "lane_blocked", context }).then((decision) => ({
    ...decision,
    lifecycle: supervisorLifecycle(decision, context.lifecycle ?? context.taskLifecycle),
  }));

/**
 * A gate is reached and the run cannot proceed past it without a human.
 *
 * Call site: the `schedulerDone` branch in auto.mjs's loop, where `gated` is
 * already computed. `gate: 'after'` is Lane L's; the context field exists so
 * that wiring is a value, not a code change.
 */
export const onGateReached = ({ root, config, runAgent, consult, ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "gate_reached", context });

/**
 * The epic ended — cleanly, or halted.
 *
 * Call site: after the loop in auto.mjs, next to the final `say(...)`.
 */
export const onEpicEnded = ({ root, config, runAgent, consult, ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "epic_ended", context });

/**
 * The human asked something.
 *
 * Call site: the CLI (`afk supervise question --question="…"`), which is where a
 * human question arrives. `consult: 'always'` because a question with no answer
 * is not an answer.
 */
export const onHumanAsked = ({ root, config, runAgent, consult = "always", ...context }) =>
  runSupervisor({ root, config, runAgent, consult, event: "question", context });

// ---------------------------------------------------------------------------
// CLI — `afk supervise <event>`
// ---------------------------------------------------------------------------

const usage = `Usage:
  node scripts/supervisor.mjs <event> [--context=<file.json>] [--question=<text>]
                                      [--task=<id>] [--dag=<path>]
                                      [--consult=auto|always|never] [--json]

  <event>  ${SUPERVISOR_EVENTS.join(" | ")}`;

const cli = async () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const root = process.cwd();
  const event = args.filter((arg) => !arg.startsWith("--"))[0];
  if (!SUPERVISOR_EVENTS.includes(event)) {
    console.error(usage);
    return 1;
  }
  let context = {};
  const contextPath = flag("context");
  if (contextPath) {
    try {
      context = JSON.parse(readFileSync(resolve(root, contextPath), "utf8"));
    } catch (error) {
      console.error(`SUPERVISE: cannot read --context=${contextPath}: ${error.message}`);
      return 1;
    }
  }
  if (flag("question")) context.question = flag("question");
  if (flag("task")) context.taskId = flag("task");
  const config = existsSync(configPath(root)) ? loadConfig(root) : {};

  const decision = await runSupervisor({
    root,
    config,
    event,
    context,
    consult: flag("consult") ?? (event === "question" ? "always" : "auto"),
  });
  if (args.includes("--json")) console.log(JSON.stringify(decision, null, 2));
  else console.log(renderSupervisorOutcome(decision, { dagPath: flag("dag") }));
  // Exit code reports whether a JUDGMENT was obtained, never what it judged. A
  // `halt` recommendation exits 0: the supervisor worked. Turning its opinion
  // into an exit code would be this module deciding an outcome it does not own.
  return decision.status === "ok" || decision.status === "skipped" ? 0 : 1;
};

if (isMainModule(import.meta.url)) {
  cli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`SUPERVISE: ${error.message}`);
      process.exitCode = 1;
    });
}
