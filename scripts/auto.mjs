// Continuous AFK task factory: parallel isolated builders, serialized integration.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentConfig,
  atomicWrite,
  baselineRustRelevant,
  buildAgentCommand,
  checkResult,
  isRustCheck,
  dirtyTreeLines,
  ensureDir,
  isBookkeeping,
  isMainModule,
  isStatusFlushPath,
  onlyStatusFlushSince,
  reviewIsCurrentAt,
  headSha,
  loadConfig,
  normalizeId,
  notify as notifyDesktop,
  parseStatusPaths,
  writeProgress,
  run,
  runAsync,
  shellQuote,
  currentRepo,
  details,
  renderTaskGraphSection,
  resolveBackend,
} from "./lib.mjs";
import {
  AWAITING_ACCEPTANCE,
  canStartIntegration,
  clearWorkerPid,
  dequeueIntegration,
  dependenciesPassed,
  deferralAnnouncements,
  deriveBlocked,
  ensureEpicClose,
  enqueueIntegration,
  epicCloseRecord,
  epicOutcome,
  gateAfterTasks,
  INFRA_FAILURE_MS,
  lifecycleOf,
  looksLikeInfra,
  laneVerified,
  neverReachedApi,
  nextWakeDelay,
  outstandingGates,
  planBuilderBatch,
  preflightBlockers,
  laneTasks,
  checkTasks,
  preflightWarnings,
  recordGateAcceptance,
  reconcileStaleState,
  reconcileWithDag,
  recordWorkerPid,
  resolveGateAfterTasks,
  runnableTasks,
  schedulerDone,
  shouldRetryBuilder,
  supervisorRecord,
  timedOutWithWork,
} from "./scheduler.mjs";
import {
  branchExists,
  changedPaths,
  createTaskWorktree,
  currentBaseSha,
  hookFailureLines,
  listAfkWorktrees,
  pruneRoleCwds,
  readLaneVerification,
  removeTaskWorktree,
  teardownWorktree,
  resetTaskWorktree,
  branchState,
  taskBranch,
  taskWorktree,
  worktreeRoot,
  isEpicCheckout,
} from "./worktree.mjs";
import { evaluateMergeGuards, guardsNotPassed, guardsPassed, mergeDelegations, renderDelegations, renderGuard } from "./merge-guards.mjs";
import { builderRunDir, laneResponded, priorAttemptsFor, runBuilder, STAGGER_MAX_WAIT_MS, staggerGate } from "./worker.mjs";
import { describeShapeChange, graphShapeHash } from "./epic.mjs";
import {
  readVerifierReport,
  renderVerifierMarkdown,
  runVerifier,
  verifierDecision,
  verifierReportCounts,
} from "./verifier.mjs";
import { noteLaneDefect, recordIntegrationDefect, recordLaneDefect, renderMidRunDefects } from "./defects.mjs";
import { lessonCounts, partitionDeferred, partitionFixed, readCloseoutGate, renderMinorsComment, renderUnpassedLanes, unpassedLanes, unpassedTaskIds, withCheckedCriteria } from "./fixer.mjs";
import { ARTEFACT_PREFIXES } from "./sweep.mjs";
import { appendCloseRow, appendLaunchRow, recordGate } from "./measure.mjs";
import { GATE_HEARTBEAT_MS, gateWaitPath, quietHostLoad, readGateHolder, waitForQuietHost, withGateLock } from "./gate-lock.mjs";
import { restoreMain, runIntegration } from "./integrate.mjs";
import { classifyGateFailure, earnsGateRerun } from "./supervisor.mjs";
import { infisicalBlocker, infisicalSessionMissing, usesInfisicalRun } from "./infisical.mjs";
import { modelSwitchLine } from "./model-check.mjs";
import { closeHerdrEpic, closeHerdrLane } from "./runtime-herdr.mjs";
import { builderRoute, checkCodexQuota, checkProviderQuotas, routingTiers, tierDispatch } from "./builder-routing.mjs";
import { JEV_TIMEOUT_MS, routeTasks } from "./tier-router.mjs";
import { roleAgent, roleFor } from "./roles.mjs";
import { LEDGER_RELATIVE, readLedger, renderLedgerForPrompt } from "./ledger.mjs";
import { startDashboard } from "./dashboard-process.mjs";
import { forgetNoDashboard, recordNoDashboard } from "./hub/runs.mjs";
import { stopProcessesUnder, teardownRecordedLanes } from "./teardown.mjs";
// Not the local `pidAlive` in runAuto (`kill -0` through a shell), which reads
// EPERM as dead: this one reads it as alive, which is the question after a
// signal that failed with EPERM.
import { pidAlive as processAlive } from "./dashboard-data.mjs";

const MAX_INTEGRATION_RETRIES = 1;
// Tasks failing back to back point at a shared cause — a broken baseline, a bad
// dependency — not at the tasks. Stop scheduling rather than marching the rest of
// the plan into the same wall. A single pass resets the count, so unrelated
// failures spread across a long plan never accumulate into a false alarm.
const MAX_CONSECUTIVE_FAILURES = 2;
export const DEFAULT_BASELINE_TIMEOUT_MS = 10 * 60_000;
export const BASELINE_HEARTBEAT_MS = GATE_HEARTBEAT_MS;

// Disk a lane is expected to need, and the free space below which a run is
// refused outright (#144). Both are config (`diskPerLaneBytes`,
// `diskFloorBytes`). The per-lane default suits a Node project with linked
// `node_modules`; a stack whose lanes each build their own target dir sets it
// from `du -sh` of one (atlas's Rust target measured 14 GB).
export const DEFAULT_DISK_PER_LANE_BYTES = 2 * 1024 ** 3;
export const DEFAULT_DISK_FLOOR_BYTES = 1024 ** 3;

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Is there room to run? Pure: the caller measures, this decides.
 *
 * Fail direction: a warning below `maxParallel × perLane`, because the estimate
 * is rough and a run that would have fit must not be refused on a guess; a
 * refusal only below the floor, where `npm ci` and the state write itself start
 * failing with ENOSPC — three epics died exactly there (#865, #874). A free
 * space that cannot be measured is `ok`: a missing statfs must not block a run.
 */
export const diskPreflight = ({ freeBytes, maxParallel, perLaneBytes, floorBytes, path }) => {
  if (!Number.isFinite(freeBytes)) return { level: "ok", line: null };
  const needed = maxParallel * perLaneBytes;
  if (freeBytes < floorBytes)
    return {
      level: "refuse",
      line: `disk: ${gib(freeBytes)} free on ${path}, below the ${gib(floorBytes)} floor (diskFloorBytes). Free space, then rerun; no baseline was run.`,
    };
  if (freeBytes < needed)
    return {
      level: "warn",
      line: `disk: ${gib(freeBytes)} free on ${path}, below maxParallel ${maxParallel} × ${gib(perLaneBytes)} per lane (diskPerLaneBytes) = ${gib(needed)}. Lanes may fail with ENOSPC; continuing.`,
    };
  return { level: "ok", line: null };
};

/**
 * The two disk keys as numbers, or the refusal that names the bad one. A value
 * written as `14G` is `NaN`, and `NaN` comparisons are all false, so the check
 * used to pass silently with the guard switched off. Fail direction: closed. A
 * typo in a key that exists only to stop a run is not a reason to run.
 */
export const diskConfig = (config) => {
  const read = (key, fallback) => {
    const value = config?.[key];
    if (value === undefined || value === null) return fallback;
    const bytes = Number(value);
    return Number.isFinite(bytes) && bytes >= 0 && String(value).trim() !== "" ? bytes : null;
  };
  const perLaneBytes = read("diskPerLaneBytes", DEFAULT_DISK_PER_LANE_BYTES);
  const floorBytes = read("diskFloorBytes", DEFAULT_DISK_FLOOR_BYTES);
  const bad = perLaneBytes === null ? "diskPerLaneBytes" : floorBytes === null ? "diskFloorBytes" : null;
  return bad
    ? { error: `${bad} must be a number of bytes (e.g. 15000000000), not ${JSON.stringify(config[bad])}.` }
    : { perLaneBytes, floorBytes };
};

/**
 * The disk preflight for `root` (#144): a refusal, a warning line, or neither.
 * One implementation for `runAuto` and `afk preflight` (#180), so they cannot drift.
 */
export const diskVerdict = ({ root, config, freeDisk = freeDiskBytes }) => {
  const path = worktreeRoot(root);
  const sizes = diskConfig(config);
  return sizes.error
    ? { level: "refuse", line: `disk: ${sizes.error}` }
    : diskPreflight({
        freeBytes: freeDisk(path),
        maxParallel: Math.max(1, Number(config.maxParallel) || 1),
        perLaneBytes: sizes.perLaneBytes,
        floorBytes: sizes.floorBytes,
        path,
      });
};

/** `config` with the runtime a run uses: the flag, then `agent.runtime`, then direct. */
export const withRuntime = (config, runtime) => ({
  ...config,
  agent: { ...(config.agent ?? {}), runtime: runtime || config.agent?.runtime || "direct" },
});

/** Free bytes on the volume holding `path`, or its nearest existing ancestor. NaN if unmeasurable. */
export const freeDiskBytes = (path) => {
  let probe = resolve(path);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const stats = statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.NaN;
  }
};

/**
 * Did this throw come from a full disk? `code` when node raised it itself; the
 * OS's own "no space left on device" text when it came through a child's stderr
 * (`npm ci` in a bootstrap). Not a bare `ENOSPC` anywhere in the text: a check
 * whose output merely names it (a test called "handles ENOSPC") would turn a
 * config fault every lane shares into one quiet lane failure.
 */
export const isDiskFull = (error) =>
  error?.code === "ENOSPC" || /no space left on device/i.test(String(error?.message ?? error ?? ""));

/** The line of a disk-full error worth logging: the one that names the disk, not the command that ran. */
const diskFullLine = (error) => {
  const lines = String(error?.message ?? error ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /no space left on device/i.test(line)) ?? lines[0] ?? "ENOSPC";
};

/**
 * Write one `removeTaskWorktree` result onto a task's runtime record. The one
 * place the three cleanup sites (integration, the restart sweep, the retry
 * below) record it, so they cannot drift apart again.
 */
export const recordCleanup = (taskRuntime, cleanup) => {
  taskRuntime.worktreeRemoved = cleanup.removed !== false;
  taskRuntime.branchDeleted = cleanup.branchDeleted;
  if (cleanup.warning) taskRuntime.cleanupWarning = cleanup.warning;
  else delete taskRuntime.cleanupWarning;
};

/**
 * Finish the cleanup of every `passed` task whose worktree removal did not take
 * (#144). `removeTaskWorktree` no longer throws after a merge, so a failed
 * removal is recorded as `worktreeRemoved: false` plus a `cleanupWarning` and
 * retried here on the next start. The worktree-list sweep in `runAuto` only sees
 * lanes git still lists; one whose registration was pruned while its directory
 * survived is visible only through state. Returns what it retried and what it
 * refused.
 *
 * `skip` is the ids the sweep already handled this start, so one restart never
 * runs a lane's cleanup (and its `finish` hook) twice. A branch that still
 * exists and is NOT merged into `baseBranch` is left alone, the same guard the
 * sweep applies: `passed` in state with work ahead of base is a contradiction a
 * human resolves, and `rm -rf` would take any uncommitted file in that lane with
 * it. Fail direction: closed, a leftover directory over lost work.
 */
export const retryPassedCleanup = ({ state, root, baseBranch = "main", setup = null, skip = new Set(), remove = removeTaskWorktree }) => {
  const retried = [];
  const refused = [];
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    if (task?.lifecycle !== "passed" || task.worktreeRemoved === true || !task.branch || skip.has(id)) continue;
    // A branch check git could not answer is not "gone": that reading skipped
    // the ancestry check and rm -rf'd the lane. Unknown leaves it (closed).
    const known = branchState(root, task.branch);
    const merged = known === "absent"
      || (known === "present"
        && run(`git merge-base --is-ancestor ${shellQuote(task.branch)} ${shellQuote(baseBranch)}`, { cwd: root }).status === 0);
    if (!merged) {
      refused.push({ id, branch: task.branch, reason: known === "unknown" ? "git could not say whether it exists" : `it is not merged into ${baseBranch}` });
      continue;
    }
    const cleanup = remove({ root, id, branch: task.branch, setup });
    recordCleanup(task, cleanup);
    retried.push({ id, ...cleanup });
  }
  return { retried, refused };
};

export const runBaselineChecks = async ({
  commands,
  cwd,
  timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS,
  heartbeatMs = BASELINE_HEARTBEAT_MS,
  say = console.log,
  // The same chain runs at two moments — before the first lane, and over the
  // closeout fix pass's commit — and a heartbeat saying "baseline" during the
  // second sends the reader to the wrong end of the run.
  label = "baseline check",
  // (#176 W3) A reason to skip `command`, or null to run it. Only the start's
  // baseline passes one; the closeout fix gate runs every check.
  skip = () => null,
}) => {
  const skipped = [];
  // Every command that ran, with its timing, for the gate event (#181).
  const ran = [];
  for (const command of commands) {
    const reason = skip(command);
    if (reason) {
      // The lane skip's record shape: `code: null`, never 0 (`checkFailed`).
      skipped.push({ command, skipped: true, code: null, reason });
      say(`AUTO: ${label} skipped: ${command} — ${reason}.`);
      continue;
    }
    const started = Date.now();
    const heartbeat = setInterval(() => {
      say(`AUTO: ${label} still running after ${Math.ceil((Date.now() - started) / 1000)}s: ${command}`);
    }, heartbeatMs);
    heartbeat.unref?.();
    let result;
    try {
      result = await runAsync(command, { cwd, timeout: timeoutMs });
    } finally {
      clearInterval(heartbeat);
    }
    ran.push(checkResult(command, result));
    if (result.status !== 0) return { ok: false, command, result, skipped, ran };
  }
  return { ok: true, skipped, ran };
};

/**
 * The paths the baseline skip treats as changing nothing a check reads (#176
 * W2): the runner's status commits, plus the paths its own closeout sweep
 * deletes (`ARTEFACT_PREFIXES`, `.agents/evidence/` among them). The sweep lands
 * after the fix gate went green, so without this it defeated the skip on every
 * relaunch after a close.
 *
 * A separate predicate, NOT a wider `isStatusFlushPath`: that one also decides
 * whether a branch carries "no work" and may be deleted (`branchWorkAheadOf` in
 * wave.mjs) and whether evidence is stale (`markStaleEvidence` in verifier.mjs),
 * and an evidence-only branch is somebody's work.
 */
export const isBaselineInertPath = (file) =>
  isStatusFlushPath(file) || ARTEFACT_PREFIXES.some((prefix) => file.startsWith(prefix));

/**
 * Why a baseline at `head` may skip its Rust checks, or null to run them (#176
 * W3). Only when the diff from `greenHead` — the head the same command list last
 * went green at — names no Rust-relevant path (`baselineRustRelevant`). Fails
 * toward running: no green head, a diff git could not produce, or an empty one.
 */
export const baselineRustSkipReason = (root, greenHead, head) => {
  if (!greenHead || !head) return null;
  const diff = run(`git diff --no-renames --name-only ${shellQuote(greenHead)} ${shellQuote(head)}`, { cwd: root });
  if (diff.status !== 0) return null;
  const changed = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!changed.length) return null;
  const scriptsAt = (sha) => {
    const shown = run(`git show ${shellQuote(`${sha}:package.json`)}`, { cwd: root });
    if (shown.status !== 0) return null;
    try {
      return JSON.parse(shown.stdout).scripts ?? {};
    } catch {
      return null;
    }
  };
  // `package.json` absent at both ends is a project with no scripts to name.
  const scriptsAfter = scriptsAt(head) ?? (changed.includes("package.json") ? null : {});
  const scriptsBefore = changed.includes("package.json") ? scriptsAt(greenHead) : scriptsAfter;
  return baselineRustRelevant({ changed, scriptsBefore, scriptsAfter })
    ? null
    : `no Rust-relevant change since the green baseline at ${greenHead.slice(0, 12)}`;
};

/**
 * The task ids whose integration merges are all that lie between `recorded`
 * and `head` besides `inert`-only commits, or null when anything else does
 * (#223). `merges` maps a passed task's `integratedHead` to its id. Walks the
 * first-parent line, so a task branch's own commits ride in under its merge.
 * Fails closed, toward running the baseline: no sha, `recorded` not on
 * `head`'s first-parent line, a git call that failed, a merge no passed task
 * recorded, or no merge at all (that case is `onlyStatusFlushSince`'s).
 */
export const onlyIntegratedMergesSince = (root, recorded, head, merges, inert = isBaselineInertPath, exec = run) => {
  if (!recorded || !head || recorded === head || !merges?.size) return null;
  const listed = exec(`git rev-list --first-parent ${shellQuote(`${recorded}..${head}`)}`, { cwd: root });
  if (listed.status !== 0) return null;
  const commits = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!commits.length) return null;
  const parent = exec(`git rev-parse ${shellQuote(`${commits.at(-1)}^1`)}`, { cwd: root });
  if (parent.status !== 0 || parent.stdout.trim() !== recorded) return null;
  const tasks = [];
  for (const sha of commits) {
    if (merges.has(sha)) { tasks.push(merges.get(sha)); continue; }
    const files = exec(`git diff-tree --no-commit-id --no-renames --name-only -r -m --first-parent ${shellQuote(sha)}`, { cwd: root });
    if (files.status !== 0) return null;
    const paths = files.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!paths.length || !paths.every(inert)) return null;
  }
  return tasks.length ? tasks.reverse() : null;
};

/**
 * The files the epic's branch changed since it left `epicBase`, repo-relative,
 * or null when git cannot say (#223). Read for a red baseline only, so a
 * timeout in the epic's own test stays a code red. Tries the local base, then
 * `origin/<base>`.
 */
export const epicChangedFiles = (root, epicBase = "main") => {
  for (const base of [epicBase, `origin/${epicBase}`]) {
    const forkPoint = run(`git merge-base ${shellQuote(base)} HEAD`, { cwd: root });
    if (forkPoint.status !== 0) continue;
    const diff = run(`git diff --no-renames --name-only ${shellQuote(forkPoint.stdout.trim())} HEAD`, { cwd: root });
    if (diff.status === 0) return diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return null;
};

// `onlyStatusFlushSince` moved to scripts/lib.mjs (#188) so the merge guardrails
// share the review-at-head test with `--accept`; re-exported for its callers.
export { onlyStatusFlushSince };

/**
 * May this start skip the baseline? Only when the last green baseline ran at
 * this head — or at a commit the head differs from only by the runner's status
 * commits (`isCurrent`, `onlyStatusFlushSince` in `runAuto`) — with this same
 * command list, in order. Anything else runs it: no record (a cold start), no
 * sha (not a git checkout), a real commit since, or a changed check list. Fails
 * toward running the checks, which costs minutes; skipping wrongly would start
 * lanes on a base nobody verified (#145).
 */
export const sameGreenBaseline = (record, { headSha: sha, commands }, isCurrent = (a, b) => a === b) =>
  Boolean(record && sha && record.headSha && isCurrent(record.headSha, sha))
  && JSON.stringify(record.commands ?? null) === JSON.stringify(commands);

/**
 * Should the breaker trip, and what should it blame? Pure, and exported only so
 * it can be tested — the counters themselves live in a closure inside `runAuto`.
 *
 * Three ways to stop, checked in that order:
 *
 *   cluster   every recent failure is infra-shaped (`looksLikeInfra`) — a dead
 *             login, so the tickets are left unmarked
 *   harness   MAX_CONSECUTIVE_FAILURES lanes never reached the API, whatever
 *             else failed alongside them
 *   tasks     MAX_CONSECUTIVE_FAILURES lanes failed having done real work
 *
 * `harness` is why a mixed run cannot burn forever. `looksLikeInfra` is
 * all-or-nothing, so one genuine failure early makes it false for the rest of
 * the run; before this counter existed, the dead lanes after it advanced NO
 * counter at all and neither branch could ever fire. Now every terminal failure
 * advances exactly one of the two counters and neither is ever decremented
 * short of a pass, so any unbroken run of failures reaches a threshold within
 * 2 * MAX_CONSECUTIVE_FAILURES - 1 failures.
 */
export const breakerVerdict = ({ recentFailures, consecutiveFailures, infraFailures }) => {
  if (recentFailures.length < MAX_CONSECUTIVE_FAILURES) return null;
  if (looksLikeInfra(recentFailures)) return { verdict: "infra", kind: "cluster" };
  if (infraFailures >= MAX_CONSECUTIVE_FAILURES) return { verdict: "infra", kind: "harness" };
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { verdict: "tasks", kind: "tasks" };
  return null;
};

// A builder killed at the agent deadline after doing real work is not the same
// event as one that got the ticket wrong. Return the operator-facing facts — the
// configured deadline, the elapsed time, tokens and files — so the failure reads
// as "ran out of clock, raise agent.timeoutMs", not "the ticket is broken" (#73).
// null for anything that is not a productive timeout, so the caller can gate on it.
export const timeoutOutcome = (verification, timeoutMs) => {
  if (!timedOutWithWork(verification)) return null;
  // A Codex lane in Herdr reports no token usage: unknown, never zero.
  const tokens = verification.tokens;
  const tokenLine = tokens && [tokens.input, tokens.output].every(Number.isFinite)
    ? `spent ${tokens.input + tokens.output} tokens in+out`
    : "token usage unknown";
  const files = verification.producedFiles?.length ?? 0;
  return {
    timedOut: true,
    note: `hit the ${timeoutMs}ms agent deadline at ${verification.durationMs ?? "?"}ms having produced ${files} file${files === 1 ? "" : "s"} and ${tokenLine} — killed by the clock, not a ticket defect. Raise agent.timeoutMs if this recurs.`,
  };
};

const LIMIT_FALLBACK_MS = 5 * 60_000;
const LIMIT_MAX_SLEEP_MS = 20 * 60_000;
const LIMIT_TOTAL_MAX_MS = 12 * 60 * 60_000;

function compactVerification(verification) {
  return {
    ...verification,
    checks: (verification.checks ?? []).map((check) => ({
      ...check,
      ...(typeof check.output === "string"
        ? { output: check.output.slice(-4000) }
        : {}),
    })),
  };
}

// Ids arrive from JSON/YAML/CLI, where `204` and `"204"` are both plausible and
// only one of them matches an object key in `.afk/state.json`. One normalisation
// at the boundary, and the rest of the runner may assume strings.
//
// The spec's optional fields become mandatory here, for the same reason. The
// epic block omits `checks` when the task wants the default gate and never
// authors `allowedPaths` at all, and every consumer used to guess for itself:
// worker.mjs called `task.checks.join()` and threw, while integrate.mjs's
// `task.checks ?? []` ran the POST-MERGE gate over an empty command list and
// merged silently. The crash was the safe half of that bug. Resolve both once,
// here, so no consumer downstream has a default left to get wrong.
//
// `allowedPaths` defaults to `['**']`, not `[]`: scope is advisory and repo-wide
// in v1 (docs/epic-schema.md), and `pathAllowed(file, [])` is false for every
// file, which would report all work out-of-scope — noise wearing the costume of
// safety.
export const normalizeDag = (dag, config = {}) => ({
  epic: dag.epic ?? null,
  branch: dag.branch ?? null,
  tasks: (dag.tasks ?? []).map((task) => {
    const id = normalizeId(task.id);
    // Copied, not aliased: without the spread every defaulted task shares ONE
    // array with .afk-setup/config.yaml, so a single downstream mutation would rewrite
    // the stack config and every other task's gate at once.
    const checks = [...(task.checks ?? config.defaultChecks ?? [])];
    // A lane admitted with no checks reaches integration and merges having run
    // nothing. There is no safe way to run it, so refuse to admit it — the
    // house rule that `loadConfig` follows when .afk-setup/config.yaml is missing.
    if (!checks.length) {
      throw new Error(
        `Task ${id} has no checks: it narrows none and .afk-setup/config.yaml sets no defaultChecks. `
          + `A task that cannot be gated must not be merged — give it \`checks\`, or set \`defaultChecks\`.`,
      );
    }
    return {
      ...task,
      id,
      dependsOn: (task.dependsOn ?? []).map(normalizeId),
      checks,
      allowedPaths: task.allowedPaths ?? ["**"],
      // `gate: after`. Present only when true, so the shape recorded in
      // .afk/state.json is unchanged for every graph that has no such gate —
      // which is every graph written before this landed.
      ...(task.gateAfter ? { gateAfter: true } : {}),
    };
  }),
});

/**
 * The graph shape, without the specification text.
 *
 * Recorded in `.afk/state.json` so out-of-process readers — `afk status`, the
 * dashboard, the heartbeat, herdr lane naming — can name the tasks of a live
 * run without a manifest file to read. Deliberately shape only: task bodies
 * stay in memory, because a cached local copy of the spec is exactly what
 * docs/epic-schema.md rejects.
 */
const dagShape = (dag) => ({
  epic: dag.epic ?? null,
  branch: dag.branch ?? null,
  tasks: dag.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    dependsOn: task.dependsOn,
    ...(task.humanGated ? { humanGated: true } : {}),
    ...(task.gateAfter ? { gateAfter: true } : {}),
  })),
});

/**
 * Tick the must-fix items the fix pass repaired in this same run.
 *
 * `renderVerifierMarkdown` renders the review as the verifier left it, which is
 * always BEFORE the fixer ran — so without this a closeout posts blockers as
 * unticked to-dos that were repaired a minute earlier. Deferred items are left
 * exactly as they are: they really are still outstanding.
 *
 * Matching is by title, not by id or by position: a fixer item built from a
 * must-fix line carries that line verbatim as its title (`fixerItems` in
 * scripts/fixer.mjs), and a title survives the ids being renumbered by dedup.
 * Anything absent, off-shape or from a fix pass that fell over reconciles to
 * nothing and the markdown is returned untouched.
 */
const tickFixedMustFix = (markdown, fixReport) => {
  const fixed = new Map();
  for (const entry of Array.isArray(fixReport?.fixed) ? fixReport.fixed : []) {
    if (!entry || typeof entry.title !== "string") continue;
    // Titles AND aliases: dedup merges a must-fix line with the finding that
    // raised the same defect, and the displaced titles ride along as `aliases`
    // (scripts/fixer.mjs). An entry from an older report has none, and works.
    for (const key of [entry.title, ...(Array.isArray(entry.aliases) ? entry.aliases : [])])
      if (typeof key === "string" && !fixed.has(key)) fixed.set(key, entry);
  }
  if (!fixed.size) return markdown;
  return markdown
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- [ ] ")) return line;
      const text = line.slice(6);
      const entry = fixed.get(text);
      if (!entry) return line;
      // The LINE's own text, not the item's title: the two differ when the match
      // was on an alias, and the rendered line is what the human is reading.
      return `- [x] ${text} — fixed in this run${entry.detail ? `: ${entry.detail}` : ""}`;
    })
    .join("\n");
};

/**
 * The epic closeout, rendered in code.
 *
 * docs/epic-schema.md, "Rejected: librarian": the verifier produces a structured
 * report and the RUNNER renders it, because a gate that can write to the thing
 * it gates is honor-system. So this is templating — deterministic, token-free,
 * and pure, which is why it takes the report rather than fetching one.
 *
 * @param {object} dag normalised DAG
 * @param {object} state runtime state, after the close has been recorded
 * @param {object|null} report the verifier's report, or null when it did not run
 * @param {object|null} fixReport the closeout fix pass, or null/omitted when none ran
 */
