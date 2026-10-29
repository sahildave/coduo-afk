// scripts/pr.mjs — the epic's draft PR, as a rendered view of run state.
//
// docs/build-prompt.md, Phase 4 Lane K: "Create the draft PR at feature-branch
// creation. Its body is a rendered view of run state, never the datastore."
//
// The direction of flow is the whole design, so it is worth saying twice:
//
//   .afk/state.json + the in-memory DAG  ──render──▶  the PR body
//
// and never the other way. Nothing in this file — or anywhere else — parses a PR
// body back into run state. `findEpicPr` reads GitHub for exactly one fact, the
// PR *number* for a branch, which is GitHub's own identifier and not run state;
// that is what makes create-or-update idempotent across a restart without this
// module ever persisting a PR id and calling it truth.
//
// Two consequences follow from "view, not datastore", and both are deliberate:
//
//   1. Every failure here degrades to a warning. A run whose PR could not be
//      opened is a run missing a *display*, and nothing reads it, so nothing
//      downstream is wrong. `fetchEpic` in scripts/epic.mjs aborts on a `gh`
//      failure because the DAG it fetches is an input the run cannot proceed
//      without; this is an output. Killing a six-hour run over a network blip in
//      a cosmetic artifact is the trade nobody would make deliberately.
//   2. A human editing the body loses the edit on the next render. Said in the
//      body itself, so it is not a surprise.
//
// `afk validate` never reaches this module. Validation is the acceptance path
// and creates nothing; only feature-branch creation opens a PR.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite, details, lifecycleOf, renderProgress, renderTaskGraphSection, run, shellQuote } from "./lib.mjs";
import { readVerifierReport, renderVerifierMarkdown } from "./verifier.mjs";
import { modelSwitchLine } from "./model-check.mjs";
import { renderMidRunDefects } from "./defects.mjs";

// The `pr:` config knob — when the runner pushes to origin (#130).
export const PR_OFF = "off";
export const PR_ONCE = "once";
export const PR_EACH = "each";
const VALID_PR_MODES = new Set([PR_OFF, PR_ONCE, PR_EACH]);

export const prMode = (config) => {
  const raw = config?.pr ?? PR_ONCE;
  if (!VALID_PR_MODES.has(raw))
    throw new Error(
      `\`pr: ${raw}\` in .afk-setup/config.yaml is not a valid mode. Use one of: ${[...VALID_PR_MODES].join(", ")}.`,
    );
  return raw;
};

// Marks the body as runner-owned. Written, never read for state — its only job
// is to tell a human (and a future `afk`) that this text is generated.
export const prMarker = (epicId) => `<!-- afk:epic-pr ${epicId} -->`;

// The order a human reads a run in, not alphabetical. `awaiting_acceptance`
// leads because it is the only lifecycle the reader of this PR can personally
// clear — everything else is the runner's job.
const LIFECYCLE_ORDER = [
  "awaiting_acceptance",
  "passed",
  "integrating",
  "ready_to_integrate",
  "running",
  "pending",
  "blocked",
  "failed",
  "integration_failed",
  "infra_failed",
];

const summarize = (dag, state) => {
  const counts = new Map();
  for (const task of dag?.tasks ?? []) {
    const lifecycle = lifecycleOf(task, state);
    counts.set(lifecycle, (counts.get(lifecycle) ?? 0) + 1);
  }
  const rank = (name) => {
    const at = LIFECYCLE_ORDER.indexOf(name);
    return at === -1 ? LIFECYCLE_ORDER.length : at;
  };
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1))
    .map(([lifecycle, n]) => `${n} ${lifecycle}`)
    .join(", ");
};

/**
 * The epic's own lifecycle, in one line, so the task table is safe to read alone.
 *
 * Without it the table has no vocabulary for the gate: epic #2's PR #41 said
 * "4 tasks — 4 pending" while all four had merged, and even a correct table can
 * only say `passed` for a `gate: after` ticket — which on a device-acceptance
 * ticket reads as though the device pass happened. The epic-level truth
 * ("awaiting_acceptance, task 32 needs a human") was in the body nowhere at all.
 *
 * Derived from `state.epicClose` and the task lifecycles, so it costs no import
 * and keeps `renderPrBody` pure. `open` is the honest default for a state file
 * that has not reached a close record yet.
 */
