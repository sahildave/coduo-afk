#!/usr/bin/env node
/**
 * `afk wave` — the wave-mode entry point (`docs/wave-mode.md`).
 *
 * Two verbs. `validate` refuses or prints the accepted graph and creates
 * NOTHING: no branch, no worktree, no `.afk/`. `run` is the driver of §4 — a
 * serial loop of waves over the frozen graph, each one an `afk auto` run in its
 * own worktree, fast-forwarded onto the base branch only when the wave finished
 * and the ancestor assertion holds.
 *
 * `validate` is what `coduo-tasks` must exit 0 on before it is finished, which
 * is what makes the authoring rules mechanical instead of aspirational.
 *
 * THIS FILE IS THE EFFECTS EDGE. Every decision the driver makes — the
 * frontier, the cap, whether a plan-review verdict blocks the run, the
 * fast-forward permission, the halt rule, the digest — is a pure function in
 * `scripts/wave-driver.mjs`, tested with no repo, no git and no agent run. What
 * is here is git commands, file writes, and two subprocesses. When something
 * below looks like a judgment, it is in the wrong file.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWrite,
  checkFailed,
  checkFailureReason,
  configPath,
  ensureDir,
  isMainModule,
  isStatusFlushPath,
  PROGRESS_DIR,
  PROGRESS_FILE,
  loadConfig,
  parseArgv,
  parseStatusPaths,
  run,
  shellQuote,
} from "./lib.mjs";
import { ARCHIVED } from "./archive.mjs";
import { builderRunDir } from "./worker.mjs";
import { verifierDecision, verifierReportPath } from "./verifier.mjs";
import { readCloseoutGate } from "./fixer.mjs";
import { appendCloseRow } from "./measure.mjs";
import { createEpicWorktree, hookFailureLines, teardownWorktree } from "./worktree.mjs";
import { removeWaveRefs, teardownRecordedLanes } from "./teardown.mjs";
import { readWaveDirectory, renderRefusals, renderWaveDag } from "./wave-loader.mjs";
import {
  ATTEMPT_BUDGET,
  WAVE_CAP,
  emptyWaveLog,
  fastForwardDecision,
  dirtyBlockers,
  planReviewDecision,
  doneFileMoves,
  followUpFiles,
  haltDecision,
  isTerminal,
  mergeWaveTasks,
  recordWave,
  renderDigest,
  resumePlan,
  taskLedger,
  verifierStatus,
  waveBranchDecision,
  waveFrontier,
  waveHasMergedWork,
  waveId,
} from "./wave-driver.mjs";

const usage = `Usage:
  node scripts/wave.mjs validate <dir> [--json]
  node scripts/wave.mjs run <dir> --base=<branch> [--cap=<n>]
  node scripts/wave.mjs accept <dir> <task-id>
  node scripts/wave.mjs stop`;

export const acceptWaveTask = ({ root, dir, taskId, say = console.log }) => {
  const waveDir = resolve(root, dir);
  const config = existsSync(configPath(root)) ? loadConfig(root) : {};
  let loaded;
  try { loaded = readWaveDirectory(waveDir, { defaultChecks: config.defaultChecks ?? [] }); }
  catch (error) { say(`WAVE: ${error.message}`); return 1; }
  const ids = new Set(loaded.ok ? loaded.dag.tasks.map((task) => task.id) : []);
  if (!ids.has(taskId)) {
    say(`WAVE: cannot accept unknown task id \`${taskId}\`.`);
    return 1;
  }
  let log;
  try { log = readWaveLog(waveDir, null); }
  catch (error) { say(`WAVE: ${error.message}`); return 1; }
  const wave = [...(log.waves ?? [])].reverse().find((entry) => entry.tasks?.[taskId]);
  if (!wave) {
    say(`WAVE: task \`${taskId}\` has no ledger record to accept.`);
    return 1;
  }
  wave.tasks[taskId] = { ...wave.tasks[taskId], outcome: "no-op", acceptedAt: new Date().toISOString() };
  atomicWrite(waveLogPath(waveDir), `${JSON.stringify(log, null, 2)}\n`);
  say(`WAVE: accepted ${taskId} as terminal no-op; it will not be scheduled on resume.`);
  return 0;
};

export const stopWaveRun = ({ root, say = console.log, teardown = teardownRecordedLanes }) => {
  const path = resolve(root, ".afk", "state.json");
  let state;
  try { state = JSON.parse(readFileSync(path, "utf8")); }
  catch { say(`WAVE: no run state at ${path}; nothing to stop.`); return 1; }
  // The project's `worktreeSetup.teardown` reaches each lane here too (#109):
  // a stop from outside the driver is the R11 path, and the simulator a lane's
  // check booted outlives the builder either way. A config that will not load
  // costs the hooks, not the stop.
  let setup = null;
  try { setup = existsSync(configPath(root)) ? loadConfig(root).worktreeSetup ?? null : null; }
  catch (error) { say(`WAVE: .afk-setup/config.yaml did not load (${error.message}); worktreeSetup.teardown hooks will not run.`); }
  const fates = teardown(state, { teardown: (lane) => teardownWorktree({ worktree: lane.worktree, setup }) });
  if (!fates.length) { say("WAVE: run state contains no live lane pid to stop."); return 1; }
  for (const fate of fates) {
    say(`WAVE: pid ${fate.pid} (${fate.role} ${fate.taskId}): ${fate.fate}.`);
    for (const line of hookFailureLines(fate.taskId, fate.teardown)) say(`WAVE: ${line}`);
  }
  return 0;
};

export const cliWaveValidate = ({ root, dir, json }) => {
  // No config is the same as a config supplying no `defaultChecks`: every task
  // without its own `checks` is ungateable, and says so. `afk validate`
  // tolerates a missing config; this must not, because the graph it prints is
  // meant to be handed to `afk auto --dag=` unchanged, and that path throws on
  // a task with no checks.
  const config = existsSync(configPath(root)) ? loadConfig(root) : null;
  // Not under `--json`: that stream is parsed, and a friendly note on it is a
  // syntax error at the caller.
  if (!config && !json) {
    console.log(
      `WAVE: no .afk-setup/config.yaml at ${configPath(root)} — every task without its own \`checks:\` will be refused as ungateable.`,
    );
  }
  let result;
  try {
    result = readWaveDirectory(resolve(root, dir), {
      defaultChecks: config?.defaultChecks ?? [],
    });
  } catch (error) {
    console.log(`WAVE: ${error.message}`);
    return 1;
  }
  if (!result.ok) {
    // Refusals to STDOUT, like every other refusal in this runner: a supervising
    // agent reads stdout, and a decline it cannot see is a command that failed
    // for no stated reason. `--json` still emits them, so a caller has one shape
    // to read whichever way it went.
    console.log(json ? JSON.stringify({ ok: false, refusals: result.refusals }, null, 2) : renderRefusals(result.refusals));
    return 1;
  }
  console.log(json ? JSON.stringify(result.dag, null, 2) : renderWaveDag(result.dag, result.done));
  return 0;
};

/**
 * One side of the todo/done split, tolerating its absence.
 *
 * Neither directory is guaranteed to exist at any given moment: `tasks-done/`
 * appears at the first merged wave, and `tasks-todo/` disappears when the last
 * file leaves it, because git does not track an empty directory. A `readdirSync`
 * that threw here would take the night down between the fast-forward and the
 * commit, which is the worst possible place to lose it.
 */
