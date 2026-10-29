// scripts/wave-driver.mjs — the wave driver's DECISIONS, with no effects.
//
// `docs/wave-mode.md` §4 is a loop of five judgments wrapped in git commands:
// which tasks are runnable, how many of them fit in one wave, whether the wave
// may be fast-forwarded onto the base branch, whether the remaining graph is
// still worth the night, and what the morning reads. Every one of them is a
// function of data here, and `scripts/wave.mjs` is the thin edge that fetches
// the data and applies the result. `scripts/scheduler.mjs` is the house pattern
// and the reason: the runner's hardest bugs were all in judgment, and a
// judgment that needs a repo, a git history and an overnight agent run to
// exercise gets exercised once, at 3am, by nobody.
//
// The wave log (`tasks/.wave-log.json`, §3) is the only input that crosses a
// wave boundary, because `.afk/` is archived wholesale at each one. Everything
// below reads it and nothing below writes it.

/**
 * One sentence, rendered by both the orchestrator log (auto.mjs imports it from
 * here) and the digest below. `fixerStateRecord`'s comment is the reason it is
 * one function: every surface that phrased the fixer's numbers locally has
 * drifted from the others at least once.
 *
 * It lives HERE and not in fixer.mjs so the arrow points the right way. This
 * module is the judgment layer and imports nothing on purpose (see the head of
 * this file); an import of fixer.mjs would drag lib, roles, verifier and
 * worktree behind it, and the reason these judgments are testable at all is
 * that exercising one needs no repo, no git history and no overnight run.
 */
export const renderCloseoutGateLine = (gate) => {
  if (!gate) {
    return "closeout fix gated: **n/a** — no fix pass ran, so nothing landed after the gates.";
  }
  const at = gate.fixSha ? `\`${gate.fixSha}\`` : gate.head ? `\`${gate.head}\`` : "(unknown commit)";
  const count = gate.checks?.length ?? 0;
  if (gate.status === "no_commit") {
    // Only what is known: the pass added nothing. NOT "the tip is the commit the
    // gates ran over" — true of a wave, and a claim about a commit this pass
    // never saw the moment anything else has touched the branch since.
    return `closeout fix gated: **n/a** — the fix pass committed nothing, so it added nothing after the gates; the tip is ${at}.`;
  }
  // Run over a tip the fix pass never moved: `integrationChecks` is lighter
  // than the full chain, so this was the epic's only full gate after the baseline.
  const tipOnly = Boolean(gate.fixSha && gate.fixSha === gate.headBefore);
  if (tipOnly && gate.status === "passed") {
    return `closeout tip ${at} gated: **yes** — no fix commit, but integration ran the lighter \`integrationChecks\`, so the full chain (${count} check(s)) ran over the tip; all exited 0.`;
  }
  if (tipOnly && gate.status === "failed") {
    return `closeout tip ${at} gated: **yes**, and it ${gate.timedOut ? "TIMED OUT" : "FAILED"} — \`${gate.failingCommand}\` ${gate.timedOut ? "was killed at the bound" : `exited ${gate.failingCode ?? "non-zero"}`}. Integration ran the lighter \`integrationChecks\`, so the break most likely came from a task integrated after the baseline; the epic's outcome is unchanged.`;
  }
  if (gate.status === "passed") {
    return `closeout fix ${at} gated: **yes** — ${count} check(s) re-run over it after the gates had passed below it; all exited 0.`;
  }
  if (gate.status === "failed") {
    // A BOUND FIRING IS NOT A RED CHECK, and saying so is the whole of ccae24b:
    // "it FAILED — exited non-zero" over a `baselineTimeoutMs` kill sends a
    // human looking for a broken assertion that does not exist. What a timeout
    // proves is that the tip is UNVERIFIED, not that it is broken — so the
    // sentence says which, and the status stays `failed` because a check that
    // did not pass is not a pass.
    if (gate.timedOut) {
      return `closeout fix ${at} gated: **yes**, and it TIMED OUT — \`${gate.failingCommand}\` was killed at the bound, so the tip is unverified rather than known broken. The epic's outcome is unchanged because this pass never owns it.`;
    }
    return `closeout fix ${at} gated: **yes**, and it FAILED — \`${gate.failingCommand}\` exited ${gate.failingCode ?? "non-zero"}. The tip is broken; the epic's outcome is unchanged because this pass never owns it.`;
  }
  return `closeout fix ${at} gated: **no** — ${gate.problem ?? "the chain could not be run"}.`;
};

// §4: "wave = frontier, capped at WAVE_CAP (default 12)".
export const WAVE_CAP = 12;

// One first attempt plus §5's two grounded retries. Named as a BUDGET rather
// than a retry count because that is the question asked of it — "has this task
// spent everything it is going to get?" — and because `attempts` in the log
// counts attempts, not retries. The driver sets `agent.maxBuilderRetries: 2`,
// so a task that fails a whole wave has spent all three.
export const ATTEMPT_BUDGET = 3;

