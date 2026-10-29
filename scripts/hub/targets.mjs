// scripts/hub/targets.mjs — who the hub can send to, and whether each is warm (#229).
//
// The targets are the chief of staff (`cos`) and every Orchestrator with a
// profile in ~/.afk-claude/orchestrators (the names `orchestrator-herdr.mjs
// start` writes, `orch-<epic>` by convention). Each one's state comes from
// `herdr agent list` and the age of its transcript's last write, the same
// reading the cold guard makes:
//
//   warm <N>m    idle under the cache window: the relay may send it now
//   cold <N>m    idle at or past the window: never messaged, queued instead
//   no session   not in herdr, herdr is down, or no transcript to age
//
// The window is the cold guard's 55 minutes. A machine whose sessions run on
// usage credits (a 5-minute cache) sets AFK_USAGE_CREDITS=1. An unknown age is
// never warm: the hub queues rather than guess.
//
// `cos` is warm only when a herdr agent is named `cos`. A Desktop chief of
// staff has no herdr agent, so it always reads `no session` and a comment to
// it always queues; it reads `afk hub queue cos` when it starts. Intended.
//
// herdr is asked asynchronously and its answer cached for a few seconds, so
// a slow herdr never stalls the hub and a burst of requests asks once.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COLD_AFTER_MIN, transcriptAgeMin } from "../orchestrator-herdr.mjs";

export const CREDITS_COLD_AFTER_MIN = 5;
export const COS_TARGET = "cos";

export const coldAfterMin = (env = process.env) =>
  (env.AFK_USAGE_CREDITS === "1" ? CREDITS_COLD_AFTER_MIN : COLD_AFTER_MIN);

const orchestratorNames = () => {
  const dir = join(homedir(), ".afk-claude", "orchestrators");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".settings.json") && file !== "owner-settings.json")
    .map((file) => file.replace(/\.settings\.json$/, ""))
    .sort();
};

const CACHE_MS = 3_000;
let cache = { at: 0, agents: null };
const herdrAgents = () => {
  if (cache.agents && Date.now() - cache.at < CACHE_MS) return cache.agents;
  const agents = new Promise((resolve) => {
    execFile("herdr", ["agent", "list"], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      try { resolve(JSON.parse(stdout).result?.agents ?? []); } catch { resolve([]); }
    });
  });
  cache = { at: Date.now(), agents };
  return agents;
};

/** `[{name, state, ageMin, warm}]`, `cos` first, then Orchestrators by name. */
export const listTargets = async (env = process.env, { now = Date.now() } = {}) => {
  const agents = await herdrAgents();
  const window = coldAfterMin(env);
  return [COS_TARGET, ...orchestratorNames().filter((name) => name !== COS_TARGET)].map((name) => {
    const agent = agents.find((candidate) => candidate.name === name);
    const ageMin = agent ? transcriptAgeMin(agent.agent_session?.value, now) : null;
    if (ageMin == null) return { name, state: "no session", ageMin: null, warm: false };
    const warm = ageMin < window;
    return { name, state: `${warm ? "warm" : "cold"} ${ageMin}m`, ageMin, warm };
  });
};

/** One target's state; a name with no profile and no session is `no session`. */
export const targetState = async (name, env = process.env) =>
  (await listTargets(env)).find((target) => target.name === name) ?? { name, state: "no session", ageMin: null, warm: false };
