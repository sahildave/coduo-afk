// scripts/fate.mjs — `afk fate`, the closeout fates ledger (#228).
//
// One fate per closeout finding: `accepted`, `fixed` or `dropped`, with a
// reason and who decided (`owner` or `cos`). Two readers: the merge guard
// (`must-fix-cleared`, `must-fix-count` in scripts/merge-guards.mjs), where a
// finding the OWNER accepted or dropped no longer blocks, and the closeout
// reviewer's prompt (scripts/verifier.mjs), which is told not to raise a
// fated finding again unless the lines it names changed. On #545 nine reviews
// raised 17 must-fix items, about six of them already decided.
//
// The ledger is `.afk/fates/<epic>.jsonl` in the epic's checkout, append-only,
// one JSON object per line; the latest line for a finding is its fate. A line
// that does not parse is reported by every reader, never skipped.
//
// An owner fate must cite the owner's own comment, which `afk fate` reads with
// `gh` and refuses when it carries an agent's mark (#235 S3), and the merge
// guard names every finding it waives, with who and where. A line appended by
// hand with a forged citation is not caught; the guard's output shows it.
//
// A finding's id is `CF-` and 8 hex of the hash of its normalised text, so the
// same must-fix line raised by a later review has the same id. A reworded
// line is a new finding: that is how a reviewer re-raises one whose lines
// changed.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDir, isMainModule, normalizeId, run, shellQuote } from "./lib.mjs";

export const FATES = ["accepted", "fixed", "dropped"];
export const DECIDERS = ["owner", "cos"];

const normalise = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
export const findingId = (text) => `CF-${createHash("sha1").update(normalise(text)).digest("hex").slice(0, 8)}`;

export const fatesPath = (root, epicId) => resolve(root, ".afk", "fates", `${normalizeId(epicId)}.jsonl`);

/**
 * The ledger as `{ fates: Map<id, entry>, problems: string[] }`, the latest
 * entry per finding. No ledger is an empty map, not a problem.
 */
export const readFates = (root, epicId) => {
  const path = fatesPath(root, epicId);
  const fates = new Map();
  const problems = [];
  if (!existsSync(path)) return { path, fates, problems };
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let entry = null;
    try { entry = JSON.parse(line); } catch { /* reported below */ }
    if (!entry || typeof entry.finding !== "string" || !FATES.includes(entry.fate) || !DECIDERS.includes(entry.by) || !entry.ts) {
      problems.push(`the fates ledger at ${path} has an unreadable line ${index + 1}`);
      return;
    }
    fates.set(entry.finding, entry);
  });
  return { path, fates, problems };
};

/**
 * A fate that lifts the finding from the merge guard: the owner's accept or
 * drop, citing the comment where the owner said so (#235 S3). `afk fate`
 * checks that comment with `gh` before it writes the line; a line written by
 * hand with no citation does not count.
 */
export const ownerCleared = (entry) => Boolean(entry && entry.by === "owner" && (entry.fate === "accepted" || entry.fate === "dropped")
  && typeof entry.evidence?.url === "string" && entry.evidence.url);

/** How the merge guard names a waiver: id, fate, who, and where they said it. */
export const describeWaiver = (entry) => `${entry.finding} ${entry.fate} by owner ${entry.evidence?.login ?? "?"} (${entry.evidence?.url ?? "no citation"})`;

const COMMENT_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)#(issuecomment|pullrequestreview|discussion_r)-(\d+)/;

/**
 * The owner's own words behind `--by=owner`: the first GitHub comment URL in
 * the reason, read with `gh api`. It must be written by the repository's owner
 * (by login or `author_association: OWNER`) and carry no agent's mark, the
 * same test `afk land` applies (scripts/land.mjs `AGENT_MARK`). Returns
 * `{ evidence }` or `{ refusal }`.
 */
export const ownerEvidence = async (reason, { gh = run, cwd = process.cwd() } = {}) => {
  const match = String(reason).match(COMMENT_URL);
  if (!match) return { refusal: "--by=owner needs a link to the owner's comment saying so, in --reason (https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>)." };
  const [url, owner, repo, number, kind, id] = match;
  const path = kind === "issuecomment" ? `repos/${owner}/${repo}/issues/comments/${id}`
    : kind === "pullrequestreview" ? `repos/${owner}/${repo}/pulls/${number}/reviews/${id}`
      : `repos/${owner}/${repo}/pulls/comments/${id}`;
  const result = gh(`gh api ${shellQuote(path)}`, { cwd });
  let comment = null;
  try { comment = JSON.parse(String(result.stdout ?? "")); } catch { /* below */ }
  if (result.status !== 0 || !comment) return { refusal: `gh could not read ${url}: ${String(result.stderr || result.stdout || "no output").trim().split("\n")[0]}` };
  const login = String(comment.user?.login ?? "");
  if (comment.author_association !== "OWNER" && login.toLowerCase() !== owner.toLowerCase()) {
    return { refusal: `${url} was written by ${login || "someone"}, not the owner of ${owner}/${repo}.` };
  }
  const { AGENT_MARK } = await import("./land.mjs");
  if (AGENT_MARK.test(String(comment.body ?? ""))) return { refusal: `${url} carries an agent's mark, so it is not the owner's own word.` };
  return { evidence: { url, login } };
};

export const describeFate = (entry) => (entry ? `${entry.fate} by ${entry.by}` : "no fate");

const readJsonOr = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};

/**
 * Every finding of the last closeout a fate can name: the review's must-fix
 * lines and finding titles, the fixer's items (whose `F<n>` ids are what its
 * PR comment shows), and whatever the ledger already holds.
 */