// §4: "if dead tasks orphan more than 25% of the remaining graph, halt".
export const ORPHAN_HALT_RATIO = 0.25;

/** `wave-01`, `wave-02`, … Zero-padded so the digests sort. */
export const waveId = (index) => `wave-${String(index).padStart(2, "0")}`;

// `planReview` is null until the run's one review passes (§4). It is top-level
// rather than a field on a wave record because the thing reviewed is the whole
// frozen graph — a property of the run, not of any wave — and because a run
// that resumes must be able to answer "has this decomposition been reviewed?"
// without picking a wave to ask. A log written before the field existed reads
// as null and is reviewed once, which is the safe direction.
export const emptyWaveLog = (base) => ({ version: 1, base, waves: [], planReview: null });

/**
 * Fold every recorded wave into one verdict per task.
 *
 * `attempts` ACCUMULATE across waves and the outcome is the last one recorded.
 * The accumulation is the whole reason this file is git-tracked (§3): without
 * it a task that burned three attempts in wave 3 gets three fresh ones in
 * wave 4, and "two grounded retries" silently becomes unlimited — the failure
 * this schema exists to prevent.
 *
 * @param {object} log a wave log, or anything log-shaped enough to have `waves`
 * @returns {Record<string, {outcome: string, attempts: number}>}
 */
export const taskLedger = (log) => {
  const ledger = {};
  for (const wave of log?.waves ?? []) {
    for (const [id, record] of Object.entries(wave?.tasks ?? {})) {
      const previous = ledger[id] ?? { outcome: "pending", attempts: 0 };
      ledger[id] = {
        outcome: record?.outcome ?? previous.outcome,
        attempts: previous.attempts + (Number(record?.attempts) || 0),
      };
    }
  }
  return ledger;
};

export const hasPassed = (ledger, id) => ledger[id]?.outcome === "passed";

// `no-op` is a satisfied task, but it is not a passing code change. Keeping the
// distinction lets the release gate require at least one real pass while
// allowing a supervisor-confirmed no-op to finish alongside it.
export const isTerminal = (ledger, id) =>
  ledger[id]?.outcome === "passed" || ledger[id]?.outcome === "no-op";

const filedDone = (dag, id) => {
  const done = dag?.done;
  return Array.isArray(done) ? done.includes(id) : done instanceof Set ? done.has(id) : false;
};

const taskDone = (dag, ledger, id) => filedDone(dag, id) || isTerminal(ledger, id);

/**
 * A task that will never run again: it did not pass and it has no attempts left.
 *
 * Deliberately NOT "outcome === 'failed'". A wave that crashed before its
 * scheduler finished leaves tasks recorded `failed` with attempts still on the
 * clock, and those are re-runnable — that is what makes `afk wave run`
 * idempotent after a 3am crash rather than a machine for burning the remaining
 * graph. Only the budget decides death.
 */
export const isDead = (ledger, id, budget = ATTEMPT_BUDGET) => {
  const record = ledger[id];
  if (!record || isTerminal(ledger, id)) return false;
  return record.attempts >= budget;
};

export const deadTasks = (dag, ledger, budget = ATTEMPT_BUDGET) =>
  new Set((dag?.tasks ?? []).map((task) => task.id).filter((id) => !filedDone(dag, id) && isDead(ledger, id, budget)));

/**
 * Tasks that can no longer be reached: something they transitively depend on is
 * dead. §4 — "its dependents never become runnable".
 *
 * The dead tasks themselves are NOT in the result. They are dead, which is a
 * different fact with a different cause, and conflating the two double-counts
 * them in the halt arithmetic below.
 */
export const unreachableTasks = (dag, dead) => {
  const orphaned = new Set();
  // Blocking is transitive, so loop until the set stops growing rather than
  // assuming the DAG arrives topologically sorted — `scheduler.mjs`'s
  // `deriveBlocked` learned this the same way.
  for (let changed = true; changed; ) {
    changed = false;
    for (const task of dag?.tasks ?? []) {
      if (dead.has(task.id) || orphaned.has(task.id)) continue;
      if (!task.dependsOn?.some((id) => dead.has(id) || orphaned.has(id))) continue;
      orphaned.add(task.id);
      changed = true;
    }
  }
  return orphaned;
};

/**
 * The next wave's task ids: everything runnable, capped.
 *
 * Runnable is exactly the scheduler's definition, read off the log instead of
 * `.afk/state.json`: not satisfied, not dead, and every `dependsOn` satisfied.
 * A task filed under `tasks-done/` is satisfied from the loader's filesystem
 * bit even when its ledger record is stale. Note
 * what follows from it — a wave's tasks can never depend on each other, because
 * a dependent's edge is only satisfied once its dependency has PASSED, which
 * happens in an earlier wave. That is why the fast-forward gate below can treat
 * the wave's tasks as independent.
 *
 * The cap slices in DAG order, which is the loader's filename order: stable
 * across runs, so a resumed wave picks the same tasks as the one it replaces.
 */
