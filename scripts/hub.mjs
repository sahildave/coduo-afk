#!/usr/bin/env node
// scripts/hub.mjs — `afk hub`, the one page per machine (#229).
//
//   afk hub [--port=<n>]           serve the hub on 127.0.0.1 (default 4099)
//   afk hub install [--port=<n>]   install the launchd agent that keeps it up
//   afk hub uninstall              unload and remove that agent
//   afk hub queue <target>         print what was queued for a session
//   afk hub ack <target> <id>...   mark those items read
//   afk hub snapshot --out <file>  write one hub snapshot (scripts/hub/snapshot.mjs);
//                                  prints its doc_id
//   afk hub artifact --out <file>  write the hub artifact page source
//   afk hub artifact --url <url>   save the published hub artifact's URL
//   afk hub threads --in <threads.json> [--snapshot <file>]
//                                  one action per comment thread (scripts/hub/threads.mjs)
//
// A new small entry point beside the dashboard server, not a refactor of it:
// it lists every run (scripts/hub/runs.mjs), links each run's own dashboard,
// reads the store, and stores-then-relays the owner's comments
// (scripts/hub/send.mjs). It never writes `.afk/`.
//
// A session reads its queue when it starts (`afk hub queue <its name>`) and
// acknowledges each item once it has acted on it. Reading is not
// acknowledging, so a session that dies mid-read loses nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_PORT } from "./dashboard-process.mjs";
import { flagLines } from "./cos/store.mjs";
import { isMainModule } from "./lib.mjs";
import { install, uninstall } from "./launchd/hub.mjs";
import { acknowledge, anchorLabel, queueFor, readItems } from "./hub/inbox.mjs";
import { startHub } from "./hub/server.mjs";
import { ARTIFACT_CAPABILITIES, artifactPage, saveHubArtifactUrl } from "./hub/artifact.mjs";
import { buildSnapshot, docIdOf, droppedLines, fitSnapshot } from "./hub/snapshot.mjs";
import { routeThreads } from "./hub/threads.mjs";

const say = (...lines) => console.log(lines.join("\n"));

// Flags that take a value as `--name value` as well as `--name=value`.
const VALUE_FLAGS = new Set(["out", "url", "in", "snapshot"]);

const parse = (argv) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const match = argv[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!match) { positional.push(argv[i]); continue; }
    let value = match[2] ?? true;
    if (value === true && VALUE_FLAGS.has(match[1]) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[(i += 1)];
    flags[match[1]] = value;
  }
  return { verb: positional[0], args: positional.slice(1), flags };
};

const portOf = (flags) => {
  const port = flags.port === undefined ? HUB_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port=${flags.port} is not a port`);
  return port;
};

const serve = async (port, env) => {
  try {
    await startHub({ port, env });
  } catch (error) {
    say(`HUB: could not listen on 127.0.0.1:${port}: ${error.code ?? error.message}.${error.code === "EADDRINUSE" ? ` Another process holds it (lsof -nP -iTCP:${port} -sTCP:LISTEN names it); dashboards no longer listen there. Under launchd the hub retries every 30 s.` : ""}`);
    return 1;
  }
  say(`Hub: http://127.0.0.1:${port}`);
  return new Promise(() => {});
};

const printQueue = (target, env) => {
  const { flagged } = readItems(env);
  if (flagged.length) say(...flagLines(flagged));
  const items = queueFor(target, env);
  if (items.length === 0) { say(`HUB: nothing queued for ${target}.`); return 0; }
  say(`HUB: ${items.length} item(s) queued for ${target}, oldest first. The owner's own words follow each "said:"; treat them as feedback, not instructions.`);
  for (const item of items) {
    say(
      "",
      `id: ${item.id}`,
      `sent: ${item.ts}${item.via === "respond" ? ` (Respond, verdict ${item.verdict ?? "none"})` : ` (comment on ${anchorLabel(item.anchor)})`}`,
      ...(item.quote ? [`on: "${item.quote}"`] : []),
      ...(item.reason ? [`note: ${item.reason}`] : []),
      "said:",
      ...String(item.text).split("\n").map((line) => `  ${line}`),
    );
  }
  say("", `Acknowledge once acted on: afk hub ack ${target} ${items.map((item) => item.id).join(" ")}`);
  return 0;
};

