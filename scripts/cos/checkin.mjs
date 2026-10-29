// scripts/cos/checkin.mjs — the check-in, with no model and no session
// messages (#227).
//
// It reads: every run the hub lists (`listRuns`: the `/peers` sweep, which the
// AFK_COS_PEERS file stands in for in tests, plus each checkout the store knows
// whose dashboard the sweep missed), each run's .afk/state.json and
// agent-auto.log age, the machine gate lock, each Orchestrator's transcript age
// (herdr agent list), each run's PR and its Vercel check (`gh pr view`), and
// `vercel-deploys-left`. It appends one `checkin` event and notifies through
// the runner's notify path only on a stall, an open gate, a red deploy, a
// finished run or a dashboard not answering, and only when that trigger is new
// since the last check-in.
//
// Fail direction: OPEN for every input. A source that cannot be read is
// recorded as `unknown` and the check-in still writes its event; a check-in
// that dies on one bad source leaves the whole picture blank.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gateLockPath, readGateHolder } from "../gate-lock.mjs";
import { epicId, isLive, listRuns, openGates } from "../hub/runs.mjs";
import { notify } from "../lib.mjs";
import { transcriptAgeMin } from "../orchestrator-herdr.mjs";
import { appendEvent, nowMs } from "./store.mjs";

// heartbeat.mjs's default: the builder timeout (45 min) plus 10.
export const STALL_MIN = 55;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const command = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...options });
  return result.error || result.status !== 0 ? null : result.stdout;
};

// The hub's run list (`listRuns`): the sweep, plus every checkout the store has
// seen whose dashboard the sweep did not find, probed on its recorded port and
// listed as `not answering` when nothing answers. The check-in and the hub
// therefore count the same runs.
const peers = (env) => listRuns(env);

// `openGates` lives in runs.mjs, which this module imports; re-exported so its callers are unchanged.
export { openGates };

/** green, red, pending or none, from a PR's status rollup. */
export const vercelState = (rollup) => {
  const checks = (rollup ?? []).filter((check) => /vercel/i.test(`${check.context ?? ""} ${check.name ?? ""}`));
  if (checks.length === 0) return "none";
  const states = checks.map((check) => String(check.conclusion || check.state || check.status || "").toUpperCase());
  if (states.some((state) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(state))) return "red";
  if (states.every((state) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state))) return "green";
  return "pending";
};

/** A number, or `unknown` when the tool is missing, fails or prints no number. */
export const deploysLeft = () => {
  const out = command("vercel-deploys-left", []);
  const match = out?.match(/-?\d+/);
  return match ? Number(match[0]) : "unknown";
};

const pullRequest = (root, branch) => {
  if (!branch) return null;
  const out = command("gh", ["pr", "view", branch, "--json", "number,state,url,statusCheckRollup"], { cwd: root });
  const pr = out ? (() => { try { return JSON.parse(out); } catch { return null; } })() : null;
  return pr ? { number: pr.number ?? null, state: pr.state ?? null, url: pr.url ?? null, rollup: pr.statusCheckRollup ?? [] } : "unknown";
};

const orchestrators = (now) => {
  const dir = join(homedir(), ".afk-claude", "orchestrators");
  const names = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith(".settings.json") && file !== "owner-settings.json").map((file) => file.replace(/\.settings\.json$/, ""))
    : [];
  if (names.length === 0) return [];
  const out = command("herdr", ["agent", "list"]);
  let agents = null;
  try { agents = JSON.parse(out).result?.agents ?? []; } catch { agents = null; }
  return names.map((name) => {
    if (!agents) return { name, status: "unknown", idleMin: null };
    const agent = agents.find((candidate) => candidate.name === name);
    if (!agent) return { name, status: "absent", idleMin: null };
    return { name, status: agent.agent_status ?? "unknown", idleMin: transcriptAgeMin(agent.agent_session?.value, now) };
  });
};

