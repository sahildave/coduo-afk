// scripts/cos/report.mjs — the morning report and the Orchestrators' open
// questions (cos-night-2026-10-13).
//
// The report is `report.md` in a run's store directory, written only by
// `afk cos report`. Text before the first `## <repo>#<epic>` heading is the
// summary; each such heading opens that epic's section. `--append` adds a
// `## Addendum <ISO time>` heading and the new text, so a section the addendum
// repeats (`## atlas#1232` again) joins the same card, after the addendum line.
//
// An Orchestrator's question is an `ask` event with `from`; it is open until
// an `answer` event names its id.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { epicId } from "../hub/runs.mjs";
import { cosRoot, readEvents, runDirs } from "./store.mjs";

export const REPORT_FILE = "report.md";

// `## atlas#1232`, `## atlas#1232: parked at #1238`, `## atlas#1232 — done`,
// or with an owner: `## owner/atlas#1232` (the repo is the part after the
// slash). Anything but a word character may follow the number. A space before
// the `#` (`## riverbend #72`) is no section: it reads like prose ("Advisor
// trial #2"), so it is reported as a stray heading instead of guessed at.
const EPIC_HEADING = /^##\s+(?:[A-Za-z0-9][\w.-]*\/)?([A-Za-z0-9][\w.-]*)#(\d+)(?!\w)/;
// A `##` heading that names an issue number but opened no section.
const STRAY_HEADING = /^##\s.*#\d/;
const ADDENDUM_HEADING = /^##\s+Addendum\b/;
const FENCE = /^\s*(```|~~~)/;

const trimBlank = (lines) => {
  const out = [...lines];
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out.at(-1).trim() === "") out.pop();
  return out;
};

/**
 * `{ summary, sections: [{ key, repo, epic, text }] }`, sections in the order
 * their first heading appears. A `##` heading that names no epic ("Advisor
 * trial") goes back to the summary. An addendum runs to the next addendum;
 * its heading leads every section it repeats, and shows in the summary only
 * when the addendum has summary text. Headings inside a code fence are text.
 * `stray` lists the `##` lines outside a fence that name `#<digits>` but opened
 * no section, so `afk cos report` can warn about them.
 */
export const parseReport = (text) => {
  const summary = [];
  const sections = new Map();
  const stray = [];
  let target = summary;
  let fenced = false;
  // The addendum heading in force, and whether the summary has shown it yet:
  // an addendum that only repeats epic sections adds nothing to the summary.
  let addendum = null;
  let shown = true;
  for (const line of String(text).split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const epic = !fenced && line.match(EPIC_HEADING);
    if (epic) {
      const key = `${epic[1]}#${epic[2]}`;
      if (!sections.has(key)) sections.set(key, { key, repo: epic[1], epic: epic[2], parts: [] });
      target = addendum ? [addendum, ""] : [];
      sections.get(key).parts.push(target);
      target.push(line);
      continue;
    }
    if (!fenced && /^##\s/.test(line)) {
      target = summary;
      if (STRAY_HEADING.test(line) && !ADDENDUM_HEADING.test(line)) stray.push(line.trim());
      if (ADDENDUM_HEADING.test(line)) {
        addendum = line.trim();
        shown = false;
        continue;
      }
    }
    if (target === summary && !shown) {
      if (!line.trim()) continue;
      while (summary.length && !summary.at(-1).trim()) summary.pop();
      summary.push("", addendum, "");
      shown = true;
    }
    target.push(line);
  }
  return {
    summary: trimBlank(summary).join("\n"),
    sections: [...sections.values()].map(({ parts, ...rest }) => ({
      ...rest,
      text: parts.map((part) => trimBlank(part).join("\n")).join("\n\n"),
    })),
    stray,
  };
};

/** The `## <repo>#<epic>` keys of a report, in order. */
export const sectionKeys = (text) => parseReport(text).sections.map((section) => section.key);

/** The newest run that has a report: `{ id, dir, path, text, meta, events }`, or null. */
export const latestReport = (env = process.env) => {
  const root = cosRoot(env);
  for (const id of runDirs(root).reverse()) {
    const dir = join(root, id);
    const path = join(dir, REPORT_FILE);
    if (!existsSync(path)) continue;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")); } catch { /* a run with no readable run.json still has its report */ }
    return { id, dir, path, text: readFileSync(path, "utf8"), meta, events: readEvents(dir).events };
  }
  return null;
};

const originName = (root) => {
  const out = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5_000 });
  return out.status === 0 ? out.stdout.trim().replace(/\.git$/, "").split(/[/:]/).pop() : null;
};

/**
 * The checkout of `<repo>#<epic>` as this run recorded it: its adopted list
 * and its check-in rows, matched on the epic number. The section's repo is a
 * GitHub name and the row's project is the clone's directory, which differ
 * (atlas vs atlas-workspace), so a root counts only when its project, or
 * the checkout's origin remote, names the repo, even when it is the only one.
 * Null when no root matches, or several do; the caller says so rather than guess.
 */
export const epicRoot = ({ meta, events }, { repo, epic }) => {
  const rows = [
    ...(meta?.adopted ?? []),
    ...(events ?? []).filter((event) => event.kind === "checkin").flatMap((event) => event.runs ?? []),
  ].filter((row) => row?.root && epicId(row.epic) === String(epic));
  const roots = [...new Set(rows.map((row) => row.root))];
  const named = roots.filter((root) =>
    rows.some((row) => row.root === root && (row.project ?? basename(root)) === repo) || originName(root) === repo);
  return named.length === 1 ? named[0] : null;
};

/** The prompt a card's Copy prompt button copies, for a fresh chat in the epic's checkout. */
export const promptFor = (report, section) => {
  const root = epicRoot(report, section);
  return [
    root
      ? `Open this chat in ${root}.`
      : `No checkout is recorded for ${section.key} in run ${report.id}, so this prompt names none. Find the epic's checkout before acting.`,
    "",
    `Epic ${section.key}, from the chief of staff's morning report (run ${report.id}). Its section, verbatim:`,
    "",
    section.text,
    "",
    `Full report: ${report.path}`,
  ].join("\n");
};

/** Questions an Orchestrator asked the chief of staff that no `answer` has closed, oldest first. */
export const openOrchestratorAsks = (events) => {
  const answered = new Set(events.filter((event) => event.kind === "answer").map((event) => event.id));
  return events.filter((event) => event.kind === "ask" && event.from && !answered.has(event.id));
};

/** Whole minutes since `ts`. */
export const ageMin = (ts, now) => Math.max(0, Math.floor((now - Date.parse(ts)) / 60_000));
