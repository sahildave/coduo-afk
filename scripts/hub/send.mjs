// scripts/hub/send.mjs — store, then relay or queue, one hub request (#229).
//
// The order is the contract: the item is appended to the store before
// anything else, so a crash at any later point loses nothing. Then, only when
// the target is warm, it goes through `orchestrator-herdr relay`, the cold-
// guarded path every owner message to an Orchestrator takes, as a verbatim
// quote with the hub as its session. `delivered` is logged only when the relay
// exits 0. Anything else (a cold or absent target, a relay that fails or times
// out, the cold guard refusing) is logged `queued`, and the session reads it
// with `afk hub queue <target>` when it next starts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchorLabel, markItem, relayTimeoutMs, storeItem } from "./inbox.mjs";
import { targetState } from "./targets.mjs";

const relayScript = fileURLToPath(new URL("../orchestrator-herdr.mjs", import.meta.url));

/** `16:28 GMT+5:30`: the relay's `--at` (when the owner said it). */
const clock = (date) =>
  date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });

// Its own process group, so a timeout kills `herdr agent prompt` with it and
// the prompt cannot land after the item is logged queued (#236 H3).
const relay = (target, text, session, at, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [relayScript, "relay", target, "--said", text, "--at", at, "--session", session], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const limit = relayTimeoutMs(env);
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }, limit);
  child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, reason: `relay failed: ${error.message}` }); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (timedOut) resolve({ ok: false, reason: `relay timed out after ${limit / 1000}s and was killed; may already have arrived` });
    else resolve({ ok: code === 0, reason: `relay failed: ${output.trim().slice(-500)}` });
  });
});

/**
 * Send one item. `fields` is `{target, anchor, text}` for a comment or
 * `{target, verdict, text, via: "respond"}` for a response. Returns what the
 * page shows: `{id, steps, state, ageMin}`.
 */
export const send = async (fields, env = process.env) => {
  const item = storeItem(fields, env);
  const steps = ["stored"];
  const target = await targetState(fields.target, env);
  if (target.warm) {
    const session = fields.via === "respond" ? "afk hub, Respond" : `afk hub, on ${anchorLabel(fields.anchor)}`;
    const result = await relay(fields.target, fields.text, session, clock(new Date(item.ts)), env);
    if (result.ok) {
      markItem(item.id, "delivered", {}, env);
      steps.push("delivered");
    } else {
      markItem(item.id, "queued", { reason: result.reason }, env);
      steps.push("queued");
    }
  } else {
    markItem(item.id, "queued", { reason: target.state }, env);
    steps.push("queued");
  }
  return { id: item.id, steps, state: target.state, ageMin: target.ageMin };
};
