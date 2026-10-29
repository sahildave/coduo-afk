// scripts/reach.mjs — the Reach axis, as four lists a script produces.
//
// The verifier's other two axes are both diff-vs-document: Standards reads the
// diff against the project's coding standards, Spec reads the diff against the
// ticket. Three real failure classes walked past both, because each needs a
// comparison neither axis makes:
//
//   diff-vs-codebase   atlas-workspace #563. The criteria named three files,
//                      the diff covered three files, Spec passed. The version
//                      guard actually needed five. Nothing compared the
//                      mechanism the diff introduced against every other site
//                      that mechanism has to cover.
//   call-graph         #365. The spec said add a toggle; a toggle existed, was
//                      persisted and was unit-tested, and its resolver had zero
//                      non-test callers. A control wired to nothing satisfies a
//                      diff-vs-document review exactly.
//   lane-vs-lane       #642. Every lane matched its own spec. Three lanes wrote
//                      outside their declared paths and two shared files, and
//                      no axis reads two lanes at once.
//
// Each is a list, and each list is cheap. So the model is not asked to discover
// them: this module computes them and the reviewer reads them. Every function
// here is pure — text or objects in, arrays out, no IO and no network, in the
// same style as scripts/epic.mjs. The caller supplies the `git log` output, the
// verification records and the knip payloads.
import { globToRegExp } from "./lib.mjs";

// The two commit subjects the runner writes, and the only two files are
// attributed through. `scripts/worker.mjs` commits a lane as
// `task <id>: <title>`; `scripts/integrate.mjs` merges it as
// `Merge task <id>: <title>` (the title is omitted when the task has none).
const TASK_SUBJECT = /^(?:Merge )?task (\d+)(?::|$)/;

/**
 * Is this line the next commit's subject rather than another file path?
 *
 * `git log --format=%s --name-only` writes `subject`, a blank line, then the
 * file list — and then the NEXT subject with no separator at all. A commit with
 * no file list (a merge) is a bare subject line. So the end of a file block is
 * genuinely ambiguous in that output, and this is where the ambiguity is
 * resolved, with two rules and a named fail direction:
 *
 *   1. a line whose successor is blank is a subject, because only a subject is
 *      ever followed by the blank that introduces a file list;
 *   2. a line that reads as a merge subject is a subject. Merges are the only
 *      commits `--name-only` prints no files for, so they are the only case
 *      rule 1 cannot see.
 *
 * Fail direction: a subject this misses is absorbed as a file path, which can
 * only invent a seam if two DIFFERENT tasks absorb the byte-identical subject.
 * The opposite error — reading a real path as a subject — would drop files out
 * of attribution and hide a seam, which is the failure this axis exists to
 * catch. So the rules stay narrow.
 */
const endsFileBlock = (line, next) =>
  next === "" || /^Merge /.test(line) || TASK_SUBJECT.test(line);

/**
 * Every file each task wrote on this branch, as `taskId → files`.
 *
 * The one place the log is attributed. `seamFiles` reads it, and so does the
 * caller that needs a lane's REAL surface to compare against its declared one
 * — two attribution mechanisms over one log is two answers to "which lane
 * wrote this".
 *
 * @param {string} logText output of
 *   `git log --format=%s --name-only <base>..<head>`
 * @returns {Map<string, string[]>} task id → files, both in first-seen order
 *   (a Map, not an object: numeric-looking object keys reorder themselves, and
 *   the order the log attributed the lanes in is the order the seam list shows)
 */
export const filesByTask = (logText) => {
  // The trailing newline goes first, and it is not cosmetic: it would make the
  // last file of the last commit a line "followed by a blank", which is rule 1
  // in `endsFileBlock` — so the final file of every real transcript was read as
  // the next commit's subject and dropped. Caught by the #625 fixture, whose
  // last line is `scripts/release/updater-asset-name.test.mjs`.
  const lines = String(logText ?? "").replace(/\n+$/, "").split("\n");
  const byTask = new Map();
  let i = 0;
  while (i < lines.length) {
    const subject = lines[i];
    i += 1;
    if (subject === "") continue;
    // No blank after the subject means this commit listed no files at all.
    if (lines[i] !== "") continue;
    i += 1;
    const match = TASK_SUBJECT.exec(subject);
    const taskId = match ? match[1] : null;
    while (i < lines.length && lines[i] !== "" && !endsFileBlock(lines[i], lines[i + 1])) {
      if (taskId) {
        if (!byTask.has(taskId)) byTask.set(taskId, []);
        const files = byTask.get(taskId);
        if (!files.includes(lines[i])) files.push(lines[i]);
      }
      i += 1;
    }
  }
  return byTask;
};

/**
 * Files written by two or more distinct tasks on one branch — the lane-vs-lane
 * list (#642).
 *
 * @param {string} logText the same `git log` output `filesByTask` reads
 * @returns {{file: string, tasks: string[]}[]} one entry per shared file, task
 *   ids in the order the log first attributed them
 */
