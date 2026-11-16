import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaneAdmission, maxLanesMachine, registerLane, releaseLane } from "./lane-admission.mjs";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "afk-lanes-")));
// Other runners' lane files: a fake pid that `alive` says is live.
const otherLane = (dir, pid, project, epic, task) => writeFileSync(
  join(dir, `${pid}.${project}.${epic}.${task}.json`),
  `${JSON.stringify({ pid, project, epic: String(epic), taskId: task })}\n`,
);
const make = (dir, over = {}) => {
  const lines = [];
  let t = 0;
  const admission = createLaneAdmission({
    config: {}, env: {}, dir, say: (l) => lines.push(l), load: () => 0, pressure: () => 1, cores: 12,
    alive: (pid) => pid < 90000, startedAt: () => null, now: () => (t += 10_000), ...over,
  });
  return { admission, lines };
};

test("the cap counts lanes across other epics' runners", () => {
  const dir = scratch();
  for (let i = 0; i < 3; i += 1) otherLane(dir, 1000, "a", 1, `t${i}`);
  for (let i = 0; i < 3; i += 1) otherLane(dir, 2000, "b", 2, `t${i}`);
  const { admission } = make(dir, { env: { AFK_MAX_LANES_MACHINE: "8" } });
  assert.equal(admission.machineSlots(0), 2);
  assert.equal(admission.machineSlots(1), 1);
  assert.equal(admission.machineSlots(2), 0);
});

test("a lane file with a dead pid is ignored and removed", () => {
  const dir = scratch();
  otherLane(dir, 1000, "a", 1, "t1");
  otherLane(dir, 99999, "b", 2, "t1");
  const { admission } = make(dir);
  assert.equal(admission.machineSlots(0), 7);
  assert.deepEqual(readdirSync(dir).length, 1);
});

test("own lanes register and release a file", () => {
  const dir = scratch();
  const file = registerLane({ dir, project: "p", epic: 3, taskId: "T-1" });
  assert.equal(readdirSync(dir).length, 1);
  releaseLane(file);
  assert.equal(readdirSync(dir).length, 0);
});

test("memory pressure warn closes admission", () => {
  const { admission, lines } = make(scratch(), { pressure: () => 2 });
  assert.equal(admission.machineSlots(0), 0);
  assert.match(lines[0], /lane admission closed: memory pressure warn \(1 epics, 0 machine lanes\)\. Waiting\./);
});

test("load at the core count closes admission", () => {
  const { admission } = make(scratch(), { load: () => 12 });
  assert.equal(admission.machineSlots(0), 0);
});

test("reopens after 3 clean readings, not 2", () => {
  let level = 4;
  const { admission, lines } = make(scratch(), { pressure: () => level });
  assert.equal(admission.machineSlots(0), 0);
  level = 1;
  assert.equal(admission.machineSlots(0), 0);
  assert.equal(admission.machineSlots(0), 0);
  assert.equal(admission.machineSlots(0), 8);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /reopened/);
});

test("an unreadable sysctl fails open", () => {
  const { admission } = make(scratch(), { pressure: () => null });
  assert.equal(admission.machineSlots(0), 8);
});

test("off disables the cap and the checks", () => {
  assert.equal(maxLanesMachine({}, { AFK_MAX_LANES_MACHINE: "off" }), null);
  assert.equal(maxLanesMachine({ maxLanesMachine: false }, {}), null);
  assert.equal(maxLanesMachine({ maxLanesMachine: 4 }, { AFK_MAX_LANES_MACHINE: "6" }), 6);
  const { admission } = make(scratch(), { env: { AFK_MAX_LANES_MACHINE: "off" }, pressure: () => 4 });
  assert.equal(admission.machineSlots(5), Infinity);
});