export const waveFrontier = ({ dag, ledger, budget = ATTEMPT_BUDGET, cap = WAVE_CAP }) => {
  const runnable = (dag?.tasks ?? []).filter((task) => {
    if (taskDone(dag, ledger, task.id)) return false;
    if (isDead(ledger, task.id, budget)) return false;
    return (task.dependsOn ?? []).every((id) => taskDone(dag, ledger, id));
  });
  return runnable.slice(0, Math.max(1, cap)).map((task) => task.id);
};

/**
 * Whether the night is still worth running (§4).
 *
 * "Draining the night on 8% of a graph produces the same morning as stopping at
 * 1am, and costs six hours." The denominator is the work still outstanding —
 * every task that has not been satisfied — and the numerator is the part of it that is
 * unreachable rather than merely unfinished. Dead tasks are excluded from the
 * numerator (see `unreachableTasks`) but stay in the denominator: they are
 * still work the morning has to deal with.
 *
 * Strictly greater than the ratio, per §4's "more than 25%".
 */
export const haltDecision = ({ dag, ledger, budget = ATTEMPT_BUDGET, ratio = ORPHAN_HALT_RATIO }) => {
  const outstanding = (dag?.tasks ?? []).filter((task) => !taskDone(dag, ledger, task.id));
  const dead = deadTasks(dag, ledger, budget);
  const orphaned = [...unreachableTasks(dag, dead)];
  const share = outstanding.length ? orphaned.length / outstanding.length : 0;
  const halt = outstanding.length > 0 && share > ratio;
  return {
    halt,
    dead: [...dead],
    orphaned,
    remaining: outstanding.length,
    share,
    reason: halt
      ? `${orphaned.length} of ${outstanding.length} remaining task(s) — ${Math.round(share * 100)}% — are unreachable behind dead task(s) ${[...dead].join(", ")}; over the ${Math.round(ratio * 100)}% halt threshold`
      : null,
  };
};

const short = (sha) => String(sha ?? "").slice(0, 7) || "unknown";

/**
 * The ancestor refusal as a DIAGNOSIS rather than a verdict.
 *
 * "the base is not an ancestor of the wave branch" names neither ref and
 * neither sha, and the operator's next move depends entirely on both. quillnote
 * wave-31 was refused correctly and the account of why — the branch was reused
 * from an attempt that died at the baseline, so its base predated two repair
 * commits — had to be reconstructed by hand from the ledger afterwards (#74).
 * Short shas because this is read, not pasted; the digest carries the full one.
 */
const describeDivergence = (divergence) => {
  if (!divergence) return null;
  const { base, id, baseSha, baseNow, ahead } = divergence;
  const distance = Number(ahead) > 0 ? ` (${ahead} commit${Number(ahead) === 1 ? "" : "s"} ahead)` : "";
  return `\`${base}\` is not an ancestor of \`${id}\`; \`${id}\` is based at \`${short(baseSha)}\`, \`${base}\` is at \`${short(baseNow)}\`${distance}.`;
};

/**
 * Does this wave's recorded run have lane merges sitting on its branch?
 *
 * `passed` is the only outcome that puts a commit on the wave branch — a
 * `no-op` is a supervisor's ruling recorded in the log, and everything else
 * failed — so this is the question "would re-cutting `wave-NN` destroy
 * anything?" asked of the only record that crosses a wave boundary (§3).
 */
export const waveHasMergedWork = (recorded) =>
  Object.values(recorded?.tasks ?? {}).some((task) => task?.outcome === "passed");

