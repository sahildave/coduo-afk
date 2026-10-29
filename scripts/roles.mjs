/**
 * Roles as data (docs/epic-schema.md "Roles").
 *
 * A role is the whole description of one kind of agent this runner starts:
 *
 *   { prompt, model, permissions, phases, pane, timeoutMs }
 *
 * plus two runner-facing labels (`processName`, `laneKey`). Nothing about a
 * role lives in `worker.mjs` or `integrate.mjs` any more — those files pick a
 * role and run it. Adding `plan-reviewer`, `verifier` or `supervisor` is
 * therefore a new entry in `ROLES`, not a new branch in the runner.
 *
 * Two roles exist today and only two: `implementer` is what the runner used to
 * call the builder, `integrator` is what it used to call the merger.
 *
 * Field notes, because the defaults are load-bearing:
 *
 * - A `null` `model` or `timeoutMs` means "inherit the project's `agent` block
 *   in .afk-setup/config.yaml". `integrator` keeps `model: null` and inherits
 *   the senior default; `implementer` and `reflector` pin their own tier
 *   (claude-opus-5-5 and claude-sonnet-5) rather than inheriting the claude-opus-5-5
 *   senior default, so those two no longer inherit `agent.model` — a project that
 *   wants them on the global model sets `roles.<name>.model` to override the
 *   pin. Every role's pin is still beaten by that per-role `roles:` override.
 * - `permissions` is a profile, not a flag. It is rendered two ways:
 *   `preflightSettings()` for the `.claude/settings.local.json` the runner
 *   writes into a worktree it owns, and `settingsArg()` for the invocation
 *   itself. A read-only role gets its `filesystem.allowWrite` cap from
 *   `permissions.sandbox`, never from an argument to `buildAgentCommand` —
 *   that builder is shared by every role (docs/notifications-and-agent-scope.md
 *   §2 argues this at length).
 * - `pane` is where a herdr run puts the agent: `lane` = the task's own
 *   worktree workspace, `parent` = the repo workspace's root pane.
 */
import { agentConfig, agentProcessName, codexOverrides, mergerProcessName, resolveBackend, root, shellQuote } from './lib.mjs';
import { hostInventory, laneContextSettings, laneInstructions } from './lane-context.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeRoot } from './worktree.mjs';
import { defaultPromptPath, promptFor } from './prompts.mjs';
// `plan-reviewer`'s prompt and its whole runner live in scripts/plan-review.mjs,
// which imports this file back for `roleFor`/`preflightSettings`. That cycle is
// fine as long as nothing here *reads* the binding while plan-review.mjs is
// still evaluating — hence the arrow wrapper on `prompt` below rather than a
// direct reference, which throws a TDZ ReferenceError when epic.mjs is the entry.
import { planReviewPrompt } from './plan-review.mjs';

// Substituted for the agent's own working directory when a sandbox profile is
// rendered. A role cannot know its worktree path; it can say "my own cwd".
export const CWD = '<cwd>';

// The phase walk a lane agent follows, mirrored into its visible checklist and
// into report.mjs. Both of today's roles walk the same one; a role is free to
// carry a different list.
const LANE_PHASES = ['Resolve', 'Context', 'Plan', 'Implement', 'Test', 'Self-check', 'Report'];

// A role's own phase walk, as the sentence a prompt's `{{phases}}` mark renders.
// Read from the role record so the prompt file and the herdr pointer prompt
// (scripts/runtime-herdr.mjs `pointerPrompt`) cannot drift apart. Safe despite
// `ROLES` being declared below: this runs when a prompt is rendered, never
// while the module is still evaluating.
const phaseLine = (roleName) => roleFor(roleName).phases.join(' → ');

// Sub-agents, denied to every role that runs unattended against a deadline.
//
// Measured on epic #23: a builder finished writing its file in the first few
// minutes, delegated `node afk.mjs selftest` to a sub-agent via `Task`, and then
// sat on "Waiting for task" for 14m53s until the agent deadline killed it —
// twice, identically, losing the epic. The check itself takes 27 seconds in that
// same worktree; the delegation was the whole cost.
//
// It is also the same rule `denySkills: ['herdr']` already encodes for the same
// reason: one ticket, one agent, one sealed worktree. A sub-agent is invisible
// to every timeout, token counter and permission profile the runner maintains,
// so a lane that spawns one is running work the runner cannot see, cannot cap,
// and cannot kill.
const SUBAGENT_DENY = ['Task'];

// Credential paths no agent has any business reading, whatever else it may do.
const CREDENTIAL_DENY = [
  'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.gnupg/**)', 'Read(~/.config/gh/**)',
  'Read(~/.npmrc)',
];
// Not `~/.infisical`: Claude Code merges `Read(...)` denies into the sandbox's
// `filesystem.denyRead`, and a sandboxed `infisical run` with no network serves
// secrets from the backup there. Read-denied it fails "No valid login session
// found", and every Infisical-wrapped check in a lane or verifier goes red.
// `~/.npmrc` read-denied only makes pnpm warn; npm and pnpm still run.

// Edit-tool denies for the two roles that run under `--dangerously-skip-permissions`.
// Bypass removes the layer that refused an out-of-directory `Write`, and the
// sandbox never covered `Write`/`Edit` (docs/permissions.md gotcha 6), so these
// rules are the only thing between a lane and the operator's home config. Lanes
// wrote `~/.claude/projects/*/memory/` in the 2026-08 transcript audit. An
// `Edit(...)` deny also covers `Write`, shell `>`/`>>` redirects and `tee`
// targets, and holds in bypass mode. Claude Code also merges these into a
// rendered sandbox's `filesystem.denyWrite`; nothing sandboxed in a lane writes
// there, and the sandbox's allowWrite already leaves all five out.
const HOME_EDIT_DENY = [
  'Edit(~/.claude/**)', 'Edit(~/.ssh/**)', 'Edit(~/.aws/**)', 'Edit(~/.gnupg/**)', 'Edit(~/.config/gh/**)',
];

// A builder in its own lane edited the MAIN checkout twice (atlas-workspace task
// 309, voice-studio task 115), so the implementer's file tools are refused the
// whole project root (`permissions.guardProjectRoot`). Nothing a lane must write
// lives there: its report is `.afk-report.json` in the lane, its checklist is
// under `/tmp`, and `.afk/runs/<task>/` is only READ by it.
//
// A PreToolUse hook, not an `Edit(<root>/**)` deny: Claude Code merges Edit
// denies into the sandbox's `denyWrite`, which beats the sandbox's grant of the
// shared `<root>/.git` and broke `git add`/`stash`/`checkout` in every linked
// worktree lane (`index.lock: Operation not permitted`). Hook decisions do not
// reach the sandbox. Sandboxed Bash (herdr lanes) is kept out of the root by
// allowWrite; under `--runtime=direct` no sandbox is rendered.
// The lanes directory and the lane's own worktree go to the hook too: the own
// lane is allowed (even when AFK_WORKTREE_ROOT puts it inside the project), and
// every other path under the lanes directory is a sibling and refused. The lane
// is fixed here at render time rather than read from the agent's cwd, which
// follows every `cd`. Rendered without a lane, the hook refuses every lane.
export const PROJECT_ROOT_GUARD = fileURLToPath(new URL('./project-root-guard.mjs', import.meta.url));
const projectRootGuard = (projectRoot, lane) => ({
  PreToolUse: [{
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    hooks: [{
      type: 'command',
      command: ['node', PROJECT_ROOT_GUARD, resolve(projectRoot), worktreeRoot(projectRoot), ...(lane ? [resolve(lane)] : [])]
        .map(shellQuote).join(' '),
    }],
  }],
});

