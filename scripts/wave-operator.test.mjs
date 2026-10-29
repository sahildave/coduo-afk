import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptWaveTask, stopWaveRun, waveLogPath } from "./wave.mjs";
import { fastForwardDecision, taskLedger, waveFrontier } from "./wave-driver.mjs";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "afk-wave-operator-"));
  cpSync(fileURLToPath(new URL("./fixtures/wave/accepted", import.meta.url)), join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".afk-setup"));
  writeFileSync(join(root, ".afk-setup", "config.yaml"), "defaultChecks:\n  - swift test\n");
  return root;
};

test("wave accept releases a blocked task and resume does not schedule it", () => {
  const root = fixture();
  try {
    writeFileSync(waveLogPath(join(root, "tasks")), JSON.stringify({
      version: 1, base: "main", waves: [{ id: "wave-01", outcome: "failed", tasks: {
        "task-01-model": { outcome: "blocked", attempts: 1 },
        "task-02-picker": { outcome: "passed", attempts: 1 },
      } }],
    }));
    assert.equal(acceptWaveTask({ root, dir: "tasks", taskId: "task-01-model", say: () => {} }), 0);
    const log = JSON.parse(readFileSync(waveLogPath(join(root, "tasks")), "utf8"));
    const ledger = taskLedger(log);
    assert.equal(ledger["task-01-model"].outcome, "no-op");
    assert.equal(fastForwardDecision({ waveTasks: ["task-01-model", "task-02-picker"], ledger, isAncestor: true }).allowed, true);
    const dag = { tasks: [{ id: "task-01-model", dependsOn: [] }, { id: "task-03-docs", dependsOn: ["task-01-model"] }] };
    assert.deepEqual(waveFrontier({ dag, ledger }), ["task-03-docs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wave accept refuses and names an unknown task id", () => {
  const root = fixture();
  try {
    const lines = [];
    assert.equal(acceptWaveTask({ root, dir: "tasks", taskId: "missing-id", say: (line) => lines.push(line) }), 1);
    assert.match(lines.join("\n"), /missing-id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wave stop reports every fate and refuses without run state", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-wave-stop-"));
  try {
    const missing = [];
    assert.equal(stopWaveRun({ root, say: (line) => missing.push(line) }), 1);
    assert.match(missing.join("\n"), /no run state/);
    mkdirSync(join(root, ".afk"));
    writeFileSync(join(root, ".afk", "state.json"), "{}");
    const lines = [];
    const rows = [
      { pid: 11, role: "builder", taskId: "a", fate: "stopped after SIGTERM" },
      { pid: 12, role: "integrator", taskId: "b", fate: "still running after SIGTERM" },
    ];
    assert.equal(stopWaveRun({ root, say: (line) => lines.push(line), teardown: () => rows }), 0);
    assert.match(lines.join("\n"), /pid 11.*stopped/);
    assert.match(lines.join("\n"), /pid 12.*still running/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