/**
 * What a cut does about a `wave-NN` branch that already exists.
 *
 * `-B` is deliberately not used and never was: an existing wave branch can
 * carry a replayed wave's earlier lane merges, and resetting it would discard
 * them. That reasoning is right and stays — but it never covered the branch
 * left behind by an attempt that died BEFORE any lane ran. On quillnote
 * wave-31's baseline died on a timed-out package fetch, two repair commits
 * landed on `main`, the wave was relaunched, and the cut silently ADOPTED the
 * branch at its original base. Three tasks then passed onto a base predating
 * the repairs, and the runner rightly refused to move the ref: a wave that was
 * entirely green and could not be landed at all (#74).
 *
 * The record says which case this is, and `waveHasMergedWork` is the question.
 * Nothing recorded as passed means nothing on the branch to protect.
 *
 * ABSENCE OF A RECORD IS NOT EVIDENCE OF NO WORK, which is why `hasRecord` is
 * threaded in rather than inferred from a falsy `hasMergedWork`. Wiping wave
 * state while deliberately KEEPING the `wave-NN` and `afk/task-*` branches is
 * this project's own salvage procedure — finished builds are re-integrated
 * instead of rebuilt — so reading a missing record as "nothing passed" deletes
 * exactly what the salvage was preserving. A human's own branch that happens to
 * be named `wave-07` reads the same way. Three cases, not two.
 *
 * When there is no record, the branch itself is asked instead:
 * `branchAheadOfBase` is git's own answer to "does this carry a commit the base
 * branch does not?". A driver killed between the cut and the record leaves a
 * `wave-NN` sitting at the base with nothing on it, which is the ordinary
 * crash-resume and must not halt the night.
 *
 * "AHEAD OF THE BASE" IS NOT THE SAME QUESTION AS "CARRIES SOMEBODY'S WORK",
 * and treating them as one refused every real crash-resume there is.
 * `flushStatuses` in auto.mjs commits the epic's progress table and the ledger (and,
 * before #106, `.afk-runs/<id>/integration-verification.json`) with
 * `--no-verify` from the FAILURE paths as well as the passing one, so a driver killed after any lane
 * failed leaves a wave branch ahead of its base by pure runner bookkeeping and
 * no record. Refusing there ends the night and tells the human to
 * `git branch -D` the only copy of that night's evidence — while the pre-#74
 * behaviour, reusing the branch and its worktree and resuming from
 * `.afk/state.json`, was the PRIMARY resume path. So the branch is asked the
 * narrower question too: `branchWorkAheadOfBase`, whose paths are
 * `isStatusFlushPath`'s in lib.mjs — the same distinction `markStaleEvidence`
 * in verifier.mjs already draws for the same reason.
 *
 * FAIL DIRECTION: recreate only where something PROVES there is nothing to lose
 * — the record saying no task passed, or git saying the branch carries no
 * commit but the runner's own. Refuse wherever there might be. Halting an
 * unattended run over a branch known to carry nothing a reviewer read wastes a
 * night for no gain; discarding lane merges nobody can reconstruct is worse
 * than a refusal a human reads in the morning. `branchWorkAheadOfBase`
 * therefore DEFAULTS TO TRUE: a caller that cannot answer it, or has not been
 * taught to, gets the refusal rather than the deletion.
 *
 * @param {object} args
 * @param {string|null} args.branchSha `refs/heads/wave-NN`, or null if absent
 * @param {string} args.baseSha the sha this wave is to be cut from
 * @param {boolean} args.hasRecord whether the wave log holds a record for `id`
 * @param {boolean} args.hasMergedWork `waveHasMergedWork` of this wave's record
 * @param {boolean} args.branchAheadOfBase `rev-list --count <base>..<branchSha>` is
 *   non-zero — consulted only when there is no record to consult
 * @param {boolean} [args.branchWorkAheadOfBase] whether any of those commits touched
 *   a path that is not runner bookkeeping — likewise only consulted with no record
 * @param {boolean} args.baseIsAncestor `merge-base --is-ancestor baseSha branchSha`
 * @returns {{action: 'cut'|'reuse'|'recreate'|'refuse', reason: string}}
 */
export const waveBranchDecision = ({ id, branchSha, baseSha, hasRecord, hasMergedWork, branchAheadOfBase, branchWorkAheadOfBase = true, baseIsAncestor }) => {
  if (!branchSha)
    return { action: "cut", reason: `cutting \`${id}\` from \`${short(baseSha)}\`.` };
  if (!hasRecord) {
    if (branchAheadOfBase && branchWorkAheadOfBase)
      return {
        action: "refuse",
        reason: `\`${id}\` already exists at \`${short(branchSha)}\`, the wave log holds no record of it, and it carries commits the base branch does not — so nothing here can say whose they are, and they are not the driver's to discard. Read it — \`git log ${id}\` — then either \`git branch -D ${id}\` or restore its record in the wave log.`,
      };
    if (branchAheadOfBase && baseIsAncestor)
      return {
        action: "reuse",
        reason: `\`${id}\` already exists at \`${short(branchSha)}\` with no record, and every commit it carries above \`${short(baseSha)}\` is the runner's own bookkeeping — the branch a driver killed mid-wave leaves behind. Resuming on it rather than discarding the run's evidence.`,
      };
    return {
      action: "recreate",
      reason: branchAheadOfBase
        ? `\`${id}\` already exists at \`${short(branchSha)}\` with no record, carrying nothing above the base but the runner's own bookkeeping, and \`${short(baseSha)}\` is not an ancestor of it — so there is no resuming on it and nothing on it to keep. Recreating it at \`${short(baseSha)}\`.`
        : `\`${id}\` already exists at \`${short(branchSha)}\` with no record and no commit the base branch does not already have — the branch a driver killed between the cut and the record leaves behind. Recreating it at \`${short(baseSha)}\`.`,
    };
  }
  if (!hasMergedWork)
    return {
      action: "recreate",
      reason: `\`${id}\` already exists at \`${short(branchSha)}\` and its record shows no task that passed — the branch an attempt that died before any lane ran leaves behind. Recreating it at \`${short(baseSha)}\` rather than adopting it and its stale base.`,
    };
  if (!baseIsAncestor)
    return {
      action: "refuse",
      reason: `\`${id}\` already exists at \`${short(branchSha)}\` and \`${short(baseSha)}\` is not an ancestor of it, so it is not the branch this replay resumes — and it records passed tasks, so its lane merges are not the driver's to discard. Read it, then either \`git branch -D ${id}\` or correct this wave's \`baseSha\` in the wave log.`,
    };
  return {
    action: "reuse",
    reason: `replaying \`${id}\` on the existing branch at \`${short(branchSha)}\`; \`${short(baseSha)}\` is an ancestor of it, so its earlier lane merges are kept.`,
  };
};

