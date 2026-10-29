#!/usr/bin/env node
// scripts/cos.mjs — `afk cos`, the chief of staff's CLI (#227).
//
//   afk cos start --mode=day|night [<epic>...]   open a run, install the check-in
//   afk cos log --kind=<kind> "<text>"           append a note, decision, grant,
//                                                comment or owner_intervention
//   afk cos ask --id=<slug> --title="<question>" [--why="<context>"]
//       --option="<value>|<label>|<detail>"... [--rec=<value>]
//                                                post a question to the hub
//   afk cos ask --id=<slug> --title="<question>" --from=orch-<n> [--option=...]...
//                                                an Orchestrator asks the chief of staff
//   afk cos answer --id=<slug> "<text>"          close an ask, recording the answer
//   afk cos report --file=<path.md> [--append]   store the morning report as report.md
//   afk cos plan --file=<plan.json>              store tonight's planned rows; the hub
//                                                draws them as "Tonight's plan"
//   afk cos run --ttl=<min> --purpose="<why>" -- <cmd>...
//                                                start a registered background process
//   afk cos checkin                              one check-in (launchd runs this)
//   afk cos handoff <session> [--notes-file=<path>] | --auto <session>
//                                                the derived handoff (scripts/cos-handoff.mjs)
//   afk cos stop                                 kill the register, unload the
//                                                check-in, close the run
//
// The only writer of the store (scripts/cos/store.mjs). Everything prints to
// STDOUT, refusals included: a supervising session reads stdout.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_PORT, discoverDashboards } from "./dashboard-process.mjs";
import { epicId } from "./hub/runs.mjs";
import { isMainModule } from "./lib.mjs";
import { CHECKIN_MINUTES, install, uninstall } from "./launchd/cos-checkin.mjs";
import { permissionsProbe, renderPermissions } from "./cos/permissions.mjs";
import { startProcess, stopProcesses } from "./cos/register.mjs";
import { readHubArtifactUrl } from "./hub/artifact.mjs";
import { validatePlan } from "./hub/plan.mjs";
import { REPORT_FILE, ageMin, openOrchestratorAsks, parseReport, sectionKeys } from "./cos/report.mjs";
import {
  LOG_KINDS, appendEvent, cosRoot, createRun, flagLines, newestRun, nowMs, openRun,
} from "./cos/store.mjs";

export const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const VALUE_FLAGS = new Set(["mode", "kind", "ttl", "purpose", "notes-file", "id", "title", "why", "option", "rec", "from", "file"]);
// Flags that may repeat; each collects into an array.
const LIST_FLAGS = new Set(["option"]);

