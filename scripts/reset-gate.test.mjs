// scripts/reset-gate.test.mjs — `afk reset` and a `gate: after` acceptance.
//
// A gate's release is a RECORD (`epicClose.acceptances[<id>]`), not an act, so
// unlike every other thing `reset` clears it does not die with the lifecycle.
// `acceptedGateIds` stops counting it once the task leaves `passed`, which is
// why this looked harmless — but the record itself survives, and now that the
// acceptance is what writes `passed`, a surviving record is a deadlock: the
// second `--accept` short-circuits on `already` without moving the task, so it
// sits in `awaiting_acceptance` forever and the epic can never close on it.
//
// A separate file because `afk selftest` discovers every `scripts/*.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AWAITING_ACCEPTANCE,
  acceptedGateIds,
  recordGateAcceptance,
  resolveGateAfterTasks,
} from "./scheduler.mjs";

const RESET = fileURLToPath(new URL("./reset-task.mjs", import.meta.url));

const dag = {
  epic: { id: "203", title: "Stripe subscriptions" },
  branch: "feat/203-stripe",
  tasks: [
    { id: "204", title: "task 204", dependsOn: [], checks: ["true"], allowedPaths: ["**"] },
    { id: "211", title: "gate 211", dependsOn: ["204"], checks: ["true"], allowedPaths: ["**"], gateAfter: true },
  ],
};

/** A run in which 204 passed and a human already accepted the gate 211. */
const acceptedState = () => ({
  epic: { id: "203" },
  branch: "feat/203-stripe",
  tasks: {
    204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 },
    211: { lifecycle: "passed", builderAttempt: 0, integrationAttempt: 0 },
  },
  integrationQueue: [],
  epicClose: {
    lifecycle: "open",
    acceptances: { 211: { at: "2026-08-19T10:00:00.000Z", by: "human", note: null } },
  },
});

const runReset = (state, ...ids) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-reset-gate-"));
  try {
    mkdirSync(join(dir, ".afk"), { recursive: true });
    writeFileSync(join(dir, ".afk/state.json"), `${JSON.stringify(state, null, 2)}\n`);
    const result = spawnSync(process.execPath, [RESET, ...ids], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(join(dir, ".afk/state.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("resetting a `gate: after` task clears its acceptance record", () => {
  const after = runReset(acceptedState(), "211");
  assert.equal(after.tasks["211"].lifecycle, "pending");
  assert.equal(after.epicClose.acceptances["211"], undefined);
});

test("`reset all` clears acceptances too, and leaves nothing to short-circuit on", () => {
  const after = runReset(acceptedState(), "all");
  assert.deepEqual(after.epicClose.acceptances, {});
});

test("a reset gate can be re-accepted, and the acceptance passes it again", () => {
  const state = runReset(acceptedState(), "211");
  // The scheduler re-admits it as a gate, not a lane: 204 is still passed.
  assert.deepEqual(resolveGateAfterTasks(dag, state), ["211"]);
  assert.equal(state.tasks["211"].lifecycle, AWAITING_ACCEPTANCE);
  assert.deepEqual(acceptedGateIds(dag, state), []);

  const outcome = recordGateAcceptance(state, { dag, id: "211", at: "2026-08-20T09:00:00.000Z" });
  // `already: true` here would be the deadlock: recorded, but never passed.
  assert.deepEqual(outcome, { ok: true, already: false });
  assert.equal(state.tasks["211"].lifecycle, "passed");
  assert.deepEqual(acceptedGateIds(dag, state), ["211"]);
});

test("resetting a task frees its worker slot, not just its lifecycle", () => {
  // docs/failure-modes.md R8. `reset` cleared the lifecycle and left the
  // `activeWorkers` entry behind, so `afk status` showed every task pending
  // while the footer still read `workers: 10, 11` — two ghosts with null pids
  // holding both slots of a `max_parallel: 2` epic. The restart admitted nobody
  // and looked, once again, like a scheduler that had simply stopped. The only
  // way out was deleting `.afk/state.json`, which is safe only when no task has
  // passed yet.
  const orphaned = () => ({
    epic: { id: "203" },
    branch: "feat/203-stripe",
    tasks: {
      204: { lifecycle: "running", builderAttempt: 1, integrationAttempt: 0 },
      211: { lifecycle: "running", builderAttempt: 1, integrationAttempt: 0 },
    },
    integrationQueue: [],
    // Null pids: the orchestrator died between the spawn and the state write,
    // which is also why `reconcileStaleState` could not kill them.
    activeWorkers: { 204: { taskId: "204", pid: null }, 211: { taskId: "211", pid: null } },
  });
  const one = runReset(orphaned(), "204");
  assert.equal(one.tasks["204"].lifecycle, "pending");
  assert.deepEqual(Object.keys(one.activeWorkers), ["211"], "only the reset task's slot freed");

  assert.deepEqual(Object.keys(runReset(orphaned(), "all").activeWorkers), []);
});
