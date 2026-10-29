#!/usr/bin/env node
// Slice-0 demo: drive a mock task DAG through visible herdr workspaces.
// No real agents, no worktrees, no API cost — this only proves the pane
// plumbing: workspace-per-task, live progress titles, completion detection
// via an output sentinel, and a serialized integrator pane.
//
//   node scripts/herdr-demo.mjs        run the demo (open herdr to watch)
//
// Workspaces are left open for inspection; close commands print at the end.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TASKS = {
  204: { title: "Stripe checkout", deps: [], secs: 2 },
  205: { title: "Onboarding flow", deps: [204], secs: 3 },
  206: { title: "Entitlement cache", deps: [204], secs: 2 },
  207: { title: "Billing settings", deps: [204], secs: 4 },
  208: { title: "Lifecycle emails", deps: [205, 206], secs: 2 },
  209: { title: "Analytics events", deps: [205, 206, 207], secs: 2 },
};
const MAX_PARALLEL = 3;

const log = (msg) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

async function herdr(...args) {
  const { stdout } = await exec("herdr", args);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

// --panes: one shared workspace with a pane per task, instead of a
// workspace per task. Same scheduling, different layout for comparison.
const PANES = process.argv.includes("--panes");
let sharedWorkspace = null;
let lastPane = null;
let laneCount = 0;

async function createWorkspace(label) {
  const res = await herdr(
    "workspace", "create", "--cwd", ROOT, "--label", label, "--no-focus",
  );
  return {
    workspaceId: res.result.workspace.workspace_id,
    paneId: res.result.root_pane.pane_id,
  };
}

async function createLane(label) {
  if (!PANES) return createWorkspace(label);
  if (!sharedWorkspace) {
    sharedWorkspace = await createWorkspace("AFK · epic demo");
    lastPane = sharedWorkspace.paneId;
    await herdr("pane", "rename", lastPane, label);
    return { workspaceId: sharedWorkspace.workspaceId, paneId: lastPane };
  }
  const dir = laneCount++ % 2 === 0 ? "right" : "down";
  const res = await herdr(
    "pane", "split", lastPane, "--direction", dir, "--cwd", ROOT,
  );
  const paneId = res.result.pane.pane_id;
  lastPane = paneId;
  await herdr("pane", "rename", paneId, label);
  return { workspaceId: sharedWorkspace.workspaceId, paneId };
}

// Herdr `pane wait-output` has no default timeout; always bound it ourselves.
async function waitFor(paneId, regex, timeoutMs) {
  // Note: herdr 0.8.0 requires the pane ID before the options here,
  // despite what `--help` prints.
  await herdr(
    "pane", "wait-output", paneId, "--regex", regex, "--timeout", String(timeoutMs),
  );
}

const passed = new Set();
const started = new Set();
const opened = [];

// Integration is serialized: each merge chains onto the previous one.
let integrator;
let mergeChain = Promise.resolve();
function integrate(id) {
  mergeChain = mergeChain.then(async () => {
    log(`#${id} integrating`);
    await herdr("pane", "run", integrator.paneId,
      "sh", "scripts/herdr-demo-worker.sh", "merge", String(id));
    await waitFor(integrator.paneId, `AFK_MERGED_${id}`, 60_000);
    passed.add(id);
    log(`#${id} passed (integrated)`);
  });
  return mergeChain;
}

async function runTask(id) {
  const { title, secs } = TASKS[id];
  const ws = await createLane(`#${id} · ${title}`);
  opened.push(ws);
  log(`#${id} running in workspace ${ws.workspaceId} (${title})`);
  await herdr("pane", "run", ws.paneId,
    "sh", "scripts/herdr-demo-worker.sh", String(id), String(secs));
  await waitFor(ws.paneId, `AFK_TASK_DONE_${id}`, 120_000);
  log(`#${id} worker done, queueing integration`);
  await integrate(id);
}

const ready = () =>
  Object.keys(TASKS).map(Number).filter(
    (id) => !started.has(id) && TASKS[id].deps.every((d) => passed.has(d)),
  );

async function main() {
  integrator = await createLane("integrator");
  opened.push(integrator);
  log(`integrator workspace ${integrator.workspaceId} ready`);
  log(`scheduling ${Object.keys(TASKS).length} tasks, maxParallel=${MAX_PARALLEL}`);

  const inflight = new Map();
  while (passed.size < Object.keys(TASKS).length) {
    for (const id of ready()) {
      if (inflight.size >= MAX_PARALLEL) break;
      started.add(id);
      inflight.set(id, runTask(id).then(() => inflight.delete(id)));
    }
    if (inflight.size === 0) throw new Error("deadlock: nothing ready, nothing running");
    await Promise.race(inflight.values());
  }

  log("all tasks passed");
  console.log("\nWorkspaces left open for inspection. Close with:");
  for (const wid of new Set(opened.map((ws) => ws.workspaceId)))
    console.log(`  herdr workspace close ${wid}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
