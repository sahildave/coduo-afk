// scripts/hub/artifact.mjs — the hub artifact (#274): the private claude.ai
// page the owner comments on and responds from, beside the local hub.
//
// `artifactPage()` is the page source the chief of staff publishes, with
// ARTIFACT_CAPABILITIES. It reads the newest document in the `snapshots`
// collection (written at each check-in from `afk hub snapshot`) and draws it
// with artifact-draw.mjs, inlined. Respond sends the owner's answers as one
// comment thread on `#cos` through `comments.sendToClaude`, which needs the
// full comments grant, not `composer_only`. With no snapshot it says so and
// draws nothing else: the design's sample fixture is test data
// (scripts/hub/fixtures/hub-snapshot.json) and never ships. Nothing here
// talks to claude.ai.
//
// The design is frozen (docs/design/hub-artifact/hub-proto.src.html, approved
// 2026-10-19): STYLE and the markup are copied from it unchanged.
//
// The published URL is saved machine-wide in `<cos root>/hub-artifact.json`
// (`~/.afk-claude/cos/` by default), not in a chief of staff run, so it
// survives every run and `afk cos start` can print it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cosRoot, nowMs } from "../cos/store.mjs";
import { drawEmpty } from "./artifact-draw.mjs";

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+\/?$/;

/** What the page needs granted when it is published. */
export const ARTIFACT_CAPABILITIES = '{comments: {}, db: {rules: [{path: "snapshots", read: "view", write: "owner"}]}}';

export const hubArtifactPath = (env = process.env) => join(cosRoot(env), "hub-artifact.json");

/** The saved hub artifact URL, or null. */
export const readHubArtifactUrl = (env = process.env) => {
  try { return JSON.parse(readFileSync(hubArtifactPath(env), "utf8")).url ?? null; } catch { return null; }
};

/** Save the URL; throws on anything that is not a claude.ai artifact link. */
export const saveHubArtifactUrl = (url, env = process.env) => {
  if (typeof url !== "string" || !ARTIFACT_URL.test(url)) throw new Error(`${url} is not a claude.ai artifact URL (https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id>)`);
  mkdirSync(cosRoot(env), { recursive: true });
  writeFileSync(hubArtifactPath(env), `${JSON.stringify({ url, savedAt: new Date(nowMs(env)).toISOString() }, null, 2)}\n`);
  return url;
};

// The draw module as part of a classic script: its `export` keywords dropped.
const drawSource = () => readFileSync(new URL("./artifact-draw.mjs", import.meta.url), "utf8")
  .replace(/^export /gm, "");

