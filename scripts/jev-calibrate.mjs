#!/usr/bin/env node
// scripts/jev-calibrate.mjs — calibrate the tier router (#294) against tickets
// whose outcome is already known.
//
//   node scripts/jev-calibrate.mjs --issues <file> [--out <file>]
//
// `<file>` is a JSON list of `{repo, number, outcome}`, outcome one of
// `first_try`, `retried`, `needed_human`. Each issue body is fetched with `gh`,
// asked the router's own questions (scripts/tier-router.mjs), and written as a
// markdown table: ticket, answers, tier, outcome. Then the same run again with
// every Score's levels presented in reverse, and the tickets whose tier
// changed: an answer that follows the position of a level rather than its
// meaning shows up there. Needs TYPESAFE_API_KEY and the network, so it runs
// at the acceptance gate, never in a lane.
import { readFileSync, writeFileSync } from "node:fs";
import { askTier, JEV_CONCURRENCY, JEV_MODEL, mapLimit } from "./tier-router.mjs";
import { isMainModule, run, shellQuote } from "./lib.mjs";

export const OUTCOMES = ["first_try", "retried", "needed_human"];

const round = (value) => (Math.round(value * 100) / 100).toFixed(2);

/** Every answer, not only the deciding ones: calibration reads them all. */
export const allAnswers = (answers) => {
  if (!answers) return "-";
  return Object.entries(answers)
    .filter(([id]) => id !== "scope" && id !== "scopeConfidence")
    .map(([id, value]) => `${id} ${round(value)}`)
    .concat(`scope ${Math.round(answers.scope * 100) / 100} (confidence ${round(answers.scopeConfidence)})`)
    .join(", ");
};

export const readIssueList = (text) => {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("--issues must be a JSON list of {repo, number, outcome}");
  for (const [index, entry] of list.entries()) {
    if (typeof entry?.repo !== "string" || !Number.isInteger(Number(entry?.number)))
      throw new Error(`entry ${index} needs a \`repo\` and an issue \`number\``);
    if (!OUTCOMES.includes(entry.outcome))
      throw new Error(`entry ${index} has outcome ${JSON.stringify(entry.outcome)} (allowed: ${OUTCOMES.join(", ")})`);
  }
  return list;
};

const fetchIssue = (exec, { repo, number }) => {
  const result = exec(`gh issue view ${shellQuote(String(number))} --repo ${shellQuote(repo)} --json title,body`);
  if (result.status !== 0) throw new Error(`gh could not read ${repo}#${number}: ${String(result.stderr ?? "").trim()}`);
  const issue = JSON.parse(result.stdout);
  return { id: `${repo}#${number}`, title: issue.title ?? "", body: issue.body ?? "" };
};

/** A skipped ask defaults to `critical` at runtime; in calibration it is no verdict. */
const tierCell = (decision) => (decision.routerSkipped ? "skipped" : decision.tier);

const table = (rows) => [
  "| Ticket | Answers | Tier | Outcome |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.ticket} | ${row.decision.jev ? allAnswers(row.decision.jev.answers) : row.decision.reason} | ${tierCell(row.decision)} | ${row.outcome} |`),
];

/**
 * The calibration report as markdown. Pure apart from its two seams: `exec`
 * for `gh`, `fetchImpl` for Jev.
 */
export const calibrate = async ({ issues, key, exec = run, fetchImpl = fetch }) => {
  const tickets = issues.map((entry) => ({ entry, task: fetchIssue(exec, entry) }));
  const ask = (reverseScores) => mapLimit(tickets, JEV_CONCURRENCY, ({ task }) =>
    askTier({ task, key, fetchImpl, reverseScores }));
  const normal = await ask(false);
  const reversed = await ask(true);
  const rows = (decisions) => tickets.map(({ entry, task }, index) => ({ ticket: task.id, outcome: entry.outcome, decision: decisions[index] }));
  const changed = tickets
    .map(({ task }, index) => ({ ticket: task.id, from: tierCell(normal[index]), to: tierCell(reversed[index]) }))
    .filter((row) => row.from !== row.to);
  const reported = normal.find((decision) => decision.jev?.model)?.jev.model ?? null;
  return [
    "# Jev tier-router calibration",
    "",
    `Jev model requested: \`${JEV_MODEL}\`; reported: ${reported ? `\`${reported}\` — pin \`JEV_MODEL\` in scripts/tier-router.mjs to it` : "none (no answer came back)"}.`,
    "",
    "## Score levels in order",
    "",
    ...table(rows(normal)),
    "",
    "## Score levels reversed",
    "",
    ...table(rows(reversed)),
    "",
    "## Tier changed when the levels were reversed",
    "",
    ...(changed.length
      ? ["| Ticket | In order | Reversed |", "| --- | --- | --- |", ...changed.map((row) => `| ${row.ticket} | ${row.from} | ${row.to} |`)]
      : ["None."]),
    "",
  ].join("\n");
};

const flag = (argv, name) => {
  const at = argv.indexOf(name);
  if (at !== -1) return argv[at + 1] ?? null;
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};

export const main = async (argv, { exec = run, fetchImpl = fetch, env = process.env, write = (text) => process.stdout.write(text), error = console.error } = {}) => {
  const issuesPath = flag(argv, "--issues");
  if (!issuesPath) {
    error("usage: node scripts/jev-calibrate.mjs --issues <file> [--out <file>]");
    return 2;
  }
  if (!env.TYPESAFE_API_KEY) {
    error("jev-calibrate: TYPESAFE_API_KEY is not set; calibration has no offline mode.");
    return 1;
  }
  try {
    const issues = readIssueList(readFileSync(issuesPath, "utf8"));
    const report = await calibrate({ issues, key: env.TYPESAFE_API_KEY, exec, fetchImpl });
    const out = flag(argv, "--out");
    if (out) writeFileSync(out, report);
    else write(report);
    return 0;
  } catch (caught) {
    error(`jev-calibrate: ${caught.message}`);
    return 1;
  }
};

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