const renderEpicStatus = (dag, state) => {
  const close = state.epicClose ?? {};
  const lifecycle = close.lifecycle ?? "open";
  const awaiting = (dag?.tasks ?? [])
    .filter((task) => lifecycleOf(task, state) === "awaiting_acceptance")
    .map((task) => task.id);
  if (lifecycle === "awaiting_acceptance") {
    const who = awaiting.length
      ? `task${awaiting.length === 1 ? "" : "s"} ${awaiting.join(", ")} need${awaiting.length === 1 ? "s" : ""} a human`
      : (close.reason ?? "a `gate: after` ticket needs a human");
    return `**Epic status:** \`awaiting_acceptance\` — every lane finished; ${who}.`
      + ` A gated task is never \`passed\` until a person accepts it; release with`
      + ` \`afk epic <id> --accept=${awaiting.join(",") || "<id>"}\`.`;
  }
  if (lifecycle === "closed") {
    const outcome = close.outcome ? ` \`${close.outcome}\`` : "";
    return `**Epic status:** closed${outcome}${close.reason ? ` — ${close.reason}` : ""}.`;
  }
  return `**Epic status:** \`${lifecycle}\` — the run is still going; this body is refreshed as it moves.`;
};

/**
 * Every role run whose later replies came from a model other than the one its
 * session started on, as a section — or null when there were none, so a clean run adds no
 * heading. Read off the records the runner already keeps: each builder's and
 * integrator's `modelCheck` in state, and the closeout verifier's report. Above
 * the task table, because a lane that finished on a model it did not start on looks
 * exactly like one that did not. scripts/model-check.mjs.
 */
export const renderModelSwitches = (state = {}, verifierReport = null) => {
  const lines = [];
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    const builder = modelSwitchLine(`builder ${id}`, task?.taskVerification?.modelCheck);
    if (builder) lines.push(`- ${builder}`);
    const integrator = modelSwitchLine(`integrator for ${id}`, task?.integratorModelCheck);
    if (integrator) lines.push(`- ${integrator}`);
  }
  const verifier = modelSwitchLine("the closeout verifier", verifierReport?.modelCheck);
  if (verifier) lines.push(`- ${verifier}`);
  return lines.length ? ["### ⚠️ Model switches", "", ...lines].join("\n") : null;
};

/**
 * The PR title. Stable across renders so a human's tab does not churn.
 */
export const renderPrTitle = ({ epic = {}, branch = null }) => {
  const id = epic.id ?? epic.number ?? null;
  const head = id ? `Epic #${id}` : "Epic";
  return epic.title ? `${head} — ${epic.title}` : `${head} — ${branch ?? "afk run"}`;
};

/**
 * The PR body: a pure function of the DAG, `.afk/state.json`, and a timestamp.
 *
 * Pure on purpose. It is the half of this module that can be tested exhaustively
 * without a process, which is why the `gh` half is kept as thin as it is.
 *
 * @param {object} args
 * @param {{id?: string, title?: string|null}} args.epic
 * @param {string|null} args.branch feature branch
 * @param {string|null} args.baseBranch what it merges back into
 * @param {{tasks: object[], epic?: object}} args.dag the in-memory DAG
 * @param {object} args.state parsed .afk/state.json, or {} before the first run
 * @param {object|null} args.verifierReport `.afk/verifier/<epic>/report.json`, or
 *   null. Null is the normal case for most of a run's life — the verifier only
 *   has a report once the epic has been closed out — so an absent report renders
 *   no section at all, not an empty one. Passed in rather than read here so this
 *   function stays pure and testable without a filesystem.
 * @param {string} args.renderedAt ISO timestamp; injected so this stays pure
 * @returns {string} markdown
 */
