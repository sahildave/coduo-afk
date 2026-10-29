// Defects caught mid-run, and the lesson each one owes (#215).
//
// The closeout fixer is not the only place a real defect is found. A post-merge
// check that fails twice on the same merged tree found one; so did a human
// whose hand fix came back through `afk salvage`. Neither used to be asked for
// a lesson, so the same defect could ship again next epic. Each is recorded in
// `.afk/state.json` under `midRunDefects` (the runner owns state), carries a
// lesson of the exact `LESSON_FIELDS` shape the fixer's findings carry, and is
// listed in the closeout and the PR body with that lesson or `Lesson: missing`.
import { coerceLesson, parseLessonFlag, renderLesson } from "./fixer.mjs";
import { infisicalSessionMissing } from "./infisical.mjs";
import { checkFailed } from "./lib.mjs";
import { classifyGateFailure, earnsGateRerun } from "./supervisor.mjs";

const commandsOf = (verification) =>
  (verification?.checks ?? []).map((check) => check?.command).filter(Boolean);

/**
 * The failed post-merge check that is a real defect: it failed, was re-run on
 * the same merged tree, and failed again, and its first red was not read as
 * the environment. Fail direction: OPEN toward recording. A defect recorded in
 * error costs one `Lesson: none` line; a real one dropped costs the next epic.
 * Only a high-confidence environment reading (the same bar the gate rerun
 * uses) keeps one out.
 */
export const integrationDefectCheck = (verification) =>
  (verification?.checkReruns ?? []).find((rerun) => rerun && !rerun.passed && !earnsGateRerun(rerun)) ?? null;

/**
 * The command the lane's own gate never ran, or null. Unknown is not "lacks":
 * a lane with no recorded checks says nothing about which ones it skipped.
 */
export const laneLacksCheck = (command, laneVerification) => {
  const ran = commandsOf(laneVerification);
  return ran.length && !ran.includes(command) ? command : null;
};

/**
 * Record task `taskId`'s failed integration as a defect that needs a lesson.
 * One entry per task and command: a restart that re-reads the same failure
 * must not list it twice. Returns `{ defect, laneLacks }`, or null when the
 * failure was no defect (no re-run that stayed red, or the environment).
 */
export const recordIntegrationDefect = (state, { taskId, verification, laneVerification = null, at = new Date().toISOString() }) => {
  const rerun = integrationDefectCheck(verification);
  if (!rerun) return null;
  state.midRunDefects ??= [];
  const laneLacks = laneLacksCheck(rerun.command, laneVerification);
  let defect = state.midRunDefects.find((entry) => entry.taskId === taskId && entry.source === "integration" && entry.command === rerun.command);
  if (!defect) {
    defect = {
      taskId, source: "integration", command: rerun.command, at,
      headSha: verification?.resultingHead ?? null,
      laneRan: laneLacks ? false : commandsOf(laneVerification).length ? true : null,
      lesson: null,
    };
    state.midRunDefects.push(defect);
  }
  return { defect, laneLacks };
};

/**
 * The lane check a failed builder attempt went red on that is a real defect,
 * or null. A retry that later passes fixed it, so the retried builder owes a
 * lesson. Not a defect: an expired login (the agent's or Infisical's), a red
 * the gate reading pins on the environment at high confidence, or an attempt
 * that died before any check went red. Fail direction: OPEN toward recording,
 * as `integrationDefectCheck` — a stray entry costs one `Lesson: none` line.
 */
export const laneDefectCheck = (verification) => {
  if (verification?.authFailure) return null;
  const failed = (verification?.checks ?? []).find((check) => check && checkFailed(check));
  if (!failed || infisicalSessionMissing(failed.output)) return null;
  if (earnsGateRerun(classifyGateFailure({ output: String(failed.output ?? ""), timedOut: Boolean(failed.timedOut) }))) return null;
  return failed;
};

/**
 * Hold task `taskId`'s red lane check until a later attempt settles it. Only
 * the first one counts: it is the defect, later reds are attempts at its fix.
 */
export const noteLaneDefect = (taskRuntime, { verification, attempt }) => {
  const failed = laneDefectCheck(verification);
  if (failed && !(taskRuntime.laneDefect?.failedAttempt < attempt)) taskRuntime.laneDefect = { command: failed.command, failedAttempt: attempt };
  return failed;
};

