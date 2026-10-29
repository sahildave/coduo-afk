// scripts/hub/page.mjs — what the hub shows, and the page that shows it (#229).
//
// `hubView` gathers it, read only: every run (`listRuns`), each run's open
// gates from its state.json, its PR and Vercel state from the latest check-in,
// what needs the owner, the store's recent events, the last check-in and the
// latest hub sends. `renderPage` turns that into one HTML page with the
// visual-explainer runtime (page.css, page.js) inlined.
//
// Every element a comment can land on carries `data-run` (the run id,
// `<project>#<epic>`, or the chief-of-staff run id for store rows) and
// `data-field` (a stable key such as `status`, `pr`, `gate:229`), so a comment
// is anchored on those, never on the words selected.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openGates } from "../cos/checkin.mjs";
import { alive } from "../cos/register.mjs";
import { ageMin, latestReport, openOrchestratorAsks, parseReport, promptFor } from "../cos/report.mjs";
import { cosRoot, flagLines, newestRun, nowMs, openRun } from "../cos/store.mjs";
import { orchestratorFatal } from "../dashboard-data.mjs";
import { anchorLabel, readItems } from "./inbox.mjs";
import { planChart, renderPlan } from "./plan.mjs";
import { listRuns } from "./runs.mjs";

const EVENTS_SHOWN = 15;
const SENDS_SHOWN = 10;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** One line for a store event, the same wording the handoff uses. */
export const eventLine = (event) => {
  switch (event.kind) {
    case "checkin": return `${event.runs?.length ?? 0} run(s); triggers: ${(event.triggers ?? []).map((t) => `${flagLabel(t.kind)} #${t.epic}${t.task ? ` task ${t.task}` : ""}`).join(", ") || "none"}; deploys left ${event.deploysLeft ?? "?"}`;
    case "process": return `pid ${event.pid}: ${event.purpose} (owner ${event.owner}, ttl ${event.ttlMin} min)`;
    case "handoff": return `${event.session} → ${event.path}`;
    case "ask": return `cos:${event.id}${event.from ? ` from ${event.from}` : ""} ${event.title}`;
    case "answer": return `cos:${event.id}${event.from ? ` to ${event.from}` : ""}: ${event.text}`;
    case "plan": return `plan for ${(event.epics ?? []).map((row) => `#${row.epic}`).join(", ")} from ${event.from ?? "?"}`;
    case "report": return `report.md ${event.append ? "appended to" : "stored"}; sections: ${(event.sections ?? []).join(", ") || "none"}`;
    case "stop": return `killed ${event.killed?.length ?? 0}, refused ${event.refused?.length ?? 0}, still alive ${event.survived?.length ?? 0}`;
    default: return event.text ?? "";
  }
};

/**
 * True when a response sent from the hub after the question answers it: its
 * Markdown (page.js `buildResponse`) has the `[ask:cos:<id>]` line without
 * the `_(not answered)_` mark. Any status counts: sent is answered.
 */
export const answers = (item, question) =>
  item.via === "respond" && item.ts >= question.ts &&
  String(item.text).split("\n").some((line) => line.includes(`[ask:cos:${question.id}]`) && !line.includes("_(not answered)_"));

const parsedReport = (found) => {
  const { summary, sections } = parseReport(found.text);
  return {
    id: found.id,
    path: found.path,
    summary,
    sections: sections.map((section) => ({ ...section, prompt: promptFor(found, section) })),
  };
};