export const renderPrBody = ({
  epic = {},
  branch = null,
  baseBranch = null,
  dag = { tasks: [] },
  state = {},
  verifierReport = null,
  renderedAt = new Date().toISOString(),
}) => {
  const id = epic.id ?? epic.number ?? dag.epic?.id ?? null;
  const total = (dag.tasks ?? []).length;
  const lines = [
    prMarker(id ?? "?"),
    "",
    `**${renderPrTitle({ epic, branch })}**`,
    "",
    [
      branch ? `Branch \`${branch}\`` : null,
      baseBranch ? `into \`${baseBranch}\`` : null,
    ]
      .filter(Boolean)
      .join(" ") || "",
    "",
    `_Rendered by \`afk\` from \`.afk/state.json\` at ${renderedAt}._`,
    "_This body is a view of run state, not its source: `afk` overwrites it on" +
      " every render and never reads it back. Edits here will be lost; they" +
      " change nothing about the run._",
    "",
    renderEpicStatus(dag, state),
    "",
    renderModelSwitches(state, verifierReport) ?? "",
    "",
    "## Progress",
    "",
    total > 0
      ? `**${total} task${total === 1 ? "" : "s"}** — ${summarize(dag, state)}.`
      : "**No tasks in this epic's `afk:` block.**",
    "",
    // The graph, then the table folded underneath it. GitHub renders a
    // ```mermaid fence natively and strips inline SVG and every HTML artifact,
    // so this is the only picture a PR body can carry — and a dependency graph
    // is the one thing the table genuinely could not show.
    renderTaskGraphSection(dag, state),
    "",
    details({
      summary: `Task table — ${total} task${total === 1 ? "" : "s"}, ${summarize(dag, state)}`,
      body: renderProgress(dag, state).replace(/^# Progress[^\n]*\n\n/, ""),
    }),
  ];
  if (state.customInstructions) {
    lines.push("", "### Epic-wide instructions", "", `> ${state.customInstructions}`);
  }
  // The closeout review, when one exists. Last, because it is the end of the
  // run and the progress table is what a human scans for mid-run.
  //
  // Guarded on truthiness rather than handed straight to the renderer:
  // `renderVerifierMarkdown(null)` deliberately renders "_No verifier report._",
  // which is right for `afk verify --markdown` and wrong here — for most of a
  // run there is simply nothing to say, and a placeholder in the PR body reads
  // as a verifier that ran and found nothing rather than one that never ran.
  // (#215) Every defect caught mid-run with its lesson, or `Lesson: missing`.
  // Rendered mid-run too: a missing lesson is cheapest to supply while the
  // salvage that fixed it is fresh.
  const defects = renderMidRunDefects(state);
  if (defects) lines.push("", defects);
  if (verifierReport) {
    lines.push("", renderVerifierMarkdown(verifierReport).trim());
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

// ---------------------------------------------------------------------------
// The `gh` half. One seam: `exec`, defaulting to lib.mjs's `run`, exactly as
// scripts/epic.mjs does for `fetchEpic` and `branchStatusOf`. Tests inject.
// ---------------------------------------------------------------------------

/**
 * Read `.afk/state.json` if it exists. Absent before the first run, and a
 * corrupt file is not worth failing a render over.
 */
export const readRunState = (root) => {
  const path = resolve(root, ".afk", "state.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/**
 * The PR for a branch, asked of GitHub rather than remembered.
 *
 * This is the create-or-update discriminator, and it deliberately holds no local
 * memory: GitHub owns the mapping branch → PR number, so a restart, a wiped
 * `.afk/`, or a PR opened by hand all resolve the same way.
 *
 * @returns {{number: number, state: string, isDraft: boolean}|null}
 */
export const findEpicPr = ({ repo, branch, exec = run, cwd }) => {
  const result = exec(
    `gh pr list --repo ${shellQuote(repo)} --head ${shellQuote(branch)} --state all --limit 1 --json number,state,isDraft`,
    cwd ? { cwd } : {},
  );
  if (result.status !== 0) {
    throw new Error(
      `gh could not list pull requests for ${repo}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const rows = JSON.parse(result.stdout || "[]");
  return rows.length > 0 ? rows[0] : null;
};

const withBodyFile = (body, fn) => {
  const path = join(tmpdir(), `afk-pr-${process.pid}-${Date.now()}.md`);
  writeFileSync(path, body);
  try {
    return fn(path);
  } finally {
    rmSync(path, { force: true });
  }
};

/**
 * Push the branch, then create the epic's draft PR or re-render the body of the
 * one that exists.
 *
 * **The push and the render are one step, and the push goes first.** This is not
 * housekeeping, it is the correctness property: the body describes commits, so a
 * body rendered ahead of the push describes commits the remote does not have.
 * Epic #4 closed with `origin/feat/4-daily-challenge-roulette` six commits
 * behind — including the merge commits for tasks #27 and #28 — while PR #43's
 * table claimed both had passed and its diff contained neither. The log line
 * `EPIC: refreshed draft PR #43 from run state` read as though something had
 * reached GitHub; nothing had. Keeping the push inside this function is what
 * makes the two atomic by construction, with no call site able to do one without
 * the other.
 *
 * Called from `scripts/epic.mjs` at feature-branch creation and on every `afk
 * epic` restart, and from `closeEpic` in `scripts/auto.mjs` at epic close — the
 * same call does all three, because "does it exist" is a question for GitHub,
 * not for state. The close-time call is load-bearing: a run that starts, dies,
 * restarts onto the existing branch and completes (epic #6) reaches no other
 * path that can open a PR once commits exist.
 *
 * **Never throws and never fails a run.** Every problem comes back as a warning
 * naming its fix, and the caller prints it and carries on. See the header.
 *
 * @returns {{action: "created"|"updated"|"skipped"|"failed", number: number|null, warnings: string[], notes: string[], failure?: {step: string, message: string}}}
 */
export const ensureDraftPr = ({
  root,
  repo,
  branch,
  baseBranch = "main",
  epic = {},
  dag = { tasks: [] },
  state = {},
  verifierReport = undefined,
  renderedAt = new Date().toISOString(),
  exec = run,
}) => {
  const warnings = [];
  const notes = [];
  // (#179) `failure` names the step that refused and what it said, so a caller
  // can record a refused push as its own state instead of a log line.
  const done = (action, number = null, failure = null) => ({ action, number, warnings, notes, ...(failure ? { failure } : {}) });
  const git = (command) => exec(command, { cwd: root });

  try {
    if (!repo) {
      warnings.push(
        "no repository — cannot open the epic's draft PR. Pass --repo=<owner/name>.",
      );
      return done("skipped");
    }
    if (!branch) {
      warnings.push("the epic's `afk:` block has no `branch:` — no PR to open.");
      return done("skipped");
    }

    // --- push, before a single character of the body is rendered ------------
    //
    // How many commits the branch carries that the base lacks. Two uses, in this
    // order: nothing to push when it is zero, and GitHub refuses a PR whose head
    // is identical to its base — which is exactly the state of a freshly
    // branched epic, and is a note rather than an error.
    const ahead = git(
      `git rev-list --count ${shellQuote(baseBranch)}..${shellQuote(branch)}`,
    );
    if (ahead.status !== 0) {
      warnings.push(
        `could not compare \`${branch}\` with \`${baseBranch}\`: ${(ahead.stderr || "").trim()}. No PR was opened.`,
      );
      return done("failed", null, { step: "compare", message: (ahead.stderr || "").trim() });
    }
    const commits = Number(ahead.stdout.trim());
    if (commits > 0) {
      if (git("git remote get-url origin").status !== 0) {
        warnings.push(
          "no `origin` remote — cannot open the epic's draft PR. `git remote add origin <url>`.",
        );
        return done("skipped");
      }
      // Unconditional, not "only if the remote branch is missing". The old
      // condition pushed once at creation and never again, which is precisely
      // how a PR ends up describing six commits its diff does not contain. A
      // `git push` with nothing to send is a no-op.
      const pushed = git(`git push -u origin ${shellQuote(branch)}`);
      if (pushed.status !== 0) {
        warnings.push(
          `could not push \`${branch}\` to origin: ${(pushed.stderr || "").trim()}. The PR body was NOT rendered — it would describe commits the remote does not have. The run continues locally.`,
        );
        return done("failed", null, { step: "push", message: (pushed.stderr || "").trim() });
      }
      notes.push(`pushed \`${branch}\` to origin.`);
    }

    // `.afk/verifier/<epic>/report.json` if the closeout has run, else null.
    // Read here rather than in `renderPrBody` so the renderer stays pure; the
    // `undefined` default distinguishes "nobody said" (look on disk) from an
    // explicit `null` (a caller that has already decided there is no report).
    const verifier =
      verifierReport === undefined
        ? readVerifierReport(root ?? ".", epic.id ?? epic.number ?? dag.epic?.id ?? "?")
        : verifierReport;
    const body = renderPrBody({
      epic,
      branch,
      baseBranch,
      dag,
      state,
      verifierReport: verifier,
      renderedAt,
    });
    const title = renderPrTitle({ epic, branch });

    const existing = findEpicPr({ repo, branch, exec, cwd: root });
    if (existing) {
      if (String(existing.state).toUpperCase() !== "OPEN") {
        warnings.push(
          `PR #${existing.number} for \`${branch}\` is ${String(existing.state).toLowerCase()}; not reopening it. Reopen it by hand if this run should report there.`,
        );
        return done("skipped", existing.number);
      }
      const edited = withBodyFile(body, (path) =>
        exec(
          `gh pr edit ${existing.number} --repo ${shellQuote(repo)} --title ${shellQuote(title)} --body-file ${shellQuote(path)}`,
          { cwd: root },
        ),
      );
      if (edited.status !== 0) {
        warnings.push(
          `could not refresh PR #${existing.number}: ${(edited.stderr || edited.stdout || "").trim()}. The run continues; the PR body is stale.`,
        );
        return done("failed", existing.number, { step: "edit", message: (edited.stderr || edited.stdout || "").trim() });
      }
      return done("updated", existing.number);
    }

    // Nothing to open a PR against: the branch is identical to its base, which
    // is the state of a freshly branched epic. Not an error — it opens as soon
    // as a lane integrates, and at the latest when the epic closes.
    if (commits === 0) {
      notes.push(
        `no commits on \`${branch}\` yet — GitHub cannot open a PR against an identical branch. It opens as soon as a lane integrates, at the latest when the epic closes.`,
      );
      return done("skipped");
    }

    const created = withBodyFile(body, (path) =>
      exec(
        `gh pr create --repo ${shellQuote(repo)} --draft --base ${shellQuote(baseBranch)} --head ${shellQuote(branch)} --title ${shellQuote(title)} --body-file ${shellQuote(path)}`,
        { cwd: root },
      ),
    );
    if (created.status !== 0) {
      warnings.push(
        `could not open the draft PR: ${(created.stderr || created.stdout || "").trim()}. If this is an auth problem, \`gh auth login\`. The run continues.`,
      );
      return done("failed", null, { step: "create", message: (created.stderr || created.stdout || "").trim() });
    }
    const number = Number(
      /\/pull\/(\d+)/.exec(created.stdout || "")?.[1] ?? NaN,
    );
    return done("created", Number.isInteger(number) ? number : null);
  } catch (error) {
    // Anything unforeseen — `gh` missing from PATH, unparseable JSON, a thrown
    // exec — is still only a missing view. Never a dead run.
    warnings.push(
      `the epic's draft PR could not be reconciled: ${error.message}. If \`gh\` is unauthenticated or offline, \`gh auth login\`. The run continues; nothing reads the PR body.`,
    );
    return done("failed", null, { step: "error", message: error.message });
  }
};

/**
 * (#179) Folds one `ensureDraftPr` outcome into `state.prDelivery`. Only a
 * refused push or a failed PR creation means the epic did not reach GitHub; a
 * failed body refresh on an open PR (step `edit`) leaves branch and PR there, so
 * it counts as delivered. A compare or thrown error says nothing either way and
 * leaves the record alone. Returns true when `state` changed.
 */
export const DELIVERY_FAILURE_STEPS = new Set(["push", "create"]);
export const applyPrDelivery = (state, outcome, at = new Date().toISOString()) => {
  if (outcome?.failure && DELIVERY_FAILURE_STEPS.has(outcome.failure.step)) {
    state.prDelivery = { status: "failed", at, ...outcome.failure };
    return true;
  }
  const delivered =
    outcome?.action === "created" || outcome?.action === "updated" || outcome?.failure?.step === "edit";
  if (delivered && state.prDelivery) {
    delete state.prDelivery;
    return true;
  }
  return false;
};

/**
 * `applyPrDelivery` for the callers outside `runAuto` (`afk finish --push`,
 * `afk epic`): re-reads `.afk/state.json` and writes it back only on a change.
 */
export const persistPrDelivery = (root, outcome) => {
  const path = resolve(root, ".afk", "state.json");
  if (!existsSync(path)) return false;
  const state = readRunState(root);
  if (!applyPrDelivery(state, outcome)) return false;
  state.updatedAt = new Date().toISOString();
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
  return true;
};

/**
 * The one-line report `afk epic` prints. Kept here so the hook in
 * scripts/epic.mjs stays a call and a print.
 */
export const renderPrOutcome = (outcome) =>
  [
    outcome.action === "created" && `EPIC: opened draft PR${outcome.number ? ` #${outcome.number}` : ""}.`,
    outcome.action === "updated" && `EPIC: refreshed draft PR #${outcome.number} from run state.`,
    ...outcome.notes.map((note) => `EPIC: ${note}`),
    ...outcome.warnings.map((warning) => `EPIC: ${warning}`),
  ]
    .filter(Boolean)
    .join("\n");