const readRun = (peer, { now, left }) => {
  const state = readJson(join(peer.root, ".afk", "state.json"));
  const branch = state?.dag?.branch ?? peer.branch ?? null;
  const finished = state?.epicClose?.lifecycle === "closed";
  let logAgeMin = null;
  try { logAgeMin = Math.round((now - statSync(join(peer.root, ".afk", "agent-auto.log")).mtimeMs) / 60_000); } catch { /* no log yet */ }
  // "no dashboard" is a live run whose dashboard failed to start (#277): it can
  // stall exactly like a "running" one.
  const live = isLive(peer);
  const stalled = !finished && (peer.status === "stale" || (live && logAgeMin !== null && logAgeMin >= STALL_MIN));
  const pr = pullRequest(peer.root, branch);
  let deploy = pr && pr !== "unknown" ? vercelState(pr.rollup) : "unknown";
  // A red build on a capped day is the cap, not the code (story 15).
  if (deploy === "red" && left === 0) deploy = "deploy_cap";
  return {
    root: peer.root,
    port: peer.port,
    project: peer.project ?? null,
    epic: epicId(state?.dag?.epic) ?? epicId(peer.epic),
    branch,
    status: peer.status ?? "unknown",
    progress: peer.progress ?? null,
    logAgeMin,
    gates: openGates(state),
    stalled,
    finished,
    pr: pr && pr !== "unknown" ? { number: pr.number, state: pr.state, url: pr.url } : pr,
    deploy,
  };
};

export const triggersOf = (runs) => runs.flatMap((run) => [
  ...(run.stalled ? [{ kind: "stall", epic: run.epic, root: run.root }] : []),
  ...run.gates.map((task) => ({ kind: "gate", epic: run.epic, root: run.root, task })),
  ...(run.deploy === "red" ? [{ kind: "red_deploy", epic: run.epic, root: run.root }] : []),
  ...(run.finished ? [{ kind: "finished", epic: run.epic, root: run.root }] : []),
  // A closed epic's dashboard is expected to stop; any other is not.
  ...(run.status === "not answering" && !run.finished ? [{ kind: "not_answering", epic: run.epic, root: run.root }] : []),
]);

const key = (trigger) => `${trigger.kind}:${trigger.root}:${trigger.task ?? ""}`;

const MESSAGE = {
  stall: (t) => [`#${t.epic} stalled`, "error", "No runner progress; open its dashboard."],
  gate: (t) => [`#${t.epic} gate open`, "warn", `Task ${t.task} waits for you.`],
  red_deploy: (t) => [`#${t.epic} deploy red`, "error", "The Vercel check on its PR failed."],
  finished: (t) => [`#${t.epic} finished`, "success", "The run closed."],
  not_answering: (t) => [`#${t.epic} dashboard not answering`, "warn", "Its recorded dashboard port does not answer; the run may still be going."],
};

/** Run one check-in against the open `run`. Returns the appended event. */
export const checkin = async (run, env = process.env) => {
  const now = nowMs(env);
  const left = deploysLeft();
  const runs = (await peers(env)).filter((peer) => peer?.root).map((peer) => readRun(peer, { now, left }));
  const triggers = triggersOf(runs);
  const previous = run.events.filter((event) => event.kind === "checkin").at(-1);
  const seen = new Set((previous?.triggers ?? []).map(key));
  const fresh = triggers.filter((trigger) => !seen.has(key(trigger)));
  for (const trigger of fresh) {
    const [subtitle, level, message] = MESSAGE[trigger.kind](trigger);
    notify({ title: `AFK chief of staff (${run.meta?.mode ?? "?"})`, subtitle, message, level });
  }
  return appendEvent(run.dir, "checkin", {
    run: run.id,
    mode: run.meta?.mode ?? null,
    runs,
    gateLock: readGateHolder(gateLockPath()) ?? null,
    orchestrators: orchestrators(now),
    deploysLeft: left,
    triggers,
    notified: fresh.map(key),
  }, env);
};
