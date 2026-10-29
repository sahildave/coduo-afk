import test from "node:test";
import assert from "node:assert/strict";
import {
  askTier,
  decideTier,
  JEV_MODEL,
  JEV_URL,
  NO_KEY_REASON,
  RISK_QUESTIONS,
  routeTasks,
  TIER_THRESHOLDS,
} from "./tier-router.mjs";

// A ticket with no risk, a named pattern, runnable criteria, small scope and a
// confident Score: the one shape that is `routine`. Each test moves one answer.
const SAFE = {
  sensitive: 0.05, format: 0.1, shared_interface: 0.2, unknown_cause: 0.05,
  pattern_named: 0.9, concrete_criteria: 0.85, scope: 0, scopeConfidence: 0.9,
};

const TASK = { id: "501", title: "Add a --json flag to afk lanes", body: "Copy scripts/status.mjs's pattern.\n\n- [ ] `node afk.mjs selftest` passes" };
const EPIC = { id: "500", title: "Machine-readable views" };

// The response shape `scripts/stack.mjs` already reads: `answers[id].noul`,
// and a Score's level with its confidence.
const jevResult = (answers = SAFE, model = "jev-1.14.2") => ({
  model,
  answers: {
    ...Object.fromEntries(Object.entries(answers)
      .filter(([id]) => id !== "scope" && id !== "scopeConfidence")
      .map(([id, value]) => [id, { noul: value }])),
    scope: { score: answers.scope, confidence: answers.scopeConfidence },
  },
});

const fakeFetch = (respond) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  return { calls, fetchImpl };
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}), text: async () => "" });

test("no risk, a named pattern and concrete criteria is routine", () => {
  assert.deepEqual(decideTier(SAFE), { tier: "routine", deciding: ["pattern_named", "concrete_criteria"] });
});

for (const id of RISK_QUESTIONS) {
  test(`${id} alone above its threshold is critical`, () => {
    const decision = decideTier({ ...SAFE, [id]: 0.9 });
    assert.equal(decision.tier, "critical");
    assert.deepEqual(decision.deciding, [id]);
  });
}

test("scope rounding to 2 is critical", () => {
  assert.deepEqual(decideTier({ ...SAFE, scope: 1.6 }), { tier: "critical", deciding: ["scope"] });
  assert.equal(decideTier({ ...SAFE, scope: 1.4 }).tier, "routine");
});

test("a Score confidence under its threshold is critical", () => {
  assert.deepEqual(decideTier({ ...SAFE, scopeConfidence: 0.5 }), { tier: "critical", deciding: ["scopeConfidence"] });
});

for (const id of ["pattern_named", "concrete_criteria"]) {
  test(`${id} missing with no risk is critical`, () => {
    assert.deepEqual(decideTier({ ...SAFE, [id]: 0.1 }), { tier: "critical", deciding: [id] });
  });
}

test("thresholds are named constants the rule reads", () => {
  assert.equal(JEV_MODEL, "jev-1.14.0", "pinned to the version the calibration run reported");
  assert.equal(TIER_THRESHOLDS.scopeConfidence, 0.6);
  for (const id of [...RISK_QUESTIONS, "pattern_named"]) assert.equal(TIER_THRESHOLDS[id], 0.5);
  assert.equal(TIER_THRESHOLDS.concrete_criteria, 0.25, "set by docs/measure/jev-calibration.md");
  assert.equal(decideTier({ ...SAFE, sensitive: 0.4 }, { ...TIER_THRESHOLDS, sensitive: 0.3 }).tier, "critical");
});

test("the request sent to Jev has state, model and typed questions with instructions and criteria", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ok(jevResult()));
  const decision = await askTier({ task: TASK, epic: EPIC, key: "k", fetchImpl });
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, JEV_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer k");
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, JEV_MODEL);
  assert.deepEqual(body.state, { ticket: { title: TASK.title, body: TASK.body }, epic: { title: EPIC.title } });
  assert.deepEqual(Object.keys(body.questions).sort(),
    ["concrete_criteria", "format", "pattern_named", "scope", "sensitive", "shared_interface", "unknown_cause"]);
  for (const [id, question] of Object.entries(body.questions)) {
    assert.equal(question.type, id === "scope" ? "score" : "noul", id);
    assert.equal(typeof question.instructions.question, "string", id);
    assert.ok(question.criteria && typeof question.criteria === "object", `${id} has criteria`);
  }
  // Jev's API takes a Score's levels as an ordered array; an object is a 422.
  assert.ok(Array.isArray(body.questions.scope.criteria), "Score levels are an ordered array");
  assert.equal(body.questions.scope.criteria.length, 3);
  assert.match(body.questions.scope.criteria[0], /One file and its test/);
  assert.match(body.questions.sensitive.instructions.question, /authentication, secrets, permissions, sandboxing or payments/);
  assert.equal(decision.tier, "routine");
  assert.equal(decision.jev.model, "jev-1.14.2", "the version Jev reports is recorded");
  assert.equal(decision.jev.answers.scopeConfidence, 0.9);
});