export const hubView = async (env = process.env) => {
  const cos = openRun({ root: cosRoot(env) });
  // After `afk cos stop` no run is open. The read-only history (check-in,
  // Decided, Night log, Recent events) then comes from the newest run, which
  // the page labels as closed; what needs the owner still comes only from an
  // open run.
  const closedRun = cos ? null : newestRun({ root: cosRoot(env) });
  const history = cos ?? closedRun;
  const lastCheckin = history?.events.filter((event) => event.kind === "checkin").at(-1) ?? null;
  const runs = (await listRuns(env)).map((run) => {
    const state = readJson(join(run.root, ".afk", "state.json"));
    const row = lastCheckin?.runs?.find((candidate) => candidate.root === run.root) ?? null;
    return {
      ...run,
      gates: state ? openGates(state) : row?.gates ?? [],
      pr: row?.pr ?? null,
      deploy: row?.deploy ?? null,
      fatal: orchestratorFatal(state),
    };
  });
  const triggers = cos ? (lastCheckin?.triggers ?? []).filter((t) => t.kind !== "gate") : [];
  const { items, flagged } = readItems(env);
  const closed = new Set((cos?.events ?? []).filter((event) => event.kind === "answer").map((event) => event.id));
  const questions = (cos?.events ?? []).filter((event) => event.kind === "ask" && !event.from && !closed.has(event.id))
    .filter((question) => !items.some((item) => answers(item, question)));
  const now = nowMs(env);
  // An Orchestrator's ask stays until the chief of staff records the answer
  // (`afk cos answer`); an owner's answer sent from the hub only marks it queued.
  const waiting = openOrchestratorAsks(cos?.events ?? [])
    // Only a response to cos counts: one sent straight to the Orchestrator never
    // reaches `afk hub queue cos`, so the chief of staff could never record it.
    .map((q) => ({ ...q, ageMin: ageMin(q.ts, now), queued: items.some((item) => item.target === "cos" && answers(item, q)) }));
  // The newest run with a report, open or not: after `afk cos stop` no run is
  // open, and the report is what the owner opens the hub for.
  const found = latestReport(env);
  const report = found ? parsedReport(found) : null;
  const all = history?.events ?? [];
  const newestOf = (kinds) => all.filter((event) => kinds.includes(event.kind)).reverse();
  return {
    cos,
    closedRun: closedRun ? { id: closedRun.id } : null,
    questions,
    waiting,
    report,
    decided: newestOf(["grant", "decision"]),
    nightLog: newestOf(["note", "comment", "owner_intervention"]),
    // `afk cos stop` killed a closed run's processes; they are not shown.
    processes: (cos?.events ?? []).filter((event) => event.kind === "process").map((event) => ({ ...event, alive: alive(event.pid) })),
    runs,
    // Only an open run's plan is drawn: after `afk cos stop` the night is over.
    plan: planChart({ cos, runs, now }),
    triggers,
    lastCheckin,
    events: all.slice(-EVENTS_SHOWN).reverse(),
    sends: items.slice(-SENDS_SHOWN).reverse(),
    flagged: [...(cos?.flagged ?? []), ...flagged],
  };
};

const field = (key, label, value, cls = "") =>
  `<div data-field="${esc(key)}"${cls ? ` class="${esc(cls)}"` : ""}><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

// Events are stamped in UTC; the page shows the machine's local time and
// keeps the UTC stamp in `datetime`.
const pad = (n) => String(n).padStart(2, "0");
const localTime = (ts) => {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return `<time>${esc(ts)}</time>`;
  return `<time datetime="${esc(ts)}">${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}</time>`;
};

const KIND_LABEL = { grant: "grant · owner's words", owner_intervention: "owner intervention" };
const kindLabel = (kind) => KIND_LABEL[kind] ?? kind;
const eventRow = (cosId, event) =>
  `<li data-run="${esc(cosId)}" data-field="event:${esc(event.ts)}:${esc(event.kind)}">${localTime(event.ts)}<span class="kind">${esc(kindLabel(event.kind))}</span><span class="verbatim">${esc(event.text)}</span></li>`;

// A check-in flag in words: `not_answering` reads as "not answering".
const flagLabel = (kind) => String(kind ?? "").replace(/_/g, " ");

const TRIGGER_TEXT = {
  stall: "stalled: no runner progress",
  red_deploy: "Vercel check red on its PR",
  finished: "finished: close it out",
  not_answering: "dashboard not answering",
  gate: "gate open: waiting for you to accept",
};
// One wording for a flag, in Latest check-in and in Needs you: "#583 stalled: …".
const triggerText = (t) => `#${t.epic}${t.task ? ` task ${t.task}` : ""} ${TRIGGER_TEXT[t.kind] ?? flagLabel(t.kind)}`;

