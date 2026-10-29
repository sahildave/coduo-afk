// scripts/herdr-epic-close.test.mjs — an epic's last integrator pane is closed
// when the epic closes (issue #111).
//
// `closeHerdrLane` closes a LANE's workspace at integration; the parent
// workspace hosting the integrator was never closed by anything. The only thing
// that returned its pane's agent to the shell prompt was the NEXT integrator to
// reuse it, so the epic's final integrator — with no successor — sat at its
// claude prompt forever: one orphan TUI (+ permission broker, ~420 MB) per
// closed epic, eight of them after one night on atlas-central.
//
// No live herdr: a fake `herdr` on PATH records every invocation.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHerdrEpic } from "./runtime-herdr.mjs";

const fixture = ({ registry = null, failClose = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-epic-close-"));
  const bin = join(dir, "bin");
  const log = join(dir, "herdr.log");
  mkdirSync(join(dir, ".afk"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (registry) writeFileSync(join(dir, ".afk", "herdr.json"), JSON.stringify(registry));
  writeFileSync(
    join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n');
if (${JSON.stringify(failClose)} && argv[0] === 'workspace' && argv[1] === 'close') {
  process.stderr.write(JSON.stringify({ error: { code: 'workspace_not_found' } }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ result: { type: 'ok' } }));
`,
    { mode: 0o755 },
  );
  return { dir, bin, log };
};

const calls = (fx) =>
  existsSync(fx.log) ? readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean) : [];

const withFake = async (fx, fn) => {
  const previous = process.env.PATH;
  process.env.PATH = `${fx.bin}:${previous}`;
  try { return await fn(); } finally { process.env.PATH = previous; }
};

const REGISTRY = {
  parentWorkspaceId: "wP1",
  parentPaneId: "wP1:p1",
  tasks: {},
};

test("the integrator pane is interrupted twice and its workspace closed", async () => {
  const fx = fixture({ registry: REGISTRY });
  const reaped = await withFake(fx, () => closeHerdrEpic(fx.dir));
  assert.deepEqual(reaped, { panes: 1, workspaces: 1 });
  assert.deepEqual(calls(fx), [
    "agent send-keys wP1:p1 ctrl+c",
    "agent send-keys wP1:p1 ctrl+c",
    "workspace close wP1",
  ]);
  // The registry is launch state for THIS epic's panes; once they are gone a
  // restart must not adopt ids that no longer exist.
  assert.equal(existsSync(join(fx.dir, ".afk", "herdr.json")), false);
});

// A failed or blocked lane keeps its pane beside its retained worktree so a
// human can read it (auto.mjs task cleanup). The epic close leaves it and keeps
// its registry entry; `afk finish` — which prunes the worktree — takes it too.
const WITH_LANE = { ...REGISTRY, tasks: { 7: { workspaceId: "wT7", paneId: "wT7:p1" } } };

test("the epic close leaves a retained lane's workspace and remembers it", async () => {
  const fx = fixture({ registry: WITH_LANE });
  const reaped = await withFake(fx, () => closeHerdrEpic(fx.dir));
  assert.deepEqual(reaped, { panes: 1, workspaces: 1 });
  assert.ok(!calls(fx).includes("workspace close wT7"));
  const left = JSON.parse(readFileSync(join(fx.dir, ".afk", "herdr.json"), "utf8"));
  assert.deepEqual(left, { parentWorkspaceId: null, parentPaneId: null, tasks: WITH_LANE.tasks });
});

test("afk finish closes retained lane workspaces with the parent", async () => {
  const fx = fixture({ registry: WITH_LANE });
  const reaped = await withFake(fx, () => closeHerdrEpic(fx.dir, { lanes: true }));
  assert.deepEqual(reaped, { panes: 1, workspaces: 2 });
  assert.ok(calls(fx).includes("workspace close wT7"));
  assert.equal(existsSync(join(fx.dir, ".afk", "herdr.json")), false);
});

// Null, not zeros: a direct-runtime epic has nothing herdr-side, and the
// runner's log should not mention herdr at all.
test("no registry means nothing to reap and no herdr call", async () => {
  const fx = fixture();
  assert.equal(await withFake(fx, () => closeHerdrEpic(fx.dir)), null);
  assert.deepEqual(calls(fx), []);
});

// A herdr that refuses (server gone, workspace already closed by hand) must not
// fail the close, and must not be reported as reaped.
test("a refused close is counted as not closed and never throws", async () => {
  const fx = fixture({ registry: REGISTRY, failClose: true });
  const reaped = await withFake(fx, () => closeHerdrEpic(fx.dir));
  assert.deepEqual(reaped, { panes: 1, workspaces: 0 });
});
