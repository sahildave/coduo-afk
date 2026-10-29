// scripts/hub/threads.mjs — `afk hub threads`: what the chief of staff does
// with each comment thread on the hub artifact (#274).
//
// Input is the JSON the chief of staff writes from what `ArtifactComments
// read` showed: `{threads: [{id, status, activated, anchor, comments: [{by,
// at, sentToClaude, text}]}]}`. Output is one action per thread, as JSON
// lines. Rules, first match wins:
//   1. not activated                         skip (not sent to Claude)
//   2. resolved, or Claude spoke last        skip
//   3. last owner-side comment not the owner's  refuse
//   4. `thread <id>` already in relays.log   reply-only (the relay went)
//   5. by anchor: an Orchestrator's ask      answer-and-relay
//                 the chief of staff's ask   recorded (reply-only once it is)
//                 a run or gate card         relay to orch-<epic>
//                 #cos, #report, no anchor   cos
//                 a card not in --snapshot   ask-which-epic
//      A Respond from the hub artifact (a body starting `# Re: afk hub`,
//      sent as one thread on #cos) is a `cos` action whatever its anchor,
//      with its answers split out (`respondOf`, below); an answer to the
//      chief of staff's own ask is recorded (`routeThreads`, `record`).
//
// Fail direction: CLOSED. A thread whose author is not exactly the owner is
// refused, never relayed; a lost relay is a re-read away, a relayed stranger
// is not undoable. Each acted-on thread (anything but skip) is appended to
// `<cos root>/hub-threads.jsonl`, which is how the epic's Outcome is read.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cosRoot, newestRun, nowMs, openRun } from "../cos/store.mjs";
import { askCardId, cardIds } from "./artifact-draw.mjs";
import { markItem, readItems, storeItem } from "./inbox.mjs";
import { answers } from "./page.mjs";

export const OWNER = "the user (owner)";
const HERDR = fileURLToPath(new URL("../orchestrator-herdr.mjs", import.meta.url));

export const relaysLogPath = () => join(homedir(), ".afk-claude", "orchestrators", "relays.log");
export const threadsLogPath = (env = process.env) => join(cosRoot(env), "hub-threads.jsonl");

const byClaude = (comment) => /^claude\b/i.test(String(comment?.by ?? "").trim());

/** A word the shell reads as itself, or the word single-quoted. */
export const shellQuote = (value) => {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
};

// The read shows comment times in UTC with no zone ("2026-10-19T07:33").
const utcMs = (at) => {
  const text = String(at ?? "");
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
};

/** A comment time as the machine's local `HH:MM TZ`, the relay's `--at`. */
export const localAt = (at) => {
  const ms = utcMs(at);
  if (!Number.isFinite(ms)) return String(at);
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
};

// The relay's --session. formatRelay (orchestrator-herdr.mjs) stores it in
// relays.log quoted, `in "<session>" at`, ahead of the owner's verbatim words.
const relaySession = (threadId) => `afk hub artifact, thread ${threadId}`;

export const relayCommand = ({ to, text, at, threadId }) => [
  "node", shellQuote(HERDR), "relay", shellQuote(to),
  "--said", shellQuote(text),
  "--at", shellQuote(localAt(at)),
  "--session", shellQuote(relaySession(threadId)),
].join(" ");

const relayedThreads = (path) => {
  if (!existsSync(path)) return [];
  const texts = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // A line that does not parse (a truncated append) still counts by its raw
    // text, quotes unescaped, so rule 4's session match sees it. Fail
    // direction: CLOSED. A bad line reads as relayed, so the thread is
    // reply-only; a missed relay is a re-read away, a double relay is not.
    try { texts.push(String(JSON.parse(line).text ?? "")); } catch { texts.push(line.replace(/\\"/g, '"')); }
  }
  return texts;
};

// A Respond sent from the hub artifact (artifact-draw.mjs `buildResponse`).
const RESPOND = /^# Re: afk hub\s*\n/;
const DECISION = /^\d+\. \[ask:([^\]]+)\] /;
const ANSWER = /^ {3}→ \*\*(.*?)\*\* `([^`]*)`/;
const WORDS_FOR = /^ {3}→ the owner's words for (\S+), relay verbatim:$/;
const GATE_KEY = /^(.+)#([^:#]+):gate:(.+)$/;
const QUOTE = /^ *>(?: |$)/;

/**
 * One Respond body, split. `items`: each answered `[ask:cos:<id>]`, as the
 * queue item a local-hub Respond leaves for `afk hub queue cos` — a Respond
 * holding that one decision, its `>` lines verbatim — so the chief of staff
 * records and relays it the same way. Printed, never written to the inbox,
 * except an answer to the chief of staff's own ask, which `routeThreads`
 * records (status `recorded`): nothing else closes that ask.
 * `gates`: each gate line, reported to the chief of staff only. Fail
 * direction: CLOSED. Nothing here accepts a gate or carries a command that
 * would; an owner's "accept" is a report the chief of staff acts on under
 * its own delegation. Every item and gate carries `words`: the entry's `>`
 * lines, prefix stripped, joined with `\n`, else `""`; a `from` entry drops
 * its first `>` line, the option label. `unanswered`: the
 * keys sent with no answer.
 * `comments`: the `## Comments` lines, verbatim. A decision key of any other
 * shape is not split; the whole body is still on the cos action's thread.
 */