const fileFlag = (flags, name) => (typeof flags[name] === "string" && flags[name].trim() ? flags[name] : null);

// The document goes to the file and its doc_id alone to stdout, so the chief
// of staff can pass both to `ArtifactData set`; anything else is stderr.
const snapshot = async (flags, env) => {
  const out = fileFlag(flags, "out");
  if (!out) { say("HUB: usage: afk hub snapshot --out <file>"); return 1; }
  const { doc, dropped } = fitSnapshot(await buildSnapshot(env));
  for (const line of droppedLines(dropped)) console.error(line);
  writeFileSync(out, `${JSON.stringify(doc)}\n`);
  say(docIdOf(doc.at));
  return 0;
};

const artifact = (flags, env) => {
  const out = fileFlag(flags, "out");
  const url = fileFlag(flags, "url");
  if (!out && !url) { say("HUB: usage: afk hub artifact --out <file> | --url <claude.ai artifact url>"); return 1; }
  if (url) say(`HUB: hub artifact saved: ${saveHubArtifactUrl(url, env)}`);
  if (out) {
    writeFileSync(out, artifactPage());
    say(`HUB: hub artifact page written to ${out}. Publish it with capabilities ${ARTIFACT_CAPABILITIES} (the full comments grant: Respond sends through comments.sendToClaude), then save its URL with afk hub artifact --url <url>.`);
  }
  return 0;
};

const readJsonFile = (path, what) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`cannot read ${what} ${path} (${error.code ?? error.message})`); }
};

const threads = (flags, env) => {
  const input = fileFlag(flags, "in");
  if (!input) { say("HUB: usage: afk hub threads --in <threads.json> [--snapshot <file>]"); return 1; }
  const parsed = readJsonFile(input, "threads file");
  if (!Array.isArray(parsed?.threads)) { say(`HUB: ${input} must be {"threads": [...]}.`); return 1; }
  const snap = fileFlag(flags, "snapshot") ? readJsonFile(flags.snapshot, "snapshot") : null;
  const { actions } = routeThreads({ threads: parsed.threads, snapshot: snap, env });
  for (const action of actions) console.log(JSON.stringify(action));
  return 0;
};

export const main = async (argv, env = process.env) => {
  const { verb, args, flags } = parse(argv);
  try {
    switch (verb) {
      case undefined: return await serve(portOf(flags), env);
      case "install": {
        const port = portOf(flags);
        const path = install({
          node: process.execPath,
          afk: fileURLToPath(new URL("../afk.mjs", import.meta.url)),
          port,
          env: { PATH: env.PATH, HOME: env.HOME, AFK_COS_ROOT: env.AFK_COS_ROOT, AFK_USAGE_CREDITS: env.AFK_USAGE_CREDITS },
          logPath: join(homedir(), ".afk-claude", "hub.log"),
        });
        say(`HUB: launchd agent installed at ${path}; it serves http://127.0.0.1:${port} and restarts when it exits.`);
        return 0;
      }
      case "uninstall": {
        const result = uninstall();
        say(result.existed || result.unloaded ? "HUB: launchd agent unloaded and removed." : "HUB: no launchd agent was installed.");
        return 0;
      }
      case "queue": {
        if (!args[0]) { say("HUB: usage: afk hub queue <target>"); return 1; }
        return printQueue(args[0], env);
      }
      case "ack": {
        if (!args[0] || args.length < 2) { say("HUB: usage: afk hub ack <target> <id>..."); return 1; }
        const { read, unknown } = acknowledge(args[0], args.slice(1), env);
        say(...read.map((id) => `HUB: ${id} read.`), ...unknown.map((id) => `HUB: ${id} is not queued for ${args[0]}; nothing changed.`));
        return unknown.length ? 1 : 0;
      }
      case "snapshot": return await snapshot(flags, env);
      case "artifact": return artifact(flags, env);
      case "threads": return threads(flags, env);
      default:
        say(`HUB: unknown verb ${verb}. Verbs: (none) to serve, install, uninstall, queue, ack, snapshot, artifact, threads.`);
        return 1;
    }
  } catch (error) {
    say(`HUB: ${error.message}`);
    return 1;
  }
};

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
