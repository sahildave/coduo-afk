#!/usr/bin/env node
// Start, read, message, restart and stop an Orchestrator session in herdr (#208).
//
// An Orchestrator is a full interactive `claude`, the same kind of process a
// herdr lane runs (runtime-herdr.mjs `laneAgentStartArgs`), not a sub-agent.
// Delta from the lane argv: no --dangerously-skip-permissions (the Orchestrator
// runs in auto mode with the profile below, like a Desktop session), no
// --strict-mcp-config/--no-chrome (it keeps the operator's session tools), and
// --name plus --remote-control so it shows in the Claude Desktop sidebar.
//
//   node scripts/orchestrator-herdr.mjs start   <name> --cwd <checkout> --prompt-file <launch-line.md> [--model opus]
//   node scripts/orchestrator-herdr.mjs restart <name> --cwd <checkout> --prompt-file <launch-line.md> [--model opus]
//   node scripts/orchestrator-herdr.mjs read    <name> [--lines 80]
//   node scripts/orchestrator-herdr.mjs prompt  <name> <text>
//   node scripts/orchestrator-herdr.mjs relay   <name> --said <verbatim> --at <HH:MM TZ> --session <title>
//   node scripts/orchestrator-herdr.mjs relay   <name> --decided <text>
//   node scripts/orchestrator-herdr.mjs stop    <name>
//
// A `prompt` arrives as typed user input, and the Orchestrator's auto-mode
// classifier cannot tell it from the owner. So an owner decision travels only
// through `relay`, in one of two fixed shapes, logged before it is sent: a
// verbatim quote with its session and time, or a decision the chief of staff
// made itself, labelled as not the owner's. `prompt` stays for scheduling.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagLines, openRun } from './cos/store.mjs';
import { isMainModule } from './lib.mjs';

const exec = promisify(execFile);

// The Orchestrator profile: what it needs without a person approving each call.
// It runs the afk runner and starts its own herdr lanes. Auto mode's classifier
// still rules on everything else.
export const ORCHESTRATOR_SETTINGS = {
  permissions: {
    allow: [
      'Bash(afk:*)', 'Bash(node:*)', 'Bash(herdr:*)',
      'Bash(git:*)', 'Bash(gh:*)', 'Bash(until:*)', 'Bash(tail:*)',
    ],
  },
};

export const orchestratorStartArgs = ({ name, pane, model, settingsPath }) => [
  'agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', 60_000,
  '--', '--model', model, '--permission-mode', 'auto',
  '--settings', settingsPath, '--name', name, '--remote-control', name,
];

const herdr = async (...args) => {
  try {
    const { stdout } = await exec('herdr', args.map(String));
    try { return JSON.parse(stdout); } catch { return stdout; }
  } catch (err) {
    throw new Error(`herdr ${args.slice(0, 2).join(' ')}: ${(err.stderr || err.stdout || err.message).trim().slice(0, 300)}`);
  }
};

// The owner's own additions to the profile: extra allow rules and an `autoMode`
// block (the classifier reads `autoMode` from a --settings file, not from
// project settings). Only the owner writes owner-settings.json; this script
// only reads it, so no agent widens its own permissions through a start.
export const orchestratorProfile = (owner) => {
  if (!owner) return ORCHESTRATOR_SETTINGS;
  const profile = {
    ...ORCHESTRATOR_SETTINGS,
    permissions: { ...ORCHESTRATOR_SETTINGS.permissions, allow: [...ORCHESTRATOR_SETTINGS.permissions.allow, ...(owner.permissions?.allow ?? [])] },
  };
  if (owner.autoMode) profile.autoMode = owner.autoMode;
  return profile;
};

const orchestratorsDir = () => join(homedir(), '.afk-claude', 'orchestrators');
const profilePath = (name) => join(orchestratorsDir(), `${name}.settings.json`);

// One file per Orchestrator: a new start must never rewrite the profile a
// running Orchestrator was started with.
const settingsFile = (name) => {
  mkdirSync(orchestratorsDir(), { recursive: true });
  const ownerPath = join(orchestratorsDir(), 'owner-settings.json');
  const owner = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, 'utf8')) : null;
  const path = profilePath(name);
  writeFileSync(path, JSON.stringify(orchestratorProfile(owner), null, 2));
  return path;
};