export const respondOf = (text, { threadId, at }) => {
  const ts = Number.isFinite(utcMs(at)) ? new Date(utcMs(at)).toISOString() : String(at ?? "");
  const blocks = [];
  const comments = [];
  let section = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("## ")) { section = line.slice(3).trim(); continue; }
    if (section === "Decisions") {
      if (DECISION.test(line)) blocks.push({ key: DECISION.exec(line)[1], lines: [line] });
      else if (line.trim() && blocks.length) blocks.at(-1).lines.push(line);
    } else if (section === "Comments" && /^ {2}> /.test(line)) comments.push(line.slice(4));
  }
  const items = [];
  const gates = [];
  const unanswered = [];
  for (const { key, lines } of blocks) {
    const answer = lines.map((line) => ANSWER.exec(line)).find(Boolean);
    if (!answer) { unanswered.push(key); continue; }
    // A `from` entry's first `>` line is the option label buildResponse adds, not the owner's words.
    const quoted = lines.filter((line) => QUOTE.test(line)).map((line) => line.replace(QUOTE, ""));
    const words = (lines.some((line) => WORDS_FOR.test(line)) ? quoted.slice(1) : quoted).join("\n");
    const gate = GATE_KEY.exec(key);
    if (gate) {
      const [, project, epic, task] = gate;
      gates.push({ key, project, epic, task, answer: answer[2], words, report: `The owner answered ${answer[2]} on gate ${task} of ${project} #${epic}. Reported only: nothing was accepted.` });
    } else if (key.startsWith("cos:")) {
      const from = lines.map((line) => WORDS_FOR.exec(line)?.[1]).find(Boolean) ?? null;
      const one = [lines[0].replace(/^\d+\./, "1."), ...lines.slice(1)];
      items.push({ id: `${threadId}:${key}`, ts, target: "cos", via: "respond", verdict: null, status: "queued", ask: key.slice(4), from, words, text: ["# Re: afk hub", "", "## Decisions", ...one, ""].join("\n") });
    }
  }
  return { items, gates, unanswered, comments };
};

const RUN = /^run-(.+)-([^-]+)$/;
const GATE = /^gate-(.+)-([^-]+)-([^-]+)$/;

/**
 * The action for one thread. `asks` are the store's ask events; `cards` is
 * the set of card ids the snapshot draws, or null with no snapshot; `relayed`
 * the relays.log text fields.
 */