// Under a section's heading when its events come from a closed run (#4 of the
// hub demo fixes): after `afk cos stop` the history stays, marked as past.
const closedLabel = (closedId) => closedId ? `<p class="ve-label from-run">from run <b>${esc(closedId)}</b> (closed)</p>` : "";

// #245 item 2: the plan page's read-only sections, each left out when empty.
const checkinSection = (cosId, c, closedId = null) => !c ? "" : `
  <section class="hub-sec" data-run="${esc(cosId)}" data-field="checkin">
    <h2>Latest check-in</h2>
    ${closedLabel(closedId)}
    <dl class="fields">
      ${field("checkin-time", "Time", localTime(c.ts))}
      ${field("checkin-runs", "Runs counted", esc(c.runs?.length ?? 0))}
      ${field("checkin-gate-lock", "Gate lock", c.gateLock ? `held by pid ${esc(c.gateLock.pid)}` : "free")}
      ${field("checkin-deploys-left", "Deploys left", esc(c.deploysLeft ?? "unknown"))}
    </dl>
    ${c.triggers?.length ? `<ul class="notices">${c.triggers.map((t) => `<li data-field="checkin-flag:${esc(t.kind)}:${esc(t.epic)}${t.task ? `:${esc(t.task)}` : ""}">${esc(triggerText(t))}${(c.notified ?? []).includes(`${t.kind}:${t.root}:${t.task ?? ""}`) ? " (notified)" : ""}</li>`).join("")}</ul>` : ""}
  </section>`;

const eventSection = (cosId, key, title, events, closedId = null) => !events.length ? "" : `
  <section class="hub-sec" data-run="${esc(cosId)}" data-field="${esc(key)}">
    <h2>${esc(title)}</h2>
    ${closedLabel(closedId)}
    <ul class="events">${events.map((event) => eventRow(cosId, event)).join("")}</ul>
  </section>`;

const processSection = (cosId, processes) => !processes.length ? "" : `
  <section class="hub-sec" data-run="${esc(cosId)}" data-field="processes">
    <h2>Processes</h2>
    <ul class="events">${processes.map((p) => `<li data-run="${esc(cosId)}" data-field="process:${esc(p.pid)}">${localTime(p.ts)}<span class="kind">${p.alive ? "alive" : "gone"}</span><span>pid ${esc(p.pid)}: ${esc(p.purpose)} (ttl ${esc(p.ttlMin)} min)</span></li>`).join("")}</ul>
  </section>`;

const statusClass = (status) => `st-${String(status ?? "").replace(/\s+/g, "-")}`;

const prText = (pr) => {
  if (!pr) return "none known";
  if (pr === "unknown") return "unknown";
  return pr.url ? `<a href="${esc(pr.url)}">#${esc(pr.number)}</a> ${esc(pr.state ?? "")}` : `#${esc(pr.number)} ${esc(pr.state ?? "")}`;
};

// #244: the dashboard's bar (dashboard.html `renderHead`): done, active,
// review + gate, failed + stale, each a share of all tasks, in its colours.
// A dashboard running older code sends no `counts`; it keeps the plain bar.
const SEGMENTS = [
  ["done", "passed", (c) => c.done],
  ["active", "building", (c) => c.active],
  ["review", "in review or waiting for you", (c) => c.review + c.gate],
  ["failed", "failed or stale", (c) => c.failed + c.stale],
];
const progressBar = ({ total, passed }, counts) => {
  const plain = `<progress max="${esc(total)}" value="${esc(passed)}"></progress>`;
  if (!counts || typeof counts !== "object" || !(total > 0)) return plain;
  const parts = SEGMENTS.map(([cls, label, n]) => [cls, label, Number(n(counts)) || 0]).filter(([, , n]) => n > 0);
  if (!parts.length) return plain;
  // The words carry the sections; the bar only repeats them in colour.
  const key = parts.map(([, label, n]) => `${n} ${label}`).join(", ");
  return `<span class="pbar" aria-hidden="true">${parts
    .map(([cls, , n]) => `<span class="seg seg-${cls}" style="width:${Math.round((n / total) * 10000) / 100}%"></span>`).join("")}</span><small class="pbar-key">${esc(key)}</small>`;
};