/**
 * Bound on `state.supervisorLog`. One record per judged event, each a few
 * hundred bytes; a long epic makes tens, so 200 holds every observation of any
 * run seen so far and caps the file at well under a megabyte. Overflow drops
 * the OLDEST and `runAuto` says so — see `appendSupervisorObservation`.
 */
export const SUPERVISOR_LOG_MAX = 200;

/**
 * Append one supervisor observation to the run's log.
 *
 * `state.supervisor` used to be a single object, so each judgment overwrote the
 * last. Epic 62 produced two `salvage` verdicts, one per failed lane, and then
 * an `epic_ended` verdict; the two salvage records were gone before anyone
 * could read them. This is the append-only side of that fix — the caller still
 * writes `state.supervisor` for readers that expect the latest as an object.
 *
 * Returns `dropped` rather than trimming silently: an observation lost to a cap
 * is exactly the kind of thing this fix exists to stop happening quietly.
 *
 * @param {Array|undefined} existing `state.supervisorLog`
 * @param {object|null} record a `supervisorRecord`, or null when there is none
 * @returns {{list: Array, dropped: number}}
 */
export const appendSupervisorObservation = (existing, record, cap = SUPERVISOR_LOG_MAX) => {
  const prior = Array.isArray(existing) ? existing : [];
  if (!record) return { list: prior, dropped: 0 };
  const list = [...prior, record];
  const dropped = Math.max(0, list.length - Math.max(1, cap));
  return { list: dropped ? list.slice(dropped) : list, dropped };
};

/**
 * (#179) Append one gate rerun to `state.gateReruns`, keeping the newest
 * `GATE_RERUNS_MAX`. One entry per rerun: at most one per start for the
 * baseline, one per failed post-merge check otherwise.
 */
export const GATE_RERUNS_MAX = 20;
export const recordGateRerun = (state, entry) => {
  state.gateReruns = [...(state.gateReruns ?? []), entry].slice(-GATE_RERUNS_MAX);
  return entry;
};

/**
 * The salvage block, as plain lines, for the halt message and the closeout.
 * Empty when the supervisor never recommended salvaging anything.
 *
 * A `salvage` recommendation means "this lane's work is worth keeping and a
 * human should look at it". The work is uncommitted in a worktree whose path
 * nobody can guess, so without this the recommendation named evidence that only
 * a manual `git status` in the right directory would ever find. Reporting it is
 * the whole fix: the runner does not commit, integrate or open a PR for work
 * that failed its gate.
 *
 * @param {object} state runtime state
 * @returns {string[]}
 */
export const salvageLines = (state) => {
  const entries = Object.entries(state?.salvage ?? {});
  if (!entries.length) return [];
  return [
    `Salvageable work — the supervisor recommends keeping ${entries.length} failed lane(s).`,
    "Nothing was committed, merged or opened as a PR: the gate failed, so that call is yours.",
    ...entries.flatMap(([taskId, entry]) => [
      `  ${taskId} — ${entry.worktree}`,
      ...(entry.paths?.length
        ? entry.paths.map((path) => `    uncommitted: ${path}`)
        : ["    (nothing uncommitted in the worktree)"]),
      ...(entry.why ? [`    why: ${entry.why}`] : []),
    ]),
  ];
};

/**
 * The three closeout stages, as the first thing a human reads.
 *
 * A closeout is long and its three agents run in sequence, so the interesting
 * failure is almost always "stage N never ran because stage N-1 produced
 * nothing usable" — and that was invisible. Epic #671 (2026-09-18) closed
 * `completed` with a closeout whose verifier returned `unparseable`, whose nine
 * criteria were therefore all `unknown`, and whose fixer consequently never ran
 * at all (`fixerItems` returns `[]` on any status but `ok`). Every one of those
 * facts was somewhere in the document; none was above the fold, and the
 * document opened by saying every task passed and every gate was accepted.
 *
 * So this is a ledger of what actually executed, never a verdict on the code.
 * Each row answers one question: did this stage run, and if it did, what did it
 * leave behind. The `did not run` rows are the ones this exists for — a stage
 * that was skipped reads identically to a stage that found nothing, unless
 * something says so.
 *
 * Pure, and takes the reports rather than reading them, exactly as
 * `renderCloseout` does.
 *
 * @param {object} close `state.epicClose` after the close has been recorded
 * @param {object|null} report the verifier's report, or null when none exists
 * @param {object|null} fixReport the fix pass's report, or null when none ran
 */
/**
 * "4 tasks — 2 passed, 1 failed, 1 blocked", for a `<summary>` line.
 *
 * A collapsed section is only safe if the collapsed state answers the question,
 * so the summary carries the tally the table would have shown.
 */