/**
 * May this wave's branch be moved onto the base branch?
 *
 * THE ANCESTOR ASSERTION IS THE WHOLE SAFETY MECHANISM (§4). `isAncestor` is
 * the boolean result of `git merge-base --is-ancestor <base> wave-NN`, computed
 * by the caller; if it is false something moved the base during the wave, and
 * the only correct move is to stop and leave the branch for a human. There is
 * no `--force` anywhere in this file or its caller, and there must never be:
 * the wave branch was cut hours ago from a base that has since gained commits,
 * and forcing the ref discards them silently.
 *
 * FAIL DIRECTION (AGENTS.md): closed, on both clauses. Not moving a good wave
 * costs a morning of `git merge`; moving a bad one costs whatever was on the
 * base branch. `verdict` distinguishes the two refusals, because they want
 * different mornings — `failed` is "this wave did not finish, resume it",
 * `halted` is "a human must look at the base branch before anything else runs".
 *
 * The gate on the tasks is "every task in the wave is terminal". A confirmed
 * `no-op` is terminal without being a pass; a dead task is terminal and already
 * accounted for in the halt rule, so treating it as a reason to withhold the
 * fast-forward would make §4's "the driver carries on with whatever else is
 * still reachable" unreachable code — the first dead task of the night would
 * strand every passing sibling off the base branch. What is NOT tolerated is a
 * blocked task without that verdict, or a task that is otherwise neither
 * terminal nor dead: still pending, still running, or failed with attempts left
 * means the wave did not finish, and a half-finished wave on the base branch is
 * a base branch nobody can reason about.
 *
 * @param {object} args
 * @param {string[]} args.waveTasks ids scheduled in this wave
 * @param {Record<string, {outcome: string, attempts: number}>} args.ledger the
 *   ledger INCLUDING this wave's own results
 * @param {boolean} args.isAncestor `git merge-base --is-ancestor base wave-NN`
 * @param {object|null} args.divergence `{base, id, baseSha, baseNow, ahead}` — the
 *   two shas and the distance between them, for the ancestor refusal's diagnosis
 * @returns {{allowed: boolean, verdict: 'merged'|'failed'|'halted', reason: string}}
 */
export const fastForwardDecision = ({ waveTasks, ledger, isAncestor, budget = ATTEMPT_BUDGET, divergence = null }) => {
  const unfinished = waveTasks.filter(
    (id) => !isTerminal(ledger, id)
      && (ledger[id]?.outcome === "blocked" || !isDead(ledger, id, budget)),
  );
  if (unfinished.length > 0) {
    return {
      allowed: false,
      verdict: "failed",
      reason: `${unfinished.join(", ")} did not reach a terminal outcome — the wave did not finish, so its branch is not moved onto the base. Re-run \`afk wave run\` to resume it.`,
    };
  }
  if (!isAncestor) {
    return {
      allowed: false,
      verdict: "halted",
      reason: [
        "the base branch is not an ancestor of the wave branch — something moved it during the wave.",
        describeDivergence(divergence),
        "Refusing to move the ref; never --force. The wave branch is left in place for a human.",
      ].filter(Boolean).join(" "),
    };
  }
  const passed = waveTasks.filter((id) => hasPassed(ledger, id));
  if (passed.length === 0) {
    return {
      allowed: false,
      verdict: "failed",
      reason: "every task in the wave is dead — there is nothing on the branch to move.",
    };
  }
  const noOp = waveTasks.filter((id) => isTerminal(ledger, id) && !hasPassed(ledger, id)).length;
  return {
    allowed: true,
    verdict: "merged",
    reason: `${passed.length} of ${waveTasks.length} task(s) passed${noOp ? `; ${noOp} no-op` : ""} and the base is an ancestor of the wave branch.`,
  };
};