test("reversed Score levels are read back to their meaning", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ok(jevResult({ ...SAFE, scope: 2 })));
  const decision = await askTier({ task: TASK, key: "k", fetchImpl, reverseScores: true });
  assert.match(calls[0].body.questions.scope.criteria[0], /several areas/);
  assert.equal(decision.jev.answers.scope, 0, "level 2 of the reversed list is level 0");
  assert.equal(decision.tier, "routine");
});

for (const [label, respond, reason] of [
  ["a 429", () => status(429), /429/],
  ["a 529", () => status(529), /529/],
  ["any other status", () => status(500), /answered 500/],
  ["a thrown error", () => { throw new Error("ECONNREFUSED"); }, /could not be reached: ECONNREFUSED/],
  ["an unreadable answer", () => ok({ answers: {} }), /unreadable/],
]) {
  test(`${label} gives critical with the reason recorded`, async () => {
    const { fetchImpl } = fakeFetch(respond);
    const decision = await askTier({ task: TASK, key: "k", fetchImpl });
    assert.equal(decision.tier, "critical");
    assert.match(decision.routerSkipped, reason);
    assert.match(decision.reason, /^router skipped: /);
    assert.equal(decision.jev, null);
  });
}

test("no answer within the deadline gives critical", async () => {
  const decision = await askTier({ task: TASK, key: "k", timeoutMs: 50, fetchImpl: () => new Promise(() => {}) });
  assert.equal(decision.tier, "critical");
  assert.match(decision.routerSkipped, /did not answer within/);
});

test("a missing key gives critical and makes no request", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ok(jevResult()));
  const decision = await askTier({ task: TASK, key: undefined, fetchImpl });
  assert.equal(decision.tier, "critical");
  assert.equal(decision.routerSkipped, NO_KEY_REASON);
  assert.equal(calls.length, 0);
});

test("routing with no key writes no assignment and records why once", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ok(jevResult()));
  const state = { tasks: {} };
  const routed = await routeTasks({ tasks: [TASK, { ...TASK, id: "502" }], state, key: "", fetchImpl });
  assert.equal(routed.skipped, NO_KEY_REASON);
  assert.deepEqual(state.builderRouting, { assignments: {}, skipped: { reason: NO_KEY_REASON } });
  assert.equal(calls.length, 0);
});

test("routing writes one decision per ticket, and a failing ticket does not stop the rest", async () => {
  const { calls, fetchImpl } = fakeFetch((n) => (n === 1 ? status(429) : ok(jevResult())));
  const state = { tasks: {} };
  await routeTasks({ tasks: [TASK, { ...TASK, id: "502" }], epic: EPIC, state, key: "k", fetchImpl });
  assert.equal(calls.length, 2);
  const tiers = Object.values(state.builderRouting.assignments).map((entry) => entry.tier).sort();
  assert.deepEqual(tiers, ["critical", "routine"]);
  assert.ok(Object.values(state.builderRouting.assignments).some((entry) => /429/.test(entry.routerSkipped ?? "")));
});

test("routing keeps at most four Jev requests in flight, and every ticket still gets its decision", async () => {
  let inFlight = 0;
  let most = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return ok(jevResult());
  };
  const tasks = Array.from({ length: 12 }, (_, index) => ({ ...TASK, id: String(600 + index) }));
  const state = { tasks: {} };
  const routed = await routeTasks({ tasks, epic: EPIC, state, key: "k", fetchImpl });
  assert.ok(most <= 4, `at most four Jev requests in flight, saw ${most}`);
  assert.equal(routed.asked, 12);
  assert.deepEqual(Object.keys(state.builderRouting.assignments).sort(), tasks.map((task) => task.id));
  assert.ok(Object.values(state.builderRouting.assignments).every((entry) => entry.tier === "routine"));
});

test("a stored decision is reused and Jev is not asked again", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ok(jevResult()));
  const stored = { tier: "routine", reason: "routine: …", routerSkipped: null, jev: { model: "jev-1.14.2", answers: SAFE, deciding: [] } };
  const state = { builderRouting: { assignments: { 501: stored } }, tasks: {} };
  const routed = await routeTasks({ tasks: [TASK], state, key: "k", fetchImpl });
  assert.equal(calls.length, 0, "the fake was not called");
  assert.equal(routed.asked, 0);
  assert.equal(state.builderRouting.assignments["501"], stored);
});