const STYLE = `
/* Layout: html-plan's dark document column widened to 1080px. Header tiles, a segmented tab bar
   (Hub / Decide / Night log left, AFK spending / AFK lanes pinned right), numbered epic cards,
   and html-plan's sticky bottom-right response bar with its Respond sheet.
   Palette: html-plan's semantic set (blue, green, amber, red, orange accent) with its dark and light
   values; the YOUR GO tile and Respond take one saturated blue. Dark first, like the screenshot. */
:root {
  --bg: #1a1a19; --card: #262624; --card-2: #30302e; --line: rgba(222,220,209,.14); --line-2: rgba(222,220,209,.07);
  --ink: #faf9f5; --ink-2: #c2c0b6; --ink-3: #9c9a92;
  --blue: #7aa7e0; --blue-soft: #25313f; --green: #6fb37a; --green-soft: #26372a;
  --amber: #d9a441; --amber-soft: #3d331f; --red: #e5776e; --red-soft: #432725;
  --orange: #d97757; --orange-soft: #46302a;
  --amber-fill: #d9a441; --on-amber: #1a1a19;
  --go: #2f6fd6; --go-2: #4a86e8; --on-go: #ffffff;
  --e1: var(--blue); --e2: var(--green); --e3: var(--orange);
  --scrim: rgba(0,0,0,.55); --float: 0 6px 24px rgba(0,0,0,.45);
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --r: 14px; --r-sm: 9px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg: #f4f2ec; --card: #ffffff; --card-2: #f0eee6; --line: rgba(31,30,29,.15); --line-2: rgba(31,30,29,.07);
  --ink: #141413; --ink-2: #3d3d3a; --ink-3: #6b6a65;
  --blue: #2a69b8; --blue-soft: #dde8f5; --green: #2c7a39; --green-soft: #e2efdf;
  --amber: #8a5c0c; --amber-soft: #f4ead2; --red: #b3261e; --red-soft: #f7dfdc;
  --orange: #b9532f; --orange-soft: #f6e7df;
  --amber-fill: #e0a63a; --on-amber: #1f1a10;
  --go: #2563d0; --go-2: #3b78e0; --on-go: #ffffff;
  --scrim: rgba(20,18,14,.35); --float: 0 6px 24px rgba(0,0,0,.14);
  color-scheme: light } }
:root[data-theme="light"] {
  --bg: #f4f2ec; --card: #ffffff; --card-2: #f0eee6; --line: rgba(31,30,29,.15); --line-2: rgba(31,30,29,.07);
  --ink: #141413; --ink-2: #3d3d3a; --ink-3: #6b6a65;
  --blue: #2a69b8; --blue-soft: #dde8f5; --green: #2c7a39; --green-soft: #e2efdf;
  --amber: #8a5c0c; --amber-soft: #f4ead2; --red: #b3261e; --red-soft: #f7dfdc;
  --orange: #b9532f; --orange-soft: #f6e7df;
  --amber-fill: #e0a63a; --on-amber: #1f1a10;
  --go: #2563d0; --go-2: #3b78e0; --on-go: #ffffff;
  --scrim: rgba(20,18,14,.35); --float: 0 6px 24px rgba(0,0,0,.14);
  color-scheme: light }

* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font: 400 12.6px/1.5 var(--sans); -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 28px 120px; }
main { max-width: 1080px; margin: 0 auto; display: grid; gap: 22px; }
h1 { font: 700 clamp(21.6px, 3.2vw, 28.8px)/1.1 var(--sans); letter-spacing: -.025em; margin: 0; text-wrap: balance; }
h2 { font: 600 10.8px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); margin: 0; }
h3 { font: 600 13.5px/1.3 var(--sans); margin: 0; min-width: 0; overflow-wrap: anywhere; }
p { margin: 0; }
code, .mono, time { font-family: var(--mono); font-size: .86em; font-variant-numeric: tabular-nums; }
:focus-visible { outline: 2px solid var(--go-2); outline-offset: 2px; }
button { font: inherit; color: inherit; cursor: pointer; }
.muted { color: var(--ink-2); } .faint { color: var(--ink-3); }
.sec { display: grid; gap: 12px; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

/* header */
.top { display: grid; gap: 14px; position: relative; }
.kicker { font: 500 11.7px/1.4 var(--mono); color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.dek { color: var(--ink-2); font-size: 12.6px; max-width: 64ch; }
.sample { font: 600 9.9px/1 var(--sans); text-transform: uppercase; letter-spacing: .06em; padding: 5px 8px; border-radius: 99px; background: var(--amber-soft); color: var(--amber); }
.top .comment { position: absolute; top: 0; right: 0; }

/* stat tiles (visual-explainer .kpis, html-plan colours) */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.tile .lbl { font: 600 9.9px/1 var(--sans); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); }
.tile .val { font: 700 27px/1 var(--sans); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.tile .val small { font-size: 12.6px; font-weight: 500; color: var(--ink-3); letter-spacing: 0; }
.tile .sub { font-size: 11.7px; color: var(--ink-2); }
.tile.dec .val { color: var(--amber); }
.tile.dec.done .val { color: var(--green); }
.tile.go { background: linear-gradient(160deg, var(--go-2), var(--go)); border-color: transparent; color: var(--on-go); cursor: pointer; text-align: left; }
.tile.go .lbl, .tile.go .sub { color: var(--on-go); opacity: .9; }
.tile.go .val { font-size: 18px; line-height: 1.15; }
.tile.go .cta { justify-self: start; margin-top: 4px; font: 600 11.7px/1 var(--sans); padding: 8px 12px; border-radius: 99px; background: rgba(255,255,255,.18); }
.tile.go:hover { filter: brightness(1.06); }
.stack { display: flex; height: 8px; border-radius: 99px; overflow: hidden; background: var(--card-2); gap: 2px; }
.stack > span { display: block; height: 100%; }

/* segmented tab bar */
.tabbar { display: flex; justify-content: space-between; gap: 10px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20; padding-block: 8px; background: var(--bg); }
.seg { display: inline-flex; flex: none; gap: 2px; padding: 3px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); max-width: 100%; overflow-x: auto; }
.seg button { border: 0; background: none; color: var(--ink-2); font: 500 11.7px/1 var(--sans); padding: 9px 14px; border-radius: 9px; white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; }
.seg button:hover { color: var(--ink); }
.seg button[aria-selected="true"] { background: var(--card-2); color: var(--ink); box-shadow: 0 0 0 1px var(--line); }
.seg .n { font: 600 9.9px/1 var(--sans); padding: 3px 6px; border-radius: 99px; background: var(--amber-fill); color: var(--on-amber); }
.seg .n:empty { display: none; }
.seg.machine button[aria-selected="true"] { color: var(--blue); }

/* pills and chips (html-plan .pill) */
.pill { display: inline-flex; align-items: center; gap: 5px; font: 600 10.8px/1 var(--sans); padding: 5px 9px; border-radius: 99px; background: var(--card-2); color: var(--ink-2); white-space: nowrap; border: 0; }
.pill.amber { background: var(--amber-soft); color: var(--amber); }
.pill.green { background: var(--green-soft); color: var(--green); }
.pill.blue { background: var(--blue-soft); color: var(--blue); }
.pill.red { background: var(--red-soft); color: var(--red); }
.pill.orange { background: var(--orange-soft); color: var(--orange); }
button.pill:hover { filter: brightness(1.12); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: currentColor; }
.comment { font: 500 10.8px/1 var(--sans); color: var(--ink-3); background: none; border: 1px solid var(--line); border-radius: 99px; padding: 6px 11px; }
.comment:hover { color: var(--ink); border-color: var(--ink-3); }
.no-comments .comment { display: none; }

/* Gantt (hub/plan.mjs geometry, recoloured per epic) */
.gx-scroll { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px 10px; }
.gx { min-width: 680px; display: grid; gap: 10px; }
.gx-row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; align-items: start; }
.gx-name { font-size: 11.7px; line-height: 1.35; min-width: 0; }
.gx-name b { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 11.7px; }
.gx-name small { display: block; color: var(--ink-3); font-size: 10.8px; }
.gx-time { position: relative; min-height: 20px; }
.gx-axis .gx-time { height: 18px; border-bottom: 1px solid var(--line); }
.gx-hour { position: absolute; top: 0; transform: translateX(-50%); font: 9.9px/1 var(--mono); color: var(--ink-3); white-space: nowrap; }
.gx-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-2); }
.gx-lane { position: relative; height: calc(var(--tracks, 1) * 24px); }
.gx-lane.plan { height: calc(var(--tracks, 1) * 13px); margin-bottom: 4px; }
.gx-bar { position: absolute; top: calc(var(--track, 0) * 24px); height: 20px; border-radius: 5px; padding: 0 6px; font: 500 9.9px/20px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: color-mix(in srgb, var(--c) 30%, var(--card)); color: var(--ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 70%, transparent); }
.gx-bar.k-build { background: color-mix(in srgb, var(--c) 45%, var(--card)); }
.gx-bar.k-baseline, .gx-bar.k-closeout { --c: var(--ink-3); }
.gx-bar.k-gate-human { --c: var(--amber); background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--amber) 40%, var(--card)) 0 6px, color-mix(in srgb, var(--amber) 22%, var(--card)) 6px 12px); }
.gx-bar.k-parked { --c: var(--red); }
.gx-bar.open { border-top-right-radius: 0; border-bottom-right-radius: 0; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 70%, transparent), inset -3px 0 0 var(--c); }
.plan .gx-bar { top: calc(var(--track, 0) * 13px); height: 10px; padding: 0; font-size: 0; border-radius: 3px; box-shadow: none;
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) 45%, transparent) 0 3px, transparent 3px 7px); }
.gx-load { position: relative; border-bottom: 1px solid var(--ink-3); }
.gx-load svg { position: absolute; left: 0; bottom: 0; width: 100%; display: block; overflow: visible; }
.gx-tick { position: absolute; right: calc(100% + 4px); transform: translateY(50%); font: 9px/1 var(--mono); color: var(--ink-3); }
.gx-cap { position: absolute; right: 0; font: 600 9px/1 var(--mono); color: var(--red); }
.gx-now { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--amber); border-radius: 2px; z-index: 2; }
.gx-now-label { position: absolute; top: 0; transform: translateX(-50%); font: 600 9.9px/1 var(--mono); color: var(--on-amber); background: var(--amber-fill); padding: 3px 5px; border-radius: 4px; z-index: 3; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 10.8px; color: var(--ink-3); }
.legend i { display: inline-block; width: 18px; height: 9px; border-radius: 3px; vertical-align: -1px; margin-right: 5px; }
.legend .l-plan { background: repeating-linear-gradient(135deg, var(--ink-3) 0 3px, transparent 3px 7px); }
.legend .l-done { background: color-mix(in srgb, var(--blue) 45%, var(--card)); }
.legend .l-open { background: color-mix(in srgb, var(--blue) 45%, var(--card)); box-shadow: inset -3px 0 0 var(--blue); }
.legend .l-gate { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--amber) 50%, var(--card)) 0 4px, color-mix(in srgb, var(--amber) 25%, var(--card)) 4px 8px); }
.legend .l-now { width: 2px; background: var(--amber); }

/* epic cards: html-plan's numbered steps, one colour each */
.epics { display: grid; gap: 12px; }
.epic { --c: var(--e1); display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 14px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; }
.epic:nth-child(3n+2) { --c: var(--e2); } .epic:nth-child(3n+3) { --c: var(--e3); }
.num { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; font: 700 13.5px/1 var(--sans); background: color-mix(in srgb, var(--c) 22%, var(--card)); color: var(--c); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 55%, transparent); }
.epic-body { display: grid; gap: 10px; min-width: 0; }
.epic-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.epic-head h3 { margin-right: auto; }
.epic-head h3 .ep { color: var(--ink-3); font-weight: 500; }
.meta { font-size: 11.7px; color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 4px 14px; }
.prog { display: grid; gap: 6px; }
.prog .stack { height: 10px; }
.prog small { font-size: 11.7px; color: var(--ink-2); }
.s-done { background: var(--c, var(--green)); } .s-active { background: color-mix(in srgb, var(--c, var(--blue)) 45%, var(--card-2)); }
.s-gate { background: var(--amber); } .s-failed { background: var(--red); }
.row-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.toggle { font: 500 11.7px/1 var(--sans); background: var(--card-2); border: 1px solid var(--line); border-radius: 99px; padding: 7px 12px; }
.toggle[aria-expanded="true"] { color: var(--c); border-color: color-mix(in srgb, var(--c) 60%, transparent); }
.graphs { display: grid; gap: 10px; border-top: 1px solid var(--line-2); padding-top: 12px; }
.gtabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--card-2); justify-self: start; max-width: 100%; overflow-x: auto; }
.gtabs button { border: 0; background: none; color: var(--ink-2); font: 500 11.7px/1 var(--sans); padding: 7px 11px; border-radius: 7px; white-space: nowrap; }
.gtabs button[aria-selected="true"] { background: var(--card); color: var(--c); box-shadow: 0 0 0 1px var(--line); }
.gpanel { min-width: 0; }
.chart { width: 100%; max-width: 760px; height: auto; display: block; }
.chart text { font: 10.8px var(--mono); fill: var(--ink-3); }
.chart .lbl-end { font: 600 12.6px var(--mono); fill: var(--ink); }
/* task DAG (afk dashboard renderDag): work flows down, one band per dependency depth */
.dag-scroll { overflow-x: auto; max-width: 100%; }
.dag { position: relative; margin: 0 auto; }
.dag-edges { position: absolute; inset: 0; pointer-events: none; }
.dag-node { position: absolute; box-sizing: border-box; padding: 9px 11px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--st) 55%, var(--line)); background: linear-gradient(color-mix(in srgb, var(--st) 16%, var(--card)), var(--card) 70%); overflow: hidden; }
.dag-node.t-waiting { border-color: var(--line); background: var(--card); }
.dag-node.t-parked { border-style: dashed; }
.dag-head { display: flex; align-items: center; gap: 6px; }
.dag-head b { font: 600 11.7px/1.3 var(--mono); font-variant-numeric: tabular-nums; }
.dag-head .st { margin-left: auto; font: 600 9px/1 var(--sans); text-transform: uppercase; letter-spacing: .05em; color: var(--st); padding: 3px 7px; border-radius: 99px; background: color-mix(in srgb, var(--st) 16%, transparent); }
.dag-node .ttl { font-size: 11.2px; line-height: 1.3; margin-top: 6px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.t-passed { --st: var(--green); } .t-building, .t-integrating { --st: var(--blue); } .t-waiting { --st: var(--ink-3); } .t-gate { --st: var(--amber); } .t-parked, .t-failed { --st: var(--red); }

/* decisions (html-plan doc-ask, with option chips) */
.decide-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.ask { border: 1px solid var(--line); border-radius: var(--r); background: var(--card); padding: 16px 18px; margin: 0; display: grid; gap: 12px; min-width: 0; transition: border-color .15s, box-shadow .15s; }
.ask[data-state="todo"] { border-color: color-mix(in srgb, var(--amber) 55%, transparent); }
.ask[data-state="picked"], .ask[data-state="suggested"] { border-color: color-mix(in srgb, var(--green) 55%, transparent); }
.ask.flash { box-shadow: 0 0 0 2px var(--amber); }
.ask-head { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; }
.ask-head .num { --c: var(--amber); width: 30px; height: 30px; font-size: 13.5px; border-radius: 9px; }
.ask-head .from { font: 500 11.7px/1.3 var(--mono); color: var(--ink-3); margin-right: auto; min-width: 0; overflow-wrap: anywhere; }
.ask .q { font: 600 13.5px/1.4 var(--sans); text-wrap: pretty; }
.ask .why { color: var(--ink-2); font-size: 12.6px; max-width: 72ch; }
.opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 8px; }
.opt { position: relative; display: grid; gap: 4px; align-content: start; padding: 11px 13px; border-radius: 11px; border: 1px solid var(--line); background: var(--card-2); cursor: pointer; transition: border-color .12s, background .12s; }
.opt:hover { border-color: var(--ink-3); }
.opt input { position: absolute; opacity: 0; pointer-events: none; }
.opt b { font-weight: 600; font-size: 11.7px; line-height: 1.35; padding-right: 22px; }
.opt small { font-size: 10.8px; color: var(--ink-2); }
.opt .rec { font: 600 9.9px/1 var(--sans); text-transform: uppercase; letter-spacing: .05em; color: var(--blue); }
.opt::after { content: ""; position: absolute; top: 11px; right: 11px; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--ink-3); }
.opt:has(input:checked) { border-color: var(--green); background: color-mix(in srgb, var(--green) 14%, var(--card)); }
.opt:has(input:checked)::after { border-color: var(--green); background: var(--green); box-shadow: inset 0 0 0 3px var(--card); }
.opt:has(input:focus-visible) { outline: 2px solid var(--go-2); outline-offset: 2px; }
.own summary { cursor: pointer; font-size: 11.7px; color: var(--ink-3); width: max-content; max-width: 100%; }
.own textarea, .note { width: 100%; margin-top: 8px; min-height: 64px; resize: vertical; font: 12.6px/1.5 var(--sans); color: var(--ink); background: var(--card-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; }
.ask-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.ask-st { font: 600 10.8px/1 var(--sans); padding: 5px 9px; border-radius: 99px; }
.ask[data-state="todo"] .ask-st { background: var(--amber-fill); color: var(--on-amber); }
.ask[data-state="picked"] .ask-st, .ask[data-state="suggested"] .ask-st { background: var(--green-soft); color: var(--green); }
.ask[data-state="sent"] .ask-st { background: var(--blue-soft); color: var(--blue); }
.btn { font: 600 11.7px/1 var(--sans); padding: 9px 13px; border-radius: 99px; border: 1px solid var(--line); background: var(--card-2); color: var(--ink); }
.btn:hover { border-color: var(--ink-3); }
.btn.go { background: var(--go); color: var(--on-go); border-color: transparent; }
.btn.go:hover { background: var(--go-2); }
.btn.go[disabled] { opacity: .45; cursor: not-allowed; }
.btn.danger { color: var(--red); }

/* night log */
.log { list-style: none; margin: 0; padding: 0; display: grid; background: var(--card); border: 1px solid var(--line); border-radius: var(--r); }
.log li { display: grid; grid-template-columns: 52px 92px minmax(0, 1fr); gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line-2); font-size: 11.7px; }
.log li:first-child { border-top: 0; }
.log .kind { font: 600 9.9px/20px var(--sans); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }
.log .k-decision, .log .k-grant { color: var(--green); } .log .k-owner_intervention { color: var(--amber); }
@media (max-width: 560px) { .log li { grid-template-columns: 48px minmax(0, 1fr); } .log .kind { grid-column: 2; } .log li > span:last-child { grid-column: 1 / -1; } }

/* machine tabs */
.big { font: 700 23.4px/1 var(--sans); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.big small { font-size: 11.7px; font-weight: 500; color: var(--ink-3); letter-spacing: 0; }
.panel-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; display: grid; gap: 14px; min-width: 0; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 12px; }
.meter { height: 12px; border-radius: 99px; background: var(--card-2); overflow: hidden; }
.meter > span { display: block; height: 100%; background: linear-gradient(90deg, var(--go-2), var(--go)); border-radius: 99px; }
.hbars { display: grid; gap: 8px; }
.hbar { display: grid; grid-template-columns: 110px minmax(0, 1fr) 72px; gap: 10px; align-items: center; font-size: 11.7px; }
.hbar .track { height: 10px; border-radius: 99px; background: var(--card-2); overflow: hidden; }
.hbar .track > span { display: block; height: 100%; border-radius: 99px; background: var(--bc, var(--blue)); }
.hbar .v { text-align: right; font: 500 10.8px var(--mono); font-variant-numeric: tabular-nums; }
.hbar .k { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* dock and Respond sheet (html-plan .nw-bar / .nw-sheet) */
.dock { position: fixed; right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 40; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; max-width: calc(100vw - 32px); }
.dock button { font: 600 11.7px/1 var(--sans); padding: 10px 14px; border-radius: 99px; border: 0; box-shadow: var(--float); display: inline-flex; gap: 8px; align-items: center; white-space: nowrap; }
.dock .todo, .dock .next { background: var(--amber-fill); color: var(--on-amber); }
.dock .todo.clear { background: var(--green-soft); color: var(--green); }
.dock .respond { background: var(--go); color: var(--on-go); }
.dock .respond:hover { background: var(--go-2); }
.dock .respond .n { font: 600 10.8px/1 var(--sans); background: rgba(255,255,255,.25); border-radius: 99px; padding: 3px 7px; }
.dock .respond .n:empty { display: none; }
.sheet-bg { position: fixed; inset: 0; background: var(--scrim); z-index: 60; display: flex; align-items: flex-end; justify-content: center; }
.sheet { background: var(--card); color: var(--ink); width: min(760px, 100vw); max-height: 88vh; border-radius: 18px 18px 0 0; border: 1px solid var(--line); display: flex; flex-direction: column; box-shadow: var(--float); padding-bottom: env(safe-area-inset-bottom, 0px); }
@media (min-width: 800px) { .sheet-bg { align-items: center; } .sheet { border-radius: 18px; max-height: 84vh; } }
.sheet header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line-2); }
.sheet header h2 { flex: 1; font: 700 14.4px/1.2 var(--sans); text-transform: none; letter-spacing: 0; color: var(--ink); }
.sheet .body { overflow: auto; padding: 16px 20px; display: grid; gap: 16px; }
.sheet .cap { font: 600 10.8px/1 var(--sans); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); display: flex; gap: 8px; align-items: center; }
.rrow { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left; padding: 10px 12px; margin-top: 6px; border: 1px solid var(--line); border-left: 4px solid var(--amber); border-radius: var(--r-sm); background: var(--card-2); font: 12.6px/1.35 var(--sans); }
.rrow.picked { border-left-color: var(--green); } .rrow.suggested { border-left-color: var(--blue); }
.rrow .k { font: 600 10.8px/1.6 var(--mono); color: var(--ink-3); min-width: 14px; }
.rrow .q { flex: 1; min-width: 0; font-weight: 600; } .rrow .q small { display: block; font-weight: 400; font-size: 11.7px; color: var(--ink-2); margin-top: 2px; }
.rrow .s { font: 600 10.8px/1 var(--sans); padding: 4px 8px; border-radius: 99px; white-space: nowrap; background: var(--amber-fill); color: var(--on-amber); }
.rrow.picked .s { background: var(--green-soft); color: var(--green); } .rrow.suggested .s { background: var(--blue-soft); color: var(--blue); }
.sheet pre { margin: 0; font: 10.8px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px 14px; max-height: 300px; overflow: auto; }
.sheet footer { display: flex; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--line-2); flex-wrap: wrap; align-items: center; }
.sheet footer .sp { flex: 1; }
.send-state { font-size: 11.7px; color: var(--ink-2); width: 100%; }
.send-state.err { color: var(--red); } .send-state.ok { color: var(--green); }
.toast { position: fixed; left: 50%; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 10px 15px; border-radius: 99px; font: 600 11.7px var(--sans); z-index: 80; box-shadow: var(--float); max-width: calc(100vw - 32px); }
.empty { color: var(--ink-3); padding: 16px; border: 1px dashed var(--line); border-radius: var(--r); }
@media (max-width: 560px) {
  body { padding-block: 18px 150px; }
  .epic { grid-template-columns: 30px minmax(0, 1fr); gap: 10px; padding: 14px; } .epic > .num { width: 30px; height: 30px; font-size: 13.5px; border-radius: 9px; }
  .gx-row { grid-template-columns: 104px 1fr; } .gx { min-width: 620px; }
  .hbar { grid-template-columns: 84px minmax(0, 1fr) 62px; }
  .top .comment { position: static; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }
`;