export const knownFindings = async (root, epicId) => {
  const { verifierReportPath } = await import("./verifier.mjs");
  const { fixerReportPath } = await import("./fixer.mjs");
  const review = readJsonOr(verifierReportPath(root, epicId), null);
  const fixer = readJsonOr(fixerReportPath(root, epicId), null);
  const byId = new Map();
  const add = (title, extra = {}) => {
    if (!title) return;
    const id = findingId(title);
    byId.set(id, { id, title: String(title), ...(byId.get(id) ?? {}), ...extra });
  };
  for (const line of review?.mustFix ?? []) add(line, { mustFix: true });
  for (const finding of review?.findings ?? []) add(finding?.title);
  const fixerIds = new Map();
  for (const item of fixer?.items ?? []) {
    add(item?.title);
    if (item?.id) fixerIds.set(String(item.id), findingId(item.title));
  }
  const ledger = readFates(root, epicId);
  for (const entry of ledger.fates.values()) if (!byId.has(entry.finding)) byId.set(entry.finding, { id: entry.finding, title: entry.title ?? "" });
  return { review, findings: [...byId.values()], fixerIds, ledger };
};

// `--name=value` and `--name value` alike, as the dispatcher forwards both.
const VALUE_FLAGS = new Set(["epic", "finding", "reason", "by"]);
const readArgs = (args) => {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) flags[name] = arg.slice(eq + 1);
    else if (VALUE_FLAGS.has(name) && index + 1 < args.length && !args[index + 1].startsWith("--")) flags[name] = args[++index];
    else flags[name] = true;
  }
  return { flags, positional };
};

const USAGE = 'Usage: afk fate <epic> [<finding> --accepted|--fixed|--dropped --reason="<why>" [--by=owner|cos]]';

export const cli = async (args = process.argv.slice(2), root = process.cwd(), now = () => new Date()) => {
  const { flags, positional } = readArgs(args);
  const say = (line) => console.log(line);
  const epicId = normalizeId(String(flags.epic ?? positional[0] ?? "").replace(/^#/, "")) || null;
  const finding = String(flags.finding ?? positional[flags.epic ? 0 : 1] ?? "").trim() || null;
  if (!epicId || !/^\d+$/.test(epicId)) { say(USAGE); return 1; }

  const state = readJsonOr(resolve(root, ".afk", "state.json"), null);
  if (!state) { say(`FATE: no run state at ${resolve(root, ".afk", "state.json")}. Run this in the epic's checkout.`); return 1; }
  const stateEpic = normalizeId(state.epic?.id ?? state.dag?.epic?.id ?? null);
  if (stateEpic !== epicId) { say(`FATE: this checkout's run state belongs to epic ${stateEpic ?? "(none)"}, not ${epicId}.`); return 1; }

  const { review, findings, fixerIds, ledger } = await knownFindings(root, epicId);
  for (const problem of ledger.problems) say(`FATE: ${problem}`);

  if (!finding) {
    const head = String(review?.head ?? state.epicClose?.verifier?.head ?? "unknown").slice(0, 12);
    say(`FATE: epic ${epicId}, review ${head}: ${findings.length} finding(s)`);
    for (const entry of findings) {
      const fate = ledger.fates.get(entry.id);
      say(`  ${entry.id}  ${describeFate(fate).padEnd(20)} ${entry.title}${fate?.reason ? ` — ${fate.reason}` : ""}`);
    }
    return ledger.problems.length ? 1 : 0;
  }

  const chosen = FATES.filter((name) => flags[name] === true);
  if (chosen.length !== 1) { say("FATE: give exactly one of --accepted, --fixed, --dropped."); return 1; }
  const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
  if (!reason) { say('FATE: a fate needs --reason="<why>".'); return 1; }
  const by = flags.by === undefined ? "cos" : String(flags.by);
  if (!DECIDERS.includes(by)) { say(`FATE: --by is owner or cos, not ${JSON.stringify(by)}.`); return 1; }
  const id = fixerIds.get(finding) ?? finding;
  const known = findings.find((entry) => entry.id === id);
  if (!known) {
    say(`FATE: no finding ${finding} in the closeout of epic ${epicId}. Known: ${findings.map((entry) => entry.id).join(", ") || "none"}.`);
    return 1;
  }
  let evidence = null;
  if (by === "owner") {
    const checked = await ownerEvidence(reason, { cwd: root });
    if (checked.refusal) { say(`FATE: ${checked.refusal}`); return 1; }
    evidence = checked.evidence;
  }
  const entry = {
    ts: now().toISOString(),
    epic: epicId,
    finding: id,
    title: known.title,
    fate: chosen[0],
    reason,
    by,
    // The review this fate answers: the reviewer diffs the finding's lines
    // against it before raising it again.
    reviewHead: review?.head ?? state.epicClose?.verifier?.head ?? null,
    ...(evidence ? { evidence } : {}),
  };
  ensureDir(resolve(ledger.path, ".."));
  appendFileSync(ledger.path, `${JSON.stringify(entry)}\n`);
  say(`FATE: epic ${epicId} ${id} ${describeFate(entry)}: ${known.title} — ${reason}`);
  if (!ownerCleared(entry) && known.mustFix) say("FATE: only the owner's accept or drop lifts a must-fix item from `afk merge`; this one still blocks if raised again.");
  return 0;
};

if (isMainModule(import.meta.url)) {
  cli()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.log(`FATE: ${error.message}`);
      process.exitCode = 1;
    });
}