export const listTaskFiles = (waveDir, side) => {
  const path = join(waveDir, side);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => name.endsWith(".md"));
};

/**
 * File the passed tasks' markdown under `tasks-done/`.
 *
 * `git mv`, not `renameSync`: the files are tracked, and the move has to be a
 * staged rename so the bookkeeping commit below records it as one rather than
 * as a delete and an add. A mv that fails is reported and skipped — the tree is
 * a rendering of the log, and a rendering that is one file stale must never be
 * a reason to lose a wave that merged.
 */
export const fileDoneTasks = ({ git, root, waveDir, names, say }) => {
  if (names.length === 0) return [];
  ensureDir(join(waveDir, "tasks-done"));
  const moved = [];
  for (const name of names) {
    const result = git(
      root,
      `mv ${shellQuote(join(waveDir, "tasks-todo", name))} ${shellQuote(join(waveDir, "tasks-done", name))}`,
    );
    if (result.status === 0) moved.push(name);
    else say(`WAVE: could not file ${name} under tasks-done/: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return moved;
};

// ---------------------------------------------------------------------------
// The effects the driver needs, in one injectable bag
// ---------------------------------------------------------------------------

const gitIn = (cwd, command) => run(`git ${command}`, { cwd });

export const waveLogPath = (dir) => join(dir, ".wave-log.json");

export const readWaveLog = (dir, base) => {
  const path = waveLogPath(dir);
  if (!existsSync(path)) return emptyWaveLog(base);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Fail closed. A corrupt log is the ONLY record of what crossed the last
    // wave boundary, and treating it as empty re-runs merged work against a
    // base branch that already has it.
    throw new Error(`${path} is unreadable (${error.message}) — it is the driver's only memory across a wave boundary, and starting fresh would re-run merged work. Fix or delete it deliberately.`);
  }
};

/**
 * A wave's per-task result, read off the run's own state (`.afk/state.json`).
 *
 * `passed` is the runner's terminal success state and the only outcome that
 * lets a dependent start (CONTEXT.md). Everything else is recorded verbatim so
 * the digest can say `blocked` rather than flatten it to "failed", but only
 * `passed` counts anywhere a decision is made.
 */
export const waveTaskResults = (runRoot, taskIds) => {
  const path = resolve(runRoot, ".afk", "state.json");
  let state = null;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch { /* no state: the run never started, and every task reads as unattempted */ }
  return Object.fromEntries(
    taskIds.map((id) => {
      const task = state?.tasks?.[id];
      return [id, {
        outcome: task?.lifecycle ?? "pending",
        attempts: Number(task?.builderAttempt) || 0,
      }];
    }),
  );
};

/**
 * The failing attempts' evidence, read BEFORE `.afk/` is archived.
 *
 * §4: "the failing attempts' evidence is copied into the digest before
 * archiving, or a dead task's reason is in a directory nobody opens." The shape
 * is `renderPriorAttempts`' (worker.mjs) — the first failing check's command
 * and output, and when no check failed, the fact that the agent process itself
 * is what went wrong. Same reason, too: a suite stops at its first failure and
 * carrying the rest is the 1.3M-token death AGENTS.md failure mode 5 records.
 */
export const collectFailureEvidence = (runRoot, results) => {
  const evidence = [];
  for (const [id, result] of Object.entries(results)) {
    if (result.outcome === "passed") continue;
    for (let attempt = 1; attempt <= Math.max(1, result.attempts); attempt += 1) {
      let verification;
      try {
        verification = JSON.parse(
          readFileSync(resolve(builderRunDir(runRoot, id, attempt), "verification.json"), "utf8"),
        );
      } catch { continue; }
      const failed = (verification.checks ?? []).find((check) => checkFailed(check));
      evidence.push({
        id,
        attempt,
        command: failed?.command ?? null,
        // A timed-out check is not a red one, and the digest is the surface a
        // human actually reads in the morning: `First failing check: swift
        // test` sends them looking for a broken assertion when what fired was
        // the bound (#70). Same split as `renderPriorAttempts` in worker.mjs —
        // named for a timeout, untouched for a real failure.
        reason: failed?.timedOut ? checkFailureReason(failed) : null,
        output: failed ? String(failed.output ?? "").trim().slice(0, 4_000) : null,
        note: failed
          ? null
          : verification.timedOut
            ? `No check failed; the agent process timed out after ${verification.durationMs ?? "unknown"}ms.`
            : `No check failed; the agent process exited ${verification.agentExitCode ?? "non-zero"}.`,
      });
    }
  }
  return evidence;
};

/**
 * Each task's permission-broker denials across all its attempts, read BEFORE
 * `.afk/` is archived, for the digest's task rows (#53). A denial is one refused
 * tool call and the lane carries on, so without this nobody learns it happened.
 * Only tasks with at least one denial appear.
 */
export const collectBrokerDenials = (runRoot, results) => {
  const denials = {};
  for (const id of Object.keys(results)) {
    let denied = 0;
    const subjects = new Set();
    // Every builder-N dir on disk, not 1..attempts: an infra or auth failure
    // zeroes the attempt counter, and the dirs from before it still count.
    const taskDir = dirname(builderRunDir(runRoot, id, 1));
    let dirs = [];
    try { dirs = readdirSync(taskDir).filter((name) => /^builder-\d+$/.test(name)); } catch { /* no run dir: no denials */ }
    for (const dir of dirs) {
      let broker;
      try {
        broker = JSON.parse(readFileSync(resolve(taskDir, dir, "verification.json"), "utf8")).brokerDecisions;
      } catch {
        // Fails OPEN: an unreadable record undercounts that attempt's denials
        // rather than stopping the digest. The count is advisory — a denial
        // never failed the lane — so a missing number costs a line, not a gate.
        continue;
      }
      if (!broker?.denied) continue;
      denied += broker.denied;
      for (const entry of broker.entries ?? [])
        if (entry.behavior === "deny") for (const subject of entry.subjects ?? []) subjects.add(subject);
    }
    if (denied) denials[id] = { denied, subjects: [...subjects] };
  }
  return denials;
};

export const readVerifier = (runRoot, id) => {
  try {
    return verifierDecision(JSON.parse(readFileSync(verifierReportPath(runRoot, id), "utf8")));
  } catch {
    return null;
  }
};

/** Move one run's `.afk/` out of the wave worktree, which is about to be removed. */
export const archiveWaveRun = ({ runRoot, root, id }) => {
  const target = resolve(root, ".afk", "archive", id);
  ensureDir(target);
  const moved = [];
  for (const entry of ARCHIVED) {
    const source = resolve(runRoot, ".afk", entry);
    if (!existsSync(source)) continue;
    try {
      renameSync(source, resolve(target, entry));
    } catch {
      // The wave worktree lives under ~/.afk-claude/epics and the repo may be on
      // another filesystem, where rename() is EXDEV. Copy, then remove — never
      // remove without copying.
      if (run(`cp -R ${shellQuote(source)} ${shellQuote(resolve(target, entry))}`).status !== 0) continue;
      rmSync(source, { recursive: true, force: true });
    }
    moved.push(entry);
  }
  return { target, moved };
};

// The run evidence `flushStatuses` commits from the FAILURE paths too, which
// `archiveWaveRun` does NOT cover: it lives on the wave BRANCH, not under
// `.afk/`. An all-failed wave never fast-forwards, so its branch is the only
// copy — and the teardown that runs BECAUSE the wave failed then deletes it,
// erasing the night's own account of why every lane died (#96). Copied (not
// moved: the worktree is about to be removed anyway) into the same archive dir
// before the branch and worktree go. `docs/progress.md` is what `flushStatuses`
// commits from the failure paths; `.afk-runs` is kept for a lane's
// `ACTION-REQUIRED.md` and for waves from before #106, when the integration
// verification was committed there too. The force-tracked ledger keeps its
// copy on the base, so it is left out.
//
// Both progress paths (#122). A wave run carries an epic id like any other —
// `epic: { id: waveId }`, stamped by the loader and re-stamped per wave below —
// so its table is `docs/progress/wave-01.md` and the DIRECTORY is what has to be
// archived. The shared file is kept beside it for waves recorded before this,
// and for a project whose own `docs/progress.md` rode the branch. `cp -R` takes
// a directory as happily as a file, and a path that does not exist is skipped.
const WAVE_EVIDENCE = [PROGRESS_FILE, PROGRESS_DIR, ".afk-runs"];
export const archiveWaveEvidence = ({ worktree, target }) => {
  ensureDir(target);
  const moved = [];
  for (const entry of WAVE_EVIDENCE) {
    const source = resolve(worktree, entry);
    if (!existsSync(source)) continue;
    const dest = resolve(target, entry);
    ensureDir(dirname(dest));
    // Copy beside the destination and swap, rather than clearing it first.
    // Both halves are load-bearing:
    //
    //   the swap — `cp -R dir dest` NESTS when dest exists, so a second archive
    //   to one target left `docs/progress/progress`, which reads as evidence of
    //   nothing. Reachable only since this list grew a directory entry (#122).
    //
    //   the staging path — clearing dest first is destructive on the failure
    //   path: a `cp` that then errors has deleted the only copy of an all-failed
    //   wave's tables, which is the ONE case this function exists for. FAIL
    //   DIRECTION: a failed copy leaves the previous archive exactly as it was
    //   and reports the entry as not moved.
    const staging = `${dest}.incoming`;
    rmSync(staging, { recursive: true, force: true });
    if (run(`cp -R ${shellQuote(source)} ${shellQuote(staging)}`).status !== 0) {
      // A partial copy is still a copy: `cp -R` over an unreadable directory
      // creates the destination and THEN fails, so leaving it would strand an
      // empty `<entry>.incoming` beside the real archive on every retry.
      rmSync(staging, { recursive: true, force: true });
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    moved.push(entry);
  }
  return { moved };
};

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

// The nested `auto` dispatcher is always this same shared entry point. The
// backend rides in AFK_BACKEND — set by whichever executable started this wave
// — and `main` resolves it from there, so `afk-codex wave` gets a Codex `auto`
// and `afk wave` a Claude one without wave picking an executable of its own.
const afkEntry = () => resolve(dirname(fileURLToPath(import.meta.url)), "..", "afk.mjs");

/** The default epic run: the selected backend's `auto` over the wave DAG. */
const spawnWaveRun = ({ runRoot, dagPath, branch }) => {
  const result = spawnSync(
    process.execPath,
    [afkEntry(), "auto", `--dag=${dagPath}`, `--base=${branch}`],
    { cwd: runRoot, stdio: "inherit" },
  );
  return { status: result.status ?? 1 };
};

/**
 * The semantic tier, ONCE PER RUN over the WHOLE frozen graph (§2). One
 * read-only agent at the project root.
 *
 * Runs at `root`, not in a worktree, because there is no worktree yet — that is
 * the whole point of where it sits, and it is also where the epic path runs it
 * (`plan-review.mjs`: "it runs at the project root").
 *
 * WHY NOT PER WAVE. It was per wave, and the first live run proved that wrong
 * in one shot: `wave-01`'s prompt carried three root tasks and the whole of
 * GOAL.md, and the reviewer refused with `unsatisfied_criterion` — "no child
 * task builds the CLI wire" — for a CLI that is `task-06-cli` in wave 3. It was
 * right about what it was shown and wrong about the project. Reviewing one
 * slice of a graph against the whole goal structurally guarantees that refusal
 * on wave 1 of any project whose goal needs more than one wave, and no wording
 * of GOAL.md fixes it: the missing tasks are missing from the prompt, not from
 * the directory. §4 already freezes the graph at t0, so the decomposition never
 * changes between waves — one review answers the question for every wave, and
 * each later re-ask would have strictly less information than the first.
 *
 * What it is given, and why:
 *
 * - `epic.body` is GOAL.md, carried onto the DAG by the loader. §2: without it
 *   review has only the tasks, and `auditFindings` has no body to check an
 *   `unsatisfied_criterion` quote against, so no such finding could ever be
 *   kept.
 * - the children are EVERY task in the directory, with their real `dependsOn`
 *   from the frozen graph — not a wave's slice, and not the stripped edges the
 *   run is handed. Stripping is a scheduling fact (a wave's dependencies are
 *   already merged onto the base it was cut from); telling the reviewer a
 *   dependent is a root would invite a `missing_dependency` for an artifact
 *   that is already on the branch.
 * - `metrics` is null. `graphMetrics` computes depth and blast radius from an
 *   `afk:` block keyed by issue numbers (`epic-spec.mjs`), which a task
 *   directory is not; porting it to this shape is a change of its own and is
 *   listed under "Open" in `docs/wave-mode.md`. `planReviewPrompt` omits the
 *   line when the row is absent. Note that the old justification — a wave has
 *   no internal edge, so every row would read depth 0 — died with the per-wave
 *   review, and is not the reason any more.
 * - `started` is empty, and now trivially so: the review runs before the first
 *   branch is cut, so nothing in the graph has been built. It exists to release
 *   the `unsatisfied_criterion` block once the repair is no longer free, and at
 *   this point every repair is free.
 *
 * Body budgets, checked rather than assumed: `EPIC_BODY_BUDGET` is 24_000 and
 * `TASK_BODY_BUDGET` 9_000, applied per body — so a directory of N tasks is
 * bounded at 24_000 + N × 9_000 characters of body text. `clip` truncates
 * loudly above that rather than dropping or overpaying. See the arithmetic in
 * `docs/wave-mode.md` §4 for where that starts to strain.
 */
const spawnWavePlanReview = async ({ root, config, dag, runDir, say }) => {
  const { renderPlanReview, runPlanReview } = await import("./plan-review.mjs");
  const outcome = await runPlanReview({
    root,
    config: config ?? {},
    epic: dag.epic,
    dag,
    metrics: null,
    started: new Set(),
    runDir,
  });
  // `planReviewDecision` reads three fields — `ok`, `status`, `message` — and the
  // outcome carries more: the kept findings, the ones the graph refuted, the
  // warnings the operator is accepting by letting the wave run, and where the
  // decision record was appended. None of them change the verdict, and all of
  // them are the operator's only account of what was reviewed. `cliEpic` prints
  // exactly this; a wave that swallowed it would make an accepted warning
  // indistinguishable afterwards from one nobody read. Printed here rather than
  // in the loop so it stays on the effects side of the seam.
  say(renderPlanReview(outcome));
  return outcome;
};

/**
 * The loop of §4. Serial, one wave at a time, `--worktree` always, so the main
 * checkout stays on the base branch and belongs to the driver alone.
 *
 * Every `io` entry is an effect and is injected so the loop is exercisable
 * without an overnight run.
 */
export const cliWaveRun = async ({
  root,
  dir,
  base,
  cap = WAVE_CAP,
  io = {},
  say = console.log,
}) => {
  const git = io.git ?? gitIn;
  const runWave = io.runWave ?? spawnWaveRun;
  const planReview = io.planReview ?? spawnWavePlanReview;
  const makeWorktree = io.makeWorktree ?? createEpicWorktree;
  const removeWorktree = io.removeWorktree ?? (({ worktree }) => git(root, `worktree remove --force ${shellQuote(worktree)}`));
  const now = io.now ?? (() => new Date().toISOString());

  const waveDir = resolve(root, dir);
  if (!base) {
    say("WAVE: `afk wave run` needs --base=<branch>. There is no default: the runner's hardcoded `main` is how a wave lands on a stale base without saying so.");
    return 1;
  }

  const config = existsSync(configPath(root)) ? loadConfig(root) : {};
  // The graph is FROZEN here, at t0, and never re-read (§4). A driver that
  // re-read the directory each wave would schedule an agent's excuse for not
  // doing the work, and the graph would stop being finite.
  let loaded;
  try {
    loaded = readWaveDirectory(waveDir, { defaultChecks: config.defaultChecks ?? [] });
  } catch (error) {
    say(`WAVE: ${error.message}`);
    return 1;
  }
  if (!loaded.ok) {
    say(renderRefusals(loaded.refusals));
    return 1;
  }
  const dag = loaded.dag;
  // Follow-up detection compares `tasks-todo/` against itself over the wave, so
  // it is the todo side alone: a file the driver FILED under `tasks-done/` left
  // this list by leaving the directory, and a file an agent WROTE joined it.
  const frozenFiles = listTaskFiles(waveDir, "tasks-todo");

  const head = git(root, "rev-parse --abbrev-ref HEAD").stdout.trim();
  if (head !== base) {
    // Fail closed. The driver commits the log and the digest to the base branch
    // and moves its ref; doing either from a checkout on another branch writes
    // the night's record somewhere nobody will look for it.
    say(`WAVE: this checkout is on \`${head}\`, not \`${base}\`. The driver owns the base checkout — check it out, or pass the branch you are on.`);
    return 1;
  }

  // The two records the driver itself leaves uncommitted between waves: a
  // withheld wave deliberately parks its log and digest in the working tree for
  // the next merged wave to carry, so neither may block a resume, and neither
  // belongs in the boundary stash below — the driver rewrites both immediately
  // after the reset.
  const driverOwned = [relative(root, waveLogPath(waveDir)), "docs/afk-runs/"];

  // Both places that ask "what tracked change is in the way?" ask it the same
  // way. They did not: one parsed porcelain here and the other in the driver,
  // and the driver's copy turned `R old -> new` into a pathspec git rejects, so
  // a mid-wave `git mv` failed the boundary stash and stranded the wave.
  const trackedDirty = () =>
    dirtyBlockers(
      parseStatusPaths(git(root, "status --porcelain").stdout, { includeUntracked: false }),
      driverOwned,
    );

  // The fast-forward brings this checkout back to the moved ref with a
  // `reset --hard`, so a tracked modification the driver did not write would be
  // destroyed hours into the night. Refuse before anything is created — an edit
  // that exists BEFORE the run can simply be committed, which is the cheapest
  // outcome for everyone. An edit made DURING the run has no such window (a
  // commit on the base strands the wave), and is carried across the boundary
  // instead; see the stash at the fast-forward.
  const dirty = trackedDirty();
  if (dirty.length) {
    say(`WAVE: this checkout has uncommitted tracked changes and the driver moves its branch ref: ${dirty.join(", ")}. Commit or stash them.`);
    return 1;
  }

  let log;
  try {
    log = readWaveLog(waveDir, base);
  } catch (error) {
    say(`WAVE: ${error.message}`);
    return 1;
  }
  if (log.base && log.base !== base) {
    say(`WAVE: ${waveLogPath(waveDir)} records base \`${log.base}\`, and you passed \`${base}\`. Refusing: the recorded shas are against the other branch.`);
    return 1;
  }
  log.base = base;

  const plan = resumePlan(log);
  if (plan.mergedWaves.length) {
    say(`WAVE: resuming — ${plan.mergedWaves.map((wave) => wave.id).join(", ")} already merged and skipped.`);
  }
  if (plan.replay) {
    say(`WAVE: ${plan.replay.id} was recorded \`${plan.replay.outcome}\`; replaying it from ${plan.replay.baseSha}.`);
  }

  // THE SEMANTIC TIER, AND THE LAST LINE BEFORE THIS RUN CREATES ANYTHING.
  // Everything below — the branch, the worktree, the lane — is downstream, so a
  // contradiction here costs one short read-only session and leaves the
  // repository exactly as it was. Same ordering as `cliEpic`, and for the same
  // reason: `plan-review.mjs`'s governing sentence is "a contradiction aborts
  // before any branch or worktree exists". It sits above the loop rather than
  // inside it because the graph is frozen at t0 (§4): the decomposition the
  // reviewer judges is the same one at wave 5 as at wave 1, and a per-wave
  // review re-asked that fixed question while showing it strictly less each
  // time — see `spawnWavePlanReview` for the run this cost.
  //
  // `log.planReview` is the memory. It is TOP-LEVEL, not a field on a wave
  // record: the thing reviewed is the whole frozen graph, which is a property
  // of the run, and hanging it off `waves[0]` would imply the answer could
  // differ between waves. It rides the same `atomicWrite` as the first wave's
  // record, so a run that dies before any wave is recorded re-reviews on the
  // next attempt — the safe direction, and the same one a log written by a
  // build from before this field takes.
  if (!log.planReview) {
    const review = planReviewDecision(
      await planReview({
        root,
        config,
        dag,
        runDir: resolve(root, ".afk", "plan-review", dag.epic.id),
        say,
      }),
    );
    if (!review.allowed) {
      say(`WAVE: plan review refused ${dir} (${review.status}) — ${review.reason}`);
      say(`WAVE: no branch, worktree or lane was created. Fix the tasks or GOAL.md in ${dir} and re-run.`);
      return 1;
    }
    log.planReview = { status: review.status, reviewedAt: now(), tasks: dag.tasks.length };
  } else {
    say(`WAVE: plan review already recorded (${log.planReview.status}, ${log.planReview.reviewedAt}) — the graph is frozen, so it is not re-run.`);
  }

  let index = plan.nextIndex;
  for (;;) {
    const ledger = taskLedger(log);
    const halt = haltDecision({ dag, ledger });
    if (halt.halt) {
      say(`WAVE: halting — ${halt.reason}`);
      return 1;
    }
    const taskIds = waveFrontier({ dag, ledger, cap });
    if (taskIds.length === 0) {
      say(`WAVE: no runnable tasks remain. ${Object.values(ledger).filter((entry) => entry.outcome === "passed").length} of ${dag.tasks.length} task(s) passed.`);
      return 0;
    }

    const id = waveId(index);
    const startedAt = now();
    // Resume re-uses the recorded checkpoint: §3's "anything else re-runs from
    // its recorded baseSha". A replayed wave that re-cut its branch from a
    // moved base would silently change what it was reviewed against.
    //
    // That holds only while there is something to be consistent WITH. A wave
    // that recorded no passed task put no lane merge on its branch, so pinning
    // the replay to its recorded sha protects nothing and pins the staleness
    // instead: quillnote wave-31 died at the baseline, two repair commits
    // landed on `main`, and the replay ran at the sha from before them and
    // could never be fast-forwarded (#74). Such a wave is re-cut from the base
    // as it stands now, which is where the repairs are.
    const recorded = (log.waves ?? []).find((wave) => wave.id === id);
    const hasMergedWork = waveHasMergedWork(recorded);
    const baseSha = (hasMergedWork ? recorded?.baseSha : null)
      ?? git(root, `rev-parse ${shellQuote(base)}`).stdout.trim();
    if (!baseSha) {
      say(`WAVE: cannot resolve \`${base}\` to a sha.`);
      return 1;
    }
    if (recorded?.baseSha && recorded.baseSha !== baseSha)
      say(`WAVE: ${id} recorded no passed task, so its recorded base ${recorded.baseSha} is not replayed; it is re-cut from ${base} as it stands now (${baseSha}).`);

    // The wave's tasks as the frozen graph states them. The stripped-edge copy
    // the run is handed is built further down.
    const waveTaskSpecs = dag.tasks.filter((task) => taskIds.includes(task.id));

    // Cut the branch, reuse it on a real replay, or clear a stale one. `-B` is
    // still deliberately not used — see `waveBranchDecision` for what the four
    // answers are and which failure each of them is avoiding. Adopting an
    // existing branch silently, which is what this used to do, is the one
    // answer that had to go.
    const branchSha = git(root, `rev-parse --verify --quiet ${shellQuote(`refs/heads/${id}`)}`).stdout.trim();
    // The evidence a missing wave-log record cannot give: does this branch hold
    // a commit the base branch does not? Fails CLOSED — a `rev-list` that could
    // not run answers "yes, it carries something", because the decision that
    // consumes this deletes the branch when the answer is no.
    const branchAheadOf = (from, sha) => {
      const counted = git(root, `rev-list --count ${shellQuote(`${from}..${sha}`)}`);
      return counted.status !== 0 || Number(counted.stdout.trim()) !== 0;
    };
    // The narrower question, and the one that separates a crash-resume from a
    // stranger's branch: of those commits, did any touch a path a reviewer
    // read? `flushStatuses` commits progress, the ledger and the per-task
    // verification from the FAILURE paths too, so "ahead of base" alone is true
    // of every resume after a lane failed. Same path list as
    // `markStaleEvidence` in verifier.mjs, for the same reason.
    //
    // Fails CLOSED, like the count above: a `log` that could not run, or commits
    // whose paths it did not print (a merge shows none), answers "yes, somebody's
    // work" — the caller deletes the branch when the answer is no.
    const branchWorkAheadOf = (from, sha) => {
      const listed = git(root, `log --format= --name-only ${shellQuote(`${from}..${sha}`)}`);
      if (listed.status !== 0) return true;
      const files = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      return files.length === 0 || !files.every(isStatusFlushPath);
    };
    const branchPlan = waveBranchDecision({
      id,
      branchSha: branchSha || null,
      baseSha,
      // Whether the log has anything to say about this wave at all, kept apart
      // from what it says. `waveHasMergedWork(undefined)` is false, and a cut
      // that could not tell those two apart deleted a branch it had no evidence
      // about — which is the salvage procedure's branches and a human's own.
      hasRecord: Boolean(recorded),
      hasMergedWork,
      branchAheadOfBase: Boolean(branchSha) && branchAheadOf(base, branchSha),
      branchWorkAheadOfBase: Boolean(branchSha) && branchWorkAheadOf(base, branchSha),
      baseIsAncestor: Boolean(branchSha)
        && git(root, `merge-base --is-ancestor ${shellQuote(baseSha)} ${shellQuote(branchSha)}`).status === 0,
    });
    say(`WAVE: ${branchPlan.reason}`);
    if (branchPlan.action === "refuse") return 1;
    if (branchPlan.action === "recreate") {
      // Worktree, then prune, then branch — and verified, because `branch -D`
      // fails quietly while a worktree still holds the ref, and cutting after a
      // delete that did not happen is the adoption all over again.
      const cleared = removeWaveRefs({ git, root, branch: id, removeWorktree });
      if (!cleared.branchGone) {
        say(`WAVE: refusing — \`${id}\` could not be removed: ${cleared.notes.join("; ")}. Remove it by hand and re-run.`);
        return 1;
      }
      // A worktree the recreate could not shed is not fatal — the branch is gone
      // and the cut proceeds — but it must not be swallowed: it is a directory a
      // human has to clear, and the makeWorktree below may collide with it (#96).
      if (!cleared.worktreeGone)
        say(`WAVE: \`${id}\`'s branch was recreated but its worktree could not be removed: ${cleared.notes.join("; ")}.`);
    }
    if (branchPlan.action !== "reuse") {
      const cut = git(root, `branch ${shellQuote(id)} ${shellQuote(baseSha)}`);
      if (cut.status !== 0) {
        say(`WAVE: cannot cut ${id} from ${baseSha}: ${cut.stderr || cut.stdout}`);
        return 1;
      }
    }

    let worktree;
    try {
      ({ worktree } = makeWorktree({ root, branch: id, epicId: id, setup: config.worktreeSetup }));
    } catch (error) {
      say(`WAVE: ${error.message}`);
      return 1;
    }
    say(`WAVE: ${id} — ${taskIds.length} task(s) in ${worktree}: ${taskIds.join(", ")}`);

    const waveDag = {
      ...dag,
      epic: { ...dag.epic, id },
      branch: id,
      tasks: waveTaskSpecs.map((task) => ({
        ...task,
        // The wave IS the disjoint set: its tasks' dependencies all passed in an
        // earlier wave and are already on the base branch this one was cut from.
        // Carrying the edges would leave every task blocked on a task the run
        // has never heard of.
        dependsOn: [],
      })),
    };
    const dagPath = resolve(worktree, ".afk", `${id}.json`);
    atomicWrite(dagPath, `${JSON.stringify(waveDag, null, 2)}\n`);

    runWave({ runRoot: worktree, dagPath, branch: id, taskIds });

    // --- everything below runs whatever the run's exit status was: a run that
    // --- died still has a state file, evidence and a branch worth reading.
    const results = waveTaskResults(worktree, taskIds);
    const failures = collectFailureEvidence(worktree, results);
    const brokerDenials = collectBrokerDenials(worktree, results);
    const decision = readVerifier(worktree, id);
    // The only evidence that this wave's TIP was checked: the closeout's fix
    // pass commits after the wave's own gates have passed. Read here, beside the
    // verifier, because `archiveWaveRun` below moves `.afk/` out of the
    // worktree — and for the last wave of a run nothing else ever closes that
    // gap (#78).
    const closeoutGate = readCloseoutGate(worktree, id);
    const isAncestor = git(root, `merge-base --is-ancestor ${shellQuote(base)} ${shellQuote(id)}`).status === 0;

    // A replayed wave keeps what its first run achieved: the frontier only
    // scheduled what had not passed, so `results` names fewer tasks than the
    // record it replaces.
    const waveTasks = mergeWaveTasks(recorded?.tasks, results);
    const merged = recordWave(log, { id, tasks: waveTasks });
    const decidedLedger = taskLedger(merged);
    const fastForward = fastForwardDecision({
      waveTasks: taskIds,
      ledger: decidedLedger,
      isAncestor,
      // Read whether or not it is used: the refusal is the one moment the two
      // shas matter, and reconstructing them afterwards from the ledger is what
      // #74 cost a morning.
      divergence: {
        base,
        id,
        baseSha,
        baseNow: git(root, `rev-parse ${shellQuote(base)}`).stdout.trim(),
        ahead: Number(git(root, `rev-list --count ${shellQuote(`${baseSha}..${base}`)}`).stdout.trim()) || 0,
      },
    });

    let headSha = null;
    if (fastForward.allowed) {
      // A human's uncommitted edit to a TRACKED file, made during the wave, is
      // carried across the boundary rather than run over. The `reset --hard`
      // below used to discard it with no error — twice in one night on
      // quillnote, and one of the two was the `blocked_by` edge repairing an
      // `owns` collision, so losing it also stopped the next cut (#72).
      // Committing is not the alternative the human has: a commit on the base
      // mid-wave breaks the ancestor assertion and strands the wave.
      //
      // Stashed BEFORE `update-ref`, while HEAD is still the sha the edit was
      // made against; a stash taken after the ref moved would diff against the
      // whole wave. Pathspec-limited, so the driver's own withheld records stay
      // where they are and untracked files are never touched (failure mode 2).
      //
      // FAIL DIRECTION: closed on capture, open on restore. A stash that cannot
      // be TAKEN aborts the fast-forward, because moving the ref anyway is the
      // data loss this exists to prevent. A stash that cannot be POPPED — the
      // wave changed the same file — leaves the tree clean at the new HEAD and
      // NAMES the stash: the edit is a real commit in the object store either
      // way, and a tree left in conflict would refuse every remaining wave.
      // One status snapshot answers both "what tracked change is in the way?"
      // and "which untracked file will the tip overwrite?" — the same way the
      // boundary already asks the tracked question, not a second `git status`.
      const status = git(root, "status --porcelain").stdout;
      const carried = dirtyBlockers(parseStatusPaths(status, { includeUntracked: false }), driverOwned);
      // `reset --hard` leaves untracked files alone (failure mode 2) EXCEPT
      // where the wave tip tracks the same path, which it then silently
      // overwrites (#91). A human and a lane working from the same task list
      // write the same new path; the human's untracked copy has to be carried
      // too, with `-u` so the stash captures it — a plain pathspec stash skips
      // untracked files. A non-colliding untracked file (a lane's follow-up
      // draft) matches no wave-tip path and is left where it was written.
      const collided = dirtyBlockers(parseStatusPaths(status), driverOwned)
        .filter((path) => !carried.includes(path))
        .filter((path) => git(root, `cat-file -e ${shellQuote(`${id}:${path}`)}`).status === 0);
      const stashed = [...carried, ...collided];
      const stashLabel = `afk wave: ${id} boundary`;
      if (stashed.length) {
        const untrackedFlag = collided.length ? "-u " : "";
        const push = git(root, `stash push ${untrackedFlag}-m ${shellQuote(stashLabel)} -- ${stashed.map(shellQuote).join(" ")}`);
        if (push.status !== 0) {
          say(`WAVE: refusing to move ${base} — your uncommitted changes to ${stashed.join(", ")} could not be stashed first and the fast-forward would discard them: ${(push.stderr || push.stdout || "").trim()}`);
          return 1;
        }
      }
      // The ancestor assertion above is the whole safety mechanism. `update-ref`
      // with no `--force` anywhere: if anything moved the base since the check,
      // git refuses and so do we.
      const move = git(root, `update-ref ${shellQuote(`refs/heads/${base}`)} ${shellQuote(id)}`);
      if (move.status !== 0) {
        if (stashed.length) git(root, "stash pop");
        say(`WAVE: refusing — could not move ${base} to ${id}: ${move.stderr || move.stdout}`);
        return 1;
      }
      // The main checkout is ON `base`, so the ref move left its index behind.
      git(root, "reset --hard HEAD");
      if (stashed.length) {
        if (git(root, "stash pop").status === 0) {
          say(`WAVE: carried ${stashed.length} uncommitted change(s) across the ${id} boundary: ${stashed.join(", ")}.`);
        } else {
          git(root, "reset --hard HEAD");
          say(`WAVE: your uncommitted changes to ${stashed.join(", ")} conflict with ${id} and were NOT re-applied. They are kept as the stash \`${stashLabel}\` — \`git stash list\`, then \`git stash pop\` once the run is over.`);
        }
      }
      headSha = git(root, `rev-parse ${shellQuote(base)}`).stdout.trim();
      say(`WAVE: ${base} fast-forwarded to ${id} (${headSha}).`);
    } else {
      say(`WAVE: ${id} not moved onto ${base} — ${fastForward.reason}`);
    }

    const afterLedger = taskLedger(merged);
    const halted = haltDecision({ dag, ledger: afterLedger });
    await appendCloseRow({ root: worktree, epicId: id, once: true, say });
    const archive = archiveWaveRun({ runRoot: worktree, root, id });
    const digestPath = resolve(root, "docs", "afk-runs", `${id}.md`);
    atomicWrite(
      digestPath,
      renderDigest({
        id,
        base,
        baseSha,
        headSha,
        startedAt,
        finishedAt: now(),
        maxParallel: Math.max(1, Number(config.maxParallel) || 1),
        tasks: taskIds.map((taskId) => ({
          id: taskId,
          outcome: afterLedger[taskId]?.outcome ?? "pending",
          attempts: afterLedger[taskId]?.attempts ?? 0,
          dead: afterLedger[taskId]?.outcome !== "passed" && (afterLedger[taskId]?.attempts ?? 0) >= ATTEMPT_BUDGET,
          broker: brokerDenials[taskId] ?? null,
        })),
        failures,
        verifier: {
          status: verifierStatus(decision),
          disputed: [...(decision?.blocking ?? []), ...(decision?.notes ?? [])],
        },
        closeoutGate,
        followUps: followUpFiles(frozenFiles, listTaskFiles(waveDir, "tasks-todo")),
        fastForward,
        halt: halted,
        archive: archive.target,
      }),
    );

    const outcome = halted.halt && !fastForward.allowed ? "halted" : fastForward.verdict;
    log = recordWave(merged, {
      id,
      branch: id,
      baseSha,
      headSha,
      maxParallel: Math.max(1, Number(config.maxParallel) || 1),
      tasks: waveTasks,
      verifier: verifierStatus(decision),
      digest: `docs/afk-runs/${id}.md`,
      outcome,
    });
    atomicWrite(waveLogPath(waveDir), `${JSON.stringify(log, null, 2)}\n`);

    // A wave that reached no terminal task outcome puts no lane commit on its
    // branch to keep, and a branch that survives is one the next cut can adopt
    // at a base the repairs have since moved past (#74) — so it is removed:
    // worktree, prune, branch, each verified, because `git branch -D` fails
    // quietly while a worktree holds the ref. But "no lane commit" is NOT "no
    // evidence": `flushStatuses` commits the failure forensics on that branch
    // too, and removing the branch is the only-copy deletion #96 fixes — so the
    // evidence is archived out FIRST. A wave that DID produce terminal work
    // keeps its branch for a human, which is what the ancestor refusal promises.
    const survives = taskIds.some((taskId) => isTerminal(afterLedger, taskId));
    if (!survives) archiveWaveEvidence({ worktree, target: archive.target });
    const cleared = removeWaveRefs({ git, root, worktree, branch: survives ? null : id, removeWorktree });
    if (!survives) {
      say(cleared.branchGone && cleared.worktreeGone
        ? `WAVE: ${id} reached no terminal task outcome; its worktree and branch are removed, so the next cut is made from ${base} rather than from this wave's base.`
        : `WAVE: ${id} reached no terminal task outcome and could not be fully cleared: ${cleared.notes.join("; ")}. Remove it by hand, or the next cut will find it.`);
    } else if (!cleared.worktreeGone) {
      // Not fatal, and never was: a worktree that will not go is not worth
      // losing the night over. It is said out loud rather than swallowed.
      say(`WAVE: ${id}'s worktree could not be removed: ${cleared.notes.join("; ")}.`);
    }

    // The log and the digest are the night's record and they go onto the base
    // branch, not into `.afk/`, because `.afk/` is archived and the base branch
    // is what the morning opens.
    //
    // ONLY WHEN THE WAVE MERGED, and this is not tidiness. §3 resumes an
    // unfinished wave "from its recorded baseSha", and a commit here would move
    // the base branch past that sha — so the ancestor assertion on the replay
    // would fail against a base the driver itself moved, and the wave could
    // never land however many times it was re-run. A withheld wave leaves its
    // log and digest in the working tree instead, where `git status` shows them
    // and the next merged wave commits them along with its own.
    //
    // The task files move on the same condition and in the same commit. §1's
    // directory contract makes `tasks-done/` the tree's rendering of what
    // finished, and the tree is what a human reads at a glance in the morning —
    // seven files still sitting in `tasks-todo/` after two merged waves says
    // nothing happened. It rides THIS commit rather than the integration merge:
    // a lane merge is the work, and a file being filed is bookkeeping about the
    // work, the same class as the log and the digest beside it. And it is bound
    // by the same "only when the wave merged" rule for the same reason — an
    // unconditional commit here moves the base past the `baseSha` a replay
    // resumes from, and the wave could then never land.
    if (fastForward.allowed) {
      const filed = fileDoneTasks({
        git,
        root,
        waveDir,
        names: doneFileMoves({
          dag,
          ledger: afterLedger,
          todoFiles: listTaskFiles(waveDir, "tasks-todo"),
          doneFiles: listTaskFiles(waveDir, "tasks-done"),
        }),
        say,
      });
      if (filed.length) say(`WAVE: filed ${filed.length} task file(s) under ${dir}/tasks-done/: ${filed.join(", ")}`);
      // NAMED PATHS, NEVER DIRECTORIES. `git add tasks/tasks-todo` sweeps every
      // UNTRACKED file under it, and on quillnote that put two unreviewed
      // agent-authored draft task files into the history under the human's
      // name, in a commit whose message says only that a wave merged (#72).
      // What the driver owns is enumerable and is enumerated here: the log, one
      // digest per wave it has recorded — a withheld wave's digest is still
      // waiting to be carried — and the exact two paths of each file it just
      // moved. Anything else in those directories belongs to whoever wrote it.
      const paths = [
        waveLogPath(waveDir),
        ...(log.waves ?? [])
          .map((wave) => resolve(root, wave.digest ?? join("docs", "afk-runs", `${wave.id}.md`)))
          .filter((path) => existsSync(path)),
        // Both sides of every rename: the todo path no longer exists in the
        // tree and has to be named for the deletion to be recorded.
        ...filed.flatMap((name) => [join(waveDir, "tasks-todo", name), join(waveDir, "tasks-done", name)]),
      ];
      // `git add` takes only what is still on disk. A single pathspec matching
      // nothing makes it stage NOTHING — so naming the gone half of a rename
      // here silently loses the untracked digest, and the commit that needed it
      // fails for a reason two steps away. `git mv` already staged that half.
      const present = paths.filter((path) => existsSync(path));
      if (present.length) git(root, `add ${present.map(shellQuote).join(" ")}`);
      const commit = git(root, `commit -m ${shellQuote(`afk wave: ${id} ${outcome}`)} -- ${paths.map(shellQuote).join(" ")}`);
      // Said out loud rather than swallowed: the wave is already on the base
      // branch at this point, so a lost bookkeeping commit does not lose work —
      // it loses the night's record, and silently, which is how it stays lost.
      if (commit.status !== 0)
        say(`WAVE: ${id} merged, but its bookkeeping commit failed: ${(commit.stderr || commit.stdout || "").trim()}. The log, the digest and the task-file moves are in the working tree; commit them by hand.`);
    }

    if (!fastForward.allowed) {
      say(`WAVE: stopping after ${id}. Digest: docs/afk-runs/${id}.md`);
      return 1;
    }
    if (halted.halt) {
      say(`WAVE: halting — ${halted.reason}. Digest: docs/afk-runs/${id}.md`);
      return 1;
    }
    index += 1;
  }
};

if (isMainModule(import.meta.url)) {
  const { flags, positional } = parseArgv(process.argv.slice(2), ["json", "base", "cap"], { command: "wave" });
  const [verb, dir, taskId] = positional;
  if (verb === "accept" && dir && taskId)
    process.exit(acceptWaveTask({ root: process.cwd(), dir, taskId }));
  if (verb === "stop" && !dir)
    process.exit(stopWaveRun({ root: process.cwd() }));
  if (verb === "run" && dir) {
    process.exit(await cliWaveRun({
      root: process.cwd(),
      dir,
      base: typeof flags.base === "string" ? flags.base : null,
      cap: Number(flags.cap) || WAVE_CAP,
    }));
  }
  if (verb !== "validate" || !dir) {
    console.log(usage);
    process.exit(1);
  }
  process.exit(cliWaveValidate({ root: process.cwd(), dir, json: Boolean(flags.json) }));
}
