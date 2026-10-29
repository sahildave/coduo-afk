// The tier router (#294). Before the first lane starts, the runner asks Jev
// (TypeSafe System One) a handful of atomic questions about each executable
// ticket, and turns the answers into a tier HERE, in code: `critical` builds on
// Opus, `routine` on Sonnet or Codex by quota (scripts/builder-routing.mjs).
// Jev observes; it never picks the tier. The wide question — "is this ticket
// hard?" — is the one a model is worst at, so it is never asked.
//
// FAIL DIRECTION: toward `critical`. No key, a 429/529, any error, an
// unreadable answer, or no answer within 20 seconds makes that ticket
// `critical`, which is what every ticket was before the router existed. A
// wrongly-`critical` ticket costs Opus tokens; a wrongly-`routine` one costs a
// failed lane and a retry, so the router only says `routine` when every
// observation it needs is present and points that way.

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Pinned to the version the calibration run reported
// (docs/measure/jev-calibration.md). An alias moves under the thresholds.
export const JEV_MODEL = "jev-1.14.0";
export const JEV_TIMEOUT_MS = 20_000;

/**
 * The policy, set from the calibration run on 44 real tickets: see
 * docs/measure/jev-calibration.md for why each value is what it is.
 */
export const TIER_THRESHOLDS = {
  sensitive: 0.5,
  format: 0.5,
  shared_interface: 0.5,
  unknown_cause: 0.5,
  pattern_named: 0.5,
  concrete_criteria: 0.25,
  scopeConfidence: 0.6,
};

// Any one of these above its threshold makes the ticket `critical`.
export const RISK_QUESTIONS = ["sensitive", "format", "shared_interface", "unknown_cause"];
// Both of these above threshold are what a `routine` ticket needs.
export const ROUTINE_QUESTIONS = ["pattern_named", "concrete_criteria"];

const NOULS = {
  sensitive: "Does the work described in `ticket.body` change authentication, secrets, permissions, sandboxing or payments?",
  format: "Does the work described in `ticket.body` change a stored data schema, a file format the program writes, or the shape of a public CLI command or API?",
  shared_interface: "Does the work described in `ticket.body` change a function, module or interface that other modules call, as opposed to code used only inside the files it names?",
  pattern_named: "Does the ticket in `ticket.body` name an existing file, function or test to copy or follow?",
  concrete_criteria: "Is every acceptance criterion in `ticket.body` a command or assertion someone could run and see pass or fail?",
  unknown_cause: "Is the ticket in `ticket.body` a bug fix where the ticket does not state what causes the bug?",
};

export const SCOPE_LEVELS = [
  "One file and its test.",
  "Several files in one area of the program.",
  "Changes across several areas of the program.",
];
const SCOPE_TOP = SCOPE_LEVELS.length - 1;

/**
 * The questions, keyed by id, in the shape `scripts/stack.mjs` already sends.
 * `reverseScores` presents the Score's levels top-down, so the calibration run
 * can see whether the answer follows the meaning or the position.
 */
export const tierQuestions = ({ reverseScores = false } = {}) => {
  const questions = {};
  for (const [id, question] of Object.entries(NOULS)) {
    questions[id] = {
      type: "noul",
      instructions: { question, answer_about: "ticket.body" },
      criteria: { true: "Yes, as the question describes.", false: "No." },
    };
  }
  const levels = reverseScores ? [...SCOPE_LEVELS].reverse() : SCOPE_LEVELS;
  questions.scope = {
    type: "score",
    instructions: { question: "How much of the program does the work described in `ticket.body` change?", answer_about: "ticket.body" },
    // An ordered array: Jev answers 422 to a Score whose levels are an object.
    criteria: levels,
  };
  return questions;
};

export const tierState = ({ task, epic = null }) => ({
  ticket: { title: task?.title ?? "", body: task?.body ?? "" },
  epic: { title: epic?.title ?? "" },
});

export const tierRequest = ({ task, epic = null, model = JEV_MODEL, reverseScores = false }) => ({
  state: tierState({ task, epic }),
  model,
  questions: tierQuestions({ reverseScores }),
});

const probability = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);

/**
 * The answers as plain numbers, or a throw naming the first one that is
 * missing. A partial answer is not read as "the rest were false": the caller
 * turns the throw into `critical`.
 */
export const readTierAnswers = (result, { reverseScores = false } = {}) => {
  const answers = result?.answers ?? {};
  const confidences = result?.providerMetadata?.typesafe?.confidence ?? {};
  const out = {};
  for (const id of Object.keys(NOULS)) {
    const value = probability(answers[id]?.noul);
    if (value === null) throw new Error(`no Noul probability for \`${id}\``);
    out[id] = value;
  }
  const scope = answers.scope ?? {};
  const raw = Number(scope.score ?? scope.choice);
  if (!Number.isFinite(raw) || raw < 0 || raw > SCOPE_TOP) throw new Error("no Score for `scope`");
  const confidence = probability(scope.confidence ?? confidences.scope);
  if (confidence === null) throw new Error("no Score confidence for `scope`");
  out.scope = reverseScores ? SCOPE_TOP - raw : raw;
  out.scopeConfidence = confidence;
  return out;
};

