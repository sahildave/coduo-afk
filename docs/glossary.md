# Glossary

The runner's vocabulary, in one place. Several of these words mean something
narrower here than a reader would assume, so each entry names the file or
command where the term is actually realised.

## Runner

The code: `afk` (`afk.mjs`), `scripts/auto.mjs` and the scripts it drives. It
owns the queue, the lane slots, the integration order and every pass or fail.
The supervisor is a read-only model role inside it and only advises.

## Orchestrator

The Claude session that runs one epic: it validates the epic, starts the
runner, checks in on it and closes the run out, following the `coduo-afk`
skill. It sits outside the runner and makes none of the runner's decisions.

A chief of staff starts each Orchestrator as a full interactive `claude` in a
herdr pane (`scripts/orchestrator-herdr.mjs start`), with `--remote-control`
so it also shows in the Claude Desktop sidebar. `start` refuses unless an
`afk cos` run is open. `prompt` and `relay` refuse a session idle 55 minutes or
more, or whose idle age cannot be read, and print the `restart --prompt-file <handoff>` line instead, with no
override: past that age a message re-sends the whole transcript uncached. A
solo `/coduo-afk` run needs no Orchestrator process of this kind.

### Naming convention and history

Prose writes "the runner" and "the orchestrator" in lower case, as it already
does for lane, ledger and integrator; a heading capitalises them.

Before 2026-10-05, "orchestrator" in this repo's docs, logs, code and
reflections means the Runner. Code identifiers, state fields (`orchestratorPid`),
event names (`orchestrator_fatal`) and log lines keep the old word.

## Chief of staff

