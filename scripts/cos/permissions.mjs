// scripts/cos/permissions.mjs — does every `afk` verb a chief-of-staff run
// plans have a standing allow line? (#227)
//
// The classifier refused merges, salvage and kills the owner had already approved
// in chat; the refusals surfaced at 3am. This finds the missing lines before
// the run starts. It reads `~/.claude/settings.json` `autoMode.allow` and
// `~/.afk-claude/orchestrators/owner-settings.json` (its `autoMode.allow` and
// `permissions.allow`), and writes neither: both are the owner's.
//
// A line names a verb when it contains the verb not followed by another word:
// "Running `afk cos stop`" names `afk cos stop` but not `afk cos`, and
// `Bash(afk cos:*)` names `afk cos`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The verbs a supervised run uses that the classifier has refused or would:
// the CoS's own CLI, the kill in `cos stop`, and the merge in `afk land`
// (epic #226, Out of Scope: The owner adds these lines himself).
export const COS_VERBS = [
  { verb: "afk cos", line: "Running `afk cos` (any subcommand) is allowed: it is the owner's own supervision CLI and writes only ~/.afk-claude/cos." },
  { verb: "afk cos stop", line: "Running `afk cos stop` is allowed: it kills only processes `afk cos run` registered, after checking each pid's start time." },
  { verb: "afk land", line: "Running `afk land <pr>` is allowed: it merges only when CI is green, the PR is not a push to the base and the owner approved it on the PR." },
];

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const names = (entry, verb) =>
  new RegExp(`${verb.replace(/ /g, "\\s+")}(?!\\s*[A-Za-z0-9])`).test(String(entry));

/** The allow entries that count, from both files under `home`. */
export const standingAllowLines = (home = homedir()) => {
  const user = readJson(join(home, ".claude", "settings.json"));
  const owner = readJson(join(home, ".afk-claude", "orchestrators", "owner-settings.json"));
  return [
    ...(user?.autoMode?.allow ?? []),
    ...(owner?.autoMode?.allow ?? []),
    ...(owner?.permissions?.allow ?? []),
  ];
};

/** `{ ok, missing: [{verb, line}] }` for `verbs` against the standing lines. */
export const permissionsProbe = ({ verbs = COS_VERBS, home = homedir() } = {}) => {
  const lines = standingAllowLines(home);
  const missing = verbs.filter(({ verb }) => !lines.some((entry) => names(entry, verb)));
  return { ok: missing.length === 0, missing };
};

export const renderPermissions = ({ ok, missing }) => (ok
  ? ["PREFLIGHT: permissions ok — every planned afk verb has a standing allow line."]
  : [
    ...missing.map(({ verb }) => `PREFLIGHT: no standing allow line names \`${verb}\`; the classifier may refuse it mid-run.`),
    'PREFLIGHT: add these to ~/.claude/settings.json under "autoMode": { "allow": [...] } (or to ~/.afk-claude/orchestrators/owner-settings.json). Only the owner edits those files:',
    ...missing.map(({ line }, index) => `  ${JSON.stringify(line)}${index < missing.length - 1 ? "," : ""}`),
  ]).join("\n");