const round = (value) => Math.round(value * 100) / 100;

/**
 * The combining rule. Returns the tier and the answer ids that decided it, so
 * the routing row can show WHY, not just what.
 */
export const decideTier = (answers, thresholds = TIER_THRESHOLDS) => {
  const risks = RISK_QUESTIONS.filter((id) => answers[id] > thresholds[id]);
  const deciding = [...risks];
  if (Math.round(answers.scope) >= SCOPE_TOP) deciding.push("scope");
  if (!(answers.scopeConfidence >= thresholds.scopeConfidence)) deciding.push("scopeConfidence");
  if (deciding.length) return { tier: "critical", deciding };
  const missing = ROUTINE_QUESTIONS.filter((id) => !(answers[id] > thresholds[id]));
  return missing.length
    ? { tier: "critical", deciding: missing }
    : { tier: "routine", deciding: [...ROUTINE_QUESTIONS] };
};

/** `sensitive 0.91, scope 2 (confidence 0.80)`: the deciding answers, and the Score's confidence always. */
export const describeAnswers = (answers, deciding = []) => {
  if (!answers) return null;
  const parts = deciding
    .filter((id) => id !== "scope" && id !== "scopeConfidence")
    .map((id) => `${id} ${round(answers[id]).toFixed(2)}`);
  parts.push(`scope ${round(answers.scope)} (confidence ${round(answers.scopeConfidence).toFixed(2)})`);
  return parts.join(", ");
};

export const NO_KEY_REASON = "no TYPESAFE_API_KEY in the runner's environment";

const skipped = (reason) => ({
  tier: "critical",
  reason: `router skipped: ${reason}`,
  routerSkipped: reason,
  jev: null,
});

/**
 * One ticket, one request, no retry: a 429 at launch is not worth a minute of
 * every lane's start, and `critical` is the safe answer. Never throws.
 */
export const askTier = async ({
  task,
  epic = null,
  key,
  fetchImpl = fetch,
  timeoutMs = JEV_TIMEOUT_MS,
  model = JEV_MODEL,
  thresholds = TIER_THRESHOLDS,
  reverseScores = false,
}) => {
  if (!key) return skipped(NO_KEY_REASON);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveDeadline({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const call = (async () => {
      const response = await fetchImpl(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(tierRequest({ task, epic, model, reverseScores })),
        signal: controller.signal,
      });
      if (!response.ok) return { status: response.status };
      return { result: await response.json() };
    })();
    const outcome = await Promise.race([call, deadline]);
    if (outcome.timedOut) return skipped(`Jev did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    if (outcome.status === 429) return skipped("Jev answered 429 (rate limited)");
    if (outcome.status === 529) return skipped("Jev answered 529 (overloaded)");
    if (outcome.status) return skipped(`Jev answered ${outcome.status}`);
    let answers;
    try {
      answers = readTierAnswers(outcome.result, { reverseScores });
    } catch (error) {
      return skipped(`Jev's answer was unreadable: ${error.message}`);
    }
    const { tier, deciding } = decideTier(answers, thresholds);
    return {
      tier,
      reason: `${tier}: ${describeAnswers(answers, deciding)}`,
      routerSkipped: null,
      jev: { model: outcome.result?.model ?? model, answers, deciding },
    };
  } catch (error) {
    return skipped(controller.signal.aborted
      ? `Jev did not answer within ${Math.round(timeoutMs / 1000)} seconds`
      : `Jev could not be reached: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
};

// Jev rate-limits a burst, and a 429 makes a ticket `critical`: every batch of
// asks runs through this pool, never `Promise.all` over the whole list.
export const JEV_CONCURRENCY = 4;

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Ask about every ticket that has no stored routing decision, and write each
 * answer into `state.builderRouting.assignments`. A task that already has an
 * assignment — the router's own, kept from an earlier start, or one written by
 * hand — is never asked again: a resumed run reuses the stored decision.
 *
 * With no key nothing is written per task and every lane launches exactly as
 * it did before the router existed; `state.builderRouting.skipped` says why,
 * once, for `afk status`.
 */
export const routeTasks = async ({ tasks, epic = null, state, key, fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS }) => {
  const routing = (state.builderRouting ??= {});
  const assignments = (routing.assignments ??= {});
  const pending = tasks.filter((task) => !assignments[task.id]);
  if (!pending.length) return { asked: 0, reused: tasks.length, skipped: routing.skipped?.reason ?? null };
  if (!key) {
    routing.skipped = { reason: NO_KEY_REASON };
    return { asked: 0, reused: tasks.length - pending.length, skipped: NO_KEY_REASON };
  }
  delete routing.skipped;
  const decisions = await mapLimit(pending, JEV_CONCURRENCY, (task) => askTier({ task, epic, key, fetchImpl, timeoutMs }));
  for (const [index, task] of pending.entries()) assignments[task.id] = decisions[index];
  return { asked: pending.length, reused: tasks.length - pending.length, skipped: null, decisions: Object.fromEntries(pending.map((task, index) => [task.id, decisions[index]])) };
};
