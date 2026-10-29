// scripts/hub/runs.mjs — every run on this machine, for the hub and the handoff (#229).
//
// Three sources, in order:
//   1. `/peers`: every dashboard answering `/health` in 4100-4499
//      (`discoverDashboards`, the same sweep the dashboards' own `/peers` makes).
//   2. The fallback: a checkout the store knows (a run's `adopted` list, a
//      check-in's `runs`) that the sweep did not find. Its `.afk/state.json`
//      records `dashboard.port`, which is probed on its own; a run started
//      with an explicit port outside the range is found this way. A recorded
//      port nobody answers on is still listed, as `not answering`. A run
//      whose dashboard failed to start records no port, only
//      `dashboardSkipped` (#277): it is listed as `no dashboard`, with
//      `port` and `dashboard` null. A run that has exited with an open gate
//      (`openGates`: a `gate: after` task awaiting acceptance, or a
//      `gate: before` task whose dependencies are done) is listed as
//      `waits for you`, those task ids its `gates`. A run whose epic closed
//      less than 24 h ago is listed as `closed`, so the hub artifact still
//      draws its card with a "closed" pill and a late comment on it resolves (#274). Any
//      other exited run is not listed.
//   3. The no-dashboard record (#279): a run whose dashboard failed is no
//      peer, and in a checkout no chief of staff has seen the store does not
//      know it either. `runAuto` adds its root to `no-dashboard.json` in the
//      store's directory when it carries on without a dashboard, and removes
//      it on every exit. A recorded root is listed, as `no dashboard`, only
//      while its state still says `dashboardSkipped`: a run killed hard
//      leaves its root recorded and its state stale, and the state decides.
//
// Read only, but for the record: nothing else here writes `.afk/` or the store.
//
// Test seams: AFK_COS_PEERS (a JSON file standing in for the sweep, as the
// check-in reads it) and AFK_HUB_PEER_PORTS (a comma list of ports to probe in
// place of the range, so a test exercises the real probe on its own ports).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { discoverDashboards } from "../dashboard-process.mjs";
import { cosRoot, nowMs, readEvents } from "../cos/store.mjs";

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const real = (path) => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

const sweep = async (env) => {
  if (env.AFK_COS_PEERS) return readJson(env.AFK_COS_PEERS) ?? [];
  if (env.AFK_HUB_PEER_PORTS != null) {
    const ports = env.AFK_HUB_PEER_PORTS.split(",").map(Number).filter((port) => port > 0);
    return (await Promise.all(ports.map((port) => discoverDashboards({ start: port, span: 1 })))).flat();
  }
  return discoverDashboards();
};

/** Every checkout root the store has seen: adopted runs and check-in rows, newest store run first. */
export const storeRoots = (env = process.env) => {
  const root = cosRoot(env);
  if (!existsSync(root)) return [];
  const roots = [];
  for (const id of readdirSync(root).sort().reverse()) {
    const dir = join(root, id);
    const meta = readJson(join(dir, "run.json"));
    if (!meta) continue;
    for (const adopted of meta.adopted ?? []) if (adopted?.root) roots.push(adopted.root);
    for (const event of readEvents(dir).events) {
      if (event.kind === "checkin") for (const run of event.runs ?? []) if (run?.root) roots.push(run.root);
    }
  }
  return [...new Set(roots)];
};

// A file, not a run folder: `storeRoots` skips an entry with no `run.json`.
const noDashboardPath = (env) => join(cosRoot(env), "no-dashboard.json");

/** The checkout roots the no-dashboard record names. */
const noDashboardRoots = (env) => {
  const roots = readJson(noDashboardPath(env));
  return Array.isArray(roots) ? roots.filter((root) => typeof root === "string") : [];
};