One Claude session over several Orchestrators, one per epic, started by the
`coduo-chief-of-staff` skill. Its state lives in the [store](#store), not in
its conversation, so a chief of staff that dies or compacts stops nothing and
a new one reads where the old one was. It acts through `afk cos`
(`scripts/cos.mjs`): `start --mode=day|night` opens a run, `log` records
notes, decisions, grants, comments and owner interventions, `run` starts a
registered background process, `checkin` is the model-free status pass that
launchd runs every 25 minutes by day and 45 at night, and `stop` ends the run.
Day and night run the same gates, thresholds and locks. Today they differ only
in check-in cadence, and both notify through the runner's notify path
(`notify` in `scripts/lib.mjs`).

## Store

`~/.afk-claude/cos/<run>/` (root `AFK_COS_ROOT`), outside every repo:
`run.json`, written once when the run opens, and `events.jsonl`, an
append-only log of `note`, `decision`, `grant`, `comment`, `checkin`,
`handoff`, `process`, `stop` and `owner_intervention` events
(`scripts/cos/store.mjs`). `afk cos` is its only writer and stamps every
event's time; appends take a lock in the style of `scripts/gate-lock.mjs`. A
run is open until its first `stop` event. A line that is not a valid event
(hand-edited, bad JSON, no `ts` or `kind`) stays in the file and every reader
prints it as `STORE: flagged line N`.

## Register

The `process` events in the [store](#store): one per background process that
`afk cos run` started, with its pid, the pid's start time from `ps`, owner,
purpose and TTL (`scripts/cos/register.mjs`). `afk cos stop` kills each one,
confirms with `kill -0` that it is gone, and refuses a pid whose start time no
longer matches, because that pid now belongs to another process. It covers
operating-system processes only: a session stops its own Monitors and
sub-agents before it calls `afk cos stop`.

## Hub

The one page per machine, on `http://127.0.0.1:4099`, that lists every run and
links each run's own dashboard. `afk cos start` prints its URL. `afk hub`
(`scripts/hub.mjs`) serves it, and `afk hub install` adds the launchd agent
that keeps it running. Dashboards never listen on 4099; each serves its own
derived port. If something else holds 4099, `afk hub` exits with an
`EADDRINUSE` line and launchd retries every 30 seconds. `afk cos ask` posts a
chief-of-staff question to its Needs you, with the recommended option
pre-checked, even when no epic runs; it leaves the page once a hub response
answers `[ask:cos:<id>]`, and the answer waits in `afk hub queue cos`.
With a chief-of-staff run open, the hub also shows the run's latest check-in,
its grants and decisions (Decided), its notes, comments and owner
interventions (Night log), and its registered processes, newest first, in
local time; a section with nothing in it is left out. An Orchestrator asks
the chief of staff with `afk cos ask --from=orch-<n>` (options optional);
Needs you lists each open one as "waiting on the chief of staff" with its age,
`afk cos checkin` prints them before anything else, and `afk cos answer`
closes one. The Morning report section shows the `report.md` of the newest
run that has one (`afk cos report`), also after `afk cos stop`: the summary,
then one card per `## <repo>#<epic>` section. A card's Copy prompt copies a
brief for a fresh chat: the epic's checkout as the run recorded it (its
check-in rows and adopted list, never a path built from the repo name), the
section verbatim, and the path of `report.md`.

## Handoff

What a fresh session needs to carry on a cold one's work: pointers and state
(run, epics, dashboard ports, state paths, PR, head, open gates, pending
relays, the event tail, the register, the next action per epic), not a
transcript summary. It is the `--prompt-file` of the restart line the cold
guard prints, and a `handoff` event in the [store](#store). `afk cos handoff
<session>` renders it from the store, the hub inbox and `/peers`, and writes
it to `<run>/handoffs/`.

## Epic

A single GitHub issue whose body carries a fenced `afk:` YAML block. That block
is the run's spec: the branch to build on, the task list, and the dependencies
between tasks. The epic is fetched once at start and re-fetched on restart —
there is no local copy — by `scripts/epic.mjs`, behind `afk validate <n>` and
`afk epic <n>`.

Note that "epic" here is a *source of truth*, not a project-management label. It
is also optionally a display name: `.afk-setup/config.yaml`'s `epic: { id, title }`
only labels lanes in the dashboard and in herdr mode, and has nothing to do with
the GitHub epic.

## Task

One child issue of the epic, and one unit of work for one agent. The key in the
`afk:` block is the child issue number, and that same number *is* the AFK task
id — it names the branch, the worktree directory, and `.afk/runs/<id>`. Defined
in `docs/epic-schema.md` ("Field rules") and parsed by `scripts/epic-spec.mjs`.

The issue body carries the title, acceptance criteria and notes; the `afk:` block
carries only the graph shape. A task never carries a status: lifecycle lives
solely in `.afk/state.json`.

## Lane

One task's isolated execution context: its branch (`afk/task-<id>`), its
worktree, and the single agent running inside it. A lane is one agent, never a
crew — `maxParallel: 5` means five lanes plus one integrator. Named in
`scripts/worktree.mjs` (`taskBranch`) and labelled for display by `laneLabel` in
`scripts/runtime-herdr.mjs`.

Lanes cannot talk to each other. The only channel between them is the ledger,
and it is one-way.

## Worktree

A real `git worktree` — a full second checkout of the repo on a task's own
branch — created per task so builders never share a working tree. It lives
**outside the project**, at `~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo>`
(`worktreeRoot` in `scripts/worktree.mjs`), overridable with `AFK_WORKTREE_ROOT`.

Outside is deliberate, not tidiness: worktrees used to sit in `.afk/` and the
project's own checks walked into them, so `eslint .` once failed an integration
whose merge was perfect. Gitignoring does not help, because those tools do not
read `.gitignore`.


### Worktree kinds

The layout agreed for #226 puts every worktree under
`~/code/worktrees/<repo>/<kind>/<name>`, one parent folder each, with four
kinds: `epic` (an epic's own checkout), `lane` (one task's builder, named
`<epic>-<task>`), `session` (a Claude Code worktree session) and `manual` (one
made by hand). The runner's defaults move there in a later ticket of #226; until
then the paths above hold, and a run keeps the paths in its `state.json`.

## Gate

Careful — the word is used two ways in this repo.

**As a noun on a task**, `gate` is a *human* gate declared in the `afk:` block,
with two values. `gate: before` means a human must act before the task may run;
it becomes `humanGated: true` (`scripts/epic.mjs`), and `runnableTasks` in
`scripts/scheduler.mjs` skips such a task unless it is named explicitly by
`afk run --task=<id>`. `gate: after` means the task runs and integrates
unattended, but the **epic** cannot close until a human accepts it with
`afk epic <n> --accept=<id>`; it becomes `gateAfter: true`.

**As a verb**, "what gates a task" means its automated checks — the task's own
`checks:` array, or `defaultChecks` from `.afk-setup/config.yaml` when it has none. A
task with neither stops the run rather than passing unverified.

## Delegated acceptance

The chief of staff accepting a `gate: after` task on the owner's behalf (#188).
Allowed only for a gate the owner delegated at launch (`afk epic <n>
--delegate=<id> --delegate-condition="<text>"`, saved in `.afk/state.json`) and
only when every [guardrail](#guardrail) passes. The Runner tries it at the
`awaiting_acceptance` park, after the closeout review and the fix pass; the
chief of staff retries it later with `afk epic <n> --accept=<id> --delegated`.
The acceptance is recorded as `by: "delegate"` with the condition, the
guardrails and the review they read. A gate nobody delegated still needs a
human, and a `gate: before` is never accepted this way.

## Guardrail

One check in `scripts/merge-guards.mjs` that an unattended merge or a
delegated acceptance must clear: `review-at-head`, `must-fix-cleared`,
`must-fix-count`, `must-fix-one-way`, `ci-green`, `trial-merge`,
`one-way-door-paths`, `launch-status`, and `walkthrough` when the delegation
asks for walkthrough evidence. Each returns `pass`, `fail` or `wait` with its
evidence. `wait` (a CI check still running) is never a pass, and a missing or
unreadable input is a `fail`. No flag skips one.

## Ledger

`.afk/epic-ledger.yaml`: the one-way cross-lane channel, written through
`afk ledger add` and read with `afk ledger list` (`scripts/ledger.mjs`). A lane
records a finding; only entries tagged `applies_to: [<task>]` are injected into
a *later* lane's prompt. Nothing flows backwards or sideways.

Two properties are load-bearing. The runner appends to it deterministically and
no agent ever rewrites it — there is no `--set` or `--edit` path, and a lane that
writes the file directly has the change reverted by `run.mjs`. And it is the one
file under `.afk/` that is force-added and committed to the base branch, because
a cross-lane finding has to outlive the run that recorded it.

## Integration queue

The FIFO list of task ids that have passed verification in their own worktree and
are waiting to be merged into the base branch. It is `state.integrationQueue` in
`.afk/state.json`, managed by `enqueueIntegration` / `dequeueIntegration` /
`canStartIntegration` in `scripts/scheduler.mjs`.

Only one integration runs at a time, no matter how many builders are parallel:
`canStartIntegration` refuses while `state.activeIntegrator` is set. Time spent
here is what the dashboard shows as **In review**.

## Blast radius

How many *other* tasks are stranded if this one fails — the size of a task's
transitive dependent set, excluding itself. Pure graph math over `depends_on`,
computed by `graphMetrics` in `scripts/epic-spec.mjs` and printed by
`afk validate` as `204: depth 0, blast radius 7 of 8`.

It is not a measure of how much code a task touches, or how risky the change is.
It is purely about the shape of the decomposition: a high blast radius flags a
task the whole plan is waiting on.

## Role

The complete data description of one kind of agent the runner can start:
`{ prompt, model, permissions, phases, pane, timeoutMs }` plus `processName` and
`laneKey`. Roles are entries in `ROLES` in `scripts/roles.mjs`, so adding a kind
of agent is a new record rather than a new branch in the runner.

A role is data, not a hardcoded prompt or a job title. `permissions` is a
profile rather than a CLI flag — tool denials, `bypassPermissions`, and a
sandbox payload. What actually holds a read-only role read-only is not that
payload: `allowWrite` only widens, so it is the tool denials plus **where the
role runs** (`docs/permissions.md`). Five are defined: `implementer` (the per-task builder,
formerly "builder"), `integrator` (the serialized merger, formerly "merger"),
and the three read-only ones — `plan-reviewer`, `verifier` and `supervisor`. `docs/epic-schema.md`
("Roles") gives each one's single job, and `docs/permissions.md` gives what
actually caps each one.

## Role cwd

The working directory an agent is started in, and — for the roles that keep
`Bash` — the thing that decides what it can write. Claude Code grants the cwd
unconditionally and `sandbox.filesystem.allowWrite` can only widen that grant,
never narrow it, so the only way to take the project away from a role is to
start it somewhere else. `roleCwd` / `createRoleCwd` in `scripts/worktree.mjs`
do that: a disposable detached checkout for `verifier`, a bare empty directory
for `supervisor`. Reasoned through in `docs/permissions.md` ("The three
mechanisms", gotcha 1).

Not to be confused with the task worktree. Every lane has a worktree; only the
roles held read-only by their location have a role cwd.

## Read-only role

A role that cannot write the project. Three exist — `plan-reviewer`,
`verifier` and `supervisor` — and all three set `bypassPermissions: false`,
but that is not what holds them: `plan-reviewer` is read-only because it
denies `Bash` outright, while `verifier` and `supervisor` keep `Bash` and are
held by their role cwd.
Declared in `ROLES` (`scripts/roles.mjs`); which mechanism holds which, and
where each still leaks, is `docs/permissions.md`.

Read-only means "cannot write the thing it is judging", not "writes nothing".
All three write freely inside their own cwd; nothing reads it back.

## Plan review

The semantic tier of validation: one `plan-reviewer` session that asks five
questions of the epic and its child issues — a missing dependency, a scope
overlap, an unsatisfied criterion, a need for a human, and an inconsistent
ticket. `afk epic` always runs it; `afk validate --plan-review` opts in; and
`afk review plan <epic>` runs it alone, at any time, with no branch or worktree.
`docs/epic-schema.md` ("Validation") says which findings refuse.

## Ticket review

The fifth plan-review question on its own, over one issue: `afk review ticket
<issue>`. It asks whether the ticket contradicts itself — a ruling, waiver or
note that says one thing while a criterion or red test still says the old thing
— and prints both passages. It is the cheap check to run right after a ticket
edit, mid-run included. It exists because an edit to one ruling line of
atlas#1237 left two criteria saying the opposite, and the plan review passed it
twice.