const runBlock = (run) => `
<details class="claim" data-l="1" data-run="${esc(run.id)}" open>
  <summary data-field="title"><span class="c-text">${esc(run.project ?? run.root)} <span class="epic">· epic #${esc(run.epic ?? "?")}</span></span><span class="c-meta"><span class="chip ${esc(statusClass(run.status))}" data-field="status">${esc(run.status ?? "unknown")}</span></span></summary>
  <div class="c-body"><dl class="fields">
    ${field("progress", "Progress", run.progress ? `${esc(run.progress.passed)} of ${esc(run.progress.total)} tasks passed${progressBar(run.progress, run.counts)}` : "unknown")}
    ${field("pr", "PR", prText(run.pr))}
    ${field("deploy", "Vercel", esc(run.deploy ?? "unknown"))}
    ${field("gates", "Open gates", run.gates.length ? `<span class="gates-open">${esc(run.gates.join(", "))}</span>` : "none")}
    ${run.fatal ? field("fatal", "Orchestrator died", `${localTime(run.fatal.at)} ${esc(run.fatal.message)}`, "wide fatal") : ""}
    ${field("branch", "Branch", `<code>${esc(run.branch ?? "unknown")}</code>`, "wide")}
    ${field("dashboard", "Dashboard", run.dashboard ? `<a href="${esc(run.dashboard)}" target="_blank" rel="noopener noreferrer">${esc(run.dashboard)}</a> <small>found by ${esc(run.source)}</small>` : run.status === "waits for you" ? "none — the run stopped at a gate" : run.status === "closed" ? "none — the run closed" : "none — it did not start; the run carries on without it", "wide")}
    ${field("root", "Checkout", `<code>${esc(run.root)}</code>`, "wide")}
  </dl></div>
</details>`;

const gateAsk = (run, task) => `
<fieldset class="ask" data-ask="${esc(run.id)}:gate:${esc(task)}" data-run="${esc(run.id)}" data-field="gate:${esc(task)}" data-cli="afk epic ${esc(run.epic)} --accept=${esc(task)}">
  <legend>Needs you · ${esc(run.id)} · <span class="ask-st">to answer</span></legend>
  <p class="ask-q">Accept task ${esc(task)} of epic #${esc(run.epic)}?</p>
  <div class="ask-opts">
    <label class="opt"><input type="radio" name="gate-${esc(run.id)}-${esc(task)}" value="accept"><span class="opt-body"><span class="opt-label">Accept</span><small>The Orchestrator runs <code>afk epic ${esc(run.epic)} --accept=${esc(task)}</code>.</small></span></label>
    <label class="opt"><input type="radio" name="gate-${esc(run.id)}-${esc(task)}" value="hold"><span class="opt-body"><span class="opt-label">Hold</span><small>Leave the gate closed; say why in a comment.</small></span></label>
  </div>
</fieldset>`;

// A chief-of-staff question (`afk cos ask`, #245), the same markup as gateAsk.
const cosAsk = (cosId, q) => `
<fieldset class="ask" data-ask="cos:${esc(q.id)}" data-run="${esc(cosId)}" data-field="ask:${esc(q.id)}">
  <legend>Chief of staff asks · ${esc(q.id)} · <span class="ask-st">to answer</span></legend>
  <p class="ask-q">${esc(q.title)}</p>
  ${q.why ? `<p><small>${esc(q.why)}</small></p>` : ""}
  <div class="ask-opts">
    ${(q.options ?? []).map((o) => `<label class="opt"><input type="radio" name="cos-${esc(q.id)}" value="${esc(o.value)}"${o.value === q.rec ? " checked" : ""}><span class="opt-body"><span class="opt-label">${esc(o.label)}</span>${o.value === q.rec ? "<small>recommended</small>" : ""}${o.detail ? `<small>${esc(o.detail)}</small>` : ""}</span></label>`).join("\n    ")}
  </div>
</fieldset>`;