/**
 * The retry passed: the held lane defect becomes a mid-run defect, with the
 * lesson the retried builder reported or none. One entry per task and command.
 */
export const recordLaneDefect = (state, { taskId, taskRuntime, verification, attempt, at = new Date().toISOString() }) => {
  const held = taskRuntime.laneDefect;
  if (!held) return null;
  delete taskRuntime.laneDefect;
  // An attempt count reset since the red (infra_failed, an expired login)
  // means this pass is a fresh run, not the retry that fixed it.
  if (!(attempt > held.failedAttempt)) return null;
  state.midRunDefects ??= [];
  const lesson = coerceLesson(verification?.lesson);
  let defect = state.midRunDefects.find((entry) => entry.taskId === taskId && entry.source === "lane" && entry.command === held.command);
  if (!defect) {
    defect = { taskId, source: "lane", command: held.command, failedAttempt: held.failedAttempt, fixedAttempt: attempt, at, lesson };
    state.midRunDefects.push(defect);
  } else if (lesson && !defect.lesson) defect.lesson = lesson;
  return defect;
};

/**
 * The lesson in a builder's closing report: its last `LESSON: <kind>:<fields>`
 * line, in the `--lesson` spelling `afk salvage` takes. Null when absent or
 * malformed — never repaired, so a bad one renders `Lesson: missing`.
 */
export const lessonFromReport = (text) => {
  const lines = String(text ?? "").match(/^\s*LESSON:\s*(.+)$/gm);
  return lines ? parseLessonFlag(lines.at(-1).replace(/^\s*LESSON:\s*/, "").trim()) : null;
};

/**
 * A salvage of `taskId` at `commit` with `lesson`. The lane's next commit fixed
 * whatever its open integration defects were, so each takes this lesson; with
 * none open, the hand fix is itself the defect found mid-run. The lesson must
 * already be a valid one — salvage refuses before it gets here otherwise.
 */
export const recordSalvageLesson = (state, { taskId, commit, lesson, at = new Date().toISOString() }) => {
  const valid = coerceLesson(lesson);
  if (!valid) throw new Error("recordSalvageLesson needs a lesson of the LESSON_FIELDS shape");
  state.midRunDefects ??= [];
  const open = state.midRunDefects.filter((entry) => entry.taskId === taskId && !entry.lesson);
  for (const entry of open) Object.assign(entry, { lesson: valid, fixedBy: { via: "salvage", commit, at } });
  if (!open.length) state.midRunDefects.push({ taskId, source: "salvage", commit, at, lesson: valid });
  return open.length ? open : [state.midRunDefects.at(-1)];
};

const describe = (defect) => {
  if (defect.source === "integration")
    return `post-merge check \`${defect.command}\` failed twice on the same merged tree`
      + (defect.laneRan === false ? " (the lane's own checks did not run it)" : "")
      + (defect.fixedBy ? `; fixed by ${defect.fixedBy.via} at ${String(defect.fixedBy.commit ?? "?").slice(0, 8)}` : "");
  if (defect.source === "lane")
    return `lane check \`${defect.command}\` failed on attempt ${defect.failedAttempt ?? "?"}; fixed by the builder's retry (attempt ${defect.fixedAttempt ?? "?"})`;
  if (defect.source === "salvage") return `fixed by hand and brought back with \`afk salvage\` at ${String(defect.commit ?? "?").slice(0, 8)}`;
  return defect.source ?? "defect";
};

/**
 * Every defect found mid-run with its lesson, one bullet each, in the shape
 * the fixer's findings render. Empty when there were none, so a run without
 * one renders exactly as before.
 */
export const renderMidRunDefects = (state, { heading = "## Defects found mid-run" } = {}) => {
  const defects = Array.isArray(state?.midRunDefects) ? state.midRunDefects : [];
  if (!defects.length) return "";
  const missing = defects.filter((defect) => !coerceLesson(defect.lesson)).length;
  return [
    heading,
    "",
    `**${defects.length} defect(s) caught before the closeout${missing ? `; ${missing} without a lesson` : ""}.**`,
    "",
    ...defects.map((defect) => `- ${coerceLesson(defect.lesson) ? "✅" : "⚠️"} **${defect.taskId}** — ${describe(defect)}\n  ${renderLesson(coerceLesson(defect.lesson))}`),
  ].join("\n");
};