export const taskTally = (dag, state = {}) => {
  const tasks = dag?.tasks ?? [];
  if (!tasks.length) return "no tasks";
  const counts = new Map();
  for (const task of tasks) {
    const lifecycle = lifecycleOf(task, state);
    counts.set(lifecycle, (counts.get(lifecycle) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([lifecycle, n]) => `${n} ${lifecycle}`);
  return `${tasks.length} task${tasks.length === 1 ? "" : "s"} — ${parts.join(", ")}`;
};

export const renderStageHeader = (close = {}, report = null, fixReport = null) => {
  const row = (stage, mark, result, detail) => `| ${stage} | ${mark} ${result} | ${detail} |`;
  const rows = [];

  // --- 1. Verifier --------------------------------------------------------
  const skipped = report?.skipped?.length ?? 0;
  const gateNote = skipped
    ? `${skipped} gate(s) did not run in the review sandbox`
    : "every declared gate ran";
  if (!report) {
    rows.push(row("1. Verifier", "⛔", "**did not run**", close.verifier?.skipped ?? "no reason recorded"));
  } else if (report.status !== "ok") {
    // The 671 shape. `status` says whether a REPORT was obtained, so a failing
    // status means there is no review here at all — however much prose the
    // document goes on to quote.
    // Unless the prose gave something back (#142): then the fixer row below
    // reports a pass over it, and "nothing below was reviewed" would be the
    // closeout contradicting itself.
    const recovered = report.status === "unparseable"
      ? (report.findings?.length ?? 0) + (report.unwired?.length ?? 0) + (report.seams?.length ?? 0)
      : 0;
    rows.push(row(
      "1. Verifier",
      "❌",
      `**no usable report** (\`${report.status}\`)`,
      `${report.problems?.[0] ?? "the agent returned no structured block"} — `
      + (recovered
        ? `no structured review; ${report.findings?.length ?? 0} finding(s) below were recovered from its prose`
          + ((report.unwired?.length || report.seams?.length) ? ", with the runner's own unwired and seam lists" : "")
        : "nothing below was reviewed"),
    ));
  } else {
    const counts = report.counts ?? verifierReportCounts(report);
    const decision = verifierDecision(report);
    rows.push(row(
      "1. Verifier",
      skipped ? "⚠️" : "✅",
      `\`${decision.recommendation}\``,
      `${counts.criteria.met}/${counts.criteriaTotal} criteria met, ${counts.findingsTotal} finding(s) `
      + `(🔴 ${counts.findings.blocker} blocker), ${counts.mustFix} must-fix — ${gateNote}`,
    ));
  }

  // --- 2. Fixer -----------------------------------------------------------
  // Null is two different events and the reader needs to know which: a review
  // that produced no work list, or a pass that was never attempted.
  if (!fixReport) {
    rows.push(row(
      "2. Fixer",
      "⛔",
      "**did not run**",
      report && report.status !== "ok"
        ? "the review was unusable, so no fix list could be built — every finding on this branch is unexamined"
        : "no fix pass is recorded for this close",
    ));
  } else if (fixReport.status === "nothing_to_do") {
    rows.push(row(
      "2. Fixer",
      "➖",
      "nothing to fix",
      "the review found nothing this pass may change"
      + (fixReport.notQueued ? `; ${fixReport.notQueued} minor finding(s) never queued and still open` : "")
      + (fixReport.unknownNotQueued ? `; ${fixReport.unknownNotQueued} unknown criteria never queued` : ""),
    ));
  } else if (fixReport.status !== "ok") {
    rows.push(row(
      "2. Fixer",
      "❌",
      `**fell over** (\`${fixReport.status}\`)`,
      `${fixReport.problems?.[0] ?? "the pass did not complete"} — all ${fixReport.items?.length ?? 0} item(s) left for you`,
    ));
  } else {
    const fixed = partitionFixed(fixReport);
    const { open, noOp, duplicates } = partitionDeferred(fixReport);
    const total = fixReport.items?.length ?? 0;
    const restating = fixed.duplicates.length + duplicates.length;
    const extra = [
      noOp.length ? `${noOp.length} needed no change` : null,
      restating ? `${restating} restating another item` : null,
      fixReport.notQueued ? `${fixReport.notQueued} minor finding(s) never queued` : null,
      fixReport.unknownNotQueued ? `${fixReport.unknownNotQueued} unknown criteria never queued` : null,
    ].filter(Boolean);
    rows.push(row(
      "2. Fixer",
      open.length ? "⚠️" : "✅",
      `fixed ${fixed.distinct.length} of ${total}`,
      `**${open.length} left for you**${extra.length ? ` (${extra.join(", ")})` : ""}`,
    ));
  }

  // --- 3. Fix gate --------------------------------------------------------
  // The gate only re-runs when the fix pass moved HEAD, so `no_commit` is the
  // common case and is not a failure — but it does mean the tip carries no
  // check run of its own, which is the thing worth saying out loud.
  const gate = close.fixGate ?? null;
  if (!gate) {
    rows.push(row("3. Fix gate", "⛔", "**did not run**", "no fix pass reached it"));
  } else if (gate.status === "no_commit") {
    rows.push(row(
      "3. Fix gate",
      "➖",
      "no commit to gate",
      "the fix pass changed nothing, so the branch tip is exactly what the lanes' own gates covered",
    ));
  } else if (gate.status === "passed") {
    // No fix commit, but `integrationChecks` is lighter, so the tip was gated anyway.
    const over = gate.fixSha && gate.fixSha === gate.headBefore ? "the tip" : "the fix commit";
    rows.push(row(
      "3. Fix gate",
      "✅",
      "passed",
      `${gate.checks?.length ?? 0} check(s) re-run over ${over} \`${(gate.fixSha ?? "").slice(0, 8)}\``,
    ));
  } else {
    rows.push(row(
      "3. Fix gate",
      "❌",
      `**${gate.status}**`,
      `${gate.timedOut ? "timed out on" : "failed"} \`${gate.failingCommand ?? "?"}\` — advisory, `
      + "the epic closed anyway; the branch tip is unverified",
    ));
  }

  return [
    "## Closeout stages",
    "",
    "| Stage | Result | Detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "_All three are advisory. None of them can mark a task passed, change the outcome above, or halt the run._",
  ].join("\n");
};

// Neither report is defaulted: a nullish one is handled below, and an arity of 4
// is what tells a caller (and a probe) that this renders a RECONCILED closeout.
export const renderCloseout = (dag, state, rawReport, fixReport) => {
  const close = state.epicClose ?? {};
  // One report for the whole document: a check-only criterion the fix pass
  // found met is met in the stage header AND the criteria table (#143), or the
  // same closeout says 0/1 in one place and 1/1 in the other.
  const report = withCheckedCriteria(rawReport, fixReport);
  const label = dag.epic?.title ?? dag.epic?.id ?? state.epic ?? "epic";
  const mark = { passed: "✅", "no-op": "✅", failed: "❌", integration_failed: "❌", blocked: "⛔", [AWAITING_ACCEPTANCE]: "⏳" };
  const gates = gateAfterTasks(dag);
  const lines = [
    `# Epic closeout — ${label}`,
    "",
    `**Outcome: \`${close.outcome ?? "?"}\`** — ${close.reason ?? ""}`.trim(),
    "",
    `Branch \`${dag.branch ?? state.branch ?? "?"}\`. Closed ${close.closedAt ?? "?"}.`,
    "",
    // What executed, before anything it concluded. See `renderStageHeader`.
    renderStageHeader(close, report, fixReport),
    "",
    "## Tasks",
    "",
    // The graph REPLACES the table as the default view rather than joining it:
    // a picture added above a table makes a long document longer. What the
    // picture carries and the table cannot is which failure blocked which
    // sibling — #665's 666 and 669 were two unremarkable rows and one edge.
    renderTaskGraphSection(dag, state),
    "",
    details({
      summary: `Task table — ${taskTally(dag, state)}`,
      body: [
        "| | ID | Task | Status | Depends on |",
        "| --- | --- | --- | --- | --- |",
        ...(dag.tasks ?? []).map((task) => {
          const lifecycle = lifecycleOf(task, state);
          return `| ${mark[lifecycle] ?? "·"} | ${task.id} | ${(task.title ?? "").replace(/\|/g, "\\|")}${task.humanGated ? " 🔒" : ""}${task.gateAfter ? " 🧾" : ""} | ${lifecycle} | ${(task.dependsOn ?? []).join(", ") || "—"} |`;
        }),
      ].join("\n"),
    }),
  ];
  if (gates.length) {
    lines.push(
      "",
      "## Human acceptance (`gate: after`)",
      "",
      ...gates.map((task) => {
        const accepted = close.acceptances?.[task.id];
        const delegated = state.delegations?.[task.id];
        if (accepted) {
          const by = accepted.by === "delegate" ? ` by the delegate under "${accepted.condition}"` : "";
          return `- ✅ ${task.id} accepted ${accepted.at}${by}${accepted.note ? ` — ${accepted.note}` : ""}`;
        }
        return delegated
          ? `- ⏳ ${task.id} delegated, waiting on ${(close.delegateWaits?.[task.id]?.waitingOn ?? ["an evaluation that has not run"]).join(", ")}`
          : `- ⏳ ${task.id} was never accepted`;
      }),
    );
  }
  // Before the verifier block: a human reading a closeout for what to do next
  // must not have to scroll past a review to learn that finished work is
  // sitting in a worktree nobody will visit.
  const salvage = salvageLines(state);
  if (salvage.length) {
    const [headline, caveat, ...rest] = salvage;
    lines.push("", "## Salvageable work", "", headline, "", caveat, "", "```", ...rest, "```");
  }
  // Same reason, one step on: a task that never passed had its criteria kept
  // out of the fix pass, so its retained branch is named here (#145).
  const unpassed = renderUnpassedLanes(close.unpassedLanes);
  if (unpassed) lines.push("", unpassed);
  // (#215) Defects caught before the closeout, each with its lesson or
  // `Lesson: missing`, beside the fixer's own findings.
  const defects = renderMidRunDefects(state);
  if (defects) lines.push("", defects);
  lines.push("", report
    // A check-only criterion the fix pass found met renders as met (#143).
    ? tickFixedMustFix(renderVerifierMarkdown(report), fixReport)
    : `## Verifier\n\n_Did not run: ${close.verifier?.skipped ?? "no reason recorded"}._`);
  // One line so the reader knows a fix pass happened at all — the deferrals and
  // what each change was live in the PR run account, not here.
  if (report && fixReport?.status === "ok" && Array.isArray(fixReport.fixed)) {
    const total = fixReport.items?.length ?? fixReport.fixed.length + (fixReport.deferred?.length ?? 0);
    // Every number here comes from fixer.mjs's own partitions, never from a
    // length counted locally: `renderFixerOutcome` posts the same numbers from
    // the same report minutes later, and each time this line recomputed one it
    // drifted — no-ops made it say "4 left for you" against "1", and
    // `fixed.length` counted five restatements of two defects as five fixes.
    const fixed = partitionFixed(fixReport);
    const { open, duplicates } = partitionDeferred(fixReport);
    // Restatements from both branches are one number, as in `renderFixerOutcome`.
    const restating = fixed.duplicates.length + duplicates.length;
    // Absent on a report from before lessons existed, so that line is unchanged.
    const lessons = lessonCounts(fixReport);
    lines.push(
      "",
      `_Fix pass: ${fixed.distinct.length} of ${total} item(s) fixed in this run; ${open.length} left for you`
      + `${restating ? ` (${restating} restating another item)` : ""}`
      + `${lessons.reported ? `; lessons: ${lessons.rule} rule, ${lessons.standard} standard` : ""}`
      // "0 left for you" is false while findings the pass never queued are open.
      + `${fixReport.notQueued ? `; ${fixReport.notQueued} minor finding(s) never queued and still open` : ""}._`,
    );
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

/**
 * Run a task DAG to completion.
 *
 * `config` is `.afk-setup/config.yaml` (how this stack is verified); `dag` is the spec,
 * held in memory for the lifetime of this call and never written to disk. The
 * lifecycle of every task lives in `.afk/state.json` and nowhere else.
 *
 * Returns the process exit code: 0 when the scheduler drained normally, 1 when
 * it refused to start or halted on a shared cause. An epic that closes
 * `incomplete` or `completed_with_findings` still exits 0: the exit code says
 * whether the RUNNER failed, and findings are content, not a runner fault.
 *
 * `accept` is the human's release of `gate: after` tasks — a list of ids, from
 * the CLI and from nowhere else. `verify` and `commentOnEpic` are the two impure
 * seams of the closeout, injected so the self-tests can close an epic without a
 * live login or a GitHub round-trip (the same seam style as `interactive`).
 */
/**
 * How an operator of each backend logs in, and what the runner calls the thing
 * they log into. One record, because three places used to hardcode `claude`:
 * preflight, the mid-run refresh offer, and the two breaker messages that tell
 * a human why the run stopped. Under `afk-codex` all three named a CLI the
 * operator had not run, which is the failure this ticket exists for — a
 * refusal that names the wrong remedy is worse than one that names none.
 */
export const AUTH_COMMANDS = {
  claude: { cli: "claude", login: "claude auth login", logout: ["auth", "logout"], loginArgs: ["auth", "login"] },
  // `codex login` and `codex logout` are top-level subcommands, not `auth`
  // verbs — `codex auth login` is not a command and would exit 2.
  codex: { cli: "codex", login: "codex login", logout: ["logout"], loginArgs: ["login"] },
};

export const authCommands = (backend = resolveBackend()) => AUTH_COMMANDS[resolveBackend(backend)];

/**
 * The agent record for the preflight auth probe ("Reply with the single word:
 * OK"). It proves a login, nothing else, so on Claude it runs on the smallest
 * model with no skills and no MCP servers: on the project's own model it loaded
 * a full lane context and cost ~60k input tokens per run start. Codex is
 * returned untouched — its probe has no skill listing to shed.
 *
 * Starts on `haiku`; `authProbeAgents` adds the lanes' own model as a retry.
 */
export const authProbeAgent = (agent) => {
  if ((agent.backend ?? "claude") !== "claude") return agent;
  const { reasoningEffort: _effort, ...rest } = agent;
  return { ...rest, model: "haiku", disableSlashCommands: true, settings: JSON.stringify({ autoMemoryEnabled: false }) };
};

/**
 * The probes to try, in order: haiku, then the lanes' configured model with the
 * same slim context. Haiku alone could refuse a valid run whose org allowlist
 * excludes haiku, and tell the operator to log in — the wrong remedy. So a
 * failed haiku probe falls back to the model the lanes will actually use, and
 * the run proceeds if either answers. The gap left open (haiku answers, the
 * lane model would not) fails at the first builder in seconds, which the infra
 * breaker (`looksLikeInfra`) already reports as the environment, not the
 * tickets; closing it would mean probing the lane model on every start.
 */
export const authProbeAgents = (agent) => {
  const first = authProbeAgent(agent);
  if (first === agent || !agent.model || agent.model === first.model) return [first];
  return [first, { ...first, model: agent.model }];
};

// What a CLI prints when the login itself is the problem.
const AUTH_ERROR = /\b(?:401|unauthori[sz]ed|not (?:logged|signed) in|log ?in|authenticat\w*|invalid api key|oauth|token (?:has )?expired|credentials?)\b/i;

/**
 * The preflight blocker for a set of failed probes, or null if one passed.
 * "not authenticated" (whose remedy is the login command) only when a probe's
 * output says so; any other failure is reported as itself, pointing at the
 * probe stream, so a model or network fault never sends anyone to log in.
 */
export const authProbeBlocker = (results) => {
  if (results.some((result) => result.ok)) return null;
  if (results.some((result) => AUTH_ERROR.test(result.output ?? ""))) return "not authenticated";
  return "auth probe failed, and not on a login error — read .afk/preflight/auth-probe*.jsonl";
};

/**
 * One preflight blocker, as the operator reads it.
 *
 * Split out of `runAuto` so the remedy is checkable without standing up a run:
 * the whole failure this exists for is `afk-codex` telling an operator to run
 * `claude auth login`, and a string built inline in a 900-line function is a
 * string nothing asserts on.
 */
export const preflightLine = (blocker, backend = resolveBackend()) =>
  blocker === "not authenticated"
    ? `${blocker} — run \`${authCommands(backend).login}\``
    : blocker;

/**
 * The preflight auth probe: true, or the blocker text. Module-level so
 * `runAuto` and `afk preflight` run the same probe. Writes its prompt and
 * streams under `<afkDir>/preflight/`.
 */
export const runAuthProbe = ({ root, afkDir, config }) => {
  const probeDir = resolve(afkDir, "preflight");
  ensureDir(probeDir);
  const promptPath = resolve(probeDir, "auth-probe.md");
  atomicWrite(promptPath, "Reply with the single word: OK\n");
  const results = [];
  for (const [index, agent] of authProbeAgents(agentConfig(config)).entries()) {
    const streamPath = resolve(probeDir, index ? `auth-probe-${agent.model}.jsonl` : "auth-probe.jsonl");
    const command = buildAgentCommand(agent, {
      nodeBin: process.execPath.replace(/\/node$/, ""),
      promptPath,
      streamPath,
    });
    // A live login answers a trivial prompt in seconds; an expired one exits
    // non-zero almost immediately. Bound the wait so a hang cannot stall startup.
    const result = run(command, { cwd: root, timeout: 60_000 });
    let stream = "";
    // The init event lists tools and plugins whose names could match the
    // login pattern; only what came after it can describe the failure.
    try { stream = readFileSync(streamPath, "utf8").split("\n").filter((line) => !line.includes('"type":"system"')).join("\n"); } catch {}
    results.push({ ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${stream}` });
    if (result.status === 0) break;
  }
  return authProbeBlocker(results) ?? true;
};

// A project probe that hangs (a container runtime waiting on a socket) must
// not stall startup forever; a minute is far past any healthy probe.
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * The listeners on a TCP port, by `lsof`: `[{ pid, command }]`, or a string
 * when lsof could not answer. lsof exits 1 with no output for a free port;
 * anything else unparseable is reported, never read as free (fail closed —
 * see `portBlockers` in scheduler.mjs).
 */
export const lsofPortHolders = (port) => {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8" });
  if (result.error) return `lsof did not run: ${result.error.message}`;
  const holders = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) holders.push({ pid: Number(line.slice(1)), command: "" });
    else if (line.startsWith("c") && holders.length) holders[holders.length - 1].command = line.slice(1);
  }
  if (holders.length) return holders;
  if (result.status === 0 || result.status === 1) return [];
  return `lsof exited ${result.status}: ${(result.stderr ?? "").trim().split("\n").pop()}`;
};

/**
 * The real seams for the host half of `preflightBlockers`. `herdrStatus` is
 * injectable because `herdr status server` exits 0 even when the server is
 * down — the blocker reads its `status:` line, not its exit code.
 */
export const hostProbes = ({ root, herdrStatus = null, portHolders = lsofPortHolders }) => ({
  runCommand: (command) => run(command, { cwd: root, timeout: PROBE_TIMEOUT_MS }),
  herdrStatus: herdrStatus ?? (() => run("herdr status server", { cwd: root, timeout: 10_000 })),
  portHolders,
  infisicalProbe: () => run("infisical user get token --silent", { cwd: root, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }),
  macAutomationProbe: () => macAutomationSession({ root }),
  // Only a checkout with a GitHub origin talks to GitHub through gh.
  ghAuthProbe: /github\.com/.test(run("git remote get-url origin", { cwd: root }).stdout ?? "")
    ? () => run("gh auth status", { cwd: root, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] })
    : null,
});

/** The base checkout's package.json, or null when it has none or it is not JSON. */
export const readPackageJson = (root) => {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

/**
 * A short macOS agent-device session (#210): open TextEdit, take one
 * interactive snapshot, close. Each step carries a node-side timeout (macOS
 * has no `timeout` binary), so an unanswered permission prompt fails rather
 * than hangs. Pass = the snapshot printed at least one `@e` ref.
 */
export const macAutomationSession = ({ root, exec = run, stepMs = 30_000 } = {}) => {
  const step = (command) => exec(command, { cwd: root, timeout: stepMs, stdio: ["ignore", "pipe", "pipe"] });
  let launched = false;
  try {
    // Quit TextEdit afterwards only if the probe launched it: The owner's own
    // windows are not ours to close.
    launched = step("pgrep -x TextEdit").status !== 0;
    const open = step("agent-device open TextEdit --platform macos");
    if (open.status !== 0)
      return { ok: false, ...open, deviceInUse: /DEVICE_IN_USE/.test(`${open.stdout ?? ""}${open.stderr ?? ""}`) };
    const snap = step("agent-device snapshot -i --platform macos");
    return { ...snap, ok: snap.status === 0 && /@e\d+/.test(snap.stdout ?? "") };
  } finally {
    step("agent-device close --platform macos");
    if (launched) step("osascript -e 'quit app \"TextEdit\"'");
  }
};

/**
 * Codex plus `runtime: herdr` is refused, and it is refused EARLY.
 *
 * The herdr runtime drives an INTERACTIVE agent in a pane: it types a pointer
 * prompt, watches the scrollback for a phase walk, and reads the lane's report
 * out of the pane. `codex exec --json` is a non-interactive pipe with none of
 * that — it has no pane to type into and no scrollback to read — so a lane
 * dispatched this way produces no report at all, minutes later, with nothing
 * anywhere saying why. `/Users/dev/code/projects/afk-codex` commit
 * ca06f8d is the run that established this.
 *
 * Returns the refusal string, or null when the combination is fine. A caller
 * that gets a string must print it and exit non-zero BEFORE it spends a model
 * call — that is the whole value of the check.
 */
export const herdrRefusal = ({ backend = resolveBackend(), runtime, config = {} } = {}) => {
  const resolved = resolveBackend(backend);
  const effective = runtime || config.agent?.runtime || "direct";
  if (resolved !== "codex" || effective !== "herdr") return null;
  return (
    "`afk-codex` supports only the direct runtime; `runtime: herdr` is refused."
    + " The herdr runtime drives an INTERACTIVE agent in a pane and reads the lane's"
    + " report out of that pane's scrollback. `codex exec --json` is a non-interactive"
    + " pipe with no pane and no scrollback, so every lane would produce no report at all."
    + " Drop --runtime=herdr (or agent.runtime in .afk-setup/config.yaml) to run Codex on"
    + " the direct runtime, or run this epic with `afk` if you want herdr."
  );
};

/**
 * Keep the integrator's model check on the task only while its LATEST attempt
 * switched, so the PR body (`renderModelSwitches`) names it. Every attempt
 * replaces the record: a clean or fast-forward retry clears an earlier switch,
 * because the merge that landed is the one the body describes.
 */
export const recordIntegratorModelCheck = (taskRuntime, check) => {
  if (check?.status === "switched") taskRuntime.integratorModelCheck = check;
  else delete taskRuntime.integratorModelCheck;
};

/**
 * Whether a lane or integration gate went red on Infisical's "No valid login
 * session found" (#210). Read from every check's output, first runs included.
 */
export const gateLostInfisicalSession = (verification) =>
  [...(verification?.checks ?? []).map((check) => check.output),
    ...(verification?.checkReruns ?? []).map((rerun) => rerun.firstOutput)]
    .some((output) => infisicalSessionMissing(output));

/**
 * Why `afk close --redo` must not run now, or null when it may (#213).
 *
 * FAIL DIRECTION: CLOSED. A redo rewrites `close.verifier` and the fixer
 * report, which `afk merge` judges; one that raced a live lane or gate would
 * record a review of a head that is still moving. Refusing costs a relaunch.
 *
 * @returns {string|null}
 */
export const redoCloseRefusal = ({ root, state, gateHolder = readGateHolder(), alive = processAlive }) => {
  const close = state?.epicClose ?? null;
  if (close?.lifecycle !== "closed") {
    return `the epic is not closed (lifecycle ${JSON.stringify(close?.lifecycle ?? null)}); there is no closeout to redo. Run \`afk epic\` to close it.`;
  }
  if (existsSync(resolve(root, ".afk", "orchestrator.lock"))) {
    return "a run holds .afk/orchestrator.lock, so lanes may still be running. Stop it first.";
  }
  const lanes = Object.entries(state.tasks ?? {})
    .filter(([, task]) => ["running", "ready_to_integrate", "integrating"].includes(task?.lifecycle))
    .map(([id]) => id);
  if (lanes.length) return `lane(s) ${lanes.join(", ")} are still in flight. Let them finish first.`;
  if (gateHolder && resolve(String(gateHolder.project ?? "")) === resolve(root) && alive(gateHolder.pid)) {
    return `a ${gateHolder.kind ?? "gate"} holds the gate lock for this project (pid ${gateHolder.pid}). Wait for it to finish.`;
  }
  if (existsSync(gateWaitPath(root))) {
    return "a gate is waiting for the gate lock in this project (.afk/gate-wait.json). Wait for it to finish.";
  }
  return null;
};

export const runAuto = async ({
  config,
  dag,
  root = process.cwd(),
  baseBranch = "main",
  explicitTaskId = null,
  runtime = null,
  refreshAuth = false,
  interactive = process.stdin.isTTY,
  epic = null,
  customInstructions = null,
  // The paths this epic's tickets name, from `epicModifiedPaths` at validate
  // time. Written to state so a concurrently-starting epic can find them — see
  // `liveEpics` in scripts/worktree.mjs. Never read by this run.
  claimedPaths = [],
  accept = [],
  // `--force` beside `--accept`: accept without a closeout review at the
  // branch head. Typed by a person, like `accept` itself.
  acceptForce = false,
  // `--delegated` beside `--accept` (#188): the delegate's acceptance, taken
  // only for a gate delegated at launch and only when every merge guardrail
  // passes. Refused with `--force`: no flag skips a guardrail on this path.
  acceptDelegated = false,
  // `--delegate=<id> --delegate-condition=…` from the launch, as
  // `[{ id, condition, evidence }]`, and `--waive-user-facing=<reason>`.
  // Persisted additively into state, like `customInstructions`.
  delegations = [],
  userFacingWaiver = null,
  // Test seam: the guardrail evaluator. Null means scripts/merge-guards.mjs's.
  mergeGuards = null,
  epicBase = "main",
  // True on a process `afk epic` re-launched after a fatal (#146,
  // scripts/restart.mjs). Only decides whether this run keeps the restart
  // record it inherits; the restart itself is decided outside `runAuto`.
  autoRestarted = false,
  // The stop forecast `afk epic` built with the epic's `stops:` answers, which
  // the DAG does not carry. Only the launch row reads it.
  forecast = null,
  verify = runVerifier,
  // `afk close --redo` (#213): re-run the closeout verifier and the fix pass
  // with its gate at the head of an already-closed epic, keeping the earlier
  // records in `close.redos`. Refused by `redoCloseRefusal`.
  redoClose = false,
  // Test seam for `redoCloseRefusal`: the gate-lock holder. Undefined reads it.
  gateHolder = undefined,
  // The fix pass's agent, injected for the same reason `verify` is: a self-test
  // that closes an epic must be able to produce the fixer's COMMIT — the thing
  // the gate below it is about — without an agent call. Null means the real one.
  fixAgent = null,
  commentOnEpic = null,
  // The path the DAG was read from, when there was one. Only the supervisor's
  // `run` action needs it (`afk run --task=… --dag=…`); `afk epic` hands the
  // DAG over in memory and passes nothing, which correctly makes that one
  // proposal unrenderable rather than wrong.
  dagPath = null,
  // Test seams for #144: the free-space probe the disk preflight reads, and the
  // builder and integrator, so a test can make either throw ENOSPC the way a
  // full disk does mid-record-write without filling a disk.
  freeDisk = freeDiskBytes,
  // Test seams for #223: the 1-minute load a baseline waits under the
  // threshold for, and how often it reads it. Undefined means the real ones.
  hostLoad = undefined,
  quietPollMs = undefined,
  // Test seam for #180: `herdr status server`, which a test cannot stand up.
  // Null means the real one (see `hostProbes`).
  herdrStatus = null,
  // Test seam for #210: the Infisical session probe. Null means the real one
  // (`probeInfisicalSession`), which runs only when a check calls `infisical run`.
  infisicalProbe = null,
  // Test seam for #279: replaces the whole baseline gate, so a test can make it
  // throw. Null means the real one (`runBaselineGate`).
  baselineGate = null,
  // Test seam (#210): replaces the real infisical / agent-device probes.
  preflightProbeOverrides = {},
  builder = runBuilder,
  // Test seam (#292): the Codex quota read a Codex-routed dispatch waits on.
  quotaProbe = () => checkCodexQuota(),
  // Test seams (#294): the tier router's key and transport, and the
  // two-provider quota read a `routine` lane chooses its provider from.
  jevKey = process.env.TYPESAFE_API_KEY,
  jevFetch = (...args) => fetch(...args),
  jevTimeoutMs = JEV_TIMEOUT_MS,
  providerQuotaProbe = () => checkProviderQuotas(),
  integrate = runIntegration,
  // Test seams for the advisory supervisor. `supervisor` is the module (a
  // loader, so a missing or broken module is a null, not a crash) and `notify`
  // is the EXISTING desktop notifier, adapted to (title, message). Neither is
  // ever on the scheduler's critical path — see `observe` below.
  supervisor = null,
  // The supervisor only asks to be heard when it set `wake`, so anything
  // reaching here is by definition worth a sound. `epic_ended` is the one that
  // is good news rather than a problem.
  notify = (title, message, event = null, taskId = null) => notifyDesktop({
    title: "AFK runner",
    subtitle: title,
    message,
    level: event === "epic_ended" ? "success" : "error",
    // The TICKET's group when the opinion is about a ticket, which is the same
    // group the lane's own banner used. A blocked lane says so, and 40s later
    // the supervisor finishes judging that same lane and wants to say it too —
    // both correct, both about #207, and the second one interrupts a human who
    // is already looking. One group makes them one event, and the repeat window
    // in lib.mjs drops the follow-up.
    //
    // A fatal is never "the same thing" as a supervisor opinion: sharing its
    // group let a `gate_reached` banner from minutes earlier dedupe the one
    // notification that says the run is dead (#144).
    group: taskId ? `afk-lane-${taskId}` : event === "orchestrator_fatal" ? "afk-orchestrator-fatal" : "afk-supervisor",
    // The supervisor's own event name IS the policy key, so a supervisor
    // opinion about a blocked lane and the lane's own banner are one filter
    // decision. `wake` only says the supervisor wants to be heard; NOTIFY_ONLY
    // in lib.mjs decides whether that reaches the desktop.
    kind: event ?? "supervisor",
  }),
}) => {
  // --runtime=herdr runs builders as interactive agents in herdr panes. Resolved
  // once here and carried on the IN-MEMORY config. Nothing writes .afk-setup/config.yaml
  // back, so a per-run flag still cannot be persisted into the committed file —
  // which is the property the old `process.env.AFK_RUNTIME` channel existed for.
  //
  // It must NOT be process.env: the runner spawns the project's own checks as
  // child processes, and an exported variable reaches every one of them. This
  // repo's baseline check is its own selftest, whose happy-path test calls
  // runBuilder — under an inherited AFK_RUNTIME=herdr it took the herdr path and
  // failed, so `afk epic --runtime=herdr` could never get past its own baseline.
  // docs/findings.md 3.4 carried that as an unreproducible flake; it was this,
  // and it was deterministic all along.
  // The backstop for `afk auto` invoked directly. `cliEpic` refuses this before
  // the plan review, which is the moment that matters; this one catches the
  // operator who skipped that command, and it still lands before any lane is
  // dispatched.
  {
    const refusal = herdrRefusal({ runtime, config });
    if (refusal) {
      console.error(`AUTO: ${refusal}`);
      return 1;
    }
  }
  let pr;
  let PR_OFF, PR_EACH;
  try {
    const prMod = await import("./pr.mjs");
    PR_OFF = prMod.PR_OFF;
    PR_EACH = prMod.PR_EACH;
    pr = prMod.prMode(config);
  } catch (error) {
    console.error(`AUTO: ${error.message}`);
    return 1;
  }
  config = withRuntime(config, runtime);
  try {
    dag = normalizeDag(dag, config);
  } catch (error) {
    console.error(`AUTO: ${error.message}`);
    return 1;
  }
  explicitTaskId = normalizeId(explicitTaskId);

  const afkDir = resolve(root, ".afk");
  const statePath = resolve(afkDir, "state.json");
  const logPath = resolve(afkDir, "agent-auto.log");
  const dashboardLogPath = resolve(afkDir, "dashboard.log");
  const lockPath = resolve(afkDir, "orchestrator.lock");

  ensureDir(afkDir);
  const say = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
  // One line per role run whose later replies came from a model other than the
  // one its session started on. The builder logs its own (scripts/worker.mjs); every other
  // role's record comes back here. scripts/model-check.mjs.
  const sayModelSwitch = (label, check) => {
    const line = modelSwitchLine(label, check);
    if (line) say(`AUTO: ${line}`);
  };
  // A refusal is an error, so it keeps stderr — but it also ENDS a run, so it
  // has to survive in `agent-auto.log` too. Refusals used to be `console.error`
  // alone: one run died on a config-caused fatal printed to a stdout nobody was
  // capturing, left the log ending on a healthy scheduler line, and was started
  // again three hours later and died identically, because the durable record
  // held no cause to act on.
  // The project's `worktreeSetup.teardown`/`finish` hooks never decide a lane's
  // outcome; a non-zero exit is a log line and nothing else (#109).
  const sayHooks = (taskId, hooks) => {
    for (const line of hookFailureLines(taskId, hooks)) say(`AUTO: ${line}`);
  };
  const refuse = (message) => {
    console.error(message);
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  };
  // Retries after the first builder attempt. Read here, once, so a malformed
  // value refuses the run before a worktree exists rather than at the first
  // failure hours in — and read through `agentConfig` like every other
  // `agent.*` value, so the default lives in one place.
  if (redoClose) {
    let current = null;
    try { current = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
    const why = redoCloseRefusal({ root, state: current, ...(gateHolder !== undefined ? { gateHolder } : {}) });
    if (why) {
      refuse(`AUTO: cannot redo the closeout: ${why}`);
      return 1;
    }
  }
  let maxBuilderRetries;
  try {
    maxBuilderRetries = agentConfig(config).maxBuilderRetries;
  } catch (error) {
    refuse(`AUTO: ${error.message}`);
    return 1;
  }
  const pidAlive = (pid) =>
    Number.isInteger(Number(pid)) &&
    Number(pid) > 0 &&
    run(`kill -0 ${Number(pid)}`).status === 0;
  const runnerAgentAlive = (pid) =>
    pidAlive(pid) &&
    /(^|\s)agent-(merge-)?[^\s]+/.test(
      run(`ps -p ${Number(pid)} -o command=`, { cwd: root }).stdout,
    );
  const loadState = () => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return null;
    }
  };
  const saveState = (state) => {
    state.updatedAt = new Date().toISOString();
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  const initialState = () => ({
    version: 1,
    orchestratorPid: process.pid,
    startedAt: new Date().toISOString(),
    activeWorkers: {},
    integrationQueue: [],
    activeIntegrator: null,
    epicClose: epicCloseRecord(),
    tasks: Object.fromEntries(
      dag.tasks.map((task) => [
        task.id,
        { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 },
      ]),
    ),
  });

  const branchName = run("git branch --show-current", {
    cwd: root,
  }).stdout.trim();
  if (branchName !== baseBranch) {
    refuse(
      `AUTO: must run from the ${baseBranch} checkout; current branch is ${branchName || "(detached)"}.` +
        (branchName ? ` To integrate into this branch instead, pass --base=${branchName}.` : ""),
    );
    return 1;
  }
  if (run("git check-ignore -q .afk/state.json", { cwd: root }).status !== 0) {
    refuse(
      "AUTO: add `.afk/` to this project's .gitignore before running. Runtime state and worktrees must never enter task commits.",
    );
    return 1;
  }
  if (existsSync(lockPath)) {
    const lockedPid = Number(readFileSync(lockPath, "utf8").trim());
    if (pidAlive(lockedPid)) {
      refuse(`AUTO: orchestrator already running (pid ${lockedPid}).`);
      return 1;
    }
    rmSync(lockPath, { force: true });
  }

  // A NEW epic in a directory whose last epic finished.
  //
  // `.afk/state.json` describes one run, and the shape guard below compares the
  // graph in it against the graph being started. Across two different epics
  // that comparison is meaningless: every task of the old epic reads as
  // "removed" and every task of the new one as "added", so a finished epic
  // refused the next one with a message about a mid-run change that never
  // happened, and told the operator to delete the state file by hand. The id is
  // what distinguishes the two cases, and it is already in the file.
  {
    const previous = loadState();
    const previousEpic = normalizeId(previous?.epic?.id ?? previous?.epic ?? null);
    const startingEpic = normalizeId(epic?.id ?? dag.epic?.id ?? null);
    if (previous && previousEpic && startingEpic && previousEpic !== startingEpic) {
      const { archiveBlocker, archiveEpic } = await import("./archive.mjs");
      const blocker = archiveBlocker(previous);
      if (blocker) {
        refuse(
          `AUTO: epic #${previousEpic} is still open in this checkout; refusing to start #${startingEpic} over it.
` +
            `  ${blocker}
` +
            `  its state: ${statePath}
` +
            "Finish it, then it archives itself. To put it away unfinished, run `afk archive --force` — that moves it, it does not delete it.",
        );
        return 1;
      }
      // Finished, so it is history rather than a conflict. MOVED, never
      // deleted: it holds the closeout, the verifier's recommendation, the fix
      // pass and the per-task record. One verb does all of it (scripts/archive.mjs)
      // so the automatic path and the one an operator types are the same path,
      // to the same place.
      const { target, moved } = archiveEpic({ root, epicId: previousEpic });
      say(
        `AUTO: epic #${previousEpic} is finished; moved ${moved.length} item(s) of its run state to ${target} and starting #${startingEpic} fresh.`,
      );
    }
  }

  let state = loadState() ?? initialState();
  if (state.orchestratorPid !== process.pid) {
    const previousIntegrator = state.activeIntegrator
      ? { ...state.activeIntegrator }
      : null;
    const reconciled = reconcileStaleState(state, runnerAgentAlive);
    state = reconciled.state;
    for (const pid of reconciled.stalePids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    if (previousIntegrator?.integrationBase) {
      const recoveryPatch = run("git diff --binary", { cwd: root }).stdout;
      if (recoveryPatch)
        atomicWrite(
          resolve(afkDir, "recovery", `main-${Date.now()}.patch`),
          recoveryPatch,
        );
      say(
        `AUTO: restoring interrupted integration of ${previousIntegrator.taskId} to ${previousIntegrator.integrationBase}.`,
      );
      restoreMain(root, previousIntegrator.integrationBase);
    }
    for (const [id, task] of Object.entries(state.tasks)) {
      if (
        task.recoveredFrom !== "running" ||
        !task.worktree ||
        !existsSync(task.worktree)
      )
        continue;
      const patch = run("git diff --binary", { cwd: task.worktree }).stdout;
      if (patch) atomicWrite(resolve(afkDir, "recovery", `${id}.patch`), patch);
    }
    // Task worktrees are retained on purpose (they may hold unverified work);
    // a read-only role's cwd never holds anything, so a crash mid-review must
    // not leave a detached worktree in `git worktree list` for good.
    const prunedRoleCwds = pruneRoleCwds(root);
    say(
      `AUTO: reconciled stale runtime state; retained task worktrees/branches${reconciled.stalePids.length ? ` and stopped ${reconciled.stalePids.length} orphan process(es)` : ""}${prunedRoleCwds.length ? `; removed ${prunedRoleCwds.length} leftover read-only role checkout(s)` : ""}.`,
    );
  }

  // The DAG says which tasks exist; state.json says what has happened to them.
  // Fold the first into the second before scheduling anything, or a task the
  // state file already knows about is treated as brand new.
  {
    const merged = reconcileWithDag(state, dag);
    state = merged.state;
    if (merged.seeded.length)
      say(`AUTO: seeded ${merged.seeded.length} task(s) missing from runtime state: ${merged.seeded.join(", ")}.`);
    if (merged.orphaned.length)
      say(`AUTO: runtime state holds ${merged.orphaned.length} task(s) no longer in the DAG: ${merged.orphaned.join(", ")}.`);
  }

  // docs/epic-schema.md failure mode 4. The spec is never cached, so a restart
  // re-fetches and can legitimately see a different graph: a child issue closed,
  // unlinked, or a dependency rewritten mid-run. Refuse, and say what moved — a
  // silently orphaned lane is the outcome this exists to prevent. Shape only:
  // ids, edges and gates, so a retitled issue cannot halt a six-hour run.
  const shapeHash = graphShapeHash(dag);
  if (state.graphShapeHash && state.graphShapeHash !== shapeHash) {
    const changes = describeShapeChange(state.dag ?? { tasks: [] }, dag);
    refuse(
      [
        "AUTO: the epic's graph has changed since this run started; refusing to continue.",
        ...changes.map((line) => `  - ${line}`),
        "Finish or abandon this run (reset the tasks, or remove .afk/state.json) before running the new shape.",
      ].join("\n"),
    );
    return 1;
  }
  // `routing.tiers` (#294), refused here, before anything has started: a
  // malformed list read as "the defaults" would route the epic to models
  // nobody chose.
  let tiers;
  try {
    tiers = routingTiers(config);
  } catch (error) {
    refuse(`AUTO: ${error.message}`);
    return 1;
  }
  // Epic-wide custom instructions are persisted, not re-supplied: a restart three
  // hours in must carry the same context the first lane got. A restart that
  // supplies a different string is a mid-run spec change, and is refused for the
  // same reason a changed graph is.
  if (customInstructions && state.customInstructions && customInstructions !== state.customInstructions) {
    refuse(
      "AUTO: this run was started with different custom instructions; refusing to swap them mid-run.\n" +
        `  in state: ${state.customInstructions}\n` +
        `  supplied: ${customInstructions}\n` +
        "Omit the flag to continue with the persisted instructions, or reset the run.",
    );
    return 1;
  }
  state.customInstructions = state.customInstructions ?? customInstructions ?? null;
  customInstructions = state.customInstructions;
  // Delegated acceptance (#188). Additive for the same reason as the
  // instructions: a restart may delegate another gate, never rewrite one.
  {
    const merged = mergeDelegations({
      dag,
      supplied: delegations,
      existing: state.delegations,
      waiver: userFacingWaiver,
      existingWaiver: state.userFacingWaiver,
      inLane: process.env.RUNNER_TASK_ID ?? null,
    });
    if (!merged.ok) {
      refuse(`AUTO: ${merged.reason}.`);
      return 1;
    }
    if (Object.keys(merged.delegations).length) state.delegations = merged.delegations;
    if (merged.waiver) state.userFacingWaiver = merged.waiver;
    if (merged.added.length || (userFacingWaiver && merged.waiver)) {
      for (const line of renderDelegations(state.delegations, state.userFacingWaiver)) say(`AUTO: ${line}`);
    }
  }

  state.orchestratorPid = process.pid;
  state.epic = epic ?? dag.epic ?? state.epic ?? null;
  // A restart keeps the paths the first run published rather than blanking them:
  // `afk auto` invoked directly supplies none, and an epic that silently stopped
  // claiming anything mid-run would go invisible to the epic starting beside it.
  state.claimedPaths = claimedPaths.length ? claimedPaths : (state.claimedPaths ?? []);
  state.branch = dag.branch ?? state.branch ?? null;
  state.graphShapeHash = shapeHash;
  state.dag = dagShape(dag);

  // The epic's lifecycle record. `??=` on purpose: a `.afk/state.json` written
  // by a runner from before this existed has no `epicClose` key, and gets the
  // default here without any other field being touched. Nothing else in the
  // state file changes shape, so a run started before this change continues
  // under a runner that has it (and one started after it continues under a
  // runner that does not, which simply ignores the extra key).
  const close = ensureEpicClose(state);
  // Is the stored closeout review still a review of this branch? The shared
  // test in lib.mjs, which the `review-at-head` merge guardrail applies too.
  const reviewIsCurrent = () => reviewIsCurrentAt(root, close.verifier, headSha(root));
  // The review an acceptance was given over, and whether `report` is that very
  // review. Identified by the commit it read and when it ran, never by what it
  // said: a re-run can word the same findings differently, and a new blocker
  // must never pass as one the human already read.
  const acceptanceReview = (id) => close.acceptances?.[id]?.review ?? null;
  const isSameReview = (seen, report) => Boolean(seen && report)
    && seen.head === (report.head ?? null) && seen.ranAt === (report.ranAt ?? null);
  // The delegate's side of a `gate: after` (#188). Evaluates every merge
  // guardrail for gate `id`, logs each with its evidence, and records the
  // acceptance only when all pass. Any `fail` or `wait` leaves the gate parked
  // and records what it waits on for the closeout's human-acceptance line.
  // Only reachable for a gate delegated at launch; `recordGateAcceptance`
  // refuses `by: "delegate"` on any other.
  const releaseDelegatedGate = (id) => {
    const delegation = state.delegations?.[id];
    if (!delegation) return false;
    const evaluate = mergeGuards ?? evaluateMergeGuards;
    let guards;
    try {
      guards = evaluate({
        root,
        epicId: normalizeId(dag.epic?.id ?? state.epic?.id ?? null),
        taskId: id,
        state,
        config,
        base: epicBase ?? "main",
        delegation,
      });
    } catch (error) {
      guards = [{ name: "guardrails", status: "fail", evidence: `could not evaluate: ${error.message}` }];
    }
    for (const guard of guards) say(`AUTO: gate ${id} guardrail ${renderGuard(guard)}`);
    const waiting = guardsNotPassed(guards);
    if (!guardsPassed(guards)) {
      (close.delegateWaits ??= {})[id] = {
        at: new Date().toISOString(),
        waitingOn: waiting.length ? waiting.map((guard) => guard.name) : ["guardrails that did not run"],
        guards,
      };
      return false;
    }
    const outcome = recordGateAcceptance(state, {
      dag,
      id,
      by: "delegate",
      detail: {
        condition: delegation.condition,
        guards,
        review: { head: close.verifier?.head ?? null, ranAt: close.verifier?.ranAt ?? null },
      },
    });
    if (!outcome.ok) {
      (close.delegateWaits ??= {})[id] = { at: new Date().toISOString(), waitingOn: [outcome.reason], guards };
      return false;
    }
    delete close.delegateWaits?.[id];
    (state.pendingStatusUpdates ??= {})[id] = "passed";
    say(outcome.already
      ? `AUTO: gate ${id} was already accepted; nothing to record.`
      : `AUTO: gate ${id} accepted by the delegate under "${delegation.condition}"; every guardrail passed.`);
    return true;
  };
  const delegateWaitLine = (id) => {
    const waits = close.delegateWaits?.[id];
    return `delegated, waiting on ${(waits?.waitingOn ?? ["an evaluation that has not run"]).join(", ")}`;
  };
  // A human's acceptance of a `gate: after` task, and the ONE place a run reads
  // one. It comes from the `--accept=` flag a human typed; no agent result, no
  // verification file and no transcript reaches this call.
  if (accept.length) {
    if (process.env.RUNNER_TASK_ID) {
      refuse(
        `AUTO: refusing --accept inside task ${process.env.RUNNER_TASK_ID}'s agent environment. A gate is released by a human, not by the lane it gates.`,
      );
      return 1;
    }
    // The review that binds a sign-off is the one at the branch head. Epic #715's
    // human accepted legal gate #720 at 09:42 over a review that predated #718's
    // integration; the review that found the redaction leak ran at 09:46, and the
    // fixer then edited the signed document. Fails closed: no review at head, no
    // acceptance, unless the human says `--force`. A review that could not run
    // (`skipped`) is not a review at head either.
    // The delegate's acceptance (#188): the same guardrails the park applies,
    // for the chief of staff to retry after CI went green or evidence landed.
    if (acceptDelegated) {
      if (acceptForce) {
        refuse("AUTO: --delegated with --force is refused. No flag skips a guardrail on the delegated path; a human accepts with --accept --force.");
        return 1;
      }
      for (const id of accept.map(normalizeId)) {
        if (!state.delegations?.[id]) {
          refuse(`AUTO: #${id} was not delegated; a human must accept it.`);
          return 1;
        }
        if (close.acceptances?.[id] && ["human", "delegate"].includes(close.acceptances[id].by)) {
          say(`AUTO: gate ${id} was already accepted; nothing to record.`);
          continue;
        }
        if (!releaseDelegatedGate(id)) {
          saveState(state);
          refuse(`AUTO: cannot accept ${id} on the delegate's behalf — ${delegateWaitLine(id)}. The gate stays awaiting_acceptance.`);
          return 1;
        }
      }
      saveState(state);
    }
    const head = headSha(root);
    const reviewAtHead = reviewIsCurrent();
    for (const id of acceptDelegated ? [] : accept.map(normalizeId)) {
      const already = close.acceptances?.[id]?.by === "human";
      if (!already && !reviewAtHead && !acceptForce) {
        const newest = !close.verifier ? "no closeout review has run for this epic"
          : close.verifier.skipped ? `the last closeout review did not run (${close.verifier.skipped})`
          : `the newest closeout review (${close.verifier.ranAt ?? "time unknown"}) read ${close.verifier.head ? close.verifier.head.slice(0, 12) : "an unrecorded commit"}, and the branch head ${head ? head.slice(0, 12) : "(unknown)"} has more than the runner's status commits on top of it`;
        refuse(
          `AUTO: cannot accept ${id} — ${newest}. Run the epic again without --accept: it reviews the head and parks on the gate, and then you accept against that review. To accept without one, add --force.`,
        );
        return 1;
      }
      const outcome = recordGateAcceptance(state, { dag, id });
      if (!outcome.ok) {
        refuse(`AUTO: cannot accept ${id} — ${outcome.reason}.`);
        return 1;
      }
      // Which review the human signed against, so the close can tell a must-fix
      // they already read from one they never saw. Null when forced.
      if (!outcome.already) {
        close.acceptances[id].review = reviewAtHead
          ? { head: close.verifier.head, ranAt: close.verifier.ranAt ?? null,
              recommendation: close.verifier.recommendation ?? null }
          : null;
        if (!reviewAtHead) close.acceptances[id].forced = true;
      }
      // The acceptance moved the task out of `awaiting_acceptance`, so the
      // committed progress table owes a row. `queueStatus` is not in scope yet
      // (it is built with the scheduler below); the queue it writes to is.
      (state.pendingStatusUpdates ??= {})[id] = "passed";
      say(outcome.already
        ? `AUTO: gate ${id} was already accepted; nothing to record.`
        : `AUTO: gate ${id} accepted by a human; the epic may now close on it.`);
    }
    saveState(state);
  }

  // Recover a completed task branch even if the orchestrator died after commit but
  // before state.json was updated. Never delete or reset an ahead branch blindly.
  // Passed lanes this sweep already looked at, so `retryPassedCleanup` below
  // does not run the same cleanup (and `finish` hook) a second time.
  const swept = new Set();
  for (const entry of listAfkWorktrees(root)) {
    const branch = String(entry.branch).replace("refs/heads/", "");
    const id = normalizeId(branch.match(/^afk\/task-(.+)$/)?.[1]);
    const task = dag.tasks.find((candidate) => candidate.id === id);
    if (!task) continue;
    if (lifecycleOf(task, state) === "passed") {
      swept.add(id);
      if (
        run(`git merge-base --is-ancestor ${shellQuote(branch)} ${shellQuote(baseBranch)}`, {
          cwd: root,
        }).status === 0
      ) {
        const cleanup = removeTaskWorktree({ root, id, branch, setup: config.worktreeSetup });
        sayHooks(id, cleanup.hooks);
        recordCleanup(state.tasks[id], cleanup);
        closeHerdrLane(root, id).catch(() => {});
        say(`AUTO: completed interrupted cleanup for passed task ${id}${cleanup.warning ? ` — ${cleanup.warning}` : ""}.`);
      }
      continue;
    }
    const tip = run(`git rev-parse ${shellQuote(branch)}`, {
      cwd: root,
    }).stdout.trim();
    const base = run(`git merge-base ${shellQuote(baseBranch)} ${shellQuote(branch)}`, {
      cwd: root,
    }).stdout.trim();
    if (tip && base && tip !== base) {
      const verification = readLaneVerification(root, id, branch);
      if (!laneVerified(verification)) {
        const recoveryPatch = run(
          `git diff --binary ${shellQuote(base)}..${shellQuote(branch)}`,
          { cwd: root },
        ).stdout;
        if (recoveryPatch)
          atomicWrite(
            resolve(afkDir, "recovery", `${id}-unverified-branch.patch`),
            recoveryPatch,
          );
        Object.assign(state.tasks[id], {
          lifecycle: "pending",
          branch,
          worktree: entry.worktree,
          baseSha: base,
          recoveredFrom: "unverified_branch",
        });
        say(
          `AUTO: retained unverified branch ${branch} and saved its patch; it will be rebuilt before integration.`,
        );
        continue;
      }
      Object.assign(state.tasks[id], {
        lifecycle: "ready_to_integrate",
        branch,
        worktree: entry.worktree,
        baseSha: base,
        commitSha: tip,
        taskVerification: compactVerification(verification),
        recoveredFrom: "committed_branch",
      });
      enqueueIntegration(state, id);
    }
  }

  // A passed task whose cleanup failed after its merge (#144). Never fatal, and
  // never blocks the run: a warning here is a leftover directory, not lost work.
  {
    const { retried, refused } = retryPassedCleanup({
      state,
      root,
      baseBranch,
      setup: config.worktreeSetup,
      skip: swept,
    });
    for (const retry of retried) {
      sayHooks(retry.id, retry.hooks);
      say(
        `AUTO: retried cleanup for passed task ${retry.id}: worktree ${retry.removed ? "removed" : "still on disk"}${retry.branchDeleted ? ", branch gone" : ""}${retry.warning ? ` — ${retry.warning}` : ""}.`,
      );
    }
    for (const { id, branch, reason } of refused)
      say(`AUTO: passed task ${id}'s lane is left on disk for a human to look at: ${branch} — ${reason}.`);
  }

  // A lane parked `ready_to_integrate` off the queue by a disk-full
  // integration (#144). The sweep above re-queues it only while git still
  // lists its worktree, and freeing disk by deleting that directory (then any
  // `git worktree prune`) made it invisible: every restart then exited with the
  // lane "in flight" forever and its dependents never ran. Integration needs
  // the branch, not the worktree. The branch is trusted when its tip is the
  // commit state recorded as verified (`commitSha`, set only when the builder's
  // checks passed), or failing that when its verification note says so — the
  // sweep's own test. A branch that is gone or moved fails the task by name.
  {
    const queued = new Set([...(state.integrationQueue ?? []), state.activeIntegrator?.taskId].filter(Boolean));
    for (const task of dag.tasks) {
      const taskRuntime = state.tasks[task.id];
      if (taskRuntime?.lifecycle !== "ready_to_integrate" || queued.has(task.id)) continue;
      const branch = taskRuntime.branch ?? taskBranch(task.id);
      const known = branchState(root, branch);
      const tip = known === "present"
        ? (run(`git rev-parse ${shellQuote(branch)}`, { cwd: root }).stdout.trim() || null)
        : null;
      const verified = tip && (tip === taskRuntime.commitSha || laneVerified(readLaneVerification(root, task.id, branch)));
      if (verified) {
        enqueueIntegration(state, task.id);
        say(`AUTO: re-queued ${task.id} for integration from ${branch} (${tip.slice(0, 8)}).`);
        continue;
      }
      if (known === "unknown") {
        say(`AUTO: could not check ${branch} for ready_to_integrate task ${task.id}; left as it is for the next start.`);
        continue;
      }
      taskRuntime.lifecycle = "integration_failed";
      (state.pendingStatusUpdates ??= {})[task.id] = "integration_failed";
      say(
        `AUTO: ${task.id} was ready_to_integrate but ${tip ? `${branch} has moved off its verified commit` : `${branch} no longer exists`}; marked integration_failed. Rebuild it with \`afk reset ${task.id}\`.`,
      );
    }
  }

  if (explicitTaskId) {
    const explicit = dag.tasks.find((task) => task.id === explicitTaskId);
    if (!explicit) {
      refuse(`AUTO: unknown task ${explicitTaskId}.`);
      return 1;
    }
    const lifecycle = lifecycleOf(explicit, state);
    const queued =
      state.integrationQueue.includes(explicitTaskId) ||
      state.activeIntegrator?.taskId === explicitTaskId;
    if (
      !queued &&
      (lifecycle !== "pending" || !dependenciesPassed(explicit, dag, state))
    ) {
      refuse(
        `AUTO: task ${explicitTaskId} is not runnable (status=${lifecycle}; all dependencies must be passed).`,
      );
      return 1;
    }
  }

  // The backstop for `afk auto` invoked directly. `cliEpic`'s hoisted preflight
  // is the path an operator normally takes and refuses first; this one says the
  // same thing, from the same source, for the one who skipped it.
  const dirty = parseStatusPaths(run("git status --porcelain", { cwd: root }).stdout);
  if (dirty.length) {
    for (const line of dirtyTreeLines(dirty, "AUTO")) refuse(line);
    return 1;
  }

  atomicWrite(lockPath, `${process.pid}\n`);
  saveState(state);
  // Defined before the preflight block below, which calls it on failure.
  //
  // Only this process's own lock (#146, #136). A process that died on a fatal
  // can linger ~15 minutes with its `exit` handler still armed; by the time it
  // exits, an auto-restart or a human may have taken the lock, and removing
  // theirs would let a third orchestrator start beside them. Fail direction:
  // a lock that cannot be read is left, and the next start removes it once its
  // pid is dead.
  const release = () => {
    try {
      if (Number(readFileSync(lockPath, "utf8").trim()) !== process.pid) return;
    } catch {
      return;
    }
    rmSync(lockPath, { force: true });
  };

  // Preflight: verify `claude` is authenticated and every required secret is
  // present before spawning the first builder. A dead login fails every task in
  // under two seconds and used to trip the breaker as if two tickets were bad —
  // and, like the base-branch guard before it, that died in the background log.
  // This speaks to STDOUT and exits before any builder runs. The host probes
  // (#180) run in the same call; `afk preflight` runs the identical set.
  const auth = authCommands();
  // (#210) The Infisical session, probed only when a configured check runs
  // `infisical run`: before the first builder (in preflight), and again before
  // each baseline and integration gate, because a session can expire mid-run
  // and `infisical run` without one can sit on an interactive prompt.
  // A repo whose checks never call `infisical run` can still print the phrase
  // (afk-claude's own selftest does), so only then is it the login.
  const gatesUseInfisical = usesInfisicalRun(config, dag);
  const infisicalNow = () => infisicalBlocker({
    config, dag, cwd: root, ...(infisicalProbe ? { probe: infisicalProbe } : {}),
  });
  {
    // Only tasks that will get a lane this run (#214): a passed or gated UI
    // ticket must not drive the screen on `--accept` or a relaunch.
    const lanes = laneTasks(dag, state, explicitTaskId);
    const probeWarnings = [];
    const blockers = preflightBlockers({
      config,
      root,
      checkAuth: () => runAuthProbe({ root, afkDir, config }),
      tasks: lanes,
      checkTasks: checkTasks(dag, state, explicitTaskId),
      ...hostProbes({ root, herdrStatus }),
      ...preflightProbeOverrides,
      warnings: probeWarnings,
    });
    for (const warning of [...probeWarnings, ...preflightWarnings({ tasks: lanes, packageJson: readPackageJson(root) })]) say(`AUTO: preflight warning: ${warning}`);
    if (blockers.length) {
      for (const blocker of blockers)
        // The probe ran the backend THIS executable selected, so the remedy is
        // that backend's login and no other. `afk-codex` telling an operator to
        // run `claude auth login` sends them to fix a CLI the run never touched.
        say(`AUTO: ${preflightLine(blocker)}`);
      say(
        "AUTO: preflight failed; no builders were spawned. Fix the above, then rerun.",
      );
      state.orchestratorPid = null;
      saveState(state);
      release();
      return 1;
    }
  }

  // An OAuth session lasts ~24h from login; a full-DAG run started late in that
  // window dies mid-run at the first builder. Offer a refresh at start, where a
  // human is present — never stall an unattended start (TTY-only, 20s default No).
  const shouldRefreshAuth = async () => {
    if (refreshAuth) return true;
    if (!interactive || explicitTaskId) return false;
    process.stdout.write(
      `AUTO: refresh the ${auth.cli} login before this run? Sessions expire ~24h after login. [y/N] (20s) `,
    );
    return new Promise((answer) => {
      const done = (value) => {
        clearTimeout(timer);
        process.stdin.off("data", onData);
        process.stdin.pause();
        answer(value);
      };
      const timer = setTimeout(() => { process.stdout.write("\n"); done(false); }, 20_000);
      const onData = (buf) => done(/^y/i.test(String(buf).trim()));
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
  };
  if (await shouldRefreshAuth()) {
    say(`AUTO: refreshing ${auth.cli} login — complete the browser flow.`);
    spawnSync(auth.cli, auth.logout, { stdio: "inherit" });
    const login = spawnSync(auth.cli, auth.loginArgs, { stdio: "inherit" });
    if (login.status !== 0) {
      say("AUTO: login did not complete; aborting before any builder runs.");
      state.orchestratorPid = null;
      saveState(state);
      release();
      return 1;
    }
  }

  // Disk, before the baseline and before any lane (#144). Three epics died of
  // ENOSPC mid-run — in a retry's `npm ci`, and writing a verification record —
  // on a volume that was already short when the run started. Its own call site,
  // separate from the baseline gate, so the two stay independent.
  {
    const verdict = diskVerdict({ root, config, freeDisk });
    // A refusal ENDS the run, so it goes through `refuse` (stderr and the log,
    // R7); a warning is a scheduler line like any other.
    if (verdict.level === "refuse") {
      refuse(`AUTO: ${verdict.line}`);
      // The state write is exactly what a full disk breaks. Guarded, so the
      // refusal above stays the reason this run stopped and the lock still goes.
      state.orchestratorPid = null;
      try {
        saveState(state);
      } catch {}
      release();
      return 1;
    }
    if (verdict.line) say(`AUTO: ${verdict.line}`);
  }

  let exiting = false;
  const activeBuilders = new Map();
  let activeIntegrator = null;
  let dashboardProcess = null;
  // The machine-wide record the hub lists a no-dashboard run from (#279).
  // Fail direction: OPEN. A failed write is logged and the run carries on; the
  // record is a window on the run, like the dashboard it stands in for.
  const noDashboardRecord = (write) => {
    try {
      write(root);
    } catch (error) {
      say(`AUTO: warning: could not update the hub's no-dashboard record — ${error.message}`);
    }
  };
  // Every path that deletes `dashboardSkipped` takes the root off the record.
  const clearDashboardSkipped = () => {
    if (!state.dashboardSkipped) return;
    delete state.dashboardSkipped;
    noDashboardRecord(forgetNoDashboard);
  };
  // Every exit between the dashboard step and the scheduler's own `finally`
  // (#279): `afk start` reads either dashboard field as "the run is up". Each
  // step on its own, as in that `finally`, so a full disk neither replaces the
  // error that ended the run nor keeps the lock.
  const exitBeforeScheduler = () => {
    try {
      dashboardProcess?.stop();
    } catch {}
    state.orchestratorPid = null;
    state.dashboard = null;
    clearDashboardSkipped();
    try {
      saveState(state);
    } catch (error) {
      console.error(`AUTO: could not write final state — ${error.message}`);
    }
    release();
  };
  process.on("exit", release);
  // Killing the orchestrator does NOT kill its lanes: they hold their own
  // worktrees and herdr panes and keep burning tokens, and `state.activeWorkers`
  // is the only map of them — a lane whose pid was never recorded is findable
  // afterwards only by cwd (`lsof -a -p <pid> -d cwd`), never by argv. Shared
  // with the fatal handler below, which used to leave them all running.
  const killLanes = () => {
    const fates = teardownRecordedLanes(state, {
      teardown: (lane) => teardownWorktree({ worktree: lane.worktree, setup: config.worktreeSetup }),
    });
    for (const fate of fates) {
      say(`AUTO: teardown pid ${fate.pid} (${fate.role} ${fate.taskId}): ${fate.fate}.`);
      sayHooks(fate.taskId, fate.teardown);
    }
    // The integrator's checks ran in the root checkout, not in its lane, so
    // whatever they booted there is torn down where it was created.
    if (state.activeIntegrator) sayHooks(state.activeIntegrator.taskId, teardownWorktree({ worktree: root, setup: config.worktreeSetup }));
    return fates;
  };
  // Kept, so a fatal can take them off again (#146): see the catch below.
  const signalHandlers = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (exiting) return;
      exiting = true;
      killLanes();
      if (state.activeIntegrator?.integrationBase)
        try {
          restoreMain(root, state.activeIntegrator.integrationBase);
        } catch {}
      dashboardProcess?.stop();
      state.dashboard = null;
      clearDashboardSkipped();
      saveState(state);
      release();
      process.exit(130);
    };
    signalHandlers.push([signal, handler]);
    process.on(signal, handler);
  }
  try {
    dashboardProcess = await startDashboard({
      root,
      logPath: dashboardLogPath,
      previousPid: state.dashboard?.managed ? state.dashboard.pid : null,
    });
    state.dashboard = {
      pid: dashboardProcess.pid,
      port: dashboardProcess.port,
      managed: !dashboardProcess.reused || dashboardProcess.recovered,
      reused: dashboardProcess.reused,
      startedAt: new Date().toISOString(),
    };
    clearDashboardSkipped();
    saveState(state);
    say(
      `AUTO: dashboard ${dashboardProcess.reused ? "ready" : "started"} at ${dashboardProcess.url} (pid ${dashboardProcess.pid}).`,
    );
  } catch (error) {
    // The dashboard is a window on the run, not part of it: an epic that dies
    // here never reaches its baseline, for want of a page nobody is looking at.
    const log = error.logPath ? "" : ` Dashboard log: ${dashboardLogPath}.`;
    say(`AUTO: warning: the dashboard did not start; carrying on without it. ${error.message}${log}`);
    dashboardProcess = null;
    state.dashboard = null;
    // `afk start` waits for a dashboard or for this: either means the run is up.
    state.dashboardSkipped = { at: new Date().toISOString(), reason: error.message };
    saveState(state);
    noDashboardRecord(recordNoDashboard);
  }

  // The tier router (#294): after the plan review, before the launch row and
  // the first lane. `tiers` was validated before anything started.
  {
    const routed = await routeTasks({
      tasks: laneTasks(dag, state, explicitTaskId),
      epic,
      state,
      key: jevKey,
      fetchImpl: jevFetch,
      timeoutMs: jevTimeoutMs,
    });
    if (routed.skipped) say(`AUTO: tier router skipped: ${routed.skipped}; every lane builds as it did before routing.`);
    for (const [id, decision] of Object.entries(routed.decisions ?? {}))
      say(`AUTO: tier router: ${id} is ${decision.tier} (${decision.reason}).`);
    if (routed.reused && !routed.asked && !routed.skipped)
      say(`AUTO: tier router: reusing the stored routing decision for ${routed.reused} task(s).`);
    saveState(state);
  }
  // From here to the scheduler's `try`, a throw (a gate that could not run, a
  // git call that failed) is not a scheduler fatal: it rethrows as before, after
  // the cleanup every planned exit does (#279).
  try {
    appendLaunchRow({ root, dag, config, release: { task: explicitTaskId, accept }, forecast, state, say });
    const baselineChecks = config.baselineChecks ?? config.defaultChecks ?? [];
    // `baselineTimeoutMs` bounds each baseline command; default 10 minutes.
    const baselineTimeoutMs = config.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS;
    // The gate runs on every start, cold ones included — an unverified baseline is
    // exactly the case it exists to catch. A plan whose first task bootstraps the
    // toolchain opts out explicitly with `"baselineChecks": []`.
    //
    // The one exception is a start at the exact commit, with the exact commands,
    // that already went green: epic #760 paid ~28 of 160 minutes for three
    // baselines, the last two over the same head. The tree was refused above if
    // it was dirty, so the head names what the checks would read.
    const baselineKey = { headSha: headSha(root), commands: baselineChecks };
    // Two records can say this command list went green at a head: the last
    // baseline's, and a passed closeout fix gate's (#176 W2), which runs the same
    // list over the fixer's commit. The gate's is read from `gate.json`, the one
    // record its own head-keyed reuse already reads, never copied into state.
    // Either may be followed by the runner's own commits: status flushes, and the
    // closeout's artefact sweep (`isBaselineInertPath`).
    const fixGate = readCloseoutGate(root, normalizeId(dag.epic?.id ?? null));
    const greens = [
      state.lastGreenBaseline && { ...state.lastGreenBaseline, source: "baseline" },
      fixGate?.status === "passed" && fixGate.fixSha
        && { headSha: fixGate.fixSha, commands: fixGate.checks, at: fixGate.ranAt ?? null, source: "fix gate" },
    ].filter(Boolean)
      .filter((record) => JSON.stringify(record.commands ?? null) === JSON.stringify(baselineChecks))
      // Newest first: the Rust skip below diffs from the latest green.
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    // (#223) Or by integrated task merges: each passed its own integration gate
    // on the merged tree, so a relaunch after them need not re-gate the whole of
    // it. The merge commit is the one `integratedHead` recorded, nothing else.
    const integratedMerges = new Map(Object.entries(state.tasks ?? {})
      .filter(([, task]) => task?.lifecycle === "passed" && task.integratedHead)
      .map(([id, task]) => [task.integratedHead, id]));
    let mergesSinceGreen = [];
    const greenRecord = greens.find((record) => sameGreenBaseline(record, baselineKey, (from, to) => {
      if (onlyStatusFlushSince(root, from, to, isBaselineInertPath)) return true;
      const merges = onlyIntegratedMergesSince(root, from, to, integratedMerges, isBaselineInertPath);
      if (merges) mergesSinceGreen = merges;
      return Boolean(merges);
    })) ?? null;
    const baselineSkipped = Boolean(greenRecord);
    if (baselineSkipped) {
      const green = greenRecord.headSha;
      const since = mergesSinceGreen.length
        ? `only integrated task merges (${mergesSinceGreen.join(", ")}) and the runner's status commits have landed since`
        : "only the runner's status commits have landed since";
      say(`AUTO: baseline check skipped — ${greenRecord.source === "fix gate" ? "the closeout fix gate" : "it"} went green at ${green.slice(0, 12)} with these ${baselineChecks.length} command(s) on ${greenRecord.at ?? "an earlier start"}, and neither has changed${green === baselineKey.headSha ? "" : ` (${since}, up to ${baselineKey.headSha.slice(0, 12)})`}.`);
    }
    // (#176 W3) Rust checks are skipped when nothing Rust-relevant changed since
    // the latest green for this same list. Computed once, only for a baseline that
    // runs; no green record means every check runs.
    const rustSkip = baselineSkipped ? null : baselineRustSkipReason(root, greens[0]?.headSha, baselineKey.headSha);
    // (#178) One full gate at a time on the machine. The lock is taken outside
    // `recordGate`, so the event's load reading and the per-command time bounds
    // both start once the gate actually runs, not while it waits.
    const runBaselineGate = baselineGate ?? (() => withGateLock(
      { root, config, epic: normalizeId(dag.epic?.id ?? null), kind: "baseline", say },
      // (#223) Then a quiet host, the same for a first launch, a relaunch and the
      // environment rerun below: the lock cannot hold back another epic's lanes.
      async ({ lockWaitS }) => {
        await waitForQuietHost({
          threshold: quietHostLoad(config), kind: "baseline", say,
          ...(hostLoad ? { load: hostLoad } : {}), ...(quietPollMs ? { pollMs: quietPollMs } : {}),
        });
        return recordGate({ root, kind: "baseline", commands: baselineChecks, lockWaitS, say }, () => runBaselineChecks({
          commands: baselineChecks,
          cwd: root,
          timeoutMs: baselineTimeoutMs,
          say,
          skip: (command) => (rustSkip && isRustCheck(command) ? rustSkip : null),
        }));
      }));
    if (!baselineSkipped && baselineChecks.length) {
      const infisical = infisicalNow();
      if (infisical) {
        say(`AUTO: ${infisical}`);
        say("AUTO: baseline gate not run; no builders were spawned.");
        exitBeforeScheduler();
        return 1;
      }
    }
    let baselineFailure = baselineSkipped ? { ok: true } : await runBaselineGate();
    // (#179) A red the deterministic reading pins on the environment — a held
    // port, a service not up yet — reruns the whole gate once, through the gate
    // lock like any gate, instead of halting for a human who would rerun it and
    // see it pass. Anything else halts below exactly as before. The rerun changes
    // nothing in the tree, and its green counts only for the head that went red.
    if (!baselineFailure.ok) {
      const { command, result } = baselineFailure;
      const reading = classifyGateFailure({
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
        timedOut: Boolean(result.timedOut),
        changedFiles: epicChangedFiles(root, epicBase ?? "main"),
      });
      if (earnsGateRerun(reading)) {
        const rerun = {
          kind: "baseline", at: new Date().toISOString(), headSha: baselineKey.headSha, command,
          firstExitCode: result.status ?? null, ...reading, passed: null,
        };
        recordGateRerun(state, rerun);
        saveState(state);
        say(`AUTO: baseline check failed on the environment, not the code — ${reading.evidence.join("; ")}. Rerunning the baseline once on the same tree.`);
        baselineFailure = await runBaselineGate();
        if (baselineFailure.ok && headSha(root) !== baselineKey.headSha) {
          baselineFailure = {
            ok: false,
            command: "(baseline rerun)",
            result: { stdout: "", stderr: `the head moved from ${baselineKey.headSha} to ${headSha(root)} during the rerun; its green is not this tree's.` },
          };
        }
        rerun.passed = baselineFailure.ok;
        saveState(state);
        say(baselineFailure.ok
          ? "AUTO: baseline rerun passed on the same tree; scheduling."
          : "AUTO: baseline rerun failed again on the same tree; halting.");
      }
    }
    if (baselineFailure.ok && !baselineSkipped && baselineKey.headSha) {
      state.lastGreenBaseline = {
        ...baselineKey,
        at: new Date().toISOString(),
        ...(baselineFailure.skipped?.length ? { skipped: baselineFailure.skipped } : {}),
      };
      saveState(state);
    }
    if (!baselineFailure.ok) {
      const { command, result: baseline } = baselineFailure;
      // Why it failed, not just that it did. This gate halts the whole run
      // before a single lane starts, and a bare "baseline check failed" sends
      // the operator to re-run it by hand — where it often passes, because the
      // orchestrator that was loading the machine has just exited.
      //
      // TAP `not ok` lines first and a blind tail second: a suite that fails one
      // test of 73 buries the name hundreds of lines above the summary, which is
      // exactly the case a tail alone cannot show.
      const output = `${baseline.stdout ?? ""}${baseline.stderr ?? ""}`.trimEnd();
      const failures = output.split("\n").filter((line) => /^\s*not ok\b/.test(line));
      say(`AUTO: baseline check failed before scheduling: ${command}`);
      if (failures.length) say(failures.slice(0, 20).join("\n"));
      if (output) say(output.split("\n").slice(-25).join("\n"));
      exitBeforeScheduler();
      return 1;
    }
  } catch (error) {
    exitBeforeScheduler();
    throw error;
  }

  // Terminal verdicts the runner owes the repository, flushed between
  // integrations. The statuses themselves live in state.json; what gets
  // committed is the human-readable progress table and the integration
  // verification each verdict is based on.
  state.pendingStatusUpdates ??= {};
  const queueStatus = (task, status) => {
    state.pendingStatusUpdates[task.id] = status;
  };
  // The ledger has to survive the run that wrote it: an entry recorded at minute
  // 10 steers a lane that starts at minute 40, and if the only copy is the
  // working tree it is gone the moment the worktree is cleaned or the branch is
  // checked out elsewhere. `--ignored` because a consuming project gitignores
  // `.afk/` (README), so an untracked ledger is invisible to a plain `status`.
  //
  // A status call that could not spawn reads as "not dirty this turn" and says
  // why (#136): the flush runs every scheduler turn, so the entry is committed
  // on the next one, where a throw here used to end the run. Fail direction:
  // open. A ledger commit one turn late loses nothing; a dead scheduler loses
  // every lane. Said once per failing spell, not once per turn.
  let ledgerCheckFailing = false;
  const ledgerDirty = () => {
    if (!existsSync(resolve(root, LEDGER_RELATIVE))) return false;
    const status = run(`git status --porcelain --ignored -- ${shellQuote(LEDGER_RELATIVE)}`, {
      cwd: root,
    });
    if (status.error) {
      if (!ledgerCheckFailing)
        say(`AUTO: could not check the epic ledger (${status.stderr.trim()}); retrying every turn until it clears.`);
      ledgerCheckFailing = true;
      return false;
    }
    ledgerCheckFailing = false;
    return status.stdout.trim() !== "";
  };
  const flushStatuses = () => {
    const updates = Object.entries(state.pendingStatusUpdates ?? {});
    // A ledger entry can arrive with no status change behind it — the supervisor
    // records one on a blocked lane. Flushing only on a verdict would leave it
    // uncommitted until the next one, and a run that ends there loses it.
    const ledgerPending = ledgerDirty();
    if (!updates.length && !ledgerPending) return;
    if (activeIntegrator)
      throw new Error("Refusing to mutate main while an integration is active.");
    // The paths staged below are mirrored by `isStatusFlushPath` in lib.mjs,
    // which `markStaleEvidence` uses to tell "the branch moved" from "the
    // runner committed its own bookkeeping". Adding a path here means adding
    // it there, or a closeout starts caveating verdicts nothing invalidated.
    const files = [];
    // `writeProgress` (lib.mjs) owns the path: `docs/progress/<epic id>.md`, or
    // the shared `docs/progress.md` when a DAG carries no epic id at all. One
    // file per epic is what stops two epics' merges colliding on a file neither
    // of them disagreed about (#122). The staged list is its return value, never
    // a second copy of the literal.
    if (updates.length) files.push(writeProgress(root, dag, state));
    if (files.length) {
      const add = run(`git add -- ${files.map(shellQuote).join(" ")}`, {
        cwd: root,
      });
      if (add.status !== 0)
        throw new Error(`Cannot stage runner status: ${add.stderr}`);
    }
    if (ledgerPending) {
      // -f: the first add of an ignored path needs it. Once tracked, later
      // commits ignore `.gitignore` entirely, so the flag costs nothing after.
      const addLedger = run(`git add -f -- ${shellQuote(LEDGER_RELATIVE)}`, {
        cwd: root,
      });
      if (addLedger.status !== 0)
        throw new Error(`Cannot stage the epic ledger: ${addLedger.stderr}`);
    }
    if (run("git diff --cached --quiet", { cwd: root }).status !== 0) {
      const label = updates.length
        ? `update task status (${updates.map(([id, status]) => `${id} ${status}`).join(", ")})`
        : "record ledger entries";
      const commit = run(
        `git commit --no-verify -m ${shellQuote(`afk: ${label}`)}`,
        { cwd: root },
      );
      if (commit.status !== 0)
        throw new Error(`Cannot commit runner status: ${commit.stderr}`);
    }
    state.pendingStatusUpdates = {};
    saveState(state);
  };
  // Every scheduler turn, in this order: re-derive `blocked` from the dependency
  // graph, then admit any `gate: after` task the graph has now reached. Both are
  // pure functions in scripts/scheduler.mjs; this wrapper only logs and queues
  // the committed progress rows for what they moved.
  const reconcileDerivedLifecycles = () => {
    for (const move of deriveBlocked(dag, state)) {
      const task = dag.tasks.find((candidate) => candidate.id === move.id);
      queueStatus(task, move.lifecycle);
      say(move.lifecycle === "blocked"
        ? `AUTO: ${move.id} blocked because dependency ${move.blocker} cannot pass.`
        : `AUTO: ${move.id} is no longer blocked — every dependency it was waiting on has passed.`);
    }
    // A `gate: after` task is human work: it is never dispatched to a builder,
    // never given a worktree, and resolves here instead. Three epics ran this
    // ticket shape through a lane and recorded `blocked`, `failed` and `passed`
    // for it on builder judgment alone — including a `passed` whose own artifact
    // said no human had touched a device.
    for (const id of resolveGateAfterTasks(dag, state)) {
      const task = dag.tasks.find((candidate) => candidate.id === id);
      queueStatus(task, AWAITING_ACCEPTANCE);
      say(
        `AUTO: ${id} is a \`gate: after\` acceptance gate — no lane, no builder. It is now awaiting_acceptance; release it with --accept=${id}.`,
      );
    }
  };

  // `dispatchFallback` is why THIS dispatch may not use Codex (a failed quota
  // read). It decides this one lane only: the stored assignment is untouched,
  // so the task's next dispatch, and every other Codex lane, reads again.
  // `resolved` is a tiered task's concrete assignment for this dispatch
  // (`tierDispatch`); without it the stored assignment is used as it stands.
  const launchBuilder = (task, startGate = null, dispatchFallback = null, resolved = null) => {
    const taskRuntime = (state.tasks[task.id] ??= {
      lifecycle: "pending",
      builderAttempt: 0,
      integrationAttempt: 0,
    });
    // A merger may temporarily move HEAD or leave a conflict index while it works.
    // Builders scheduled concurrently use the last known-good main snapshot, never
    // a half-integrated commit. Once integration passes, newly unblocked work uses
    // the new main tip on the next scheduler turn.
    const baseSha =
      state.activeIntegrator?.integrationBase ?? currentBaseSha(root, baseBranch);
    const branch = taskBranch(task.id);
    const worktree = taskWorktree(root, task.id);
    const setup = config.worktreeSetup;
    try {
      if (existsSync(worktree) || branchExists(root, branch)) {
        createTaskWorktree({ root, id: task.id, baseSha, setup });
        resetTaskWorktree({ worktree, baseSha, root, setup });
      } else {
        const lane = createTaskWorktree({ root, id: task.id, baseSha, setup });
        const bootstrapped = [
          ...lane.setup.linked.map((entry) => `linked ${entry}`),
          ...lane.setup.copied.map((entry) => `copied ${entry}`),
          ...lane.setup.ran.map((command) => `ran ${command}`),
        ];
        if (bootstrapped.length)
          say(`AUTO: bootstrapped worktree ${task.id} — ${bootstrapped.join(", ")}.`);
      }
    } catch (error) {
      // Only a full disk is the lane's problem (#144, epic #865). Any other
      // bootstrap throw — a `worktreeSetup.link` naming a missing path — is a
      // config fault every lane shares, and stays fatal and loud.
      if (!isDiskFull(error)) throw error;
      failLaneOnFullDisk(task.id, error, "worktree bootstrap");
      return;
    }
    taskRuntime.builderAttempt = (taskRuntime.builderAttempt ?? 0) + 1;
    // A rate-limit retry reuses the attempt number; the dispatch number tells
    // its `builderRuns` entry apart from the earlier one's.
    taskRuntime.builderDispatchAttempt = (taskRuntime.builderDispatchAttempt ?? 0) + 1;
    const dispatchAttempt = taskRuntime.builderDispatchAttempt;
    const route = builderRoute(resolved ?? state.builderRouting?.assignments?.[task.id], {
      fallbackReason: dispatchFallback ?? taskRuntime.codexFallbackReason ?? null,
    });
    // What this attempt asked for. `finishBuilder` overwrites the model with
    // what the lane's own record says it ran on (`verification.agent`).
    const asked = roleAgent(roleFor("implementer"), config, route?.backend);
    (taskRuntime.builderRuns ??= []).push({
      attempt: taskRuntime.builderAttempt,
      dispatch: dispatchAttempt,
      backend: route?.backend ?? asked.backend ?? resolveBackend(),
      model: route?.model ?? asked.model ?? null,
      reason: route?.reason ?? null,
      ...(resolved?.tier ? { tier: route?.fallback ? "critical" : resolved.tier } : {}),
      outcome: null,
    });
    Object.assign(taskRuntime, {
      lifecycle: "running",
      branch,
      worktree,
      baseSha,
      retryAt: null,
      pid: null,
      // Each attempt starts without a deadline verdict; finishBuilder sets it
      // only if THIS attempt is killed by the clock after real work (#73).
      timedOut: false,
    });
    state.activeWorkers[task.id] = {
      taskId: task.id,
      pid: null,
      branch,
      worktree,
      baseSha,
      attempt: taskRuntime.builderAttempt,
      dispatchAttempt,
    };
    saveState(state);
    const current = taskRuntime.builderRuns.at(-1);
    say(
      `AUTO: builder ${task.id} attempt ${taskRuntime.builderAttempt} started${route ? ` on ${current.backend}/${current.model ?? "default"}${route.reason ? ` (${route.reason})` : ""}` : ""} at ${baseSha.slice(0, 8)} in ${worktree}.`,
    );
    const promise = builder({
      root,
      config,
      task,
      worktree,
      branch,
      baseSha,
      attempt: taskRuntime.builderAttempt,
      // Absent (no assignment), the lane builds exactly as before routing.
      ...(route ? {
        backend: route.backend,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        backendFallbackReason: route.fallback ? route.reason : null,
      } : {}),
      customInstructions,
      // Read at launch, not at run start: a lane that finishes at minute 10 and
      // records a finding must reach a lane that starts at minute 11. Reading
      // once into a closure would silently make the ledger useless for exactly
      // the case it exists for.
      ledgerNotes: ledgerFor(task.id),
      startGate,
      // Why the previous attempts on this ticket died. Read here rather than
      // inside the worker because the run directories are per attempt and this
      // is the only place that knows which attempt is starting. Null on attempt
      // 1, and null when every prior attempt never reached the API.
      priorAttempts: priorAttemptsFor({
        root,
        taskId: task.id,
        attempt: taskRuntime.builderAttempt,
      }),
      // Without this the worker's `NEEDS A HUMAN` line defaults to `console.log`
      // and reaches stdout only, never `.afk/agent-auto.log` — and a diagnosis
      // only one surface can see is not a diagnosis (AGENTS.md #7, #8).
      say,
      onPid: (pid) => {
        recordWorkerPid(state, task.id, pid);
        saveState(state);
      },
    }).then(
      (result) => ({ type: "builder", taskId: task.id, result }),
      // ENOSPC writing the lane's own records (`verification.json`) rejects
      // the builder; it becomes this lane's failure, not the run's (#144).
      (error) => {
        if (!isDiskFull(error)) throw error;
        return { type: "builder", taskId: task.id, diskFullError: error };
      },
    );
    activeBuilders.set(task.id, promise);
  };

  // Tasks waiting on their Codex quota read. Each holds its builder slot and
  // its scope claim for the whole wait (#292, defect 1): the scheduler's view
  // counts it as an active worker and not as runnable, so `maxParallel` and
  // scope exclusion hold exactly as if its lane had already started.
  const probingTasks = new Set();
  const withProbeReservations = (current) => probingTasks.size
    ? {
        ...current,
        activeWorkers: {
          ...current.activeWorkers,
          ...Object.fromEntries([...probingTasks].map((id) => [id, { taskId: id, pid: null, probing: true }])),
        },
        tasks: {
          ...current.tasks,
          ...Object.fromEntries([...probingTasks].map((id) => [id, { ...current.tasks[id], lifecycle: "running" }])),
        },
      }
    : current;

  // A routine task's builder retry runs on `critical`, never the other way.
  const escalation = (taskRuntime) => (taskRuntime?.builderAttempt ?? 0) >= 1
    ? `routine task's retry runs on critical (attempt ${taskRuntime.builderAttempt + 1})`
    : null;

  // A `routine` lane reads both providers' quota and takes the one with more
  // left. It holds its slot and scope claim while it reads, exactly as a
  // Codex lane does (`probingTasks`).
  const prepareRoutine = (task, startGate) => {
    probingTasks.add(task.id);
    const probe = (async () => {
      let quota;
      try {
        quota = await providerQuotaProbe();
      } catch (error) {
        const reason = `quota probe failed: ${error.message}`;
        quota = { claude: { allowed: false, reason }, codex: { allowed: false, reason } };
      }
      probingTasks.delete(task.id);
      activeBuilders.delete(task.id);
      if (halted) return { type: "dispatch" };
      const resolved = tierDispatch("routine", tiers, { quota });
      if (resolved.tier !== "routine") say(`AUTO: ${task.id}: ${resolved.reason}.`);
      launchBuilder(task, resolved.preferredBackend === "codex" ? null : startGate, null, resolved);
      return { type: "dispatch" };
    })();
    activeBuilders.set(task.id, probe);
  };

  const prepareBuilder = (task, startGate = null) => {
    const taskRuntime = state.tasks[task.id];
    const assignment = state.builderRouting?.assignments?.[task.id];
    // A tiered assignment names a tier, not a backend; it becomes one here,
    // at the moment the lane starts, from `routing.tiers` and live quota.
    let resolved = null;
    if (assignment?.tier) {
      const escalate = assignment.tier === "routine" ? escalation(taskRuntime) : null;
      if (assignment.tier === "routine" && !escalate) {
        prepareRoutine(task, startGate);
        return;
      }
      resolved = { ...tierDispatch(assignment.tier, tiers, { escalate }), ...(assignment.tier === "critical" ? { reason: assignment.reason } : {}) };
    }
    const route = builderRoute(resolved ?? assignment, {
      fallbackReason: taskRuntime?.codexFallbackReason ?? null,
    });
    if (route?.backend !== "codex") {
      launchBuilder(task, startGate, null, resolved);
      return;
    }
    probingTasks.add(task.id);
    const probe = (async () => {
      let quota;
      try {
        quota = await quotaProbe();
      } catch (error) {
        quota = { allowed: false, reason: `quota probe failed: ${error.message}` };
      }
      probingTasks.delete(task.id);
      activeBuilders.delete(task.id);
      if (halted) return { type: "dispatch" };
      // FAIL DIRECTION: a failed, timed-out or malformed read sends THIS lane to
      // Claude Opus and nothing else (#292, defect 2). It is a missing reading,
      // not a verdict on Codex, so the next Codex lane reads again.
      const allowed = quota?.allowed === true;
      const reason = allowed ? null : `${quota?.reason ?? "quota read returned nothing"}; this dispatch only`;
      if (!allowed) say(`AUTO: ${reason}; dispatching ${task.id} on Claude.`);
      launchBuilder(task, startGate, reason, resolved);
      return { type: "dispatch" };
    })();
    activeBuilders.set(task.id, probe);
  };

  // Several lanes starting together: launch the first, and hold the rest until
  // its first API response so they read the shared prompt prefix from cache
  // (worker.mjs `staggerGate`, bounded, never waits on a dead lane).
  // Claude only: `laneResponded` reads Claude's `"type":"assistant"` event, so
  // a Codex batch would always sit out the full cap for a cache it never reads.
  const launchBatch = (tasks) => {
    const [leader, ...followers] = tasks;
    if (!leader) return;
    const since = Date.now();
    prepareBuilder(leader);
    const leaderDone = activeBuilders.get(leader.id);
    // A leader still waiting on its quota read has not started anything yet.
    const leaderOnClaude = !probingTasks.has(leader.id)
      && state.tasks[leader.id]?.builderRuns?.at(-1)?.backend === "claude";
    const gate = followers.length && leaderDone && leaderOnClaude
      ? staggerGate({
          responded: () => laneResponded({
            runDir: builderRunDir(root, leader.id, state.tasks[leader.id].builderAttempt),
            worktree: state.tasks[leader.id].worktree,
            since,
          }),
          leaderDone,
        })
      : null;
    if (gate) say(`AUTO: staggering ${followers.length} lane(s) behind ${leader.id} until its first response (at most ${STAGGER_MAX_WAIT_MS / 1000}s).`);
    // A Codex follower never reads Claude's prompt cache, so it does not wait.
    // A routine follower decides its provider after its quota read, and drops
    // the gate there if it lands on Codex.
    for (const task of followers)
      prepareBuilder(task, builderRoute(state.builderRouting?.assignments?.[task.id])?.backend === "codex" ? null : gate);
  };

  // The ledger's read path. Never fatal: a corrupt or unreadable ledger costs
  // the lane its cross-lane context, which is strictly less bad than refusing to
  // start the lane at all over a log file.
  const ledgerFor = (taskId) => {
    try {
      return renderLedgerForPrompt(readLedger(root).entries, taskId);
    } catch (error) {
      say(`AUTO: could not read the epic ledger; lane ${taskId} starts without it — ${error.message}`);
      return null;
    }
  };

  let consecutiveFailures = 0;
  let infraFailures = 0;
  const recentFailures = [];
  let halted = null;
  // (#210) Set when the Infisical session is gone: no integration starts, and
  // the queued lanes stay `ready_to_integrate` for the rerun after a login.
  let infisicalHalt = false;
  // Returns "infra" when the breaker trips on a cluster of near-instant uniform
  // failures, "tasks" when it trips on a genuine run of bad tickets, and null
  // otherwise. The caller marks the ticket accordingly — an infra verdict leaves
  // it unmarked so a good ticket is never poisoned by a dead login.
  const recordOutcome = (taskId, terminal, durationMs, facts = {}) => {
    if (!terminal) {
      consecutiveFailures = 0;
      infraFailures = 0;
      recentFailures.length = 0;
      return null;
    }
    recentFailures.push({ taskId, durationMs, ...facts });
    // A lane that never reached the API failed the HARNESS, not its ticket —
    // which is why `infra_failed` leaves the ticket unmarked and a clean retry
    // usually passes. Charging it to the TICKET streak halted a real epic that
    // had exactly one terminal failure. So it goes on its OWN counter, which has
    // its own threshold: every terminal failure still advances one of the two,
    // which is what stops a dead harness burning every remaining lane.
    if (facts.neverReachedApi) infraFailures += 1;
    else consecutiveFailures += 1;
    if (halted) return null;
    const call = breakerVerdict({ recentFailures, consecutiveFailures, infraFailures });
    if (!call) return null;
    if (call.kind === "cluster") {
      halted = `${recentFailures.length} tasks failed in under ${INFRA_FAILURE_MS / 1000}s each (latest ${taskId})`;
      say(
        `AUTO: looks like infra, not tickets — ${recentFailures.length} unrelated tasks failed near-instantly and uniformly. Check auth/env (\`${auth.login}\`, required secrets). The tickets are left unmarked; scheduling no further builders.`,
      );
      return "infra";
    }
    if (call.kind === "harness") {
      halted = `${infraFailures} lanes never reached the API (latest ${taskId})`;
      say(
        `AUTO: ${halted}. Nothing is reaching the model, so none of this is about the tickets. Check auth/env (\`${auth.login}\`, required secrets). The tickets are left unmarked; scheduling no further builders.`,
      );
      return "infra";
    }
    halted = `${consecutiveFailures} tasks failed in a row (latest ${taskId})`;
    say(
      `AUTO: ${halted}. Likely a shared cause, not the tasks. Scheduling no further builders; draining what is in flight.`,
    );
    return "tasks";
  };

  // -------------------------------------------------------------------------
  // The supervisor — advisory, off the critical path
  // -------------------------------------------------------------------------
  //
  // scripts/supervisor.mjs judges six events. It OBSERVES; it does not own the
  // queue, and nothing below may let it. Three properties hold that line:
  //
  //  1. **Never on the critical path.** `observe` captures its context
  //     synchronously — at the exact moment the event fires, after the
  //     lifecycle assignment it observes — and then returns. The judgment runs
  //     on a serialized chain that the scheduler loop never awaits, so no
  //     builder start, integration dequeue or `schedulerDone` test ever waits
  //     behind a model session. The chain is drained once, after the loop.
  //  2. **Bounded.** `runSupervisor` bounds its own agent at the supervisor
  //     role's 180s `timeoutMs` (SIGTERM, then SIGKILL 5s later). That bound
  //     depends on the child's stdio reaching EOF, which an orphaned
  //     grandchild can delay indefinitely, so `observe` puts an outer wall
  //     clock over the whole call. On expiry the observation is abandoned; the
  //     child is already condemned and nothing waits for it.
  //  3. **Never fatal.** The module is loaded lazily through a catch, every
  //     call is wrapped, and the chain swallows rejections. A supervisor that
  //     is absent, throws, hangs, or is unauthenticated costs the run exactly
  //     one log line and nothing else.
  //
  // Proposed commands are PRINTED, never executed — see docs and the report.
  // Executing them would put gate release (`afk run`) and worktree destruction
  // (`afk reset`) under an LLM's discretion, which is the authority split this
  // whole design exists to keep.
  const SUPERVISOR_WALL_MS = 240_000;
  // "off" fires nothing at all; "never" still produces the runner's own
  // deterministic reading and its notification, for free, with no session;
  // "auto" (the default) and "always" are `shouldConsult`'s own vocabulary.
  const supervisorMode =
    process.env.AFK_SUPERVISOR
    ?? (config.supervisor === false ? "off" : config.supervisor?.consult)
    ?? "auto";
  let supervisorModule;
  const loadSupervisor = () => {
    supervisorModule ??= (supervisor
      ? Promise.resolve(supervisor)
      : import("./supervisor.mjs")
    ).then((module) => module, () => null);
    return supervisorModule;
  };
  // A compact projection of run state, not the state file: `evidence` is
  // JSON-stringified whole into the prompt, and `taskVerification` blobs would
  // reproduce the oversized-prompt failure the evidence budget exists to avoid.
  const runSnapshot = () => {
    try {
      return {
        tasks: Object.fromEntries(
          dag.tasks.map((task) => [task.id, lifecycleOf(task, state)]),
        ),
        inFlight: [...activeBuilders.keys()],
        integrating: state.activeIntegrator?.taskId ?? null,
        integrationQueue: [...(state.integrationQueue ?? [])],
      };
    } catch {
      return null;
    }
  };
  const supervisorEpic = () => {
    const value = state.epic ?? dag.epic ?? null;
    if (!value) return null;
    return typeof value === "object" ? value : { id: value, title: null };
  };
  // The evidence behind a `salvage` recommendation, captured at the moment it
  // is made. The worktree of a FAILED lane is retained on purpose (see
  // `finishIntegration`: only `passed` calls `removeTaskWorktree`), and a
  // terminal failure is the only lane failure the supervisor observes, so the
  // retry path's `resetTaskWorktree` can never have wiped what is recorded
  // here. Reading it is a `git status` in a directory nobody would think to
  // look in; this is what makes it findable.
  const recordSalvage = (decision) => {
    const taskId = decision.evidence?.taskId ?? null;
    const taskRuntime = taskId ? state.tasks?.[taskId] : null;
    const worktree = taskRuntime?.worktree ?? null;
    if (!worktree || !existsSync(worktree)) return false;
    let paths = [];
    // Never fatal, and never silent: a lane whose status cannot be read is
    // still worth naming by path.
    try {
      // `runs/` and the rest of `isBookkeeping` is the runner's own output, not
      // the lane's — the same filter `runBuilder` uses for `producedFiles`.
      // Listing it here would bury the two files a human came to look at.
      paths = changedPaths(worktree).filter((file) => !isBookkeeping(file, config));
    } catch (error) {
      say(`AUTO: could not read lane ${taskId}'s worktree status — ${error.message}`);
    }
    (state.salvage ??= {})[taskId] = {
      at: new Date().toISOString(),
      worktree,
      branch: taskRuntime.branch ?? null,
      paths,
      why: decision.answer ?? decision.reasoning ?? null,
    };
    say(
      `AUTO: supervisor recommends SALVAGING lane ${taskId}. Its work is uncommitted in ${worktree}`
      + `${paths.length ? ` — ${paths.join(", ")}` : " (nothing uncommitted there)"}.`
      + " The worktree is retained; nothing is committed, merged or PR'd for you.",
    );
    return true;
  };

  let supervisorChain = Promise.resolve();
  let blockedSupervisorPending = false;
  const observe = (event, context) => {
    if (event === "onLaneBlocked") blockedSupervisorPending = true;
    // "off" is the only mode that fires nothing. The other three are
    // `shouldConsult`'s vocabulary and are handed straight through, so "never"
    // still yields the runner's own deterministic reading without a session.
    if (supervisorMode === "off") return supervisorChain;
    supervisorChain = supervisorChain.then(async () => {
      const s = await loadSupervisor();
      if (typeof s?.[event] !== "function") return;
      let timer;
      const decision = await Promise.race([
        s[event]({ root, config, consult: supervisorMode, ...context }),
        new Promise((resolveRace) => {
          timer = setTimeout(() => resolveRace(null), SUPERVISOR_WALL_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!decision) {
        say(`AUTO: supervisor (${event}) did not answer within ${SUPERVISOR_WALL_MS / 1000}s; ignored.`);
        return;
      }
      // A cached decision is an earlier session's answer; its switch was logged then.
      if (!decision.reused) sayModelSwitch(`supervisor (${event})`, decision.modelCheck);
      const taskId = decision.evidence?.taskId ?? context.taskId ?? null;
      const taskRuntime = taskId ? state.tasks?.[taskId] : null;
      const interpretedLifecycle = typeof s.supervisorLifecycle === "function"
        ? s.supervisorLifecycle(decision, taskRuntime?.lifecycle)
        : decision.lifecycle;
      let lifecycleChanged = false;
      if (taskRuntime?.lifecycle === "blocked" && interpretedLifecycle === "no-op") {
        taskRuntime.lifecycle = "no-op";
        const task = dag.tasks.find((candidate) => candidate.id === taskId);
        if (task) queueStatus(task, "no-op");
        lifecycleChanged = true;
        say(`AUTO: supervisor confirmed ${taskId} is a no-op; recorded terminal no-op.`);
      }
      const note = s.supervisorNotification(decision);
      if (note) notify(note.title, note.message, decision.event, decision.evidence?.taskId ?? null);
      const { commands, refused } = s.supervisorCommands(decision, { dagPath });
      say(
        `AUTO: supervisor (${event}) — \`${decision.classification}\` (${decision.confidence}), recommends \`${decision.recommendation}\`.`,
      );
      if (decision.answer) say(`AUTO: supervisor says: ${decision.answer}`);
      // Advisory only. These are printed for a human to run, never spawned.
      for (const entry of commands) {
        say(`AUTO: supervisor proposes \`afk ${entry.argv.join(" ")}\`${entry.why ? ` — ${entry.why}` : ""} (advisory; not run).`);
      }
      // And onto the surface a human actually types. The log line above is the
      // only place two epics' correct diagnoses ever appeared, and neither human
      // saw one while it still mattered.
      const record = supervisorRecord(decision, commands, {
        taskLifecycle: state.tasks?.[taskId]?.lifecycle ?? null,
        // (#179) A run-wide note expires on any task's move (`supervisorAdvice`).
        runLifecycles: taskId ? null : runSnapshot()?.tasks ?? null,
      });
      if (record) {
        // Two keys, deliberately. `state.supervisor` stays the LATEST record as
        // an object because `supervisorAdvice` (scripts/scheduler.mjs, via `afk
        // status`) reads it that way and shows one live diagnosis — turning it
        // into an array would silently break the one surface an operator types.
        // `state.supervisorLog` is the append-only history that fix exists for.
        state.supervisor = record;
        const appended = appendSupervisorObservation(state.supervisorLog, record);
        state.supervisorLog = appended.list;
        if (appended.dropped)
          say(
            `AUTO: supervisor log is at its ${SUPERVISOR_LOG_MAX}-record cap; dropped the ${appended.dropped} oldest observation(s). The full transcripts are under .afk/supervisor/.`,
          );
      }
      // A `salvage` verdict names work that exists only as uncommitted files in
      // a lane worktree. Record what and where, now, while the supervisor is
      // still holding the reason. Never commits, never integrates, never opens
      // a PR — the lane failed its gate and that judgment is a human's.
      const salvaged = decision.recommendation === "salvage" && recordSalvage(decision);
      if (record || salvaged || lifecycleChanged) saveState(state);
      for (const entry of refused) {
        say(`AUTO: supervisor asked for \`${entry.command}\` — refused: ${entry.why}`);
      }
    }).catch((error) => {
      // Includes an unimportable module, a thrown entry point and a notifier
      // that blew up. None of them is the run's problem.
      try {
        say(`AUTO: supervisor (${event}) failed; ignored — ${error?.message ?? error}`);
      } catch {
        // Even the log line is optional.
      }
    });
    return supervisorChain;
  };

  const retryDelay = (rateLimit, taskRuntime) => {
    const resetMs =
      typeof rateLimit?.resetsAt === "number"
        ? rateLimit.resetsAt * 1000 - Date.now() + 30_000
        : LIMIT_FALLBACK_MS;
    const delay = Math.max(1000, Math.min(LIMIT_MAX_SLEEP_MS, resetMs));
    taskRuntime.rateLimitWaitedMs = (taskRuntime.rateLimitWaitedMs ?? 0) + delay;
    return delay;
  };

  // Stop the agent a recorded lane (or integrator) still has running, before
  // its record is cleared. Throws when it will not stop; see the callers.
  const stopRecordedAgent = (lanes, label) => {
    for (const fate of teardownRecordedLanes(lanes)) {
      // ESRCH: it had already exited, which is the outcome wanted.
      if (/ESRCH/.test(fate.fate)) {
        say(`AUTO: ${label} pid ${fate.pid} had already exited.`);
        continue;
      }
      say(`AUTO: stopped ${label} pid ${fate.pid} after a full disk: ${fate.fate}.`);
      // A signal that failed any other way (EPERM) proves nothing about the
      // process, so liveness is asked directly, and alive is fatal.
      if (fate.fate === "still running after SIGTERM" || (fate.fate.startsWith("signal failed") && processAlive(fate.pid)))
        throw new Error(`${label} pid ${fate.pid} is still running (${fate.fate}); refusing to reuse its worktree.`);
    }
  };
  // A full disk is infra, not the ticket (#144). The lane is left
  // `infra_failed` — unmarked, like a dead login — and counted on the harness
  // streak, so a disk that stays full halts new work after two lanes and drains
  // the rest, where it used to kill the orchestrator on the first. Fail
  // direction: the lane, never the process.
  const failLaneOnFullDisk = (taskId, error, where) => {
    activeBuilders.delete(taskId);
    // The builder's promise rejecting does not mean its agent exited: a
    // `saveState` inside `onPid` can throw ENOSPC while the detached agent
    // runs on. Clearing the pid without stopping it, then rebuilding the task,
    // put two agents in one worktree with the first untracked. So the recorded
    // pid is stopped the way a fatal stops it, and one that will not stop is
    // fatal. Fail direction: closed. An orphan writing into a lane the runner
    // is about to reset is worse than ending the run.
    stopRecordedAgent({ activeWorkers: { [taskId]: state.activeWorkers[taskId] } }, `builder ${taskId}`);
    clearWorkerPid(state, taskId);
    const taskRuntime = state.tasks[taskId];
    const line = diskFullLine(error);
    taskRuntime.lifecycle = "infra_failed";
    taskRuntime.diskFull = { at: new Date().toISOString(), where, message: line };
    say(
      `AUTO: builder ${taskId} hit a full disk during ${where} — ${line}. Left unmarked (infra_failed); free space, then \`afk reset ${taskId}\`.`,
    );
    recordOutcome(taskId, true, 0, { neverReachedApi: true });
    saveState(state);
  };
  // The two retry paths below reset the lane, which re-runs its bootstrap — the
  // `npm ci` that hit ENOSPC on epic #865 was a retry's.
  const resetForRetry = (taskId, taskRuntime) => {
    try {
      resetTaskWorktree({
        worktree: taskRuntime.worktree,
        baseSha: taskRuntime.baseSha,
        root,
        setup: config.worktreeSetup,
      });
      return true;
    } catch (error) {
      if (!isDiskFull(error)) throw error;
      failLaneOnFullDisk(taskId, error, "the retry's worktree reset");
      return false;
    }
  };

  const finishBuilder = ({ taskId, result, diskFullError }) => {
    if (diskFullError) {
      // The teardown hook first, as every other outcome gets it below: the
      // lane's simulator or container outlives a full disk as it does a pass.
      sayHooks(taskId, teardownWorktree({ worktree: state.tasks[taskId]?.worktree, setup: config.worktreeSetup }));
      failLaneOnFullDisk(taskId, diskFullError, "a record write");
      return;
    }
    activeBuilders.delete(taskId);
    const task = dag.tasks.find((candidate) => candidate.id === taskId);
    const taskRuntime = state.tasks[taskId];
    clearWorkerPid(state, taskId);
    // The backend and model this attempt ACTUALLY ran on, from the lane's own
    // record, kept per attempt so a fallback never overwrites the first try.
    const thisRun = taskRuntime.builderRuns?.at(-1) ?? null;
    if (thisRun) {
      const ran = result.verification?.agent;
      if (ran?.backend) thisRun.backend = ran.backend;
      if (ran?.model) thisRun.model = ran.model;
      thisRun.outcome = result.outcome;
    }
    if (result.verification?.agentStillRunning) {
      // FAIL DIRECTION: closed. The Herdr pane could not be proven stopped, so
      // no teardown hook, no reset and no retry runs against a lane another
      // agent may still be writing. A human stops the pane first.
      taskRuntime.lifecycle = "infra_failed";
      halted = `builder ${taskId} agent is still running in its Herdr pane`;
      say(
        `AUTO: builder ${taskId} was not retried because its Herdr agent is still running. `
        + `Stop the recorded pane before resetting or reusing ${taskRuntime.worktree}.`,
      );
      saveState(state);
      return;
    }
    // Before the outcome is read, because every outcome arrives here — a lane
    // whose builder died leaves its simulator booted exactly as a passed one
    // does — and before the retry paths reset the worktree the hook runs in.
    sayHooks(taskId, teardownWorktree({ worktree: taskRuntime.worktree, setup: config.worktreeSetup }));
    // A Codex lane that named its usage limit, or whose login is gone, is
    // retried on Claude Opus (#292). It is a retry like any other, so it spends
    // the ordinary builder retry budget, and it is this task's fallback only:
    // other Codex lanes keep their route.
    // Never over a lane that wrote outside itself: that halts, below, with the
    // evidence left where it is.
    const codexLaneFallback = thisRun?.backend === "codex" && !result.verification?.wroteOutsideLane
      && (result.quotaRejected || result.verification?.quotaRejected || result.verification?.authFailure)
      ? (result.verification?.authFailure
        ? "Codex login failed (run `codex login`); retried on Claude Opus"
        : "Codex reported its usage limit exhausted; retried on Claude Opus")
      : null;
    if (codexLaneFallback) taskRuntime.codexFallbackReason = codexLaneFallback;
    // #73: before the outcome branches decide retry-or-fail, LABEL a deadline
    // kill that did real work. The retry/attempt accounting below is deliberately
    // unchanged — the failure just has to read as its own event, so `timedOut`
    // rides the recorded outcome into state.json and one log line names the clock.
    // A lane that timed out but still passed its checks (`ready_to_integrate`) or
    // is being retried for a rate limit is not this event.
    const clock = timeoutOutcome(result.verification, agentConfig(config).timeoutMs);
    if (clock && result.outcome !== "ready_to_integrate" && result.outcome !== "rate_limited") {
      taskRuntime.timedOut = true;
      say(`AUTO: builder ${taskId} ${clock.note}`);
    }
    if (result.outcome === "ready_to_integrate") {
      Object.assign(taskRuntime, {
        lifecycle: "ready_to_integrate",
        commitSha: result.commitSha,
        taskVerification: compactVerification(result.verification),
      });
      enqueueIntegration(state, taskId);
      say(
        `AUTO: builder ${taskId} passed worktree checks and committed ${result.commitSha.slice(0, 8)}; queued for integration.`,
      );
      // (#215) An earlier attempt went red on its own check and this one fixed
      // it: a defect caught mid-run, owed the lesson this builder was asked for.
      const laneDefect = recordLaneDefect(state, { taskId, taskRuntime, verification: result.verification, attempt: taskRuntime.builderAttempt });
      if (laneDefect)
        say(`AUTO: builder ${taskId}'s retry fixed its red lane check \`${laneDefect.command}\`; recorded as a mid-run defect (${laneDefect.lesson ? "lesson given" : "Lesson: missing"}).`);
    } else if (codexLaneFallback && shouldRetryBuilder(taskRuntime.builderAttempt, maxBuilderRetries)) {
      taskRuntime.lifecycle = "pending";
      taskRuntime.retryAt = Date.now();
      // Persisted before the reset can fail or the process die: a restart must
      // not send this lane back to the Codex that just refused it.
      saveState(state);
      if (resetForRetry(taskId, taskRuntime))
        say(`AUTO: builder ${taskId} on Codex failed: ${codexLaneFallback}.`);
    } else if (result.outcome === "rate_limited" && !codexLaneFallback) {
      const delay = retryDelay(result.rateLimit, taskRuntime);
      if (taskRuntime.rateLimitWaitedMs > LIMIT_TOTAL_MAX_MS) {
        taskRuntime.lifecycle = "failed";
        queueStatus(task, "failed");
        say(`AUTO: builder ${taskId} exceeded the 12h rate-limit wait cap.`);
      } else {
        taskRuntime.lifecycle = "pending";
        taskRuntime.retryAt = Date.now() + delay;
        taskRuntime.builderAttempt--;
        if (resetForRetry(taskId, taskRuntime))
          say(
            `AUTO: builder ${taskId} rate-limited; retrying independently in ${Math.ceil(delay / 60000)}m.`,
          );
      }
    } else if (result.outcome === "blocked" && !codexLaneFallback && neverReachedApi(result.verification)) {
      // A lane that never reached the API did not refuse its ticket. Two lanes
      // died at 114,456ms and 114,711ms — a quarter-second apart on a 900s
      // timeout, so a fixed deadline in the runtime, not two flukes — with zero
      // tokens in and out and no files, and both were recorded as `blocked`,
      // which reads as "the builder looked at this and had nothing to do". Both
      // passed on a clean retry.
      //
      // `looksLikeInfra` already catches the fast version of this, but it needs
      // a CLUSTER of sub-second failures across unrelated tasks; this is one
      // lane, slow, and certain on its own evidence. The ticket is left unmarked
      // and `infra_failed` does not block dependants, so `afk reset` is the
      // whole recovery.
      taskRuntime.lifecycle = "infra_failed";
      say(
        `AUTO: builder ${taskId} exited ${result.verification?.agentExitCode ?? 0} after ${result.verification?.durationMs ?? "?"}ms having spent no tokens — it never reached the API, so this is infra, not the ticket. Left unmarked; \`afk reset ${taskId}\` to retry.`,
      );
      recordOutcome(taskId, true, result.verification?.durationMs, {
        neverReachedApi: true,
      });
    } else if (result.outcome === "blocked" && !codexLaneFallback) {
      taskRuntime.lifecycle = "blocked";
      queueStatus(task, "blocked");
      // Two causes, one lifecycle, and the log line has to say which: "produced
      // no source change" printed over a reverted package.json is the diagnosis
      // that sent a human looking at the builder instead of at the revert.
      const invalidated = result.verification?.checksInvalidated ?? [];
      say(
        invalidated.length
          ? `AUTO: builder ${taskId} had ${invalidated.join(", ")} reverted, so its checks ran against a tree that file no longer describes; marked blocked rather than passed. Make the edit by hand or allow it in \`protectedEdits\`.`
          : `AUTO: builder ${taskId} produced no source change; marked blocked.`,
      );
      recordOutcome(taskId, true, result.verification?.durationMs);
      observe("onLaneBlocked", {
        taskId,
        task,
        verification: result.verification,
        epic: supervisorEpic(),
        branch: taskRuntime.branch ?? null,
      });
    } else if (result.verification?.authFailure && !codexLaneFallback) {
      // A certain infra diagnosis — the session transcript says the login
      // expired. Leave the ticket unmarked, reset attempts, halt immediately:
      // every further lane would die the same way.
      taskRuntime.lifecycle = "infra_failed";
      taskRuntime.builderAttempt = 0;
      halted = `the ${auth.cli} login expired mid-run (run \`${auth.login}\`, then rerun)`;
      say(
        `AUTO: builder ${taskId} died on an expired ${auth.cli} login; scheduling no further builders.`,
      );
    } else if (gatesUseInfisical && gateLostInfisicalSession(result.verification)) {
      // (#210) A gate red on Infisical's "No valid login session found" is the
      // login, not the code: the lane keeps its reset (attempts back to 0), the
      // ticket is left unmarked, and no further builders start, since every
      // gate that calls `infisical run` would fail the same way.
      taskRuntime.lifecycle = "infra_failed";
      taskRuntime.builderAttempt = 0;
      halted = halted ?? "the Infisical login expired";
      say(`AUTO: builder ${taskId}'s gate failed on an expired Infisical session (infra, not the ticket); scheduling no further builders. Run \`infisical login\`, then rerun.`);
    } else if (result.verification?.wroteOutsideLane) {
      // A lane boundary crossing is not a flake, and it must not go down the
      // retry path: `resetTaskWorktree` below would discard this lane's work
      // while the file the builder wrote OUTSIDE the lane stays exactly where
      // it is — destroying the evidence and keeping the escape. So it halts,
      // like an expired login, and a human looks. docs/findings.md 3.15.
      taskRuntime.lifecycle = "failed";
      queueStatus(task, "failed");
      const crossings = result.verification.wroteOutsideLane
        .map((entry) => `${entry.tool} -> ${entry.path}`);
      // Epic-wide, not lane-wide. The builder may have written INTO another
      // lane, so every other lane's work is suspect too; scheduling more
      // builders on top of that buries the one event worth looking at.
      halted = `builder ${taskId} wrote outside its worktree (${crossings.join(", ")})`;
      say(
        `AUTO: builder ${taskId} WROTE OUTSIDE ITS LANE and was stopped. ` +
        `Nothing was committed and the lane is left as it is. Inspect and remove by hand:\n  ` +
        crossings.join("\n  "),
      );
    } else if (shouldRetryBuilder(taskRuntime.builderAttempt, maxBuilderRetries)) {
      // (#215) Held until a later attempt passes; a lane that never does
      // records no defect, it fails.
      noteLaneDefect(taskRuntime, { verification: result.verification, attempt: taskRuntime.builderAttempt });
      taskRuntime.lifecycle = "pending";
      taskRuntime.retryAt = Date.now();
      if (resetForRetry(taskId, taskRuntime))
        say(`AUTO: builder ${taskId} failed; retrying with a fresh agent process.`);
    } else {
      say(`AUTO: builder ${taskId} failed after ${maxBuilderRetries} ${maxBuilderRetries === 1 ? "retry" : "retries"}.`);
      if (recordOutcome(taskId, true, result.verification?.durationMs) === "infra") {
        // Suspected environmental failure: leave the ticket unmarked. It never got
        // a fair run, so marking it failed would poison a good ticket and block
        // its dependants. Reset the attempt count so a rerun past preflight gets a
        // clean build.
        taskRuntime.lifecycle = "infra_failed";
        taskRuntime.builderAttempt = 0;
      } else {
        taskRuntime.lifecycle = "failed";
        queueStatus(task, "failed");
      }
      // After `recordOutcome` and after the lifecycle assignment, so the
      // supervisor can never race a transition it does not own. `recentFailures`
      // is the breaker's live window; it is copied, not handed over, because the
      // judgment runs later and the window keeps mutating.
      observe("onLaneFailed", {
        taskId,
        task,
        attempt: taskRuntime.builderAttempt,
        verification: result.verification,
        recentFailures: [...recentFailures],
        epic: supervisorEpic(),
        branch: taskRuntime.branch ?? null,
      });
    }
    saveState(state);
  };

  const startIntegrator = () => {
    const infisical = infisicalNow();
    if (infisical) {
      infisicalHalt = true;
      halted = halted ?? "the Infisical login expired";
      say(`AUTO: ${infisical}`);
      say("AUTO: no integration gate started; queued lanes stay ready_to_integrate for the rerun.");
      return;
    }
    const taskId = dequeueIntegration(state);
    const task = dag.tasks.find((candidate) => candidate.id === taskId);
    const taskRuntime = state.tasks[taskId];
    taskRuntime.integrationAttempt = (taskRuntime.integrationAttempt ?? 0) + 1;
    taskRuntime.lifecycle = "integrating";
    taskRuntime.integrationRetryAt = null;
    const integrationBase = currentBaseSha(root, baseBranch);
    state.activeIntegrator = {
      taskId,
      pid: null,
      branch: taskRuntime.branch,
      worktree: taskRuntime.worktree,
      baseSha: taskRuntime.baseSha,
      attempt: taskRuntime.integrationAttempt,
      integrationBase,
    };
    saveState(state);
    say(
      `AUTO: integrator ${taskId} attempt ${taskRuntime.integrationAttempt} started from ${integrationBase.slice(0, 8)}.`,
    );
    activeIntegrator = integrate({
      root,
      config,
      epic: normalizeId(dag.epic?.id ?? null),
      say,
      task,
      baseBranch,
      branch: taskRuntime.branch,
      baseSha: taskRuntime.baseSha,
      attempt: taskRuntime.integrationAttempt,
      taskVerification: taskRuntime.taskVerification,
      onPid: (pid, recordedBase) => {
        state.activeIntegrator.pid = pid;
        state.activeIntegrator.integrationBase = recordedBase;
        saveState(state);
      },
      onCheckRerun: (command, reason) => say(
        `AUTO: integration ${taskId}: ${reason}; the merge was clean, so re-running the failed check once on the same merged tree.`,
      ),
    }).then(
      (result) => ({ type: "integration", taskId, result }),
      // A full disk mid-integration (#144, epic #874: ENOSPC writing
      // `verification.json`) fails this integration, not the run: main goes
      // back to its pre-merge base exactly as a failed merge's does, and the
      // ordinary retry-then-`integration_failed` path takes it from there.
      (error) => {
        if (!isDiskFull(error)) throw error;
        // A merger that may still be writing is stopped before main is reset
        // under it, for the same reason a builder is (`failLaneOnFullDisk`).
        stopRecordedAgent({ activeIntegrator: state.activeIntegrator }, `integrator ${taskId}`);
        const base = state.activeIntegrator?.integrationBase ?? integrationBase;
        // Fail direction: open, but said. A restore that fails here leaves main
        // half-merged, which is bad, but throwing would kill the scheduler
        // over a disk it cannot free; the next start's restore path
        // (`reconcileStaleState` → `restoreMain`) retries it, and this line is
        // the record a human reads first.
        try {
          restoreMain(root, base);
        } catch (restoreError) {
          say(`AUTO: could not restore ${baseBranch} to ${base} after integrator ${taskId} hit a full disk — ${restoreError.message}`);
        }
        return {
          type: "integration",
          taskId,
          result: { outcome: "disk_full", error, integrationBase: base, verification: null },
        };
      },
    );
  };

  // Serializes the per-merge PR refreshes below against each other.
  let prRefresh = Promise.resolve();

  const finishIntegration = ({ taskId, result }) => {
    activeIntegrator = null;
    state.activeIntegrator = null;
    const task = dag.tasks.find((candidate) => candidate.id === taskId);
    const taskRuntime = state.tasks[taskId];
    // Post-merge checks run in the root checkout, so that is where the hook runs.
    if (!result.verification?.agentStillRunning)
      sayHooks(taskId, teardownWorktree({ worktree: root, setup: config.worktreeSetup }));
    sayModelSwitch(`integrator for ${taskId}`, result.verification?.modelCheck);
    recordIntegratorModelCheck(taskRuntime, result.verification?.modelCheck);
    // (#179) Every post-merge re-run, with what the first red looked like, where
    // `afk status` reads it. The full first output stays in verification.json.
    for (const rerun of result.verification?.checkReruns ?? []) {
      recordGateRerun(state, {
        kind: "integration", at: new Date().toISOString(), taskId, headSha: result.verification.resultingHead ?? null,
        command: rerun.command, firstExitCode: rerun.firstCode ?? null,
        classification: rerun.classification ?? null, confidence: rerun.confidence ?? null,
        evidence: rerun.evidence ?? [], passed: rerun.passed,
      });
    }
    if (result.verification?.agentStillRunning) {
      // FAIL DIRECTION: closed, as for a builder. integrate.mjs left the
      // checkout as the merger had it rather than reset it under a live agent.
      taskRuntime.lifecycle = "infra_failed";
      halted = `integrator ${taskId} agent is still running in its Herdr pane`;
      say(
        `AUTO: integration ${taskId} was not retried because its Herdr merger is still running. `
        + "Stop the recorded pane before restoring or reusing the checkout.",
      );
    } else if (result.outcome === "disk_full") {
      // Infra, not the ticket, and consistent with the builder path: no
      // `integration_failed` in the progress table, the harness streak rather
      // than the ticket streak, and no retry this run on the same full disk.
      // The lane stays `ready_to_integrate` off the queue rather than going to
      // `infra_failed`, because `infra_failed` is REBUILT, and a rebuild resets
      // the lane's committed branch to base. A restart re-queues it from the
      // branch alone (the startup pass after the worktree sweep), so deleting
      // the lane directory to free space cannot strand it. This run exits
      // non-zero while any lane is parked here, so no wrapper reads it as done.
      const line = diskFullLine(result.error);
      taskRuntime.lifecycle = "ready_to_integrate";
      taskRuntime.integrationAttempt = Math.max(0, (taskRuntime.integrationAttempt ?? 1) - 1);
      taskRuntime.diskFull = { at: new Date().toISOString(), where: "integration", message: line };
      say(
        `AUTO: integration ${taskId} hit a full disk — ${line}. ${baseBranch} restored; the lane is kept ready_to_integrate and not retried this run. Free space, then restart.`,
      );
      recordOutcome(taskId, true, 0, { neverReachedApi: true });
    } else if (result.outcome === "passed") {
      taskRuntime.lifecycle = "passed";
      taskRuntime.integrationBase = result.integrationBase;
      taskRuntime.integratedHead = result.head;
      queueStatus(task, "passed");
      flushStatuses();
      // Never throws (#144): the merge above is recorded and flushed, so a
      // cleanup failure is a warning and a retry on the next start, not a death.
      const cleanup = removeTaskWorktree({
        root,
        id: taskId,
        branch: taskRuntime.branch,
        setup: config.worktreeSetup,
      });
      sayHooks(taskId, cleanup.hooks);
      recordCleanup(taskRuntime, cleanup);
      // Herdr lane cleanup mirrors worktree retention: passed closes the
      // workspace; failures keep it open beside the retained worktree.
      closeHerdrLane(root, taskId).catch(() => {});
      say(
        `AUTO: ${taskId} integrated and passed post-merge verification; ${cleanup.removed ? "worktree removed" : "worktree NOT removed (retried on next start)"}${cleanup.branchDeleted ? " and branch deleted" : ""}${cleanup.warning ? ` — ${cleanup.warning}` : ""}.`,
      );
      // Push the merge and re-render the PR now, not at epic end. The branch
      // used to sit unpushed for the whole run, so the PR showed "N pending"
      // and no commits while lanes landed one after another, and a human who
      // opened it mid-run saw a run that looked like it had not started. It is
      // also the moment CI has something to run against.
      //
      // Chained rather than awaited: `finishIntegration` is synchronous and on
      // the scheduler's path, and a slow `gh` must not hold the next lane. Two
      // merges landing close together would otherwise race two `git push`es
      // over one branch. `refreshEpicPr` never throws.
      if (pr === PR_EACH) prRefresh = prRefresh.then(() => refreshEpicPr());
      recordOutcome(taskId, false);
    } else if (result.outcome === "rate_limited") {
      const delay = retryDelay(result.rateLimit, taskRuntime);
      taskRuntime.integrationRateLimitWaitedMs =
        (taskRuntime.integrationRateLimitWaitedMs ?? 0) + delay;
      if (taskRuntime.integrationRateLimitWaitedMs > LIMIT_TOTAL_MAX_MS) {
        taskRuntime.lifecycle = "integration_failed";
        queueStatus(task, "integration_failed");
        flushStatuses();
        say(
          `AUTO: integration ${taskId} exceeded the 12h rate-limit wait cap; branch/worktree retained.`,
        );
      } else {
        taskRuntime.lifecycle = "ready_to_integrate";
        taskRuntime.integrationRetryAt = Date.now() + delay;
        taskRuntime.integrationAttempt--;
        enqueueIntegration(state, taskId);
        say(
          `AUTO: merger ${taskId} rate-limited; main restored and retry scheduled independently in ${Math.ceil(delay / 60000)}m.`,
        );
      }
    } else if (gatesUseInfisical && gateLostInfisicalSession(result.verification)) {
      // (#210) Infra, not the merge. Kept `ready_to_integrate` and queued
      // rather than `infra_failed`, which would rebuild the committed lane
      // (the same reasoning as `disk_full` above); no integration starts again
      // this run.
      taskRuntime.lifecycle = "ready_to_integrate";
      taskRuntime.integrationAttempt = Math.max(0, (taskRuntime.integrationAttempt ?? 1) - 1);
      enqueueIntegration(state, taskId);
      infisicalHalt = true;
      halted = halted ?? "the Infisical login expired";
      say(`AUTO: integration ${taskId} failed on an expired Infisical session (infra, not the merge); ${baseBranch} restored and the lane kept ready_to_integrate. Run \`infisical login\`, then rerun.`);
      recordOutcome(taskId, true, 0, { neverReachedApi: true });
    } else {
      // The reason travels in the log line. It used to live only in
      // verification.json, so an integration failed by one stray untracked file
      // looked identical to one failed by a genuinely broken merge.
      const why = result.failureReason ? ` — ${result.failureReason}` : "";
      const swept = result.removed?.length
        ? ` Removed ${result.removed.length} file(s) the merger left behind: ${result.removed.join(", ")}.`
        : "";
      // A failed check that already had its second run on the clean merged
      // tree (#176) is not retried whole: a fresh merger rebuilds the same tree.
      if (taskRuntime.integrationAttempt <= MAX_INTEGRATION_RETRIES && !result.checkRerun) {
        taskRuntime.lifecycle = "ready_to_integrate";
        enqueueIntegration(state, taskId);
        say(
          `AUTO: integration ${taskId} failed${why}; main restored, retrying with a fresh merger.${swept}`,
        );
      } else {
        taskRuntime.lifecycle = "integration_failed";
        taskRuntime.integrationBase = result.integrationBase;
        queueStatus(task, "integration_failed");
        flushStatuses();
        say(
          result.verification?.checks?.some((check) => check.timedOut)
            ? `AUTO: integration ${taskId} failed${why}; a timed-out check is not retried. Branch/worktree retained.${swept}`
            : result.checkRerun
            ? `AUTO: integration ${taskId} failed${why}, again after it re-ran the failed check on the same merged tree; branch/worktree retained.${swept}`
            : `AUTO: integration ${taskId} failed after ${MAX_INTEGRATION_RETRIES} retry${why}; branch/worktree retained.${swept}`,
        );
        // (#215) A check red twice on the same merged tree, not read as the
        // environment, found a real defect the lane's gate let through. It is
        // owed a lesson like any fixer finding; the salvage that fixes it
        // supplies one, and the closeout lists it either way.
        const found = recordIntegrationDefect(state, {
          taskId, verification: result.verification, laneVerification: taskRuntime.taskVerification ?? null,
        });
        if (found) {
          say(`AUTO: integration ${taskId} found a defect on \`${found.defect.command}\`; recorded as a mid-run defect that needs a lesson (\`afk salvage ${taskId} --lesson=...\`).`);
          if (found.laneLacks) say(`AUTO: ${taskId}: lane checks lack \`${found.laneLacks}\` — the lane's own gate never ran the check that caught this at integration.`);
        }
        recordOutcome(taskId, true);
        observe("onIntegrationFailed", {
          taskId,
          task,
          attempt: taskRuntime.integrationAttempt,
          verification: result.verification,
          failureReason: result.failureReason,
          removed: result.removed,
          integrationBase: result.integrationBase,
          epic: supervisorEpic(),
          branch: taskRuntime.branch ?? null,
        });
      }
    }
    saveState(state);
  };

  // -------------------------------------------------------------------------
  // Epic close
  // -------------------------------------------------------------------------
  //
  // Idempotence, stated plainly: the whole block below is guarded on
  // `close.lifecycle === "closed"`, so a restart after a close does nothing at
  // all — no second verifier run, no second issue comment, no second render.
  // Belt and braces underneath that: `runVerifier({ reuse: true })` returns the
  // report already on disk under `.afk/verifier/<epic>/` even if the state file
  // were lost, and the issue comment carries an `<!-- afk:closeout:<id> -->`
  // marker so a duplicate is at least identifiable. The one way to close twice
  // is a REOPEN, which is an explicit, logged transition (see below).
  const closeDir = resolve(afkDir, "epic-close", String(state.epic?.id ?? state.epic ?? "epic"));
  // `editUrl` edits a comment this runner posted before, in place — the minors
  // checklist of a close that was reopened (`postMinorsToIssue`).
  const postComment = commentOnEpic
    ?? (({ epicId, path, editUrl = null }) => {
      const commentId = editUrl?.match(/#issuecomment-(\d+)$/)?.[1];
      return commentId
        ? run(`gh api -X PATCH ${shellQuote(`repos/{owner}/{repo}/issues/comments/${commentId}`)} -F ${shellQuote(`body=@${path}`)} --jq .html_url`, { cwd: root })
        : run(`gh issue comment ${shellQuote(epicId)} --body-file ${shellQuote(path)}`, { cwd: root });
    });

  const reopenIfWorkResumed = () => {
    if (close.lifecycle === "open") return;
    if (epicOutcome(dag, state).status !== "in_progress") return;
    close.history ??= [];
    close.history.push({
      lifecycle: close.lifecycle,
      outcome: close.outcome,
      reason: close.reason,
      closedAt: close.closedAt,
      // The four records cleared below. Kept here because clearing them is only
      // safe if the superseded close survives somewhere: what run 1 was told is
      // how you read what run 2 did differently, and epic #391 lost that when a
      // relaunch overwrote the previous attempt in place.
      verifier: close.verifier ?? null,
      closeout: close.closeout ?? null,
      fixer: close.fixer ?? null,
      reflection: close.reflection ?? null,
      sweep: close.sweep ?? null,
      // Kept so the next close edits this comment instead of adding a second.
      minorsComment: close.minorsComment ?? null,
      reopenedAt: new Date().toISOString(),
    });
    // Every artifact of the close, not the two that were easiest to name. A
    // reopened epic used to keep `fixer` and `reflection` from the close it is
    // superseding: epic #391 was relaunched after a human reverted a lane's
    // refusal, and carried forward a fix report about the reverted commit and a
    // reflection written against the branch before it. `history` above keeps
    // the superseded record; nothing is lost by clearing the live one.
    Object.assign(close, {
      lifecycle: "open",
      outcome: null,
      reason: null,
      closedAt: null,
      verifier: null,
      closeout: null,
      fixer: null,
      reflection: null,
      sweep: null,
      unpassedLanes: null,
      minorsComment: null,
      enteredAt: new Date().toISOString(),
    });
    say("AUTO: the epic has runnable work again; reopening the closed epic record.");
    saveState(state);
  };

  /**
   * The verifier, run once, at epic end (docs/epic-schema.md, roles table).
   *
   * It is READ-ONLY and ADVISORY. `verifierDecision` returns a recommendation
   * and never a lifecycle, and this function never lets one become one:
   *
   *   clean | inconclusive          → outcome `completed`
   *   must-fix | criteria-unmet     → outcome `completed_with_findings`
   *   verifier unavailable / threw  → outcome `completed`, `skipped` recorded
   *
   * In every case the epic closes. The verifier cannot complete an epic (a
   * human's acceptance and the passing of every gate did that) and it cannot
   * block one either — a review that could halt the runner would be a gate that
   * writes to the thing it gates, which docs/epic-schema.md rejects.
   */
  const runCloseoutVerifier = async (outstanding) => {
    if (!state.epic?.id && !state.epic) {
      return { report: null, skipped: "this run has no epic id (the `--dag=` seam), so there is nothing to review against" };
    }
    try {
      const report = await verify({
        root,
        config,
        dag,
        branch: dag.branch ?? baseBranch,
        baseBranch: epicBase,
        outstanding,
        reuse: true,
      });
      // A reused report is an earlier session's review; its switch was logged then.
      if (!report?.reused) sayModelSwitch("closeout verifier", report?.modelCheck);
      return { report, skipped: null };
    } catch (error) {
      return { report: null, skipped: `the verifier could not run: ${error.message}` };
    }
  };

  /** What the epic still owes, in the words the review should be labelled with. */
  const outstandingWork = (outcome) => [
    ...(outcome.failed ?? []).map((id) => `${id} did not pass`),
    ...(outcome.pending ?? []).map((id) => `${id} never ran`),
    ...(outcome.awaiting ?? []).map((id) => `${id} awaits human acceptance`),
  ];

  /**
   * Run the closeout review because the epic STOPPED — not because it succeeded.
   *
   * It used to be gated on `outcome.status === "complete"`, and the line
   * `verifier did not run — the epic closed incomplete, so there was nothing
   * complete to review` fired on six of six overnight epics. This is the only
   * step in the pipeline that reads the integrated branch against the child
   * issues, so gating it on completeness meant the runs that most needed a
   * review were exactly the ones that never got one: the run it skipped shipped
   * a data-loss bug, another a bypassable feature gate, another a mutex that
   * aborted a live recorder. None were catchable by a check suite; all were
   * catchable by reading the code once.
   *
   * Two properties are preserved deliberately:
   *
   *  - it stays ADVISORY. The recommendation still never becomes a lifecycle,
   *    and `close.outcome` below is computed from the DAG, not from this.
   *  - it can never halt the runner. `runVerifier` never throws, the call is
   *    wrapped anyway, and every failure lands as `skipped` text.
   *
   * It also runs for an epic PARKED on acceptance, before the human accepts —
   * the only order in which the review can inform the acceptance.
   *
   * @returns {Promise<object|null>} the report, or null when it could not run
   */
  const ensureCloseoutVerifier = async (outcome) => {
    const outstanding = outstandingWork(outcome);
    say(outstanding.length
      ? `AUTO: the epic stopped with ${outstanding.join("; ")}; reviewing what actually integrated.`
      // Says only what is known BEFORE the review: the DAG drained. It used to
      // read as a verdict on the epic and was then followed, in the same log, by
      // a `must-fix` recommendation with two blockers.
      : "AUTO: every task passed and every gate is accepted; the branch has not been reviewed yet — running the closeout verifier.");
    let report = null;
    let skipped = null;
    let decision = null;
    try {
      // `reuse: true` inside: a review already on disk for this epic is
      // returned rather than re-run, so parking on acceptance and then closing
      // costs one review, not two.
      ({ report, skipped } = await runCloseoutVerifier(outstanding));
      decision = report ? verifierDecision(report) : null;
    } catch (error) {
      report = null;
      skipped = `the verifier could not run: ${error.message}`;
    }
    close.verifier = report
      ? {
          recommendation: decision.recommendation,
          blocking: decision.blocking,
          notes: decision.notes,
          ranAt: report.ranAt ?? null,
          // The commit the review read, so `--accept` can tell a review at the
          // branch head from one that predates the last integration.
          head: report.head ?? null,
          reportPath: report.artifacts?.report ?? null,
          outstanding,
        }
      : { recommendation: null, skipped, outstanding };
    saveState(state);
    if (skipped) say(`AUTO: verifier did not run — ${skipped}.`);
    return report;
  };

  /**
   * One bounded fix pass over the verifier's findings, then nothing else.
   *
   * Never throws and never changes the epic's outcome — same contract as the
   * verifier, for the same reason: an agent that could turn its own work into a
   * lifecycle would be the honor-system gate docs/epic-schema.md rejects. It
   * only makes the branch better before a human reads it, and says what it left.
   *
   * `reuse: true` so a close that happens twice across a restart costs one pass.
   *
   * Whatever the pass does, the branch it leaves behind is gated below before
   * this returns — see `gateCloseoutFix`.
   */
  const runCloseoutFixer = async (report) => {
    // Read BEFORE the pass, and outside the try: it is the only way to tell
    // afterwards whether the fixer committed, and a pass that dies mid-commit
    // still has to be gated.
    const headBefore = headSha(root);
    let fixReport = null;
    // `unparseable` too: its prose still carries findings (#142).
    if (report && (report.status === "ok" || report.status === "unparseable")) {
      try {
        const { runFixer, renderFixerOutcome, fixerStateRecord } = await import("./fixer.mjs");
        fixReport = await runFixer({
          root,
          config,
          dag,
          branch: state.branch ?? dag.branch ?? null,
          baseBranch: epicBase ?? "main",
          verifierReport: report,
          skipTasks: unpassedTaskIds(dag, state),
          reuse: true,
          ...(fixAgent ? { runAgent: fixAgent } : {}),
        });
        const line = fixReport ? renderFixerOutcome(fixReport) : null;
        if (line) say(`AUTO: ${line}`);
        sayModelSwitch("closeout fixer", fixReport?.modelCheck);
        // The partitioned shape, from fixer.mjs's own helpers — never a length
        // counted here. See `fixerStateRecord`.
        close.fixer = fixerStateRecord(fixReport);
        saveState(state);
      } catch (error) {
        say(`AUTO: the closeout fix pass could not run (${error.message}); every finding is left for you.`);
        fixReport = null;
      }
    }
    // THE FIX PASS'S OWN `head`, when there is one, because `headBefore` above
    // is wrong across exactly one restart — the one that matters. Kill the
    // runner between the fixer's commit and the gate's write, and on the way
    // back up the fixer's `reuse` returns its report and commits nothing, so
    // `headBefore` is read AFTER the commit, matches HEAD, and the gate records
    // "the fix pass committed nothing" over the one ungated commit on the
    // branch — quillnote wave-34's shape with an artifact asserting it is fine.
    // `runFixer` reads its `head` before the agent runs, so a reused report
    // still carries the pre-fix sha. On the ordinary path the two are equal.
    await gateCloseoutFix(fixReport?.head ?? headBefore);
    return fixReport;
  };

  /**
   * Re-run the project's check chain over whatever the fix pass just committed.
   *
   * The gap this closes (#78): the fix pass commits AFTER the gates that just
   * passed, so in the wave that produced it nothing ever checks it. The next
   * wave's baseline normally covers it by accident — the last wave of a run has
   * no next wave, and quillnote wave-34 shipped exactly that tip.
   *
   * Never throws, and deliberately does not change `close.outcome`: see the
   * stated fail direction on `runCloseoutGate`. The gate reports; the DAG and
   * the verifier still decide.
   */
  const gateCloseoutFix = async (headBefore) => {
    let gate = null;
    try {
      const { runCloseoutGate } = await import("./fixer.mjs");
      // From the judgment layer directly. fixer.mjs re-exported this purely so
      // this line could hop through it, which made a Middle Man of the module
      // that runs the checks.
      const { renderCloseoutGateLine } = await import("./wave-driver.mjs");
      gate = await runCloseoutGate({
        root,
        config,
        epicId: normalizeId(dag.epic?.id ?? null),
        headBefore,
        say,
        // The same chain `integrate.mjs` re-runs after a merge, and the same one
        // the run's own baseline ran: `baselineChecks ?? defaultChecks`.
        runChecks: ({ commands, cwd }) => runBaselineChecks({
          commands,
          cwd,
          timeoutMs: config.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS,
          say,
          label: "closeout fix gate check",
        }),
      });
      say(`AUTO: ${renderCloseoutGateLine(gate)}`);
    } catch (error) {
      // A gate that could not run is an UNGATED tip, which is the whole thing
      // this exists to make visible. Record it as such rather than as silence.
      gate = { status: "unavailable", problem: error.message, head: headSha(root), fixSha: null };
      // ONTO DISK, not only into state. The wave digest reads `gate.json` and
      // nothing else, so an unwritten record renders as "n/a — no fix pass ran"
      // over a tip that ran a pass and gated none of it — the one case #78's
      // criterion names, silent on the unsafe side. `runCloseoutGate` persists
      // its own unavailable verdict; reaching here means it never got that far.
      try {
        const { writeCloseoutGate } = await import("./fixer.mjs");
        writeCloseoutGate(root, normalizeId(dag.epic?.id ?? null), gate);
      } catch { /* fixer.mjs will not load; `close.fixGate` below is all that is left */ }
      say(`AUTO: the closeout fix gate could not run (${error.message}); the branch tip is unverified.`);
    }
    close.fixGate = gate;
    saveState(state);
    return gate;
  };

  /**
   * The run's reflection, written into the RUNNER's repository.
   *
   * Last on this path, and after the fix pass, because it reads that pass's
   * report as evidence. Never throws, and never blocks the close: a run whose
   * reflection failed is a run that happened, with a document missing.
   *
   * It writes no commit anywhere. The file lands in a different repository from
   * the one this run touched, and the operator commits it.
   */
  const runCloseoutReflection = async (outcome) => {
    try {
      const { runReflector, renderReflectionOutcome } = await import("./reflect.mjs");
      const result = await runReflector({
        root,
        config,
        dag,
        branch: state.branch ?? dag.branch ?? null,
        outcome: close.outcome ?? outcome?.status ?? "unknown",
        reason: close.reason ?? null,
      });
      say(`AUTO: ${renderReflectionOutcome(result)}`);
      sayModelSwitch("reflector", result?.modelCheck);
      close.reflection = result
        ? { ok: result.ok, path: result.path, bytes: result.bytes, reused: result.reused ?? false }
        : null;
      saveState(state);
      return result;
    } catch (error) {
      say(`AUTO: the reflection could not be written (${error.message}).`);
      return null;
    }
  };

  /**
   * The run's account, as a PR COMMENT.
   *
   * Not the body. `renderPrBody` is a projection of run state that the runner
   * overwrites on every refresh and never reads back, so a closeout written
   * there is deleted by the next render with nothing to show it existed. Five
   * separate epic reflections reached that conclusion independently before it
   * was ever code (docs/reflection/voice-studio/epic-{1,4,5,47}.md,
   * docs/reflection/brightpath/epic-1.md).
   *
   * A failure here is a warning. The closeout is on disk and the epic is closed
   * either way — the same rule scripts/pr.mjs holds for the draft PR itself.
   */
  const commentOnPr = async ({ what, marker, body, file }) => {
    try {
      const { findEpicPr } = await import("./pr.mjs");
      const branch = state.branch ?? dag.branch ?? null;
      const repo = currentRepo(root);
      const pr = branch && repo ? findEpicPr({ repo, branch, cwd: root }) : null;
      const path = resolve(closeDir, file);
      atomicWrite(path, `${marker}\n\n${body.trim()}\n`);
      if (!pr) {
        say(`AUTO: no pull request for this branch, so the ${what} was not posted; it is at ${path}.`);
        return false;
      }
      const posted = run(
        `gh pr comment ${shellQuote(String(pr.number))} --repo ${shellQuote(repo)} --body-file ${shellQuote(path)}`,
        { cwd: root },
      );
      if (posted.status === 0) {
        say(`AUTO: ${what} posted as a comment on PR #${pr.number}.`);
        return true;
      }
      say(`AUTO: could not comment on PR #${pr.number} (${(posted.stderr ?? "").trim().slice(0, 200)}); the ${what} is at ${path}.`);
      return false;
    } catch (error) {
      say(`AUTO: could not post the ${what} (${error.message}).`);
      return false;
    }
  };

  const postRunAccount = async ({ markdown, fixReport }) => {
    const { renderFixerMarkdown } = await import("./fixer.mjs");
    return commentOnPr({
      what: "run account",
      marker: `<!-- afk:run-account:${state.epic?.id ?? state.epic ?? "epic"} -->`,
      body: `${markdown.trim()}\n\n${renderFixerMarkdown(fixReport).trim()}`,
      file: "pr-comment.md",
    });
  };

  /**
   * The reflection, as its own comment. Read from the file the reflector wrote
   * rather than from anything it said: the document IS the output, and a
   * summary of it in the agent's final message is a second, unverified copy.
   */
  const postReflection = async (result) => {
    if (!result?.ok) return false;
    let body;
    try {
      body = readFileSync(result.path, "utf8");
    } catch {
      say(`AUTO: the reflection at ${result.path} could not be read back; it was not posted.`);
      return false;
    }
    // Folded, and the longest thing on the PR by some margin — last night's
    // ran 52, 54, 145 and 194 lines of agent prose, all of it unfolded, all of
    // it below a review a human is actually there to read. The run account is
    // read BEFORE merging; the reflection is read when the same thing goes
    // wrong again, which is a different day. So it keeps its own comment and
    // gives that day's reader one line until they want it.
    //
    // The headline survives the fold: the reflector's first paragraph is its
    // own summary of the run, so it goes in the summary line and the reader
    // learns what the reflection concluded without expanding anything.
    const lines = body.trim().split("\n");
    const title = (lines.find((line) => line.startsWith("# ")) ?? "").replace(/^#\s*/, "").trim();
    const gist = lines.find((line) => line.trim() && !line.startsWith("#")) ?? "";
    return commentOnPr({
      what: "reflection",
      marker: `<!-- afk:reflection:${state.epic?.id ?? state.epic ?? "epic"} -->`,
      body: [
        `**${title || "Reflection"}** — _what this run taught the runner, not what the branch does._`,
        "",
        `> ${gist.trim().slice(0, 400)}${gist.trim().length > 400 ? "…" : ""}`,
        "",
        details({
          summary: `Full reflection — ${lines.length} lines`,
          body: body.trim(),
        }),
        "",
        "---",
        `_Written by the runner to \`${result.path}\`; commit it there if you want to keep it._`,
      ].join("\n"),
      file: "pr-reflection.md",
    });
  };

  // Push-and-render, from both places a run can stop. An epic that parks on a
  // `gate: after` used to render its body only at feature-branch creation, so
  // it stayed frozen at "N pending" for as long as the human took — precisely
  // the window in which someone opens the PR, because the run is waiting on
  // them. `ensureDraftPr` resolves branch → PR by asking GitHub and holds no
  // local memory, so calling it twice is safe and idempotent.
  const refreshEpicPr = async (verifierReport) => {
    try {
      const { applyPrDelivery, ensureDraftPr, renderPrOutcome } = await import("./pr.mjs");
      const outcome = ensureDraftPr({
        root,
        repo: currentRepo(root),
        branch: state.branch ?? dag.branch ?? baseBranch,
        baseBranch: epicBase ?? "main",
        epic: state.epic ?? {},
        dag,
        state,
        verifierReport: verifierReport ?? undefined,
      });
      const line = renderPrOutcome(outcome);
      if (line) say(`AUTO: ${line}`);
      for (const warning of outcome.warnings ?? []) say(`AUTO: ${warning}`);
      // (#179) A refused push or a failed PR creation is state, not a log line:
      // #489 closed with its push refused by a pre-push hook, no PR, and a
      // closeout that read as finished. `afk status` and the epic_ended reading
      // both read this; the next delivery that lands clears it.
      if (applyPrDelivery(state, outcome)) saveState(state);
    } catch (error) {
      // Same rule as everywhere else this runner touches GitHub: a warning,
      // never a halt. The run's own state is on disk regardless.
      say(`AUTO: could not refresh the epic's draft PR (${error.message}).`);
    }
  };

  /**
   * Put the rendered closeout on the epic issue, and record that it landed.
   *
   * Separate from `closeEpic` because it is the one step of a close that can
   * fail on its own and be worth retrying: `gh` rate-limits, the network drops,
   * the process is killed between `saveState` and here. Everything before it is
   * on disk and costs a session to redo; this costs one API call.
   *
   * Idempotent on `issueCommentedAt` rather than on the lifecycle, which is why
   * it can be called from the already-closed path below.
   */
  const postCloseoutToIssue = (markdown) => {
    const epicId = state.epic?.id ?? state.epic ?? null;
    if (!epicId || !close.closeout || close.closeout.issueCommentedAt) return;
    const commentPath = resolve(closeDir, "issue-comment.md");
    atomicWrite(commentPath, `<!-- afk:closeout:${epicId} -->\n\n${markdown}`);
    const posted = postComment({ epicId: String(epicId), path: commentPath, body: markdown, root });
    if (posted?.status === 0) {
      close.closeout.issueCommentedAt = new Date().toISOString();
      delete close.closeout.issueCommentError;
      say(`AUTO: closeout posted to epic #${epicId}.`);
    } else {
      close.closeout.issueCommentError = (posted?.stderr ?? "gh issue comment failed").trim().slice(0, 400);
      // A GitHub failure is a warning, never a halt: the closeout is on disk
      // and the epic is closed either way. Same rule scripts/pr.mjs follows.
      say(`AUTO: could not comment on epic #${epicId} (${close.closeout.issueCommentError}); the closeout is at ${close.closeout.path}.`);
    }
    saveState(state);
  };

  /**
   * The never-queued minor findings, as ONE checklist comment on the epic
   * issue (#145), in two steps so no failure loses it.
   *
   * `stageMinors` writes the checklist and records it as owed
   * (`postedAt: null`) when the closeout is rendered, before anything is
   * posted — so a crash, or a `gh` 502, between the closeout's comment and this
   * one leaves a record the re-entry path in `closeEpic` retries. A close after
   * a reopen edits the comment the superseded close posted (its record is in
   * `close.history`) rather than adding a second checklist; if that close left
   * no minors, the old checklist is edited to say so.
   *
   * A failure is a warning, as every GitHub call here is.
   */
  const stageMinors = (report) => {
    const epicId = state.epic?.id ?? state.epic ?? null;
    if (!epicId) return;
    const editUrl = [...(close.history ?? [])].reverse().find((entry) => entry.minorsComment?.url)?.minorsComment.url ?? null;
    const body = renderMinorsComment(report)
      ?? (editUrl ? "### No minor findings remain\n\nThe latest closeout review of this epic left none.\n" : null);
    if (!body) return;
    const path = resolve(closeDir, "issue-minors.md");
    atomicWrite(path, `<!-- afk:minors:${epicId} -->\n\n${body}`);
    close.minorsComment = { postedAt: null, path, ...(editUrl ? { editUrl } : {}) };
  };

  // Said when a re-entry does NOT retry an owed checklist because the branch
  // moved under it, so the debt is visible rather than silently parked.
  const sayMinorsStillOwed = () => {
    const owed = close.minorsComment;
    if (!owed || owed.postedAt || !existsSync(owed.path)) return;
    say(`AUTO: the minor findings checklist is still owed to the epic issue; it is at ${owed.path} and is not being posted, because the branch has moved since the review it lists.`);
  };

  const postMinorsToIssue = () => {
    const epicId = state.epic?.id ?? state.epic ?? null;
    const owed = close.minorsComment;
    if (!epicId || !owed || owed.postedAt || !existsSync(owed.path)) return;
    const body = readFileSync(owed.path, "utf8").replace(/^<!-- afk:minors:[^>]*-->\n\n/, "");
    let editUrl = owed.editUrl ?? null;
    let posted = postComment({ epicId: String(epicId), path: owed.path, body, root, editUrl });
    // The comment to edit was deleted: post a fresh one rather than lose it.
    if (editUrl && posted?.status !== 0 && /\b404\b|not found/i.test(`${posted?.stderr ?? ""}${posted?.stdout ?? ""}`)) {
      say(`AUTO: the minor findings comment ${editUrl} is gone; posting a new one.`);
      editUrl = null;
      posted = postComment({ epicId: String(epicId), path: owed.path, body, root, editUrl: null });
    }
    if (posted?.status === 0) {
      const url = editUrl ?? String(posted.stdout ?? "").match(/https:\/\/\S+#issuecomment-\d+/)?.[0] ?? null;
      close.minorsComment = { ...owed, postedAt: new Date().toISOString(), url };
      delete close.minorsComment.error;
      if (!editUrl) delete close.minorsComment.editUrl;
      say(`AUTO: never-queued minor findings ${editUrl ? "updated on" : "posted to"} epic #${epicId} as a checklist.`);
    } else {
      const error = (posted?.stderr ?? "gh issue comment failed").trim().slice(0, 400);
      close.minorsComment = { ...owed, error };
      say(`AUTO: could not post the minor findings to epic #${epicId} (${error}); they are at ${owed.path} and are retried on the next run.`);
    }
    saveState(state);
  };

  /**
   * One commit removing `.afk-runs/<id>/` and `.agents/evidence/<id>/` for this
   * epic's tasks (#110). Default on; `sweepRunArtefacts: false` in
   * `.afk-setup/config.yaml` keeps them. Never throws and never changes the
   * outcome: a sweep that could not run leaves the branch as every epic before
   * it closed, with the artefacts still tracked.
   */
  const sweepEpicArtefacts = async () => {
    let sweep = null;
    try {
      const { renderSweepLine, sweepRunArtefacts } = await import("./sweep.mjs");
      sweep = config.sweepRunArtefacts === false
        ? null
        : sweepRunArtefacts({
            root,
            epicId: normalizeId(dag.epic?.id ?? null),
            ids: dag.tasks.map((task) => normalizeId(task.id)),
          });
      say(`AUTO: ${renderSweepLine(sweep)}`);
    } catch (error) {
      sweep = { removed: [], commit: null, problem: error.message };
      say(`AUTO: run artefacts could not be swept (${error.message}); they are still on the branch.`);
    }
    close.sweep = sweep;
    saveState(state);
    return sweep;
  };

  /**
   * Close the herdr workspace hosting the integrator, once the runner is about
   * to exit with no integrator to follow. The parent workspace was never closed
   * by anything: `closeHerdrLane` reaps lanes at integration, and the only
   * thing that returned the integrator's pane to its shell prompt was the next
   * integrator to reuse it. The epic's last one sat at its claude prompt for
   * good — one orphan TUI and permission broker (~420 MB) per closed epic
   * (#111). Two exits qualify: the close, and the `awaiting_acceptance` park,
   * which can hold for days before a human accepts. A reopen rebuilds the
   * parent on demand (`parentPane`), so closing it early costs nothing.
   *
   * Ungated on the runtime, like `closeHerdrLane`: the registry is the signal,
   * and an epic run under herdr then relaunched `--runtime=direct` still owns
   * its pane. `closeHerdrEpic` never throws and counts only what closed, so a
   * refused reap reads as 0 here and again in `afk finish`.
   */
  const reapIntegratorPane = async () => {
    const reaped = await closeHerdrEpic(root);
    if (reaped) say(`AUTO: herdr: closed ${reaped.panes} pane(s), ${reaped.workspaces} workspace(s).`);
  };

  /**
   * `afk close --redo` (#213): the same verifier and fix pass the close runs,
   * at the branch's current head, so `afk merge` judges the head that would
   * ship. The superseded records go onto `close.redos`, and the reports on
   * disk are copied beside them before they are overwritten (#140). Posts
   * nothing to the issue; the merge guards read state and the reports.
   */
  const redoCloseout = async (outcome) => {
    const epicId = normalizeId(dag.epic?.id ?? state.epic?.id ?? null);
    const stamp = new Date().toISOString();
    const keptDir = resolve(closeDir, "redo", stamp.replace(/[:.]/g, "-"));
    const kept = [];
    try {
      const { verifierReportPath } = await import("./verifier.mjs");
      const { fixerReportPath, closeoutGatePath } = await import("./fixer.mjs");
      for (const [name, path] of [
        ["verifier-report.json", verifierReportPath(root, epicId)],
        ["fixer-report.json", fixerReportPath(root, epicId)],
        ["fix-gate.json", closeoutGatePath(root, epicId)],
      ]) {
        if (!existsSync(path)) continue;
        ensureDir(keptDir);
        atomicWrite(resolve(keptDir, name), readFileSync(path, "utf8"));
        kept.push(resolve(keptDir, name));
      }
    } catch (error) {
      say(`AUTO: the earlier closeout reports could not be copied (${error.message}); their state records are still kept.`);
    }
    close.redos ??= [];
    close.redos.push({
      verifier: close.verifier ?? null,
      fixer: close.fixer ?? null,
      fixGate: close.fixGate ?? null,
      reports: kept,
      supersededAt: stamp,
    });
    saveState(state);
    say(`AUTO: redoing the closeout of epic ${epicId ?? "(no id)"} at ${String(headSha(root) ?? "unknown").slice(0, 12)}; the earlier review is kept in state.epicClose.redos.`);
    const report = await ensureCloseoutVerifier(outcome);
    await runCloseoutFixer(report);
    say(`AUTO: closeout redone — review of ${String(close.verifier?.head ?? "unknown").slice(0, 12)}${close.verifier?.recommendation ? ` recommends \`${close.verifier.recommendation}\`` : ""}. \`afk merge\` now judges this head.`);
  };

  const closeEpic = async (outcome) => {
    if (close.lifecycle === "closed" && redoClose) {
      await redoCloseout(outcome);
      return;
    }
    if (close.lifecycle === "closed") {
      // A close that rendered its closeout and then died — or whose `gh` call
      // failed — left the epic terminal with its account never delivered. Epic
      // #391's second close did exactly that: `issueCommentedAt: null`, no
      // "closeout posted" line, and the issue left carrying the FIRST run's
      // verdict about a commit that had since been reverted. Retry the one step
      // that did not land. Nothing else is re-run: no second review, no second
      // fix pass, and `closedAt` does not move.
      // `existsSync` because a re-entry can happen after `afk archive` has moved
      // `.afk/` away, or in a checkout that never had it. Without the guard the
      // retry turns a benign "already closed" into a crash on the one path that
      // exists to be forgiving.
      if (close.closeout && !close.closeout.issueCommentedAt && existsSync(close.closeout.path)) {
        // Only if it still describes the branch. Between the failed post and
        // now, a human can have committed — and with every task still `passed`,
        // `reopenIfWorkResumed` sees no runnable work and never regenerates it.
        // Posting anyway would put a confident verdict about an older branch on
        // the issue, which is the exact failure this whole retry exists to undo.
        const now = headSha(root);
        if ((close.closeout.head ?? null) !== (now ?? null)) {
          say(
            `AUTO: the epic is closed and its closeout never reached the issue, but the branch has moved since it was written (${close.closeout.head ?? "unknown"} → ${now ?? "unknown"}); it is at ${close.closeout.path} and is not being posted. \`afk verify\` to review the branch as it stands.`,
          );
          sayMinorsStillOwed();
          return;
        }
        say("AUTO: the epic is closed but its closeout never reached the issue; posting it now.");
        postCloseoutToIssue(readFileSync(close.closeout.path, "utf8"));
        postMinorsToIssue();
        return;
      }
      // Same retry, for the minors checklist: owed and never posted, and still
      // about the branch as it stands.
      if (
        close.minorsComment && !close.minorsComment.postedAt && existsSync(close.minorsComment.path)
        && (close.closeout?.head ?? null) === (headSha(root) ?? null)
      ) {
        say("AUTO: the epic is closed but its minor findings never reached the issue; posting them now.");
        postMinorsToIssue();
        return;
      }
      sayMinorsStillOwed();
      say(`AUTO: epic already closed (${close.outcome}); leaving the closeout untouched.`);
      return;
    }
    // The review a human accepted over is still the binding one when only the
    // runner's status commits have landed since, so it is read back rather
    // than re-run: a re-run is a fresh, nondeterministic review, and every
    // acceptance commits the progress table. Anything that cannot be read back
    // exactly — no file, a different run — is reviewed again.
    const storedReview = () => {
      if (!reviewIsCurrent()) return null;
      const stored = readVerifierReport(root, normalizeId(dag.epic?.id ?? state.epic?.id ?? null));
      if (!stored || !isSameReview({ head: close.verifier.head, ranAt: close.verifier.ranAt ?? null }, stored)) return null;
      say(`AUTO: the closeout review of ${String(stored.head).slice(0, 12)} still describes the branch (only the runner's status commits since); using it rather than re-running it.`);
      return { ...stored, reused: true };
    };
    const report = storedReview() ?? await ensureCloseoutVerifier(outcome);
    const decision = report ? verifierDecision(report) : null;
    // A must-fix review voids every sign-off that was not given over this exact
    // review: the gate goes back to awaiting_acceptance and the epic parks
    // instead of closing, before the fixer can edit what was signed (#145, epic
    // #715). Fails closed: an acceptance with no recorded review (forced, or
    // from a runner before this) is reopened too. It cannot loop, because the
    // review a human accepts over is the one read back above as long as only
    // status commits land after it.
    if (outcome.status === "complete" && decision?.recommendation === "must-fix") {
      const reopened = gateAfterTasks(dag).map((task) => task.id)
        .filter((id) => ["human", "delegate"].includes(close.acceptances?.[id]?.by)
          && !isSameReview(acceptanceReview(id), report));
      if (reopened.length) {
        for (const id of reopened) {
          // Kept, not just deleted: the measure row counts every sign-off given.
          (close.voidedAcceptances ??= []).push({ id, ...close.acceptances[id] });
          delete close.acceptances[id];
          state.tasks[id].lifecycle = AWAITING_ACCEPTANCE;
          state.pendingStatusUpdates[id] = AWAITING_ACCEPTANCE;
        }
        close.lifecycle = "awaiting_acceptance";
        close.enteredAt = new Date().toISOString();
        close.reason = `the closeout review after acceptance recommends must-fix; ${reopened.join(", ")} await a human again`;
        saveState(state);
        if (pr !== PR_OFF) prRefresh = prRefresh.then(() => refreshEpicPr(report));
        await reapIntegratorPane();
        await prRefresh;
        say(
          `AUTO: the closeout review recommends \`must-fix\` (${decision.blocking.join("; ")}), and it is not the review gate(s) ${reopened.join(", ")} were accepted over. They are back to awaiting_acceptance. Read the review, then --accept=${reopened.join(",")} again.`,
        );
        // The same event the park fires: the run stopped on a person. Without
        // it the supervisor's next word is the epic ending.
        observe("onGateReached", {
          taskIds: reopened,
          gate: "after",
          titles: reopened.map((id) => dag.tasks.find((task) => task.id === id)?.title ?? null),
          epic: supervisorEpic(),
          branch: dag.branch ?? baseBranch,
          run: runSnapshot(),
        });
        return;
      }
    }
    // One bounded pass over what the review found, BEFORE the PR is rendered and
    // before anything is posted — so the body describes the branch as it will be
    // read, and the comment can say what was fixed rather than only what was
    // wrong. It never throws and it cannot change `close.outcome` below: an epic
    // with findings is `completed_with_findings` whether or not they were fixed,
    // because the fixer did not review its own work and nothing has re-judged it.
    const fixReport = await runCloseoutFixer(report);
    // The epic's own run artefacts come off the run branch HERE and nowhere
    // earlier: the verifier above resolved `.afk-runs/**.json` as evidence off
    // this working tree, and the fix gate inside `runCloseoutFixer` has run
    // over the branch. Task branches are never touched, so the crash sweep at
    // the top of this run still finds its verification note on any lane an
    // `incomplete` close left alive. Scoped to this epic's ids — a sibling epic
    // in the same repo is still reading its own. Ordering constraints: sweep.mjs.
    // Unchanged, and deliberately: the verifier's opinion can turn a completed
    // epic into `completed_with_findings` and can do nothing else. An incomplete
    // epic is incomplete because the DAG says so, however clean the review was.
    close.outcome = outcome.status === "complete"
      ? (decision && ["must-fix", "criteria-unmet"].includes(decision.recommendation)
        ? "completed_with_findings"
        : "completed")
      : "incomplete";
    close.reason = outcome.reason;
    // `??=`: a close killed mid-sweep re-enters with the same `closedAt`, so
    // `once` below finds its marker and writes no second row.
    close.closedAt ??= new Date().toISOString();
    saveState(state);
    // The measure row BEFORE the sweep (#177 story 2), so it is computed from
    // the run as it ended. `lifecycle` stays open until after the sweep: a
    // close killed mid-sweep must re-enter the full path and sweep again.
    await appendCloseRow({ root, once: true, say });
    await sweepEpicArtefacts();
    close.lifecycle = "closed";

    close.unpassedLanes = unpassedLanes({ root, dag, state });
    stageMinors(report);
    const closeoutPath = resolve(closeDir, "closeout.md");
    // With the fix report, so an item repaired above renders as done rather
    // than as an unticked to-do the human then goes looking for.
    const markdown = renderCloseout(dag, state, report, fixReport);
    atomicWrite(closeoutPath, markdown);
    // `head` so the retry below can tell "this never got posted" from "this
    // never got posted and is now about a branch that has moved on".
    close.closeout = {
      path: closeoutPath,
      renderedAt: new Date().toISOString(),
      head: headSha(root),
      issueCommentedAt: null,
    };
    saveState(state);

    // The epic's draft PR, refreshed here as well as at feature-branch creation.
    // At creation the branch is usually IDENTICAL to its base and GitHub refuses
    // to open a PR at all — so for an epic that finishes in one run, that was the
    // only attempt and no PR ever existed. The first live epic (#3) closed having
    // opened none, printing "it will be opened on the next run" six times.
    // By close there are always commits, and the verifier's report exists to
    // render into the body.
    // After any per-merge refresh still in flight, so the last render is this
    // one and carries the closeout review.
    if (pr !== PR_OFF) {
      prRefresh = prRefresh.then(() => refreshEpicPr(report));
      await prRefresh;
    }

    // The run's account goes in a PR COMMENT, never the body: the body is
    // re-rendered from run state on every refresh and never read back, so
    // anything written there is overwritten without trace. Five reflections
    // reached that conclusion separately before it was ever written down.
    await postRunAccount({ markdown, fixReport });
    // Second comment, not appended to the first. The account above is about the
    // CODE and is read before merging; this is about the RUN and is read when
    // the same thing goes wrong again. One comment carrying both would be
    // scrolled past by whichever reader came for the other half.
    await postReflection(await runCloseoutReflection(outcome));
    postCloseoutToIssue(markdown);
    postMinorsToIssue();
    saveState(state);
    // Last, after every step that could still want a pane.
    await reapIntegratorPane();
    say(`AUTO: epic closed — ${close.outcome}: ${close.reason}`);
    if (close.outcome === "completed_with_findings") {
      // It used to end "The work is merged and accepted", which is the one
      // thing a close never establishes: `afk finish` prints the merge command
      // and refuses to run it, so every epic ends on an unmerged branch and the
      // supervisor's own summary two lines later said so.
      say(
        `AUTO: the closeout review recommends \`${close.verifier.recommendation}\` (${close.verifier.blocking.join("; ")}). These items are yours, on the branch and unmerged. See ${closeoutPath}.`,
      );
    }
  };

  // The rest of the stretch before the scheduler, under the same cleanup.
  try {
    reopenIfWorkResumed();

    say(
      `AUTO: continuous scheduler started (maxParallel=${Math.max(1, Number(config.maxParallel) || 1)}${baseBranch !== "main" ? `, base ${baseBranch}` : ""}${explicitTaskId ? `, explicit task ${explicitTaskId}` : ""}).`,
    );

    // The previous run's fatal record describes a process that is gone, and this
    // run has now got past every gate that can refuse it (preflight, disk,
    // baseline), so it is the restart the record asked for. Cleared here and not
    // at startup: a refused restart must leave the record for `afk status`.
    delete state.fatal;
    // The auto-restart count (#146) belongs to one launch. A start a human typed
    // gets the whole budget again, and a restart keeps counting.
    if (!autoRestarted) delete state.restart;
  } catch (error) {
    exitBeforeScheduler();
    throw error;
  }
  let exitCode = 0;
  // Which scope deferrals have already been logged, keyed by task id and
  // replaced wholesale each tick by `deferralAnnouncements`. A tick's-worth of
  // memory, held out here because the loop below is re-entered thousands of
  // times a run.
  let deferralMemo = new Map();
  try {
    for (;;) {
      reconcileDerivedLifecycles();
      if (!activeIntegrator) flushStatuses();
      if (!activeIntegrator && !infisicalHalt && canStartIntegration(state)) startIntegrator();
      // A halted run still integrates and drains what is already building — the
      // work is done and paid for. It just starts nothing new.
      if (!halted) {
        const batch = planBuilderBatch(
          dag,
          config,
          withProbeReservations(state),
          Date.now(),
          explicitTaskId,
        );
        // After the builders start, so the log reads in the order it happened:
        // the lane a task lost to is named as running by the line above it.
        // Said once per deferral, not once per tick — the loop spins
        // continuously, and `deferralMemo` is what stops one idle lane from
        // filling the log with the same sentence. `deferralAnnouncements` owns
        // the decision; this owns the effect.
        // A task still waiting on its quota read already owns its dispatch.
        launchBatch(batch.picked.filter((task) => !activeBuilders.has(task.id)));
        const announcement = deferralAnnouncements(batch.deferred, deferralMemo);
        deferralMemo = announcement.announced;
        for (const line of announcement.lines) say(`AUTO: ${line}`);
      }

      if (
        halted &&
        !activeBuilders.size &&
        !activeIntegrator &&
        (!state.integrationQueue?.length || infisicalHalt)
      ) {
        flushStatuses();
        // The salvage evidence is written by the supervisor's chain, which the
        // scheduler deliberately never awaits. Here it is safe and necessary:
        // no builder, no integrator, nothing queued — the run is over, so this
        // is not the critical path, and the wait (bounded by SUPERVISOR_WALL_MS
        // per observation) is the difference between reporting salvageable work
        // and halting on top of it. `supervisorChain` never rejects.
        await supervisorChain;
        // A halt ends this RUN, not the epic: the tasks it never reached are
        // still pending, and a rerun past the shared cause continues them. So
        // the epic record stays `open` and only remembers why the run stopped.
        close.lastHalt = { reason: halted, at: new Date().toISOString() };
        saveState(state);
        say(`AUTO: stopped after ${halted}. Fix the shared cause, then rerun.`);
        for (const line of salvageLines(state)) say(`AUTO: ${line}`);
        exitCode = 1;
        break;
      }

      if (schedulerDone(dag, state, Date.now(), explicitTaskId)) {
        if (blockedSupervisorPending) {
          // A blocked lane is not terminal until its optional supervisor
          // judgment has had a chance to convert it to `no-op`. Recheck the
          // scheduler after the chain so a valid verdict can release the epic.
          await supervisorChain;
          blockedSupervisorPending = false;
          flushStatuses();
          continue;
        }
        flushStatuses();
        const gated = dag.tasks
          .filter(
            (task) =>
              task.humanGated &&
              lifecycleOf(task, state) === "pending" &&
              dependenciesPassed(task, dag, state),
          )
          .map((task) => task.id);
        say(
          gated.length
            ? `AUTO: no automatic work remains; human-gated task(s) ready: ${gated.join(", ")}.`
            : "AUTO: no active, queued, or automatically runnable tasks remain.",
        );
        if (gated.length) {
          observe("onGateReached", {
            taskIds: gated,
            gate: "before",
            titles: gated.map(
              (id) => dag.tasks.find((task) => task.id === id)?.title ?? null,
            ),
            epic: supervisorEpic(),
            branch: dag.branch ?? baseBranch,
            run: runSnapshot(),
          });
        }
        // An explicit single-task run sees one node of the graph, so it is not
        // entitled to an opinion about the epic. Only a full run closes one.
        if (!explicitTaskId) {
          let outcome = epicOutcome(dag, state);
          if (outcome.status === "awaiting_acceptance") {
            if (close.lifecycle !== "awaiting_acceptance") {
              close.lifecycle = "awaiting_acceptance";
              close.enteredAt = new Date().toISOString();
            }
            close.reason = outcome.reason;
            saveState(state);
            // Before the human is asked, not after. The closeout review is the
            // only thing that reads the whole integrated branch against the
            // child issues, and a person accepting a device gate should have it
            // in hand — that is the only order in which it can inform the
            // acceptance. Advisory as ever: it cannot accept, refuse or halt.
            // `close.verifier` is the stored SUMMARY, not the report the PR
            // body renders — only a review that ran this pass can be folded in.
            // A stored review of an older commit is re-run: `--accept` is refused
            // until a current review exists, so parking over a stale one would
            // leave the human nothing to accept against.
            const closeoutReport = reviewIsCurrent() ? null : await ensureCloseoutVerifier(outcome);
            // Delegated gates (#188): after the review, the fix pass and its
            // gate, then every guardrail. All pass, the delegate accepts and
            // the epic closes in this same run; anything else parks as before.
            const delegated = outcome.awaiting.filter((id) => state.delegations?.[id]);
            if (delegated.length) {
              const epicId = normalizeId(dag.epic?.id ?? state.epic?.id ?? null);
              await runCloseoutFixer(closeoutReport ?? readVerifierReport(root, epicId));
              for (const id of delegated) {
                if (!releaseDelegatedGate(id)) say(`AUTO: gate ${id} stays parked — ${delegateWaitLine(id)}.`);
              }
              saveState(state);
              outcome = epicOutcome(dag, state);
              if (outcome.status !== "awaiting_acceptance") {
                await closeEpic(outcome);
                break;
              }
              close.reason = outcome.reason;
              saveState(state);
            }
            // The body has to say "waiting on you" while that is true, not
            // only once the epic finally closes.
            if (pr !== PR_OFF) prRefresh = prRefresh.then(() => refreshEpicPr(closeoutReport));
            await reapIntegratorPane();
            await prRefresh;
            say(
              `AUTO: every task passed, but the epic cannot close: \`gate: after\` task(s) ${outcome.awaiting.join(", ")} await a human. Review them, then release with --accept=${outcome.awaiting.join(",")}.${close.verifier?.recommendation ? ` The closeout review recommends \`${close.verifier.recommendation}\` — read it before you accept.` : ""}`,
            );
            // Lane L's `gate: after`. Same event, different value of the field
            // Lane I built for exactly this — the run has stopped and cannot
            // proceed without a person, which is what `gate_reached` means.
            // Mutually exclusive with the `before` firing above: a pending
            // human-gated task makes `epicOutcome` `in_progress`, never
            // `awaiting_acceptance`, so the two can never both fire in one pass.
            observe("onGateReached", {
              taskIds: outcome.awaiting,
              gate: "after",
              titles: outcome.awaiting.map(
                (id) => dag.tasks.find((task) => task.id === id)?.title ?? null,
              ),
              epic: supervisorEpic(),
              branch: dag.branch ?? baseBranch,
              run: runSnapshot(),
            });
          } else if (outcome.status === "complete" || outcome.status === "incomplete") {
            await closeEpic(outcome);
          } else {
            say(`AUTO: the epic stays open — ${outcome.reason}.`);
          }
        }
        break;
      }

      const events = [...activeBuilders.values()];
      if (activeIntegrator) events.push(activeIntegrator);
      events.push(
        new Promise((resolveEvent) =>
          setTimeout(() => resolveEvent({ type: "timer" }), nextWakeDelay(state)),
        ),
      );
      const event = await Promise.race(events);
      if (event.type === "builder") finishBuilder(event);
      if (event.type === "integration") finishIntegration(event);
    }
    // A lane parked for a disk-full restart means this run is NOT done, and a
    // wrapper reading exit 0 would say it was.
    const parked = dag.tasks
      .filter((task) => state.tasks[task.id]?.lifecycle === "ready_to_integrate" && state.tasks[task.id]?.diskFull?.where === "integration" && !state.integrationQueue?.includes(task.id))
      .map((task) => task.id);
    if (parked.length) {
      say(`AUTO: ${parked.join(", ")} parked after a full disk during integration; free space, then restart.`);
      exitCode = 1;
    }
  } catch (error) {
    // `agent-auto.log` exists because the runner is designed to be started and
    // walked away from, so every message that ENDS a run belongs in it. Until
    // this catch existed only scheduler events did: a throw here went to a
    // stdout nobody was capturing, and the durable record of a fatal,
    // reproducible, config-caused failure was a run that started two builders
    // and stopped having opinions. The same run was launched again three hours
    // later and died identically, because the log held no cause to act on.
    //
    // `say` writes both streams, so the rethrow below still surfaces to a
    // foreground caller. The lanes die here rather than outliving the process
    // that was supposed to own them.
    //
    // Every step below is guarded on its own: the throw that got us here may be
    // ENOSPC, and then the log append and the state write fail too. The
    // notification goes first because it needs no disk.
    const message = String(error?.message ?? error).split("\n")[0];
    const at = new Date().toISOString();
    // #144: a fatal used to be one line at the END of the log, and a watcher
    // reading `afk status` saw a quiet run with lanes `running`, for up to
    // 2h13m. `orchestrator_fatal` is on the default NOTIFY_ONLY list.
    try {
      notify("orchestrator exited", `${at}: ${message}`, "orchestrator_fatal");
    } catch {}
    try {
      say(`AUTO: fatal — ${error?.stack ?? error?.message ?? error}`);
    } catch {}
    // Read by `afk status` and the dashboard; saved by the `finally` below.
    state.fatal = { at, message };
    // The mark `afk epic` restarts on (#146): a scheduler fatal, as opposed to
    // a refusal (which returns 1) or a throw before the scheduler started.
    try {
      error.fatal = state.fatal;
    } catch {}
    try {
      killLanes();
    } catch {}
    // The same restore the signal handler does: a fatal mid-integration would
    // otherwise leave the base checkout parked on a half-merged tree, which is
    // the one state the next run cannot reason about.
    if (state.activeIntegrator?.integrationBase)
      try {
        restoreMain(root, state.activeIntegrator.integrationBase);
      } catch {}
    // The lanes are stopped and the checkout restored, so the signal handlers
    // have nothing left to do, and armed they are a hazard (#146, #136): a
    // Ctrl-C while this process lingers would run them again and save this
    // stale in-memory state over whatever an auto-restart has since written.
    // Off, a signal takes its default action and ends the process; `afk epic`
    // installs its own while it hands over to a restart.
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    throw error;
  } finally {
    // Each step on its own: on a full disk `saveState` throws, and a throw here
    // would replace the error that ended the run (the cause a human needs) and
    // skip `release()`, leaving a lock the next start has to reason about.
    try {
      dashboardProcess?.stop();
    } catch {}
    state.orchestratorPid = null;
    state.dashboard = null;
    clearDashboardSkipped();
    try {
      saveState(state);
    } catch (error) {
      console.error(`AUTO: could not write final state — ${error.message}`);
    }
    release();
  }

  // The epic ended. Fired here — after the loop, after the `finally` has
  // written final state and released the lock — so it observes a run that is
  // finished and can race nothing. `close.verifier` is Lane L's closeout
  // review, joined here because the `epic_ended` evidence has a `verifier`
  // field and nothing else fills it: without it the 2am notification says
  // "epic finished" when what a human needs to hear is "epic finished, and the
  // closeout review has two must-fix findings". It is already in memory, so it
  // costs a projection and no work.
  const finalOutcome = explicitTaskId ? null : epicOutcome(dag, state);
  // A DAG with no tasks ended nothing. Judging it would cost a session to be
  // told so, and it is the shape the dashboard and --base tests run.
  if (dag.tasks.length) await observe("onEpicEnded", {
    epic: supervisorEpic(),
    branch: dag.branch ?? baseBranch,
    halted,
    delivery: state.prDelivery ?? null,
    tally: {
      status: finalOutcome?.status ?? (explicitTaskId ? "single_task" : null),
      reason: finalOutcome?.reason ?? null,
      passed: finalOutcome ? dag.tasks.filter((task) => lifecycleOf(task, state) === "passed").map((task) => task.id) : [],
      failed: finalOutcome?.failed ?? [],
      pending: finalOutcome?.pending ?? [],
      awaiting: finalOutcome?.awaiting ?? [],
      epicClose: close.lifecycle ?? null,
      outcome: close.outcome ?? null,
    },
    run: runSnapshot(),
    verifier: close.verifier
      ? {
          status: close.verifier.skipped ? "skipped" : "ran",
          recommendation: close.verifier.recommendation ?? null,
          mustFix: close.verifier.blocking ?? [],
        }
      : null,
  });
  // Drain anything still on the chain — a lane that failed a second before the
  // epic ended must not lose its judgment to process exit. Every job on the
  // chain carries its own wall clock, so this is bounded and cannot hang.
  await supervisorChain;
  // The one place every stop converges — close, park, a halted breaker, nothing
  // runnable — after the supervisor chain has drained, so no in-flight
  // judgment is caught in its role checkout. A herdr lane's `claude` outlives
  // its lane and is tied to the run only by its cwd; leave it and it idles for
  // hours. The epic checkout counts only when `afk epic --worktree` made it:
  // the main checkout is where a human's own shells live.
  const leftover = stopProcessesUnder([worktreeRoot(root), isEpicCheckout(root) ? root : null]);
  if (leftover.length) say(`AUTO: stopped ${leftover.length} leftover lane process(es): ${leftover.join(", ")}.`);
  return exitCode;
};

// --- CLI ---------------------------------------------------------------------
// The dev/test seam. `--dag=<path>` reads a JSON file of the DAG shape declared
// in lib.mjs; Wave 2's `afk epic` imports runAuto directly with a DAG fetched
// from GitHub and no file at all.
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const dagPath = flag("dag");
  if (!dagPath) {
    console.error(
      "AUTO: no task DAG. Pass --dag=<path to a JSON file of { epic, branch, tasks: [...] }>.",
    );
    process.exit(1);
  }
  let dag;
  try {
    dag = JSON.parse(readFileSync(resolve(process.cwd(), dagPath), "utf8"));
  } catch (error) {
    console.error(`AUTO: cannot read DAG ${dagPath}: ${error.message}`);
    process.exit(1);
  }
  // `process.exitCode`, never `process.exit()`: this process has just written a
  // run's worth of lines to a pipe, and exiting hard can truncate them.
  process.exitCode = await runAuto({
    config: loadConfig(process.cwd()),
    dag,
      // Which branch tasks branch from and integrate into. The merge logic
      // already works against whatever HEAD is; only the pre-flight guard ever
      // pinned "main".
    baseBranch: flag("base") || "main",
    explicitTaskId: flag("task"),
    runtime: flag("runtime"),
    refreshAuth: args.includes("--refresh-auth"),
    customInstructions: flag("instructions"),
    // The human's release of `gate: after` work: `--accept=211` or
    // `--accept=211,212`. Typed by a person, never derived from an agent.
    accept: (flag("accept") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    acceptForce: args.includes("--force"),
    // The fixed point the closeout review is taken against. It is NOT
    // `--base`: `--base` is the branch lanes integrate into (the epic's feature
    // branch), and reviewing that branch against itself is an empty diff.
    epicBase: flag("epic-base") || "main",
    // Only so the supervisor's `run` proposal renders a command a human can
    // paste. Nothing reads the file twice.
    dagPath,
  });
}
