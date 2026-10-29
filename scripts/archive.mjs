// scripts/archive.mjs — put one epic's run state away, all of it, in one place.
//
// `.afk/` holds exactly one run. Starting a second epic in a checkout that still
// holds the first is the refusal every operator meets sooner or later, and until
// now the advice in that refusal was "reset its tasks, or remove
// .afk/state.json" — a hand-rolled `mv` that has been performed differently
// every time it was needed (docs/dx-proposals.md 2.2). Three things were wrong
// with it, and this file is the three fixes:
//
//   1. THE AUTO-ARCHIVE MOVED TWO OF SIX DIRECTORIES. `state.json` and
//      `supervisor/` went; `runs/`, `verifier/`, `recovery/`, `plan-review/`
//      and `fixer/` stayed, so the next epic inherited the previous one's lane
//      reports and review artifacts under its own paths.
//   2. TWO PATH CONVENTIONS FOR ONE CONCEPT. The auto-archive wrote
//      `.afk/epics/<id>/` and the documented hand-rolled move wrote
//      `.afk/archive/epic-<id>/`. `.afk/archive/epic-<id>/` wins here, because
//      it is the one an operator has been told to type.
//   3. AN EPIC PARKED ON A HUMAN GATE COUNTED AS "STILL OPEN". `gate: after` is
//      where a correct epic waits, sometimes for days, and that is finished work
//      by every measure except the lifecycle field. It is archivable.
//
// What is NOT archivable without `--force` is a half-failed epic: tasks that
// failed, or gates never released. That is an unfinished thread and moving it
// silently loses it.
//
// `.afk/epic-ledger.yaml` is deliberately untouched. It is TRACKED, on purpose
// (scripts/ledger.mjs says why), so moving it stages a deletion that the next
// status flush sweeps onto the epic branch — which is exactly how one run
// discovered it, as an unexplained `D` in `git status`.
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { die, ensureDir, isMainModule, normalizeId } from "./lib.mjs";
import { appendCloseRow } from "./measure.mjs";

/** Everything one run writes under `.afk/`, and nothing that outlives a run. */
export const ARCHIVED = [
  "state.json",
  "runs",
  "verifier",
  "fixer",
  "reflect",
  "recovery",
  "supervisor",
  "plan-review",
  "epic-close",
  // One file per auto-restart's output (#146). A `*` entry matches file names.
  "restart-*.log",
];

export const archiveDir = (root, epicId) =>
  resolve(root, ".afk", "archive", `epic-${epicId}`);

/**
 * Why this epic may not be archived, or null.
 *
 * Pure, so the policy is testable without a filesystem. `closed` and
 * `awaiting_acceptance` are both finished: the second is a correct epic waiting
 * on a person, and refusing to archive it is what sent operators to `rm`.
 */
export const archiveBlocker = (state) => {
  const lifecycle = state?.epicClose?.lifecycle ?? "open";
  if (lifecycle === "closed" || lifecycle === "awaiting_acceptance") return null;
  const unfinished = Object.entries(state?.tasks ?? {})
    .filter(([, task]) => task?.lifecycle !== "passed")
    .map(([id, task]) => `${id} (${task?.lifecycle ?? "unknown"})`);
  return unfinished.length
    ? `the epic has not finished: ${unfinished.join(", ")}`
    : "the epic record is still open";
};

/**
 * Move this run's state to `.afk/archive/epic-<id>/`. Moves, never deletes, so a
 * mistake costs a `mv` back rather than the run's only record.
 *
 * Returns what moved and what was not there. Never throws on an absent
 * directory — most runs never create `recovery/`, and half of them never reach
 * the fixer.
 */
export const archiveEpic = ({ root, epicId, move = renameSync }) => {
  const afk = resolve(root, ".afk");
  const target = archiveDir(root, epicId);
  ensureDir(target);
  const moved = [];
  const absent = [];
  for (const entry of ARCHIVED) {
    const [prefix, suffix] = entry.split("*");
    const names = suffix === undefined
      ? (existsSync(resolve(afk, entry)) ? [entry] : [])
      : readdirSync(afk).filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).sort();
    if (!names.length) absent.push(entry);
    for (const name of names) {
      move(resolve(afk, name), resolve(target, name));
      moved.push(name);
    }
  }
  return { target, moved, absent };
};

export const readEpicState = (root) => {
  const path = resolve(root, ".afk", "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const cli = async () => {
  const root = process.cwd();
  const state = readEpicState(root);
  if (!state) {
    console.log("ARCHIVE: no .afk/state.json in this checkout — nothing to archive.");
    return 0;
  }
  const epicId = normalizeId(state.epic?.id ?? state.epic ?? null);
  if (!epicId) die("ARCHIVE: .afk/state.json names no epic; refusing to guess where to put it.");

  const blocker = archiveBlocker(state);
  if (blocker && !process.argv.includes("--force")) {
    console.error(`ARCHIVE: refusing to archive epic #${epicId} — ${blocker}.`);
    console.error("  Finish it, or archive it anyway with `afk archive --force`. Nothing is deleted either way.");
    return 1;
  }
  await appendCloseRow({ root, epicId, once: true });
  const { target, moved, absent } = archiveEpic({ root, epicId });
  console.log(`ARCHIVE: epic #${epicId} moved to ${target}`);
  console.log(`  moved: ${moved.join(", ") || "(nothing)"}`);
  if (absent.length) console.log(`  absent: ${absent.join(", ")}`);
  console.log("  `.afk/epic-ledger.yaml` is tracked and was left alone.");
  return 0;
};

if (isMainModule(import.meta.url)) process.exitCode = await cli();