/**
 * Commands that destroy a SHARED resource, denied to every role.
 *
 * The verifier's cap is its working directory — a disposable checkout nothing
 * reads back. That holds for files and holds for nothing else. A local
 * Postgres, a Docker volume, a simulator's data, the developer's own Supabase
 * stack: none of them live in the cwd, so none of them are protected by it,
 * and a gate that resets one resets the real thing.
 *
 * This nearly happened. Every atlas-central closeout reports `pnpm run test:db`
 * failing because `supabase db reset` could not start a local stack, and the
 * proposed fix for that class of failure is to give the reviewer network access
 * (see `sandbox.network` below). Network access does not make `db reset`
 * safe — it makes it SUCCEED. Whoever grants the network must not thereby also
 * grant the reset, so the two land together and this half is not optional.
 *
 * Deny rules outrank allow rules in Claude Code, so a `roles.<name>.gates`
 * entry cannot re-enable any of these — which is the point: `test:db` may be a
 * declared gate and still must not be able to drop a database.
 */
const DESTRUCTIVE_DENY = [
  'Bash(supabase db reset:*)', 'Bash(supabase db push:*)', 'Bash(supabase stop:*)',
  'Bash(prisma migrate reset:*)', 'Bash(npx prisma migrate reset:*)',
  'Bash(dropdb:*)', 'Bash(docker volume rm:*)', 'Bash(docker system prune:*)',
  'Bash(xcrun simctl erase:*)', 'Bash(xcrun simctl delete:*)',
  'Bash(rm -rf /:*)', 'Bash(git clean -xfd:*)',
];

/**
 * The task specification is `task.body` — held in memory, never read off disk.
 * It used to be `planning/tasks/<id>.md` inside the worktree, which meant the
 * spec could be edited by the very agent it was instructing.
 *
 * `ledgerNotes` is the rendered `.afk/epic-ledger.yaml` entries tagged for this
 * task — the one-way cross-lane channel (docs/epic-schema.md, "Communication").
 * It sits in the same position, and is inert for the same reason: a lane cannot
 * mark its own work passed, so a finding from another lane can add context and
 * cannot release a gate.
 *
 * `customInstructions` is the epic-wide, additive-only string from `afk epic
 * --instructions=`. It is placed BEFORE the sentence that says the builder
 * rules override any instruction, so that sentence governs it. It is
 * deliberately not content-filtered here: gates are enforced in the report API
 * and a lane cannot mark its own work passed, so the string is made inert by
 * position rather than by a regex over free-form English.
 */
// Patterns an override must still match. Not style policing: `verifier` and
// `supervisor` are parsed by taking the LAST fenced `json` block of the
// agent's output, so an override that drops that instruction produces a report
// the runner cannot read, minutes later, with no hint at the cause.
const REQUIRES_LAST_JSON_BLOCK = [
  {
    pattern: /LAST thing in your final message/,
    why: 'the runner parses this role by taking the last fenced `json` block, so the agent must be told to put it last',
  },
];

// Same idea, for the mark that carries the role's phase walk. The walk is not
// decoration: under the `direct` runtime the prompt file is the ONLY place an
// agent is told it, since `pointerPrompt` (scripts/runtime-herdr.mjs) exists
// only in a herdr pane. An override that drops `{{phases}}` therefore produces
// a lane that plans nothing and reports no progress, and nothing anywhere says
// why. A project that genuinely wants no phase walk can render the mark and
// ignore it in prose; it cannot delete it by accident.
const REQUIRES_PHASES = [
  {
    pattern: /\{\{phases\}\}/,
    why: 'the role\'s phase walk is rendered here, and under the direct runtime this file is the only place the agent is told it',
  },
];

// What a prompt may promise depends on the backend. Under Claude the role gets
// the standing instruction on its system prompt and the elapsed-time hook
// (lib.mjs `withTimeBudget`); Codex gets neither, so its prompt carries the
// short no-offer line instead and no budget line.
const backendSections = (backend) => ({
  timeBudget: backend !== 'codex',
  codex: backend === 'codex',
});

export const implementerPrompt = ({
  task, taskText = '', customInstructions = null, ledgerNotes = null,
  priorAttempts = null, skills = null, projectRoot = null, backend = resolveBackend(),
}) => promptFor('implementer', projectRoot, {
  ...backendSections(backend),
  // Rendered into the prompt file as well as the herdr pointer prompt, because
  // that pointer only exists under the herdr runtime — a direct run would
  // otherwise get no phase walk at all.
  phases: phaseLine('implementer'),
  task: {
    id: task.id,
    title: task.title,
    allowedPaths: task.allowedPaths.join(', '),
    checks: task.checks.join(' ; '),
  },
  skills,
  // Placed AFTER the builder rules, and that position is the whole of its
  // safety: the closing sentence says the rules override any instruction, so
  // it governs this string. Deliberately not content-filtered — gates are
  // enforced in the report API and a lane cannot mark its own work passed, so
  // the string is made inert by position rather than by a regex over English.
  customInstructions,
  // The rendered `.afk/epic-ledger.yaml` entries tagged for this task: the
  // one-way cross-lane channel (docs/epic-schema.md, "Communication"). Inert
  // for the same reason and in the same position.
  ledgerNotes,
  // Why the previous attempts on this ticket died, rendered by
  // `renderPriorAttempts` (scripts/worker.mjs). Absent on attempt 1 and absent
  // whenever every prior attempt never reached the API, so the section is a
  // fact about this ticket or it is not there at all.
  priorAttempts,
  taskText,
}, REQUIRES_PHASES);

export const integratorPrompt = ({
  task, taskText = '', branch, baseSha, baseBranch, integrationBase, taskVerification, diff,
  skills = null, projectRoot = null,
}) => promptFor('integrator', projectRoot, {
  phases: phaseLine('integrator'),
  task: { id: task.id, title: task.title },
  branch, baseSha, baseBranch, integrationBase, diff, taskText, skills,
  taskVerification: JSON.stringify(taskVerification, null, 2),
}, REQUIRES_PHASES);

/**
 * The Reach axis's three runner-computed lists, as prompt text.
 *
 * Absence is stated, never rendered as an empty section: a heading with nothing
 * under it reads as "no seams", and "nobody computed the seams" is a different
 * fact. Same rule the verifier's `skipped` list follows.
 */