export const seamFiles = (logText) => {
  const byFile = new Map();
  for (const [taskId, files] of filesByTask(logText)) {
    for (const file of files) {
      const tasks = byFile.get(file) ?? [];
      tasks.push(taskId);
      byFile.set(file, tasks);
    }
  }
  return [...byFile.entries()]
    .filter(([, tasks]) => tasks.length > 1)
    .map(([file, tasks]) => ({ file, tasks }));
};

/**
 * The lanes that kept an edit outside their declared paths.
 *
 * `keptOutsideDeclaredPaths` is written by `scripts/worker.mjs` and read by
 * `scripts/supervisor.mjs`, and lives as a git note on the task commit
 * (`refs/notes/afk-verification/<id>`). Nothing has ever shown it to a
 * reviewer — an empty array means "nothing was reverted", never "the lane
 * stayed in scope", and #642 shipped three out-of-scope lanes with every gate
 * green.
 *
 * @param {Record<string, object>} verifications taskId → verification record
 * @returns {{taskId: string, paths: string[]}[]}
 */
export const undeclaredWrites = (verifications) =>
  Object.entries(verifications ?? {})
    .map(([taskId, verification]) => ({
      taskId: String(taskId),
      paths: (verification?.keptOutsideDeclaredPaths ?? []).filter(Boolean),
    }))
    .filter((entry) => entry.paths.length > 0);

/**
 * Declared globs no changed file matches — scope a lane claimed and never used.
 *
 * Advisory on its own: a ticket that claims a file it turns out not to need has
 * done nothing wrong. It earns its place beside the seam list because the two
 * together say where a lane's real surface differs from its declared one, which
 * is the question #642's closeout could not answer from any artifact.
 *
 * Uses the runner's own `globToRegExp` (scripts/lib.mjs), the same matcher the
 * worker's scope check runs, so "in scope" means one thing in this repo.
 *
 * @param {string[]} allowedPaths the task's declared globs
 * @param {string[]} changedFiles every file the task actually changed
 * @returns {string[]} the globs nothing matched
 */
export const untouchedAllowed = (allowedPaths, changedFiles) =>
  (allowedPaths ?? []).filter((pattern) => {
    const re = globToRegExp(pattern);
    return !(changedFiles ?? []).some((file) => re.test(file));
  });

/** `file:symbol` for every unused export and unused exported type in a payload. */
const knipKeys = (report) => {
  const keys = new Map();
  for (const issue of report?.issues ?? []) {
    const file = issue?.file;
    if (!file) continue;
    for (const entry of [...(issue.exports ?? []), ...(issue.types ?? [])]) {
      if (!entry?.name) continue;
      keys.set(`${file}:${entry.name}`, { file, symbol: entry.name });
    }
  }
  return keys;
};

/**
 * Unused exports present at head and absent at base — the call-graph list
 * (#365), as a ratchet.
 *
 * A ratchet because the baseline is red: atlas-workspace reports 58 unused
 * exports on `main` before any epic runs, so an absolute count says nothing and
 * a gate on it would never be green. What an epic is answerable for is what it
 * ADDED — an export this branch introduced that nothing calls is the shape of a
 * control wired to nothing, which is exactly #365.
 *
 * Both payloads are `knip --reporter json`:
 * `{ issues: [{ file, exports: [{name, line, col}], types: [...] }] }`.
 *
 * @returns {{file: string, symbol: string}[]} sorted, new-in-head only
 */
export const newUnusedExports = (baseReport, headReport) => {
  const base = knipKeys(baseReport);
  return [...knipKeys(headReport).entries()]
    .filter(([key]) => !base.has(key))
    .map(([, entry]) => entry)
    .sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
};

/**
 * A `knip --reporter json` payload out of a command's raw stdout, or `null`.
 *
 * Two facts about that stdout, both measured rather than assumed:
 *
 *   - it is not JSON from byte zero. knip loads the project's configs
 *     in-process and anything they log lands ahead of the report —
 *     atlas-workspace prints six `[stripe-catalog]` lines, which is the only
 *     thing `scripts/fixtures/README.md` records removing from the two
 *     committed payloads. So the report starts at the first `{`.
 *   - the command's EXIT CODE says nothing. knip exits non-zero whenever it
 *     finds an unused export, which on a red baseline is always. The caller
 *     reads this function's answer, never the status.
 *
 * `null`, not `{}`, when there is no report: an empty payload would read as
 * "knip found nothing", which turns every pre-existing unused export on the
 * branch into a new finding. Absence has to stay distinguishable from zero.
 *
 * Copied from atlas-workspace' `scripts/knip-ratchet.mjs` `parseKnipReport`,
 * which is the working reference; the delta is that this answers `null` where
 * that throws, because `collectReach` must never take a closeout down with it.
 */
export const parseKnipReport = (text) => {
  const start = String(text ?? "").indexOf("{");
  if (start === -1) return null;
  try {
    const value = JSON.parse(String(text).slice(start));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};