// Through a rename, so a reader never sees half a file.
const writeNoDashboard = (roots, env) => {
  const path = noDashboardPath(env);
  mkdirSync(cosRoot(env), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(roots, null, 2)}\n`);
  renameSync(`${path}.${process.pid}.tmp`, path);
};

/** Add a checkout root to the no-dashboard record. Throws on a failed write. */
export const recordNoDashboard = (root, env = process.env) => {
  const roots = noDashboardRoots(env).filter((known) => real(known) !== real(root));
  writeNoDashboard([...roots, root], env);
};

/** Remove a checkout root from the no-dashboard record. Throws on a failed write. */
export const forgetNoDashboard = (root, env = process.env) => {
  const roots = noDashboardRoots(env);
  const kept = roots.filter((known) => real(known) !== real(root));
  if (kept.length !== roots.length) writeNoDashboard(kept, env);
};

/**
 * An epic as its id string, or null. A real `.afk/state.json` records
 * `dag.epic` as `{id, title}`, and `/health` passes it through as it is;
 * older fixtures and the store carry a bare string or number.
 */
export const epicId = (epic) => {
  const id = epic != null && typeof epic === "object" ? epic.id : epic;
  return id != null ? String(id) : null;
};

/**
 * The `gate: after` tasks awaiting acceptance and the `gate: before` tasks
 * whose dependencies are done. Here, not in checkin.mjs, because checkin.mjs
 * imports this module; checkin.mjs re-exports it.
 */
export const openGates = (state) => {
  const lifecycle = (id) => state?.tasks?.[id]?.lifecycle ?? "pending";
  const done = (id) => ["passed", "no-op"].includes(lifecycle(id));
  return (state?.dag?.tasks ?? [])
    .filter((task) => lifecycle(task.id) === "awaiting_acceptance"
      || (task.humanGated && lifecycle(task.id) === "pending" && (task.dependsOn ?? []).every(done)))
    .map((task) => String(task.id));
};

/**
 * A run that is building: `running`, or `no dashboard`, a running epic whose
 * dashboard did not start (#277). The check-in's stall check and the hub
 * snapshot's lane cap both read it.
 */
export const isLive = (run) => run?.status === "running" || run?.status === "no dashboard";

// How long a closed run stays on the list: artifact-draw.mjs draws a run
// closed less than this before the snapshot's `at`.
const CLOSED_KEPT_MS = 24 * 60 * 60 * 1000;

/** The run id the hub anchors comments on: `<project>#<epic>`. */
export const runId = (run) => `${run.project || basename(run.root || "") || "?"}#${run.epic ?? "?"}`;

/**
 * `[{root, port, project, epic, branch, status, progress, counts, source, dashboard}]`.
 * `source` is `peers` or `state.json`; `dashboard` is the run's own URL.
 * `counts` is `/health`'s tasks per phase (#244), passed through on both
 * paths; absent from a dashboard running older code, null when not answering.
 */
export const listRuns = async (env = process.env) => {
  const found = (await sweep(env)).filter((peer) => peer?.root)
    .map((peer) => ({ ...peer, source: "peers" }));
  const seen = new Set(found.map((peer) => real(peer.root)));
  for (const root of storeRoots(env)) {
    if (seen.has(real(root))) continue;
    seen.add(real(root));
    const state = readJson(join(root, ".afk", "state.json"));
    const port = Number(state?.dashboard?.port);
    const recorded = {
      root,
      project: basename(root),
      epic: state?.dag?.epic ?? null,
      branch: state?.dag?.branch ?? null,
      status: "not answering",
      progress: null,
      counts: null,
    };
    if (!port) {
      // A runner that exits clears `dashboard` (#277). An epic parked at a
      // gate has exited too, and the owner still has to answer it. The gates
      // are the check-in's own (`openGates`), so both count the same ones.
      const gates = openGates(state);
      // Fail direction: CLOSED. A missing or unparsable `closedAt` leaves the
      // run off the list rather than on it forever; a closed run missing
      // from the hub is the error the owner can still see in `afk status`.
      const close = state?.epicClose;
      const closedMs = close?.lifecycle === "closed" ? Date.parse(close.closedAt ?? "") : NaN;
      const recentlyClosed = nowMs(env) - closedMs < CLOSED_KEPT_MS;
      if (state?.dashboardSkipped) found.push({ ...recorded, status: "no dashboard", port: null, source: "state.json" });
      else if (gates.length) found.push({ ...recorded, status: "waits for you", gates, port: null, source: "state.json" });
      else if (recentlyClosed) found.push({ ...recorded, status: "closed", port: null, source: "state.json" });
      continue;
    }
    const [answer] = await discoverDashboards({ start: port, span: 1 });
    // The answer's own `root` is the dashboard's checkout, which may be a
    // different spelling of this one; the store's root is the one we know.
    found.push({ ...recorded, ...(answer ?? {}), root, port, source: "state.json" });
  }
  for (const root of noDashboardRoots(env)) {
    if (seen.has(real(root))) continue;
    seen.add(real(root));
    const state = readJson(join(root, ".afk", "state.json"));
    if (!state?.dashboardSkipped) continue;
    found.push({
      root,
      project: basename(root),
      epic: state.dag?.epic ?? null,
      branch: state.dag?.branch ?? null,
      status: "no dashboard",
      progress: null,
      counts: null,
      port: null,
      source: "state.json",
    });
  }
  return found.map((peer) => {
    const run = { ...peer, epic: epicId(peer.epic) };
    return { ...run, id: runId(run), dashboard: run.port ? `http://127.0.0.1:${run.port}/` : null };
  });
};