// An Orchestrator's question to the chief of staff (`afk cos ask --from`): a
// card like cosAsk, answered in the owner's own words (it has no options).
// Respond sends the words to the chief of staff's queue under the ask id
// (`[ask:cos:<id>]`, page.js `buildResponse`); the chief of staff records them
// with `afk cos answer` and relays them. Until then the card stays, marked
// queued once the owner has sent an answer. The ask id stays in attributes.
const orchAsk = (cosId, q) => `
<fieldset class="ask" data-ask="cos:${esc(q.id)}" data-run="${esc(cosId)}" data-field="ask:${esc(q.id)}" data-from="${esc(q.from)}"${q.queued ? ' data-queued="1"' : ""}>
  <legend>${esc(q.from)} asks the chief of staff · waiting ${esc(q.ageMin)} min · <span class="ask-st">${q.queued ? "your answer is queued" : "to answer"}</span></legend>
  <p class="ask-q">${esc(q.title)}</p>
  ${q.why ? `<p><small>${esc(q.why)}</small></p>` : ""}
  <label class="ask-free"><span class="ve-label">${q.queued ? "Your answer is queued for the chief of staff. To change it, write here and send again." : `Your answer, in your words. The chief of staff relays it to ${esc(q.from)} as you wrote it.`}</span><textarea name="answer-${esc(q.id)}" class="r-note" rows="3"></textarea></label>
</fieldset>`;

// The morning report (`afk cos report`): the summary, then one card per
// `## <repo>#<epic>` section. The hub renders Markdown as the Respond modal
// does, preformatted (`.r-md`); the Copy prompt carries a fresh chat's brief.
const reportSection = (report) => !report ? "" : `
  <section class="hub-sec" data-run="${esc(report.id)}" data-field="report">
    <h2>Morning report</h2>
    <p class="ve-label">Run <b>${esc(report.id)}</b> · <code>${esc(report.path)}</code></p>
    ${report.summary ? `<pre class="r-md report-md" data-field="report-summary">${esc(report.summary)}</pre>` : ""}
    ${report.sections.map((section) => `
    <details class="claim report-card" data-l="1" data-run="${esc(report.id)}" data-field="report:${esc(section.key)}" open>
      <summary><span class="c-text">${esc(section.key)}</span></summary>
      <div class="c-body"><p class="report-actions"><button type="button" class="copy-prompt" data-prompt="${esc(section.prompt)}">Copy prompt</button></p><pre class="r-md report-md">${esc(section.text)}</pre></div>
    </details>`).join("")}
  </section>`;

// #243: tabs. Overview is the page as it was; each run from `listRuns` (the
// list `/runs.json` serves) gets a tab whose panel frames its own dashboard,
// with `?embed=1` so the dashboard hides its peer strip. page.js sets a frame's
// `src` from `data-src` when its tab first opens, so an unopened tab costs no
// requests. A run not answering gets its state in words, never an empty frame.
// The machine-wide views (scripts/machine-views.mjs): no run behind them, so
// they are pinned to the right of the bar after the run tabs. The server
// serves their pages and JSON itself.
const MACHINE_TABS = [
  { key: "spending", label: "AFK spending", src: "/usage.html" },
  { key: "lanes", label: "AFK lanes", src: "/lanes.html" },
];