const renderReachBlock = (reach) => {
  if (!reach) {
    return 'Reach evidence: the runner computed none for this epic '
      + '(no branch, or the log could not be read). Derive Step 1c\'s lists yourself by grep, '
      + 'and say in `summary` that the lane-vs-lane list was unavailable.';
  }
  const seams = reach.seams ?? [];
  const undeclared = reach.undeclaredWrites ?? [];
  const untouched = reach.untouchedAllowed ?? [];
  // `null` and `[]` are different facts, and the third branch below is the one
  // that matters: a project that declares no `reachReport` command had nobody
  // look, which must not read as an epic that wired everything it exported.
  const unwired = reach.unwired;
  return [
    'Reach evidence, computed by the runner from this branch. These are facts, not opinions —'
    + ' do not re-derive them, read them.',
    '',
    seams.length
      ? `Shared files — written by two or more tasks (${seams.length}):\n${seams
        .map((entry) => `- \`${entry.file}\` — #${entry.tasks.join(', #')}`).join('\n')}`
      : 'Shared files: none. No file on this branch was written by two different tasks.',
    '',
    undeclared.length
      ? `Lanes that kept an edit outside their declared paths (${undeclared.length}):\n${undeclared
        .map((entry) => `- #${entry.taskId}: ${entry.paths.map((p) => `\`${p}\``).join(', ')}`).join('\n')}`
      : 'Out-of-scope writes: none recorded. An empty list means nothing was reverted, which is'
        + ' not the same as a lane having stayed in scope — check the shared files above anyway.',
    '',
    untouched.length
      ? `Declared scope nothing touched (${untouched.length}):\n${untouched
        .map((entry) => `- #${entry.taskId}: ${entry.paths.map((p) => `\`${p}\``).join(', ')}`).join('\n')}`
      : 'Declared scope nothing touched: none — every declared glob matched at least one changed file.',
    '',
    !Array.isArray(unwired)
      ? 'Unwired exports: not computed — this project declares no `reachReport` command, so the'
        + ' runner could not set-diff the two static-analysis payloads. Derive the `unwired` list'
        + ' yourself by grep, as Step 1c describes, and say in `summary` that you did.'
      : unwired.length
        ? `Unwired exports — added by this epic, reachable from no production entry point (${unwired.length}):\n${unwired
          .map((entry) => `- \`${entry.symbol}\`${entry.file ? ` — \`${entry.file}\`` : ''}`).join('\n')}`
        : 'Unwired exports: none. The runner set-diffed the project\'s static analysis at the'
          + ' merge-base and at this branch; every export this epic added is reachable.',
  ].join('\n');
};

/**
 * The verifier's prompt (Lane H).
 *
 * The hard part of this role is that `/code-review` returns **prose** — two
 * sub-agent reports under `## Standards` and `## Spec`, aggregated by the skill.
 * A structured closeout cannot be recovered from that by regex without inventing
 * a grammar the skill never promised. So this prompt does not parse prose: it
 * asks for the prose review *and* a machine-readable restatement of it, and the
 * runner reads only the restatement. Structure by contract, not by parsing.
 *
 * Three properties are load-bearing and are stated to the agent as rules:
 * the JSON block is LAST (enforced by `REQUIRES_LAST_JSON_BLOCK` above); there
 * is no `passed`/`approved`/`complete` field, because this role has no
 * authority to decide any of those; and a criterion with no evidence is
 * `unknown`, never `met` — "I could not check" and "it works" must not
 * collapse into one value.
 */