// The page's own behaviour: the owner's picks, tabs, the dock and the Respond
// sheet, from the frozen design's script. Drawing is artifact-draw.mjs's.
const RUNTIME = `
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- state: the owner's picks, kept across redraws ---------- */
const KEY = "afk-hub-artifact:v1";
const S = { tab: "hub", answers: {}, sent: {}, note: "", open: {}, gtab: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* storage off: state lasts the visit */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ tab: S.tab, answers: S.answers, sent: S.sent, note: S.note })); } catch { /* see above */ } };

let snap = null;      // the snapshot drawn; null until the db holds one
let now = Date.now();
let decisions = [];   // buildDecisions(snap)

const isOpen = (d) => isOpenIn(S)(d);
const inResponse = (d) => inResponseIn(S)(d);
const ctx = () => drawContext(snap, { now, state: S });

const toast = (msg) => { const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2200); };

const drawDock = () => {
  const open = decisions.filter(isOpen).length;
  const chosen = decisions.filter((d) => inResponse(d) && !isOpen(d)).length + (S.note.trim() ? 1 : 0);
  const todo = $("#dock-todo");
  todo.textContent = open ? \`TODO (\${open})\` : "All answered";
  todo.classList.toggle("clear", !open);
  $("#dock-next").textContent = \`\${open} to answer ↓\`;
  $("#dock-next").hidden = !open;
  $("#respond-n").textContent = chosen ? String(chosen) : "";
  const tabN = $("#tab-n"); if (tabN) tabN.textContent = open ? String(open) : "";
};

const showTab = (key) => {
  S.tab = key; save();
  for (const b of $$(".tabbar [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === key));
  for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== key;
};

const draw = () => {
  if (!snap) return;
  decisions = buildDecisions(snap);
  $("#hub").innerHTML = drawSnapshot(snap, { now, state: S });
  drawDock();
  // A saved tab this snapshot does not draw (a Report tab, once the report is gone) falls back to Hub.
  showTab($(\`[data-panel="\${S.tab}"]\`) ? S.tab : "hub");
};
const drawHubPanel = () => { $("#panel-hub").innerHTML = drawHub(ctx()); };
const drawHeaderParts = () => { const h = drawHeader(ctx()); $("#kicker").innerHTML = h.kicker; $("#title").innerHTML = h.title; $("#dek").innerHTML = h.dek; $("#tiles").innerHTML = h.tiles; };
/* No snapshot to draw: the header card alone says why. Never sample data. */
const sayEmpty = (title, dek) => { snap = null; decisions = []; $("#hub").innerHTML = drawEmpty(title, dek); drawDock(); };

const nextOpen = () => {
  const d = decisions.find(isOpen);
  showTab("decide");
  if (!d) return;
  const el = document.getElementById(d.card);
  el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1400);
  el?.querySelector("input")?.focus({ preventScroll: true });
};

const response = () => buildResponse(decisions, S);
const bytes = (t) => new TextEncoder().encode(t).length;

/* ---------- capabilities ---------- */
let commentsP = null;
const comments = () => (commentsP ??= (window.claude?.use ? window.claude.use("comments") : Promise.resolve(null)).catch(() => null));

let sheetBg = null;
const closeSheet = () => { sheetBg?.remove(); sheetBg = null; $("#dock-respond").focus(); };
const openRespond = async () => {
  closeSheet();
  const pending = decisions.filter(inResponse);
  const left = pending.filter(isOpen);
  sheetBg = document.createElement("div");
  sheetBg.className = "sheet-bg";
  sheetBg.innerHTML = \`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="r-title">
    <header><h2 id="r-title">Your response</h2><button type="button" class="btn" data-close>Close</button></header>
    <div class="body">
      \${pending.length ? \`<section><p class="cap">Decisions · \${left.length ? \`<span class="pill amber">\${left.length} to answer</span>\` : '<span class="pill green">all answered</span>'}</p>
        \${pending.map((d, k) => { const st = stateOf(S, d); const a = answerOf(S, d); return \`<button type="button" class="rrow \${st}" data-jump="\${esc(d.card)}"><span class="k">\${k + 1}</span><span class="q">\${esc(d.q)}<small>\${a?.value ? esc(optLabel(d, a.value)) + (a.words?.trim() ? " + your words" : "") : \`no answer\${d.rec ? \` (recommended: \${esc(optLabel(d, d.rec))})\` : ""}\`}</small></span><span class="s">\${{ todo: "to answer", picked: "answered", suggested: "as suggested" }[st]}</span></button>\`; }).join("")}</section>\` : ""}
      <section><label class="cap" for="r-note">Add a comment</label><textarea id="r-note" class="note" rows="3" placeholder="Anything else for the chief of staff">\${esc(S.note)}</textarea></section>
      <section><p class="cap">What will be sent</p><pre id="r-md"></pre></section>
    </div>
    <footer><button type="button" class="btn danger" id="r-reset">Reset</button><span class="sp"></span><button type="button" class="btn" id="r-copy">Copy response</button><button type="button" class="btn go" id="r-send" disabled>Send to Claude</button><p class="send-state" id="r-state" role="status">Checking whether Claude can receive it…</p></footer>
  </div>\`;
  document.body.append(sheetBg);
  const md = $("#r-md", sheetBg); const state = $("#r-state", sheetBg); const send = $("#r-send", sheetBg);
  const say = (t, cls = "") => { state.textContent = t; state.className = \`send-state \${cls}\`; };
  const update = () => {
    const text = response(); md.textContent = text;
    if (bytes(text) > 4096) { send.disabled = true; say(\`The response is \${bytes(text)} bytes; a comment holds 4096. Shorten your words, or Copy it instead.\`, "err"); return false; }
    return true;
  };
  update();
  $("#r-note", sheetBg).addEventListener("input", (e) => { S.note = e.target.value; save(); update(); drawDock(); });
  sheetBg.addEventListener("click", (e) => { if (e.target === sheetBg || e.target.closest("[data-close]")) closeSheet(); const j = e.target.closest("[data-jump]"); if (j) { closeSheet(); showTab("decide"); const el = document.getElementById(j.dataset.jump); el?.scrollIntoView({ block: "center" }); el?.querySelector("input")?.focus({ preventScroll: true }); } });
  sheetBg.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  const reset = $("#r-reset", sheetBg);
  reset.addEventListener("click", () => {
    if (reset.dataset.armed !== "1") { reset.dataset.armed = "1"; reset.textContent = "Clear every answer?"; setTimeout(() => { reset.dataset.armed = ""; reset.textContent = "Reset"; }, 3000); return; }
    S.answers = {}; S.note = ""; save(); closeSheet(); draw(); toast("Answers cleared");
  });
  $("#r-copy", sheetBg).addEventListener("click", async () => {
    const text = response();
    try { await navigator.clipboard.writeText(text); toast("Response copied"); }
    catch { const r = document.createRange(); r.selectNodeContents(md); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); say("Copy was refused here. The response is selected; press Cmd+C.", "err"); }
  });
  send.focus();
  /* Send to Claude: one comment, anchored to the #cos card, through comments.sendToClaude */
  const c = await comments();
  if (!sheetBg) return;
  if (!c) { say("Sending from this page is off in this view. Copy the response and paste it to the chief of staff.", "err"); return; }
  let can = "off";
  try { can = await c.canSendToClaude(); } catch { can = "off"; }
  const why = { writers_only: "Only an editor of this artifact can send to Claude. Copy the response instead.", no_session: "No Claude session is watching this artifact right now. Copy the response, or send again once the chief of staff is on.", off: "Sending to Claude is off in this view. Copy the response instead." };
  if (can !== "available") { say(why[can] ?? why.off, "err"); return; }
  if (update()) { send.disabled = false; say(left.length ? \`\${left.length} decision\${left.length === 1 ? " is" : "s are"} still open; they go as "not answered".\` : "Ready. The first send asks you to let this page send messages to your Claude session."); }
  send.addEventListener("click", async () => {
    if (!update()) return;
    send.disabled = true; say("Sending…");
    const sentKeys = decisions.filter((d) => inResponse(d) && !isOpen(d)).map((d) => d.key);
    try {
      const anchor = await c.anchorFor(document.getElementById("cos"));
      await c.sendToClaude({ anchor, text: response() });
      for (const k of sentKeys) { S.sent[k] = new Date().toISOString(); delete S.answers[k]; }
      S.note = ""; save();
      state.innerHTML = drawSent(); state.className = "send-state ok";
      toast("Sent to Claude"); draw();
    } catch (e) {
      const code = e?.code;
      const msg = {
        consent_required: "Not sent: this page is not allowed to send for you yet. Press Send again and allow it in the prompt.",
        forbidden: "Not sent: sending from this page is off for you here. Copy the response instead.",
        claude_unavailable: "Not sent: no Claude session could take it. Nothing was posted. Copy the response, or try once the chief of staff is on.",
        rate_limited: "Not sent: too many sends just now. Wait a minute, then press Send.",
        invalid: "Not sent: the response was refused as malformed. Copy it instead.",
      }[code] ?? \`Not sent (\${code ?? "error"}). It may have posted anyway; check the comments before sending again.\`;
      say(msg, "err");
      send.disabled = code === "forbidden" || code === "invalid";
    }
  });
};

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target;
  const tab = t.closest(".tabbar [role=tab]"); if (tab) { showTab(tab.dataset.tab); return; }
  if (t.closest("#go-tile")) { decisions.some(isOpen) ? nextOpen() : openRespond(); return; }
  if (t.closest("#dock-todo")) { showTab("decide"); scrollTo({ top: 0 }); return; }
  if (t.closest("#dock-next")) { nextOpen(); return; }
  if (t.closest("#dock-respond")) { openRespond(); return; }
  if (t.closest("#take-recs")) { for (const d of decisions) if (isOpen(d) && d.rec) S.answers[d.key] = { value: d.rec, how: "suggested", words: "" }; save(); draw(); toast("Recommendations taken"); return; }
  const goto = t.closest("[data-goto-run]"); if (goto) { const d = decisions.find((x) => x.run?.id === goto.dataset.gotoRun && isOpen(x)); showTab("decide"); document.getElementById(d?.card)?.scrollIntoView({ block: "center" }); return; }
  const tog = t.closest("[data-toggle]"); if (tog) { S.open[tog.dataset.toggle] = !S.open[tog.dataset.toggle]; drawHubPanel(); document.querySelector(\`[data-toggle="\${CSS.escape(tog.dataset.toggle)}"]\`)?.focus(); return; }
  const gt = t.closest("[data-gtab]"); if (gt) { S.gtab[gt.dataset.for] = gt.dataset.gtab; drawHubPanel(); document.querySelector(\`[data-gtab="\${gt.dataset.gtab}"][data-for="\${CSS.escape(gt.dataset.for)}"]\`)?.focus(); return; }
  if (t.closest("[data-see-reply]")) {
    /* No open-thread verb in comments: the composer on #cos opens the panel at the thread Claude replies on. */
    const c = await comments();
    if (!c) { toast("Commenting is off in this view"); return; }
    if (sheetBg) closeSheet();
    c.openComposer({ element: document.getElementById("cos") }).catch(() => toast("Could not open the comment box here"));
    return;
  }
  const cm = t.closest("[data-comment-for]");
  if (cm) {
    const c = await comments();
    const el = document.getElementById(cm.dataset.commentFor);
    if (!c) { toast("Commenting is off in this view"); return; }
    if (el) c.openComposer({ element: el }).catch(() => toast("Could not open the comment box here"));
  }
});
document.addEventListener("change", (e) => {
  const input = e.target.closest(".ask input[type=radio]"); if (!input) return;
  const key = input.closest(".ask").dataset.key;
  S.answers[key] = { ...(S.answers[key] ?? {}), value: input.value, how: "picked" };
  delete S.sent[key]; save();
  const y = scrollY; draw(); scrollTo({ top: y });
});
document.addEventListener("input", (e) => {
  const ta = e.target.closest("textarea[data-words]"); if (!ta) return;
  const key = ta.closest(".ask").dataset.key;
  S.answers[key] = { ...(S.answers[key] ?? {}), words: ta.value }; save();
});

/* ---------- data: the newest db snapshot, else a line saying why there is none ---------- */
const useLive = (doc) => { snap = doc; now = Date.now(); draw(); };
setInterval(() => { if (snap && !sheetBg) { now = Date.now(); drawHeaderParts(); } }, 60000);
if (!window.claude?.use) { sayEmpty("Open this page on claude.ai", "It reads its snapshots from the artifact's database."); }
else {
  (async () => {
    const [db, c] = await Promise.all([window.claude.use("db"), comments()]);
    if (!c) document.documentElement.classList.add("no-comments");
    if (!db) { sayEmpty("No snapshot database", "The snapshot database is not available in this view."); return; }
    db.collection("snapshots").orderBy("at", "desc").limit(1).onSnapshot(
      (q) => { const d = q.docs[0]; if (d) useLive(d.data()); else sayEmpty("No snapshot yet", "The chief of staff writes one at every check-in (afk hub snapshot)."); },
      (error) => sayEmpty("Could not read snapshots", String((error && (error.message || error.code)) || "unknown error")),
    );
  })();
}
`;

/** The page source to publish: head, style, an empty-state body, the dock and the script. */
export const artifactPage = () => `<title>AFK Hub</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>${STYLE}</style>
<style>/* From the design's build.sh wrapper: the tabs and graphs hide with \`hidden\`, which .sec and .graphs (display: grid) would otherwise override. */
[hidden] { display: none !important; }</style>

<main id="hub">
  ${drawEmpty("Loading the newest snapshot")}
</main>

<div class="dock" id="dock">
  <button type="button" class="todo" id="dock-todo">TODO (0)</button>
  <button type="button" class="next" id="dock-next">0 to answer ↓</button>
  <button type="button" class="respond" id="dock-respond">Respond <span class="n" id="respond-n"></span></button>
</div>

<script>
(() => {
"use strict";
${drawSource()}
${RUNTIME}
})();
</script>
`;