const tabStrip = (runs) => `<nav class="hub-tabs" role="tablist" aria-label="Overview, runs, spending and lanes">
  <button type="button" role="tab" id="tab-0" data-tab="overview" aria-controls="panel-0" aria-selected="true">Overview</button>
  ${runs.map((run, i) => `<button type="button" role="tab" id="tab-${i + 1}" data-tab="${esc(run.id)}" aria-controls="panel-${i + 1}" aria-selected="false" tabindex="-1"><span class="dot ${esc(statusClass(run.status))}" aria-hidden="true"></span>${esc(run.project ?? run.root)} <span class="epic">#${esc(run.epic ?? "?")}</span>${run.status === "running" ? "" : ` <span class="tab-st">${esc(run.status ?? "unknown")}</span>`}</button>`).join("\n  ")}
  ${MACHINE_TABS.map((tab, i) => `<button type="button" role="tab" class="pin${i === 0 ? " pin-first" : ""}" id="tab-${runs.length + 1 + i}" data-tab="${tab.key}" aria-controls="panel-${runs.length + 1 + i}" aria-selected="false" tabindex="-1">${tab.label}</button>`).join("\n  ")}
</nav>`;

const machinePanels = (runs) => MACHINE_TABS.map((tab, i) => `
<section class="tab-panel run-panel" id="panel-${runs.length + 1 + i}" role="tabpanel" aria-labelledby="tab-${runs.length + 1 + i}" data-tab="${tab.key}" hidden>
  <iframe data-src="${tab.src}?embed=1" title="${tab.label}"></iframe>
</section><!-- /tab -->`).join("");

const runPanel = (run, i) => `
<section class="tab-panel run-panel" id="panel-${i + 1}" role="tabpanel" aria-labelledby="tab-${i + 1}" data-tab="${esc(run.id)}" hidden>
  ${run.status === "not answering" ? `<div class="run-down">
    <p class="eyebrow">${esc(run.project ?? run.root)} · epic #${esc(run.epic ?? "?")}</p>
    <p><span class="chip ${esc(statusClass(run.status))}">not answering</span></p>
    <p>Its <code>.afk/state.json</code> records the dashboard on port ${esc(run.port)}, and nothing answers there. To serve it again, run <code>PORT=${esc(run.port)} afk dashboard</code> in <code>${esc(run.root)}</code>, then reload the hub.</p>
  </div>` : run.status === "waits for you" ? `<div class="run-down">
    <p class="eyebrow">${esc(run.project ?? run.root)} · epic #${esc(run.epic ?? "?")}</p>
    <p><span class="chip ${esc(statusClass(run.status))}">waits for you</span></p>
    <p>The run stopped and waits for you at gate ${esc(run.gates.join(", "))}; its runner has exited, so it serves no dashboard. Answer the gate on the Overview, or run <code>afk status</code> in <code>${esc(run.root)}</code> for the command that accepts it.</p>
  </div>` : run.status === "closed" ? `<div class="run-down">
    <p class="eyebrow">${esc(run.project ?? run.root)} · epic #${esc(run.epic ?? "?")}</p>
    <p><span class="chip ${esc(statusClass(run.status))}">closed</span></p>
    <p>The epic closed; its runner has exited, so it serves no dashboard. Run <code>afk status</code> in <code>${esc(run.root)}</code> for its closeout.</p>
  </div>` : !run.dashboard ? `<div class="run-down">
    <p class="eyebrow">${esc(run.project ?? run.root)} · epic #${esc(run.epic ?? "?")}</p>
    <p><span class="chip ${esc(statusClass(run.status))}">no dashboard</span></p>
    <p>Its dashboard did not start, and the run carries on without it; the reason is in <code>${esc(run.root)}/.afk/dashboard.log</code>. To serve one, run <code>afk dashboard</code> in <code>${esc(run.root)}</code>, then reload the hub.</p>
  </div>` : `<iframe data-src="${esc(run.dashboard)}?embed=1" title="Dashboard for ${esc(run.id)}"></iframe>`}