/** `--name=value` and `--name value` both; everything after `--` is the command. */
export const parseCos = (argv) => {
  const dash = argv.indexOf("--");
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const flags = {};
  const positional = [];
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = true;
    if (eq !== -1) value = arg.slice(eq + 1);
    else if (VALUE_FLAGS.has(name) && i + 1 < head.length && !head[i + 1].startsWith("--")) value = head[(i += 1)];
    if (LIST_FLAGS.has(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { verb: positional[0], positional: positional.slice(1), flags, cmd: dash === -1 ? [] : argv.slice(dash + 1) };
};

const say = (...lines) => console.log(lines.join("\n"));
const refuse = (line) => { say(`COS: ${line}`); return 1; };
const NO_RUN = "no afk cos run is open. Open one with `afk cos start --mode=day|night <epic>...`.";

const printFlagged = (run) => { if (run?.flagged.length) say(...flagLines(run.flagged)); };

const start = async ({ flags, positional }, env) => {
  const current = openRun({ root: cosRoot(env) });
  printFlagged(current);
  if (current) return refuse(`run ${current.id} is already open (mode ${current.meta?.mode}). \`afk cos stop\` closes it.`);
  const mode = flags.mode;
  if (!Object.hasOwn(CHECKIN_MINUTES, mode)) return refuse("start needs --mode=day or --mode=night.");
  const probe = permissionsProbe();
  if (!probe.ok) {
    say(renderPermissions(probe));
    return refuse("start refused: the run would hit classifier refusals. Add the lines above, then start again.");
  }
  // Adopt runs already going: a CoS started later registers them, nothing more.
  let peers = [];
  try {
    peers = env.AFK_COS_PEERS ? JSON.parse(readFileSync(env.AFK_COS_PEERS, "utf8")) : await discoverDashboards();
  } catch { peers = []; }
  const adopted = peers.filter((peer) => peer?.status === "running")
    .map((peer) => ({ epic: epicId(peer.epic), root: peer.root, port: peer.port }));
  const root = cosRoot(env);
  const pass = ["PATH", "HOME", "AFK_COS_ROOT", "AFK_GATE_LOCK_DIR", "AFK_COS_PEERS"];
  try {
    install({
      mode,
      node: process.execPath,
      afk: fileURLToPath(new URL("../afk.mjs", import.meta.url)),
      env: Object.fromEntries(pass.map((key) => [key, key === "AFK_COS_ROOT" ? root : env[key]])),
      logPath: join(root, "checkin.log"),
    });
  } catch (error) {
    return refuse(`start refused: the check-in could not be installed (${error.message}).`);
  }
  const run = createRun({ root, mode, epics: positional, adopted, env });
  appendEvent(run.dir, "note", { text: `run opened, mode ${mode}, epics ${positional.join(", ") || "none"}, adopted ${adopted.map((a) => a.epic ?? a.root).join(", ") || "none"}` }, env);
  say(
    `COS: run ${run.id} open (mode ${mode}, check-in every ${CHECKIN_MINUTES[mode]} min by launchd).`,
    ...adopted.map((a) => `COS: adopted running epic ${a.epic ?? "?"} at ${a.root} (dashboard :${a.port}).`),
    `Hub: ${HUB_URL}`,
    hubArtifactLine(env),
  );
  return 0;
};

// Saved machine-wide by `afk hub artifact --url`, so every run prints it.
const hubArtifactLine = (env) => {
  const url = readHubArtifactUrl(env);
  return url ? `hub artifact: ${url}` : "hub artifact: not set (afk hub artifact --url <url>)";
};

const log = ({ flags, positional }, env) => {
  const run = openRun({ root: cosRoot(env) });
  if (!run) return refuse(NO_RUN);
  printFlagged(run);
  if (!LOG_KINDS.includes(flags.kind)) return refuse(`log needs --kind=${LOG_KINDS.join("|")}.`);
  const text = positional.join(" ").trim();
  if (!text) return refuse("log needs the text to record.");
  const event = appendEvent(run.dir, flags.kind, { text }, env);
  say(`COS: logged ${event.kind} at ${event.ts}.`);
  return 0;
};

// A question for the owner, rendered on the hub as a gate-style ask (#245).
// The answer comes back through the hub's Respond, as `[ask:cos:<id>]`.
// With `--from=orch-<n>` it is an Orchestrator's question to the chief of
// staff instead: options are optional (such a question is often open-ended),
// `afk cos checkin` prints it first, and `afk cos answer` closes it.
const SESSION = /^[A-Za-z0-9][\w.-]{0,63}$/;
const ask = ({ flags }, env) => {
  const run = openRun({ root: cosRoot(env) });
  if (!run) return refuse(NO_RUN);
  printFlagged(run);
  const id = typeof flags.id === "string" ? flags.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) return refuse("ask needs --id=<slug>: letters, digits and dashes.");
  const title = typeof flags.title === "string" ? flags.title.trim() : "";
  if (!title) return refuse('ask needs --title="<question>".');
  const from = flags.from === undefined ? null : typeof flags.from === "string" ? flags.from.trim() : "";
  if (from !== null && !SESSION.test(from)) return refuse("ask: --from needs the asking session's name, e.g. --from=orch-1232.");
  const options = (flags.option ?? []).filter((o) => typeof o === "string").map((o) => {
    const [value, label, ...detail] = o.split("|").map((part) => part.trim());
    return { value, label: label || value, detail: detail.join(" | ") };
  });
  if (options.some((o) => !o.value)) return refuse('ask: every --option needs a value, as --option="<value>|<label>|<detail>".');
  if (!from && options.length < 2) return refuse('ask needs at least two --option="<value>|<label>|<detail>".');
  if (new Set(options.map((o) => o.value)).size !== options.length) return refuse("ask: two options share a value.");
  const rec = typeof flags.rec === "string" ? flags.rec.trim() : null;
  if (flags.rec !== undefined && !options.some((o) => o.value === rec)) return refuse(`ask: --rec=${flags.rec} is not one of the option values (${options.map((o) => o.value).join(", ")}).`);
  const why = typeof flags.why === "string" ? flags.why.trim() : "";
  const asked = (events) => events.some((event) => event.kind === "ask" && event.id === id);
  const event = appendEvent(run.dir, "ask", { id, title, why, options, rec, ...(from ? { from } : {}) }, env, { unless: asked });
  if (!event) return refuse(`question ${id} is already asked in run ${run.id}. Pick another --id.`);
  if (from) say(`COS: asked cos:${id} from ${from} at ${event.ts}. \`afk cos checkin\` lists it until \`afk cos answer --id=${id}\` closes it; the hub shows it to the owner as a card he can answer: ${HUB_URL}`);
  else say(`COS: asked cos:${id} at ${event.ts}. It shows on the hub until a response answers it: ${HUB_URL}`);
  return 0;
};

// Closes an ask and records the answer. Delivering it into the asking
// session is the chief of staff's relay, not this verb's. Like `report`, it
// works on the newest run after `afk cos stop`: an ask left open at the stop
// can still be closed.
const answer = ({ flags, positional }, env) => {
  const root = cosRoot(env);
  const run = openRun({ root }) ?? newestRun({ root });
  if (!run) return refuse(NO_RUN);
  printFlagged(run);
  const id = typeof flags.id === "string" ? flags.id.trim() : "";
  if (!id) return refuse('answer needs --id=<slug> "<text>".');
  const text = positional.join(" ").trim();
  if (!text) return refuse(`answer needs the text: afk cos answer --id=${id} "<text>".`);
  let why = null;
  const event = appendEvent(run.dir, "answer", (events) => ({
    id, text, from: events.find((e) => e.kind === "ask" && e.id === id)?.from ?? null,
  }), env, {
    unless: (events) => {
      const ask = events.find((e) => e.kind === "ask" && e.id === id);
      if (!ask) why = `no question ${id} was asked in run ${run.id}.`;
      else if (!ask.from) why = `${id} is the owner's question, not an Orchestrator's; it is answered in the hub: ${HUB_URL}`;
      else if (events.some((e) => e.kind === "answer" && e.id === id)) why = `question ${id} is already answered in run ${run.id}.`;
      return why !== null;
    },
  });
  if (!event) return refuse(why);
  say(`COS: answered cos:${id}${event.from ? ` for ${event.from}` : ""} at ${event.ts}. Relay it into ${event.from ?? "the asking session"} if it has not seen it.`);
  return 0;
};

// The morning report, as report.md in the open run's store, or the newest
// run's when none is open: the report is appended to after `afk cos stop`.
// The file is written inside the store lock, with the `report` event.
const report = ({ flags }, env) => {
  const root = cosRoot(env);
  const run = openRun({ root }) ?? newestRun({ root });
  if (!run) return refuse("no afk cos run exists yet, so there is nowhere to store a report.");
  printFlagged(run);
  if (typeof flags.file !== "string" || !flags.file.trim()) return refuse("report needs --file=<path.md>.");
  let text;
  try { text = readFileSync(flags.file, "utf8"); } catch (error) { return refuse(`report: cannot read ${flags.file} (${error.code ?? error.message}).`); }
  if (!text.trim()) return refuse(`report: ${flags.file} is empty. Nothing stored.`);
  const path = join(run.dir, REPORT_FILE);
  // An append with no report yet is the report: an addendum heading on top
  // would turn its whole text into an addendum.
  const append = flags.append === true && existsSync(path);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const event = appendEvent(run.dir, "report", () => {
    if (append) appendFileSync(path, `\n## Addendum ${new Date(nowMs(env)).toISOString()}\n\n${body}`);
    else writeFileSync(path, body);
    return { path, append, sections: sectionKeys(text), from: flags.file };
  }, env);
  say(`COS: ${append ? "appended to" : "stored"} the report at ${path} (run ${run.id}, sections: ${event.sections.join(", ") || "none"}). The hub shows it: ${HUB_URL}`);
  for (const line of parseReport(text).stray) say(`COS: heading "${line}" names no epic section; write it as "## <repo>#<epic>"`);
  return 0;
};

// Tonight's planned rows (scripts/hub/plan.mjs has the schema), stored whole
// as a `plan` event in the open run; a later plan replaces it on the hub.
const plan = ({ flags }, env) => {
  const run = openRun({ root: cosRoot(env) });
  if (!run) return refuse(NO_RUN);
  printFlagged(run);
  if (typeof flags.file !== "string" || !flags.file.trim()) return refuse("plan needs --file=<plan.json>.");
  let raw;
  try { raw = readFileSync(flags.file, "utf8"); } catch (error) { return refuse(`plan: cannot read ${flags.file} (${error.code ?? error.message}).`); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return refuse(`plan: ${flags.file} is not JSON. Nothing stored.`); }
  const { plan: valid, errors } = validatePlan(parsed);
  if (!valid) {
    say(...errors.map((error) => `COS: plan: ${error}`));
    return refuse(`plan refused: ${errors.length} problem(s) in ${flags.file}. Nothing stored.`);
  }
  const event = appendEvent(run.dir, "plan", { from: flags.file, epics: valid.epics }, env);
  say(`COS: stored the plan for ${valid.epics.map((row) => `#${row.epic}`).join(", ")} in run ${run.id} at ${event.ts}. The hub draws it under Tonight's plan: ${HUB_URL}`);
  return 0;
};

const runProcess = ({ flags, cmd }, env) => {
  const run = openRun({ root: cosRoot(env) });
  if (!run) return refuse(NO_RUN);
  printFlagged(run);
  const ttlMin = Number(flags.ttl);
  if (!(ttlMin > 0)) return refuse("run needs --ttl=<minutes>, a positive number.");
  if (typeof flags.purpose !== "string" || !flags.purpose.trim()) return refuse('run needs --purpose="<why>".');
  if (cmd.length === 0) return refuse("run needs a command after `--`.");
  const owner = env.AFK_COS_OWNER || (env.RUNNER_TASK_ID ? `lane ${env.RUNNER_TASK_ID}` : "chief of staff");
  const entry = startProcess({ cmd, dir: run.dir, ttlMin, purpose: flags.purpose.trim(), owner, env });
  // Registered only while the run is still open, checked under the store lock:
  // a `stop` that landed after the spawn has already read the register, so a
  // process appended behind it would never be killed.
  const closed = (events) => events.some((event) => event.kind === "stop");
  if (!appendEvent(run.dir, "process", entry, env, { unless: closed })) {
    const outcome = stopProcesses([entry]);
    return refuse(`run ${run.id} closed while pid ${entry.pid} was starting; killed it (${outcome.killed.length ? "gone" : "check by hand"}). Nothing registered.`);
  }
  say(`COS: registered pid ${entry.pid} (${entry.purpose}, ttl ${ttlMin} min, owner ${owner}). Output: ${entry.log}`);
  return 0;
};

const checkinVerb = async (env) => {
  const run = openRun({ root: cosRoot(env) });
  if (!run) { say(`COS: ${NO_RUN} Nothing checked.`); return 0; }
  // First, before anything else: an Orchestrator waiting on the chief of
  // staff has ended its turn, so every other source reads it as idle.
  const now = nowMs(env);
  for (const q of openOrchestratorAsks(run.events)) {
    say(`COS: ${q.from} has waited ${ageMin(q.ts, now)} min on the chief of staff: cos:${q.id} "${q.title}". Answer with \`afk cos answer --id=${q.id} "<text>"\`.`);
  }
  printFlagged(run);
  const { checkin } = await import("./cos/checkin.mjs");
  const event = await checkin(run, env);
  say(
    `COS: check-in ${event.ts}: ${event.runs.length} run(s), deploys left ${event.deploysLeft}, gate lock ${event.gateLock ? `held by pid ${event.gateLock.pid}` : "free"}.`,
    ...event.triggers.map((t) => `COS: ${t.kind} #${t.epic}${t.task ? ` task ${t.task}` : ""}${event.notified.includes(`${t.kind}:${t.root}:${t.task ?? ""}`) ? " (notified)" : ""}`),
  );
  return 0;
};

const stop = (env) => {
  const run = openRun({ root: cosRoot(env) });
  // Unload first and always: a check-in left behind by a crashed run is the
  // timer that woke a session cold at 06:53 on 2026-10-13.
  const agent = uninstall({ home: homedir() });
  const agentLine = agent.existed || agent.unloaded
    ? `COS: check-in agent ${agent.unloaded ? "unloaded" : `not loaded (${agent.detail || "launchctl failed"})`} and removed.`
    : "COS: no check-in agent was installed.";
  if (!run) { say(agentLine, `COS: ${NO_RUN} Nothing else to stop.`); return 0; }
  printFlagged(run);
  // Kill, then close the run under the lock only if the register did not
  // grow meanwhile; a `cos run` that registered during the kills is killed on
  // the next pass rather than left behind a closed run.
  const outcome = { killed: [], gone: [], refused: [], survived: [] };
  const handled = new Set();
  let events = run.events;
  let closed = null;
  for (;;) {
    const fresh = events.filter((event) => event.kind === "process" && !handled.has(event.pid));
    const pass = stopProcesses(fresh);
    for (const key of Object.keys(outcome)) outcome[key].push(...pass[key]);
    for (const event of fresh) handled.add(event.pid);
    let latest = events;
    closed = appendEvent(run.dir, "stop", (now) => ({
      killed: outcome.killed.map((p) => p.pid),
      gone: outcome.gone.map((p) => p.pid),
      refused: outcome.refused.map((p) => ({ pid: p.pid, reason: p.reason })),
      survived: outcome.survived.map((p) => p.pid),
      ownerInterventions: now.filter((event) => event.kind === "owner_intervention").length,
    }), env, { unless: (now) => { latest = now; return now.some((event) => event.kind === "process" && !handled.has(event.pid)); } });
    if (closed) break;
    events = latest;
  }
  const { ownerInterventions } = closed;
  say(
    ...outcome.killed.map((p) => `COS: killed pid ${p.pid} (${p.purpose}) and its group, ${p.members} process(es); kill -0 confirms each is gone.`),
    ...outcome.refused.map((p) => `COS: refused pid ${p.pid}: ${p.reason}, so it may be another process now. Left running; check it by hand.`),
    ...outcome.survived.map((p) => `COS: pid ${p.pid} (${p.purpose}): ${p.left.join(", ")} STILL ALIVE after SIGKILL.`),
    agentLine,
    `COS: stopped run ${run.id}: killed ${outcome.killed.length}, already gone ${outcome.gone.length}, refused ${outcome.refused.length}, still alive ${outcome.survived.length}; owner interventions: ${ownerInterventions}.`,
  );
  return outcome.survived.length ? 1 : 0;
};

export const main = async (argv, env = process.env) => {
  const parsed = parseCos(argv);
  switch (parsed.verb) {
    case "start": return start(parsed, env);
    case "log": return log(parsed, env);
    case "ask": return ask(parsed, env);
    case "answer": return answer(parsed, env);
    case "report": return report(parsed, env);
    case "plan": return plan(parsed, env);
    case "run": return runProcess(parsed, env);
    case "checkin": return checkinVerb(env);
    case "stop": return stop(env);
    case "handoff": return (await import("./cos-handoff.mjs")).main(parsed.positional.concat(Object.entries(parsed.flags).map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`))), env);
    default: return refuse(`unknown verb ${parsed.verb ?? "(none)"}. Verbs: start, log, ask, answer, report, plan, run, checkin, handoff, stop.`);
  }
};

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
