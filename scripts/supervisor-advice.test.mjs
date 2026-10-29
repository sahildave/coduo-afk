// scripts/supervisor-advice.test.mjs — the diagnosis a human never saw.
//
// Two live epics turned on a supervisor call that was mechanically right — the
// fast-forward cause, the exact `afk reset`, and why the retry would work this
// time — and both times it existed only as one line in `.afk/agent-auto.log`,
// which nobody opens while a run is going. Its accuracy argues for a second
// surface, not for giving it the loop.
//
// A separate file because `afk selftest` discovers every `scripts/*.test.mjs`,
// so a lane adding a file cannot conflict with a lane adding another.
import test from "node:test";
import assert from "node:assert/strict";
import { supervisorAdvice, supervisorRecord } from "./scheduler.mjs";

const AT = "2026-08-20T09:00:00Z";

const DECISION = {
  event: "integration_failed",
  classification: "conflict",
  confidence: "high",
  recommendation: "retry-clean",
  answer: "The tip has advanced past #23's base, so a fresh merge produces a real commit.",
  evidence: { taskId: "23" },
};

test("a decision worth acting on is recorded, and `leave` is not", () => {
  const record = supervisorRecord(DECISION, [{ argv: ["reset", "23"], why: "the base moved" }], { at: AT, taskLifecycle: "integration_failed" });
  assert.equal(record.taskId, "23");
  assert.equal(record.recommendation, "retry-clean");
  assert.deepEqual(record.proposals, [{ command: "afk reset 23", why: "the base moved" }]);
  // `leave` with nothing proposed is the supervisor saying the run is fine.
  // Recording it would push the last real diagnosis out of view.
  assert.equal(supervisorRecord({ ...DECISION, recommendation: "leave" }, [], { at: AT }), null);
  // Unless it still wants a human, which is the whole point of `wake`.
  assert.ok(supervisorRecord({ ...DECISION, recommendation: "leave", wake: true }, [], { at: AT }));
});

test("`afk status` shows the diagnosis and the command, marked advisory", () => {
  const state = {
    supervisor: supervisorRecord(DECISION, [{ argv: ["reset", "23"], why: "the base moved" }], { at: AT, taskLifecycle: "integration_failed" }),
    tasks: { 23: { lifecycle: "integration_failed" } },
  };
  const lines = supervisorAdvice(state);
  assert.match(lines[0], /integration_failed/);
  assert.match(lines[0], /retry-clean/);
  assert.match(lines[0], /tip has advanced/);
  assert.match(lines[1], /afk reset 23/);
  // It proposes; it does not act. Saying so on the surface a human reads keeps
  // the guarantee legible rather than buried in the allowlist's source.
  assert.match(lines[1], /advisory/);
});

test("advice the run has already answered is gone, not stale", () => {
  // The failure this avoids: a note about lane 23 still on screen after the
  // retry passed, which teaches an operator to skim past the block entirely.
  // Any move off the lifecycle the diagnosis was made against counts — the
  // reset it PROPOSES lands on `pending`, so a list of "resolved" states would
  // leave its own remedy's outcome on screen forever.
  const state = {
    supervisor: supervisorRecord(DECISION, [], { at: AT, taskLifecycle: "integration_failed" }),
    tasks: { 23: { lifecycle: "passed" } },
  };
  assert.deepEqual(supervisorAdvice(state), []);
  assert.deepEqual(supervisorAdvice({ ...state, tasks: { 23: { lifecycle: "pending" } } }), []);
  // Still on the state it was diagnosed against: still live.
  assert.equal(supervisorAdvice({ ...state, tasks: { 23: { lifecycle: "integration_failed" } } }).length, 1);
  assert.deepEqual(supervisorAdvice({}), []);
});