/**
 * May this wave be cut at all? The plan reviewer's verdict, read in code.
 *
 * §2 makes GOAL.md "the thing a wave is checked against"; `plan-review.mjs`
 * turns that into a verdict computed in code from audited findings, and its
 * governing sentence is "a contradiction aborts before any branch or worktree
 * exists". This function is the driver's half of that sentence: the reviewer's
 * outcome in, permission to cut the branch out. The caller runs it BEFORE
 * `git branch`, which is the same ordering `cliEpic` uses on purpose.
 *
 * FAIL DIRECTION (AGENTS.md): closed, and deliberately not re-decided here.
 * `runPlanReview` already computes `ok` — false for a contradiction, for an
 * expired login, and for a reviewer that returned nothing usable twice — and
 * `cliEpic` blocks on exactly `!outcome.ok` without discriminating between
 * them. A wave that split those three apart would be a second, quieter policy
 * for the same question. A MISSING outcome blocks too: "no review ran" is not
 * "a review found nothing" (the same distinction `verifierStatus` draws), and
 * a judgment gate that silently no-ops is decoration.
 *
 * @param {object|null} outcome `runPlanReview`'s return value
 * @returns {{allowed: boolean, status: string, reason: string}}
 */
export const planReviewDecision = (outcome) => {
  if (!outcome) {
    return {
      allowed: false,
      status: "unavailable",
      reason:
        "the plan review did not run, and a wave is not cut without one — GOAL.md is the only thing this wave is checked against (docs/wave-mode.md §2).",
    };
  }
  if (outcome.ok) {
    return {
      allowed: true,
      status: outcome.status ?? "clean",
      reason: outcome.message ?? "no contradiction between the wave and GOAL.md",
    };
  }
  return {
    allowed: false,
    status: outcome.status ?? "refused",
    reason: `${outcome.message ?? "the plan reviewer refused this wave"}`,
  };
};

/**
 * What a re-run does with the log it finds (§3: "resume is reading this file").
 *
 * A wave recorded `merged` is history: its work is on the base branch and
 * re-running it would rebuild merged code. Anything else is replayed — the same
 * wave id, cut again from its recorded `baseSha`, with the frontier recomputed
 * so that whatever DID pass inside it is not run twice. That recomputation is
 * what makes the command idempotent rather than merely restartable: the second
 * run converges on the same end state as an uninterrupted first one.
 *
 * @returns {{mergedWaves: object[], replay: object|null, nextIndex: number}}
 */
export const resumePlan = (log) => {
  const waves = log?.waves ?? [];
  const merged = [];
  for (const wave of waves) {
    if (wave?.outcome !== "merged") {
      return { mergedWaves: merged, replay: wave, nextIndex: merged.length + 1 };
    }
    merged.push(wave);
  }
  return { mergedWaves: merged, replay: null, nextIndex: merged.length + 1 };
};

/**
 * Append a wave record, or replace the one with the same id.
 *
 * Replacing rather than appending is what stops a resumed wave from recording
 * itself twice and double-counting its attempts in `taskLedger`. Returns a new
 * log; the caller writes it.
 */
export const recordWave = (log, record) => {
  const waves = log?.waves ?? [];
  const at = waves.findIndex((wave) => wave?.id === record.id);
  return {
    ...log,
    waves: at === -1 ? [...waves, record] : [...waves.slice(0, at), record, ...waves.slice(at + 1)],
  };
};

/**
 * Tracked changes in the base checkout that the driver must not run over.
 *
 * The fast-forward moves the base ref out from under a checkout that is sitting
 * on it, so the working tree has to be brought back to the new HEAD — and that
 * is a `git reset --hard`, which discards tracked modifications. AGENTS.md
 * failure mode 1 is this runner destroying a user's files once already, so the
 * driver refuses to start rather than discovering the problem after the ref has
 * moved.
 *
 * The driver's own two records are exempt: a withheld wave deliberately leaves
 * its log and digest in the working tree for the next merged wave to commit,
 * and refusing to resume because of them would deadlock the thing they exist
 * for. UNTRACKED files are not considered at all — `reset --hard` does not
 * touch them, and treating them as blockers is failure mode 2 — which is the
 * caller's job now: this takes PATHS, not porcelain.
 *
 * Parsing moved to `parseStatusPaths` in lib.mjs after the second parser here
 * turned a rename into the literal `old -> new`, handed it to the boundary's
 * `git stash push -- <pathspec>`, and stranded the wave on a pathspec that
 * matched no file. This module knows which paths block; git's output format is
 * not judgment and does not belong in it.
 *
 * @param {string[]} paths tracked changed paths, already parsed
 * @param {string[]} exempt repo-relative path prefixes the driver owns
 */