</section><!-- /tab -->`;

/** The whole page. `token` is checked on every POST. */
export const renderPage = (view, { token }) => {
  const css = readFileSync(new URL("./page.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("./page.js", import.meta.url), "utf8");
  const cosId = view.cos?.id ?? "store";
  const waiting = view.waiting ?? [];
  const asks = [
    ...(view.questions ?? []).map((q) => cosAsk(cosId, q)),
    ...waiting.map((q) => orchAsk(cosId, q)),
    ...view.runs.flatMap((run) => run.gates.map((task) => gateAsk(run, task))),
  ];
  // A card whose answer is already queued no longer waits on the owner.
  const open = asks.length - waiting.filter((q) => q.queued).length;
  const notices = view.triggers.map((t) => {
    const run = view.runs.find((candidate) => candidate.root === t.root);
    return `<li data-run="${esc(run?.id ?? cosId)}" data-field="${esc(t.kind)}">${esc(triggerText(t))}</li>`;
  });
  const checkin = view.lastCheckin;
  // The history sections' run: the open one, or after `afk cos stop` the newest.
  const closedId = view.closedRun?.id ?? null;
  const historyId = closedId ?? cosId;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="afk-hub-token" content="${esc(token)}">
<title>afk hub</title>
<link rel="icon" type="image/png" href="/favicon.ico">
<style>${css}</style>
</head>
<body data-tab="overview">
${tabStrip(view.runs)}
<section class="tab-panel" id="panel-0" role="tabpanel" aria-labelledby="tab-0" data-tab="overview">
<main class="hub-page">
  <header>
    <p class="eyebrow">afk hub · this machine</p>
    <h1>${view.runs.length} run${view.runs.length === 1 ? "" : "s"}${open ? ` <span class="h1-sub">· ${open} need${open === 1 ? "s" : ""} you</span>` : ""}</h1>
    <p class="ve-label">${view.cos ? `Chief of staff run <b>${esc(view.cos.id)}</b> (${esc(view.cos.meta?.mode ?? "?")})` : "No chief-of-staff run is open."} Respond answers what needs you. To comment, select any text, or write in Respond.</p>
    <p class="ve-last" role="status"></p>
    ${view.flagged.length ? `<ul class="notices">${flagLines(view.flagged).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
  </header>
  ${renderPlan(view.plan, cosId)}
  <section class="hub-sec" data-run="${esc(cosId)}" data-field="needs-you">
    <h2>Needs you</h2>
    ${asks.join("") || `<p class="empty">${notices.length ? "No question waits for you." : "Nothing waits for you."}</p>`}
    ${notices.length ? `<ul class="notices">${notices.join("")}</ul>` : ""}
  </section>
  ${reportSection(view.report)}
  <section class="hub-sec">
    <h2>Runs</h2>
    ${view.runs.map(runBlock).join("") || '<p class="empty">No run answers on this machine.</p>'}
  </section>
  ${checkinSection(historyId, checkin, closedId)}
  ${eventSection(historyId, "decided", "Decided", view.decided ?? [], closedId)}
  ${eventSection(historyId, "night-log", "Night log", view.nightLog ?? [], closedId)}
  ${processSection(cosId, view.processes ?? [])}
  <section class="hub-sec" data-run="${esc(historyId)}" data-field="events">
    <h2>Recent events</h2>
    ${closedLabel(view.events.length ? closedId : null)}
    ${view.events.length ? `<ul class="events">${view.events.map((event) => `<li data-run="${esc(historyId)}" data-field="event:${esc(event.ts)}:${esc(event.kind)}">${localTime(event.ts)}<span class="kind">${esc(kindLabel(event.kind))}</span><span>${esc(eventLine(event))}</span></li>`).join("")}</ul>` : '<p class="empty">No events.</p>'}
  </section>
  <section class="hub-sec">
    <h2>Sent from the hub</h2>
    ${view.sends.length ? `<ul class="events">${view.sends.map((item) => `<li data-run="inbox" data-field="item:${esc(item.id)}">${localTime(item.ts)}<span class="kind">${esc(item.status)}</span><span>to ${esc(item.target)}${item.via === "respond" ? " (Respond)" : `, on ${esc(anchorLabel(item.anchor))}`}: ${esc(String(item.text).slice(0, 160))}</span></li>`).join("")}</ul>` : '<p class="empty">Nothing sent yet.</p>'}
  </section>
</main>
</section><!-- /tab -->
${view.runs.map(runPanel).join("")}${machinePanels(view.runs)}
<script>${js}</script>
</body>
</html>
`;
};
