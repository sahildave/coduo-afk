// scripts/hub-truth.test.mjs — the hub tells the truth: a merged epic is not
// "parked at a gate", the epic filter reads `owner/repo#n`, a run is found from
// the root it recorded at start, and a stale artifact says so.
// `gh` is a shim on PATH; nothing real is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setup = (ghBody) => {
  const home = mkdtempSync(join(tmpdir(), "afk-truth-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "gh"), `#!/bin/sh\n${ghBody}\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, AFK_COS_ROOT: join(home, "cos"), AFK_HUB_PEER_PORTS: "", PATH: `${join(home, "bin")}:${process.env.PATH}` };
  delete env.AFK_COS_PEERS;
  return { home, env };
};

// An exited checkout parked at a gate, recorded as started so listRuns finds it.
const parked = async (m, name) => {
  const root = join(m.home, "repos", name);
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({
    dag: { epic: { id: "33", title: "x" }, branch: `feat/${name}`, tasks: [{ id: "35" }] },
    tasks: { 35: { lifecycle: "awaiting_acceptance" } },
    dashboard: null,
  }));
  const { recordStartedRoot } = await import("./hub/runs.mjs");
  recordStartedRoot(root, m.env);
  return root;
};

test("an exited run parked at a gate whose PR merged is listed closed, with no gates", async () => {
  const m = setup(`echo '{"state":"MERGED","number":36}'`);
  await parked(m, "merged-run");
  const { listRuns } = await import("./hub/runs.mjs");
  const [run] = await listRuns(m.env);
  assert.deepEqual([run.status, run.gates, run.pr], ["closed", [], { state: "MERGED", number: 36 }]);
});

test("an open PR, or gh failing, leaves the run waiting for you", async () => {
  for (const [name, body] of [["open-pr", `echo '{"state":"OPEN","number":9}'`], ["gh-fails", "exit 1"]]) {
    const m = setup(body);
    await parked(m, name);
    const { listRuns } = await import("./hub/runs.mjs");
    const [run] = await listRuns(m.env);
    assert.deepEqual([run.status, run.gates], ["waits for you", ["35"]], name);
  }
});

test("a run that exited before its first check-in is listed from the root it recorded at start (#49)", async () => {
  const m = setup("exit 1");
  const root = await parked(m, "early-exit");
  const { storeRoots } = await import("./hub/runs.mjs");
  assert.deepEqual(storeRoots(m.env), [root]);
});

test("scopedRuns reads owner/repo#n epics and epicRefs (#49)", async () => {
  const { scopedRuns } = await import("./hub/snapshot.mjs");
  const runs = [{ project: "sticky-notes", epic: "2" }, { project: "other", epic: "2" }, { project: "sticky-notes", epic: "3" }];
  const old = { meta: { epics: ["sahildave/sticky-notes#2"] }, events: [] };
  assert.deepEqual(scopedRuns(runs, old).map((r) => r.project + r.epic), ["sticky-notes2"]);
  const bare = { meta: { epics: ["2"] }, events: [] };
  assert.equal(scopedRuns(runs, bare).length, 2, "a bare number still matches any project");
  const refs = { meta: { epics: ["x#2"], epicRefs: [{ project: "sticky-notes", epic: 3 }] }, events: [] };
  assert.deepEqual(scopedRuns(runs, refs).map((r) => r.project + r.epic), ["sticky-notes3"]);
});

test("a snapshot older than 90 minutes draws the stale banner; a fresh one does not", async () => {
  const { drawSnapshot } = await import("./hub/artifact-draw.mjs");
  const now = Date.parse("2026-11-15T12:00:00Z");
  const at = (min) => new Date(now - min * 60_000).toISOString();
  assert.match(drawSnapshot({ at: at(360), runs: [] }, { now }), /This page is 6 h old\. The chief of staff has stopped updating it\./);
  assert.doesNotMatch(drawSnapshot({ at: at(30), runs: [] }, { now }), /has stopped updating/);
});
