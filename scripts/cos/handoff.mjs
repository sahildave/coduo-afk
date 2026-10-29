// scripts/cos/handoff.mjs — render a handoff from the store and `/peers` (#229).
//
// A handoff is what a fresh session needs to carry on a cold one's work:
// pointers and state, every one a literal value, nothing the reader has to go
// and find. Per epic: the Orchestrator and its cache state, the dashboard, the
// state.json path, the PR, the head sha, the Vercel state, the open gates and
// one next action. Then the pending relays (with the commands that read and
// acknowledge them), the register, and the events tail. The model adds at
// most NOTES_MAX characters (about 2k tokens) of its own notes; everything
// else is derived here.
//
// Sources, all read only: the open run (run.json, events.jsonl), the hub's
// inbox, `listRuns` (the `/peers` sweep and its state.json fallback), each
// checkout's .afk/state.json, `git rev-parse` in each checkout, and herdr's
// agent list for the Orchestrators' idle age.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_PORT } from "../dashboard-process.mjs";
import { anchorLabel, readItems } from "../hub/inbox.mjs";
import { listRuns } from "../hub/runs.mjs";
import { targetState } from "../hub/targets.mjs";
import { eventLine } from "../hub/page.mjs";
import { alive } from "./register.mjs";
import { openGates } from "./checkin.mjs";
import { flagLines } from "./store.mjs";

export const NOTES_MAX = 8_000;
const TAIL = 15;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const head = (root, branch) => {
  for (const ref of [branch, "HEAD"].filter(Boolean)) {
    const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", `${ref}^{commit}`], { encoding: "utf8" });
    if (result.status === 0) return { sha: result.stdout.trim(), ref };
  }
  return null;
};

const orchestratorOf = (epic) => `orch-${epic}`;

/** One next action, the first that applies. */
const nextAction = (epic) => {
  if (epic.queued.length) return `read \`afk hub queue ${epic.orchestrator}\` first: The owner sent ${epic.queued.length} item(s) while it was away.`;
  if (epic.finished) return `the run closed; close out PR ${epic.pr?.number ? `#${epic.pr.number}` : "(none recorded)"}.`;
  if (epic.gates.length) return `gate ${epic.gates.join(", ")} waits for the owner on the hub (http://127.0.0.1:${HUB_PORT}); once he accepts, \`afk epic ${epic.epic} --accept=${epic.gates[0]}\`.`;
  if (epic.deploy === "deploy_cap") return "Vercel deploy cap reached (0 deploys left today); wait for the reset, change no code for it.";
  if (epic.deploy === "red") return `the Vercel check on PR #${epic.pr?.number ?? "?"} is red; open ${epic.pr?.url ?? "the PR"}.`;
  if (epic.stalled) return `no runner progress; open ${epic.dashboard ?? epic.statePath}.`;
  if (!epic.dashboard) return `no dashboard answers; read ${epic.statePath}.`;
  if (epic.status === "running") return "running; nothing to do before the next check-in.";
  return `not running (${epic.status ?? "unknown"}); open ${epic.dashboard}.`;
};

/**
 * Gather the handoff for `session` from the open `run`. Returns
 * `{ text, openWork }`; `openWork` is false when every epic has closed, nothing
 * is queued and no registered process is alive.
 */
