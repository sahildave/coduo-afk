// #73: a builder killed at agent.timeoutMs after doing real work must read as its
// own event, not as a plain builder failure — otherwise a correct ticket is marked
// DEAD after three timeouts and the operator is sent to the ticket instead of
// raising the deadline. These lock the classification (`timedOutWithWork`) and the
// operator-facing label (`timeoutOutcome`) that carry that distinction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timedOutWithWork } from "./scheduler.mjs";
import { timeoutOutcome } from "./auto.mjs";

const deadlineKillWithWork = {
  timedOut: true,
  durationMs: 899_000,
  producedFiles: ["A.swift", "B.swift", "C.swift", "D.swift", "E.swift"],
  tokens: { input: 40_000, output: 120_000, cacheRead: 1_000_000 },
};

const plainFailure = {
  timedOut: false,
  durationMs: 90_000,
  producedFiles: ["A.swift"],
  tokens: { input: 10_000, output: 5_000, cacheRead: 0 },
};

const hungWithoutWork = {
  timedOut: true,
  durationMs: 899_000,
  producedFiles: [],
  tokens: { input: 0, output: 0, cacheRead: 0 },
};

test("a deadline kill that did real work is distinguishable from a plain failure", () => {
  assert.equal(timedOutWithWork(deadlineKillWithWork), true);
  assert.equal(timedOutWithWork(plainFailure), false);
});

test("a timeout with tokens but no files still counts as real work", () => {
  assert.equal(
    timedOutWithWork({ timedOut: true, durationMs: 899_000, producedFiles: [], tokens: { input: 5, output: 5, cacheRead: 0 } }),
    true,
  );
});

test("a lane that hung having spent nothing is not a productive timeout", () => {
  assert.equal(timedOutWithWork(hungWithoutWork), false);
});

test("timeoutOutcome labels a productive timeout, naming deadline, elapsed, files and tokens", () => {
  const outcome = timeoutOutcome(deadlineKillWithWork, 900_000);
  assert.ok(outcome, "a productive timeout must produce an outcome, not null");
  assert.equal(outcome.timedOut, true);
  assert.match(outcome.note, /900000ms agent deadline/); // the configured deadline
  assert.match(outcome.note, /899000ms/); // elapsed
  assert.match(outcome.note, /5 files/); // files produced
  assert.match(outcome.note, /160000 tokens/); // 40k in + 120k out
});

test("timeoutOutcome leaves unavailable token telemetry unknown", () => {
  const outcome = timeoutOutcome({
    timedOut: true,
    durationMs: 899_000,
    producedFiles: ["source.txt"],
  }, 900_000);
  assert.match(outcome.note, /token usage unknown/);
  assert.doesNotMatch(outcome.note, /spent 0 tokens/);
});

test("timeoutOutcome returns null for a plain failure and for a hung lane", () => {
  assert.equal(timeoutOutcome(plainFailure, 900_000), null);
  assert.equal(timeoutOutcome(hungWithoutWork, 900_000), null);
});