export const routeThread = (thread, { asks = [], cards = null, relayed = [] } = {}) => {
  const base = { thread: thread.id };
  const comments = thread.comments ?? [];
  if (!thread.activated) return { ...base, action: "skip", why: "not sent to Claude" };
  if (thread.status === "resolved") return { ...base, action: "skip", why: "resolved" };
  if (byClaude(comments.at(-1))) return { ...base, action: "skip", why: "Claude replied last" };
  const said = comments.filter((c) => !byClaude(c)).at(-1);
  if (!said) return { ...base, action: "skip", why: "no comment to act on" };
  const commentAt = said.at ?? null;
  if (String(said.by ?? "").trim() !== OWNER) return { ...base, commentAt, action: "refuse", reply: "not relayed: not the owner's comment" };
  // The session with both its quotes, so thread 1 never matches thread 12.
  // Owner words that quote a whole session still match: a lost relay (CLOSED).
  if (relayed.some((text) => text.includes(`"${relaySession(thread.id)}"`))) return { ...base, commentAt, action: "reply-only" };
  if (RESPOND.test(said.text ?? "")) return { ...base, commentAt, action: "cos", respond: respondOf(said.text, { threadId: thread.id, at: said.at }) };
  const anchor = String(thread.anchor ?? "").trim().replace(/^#/, "");
  if (!anchor || anchor === "cos" || anchor === "report" || anchor === "usage" || anchor === "lanes") return { ...base, commentAt, action: "cos" };
  const gone = { ...base, commentAt, action: "ask-which-epic", anchor: `#${anchor}`, reply: `The card #${anchor} is no longer on the hub. Which epic is this about?` };
  if (cards && !cards.has(anchor)) return gone;
  const relay = (to, extra = {}) => ({
    ...base, commentAt, action: "relay", to, ...extra,
    command: relayCommand({ to, text: said.text ?? "", at: said.at, threadId: thread.id }),
  });
  if (anchor.startsWith("ask-")) {
    const ask = asks.find((event) => askCardId(event.id) === anchor);
    if (!ask) return gone;
    if (!ask.from) return { ...base, commentAt, action: "record-decision", ask: ask.id, text: said.text ?? "" };
    return {
      ...relay(ask.from, { ask: ask.id }),
      action: "answer-and-relay",
      answer: `afk cos answer --id=${shellQuote(ask.id)} ${shellQuote(said.text ?? "")}`,
    };
  }
  let m;
  if ((m = GATE.exec(anchor))) return relay(`orch-${m[2]}`, { epic: m[2], task: m[3] });
  if ((m = RUN.exec(anchor))) return relay(`orch-${m[2]}`, { epic: m[2] });
  return gone;
};

/**
 * Every thread's action, and the log lines appended for the acted-on ones.
 * `snapshot` is the parsed `afk hub snapshot` document, or null.
 */
export const routeThreads = ({ threads, snapshot = null, env = process.env }) => {
  const root = cosRoot(env);
  const run = openRun({ root }) ?? newestRun({ root });
  const asks = (run?.events ?? []).filter((event) => event.kind === "ask");
  const cards = snapshot ? new Set(cardIds(snapshot)) : null;
  const relayed = relayedThreads(relaysLogPath());
  const answered = (ask) => (run?.events ?? []).some((event) => event.kind === "answer" && event.id === ask.id) ||
    readItems(env).items.some((item) => answers(item, ask));
  // The owner's answer to the chief of staff's own ask, recorded as the local
  // hub records a Respond (send.mjs `send`: `storeItem` {target cos, via
  // respond}), so the ask closes as it does there (page.mjs `answers`). Marked
  // read by cos at once: this output is the chief of staff reading it, and a
  // queued copy would come back from `afk hub queue cos`. Fail direction:
  // CLOSED, at most once. An ask already answered is never recorded again; the
  // later words are still printed for the chief of staff, while a second
  // record would be a second answer to one question.
  const record = (ask, text) => {
    if (answered(ask)) return false;
    const item = storeItem({ target: "cos", via: "respond", verdict: null, text }, env);
    markItem(item.id, "read", { by: "cos" }, env);
    return true;
  };
  const ownAsk = (id) => asks.find((event) => event.id === id && !event.from);
  const actions = threads.map((thread) => {
    const action = routeThread(thread, { asks, cards, relayed });
    if (action.action === "record-decision") {
      const ask = ownAsk(action.ask);
      const quoted = action.text.trim().split("\n").map((line) => `     > ${line}`);
      const text = ["# Re: afk hub", "", "## Decisions", `1. [ask:cos:${ask.id}] ${ask.title ?? ""}`, ...quoted, ""].join("\n");
      const { text: words, ...rest } = action;
      return record(ask, text) ? { ...rest, action: "recorded", words } : { ...rest, action: "reply-only" };
    }
    for (const item of action.respond?.items ?? []) {
      const ask = ownAsk(item.ask);
      if (ask) item.status = record(ask, item.text) ? "recorded" : "already recorded";
    }
    return action;
  });
  const decidedAt = new Date(nowMs(env)).toISOString();
  const acted = actions.filter((a) => a.action !== "skip")
    .map((a) => ({ threadId: a.thread, commentAt: a.commentAt ?? null, decidedAt, action: a.action }));
  if (acted.length) {
    mkdirSync(root, { recursive: true });
    appendFileSync(threadsLogPath(env), acted.map((row) => `${JSON.stringify(row)}\n`).join(""));
  }
  return { actions, acted };
};