export const buildHandoff = async ({ run, session, notes = "", env = process.env, now = new Date() }) => {
  const runs = await listRuns(env);
  const checkin = run.events.filter((event) => event.kind === "checkin").at(-1) ?? null;
  const { items, flagged: inboxFlagged } = readItems(env);
  const queued = items.filter((item) => item.status === "queued");
  const epicIds = [...new Set([
    ...(run.meta?.epics ?? []),
    ...(run.meta?.adopted ?? []).map((a) => a.epic),
    ...runs.map((r) => r.epic),
  ].filter((epic) => epic != null).map(String))];
  const epics = await Promise.all(epicIds.map(async (epic) => {
    const peer = runs.find((r) => r.epic === epic) ?? null;
    const row = checkin?.runs?.find((r) => r.epic === epic) ?? null;
    const root = peer?.root ?? row?.root ?? (run.meta?.adopted ?? []).find((a) => String(a.epic) === epic)?.root ?? null;
    const state = root ? readJson(join(root, ".afk", "state.json")) : null;
    const branch = state?.dag?.branch ?? peer?.branch ?? null;
    const orchestrator = orchestratorOf(epic);
    const entry = {
      epic,
      project: peer?.project ?? null,
      orchestrator,
      target: await targetState(orchestrator, env),
      dashboard: peer?.port && peer.status !== "not answering" ? `http://127.0.0.1:${peer.port}` : null,
      recordedPort: peer?.port ?? state?.dashboard?.port ?? null,
      status: peer?.status ?? null,
      progress: peer?.progress ?? null,
      statePath: root ? join(root, ".afk", "state.json") : null,
      root,
      branch,
      head: root ? head(root, branch) : null,
      pr: row?.pr ?? null,
      deploy: row?.deploy ?? "unknown",
      gates: state ? openGates(state) : row?.gates ?? [],
      stalled: Boolean(row?.stalled),
      finished: state?.epicClose?.lifecycle === "closed" || Boolean(row?.finished),
      queued: queued.filter((item) => item.target === orchestrator),
    };
    return { ...entry, next: nextAction(entry) };
  }));
  const register = run.events.filter((event) => event.kind === "process")
    .map((event) => ({ ...event, alive: alive(event.pid) }));
  const stopped = new Set(run.events.filter((e) => e.kind === "stop").flatMap((e) => [...(e.killed ?? []), ...(e.gone ?? [])]));
  const live = register.filter((p) => p.alive && !stopped.has(p.pid));
  const tail = run.events.slice(-TAIL);
  const pr = (p) => (!p ? "none recorded" : p === "unknown" ? "unknown (gh failed at the last check-in)" : `#${p.number} ${p.url ?? ""} (${p.state ?? "?"})`.replace("  ", " "));

  const lines = [
    `# Handoff for ${session}`,
    "",
    `Written ${now.toISOString()} by \`afk cos handoff\` from the store and /peers. Every value below is current as of that time; the paths and commands are exact.`,
    "",
    `Run: ${run.id} (mode ${run.meta?.mode ?? "?"}, opened ${run.meta?.startedAt ?? "?"})`,
    `Store: ${run.dir}`,
    `Hub: http://127.0.0.1:${HUB_PORT}`,
    `Last check-in: ${checkin ? `${checkin.ts}, deploys left ${checkin.deploysLeft ?? "?"}` : "none yet"}`,
    ...flagLines([...run.flagged, ...inboxFlagged]),
  ];
  for (const e of epics) {
    lines.push(
      "",
      `## Epic #${e.epic}${e.project ? ` (${e.project})` : ""}`,
      "",
      `- Orchestrator: ${e.orchestrator} (${e.target.state})`,
      `- Dashboard: ${e.dashboard ?? `not answering${e.recordedPort ? ` (recorded port ${e.recordedPort})` : ""}`}${e.status ? `, ${e.status}` : ""}${e.progress ? `, ${e.progress.passed} of ${e.progress.total} tasks passed` : ""}`,
      `- State: ${e.statePath ?? "no checkout known"}`,
      `- PR: ${pr(e.pr)}`,
      `- Head: ${e.head ? `${e.head.sha} (${e.head.ref})` : "unknown"}`,
      `- Vercel: ${e.deploy}`,
      `- Open gates: ${e.gates.length ? e.gates.join(", ") : "none"}`,
      `- Next: ${e.next}`,
    );
  }
  lines.push("", "## Pending relays", "");
  if (queued.length === 0) lines.push("None.");
  for (const item of queued) {
    lines.push(`- ${item.id} to ${item.target}, queued ${item.statusAt}${item.via === "respond" ? " (Respond)" : `, on ${anchorLabel(item.anchor)}`}: "${String(item.text).replace(/\s+/g, " ").slice(0, 200)}"${item.reason ? ` (note: ${item.reason})` : ""}`);
  }
  for (const target of [...new Set(queued.map((item) => item.target))]) {
    const ids = queued.filter((item) => item.target === target).map((item) => item.id);
    lines.push(`- Read: \`afk hub queue ${target}\`; acknowledge: \`afk hub ack ${target} ${ids.join(" ")}\``);
  }
  lines.push("", "## Register", "");
  if (register.length === 0) lines.push("No registered processes.");
  for (const p of register) {
    lines.push(`- pid ${p.pid} ${p.alive && !stopped.has(p.pid) ? "alive" : "gone"}: ${p.purpose} (owner ${p.owner}, ttl ${p.ttlMin} min, started ${p.ts ?? "?"}, log ${p.log ?? "none"})`);
  }
  lines.push("", `## Events tail (last ${tail.length})`, "");
  for (const event of tail) lines.push(`- ${event.ts} ${event.kind}: ${eventLine(event)}`);
  if (notes.trim()) lines.push("", "## Notes", "", notes.trim());
  return {
    text: `${lines.join("\n")}\n`,
    openWork: epics.some((e) => !e.finished) || queued.length > 0 || live.length > 0,
  };
};
