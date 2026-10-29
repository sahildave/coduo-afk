#!/usr/bin/env node
// scripts/cos-handoff.mjs — `afk cos handoff <session>`, the derived handoff (#229).
//
//   node scripts/cos-handoff.mjs <session> [--notes-file=<path>]
//       Render the handoff (scripts/cos/handoff.mjs), write it to
//       <run>/handoffs/<session>-<time>.md, append a `handoff` event naming
//       the file, and print it. The file is the `--prompt-file` of the
//       restart line the cold guard prints. Notes: at most 8000 characters.
//
//   node scripts/cos-handoff.mjs --auto <session>
//       The end-of-turn hook (a Claude Code Stop hook; it reads the hook's
//       JSON on stdin). Writes the handoff only when the session's context is
//       at least 150k tokens AND work is open; otherwise prints why it
//       skipped. Never blocks the turn: exit 0 either way. There is no idle
//       timer; nothing writes a handoff between turns.
//
// Context is read from the transcript's last assistant message: input plus
// cache-read plus cache-creation tokens, the size of the next call's prompt.
// The 150k threshold is the epic's measured break-even (PR #172: a fresh
// session pays 41-54k on its first call and 51-73k exploring before its first
// edit, so below about 120k one cold re-send is cheaper than a restart).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_MAX, buildHandoff } from "./cos/handoff.mjs";
import { appendEvent, cosRoot, nowMs, openRun } from "./cos/store.mjs";
import { isMainModule } from "./lib.mjs";

export const AUTO_MIN_CONTEXT = 150_000;

const say = (...lines) => console.log(lines.join("\n"));

/** Tokens in the prompt of the transcript's last assistant call, or null. */
export const contextTokens = (transcriptPath) => {
  let lines;
  try { lines = readFileSync(transcriptPath, "utf8").trim().split("\n"); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const usage = entry?.message?.usage;
    if (entry?.type === "assistant" && usage) {
      return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
  }
  return null;
};

const readStdin = () => {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
};

const write = async ({ run, session, notes, env }) => {
  const { text, openWork } = await buildHandoff({ run, session, notes, env, now: new Date(nowMs(env)) });
  const dir = join(run.dir, "handoffs");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(nowMs(env)).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = join(dir, `${session.replace(/[^\w.-]/g, "_")}-${stamp}.md`);
  writeFileSync(path, text);
  appendEvent(run.dir, "handoff", { session, path, chars: text.length }, env);
  return { text, path, openWork };
};

export const main = async (argv, env = process.env) => {
  const auto = argv.includes("--auto");
  const notesFlag = argv.find((arg) => arg.startsWith("--notes-file="));
  const session = argv.find((arg) => !arg.startsWith("--"));
  if (!session) { say("HANDOFF: usage: afk cos handoff <session> [--notes-file=<path>] | --auto <session>"); return 1; }
  const run = openRun({ root: cosRoot(env) });

  if (auto) {
    if (!run) { say("HANDOFF: skipped, no afk cos run is open."); return 0; }
    let hook = {};
    try { hook = JSON.parse(readStdin() || "{}"); } catch { /* no hook input */ }
    const tokens = hook.transcript_path ? contextTokens(hook.transcript_path) : null;
    if (tokens == null) { say("HANDOFF: skipped, no transcript usage to measure."); return 0; }
    if (tokens < AUTO_MIN_CONTEXT) { say(`HANDOFF: skipped, context ${tokens} tokens is under ${AUTO_MIN_CONTEXT}.`); return 0; }
    const { openWork } = await buildHandoff({ run, session, env });
    if (!openWork) { say("HANDOFF: skipped, no open work (every epic closed, nothing queued, no live registered process)."); return 0; }
    const { path } = await write({ run, session, notes: "", env });
    say(`HANDOFF: wrote ${path} (context ${tokens} tokens).`);
    return 0;
  }

  if (!run) { say("HANDOFF: no afk cos run is open. Open one with `afk cos start --mode=day|night <epic>...`."); return 1; }
  let notes = "";
  if (notesFlag) {
    try { notes = readFileSync(notesFlag.slice("--notes-file=".length), "utf8"); } catch (error) { say(`HANDOFF: could not read the notes file: ${error.message}`); return 1; }
    if (notes.length > NOTES_MAX) { say(`HANDOFF: notes are ${notes.length} characters; the cap is ${NOTES_MAX} (about 2k tokens). Cut them; the rest of the handoff is derived.`); return 1; }
  }
  const { text, path } = await write({ run, session, notes, env });
  process.stdout.write(text);
  say(`HANDOFF: wrote ${path}`);
  return 0;
};

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