// The two shapes an owner decision may take on its way to an Orchestrator.
// A quote with no session or time is refused: it is the shape a laundered
// permission takes.
export const formatRelay = ({ said, decided, at, session }) => {
  if ((said == null) === (decided == null)) throw new Error('relay: give exactly one of --said <verbatim> or --decided <text>');
  if (decided != null) return `Chief of staff decision (rule 5, not a the owner quote): ${decided}`;
  if (!session) throw new Error('relay --said needs --session <chief of staff session title>');
  if (!at) throw new Error('relay --said needs --at <HH:MM TZ> (when the owner said it)');
  return `Relayed by the chief of staff. The owner said, in "${session}" at ${at}, verbatim: "${said}"`;
};

// A plain screen read drops styling, so Claude Code's greyed (SGR 2) prompt
// suggestion after ❯ reads as text the owner typed. Mark it, then strip ANSI.
// 2026-10-12: two suggestions were reported to the owner as his unsent drafts.
export const markSuggestion = (ansi) => ansi
  .replace(/(\u276F[ \u00A0]*)(?:\x1b\[0m)*\x1b\[2m[^\x1b\r\n]*/g, '$1[greyed suggestion, not typed]')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '');

// Minutes since the Orchestrator's transcript last changed: its cache is 1 h
// (5 min on usage credits), and a message past that re-sends it all cold.
export const transcriptAgeMin = (sessionId, now = Date.now()) => {
  const projects = join(homedir(), '.claude', 'projects');
  if (!sessionId || !existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return Math.round((now - statSync(file).mtimeMs) / 60_000);
  }
  return null;
};

// The cold guard (#227): at or past this idle age a message re-sends the
// whole transcript cold (a 1-hour main-session cache, with 5 minutes of
// margin). No override flag, by the owner's ruling: "I will never pass this".
export const COLD_AFTER_MIN = 55;

/**
 * The refusal for a cold Orchestrator, or null when it may be messaged. An
 * unknown age (no session, no transcript, or not in herdr's list) is refused
 * too: the guard fails closed, because a cold re-send is the error it exists
 * to prevent and an unknown age may be one.
 */
const coldRefusal = async (name) => {
  const agent = ((await herdr('agent', 'list')).result?.agents ?? []).find((a) => a.name === name);
  const age = transcriptAgeMin(agent?.agent_session?.value);
  if (age != null && age < COLD_AFTER_MIN) return null;
  const script = fileURLToPath(import.meta.url);
  return [
    age == null
      ? `refused: ${name}'s idle age unknown (${agent ? 'no transcript found for its session' : 'not in herdr agent list'}); the guard cannot rule out a cold re-send. Nothing was sent.`
      : `refused: ${name} has been idle ${age} min (cold at ${COLD_AFTER_MIN}); a message now re-sends its whole transcript uncached. Nothing was sent.`,
    'Restart it from its handoff instead:',
    `  node ${script} restart ${name} --cwd <checkout> --prompt-file <handoff>`,
  ].join('\n');
};

const statusLine = async (name) => {
  const agent = ((await herdr('agent', 'list')).result?.agents ?? []).find((a) => a.name === name);
  if (!agent) return `${name}: not in herdr agent list`;
  const age = transcriptAgeMin(agent.agent_session?.value);
  const cache = age == null ? 'transcript not found' : `last transcript write ${age}m ago · ${age >= COLD_AFTER_MIN ? 'cache likely cold' : 'cache warm if on a subscription (5m on usage credits)'}`;
  return `${name}: ${agent.agent_status ?? 'unknown'} · ${cache}`;
};

const holderWorkspace = async (name) => {
  try { await herdr('agent', 'get', name); } catch (err) {
    // Only a real not-found means "no agent"; herdr being down must not read as stopped.
    if (/agent_not_found/.test(err.message)) return null;
    throw err;
  }
  const list = await herdr('agent', 'list');
  return (list.result?.agents ?? []).find((a) => a.name === name)?.workspace_id ?? null;
};

const stop = async (name) => {
  const ws = await holderWorkspace(name);
  if (ws) await herdr('workspace', 'close', ws);
  rmSync(profilePath(name), { force: true });
  return ws;
};

const start = async (name, { cwd, prompt, model = 'opus' }) => {
  const ws = await herdr('workspace', 'create', '--cwd', resolve(cwd), '--label', name, '--no-focus');
  const pane = ws.result.root_pane.pane_id;
  const args = orchestratorStartArgs({ name, pane, model, settingsPath: settingsFile(name) });
  for (let wait = 1_000; ; wait *= 2) {
    try { await herdr(...args); break; } catch (err) {
      // A workspace's shell needs a moment before agent start accepts it.
      if (/agent_name_taken/.test(err.message) || wait > 16_000) {
        await herdr('workspace', 'close', ws.result.workspace.workspace_id).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // `agent start` returns when the process exists, not when claude reads input.
  // The launch line carries the authorizations, so a failed wait or prompt is fatal
  // and the workspace is closed rather than left holding the name.
  try {
    await herdr('agent', 'wait', name, '--until', 'idle', '--timeout', 90_000);
    await herdr('agent', 'prompt', name, prompt);
  } catch (err) {
    await herdr('workspace', 'close', ws.result.workspace.workspace_id).catch(() => {});
    throw err;
  }
  return { workspace: ws.result.workspace.workspace_id, pane };
};

const main = async ([cmd, name, ...rest]) => {
  const opt = (flag) => { const i = rest.indexOf(flag); return i === -1 ? undefined : rest[i + 1]; };
  if (!name) throw new Error('usage: orchestrator-herdr.mjs start|restart|read|prompt|relay|stop <name> ...');
  // Reads the launch line up front, so a bad path fails before restart stops anything.
  const startOpts = () => {
    if (!opt('--prompt-file')) throw new Error(`usage: orchestrator-herdr.mjs ${cmd} <name> --prompt-file <launch-line.md> [--cwd <checkout>] [--model opus]`);
    return { cwd: opt('--cwd') ?? process.cwd(), prompt: readFileSync(opt('--prompt-file'), 'utf8').trim(), model: opt('--model') };
  };
  switch (cmd) {
    case 'start': {
      // The start gate (#227): an Orchestrator starts only under an open chief
      // of staff run, so the run's store and check-in exist before it does. A
      // solo `afk epic` never comes through here.
      const run = openRun();
      if (run?.flagged.length) console.log(flagLines(run.flagged).join('\n'));
      if (!run) {
        console.log('refused: no afk cos run is open. Run `afk cos start --mode=day|night <epic>...` first; a solo `afk epic` needs no Orchestrator.');
        process.exitCode = 1;
        return;
      }
      return console.log(JSON.stringify(await start(name, startOpts())));
    }
    case 'restart': {
      const opts = startOpts();
      const closed = await stop(name);
      console.log(closed ? `closed workspace ${closed}` : `no agent named ${name}`);
      return console.log(JSON.stringify(await start(name, opts)));
    }
    case 'read': {
      const out = await herdr('agent', 'read', name, '--source', 'recent-unwrapped', '--lines', opt('--lines') ?? 80, '--format', 'ansi');
      console.log(await statusLine(name));
      return console.log(typeof out === 'string' ? markSuggestion(out) : JSON.stringify(out));
    }
    case 'relay': {
      const text = formatRelay({ said: opt('--said'), decided: opt('--decided'), at: opt('--at'), session: opt('--session') });
      const cold = await coldRefusal(name);
      if (cold) { console.log(cold); process.exitCode = 1; return; }
      mkdirSync(orchestratorsDir(), { recursive: true });
      appendFileSync(join(orchestratorsDir(), 'relays.log'), `${JSON.stringify({ at: new Date().toISOString(), name, text })}\n`);
      return console.log(JSON.stringify(await herdr('agent', 'prompt', name, text)));
    }
    case 'prompt': {
      const cold = await coldRefusal(name);
      if (cold) { console.log(cold); process.exitCode = 1; return; }
      return console.log(JSON.stringify(await herdr('agent', 'prompt', name, rest.join(' '))));
    }
    case 'stop': { const ws = await stop(name); return console.log(ws ? `closed workspace ${ws}` : `no agent named ${name}`); }
    default: throw new Error(`unknown command ${cmd}`);
  }
};

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