export const dirtyBlockers = (paths, exempt = []) =>
  (paths ?? []).filter((path) => !exempt.some((prefix) => path === prefix || path.startsWith(prefix)));

/**
 * Fold a replayed wave's results into the record it is replacing.
 *
 * A crashed wave is re-run with the frontier recomputed, so the second run
 * schedules only what did not pass — which means its results name FEWER tasks
 * than the record it replaces. Replacing the record wholesale would drop the
 * passed ones out of the log, and `taskLedger` would then re-offer them to the
 * next frontier and rebuild code already on the branch. Attempts add, for the
 * same reason they add across waves: the budget is spent whichever run spent it.
 */
export const mergeWaveTasks = (prior = {}, results = {}) => {
  const merged = { ...prior };
  for (const [id, result] of Object.entries(results)) {
    merged[id] = {
      outcome: result.outcome,
      attempts: (Number(prior[id]?.attempts) || 0) + (Number(result.attempts) || 0),
    };
  }
  return merged;
};

/**
 * Task files an agent wrote during the wave.
 *
 * §4 freezes the graph at t0: a builder that writes a follow-up task file still
 * writes it, and the file waits in `tasks-todo/` for morning triage rather than
 * joining tonight's run. "A driver that re-read the directory each wave would
 * schedule an agent's excuse for not doing the work." They still have to be
 * NAMED, or the morning never finds them.
 *
 * @param {string[]} frozenFiles filenames present when the graph was frozen
 * @param {string[]} presentFiles filenames present now
 */
export const followUpFiles = (frozenFiles, presentFiles) => {
  const frozen = new Set(frozenFiles ?? []);
  return (presentFiles ?? []).filter((name) => !frozen.has(name)).sort();
};

/**
 * Which task files the tree should be showing under `tasks-done/` (§1).
 *
 * The file tree is how a human sees overnight progress at a glance, and a tree
 * that still lists every task as to-do after five of them merged reports that
 * nothing happened. So the runner files the file — never the task itself: an
 * agent that moves its own file into `tasks-done/` is an agent marking its own
 * homework, and the ledger, not the agent, is what says `passed`.
 *
 * STATE IS AUTHORITATIVE AND THE FILES ARE A RENDERING OF IT. The ledger is
 * read here, so the answer is the same whether this is the wave that passed the
 * task or a later one converging after a crash. That is also what makes it
 * idempotent: a file already on the far side is not in `todoFiles`, so it
 * yields no move, and re-running produces the empty list rather than an error.
 *
 * A file present on BOTH sides yields no move either. That is a corruption this
 * function cannot repair, and the loader already refuses the whole directory
 * for it with `duplicate_id` — deleting one of the two here to tidy the tree
 * would destroy the evidence of how it happened.
 *
 * ONE BIT, DONE OR NOT. A failed or dead task keeps its file in `tasks-todo/`
 * and there is no `tasks-failed/`: a third directory would be a second
 * lifecycle vocabulary competing with the wave log, which is the only thing
 * that crosses a wave boundary and the only thing entitled to say why a task
 * did not finish.
 *
 * The filename is `<id>.md` because the loader refuses `id_mismatch` when the
 * frontmatter id and the filename stem disagree, and defaults a missing id to
 * the stem — so in any directory that loaded at all, they are the same string.
 *
 * @param {object} dag the frozen graph
 * @param {Record<string, {outcome: string}>} ledger the wave log's fold
 * @param {string[]} todoFiles filenames currently in `tasks-todo/`
 * @param {string[]} doneFiles filenames currently in `tasks-done/`
 * @returns {string[]} filenames to move, in DAG order
 */
export const doneFileMoves = ({ dag, ledger, todoFiles = [], doneFiles = [] }) => {
  const todo = new Set(todoFiles);
  const done = new Set(doneFiles);
  return (dag?.tasks ?? [])
    .filter((task) => hasPassed(ledger, task.id))
    .map((task) => `${task.id}.md`)
    .filter((name) => todo.has(name) && !done.has(name));
};

/**
 * The verifier's standing, for the log's `verifier` field (§3).
 *
 * Advisory, always: §4 is explicit that an objection is recorded and does not
 * hold the wave off the base branch. Holding would make one disputed criterion
 * at 1am cost the rest of the night, and the checkpoint sha makes it reversible.
 * `unavailable` is its own value rather than folded into `clean`, because "no
 * review ran" and "a review found nothing" are the difference between a green
 * night and an unreviewed one.
 */
export const verifierStatus = (decision) => {
  if (!decision) return "unavailable";
  if (decision.recommendation === "inconclusive") return "unavailable";
  return (decision.blocking?.length ?? 0) > 0 || (decision.notes?.length ?? 0) > 0
    ? "disputed"
    : "clean";
};