export const verifierPrompt = ({
  epic = {}, epicBody = null, branch = null, baseBranch = 'main', criteria = [], tasks = [],
  checks = [], schema = '', skills = null, projectRoot = null, reach = null,
}) => promptFor('verifier', projectRoot, {
  phases: phaseLine('verifier'),
  epic: { id: epic.id ?? '?' },
  epicTitle: epic.title ? ` — ${epic.title}` : '',
  branch,
  baseBranch,
  schema,
  skills,
  taskList: tasks.map((task) => `#${task.id} ${task.title}`).join('; ') || 'none recorded',
  // The issue bodies, inline. The role denies `gh` (write verbs and read verbs
  // alike — the deny is verb-shaped) and its sandbox names no network host, so
  // every closeout that went looking for "the originating issue" reported gh as
  // a skipped gate. The runner already holds the text; hand it over.
  ticketBlock: [
    ...(epicBody ? [`### Epic #${epic.id ?? '?'}\n\n${String(epicBody).trim()}`] : []),
    ...tasks
      .filter((task) => task.body)
      .map((task) => `### Task #${task.id} ${task.title ?? ''}\n\n${String(task.body).trim()}`),
  ].join('\n\n') || '(no issue text was recorded for this epic)',
  // The Reach axis's evidence, computed by the runner rather than discovered by
  // the model (`collectReach` in scripts/verifier.mjs, over scripts/reach.mjs).
  // Every line here is a list a script produces in under a second; the reviewer
  // reads it. `null` when the runner could not compute it — and that says so
  // out loud rather than rendering an empty section that reads as "clean".
  reachBlock: renderReachBlock(reach),
  // The project's own gates, named rather than guessed at — the fixer gets the
  // same list. Blank when the project declares none, and the section around it
  // in the template renders nothing.
  checks: checks.map((check) => `- \`${check}\``).join('\n'),
  criteriaBlock: criteria.length
    ? `Acceptance criteria (${criteria.length}):\n${criteria.map((c) => `- [${c.id}] (task #${c.taskId}) ${c.text}`).join('\n')}`
    : 'Acceptance criteria: none were extractable. No child issue body carries a `## Acceptance criteria` section. Review the diff on its own merits and return an empty `criteria` array; do not invent criteria.',
}, [...REQUIRES_LAST_JSON_BLOCK, ...REQUIRES_PHASES]);

/**
 * The fixer's prompt. Its list is the runner's arithmetic over the verifier's
 * report (`fixerItems` in scripts/fixer.mjs), rendered here; the model is never
 * asked to decide what counts as a must-fix.
 */
export const fixerPrompt = ({
  epic = {}, branch = null, baseBranch = 'main', findingsBlock = '', checks = '', schema = '',
  skills = null, projectRoot = null, backend = resolveBackend(),
}) => promptFor('fixer', projectRoot, {
  ...backendSections(backend),
  phases: phaseLine('fixer'),
  epic: { id: epic.id ?? '?' },
  epicTitle: epic.title ? ` — ${epic.title}` : '',
  branch,
  baseBranch,
  findingsBlock,
  checks,
  schema,
  skills,
}, [...REQUIRES_LAST_JSON_BLOCK, ...REQUIRES_PHASES]);

/**
 * The reflector's prompt. It gets absolute paths rather than content: the run
 * log alone can be megabytes, and a prompt that inlined it would spend the
 * window on routine lines before the agent reached the interesting one.
 */
export const reflectorPrompt = ({
  epic = {}, project = null, branch = null, outcome = 'unknown', reason = null,
  fileName = '', evidenceBlock = '', skills = null, projectRoot = null,
}) => promptFor('reflector', projectRoot, {
  phases: phaseLine('reflector'),
  epic: { id: epic.id ?? '?' },
  epicTitle: epic.title ? ` — ${epic.title}` : '',
  project,
  branch,
  outcome,
  reason,
  fileName,
  evidenceBlock,
  skills,
}, REQUIRES_PHASES);

/**
 * The supervisor's prompt (Lane I).
 *
 * One template for six events, because the *shape* of the judgment is identical
 * every time — here is what happened, here is what the runner already concluded
 * deterministically, disagree only with evidence — and six near-identical
 * templates would drift.
 *
 * Two properties are load-bearing and are stated as rules, not hints:
 *
 * - the runner's own deterministic reading (`prior`) is shown to the model, and
 *   a `locked` prior may not be overturned. An observed expired login is a fact;
 *   a model that argues it away is wrong, and the runner discards the argument
 *   (`mergeDecision` in scripts/supervisor.mjs enforces this, not this text).
 * - `actions` names `afk` commands only, from a fixed list. The model does not
 *   run them and cannot run them — `Bash(afk:*)` is denied to this role below.
 *   It proposes; the runner executes, in code, from an allowlist.
 */
export const supervisorPrompt = ({
  event, root = null, question = null, evidence = {}, prior = {},
  classifications = [], recommendations = [], actions = [], schema = '',
  skills = null, projectRoot = null,
}) => promptFor('supervisor', projectRoot, {
  event, root, question, schema, skills,
  prior: JSON.stringify(prior, null, 2),
  evidence: JSON.stringify(evidence, null, 2),
  // Two names rather than one negated section: the template language has no
  // `{{^name}}`, and adding one to express a single either/or is more machinery
  // than the two booleans it would replace.
  locked: Boolean(prior?.locked),
  unlocked: !prior?.locked,
  classifications: classifications.join(', '),
  recommendations: recommendations.join(', '),
  actions: actions.join(', ') || 'none',
}, REQUIRES_LAST_JSON_BLOCK);

export const ROLES = {
  implementer: {
    name: 'implementer',
    unattended: true,
    prompt: implementerPrompt,
    // The build role is pinned to the same model as the senior default
    // (`DEFAULT_AGENT` is claude-opus-5-5), but as its own pin: a project that
    // lowers `agent.model` does not drag the builder down with it. Unlike the
    // null default, this does NOT inherit a project's
    // `agent.model` — a repo that wants its builder on the global model sets
    // `roles.implementer.model` back to it in .afk-setup/config.yaml.
    model: 'claude-opus-5-5',
    permissions: {
      deny: [...CREDENTIAL_DENY, ...SUBAGENT_DENY, ...HOME_EDIT_DENY],
      guardProjectRoot: true,
      // The herdr skill lets an agent start sibling agents in other panes,
      // which would break "one ticket, one agent, one sealed worktree" —
      // and none of the runner's filesystem protections would notice.
      // docs/notifications-and-agent-scope.md §2, roles table.
      denySkills: ['herdr'],
      // bypassPermissions stays; the sandbox is what actually caps it.
      sandbox: { allowWrite: [CWD, '/tmp', '/private/tmp', '/var/tmp'] },
    },
    phases: LANE_PHASES,
    pane: 'lane',
    timeoutMs: null,
    processName: agentProcessName,
    laneKey: (taskId) => `${taskId}`,
  },
  integrator: {
    name: 'integrator',
    unattended: true,
    prompt: integratorPrompt,
    model: null,
    permissions: {
      // Not the project root: merging there is its job.
      deny: [...CREDENTIAL_DENY, ...SUBAGENT_DENY, ...HOME_EDIT_DENY],
      denySkills: ['herdr'],
      // The integrator runs at the project root, where `.claude/` belongs to
      // the project, not the runner. It gets no sandbox profile for the same
      // reason it gets no preflight file: the runner must not overwrite a
      // project's own settings. Its permission profile therefore travels with
      // the invocation (`settingsArg`), not with a file on disk.
      sandbox: null,
    },
    phases: LANE_PHASES,
    pane: 'parent',
    timeoutMs: null,
    processName: mergerProcessName,
    laneKey: (taskId) => `merge-${taskId}`,
  },
  // The semantic tier of validation. Runs once, inside `afk epic`, only if the
  // deterministic tier passed, and BEFORE the feature branch exists — so a
  // contradiction costs one short session and leaves nothing behind.
  // scripts/plan-review.mjs is the whole of it; this record is its profile.
  'plan-reviewer': {
    name: 'plan-reviewer',
    // Lazy on purpose: see the import comment at the top of this file.
    prompt: (input) => planReviewPrompt(input),
    model: null,
    permissions: {
      // Read-only is enforced here, not promised in the prompt. Three layers,
      // because each one alone has a hole: the sandbox stops writes the tools
      // do not mediate, the tool denials stop the tools, and `bypassPermissions:
      // false` (applied in plan-review.mjs) means the role never gets
      // `--dangerously-skip-permissions` in the first place —
      // docs/epic-schema.md: "Only `implementer` and `integrator` need" it.
      // Bash is denied outright: this role is given the epic and the child
      // issues in its prompt and has no reason to run a command, and Bash is
      // the one read tool that can write.
      deny: [
        'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.gnupg/**)', 'Read(~/.config/gh/**)',
        'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch',
      ],
      // docs/notifications-and-agent-scope.md, roles table: no non-supervisor
      // role gets herdr. This one "runs before any pane exists".
      denySkills: ['herdr'],
      // An empty allowWrite is deliberate, and it is also NOT what makes this
      // role read-only. Measured live 2026-08-18 (docs/findings.md 3.2):
      // `allowWrite` is an allow-list that only WIDENS, so `[]` adds nothing
      // rather than forbidding everything, and Claude Code's default grant of
      // the session's working directory stands underneath it. With the deny
      // list removed, this role wrote straight into the repo root. What holds
      // here is `deny` — and specifically the `Bash` entry, without which the
      // Write denial is walked around by a shell redirect.
      sandbox: { allowWrite: [] },
      // Only implementer and integrator need to edit files, so only they get
      // bypass mode (docs/epic-schema.md). Declared on the record, not applied
      // in plan-review.mjs, so `roleAgent` is the single place that reads it.
      bypassPermissions: false,
    },
    // One read of the tickets and one report. It never touches a worktree, so
    // the lane phase walk would be a lie in the herdr sidebar.
    phases: ['Read', 'Review', 'Report'],
    pane: 'parent',
    // Pinned rather than inherited: this is a single bounded judgment over text
    // already in its prompt, and it stands between the human and the run
    // starting. Fifteen minutes of it is a hang, not a deep think.
    timeoutMs: 300_000,
    processName: (epicId) => `agent-plan-review-${epicId}`,
    laneKey: (epicId) => `plan-review-${epicId}`,
  },
  // --- verifier (Lane H) ----------------------------------------------------
  // Self-contained addition. Nothing above this entry is reordered or altered.
  // Everything that *runs* this role — the JSON contract, the parser, the
  // decision function, the markdown renderer and the CLI — lives in
  // scripts/verifier.mjs; only the data lives here.
  verifier: {
    name: 'verifier',
    unattended: true,
    prompt: verifierPrompt,
    // prompts/verifier.md tells it to run `/code-review` whatever the project's
    // `roles:` block says, so the skill trim must never switch it off.
    requiredSkills: ['code-review'],
    model: null,
    permissions: {
      // Read-only rests on three caps, and the first of them is the CWD, not
      // the sandbox payload (docs/findings.md 3.2):
      //
      //   1. WHERE IT RUNS. `sandbox.allowWrite` only ever widens, so omitting
      //      CWD here does not deny CWD — Claude Code grants the agent's own
      //      working directory underneath any payload, and this role wrote the
      //      repository root live through a Bash redirect while every editing
      //      tool was denied. What closes that is `scripts/worktree.mjs`
      //      `roleCwd`: the verifier now runs in a disposable detached checkout
      //      of the branch it reviews, so the default grant lands on a copy
      //      nothing reads back and the project falls outside every allowWrite
      //      entry the sandbox does enforce.
      //   2. the deny rules refuse the editing tools and the Git/gh verbs that
      //      would move a ref or write to the issue. Real, but tool-shaped: a
      //      shell redirect is not a command name, so no allowlist of Bash
      //      verbs would have closed 1 — which is why 1 is solved by cwd.
      //   3. `bypassPermissions: false` keeps `--dangerously-skip-permissions`
      //      off the command line entirely (scripts/verifier.mjs reads it;
      //      `roleAgent` deliberately does not, so the two roles that existed
      //      before this one keep their byte-identical invocation).
      //
      // Do not "fix" anything here by widening the sandbox; the cap is the
      // point, and the cwd is the lever.
      //
      // docs/epic-schema.md, "Rejected: librarian": the verifier gates the epic
      // and a gate that can write to the thing it gates is honor-system. The
      // runner writes the report to the issue and PR; this role never does.
      deny: [
        ...CREDENTIAL_DENY,
        // Network access (below) turns several of these from "fails to run" into
        // "runs and destroys the developer's local stack". See DESTRUCTIVE_DENY.
        ...DESTRUCTIVE_DENY,
        'Edit', 'Write', 'NotebookEdit',
        'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git merge:*)',
        'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git branch:*)',
        'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)',
      ],
      denySkills: ['herdr'],
      bypassPermissions: false,
      // No CWD entry, on purpose. The implicit grant of the agent's own cwd is
      // the whole write budget this role gets, and that cwd is a throwaway
      // checkout — see the note above. Naming CWD here would grant nothing new
      // and would read as if the project root were meant to be writable.
      sandbox: { allowWrite: ['/tmp', '/private/tmp', '/var/tmp'] },
      // No host by default. A project that wants its build gates to actually
      // run in the review sandbox names the hosts in
      // `roles.verifier.network`, and gets DESTRUCTIVE_DENY with them — see
      // `networkRules`. The empty default keeps every existing project's
      // invocation byte-identical.
      network: [],
    },
    // Not LANE_PHASES: this role implements nothing and tests nothing.
    phases: ['Resolve', 'Diff', 'Review', 'Criteria', 'Report'],
    pane: 'parent',
    timeoutMs: null,
    processName: (epicId) => `agent-verify-${epicId}`,
    laneKey: (epicId) => `verify-${epicId}`,
  },
  // --- supervisor (Lane I) --------------------------------------------------
  // Self-contained addition. Nothing above this entry is reordered or altered.
  // Everything that *runs* this role — the six event entry points, the
  // deterministic prior, the parser, the merge rule, the action allowlist and
  // the CLI — lives in scripts/supervisor.mjs; only the data lives here.
  // The bounded fixer docs/epic-schema.md named as the thing "Rejected:
  // librarian" forwent. It is not that librarian: it renders nothing, writes to
  // no issue or PR, and — the property the rejection was protecting — it did
  // not produce the review it is acting on. The verifier judged; this one only
  // changes code, and cannot judge whether the change was enough.
  fixer: {
    name: 'fixer',
    unattended: true,
    prompt: fixerPrompt,
    model: null,
    permissions: {
      // Unlike the verifier this role MUST write, so the cwd cannot be the cap
      // — its whole output is a commit on the branch the epic just merged. The
      // cap is therefore the deny list, and what it denies is everything that
      // would let this pass leave the local branch or speak for the runner:
      //
      //   push/merge     it must not land its own fixes anywhere
      //   checkout/reset it must not move off the branch it was pointed at, or
      //                  rewrite the merges it is standing on
      //   gh pr/issue    the runner posts. A fixer that could comment could
      //                  report a fix it did not make, and the comment is the
      //                  only thing a human reads before merging.
      //
      // `git commit` and `git add` are deliberately NOT denied: a fix that is
      // not committed is a dirty tree the next command refuses.
      deny: [
        ...CREDENTIAL_DENY,
        // Same deadline, same trap — and this role runs the project's checks
        // too, which is exactly what the builder delegated away.
        ...SUBAGENT_DENY,
        'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)',
        'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)',
        'Bash(git branch:*)', 'Bash(git worktree:*)',
        'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)',
      ],
      denySkills: ['herdr'],
      bypassPermissions: true,
      sandbox: { allowWrite: [CWD, '/tmp', '/private/tmp', '/var/tmp'] },
    },
    phases: ['Read', 'Fix', 'Check', 'Commit', 'Report'],
    pane: 'parent',
    timeoutMs: null,
    processName: (epicId) => `agent-fix-${epicId}`,
    laneKey: (epicId) => `fix-${epicId}`,
  },

  // The run-shaped half of the "codebase explanation" docs/epic-schema.md left
  // out of "Rejected: librarian" as genuine judgment needing an agent. It reads
  // the run and writes ONE document, in the RUNNER's repository, where the
  // operator already keeps them.
  reflector: {
    name: 'reflector',
    prompt: reflectorPrompt,
    // Report-writing, not senior-dev work: pinned to Sonnet 5 rather than the
    // claude-opus-5-5 senior default, but at high effort — the retrospective is
    // the one place a cheaper model earns its reasoning back. A repo overrides
    // either via `roles.reflector.model` / `.reasoningEffort` in
    // .afk-setup/config.yaml.
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
    permissions: {
      // The cwd IS the cap, exactly as it is for the verifier and for the same
      // reason (docs/findings.md 3.2): Claude Code grants the agent's own
      // working directory unconditionally and `allowWrite` only ever widens, so
      // the only reliable way to bound where a role writes is to stand it
      // somewhere harmless. Here that is the reflections folder itself — the one
      // directory this role is supposed to write — and the project it just read
      // is outside every entry below.
      //
      // Reads are not capped, and must not be: the whole job is reading the
      // run's artifacts by absolute path.
      deny: [
        ...CREDENTIAL_DENY,
        'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git merge:*)',
        'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git branch:*)',
        'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)',
      ],
      denySkills: ['herdr'],
      bypassPermissions: false,
      sandbox: { allowWrite: [CWD, '/tmp', '/private/tmp', '/var/tmp'] },
    },
    // `Sort` is its own phase because it is the step that decides whether this
    // document is worth reading later: one-off, or a shape that will bite again.
    phases: ['Read', 'Reconstruct', 'Sort', 'Write', 'Report'],
    pane: 'parent',
    timeoutMs: null,
    processName: (epicId) => `agent-reflect-${epicId}`,
    laneKey: (epicId) => `reflect-${epicId}`,
  },

  supervisor: {
    name: 'supervisor',
    prompt: supervisorPrompt,
    // Reading panes is its job (see `denySkills: []` below), so the skill trim
    // must keep `herdr` on even when the project's `roles:` lists say nothing.
    requiredSkills: ['herdr'],
    model: null,
    permissions: {
      // Read-only, by the same caps as the verifier — including the cwd cap
      // that carries the weight: `Bash` is allowed here by necessity and a
      // shell redirect is not a command name, so the project root is kept out
      // of reach by running this role in a scratch directory instead
      // (scripts/worktree.mjs `roleCwd`, docs/findings.md 3.2). Plus two
      // denials specific to this role, which are the whole authority split
      // expressed as permissions:
      //
      //   `Bash(afk:*)` / `Bash(node afk.mjs:*)` — docs/epic-schema.md says the
      //   supervisor "acts through the same `afk` commands a human would". It
      //   proposes them; scripts/supervisor.mjs renders the allowlisted ones to
      //   argv and the RUNNER spawns them. The LLM never executes an action, so
      //   a hallucinated `afk reset` cannot reach a shell.
      //
      //   the mutating `herdr` verbs — see `denySkills` below.
      deny: [
        ...CREDENTIAL_DENY,
        'Edit', 'Write', 'NotebookEdit',
        'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git merge:*)',
        'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git branch:*)',
        'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)',
        'Bash(afk:*)', 'Bash(node afk.mjs:*)',
        // The read verbs stay: reading a pane is the point. These five are the
        // ones scripts/runtime-herdr.mjs itself uses to MUTATE the pane layout,
        // and a supervisor that closes a workspace or sends keys to a lane has
        // stopped supervising and started scheduling.
        'Bash(herdr agent:*)', 'Bash(herdr worktree:*)',
        'Bash(herdr workspace create:*)', 'Bash(herdr workspace close:*)',
        'Bash(herdr pane rename:*)',
      ],
      // THE ONE ROLE THAT KEEPS THE HERDR SKILL.
      // docs/notifications-and-agent-scope.md, roles table: implementer no,
      // integrator no, plan-reviewer no, verifier no, `supervisor` **yes** —
      // "Reading panes is how it answers 'what is 207 doing'". An empty list is
      // therefore deliberate and is asserted by a test, so a later sweep that
      // adds 'herdr' to every role for symmetry fails loudly instead of quietly
      // blinding this one. The escape the deny list closes for lane roles —
      // starting a sibling agent — is closed here by `Bash(herdr agent:*)`
      // above instead, because this role has no lane to escape from.
      denySkills: [],
      // Bash is allowed, unlike plan-reviewer's. This role's whole input is
      // logs, run state and panes, all of which are read with a command.
      bypassPermissions: false,
      // No CWD entry: the implicit cwd grant is the whole write budget, and
      // that cwd is a scratch directory outside the project. `.afk/supervisor/`
      // is written by the RUNNER around the agent, never by the agent — same
      // split as the verifier's report, and now enforced by where it runs.
      sandbox: { allowWrite: ['/tmp', '/private/tmp', '/var/tmp'] },
    },
    // Not LANE_PHASES: it implements nothing, tests nothing and reports on a
    // run rather than on a diff.
    phases: ['Read', 'Judge', 'Answer'],
    pane: 'parent',
    // Pinned, and short. This fires while a run is in flight; every second of it
    // is a second the scheduler's next decision waits behind. A supervisor still
    // thinking after three minutes has failed to be a *short* session, which is
    // the property docs/epic-schema.md asks of it ("event-driven, not
    // resident"). Deliberately not `model`-pinned: a cheaper model is the
    // obvious next economy but no model id has been measured on this judgment,
    // and guessing one here would be an unverified behaviour change.
    timeoutMs: 180_000,
    processName: (key) => `agent-supervise-${key}`,
    laneKey: (key) => `supervise-${key}`,
  },
};

/**
 * The skills a role is given, as the paragraph the prompt's `{{skills}}` mark
 * renders (docs/epic-schema.md "Roles"). Data in, text out; nothing here
 * decides which skills a project has.
 *
 *   roles:
 *     implementer:
 *       always: [implement]     a RULE — the agent applies each one
 *       offer:  [shadcn]        a CHOICE — only when the task needs it
 *
 * The list exists because a model that is not told which skills are installed
 * invents plausible names, and an invented name fails silently as "no such
 * skill". It is not a restriction; `offer` deliberately leaves the judgment
 * with the agent, which is why there is no per-ticket signal to maintain.
 *
 * Written by `setup-coduo-agents` from the repo's enabled plugins, and safe to
 * hand-edit — `.afk-setup/config.yaml` is committed and human-owned.
 */
export const skillsFor = (config, roleName) => {
  const role = roleFor(roleName);
  const spec = config?.roles?.[roleName] ?? {};
  const denied = new Set(role.permissions.denySkills ?? []);
  // A config that grants a skill the ROLE denies is a contradiction, and the
  // deny rule wins — it is rendered into the agent's own settings, so the
  // grant would only ever produce an agent told to use a skill that fails.
  // Refuse it here, where the file that says it can be named.
  const check = (list, field) => (list ?? []).map((skill) => {
    if (denied.has(skill)) {
      throw new Error(
        `.afk-setup/config.yaml: roles.${roleName}.${field} lists "${skill}", `
        + `which the ${roleName} role denies. Remove it, or the agent is told to use a skill it cannot load.`,
      );
    }
    return skill;
  });
  const always = check(spec.always, 'always');
  const offer = check(spec.offer, 'offer');
  // `notes` is prose for a stack that has no skill — which is most of them.
  // Without it a project on Expo, Supabase or Stripe gets nothing from its
  // stack at all, and the whole `roles:` block would only serve the few
  // stacks that happen to ship a plugin.
  const notes = typeof spec.notes === 'string' ? spec.notes.trim() : '';
  if (!always.length && !offer.length && !notes) return null;
  return [
    always.length
      ? `Apply these skills to every task, before you start: ${always.join(', ')}.`
      : '',
    offer.length
      ? `These skills are installed for this project. Read and apply one only when it is relevant to your task: ${offer.join(', ')}. Do not use a skill your task does not need.`
      : '',
    notes ? `What this project is built with:\n${notes}` : '',
  ].filter(Boolean).join('\n\n');
};

/**
 * Build a role's prompt with its configured skills already resolved. Every
 * caller goes through here rather than `role.prompt` directly, so a new role
 * gets the `{{skills}}` join for free and none of them can forget it.
 */
export const rolePrompt = (role, config, input) =>
  role.prompt({ ...input, skills: skillsFor(config, role.name), backend: input.backend ?? resolveBackend() });

export const roleFor = (name) => {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role "${name}". Known roles: ${Object.keys(ROLES).join(', ')}.`);
  return role;
};

// Skills go through the same permission system as any other tool. Both forms
// are needed: `Skill(herdr)` matches a bare invocation, `Skill(herdr *)` one
// carrying arguments. Verified 2026-08-18 (docs/notifications-and-agent-scope.md).
export const skillDenyRules = (role) =>
  (role.permissions.denySkills ?? []).flatMap((skill) => [`Skill(${skill})`, `Skill(${skill} *)`]);

/**
 * The project's declared gate commands for a role, from `roles.<name>.gates`
 * in `.afk-setup/config.yaml`, rendered as the two settings that let them run
 * under `-p`.
 *
 * A read-only role runs `--permission-mode default` with no one to answer a
 * prompt, so any command the sandbox cannot hold — `xcodebuild` writing
 * DerivedData, `xcrun simctl` talking to CoreSimulator — falls through to the
 * permission flow and is denied. That is how epic #391's verifier ran zero of
 * six gates. Each listed command becomes:
 *
 *   - `sandbox.excludedCommands` entries, so it runs outside the sandbox at all;
 *   - a `Bash(<command>:*)` allow rule, so it is auto-approved once there.
 *
 * Only the listed prefix is allowed. `xcrun simctl` leaves `xcrun git push`
 * unsandboxed AND unallowed, which under `-p` is a denial. Deny rules outrank
 * allow rules in Claude Code, so a gate cannot re-enable a denied verb either.
 */
/**
 * The hosts a role may reach, from `roles.<name>.network` in
 * `.afk-setup/config.yaml`, unioned with the role's own default.
 *
 * Opt-in by host, never a blanket grant. Measured across seven closeouts on
 * 2026-09-18, network denial accounted for four of roughly fifteen skipped
 * gates — SPM resolution (`CONNECT 403` on github.com), `next/font` reaching
 * fonts.googleapis.com, and infisical's `eu.infisical.com`. The other eleven
 * were FILESYSTEM failures (a `node_modules` symlink outside the writable
 * roots, `../.atlas-target`, `~/.supabase`) and no amount of network fixes
 * them, so this is a partial remedy and is documented as one.
 *
 * An allowlist rather than `network: true` for the obvious reason and one less
 * obvious one: the verifier reads a branch that agents wrote, so its prompt and
 * its diff are attacker-influenced in the ordinary prompt-injection sense. A
 * reviewer with unrestricted egress and the repository in its context is an
 * exfiltration path; a reviewer that may reach the package registries its build
 * needs is not.
 *
 * `gh` stays denied and is deliberately NOT in any default list. The epic and
 * every child issue are reproduced verbatim in the verifier's own prompt
 * (prompts/verifier.md), so the Spec axis has the spec without a network call —
 * and a reviewer that can reach the GitHub API is one `gh pr review` away from
 * writing to the thing it gates, which is the property docs/epic-schema.md's
 * "Rejected: librarian" exists to protect.
 */
export const networkRules = (config, roleName, role = null) => {
  const declared = config?.roles?.[roleName]?.network;
  if (declared != null && (!Array.isArray(declared) || !declared.every((h) => typeof h === 'string' && h.trim()))) {
    throw new Error(
      `.afk-setup/config.yaml: roles.${roleName}.network must be a list of hosts `
      + '(e.g. ["registry.npmjs.org", "fonts.googleapis.com"]). '
      + 'There is no "allow everything" value on purpose.',
    );
  }
  const hosts = [...new Set([
    ...(role?.permissions?.network ?? []),
    ...(declared ?? []).map((host) => host.trim()),
  ])].sort();
  return hosts;
};

export const gateRules = (config, roleName) => {
  const gates = config?.roles?.[roleName]?.gates;
  if (gates == null) return { allow: [], excludedCommands: [] };
  if (!Array.isArray(gates) || !gates.every((gate) => typeof gate === 'string' && gate.trim())) {
    throw new Error(
      `.afk-setup/config.yaml: roles.${roleName}.gates must be a list of command prefixes `
      + '(e.g. [xcodebuild, "xcrun simctl"]).',
    );
  }
  const commands = gates.map((gate) => gate.trim());
  return {
    allow: commands.map((command) => `Bash(${command}:*)`),
    excludedCommands: commands.flatMap((command) => [command, `${command} *`]),
  };
};

// The settings file the runner owns inside a worktree it created. Highest
// precedence scope, so it beats user-level skills and settings.
export const preflightSettings = (role, cwd, config = null) => {
  const gates = gateRules(config, role.name);
  const network = networkRules(config, role.name, role);
  return {
    permissions: {
      deny: [...(role.permissions.deny ?? []), ...skillDenyRules(role)],
      ...(gates.allow.length ? { allow: gates.allow } : {}),
    },
    ...(role.permissions.sandbox
      ? {
          sandbox: {
            enabled: true,
            filesystem: {
              allowWrite: role.permissions.sandbox.allowWrite.map((p) => (p === CWD ? cwd : p)),
            },
            // Absent when no host is allowed, so a role that was never granted
            // egress renders byte-identically to before this existed.
            // `network.allowedDomains` is the real key — verified against the
            // installed Claude Code 2.1.278 binary, which also carries
            // `deniedDomains`, `allowUnixSockets` and `allowLocalBinding`. An
            // earlier cut of this wrote `network.allow`, which is not a key the
            // runtime reads: the payload would have been accepted in silence
            // and every gate would have stayed exactly as denied as before,
            // with a config line claiming otherwise.
            ...(network.length ? { network: { allowedDomains: network } } : {}),
            ...(gates.excludedCommands.length ? { excludedCommands: gates.excludedCommands } : {}),
          },
        }
      : {}),
  };
};

// The part of the profile that must hold wherever the role runs, including in
// a directory whose `.claude/` the runner does not own. `claude --settings`
// takes a JSON string; deny rules union across scopes, so passing this
// alongside a preflight file is safe and additive.
//
// It also carries the context trim (scripts/lane-context.mjs): auto-memory off,
// and every plugin and loose skill the role's `roles:` lists do not name
// switched off. `inventory` is what this host would load; read once per process
// unless a test hands one in.
//
// `AFK_CONTEXT_HOME`, when set, is read as both the home directory and the
// project root, so the self-test suite (afk.mjs points it at an empty
// directory) never reads the operator's real ~/.claude.
let hostInventoryMemo = null;
const defaultInventory = () => (hostInventoryMemo ??= process.env.AFK_CONTEXT_HOME
  ? hostInventory(process.env.AFK_CONTEXT_HOME, process.env.AFK_CONTEXT_HOME)
  : hostInventory(root));

export const settingsArg = (role, config = null, inventory = defaultInventory(), projectRoot = root, lane = null) => {
  const trim = laneContextSettings(role, config, inventory);
  // A sandbox naming CWD can only be rendered where the cwd is known, which is
  // the preflight file inside a worktree the runner created. A cwd-free sandbox
  // — every read-only role — has no such worktree: it runs at the project root,
  // whose `.claude/` belongs to the project and which the runner must not
  // write. So its whole profile travels on the invocation instead, which is the
  // only way it reaches the role under `--runtime=direct`.
  const sandbox = role.permissions.sandbox;
  if (sandbox && !sandbox.allowWrite.includes(CWD)) {
    return JSON.stringify({ ...preflightSettings(role, null, config), ...trim });
  }
  // A lane role gets no preflight file under `--runtime=direct`, and a role with
  // no sandbox (the integrator) never gets one, so for both the invocation is
  // the only path their deny list has. Deny rules union across scopes, so a
  // herdr lane that has both carries the same rules twice, harmlessly.
  // `projectRoot` is the run's checkout, which the guard hook refuses the file
  // tools; the invocation is the one path that reaches the role on both runtimes.
  // `lane` is the role's own worktree, the one lane the guard lets it write.
  const carried = role.pane === 'lane' || !sandbox ? (role.permissions.deny ?? []) : [];
  const deny = [...carried, ...skillDenyRules(role)];
  return JSON.stringify({
    ...(deny.length ? { permissions: { deny } } : {}),
    ...(role.permissions.guardProjectRoot ? { hooks: projectRootGuard(projectRoot, lane) } : {}),
    ...trim,
  });
};

/**
 * Codex has two tiers and every role sits in exactly one of them.
 *
 * Sol at medium is the reviewing and merging half — plan-reviewer, integrator,
 * fixer, verifier, supervisor. Luna at max is the half that writes new prose or
 * new code from a ticket: implementer and reflector.
 *
 * This table is the ONLY source of a Codex model. The `roles:` block in
 * .afk-setup/config.yaml carries Claude model names (`claude-fable-5` and
 * friends), because the same file serves both executables; under Codex those
 * values are ignored and a project that wants to move a role between tiers
 * writes `roles.<name>.codex.model` instead, which is validated.
 *
 * A role missing from here refuses rather than inheriting a default: a new role
 * whose tier nobody chose is a model choice made by accident.
 */
export const CODEX_ROLE_TIERS = {
  'plan-reviewer': { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  integrator: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  fixer: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  verifier: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  supervisor: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  implementer: { model: 'gpt-5.6-luna', reasoningEffort: 'max' },
  reflector: { model: 'gpt-5.6-luna', reasoningEffort: 'max' },
};

/**
 * The role's filesystem boundary as a Codex sandbox mode. The intent the Claude
 * permission profile carries maps cleanly: a role that names its own working
 * directory in `sandbox.allowWrite` is a writer and gets `workspace-write`; a
 * role whose sandbox never widens to CWD is a reviewer and is capped at
 * `read-only`. The integrator has no sandbox profile at all (it runs at the
 * project root, whose `.claude/` the runner must not write) and is a writer.
 * This mirrors `settingsArg`'s own CWD test, so the two renders of one profile
 * cannot drift.
 */
export const codexSandbox = (role) => {
  const sandbox = role.permissions.sandbox;
  return sandbox && !sandbox.allowWrite.includes(CWD) ? 'read-only' : 'workspace-write';
};

const codexRoleAgent = (role, agent, config) => {
  const tier = CODEX_ROLE_TIERS[role.name];
  if (!tier)
    throw new Error(
      `Role "${role.name}" has no Codex tier. Add it to CODEX_ROLE_TIERS in scripts/roles.mjs — `
      + 'a role with no tier would run on whatever model happened to be lying around.',
    );
  return {
    ...agent,
    ...tier,
    // The project may move a role between tiers, but only through the
    // Codex-specific key, and only with a value that is a Codex model.
    ...codexOverrides(config?.roles?.[role.name]?.codex, `roles.${role.name}.codex`),
    sandbox: codexSandbox(role),
    ...(role.timeoutMs ? { timeoutMs: role.timeoutMs } : {}),
  };
};

/**
 * The effective agent invocation for a role: the project's `agent` block with
 * the role's own overrides applied, plus the role's permission profile — as a
 * `--settings` payload under Claude, as a `--sandbox` mode under Codex. This is
 * the object `buildAgentCommand` and the herdr runtime take; they never see the
 * role itself, so a role stays data.
 */
// Read on first use rather than at import: roles.mjs is imported by every
// entry point, and most of them never build an agent.
let unattended = null;
const unattendedInstruction = () =>
  (unattended ??= readFileSync(defaultPromptPath('_unattended'), 'utf8').trim());

// The runner's own rules about the host machine (simulators), for every Claude
// role. Lanes no longer load the operator's home CLAUDE.md, so the few of its
// rules that lanes must keep ride here instead.
let host = null;
const hostInstruction = () =>
  (host ??= readFileSync(defaultPromptPath('_host'), 'utf8').trim());

// The repo's instruction files (AGENTS.md, CLAUDE.md, nested ones, their
// includes), read once per process. Claude Code's own CLAUDE.md loading is off
// for every runner agent (`laneContextSettings`), so this is how a rule the repo
// makes mandatory reaches a role. Same `AFK_CONTEXT_HOME` switch as the
// inventory, so the self-test suite never reads a real repo's files by accident.
let repoInstructionsMemo = null;
const repoInstructions = () => (repoInstructionsMemo ??= process.env.AFK_CONTEXT_HOME
  ? laneInstructions(process.env.AFK_CONTEXT_HOME)
  : laneInstructions(root));

// What a Claude role gets through `--append-system-prompt`: the standing
// instruction for an unattended role, then the host rules and the repo's
// instruction files for every role.
const appendedSystemPrompt = (role) =>
  [role.unattended ? unattendedInstruction() : '', hostInstruction(), repoInstructions()].filter(Boolean).join('\n\n');

export const roleAgent = (role, config, backend = undefined, projectRoot = root, lane = null) => {
  // `backend` is normally left to the environment the executable set, and is an
  // argument only so a test can name it without mutating process.env.
  const agent = agentConfig(config, backend ?? resolveBackend());
  // Which backend is not a per-role choice: it is which executable the operator
  // ran, and it decides the whole shape of what follows. Claude's model,
  // effort, settings payload and bypass flag are read ONLY on the Claude path.
  if (agent.backend === 'codex') return codexRoleAgent(role, agent, config);
  // Per-role model/effort from the human-owned `roles:` block, overriding the
  // record's own default (`implementer`, `reflector` pin model/effort; the rest
  // leave them null), which in turn overrides the global `agent` block.
  // `skillsFor` already reads this same
  // `config.roles[name]` map for skills; these two keys ride alongside it, so a
  // project pins "senior architect on the plan, mid-level on the build" in the
  // committed config without touching this file.
  const override = config?.roles?.[role.name] ?? {};
  const model = override.model ?? role.model;
  const reasoningEffort = override.reasoningEffort ?? role.reasoningEffort;
  return {
    ...agent,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(role.timeoutMs ? { timeoutMs: role.timeoutMs } : {}),
    settings: settingsArg(role, config, undefined, projectRoot, lane),
    // `unattended` roles work a task through with nobody reading along, so they
    // get the standing instruction about how turns end (prompts/_unattended.md).
    // Single-answer roles do not: their one JSON reply IS the end of the turn.
    // Every role gets the host rules and the repo's instruction files after it.
    appendSystemPrompt: appendedSystemPrompt(role),
    // Only the two roles that need to edit files get bypass mode. A role that
    // sets this explicitly to false never receives
    // `--dangerously-skip-permissions`; implementer and integrator set nothing
    // and so keep the invocation Lane F verified byte-identical.
    ...(role.permissions.bypassPermissions === false ? { bypassPermissions: false } : {}),
  };
};