const bullet = (lines, empty) => (lines.length ? lines : [empty]);

/**
 * The digest, `docs/afk-runs/wave-NN.md` (§4), committed to the base branch.
 *
 * This is how a failed task is documented on the base branch even though its
 * code is not. It carries the failing attempts' evidence because the caller
 * copies it in BEFORE `.afk/` is archived — otherwise a dead task's reason ends
 * up in a directory nobody opens.
 *
 * Pure: every fact it renders is passed in.
 */
export const renderDigest = ({
  id,
  base,
  baseSha,
  headSha = null,
  startedAt = null,
  finishedAt = null,
  maxParallel = null,
  tasks = [],
  failures = [],
  verifier = { status: "unavailable", disputed: [] },
  // `runCloseoutGate`'s record, read off `.afk/fixer/<wave>/gate.json` before
  // the run is archived. Null when no fix pass ran at all.
  closeoutGate = null,
  followUps = [],
  fastForward,
  halt = null,
  archive = null,
}) => {
  const outcome = fastForward?.verdict ?? "failed";
  // A blocked lane may have left a verification artifact before the supervisor
  // confirmed it was a no-op. Keep the no-op task row as evidence, but do not
  // render its stale blocked artifact as a wave failure.
  const reportedFailures = failures.filter(
    (failure) => !tasks.some((task) => task.id === failure.id && task.outcome === "no-op"),
  );
  return [
    `# ${id}`,
    "",
    `- base branch: \`${base}\` at \`${baseSha}\``,
    `- wave branch: \`${id}\`${headSha ? ` → base moved to \`${headSha}\`` : " (not moved onto the base)"}`,
    `- outcome: **${outcome}** — ${fastForward?.reason ?? "no fast-forward decision recorded"}`,
    startedAt ? `- started: ${startedAt}` : null,
    finishedAt ? `- finished: ${finishedAt}` : null,
    maxParallel ? `- maxParallel: ${maxParallel}` : null,
    archive ? `- full artifacts: \`${archive}\`` : null,
    "",
    "## Undo",
    "",
    // The checkpoint sha is what makes an advisory verifier objection safe to
    // wave through, so it is a command an operator can paste, not a fact.
    "The base branch before this wave, and the exact command to put it back:",
    "",
    "```bash",
    `git update-ref refs/heads/${base} ${baseSha}`,
    "```",
    "",
    "## Tasks",
    "",
    ...bullet(
      tasks.map(
        (task) =>
          `- \`${task.id}\` — **${task.outcome}** after ${task.attempts} attempt${task.attempts === 1 ? "" : "s"}${task.dead ? " (dead: no attempts left)" : ""}`
          // A broker denial never fails a lane, so this row is where it shows (#53).
          + (task.broker?.denied ? `; broker: ${task.broker.denied} denied${task.broker.subjects?.length ? ` (${task.broker.subjects.join(", ")})` : ""}` : ""),
      ),
      "- none scheduled",
    ),
    "",
    "## Failures",
    "",
    ...(reportedFailures.length
      ? reportedFailures.flatMap((failure) => [
          `### \`${failure.id}\` — attempt ${failure.attempt}`,
          "",
          // `reason` is set only when the check hit its bound: `First failing
          // check: swift test` sends the morning's reader after a broken
          // assertion for a check that never returned (#70). Rendered, not
          // composed — the seconds are formatted by `checkFailureReason` in
          // lib.mjs, and this module imports nothing.
          failure.reason ?? (failure.command ? `First failing check: \`${failure.command}\`` : failure.note ?? "No check failed; the agent process itself did not finish."),
          "",
          ...(failure.output ? ["```", failure.output, "```", ""] : []),
        ])
      : ["Nothing failed.", ""]),
    "## Verifier",
    "",
    `Status: **${verifier.status}** — advisory. A verifier objection is recorded here and does not hold a wave off the base branch (docs/wave-mode.md §4).`,
    "",
    ...bullet(
      (verifier.disputed ?? []).map((item) => `- ${item}`),
      "- nothing disputed",
    ),
    "",
    // Without this section the digest cannot tell a wave whose tip was checked
    // from one whose tip was not, and the last wave of a run is the one where
    // that difference is permanent (#78).
    "## Closeout fix gate",
    "",
    `The ${renderCloseoutGateLine(closeoutGate)}`,
    ...(closeoutGate?.output ? ["", "```", closeoutGate.output, "```"] : []),
    "",
    "## Follow-up task files written during this wave",
    "",
    ...bullet(
      followUps.map((name) => `- \`${name}\` — not scheduled tonight; the graph is frozen at t0`),
      "- none",
    ),
    ...(halt?.halt
      ? ["", "## Halted", "", halt.reason, "", `Orphaned: ${halt.orphaned.join(", ") || "none"}`]
      : []),
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
};
