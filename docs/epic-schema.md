# Epic spec layer, roles, and authoring skills

Contract for moving the DAG onto the GitHub epic and turning builder/integrator
into a named role set. Companion to `docs/herdr-plan.md` (runtime), which stays
authoritative for how a lane executes.

Status: partly built. Wave 1 landed the config/DAG split, `scripts/epic-spec.mjs`
(the `afk:` block parser, validator and graph math) and `scripts/epic.mjs` (the
epic→DAG bridge behind `afk validate` and `afk epic`). The roles and the
authoring skills are still design; `gate: after`'s lifecycle is built, and
this document's failure mode 5 below records what it turned out to be.

## The split

Three sources of truth, none overlapping:

```
GitHub epic + children   WHAT to build, and in what order   (spec)
.afk-setup/config.yaml   HOW this stack is verified         (stack)
.afk/state.json          WHAT is happening right now        (runtime)
```

The current `planning/manifest.json` conflates all three, which is why a failed
run leaves it dirty. Splitting it is a precondition for the GitHub layer, not a
follow-up to it.

### Stack config stays local: `.afk-setup/config.yaml`

Repo-level, committed, changes rarely, never travels to GitHub. It is the
existing manifest minus the task list:

```json
{
  "defaultChecks": ["npm run lint:check", "npm run typecheck", "npm test"],
  "baselineChecks": [],
  "worktreeSetup": { "link": ["node_modules"], "copy": [".env.local"], "run": ["pnpm install --frozen-lockfile"] },
  "maxParallel": 5,
  "agent": { "timeoutMs": 900000, "runtime": "herdr" },
  "launchStatus": "pre-launch"
}
```

`integrationChecks` (optional) is the chain run on the merged tree after each
task integrates, in place of `baselineChecks`; the task's own `checks` still
run there too. Unset, integration re-runs `baselineChecks ?? defaultChecks`,
as before. Set (even to `[]`), the closeout gate runs `baselineChecks` over the
final tip whether or not the fix pass committed, since no integration ran the
full chain over it. Use it when the full chain takes minutes and an epic
integrates many tasks: a break the lighter list misses then surfaces at
closeout, not at the task that caused it.

`launchStatus` says whether the product has users yet: `pre-launch` or
`launched`. Any other value is a validate error. A missing key is read as
`launched`, and validate says so (`launch status: not declared, treated as
launched`) with a `no_launch_status` warning. The stop forecast prints it in its
heading.

`checks` are deliberately absent from the epic YAML. PLANNER.md 1.6 already
requires every task to carry the same array as `defaultChecks`; duplicating that
onto an issue buys nothing and rots independently. A task needing a *narrower*
gate is the exception and sets `checks:` explicitly (below).

### Spec lives on the epic: the `afk:` block

Fenced YAML in the epic issue body. The Mermaid diagram stays for humans, but is
**rendered from this block** — two hand-maintained graphs drift, and the
human-readable one is the one people trust.

```yaml
afk:
  version: 1
  branch: feat/203-stripe-subscriptions
  max_parallel: 3                            # optional; hard cap, and blocks the root-width raise

  tasks:
    204:
      depends_on: []
      gate: before                           # human provisions, then releases

    205:
      depends_on: [204]

    206:
      depends_on: [204]

    208:
      depends_on: [205, 206]
      checks: [npm run lint:check, npm test] # narrower gate, optional

    211:
      depends_on: [208, 209, 210]
      gate: after                            # human accepts before epic closes

  stops:                                     # optional; one answer per stop
    204: park
    211: "delegate: zero must-fix left after the fixer, screenshot diff 1% or less"
```

Field rules:

- **task key** is the child issue number. It is also the AFK task id. The
  `001`/`002` numbering and `planning/tasks/*.md` both disappear. Issue numbers
  are unique per repo, so worktree paths and `.afk/runs/<id>` stop colliding
  across runs — a free win over the current scheme.
- `depends_on` — issue numbers. Cycle and dangling-reference detection is the
  validator's job, not the planner LLM's.
- `checks` — optional narrowing. Absent means `defaultChecks`.
- `gate` — `before` | `after`. `before` maps to today's `humanGated`. `after`
  means the task is never dispatched at all: on admission it resolves to
  `awaiting_acceptance` — no worktree, no install, no builder — and a human's
  `afk epic <n> --accept=<id>` is the verdict that passes it (this document's
  failure mode 5).
- `stops` — optional, keyed by task id: the answer recorded for that task's
  stop (see "Stop forecast"). One answer covers every stop on the task. Values:
  `park` (the run parks there and a human releases it), `last` (the stop is
  left until everything else is done), or `"delegate: <condition>"` (quoted;
  the condition says what a delegate checks, at least 10 characters). Refused:
  a key that is not a task in the block, any other value, a shorter delegate
  condition, and `last` on a stop whose `blocks` holds a task with no stop of
  its own, because ungated work still waits behind it. An answer on a task
  with no declared gate is a `stop_without_gate` warning, since the plan
  reviewer may raise a stop there later. If the reviewer does raise one, the
  same `last` rule applies to it: the answer is dropped, the stop counts as
  unanswered and its line says why. An answer changes no scheduling:
  `park` and `delegate` both still park. `stops:` is not graph shape, so it
  stays out of the shape hash and editing it mid-run refuses nothing.
- Anything not listed here is a validation error, not a silently ignored key.

Title, acceptance criteria, and implementation notes are **not** in this block.
They stay in the issue body and reach the agent by issue reference.

### No local copy of the spec

`afk epic 203` fetches the epic and its children once at start and holds the DAG
in memory for the process lifetime. On restart it re-fetches. `.afk/state.json`
persists only `{ epic, branch }` plus the graph shape, for the restart diff
below.

An earlier draft cached a compiled `spec.json` to survive a `gh` credential
expiry mid-run. Rejected: `gh` expiry has not happened in practice (unlike the
Claude auth death the runtime already handles), and a cache that can disagree
with the epic is a staleness bug bought for a hypothetical.

### `allowed_paths` is computed at admission, not authored

Scope cannot be authored on the ticket. Between writing the ticket and running
it the repo moves, and it moves *during* a run as earlier tasks integrate. A
task scheduled three hours in must be scoped against the tree it actually
branches from.

So: `allowed_paths` are derived at **admission**, under the same lock that
admits the lane, against the current feature-branch tip, and checked against the
paths of every currently-active lane. A lane whose scope collides with a running
one is held rather than admitted.

Admission, not "just before the implementer starts". The latter silently drops a
property: two lanes deriving scope independently against the same tip cannot see
each other. Deriving under the admission lock restores it.

Tradeoff, stated plainly: scope moves from human-reviewed (today you can eyeball
`allowedPaths` in the manifest before a run) to agent-derived, unseen. That is
tolerable only because scope is advisory — PLANNER.md 1.4 has the worker keep
out-of-scope edits for review rather than hard-failing. **If scope ever becomes
a hard gate, revisit this.**

## Validation

`afk validate 203` runs before anything is created, and `afk epic` runs it
implicitly. Two tiers:

**Deterministic (code, always):** YAML parses; every `depends_on` names a task
in the block; no cycles; every task key is a real open issue whose parent is the
epic; `branch` does not already exist with divergent history; `max_parallel` is
sane; unknown keys rejected.

It also prints **depth and blast radius per node** — pure graph math over
`depends_on`, no LLM, no tokens. `afk validate` saying "204: depth 0, blast
radius 7 of 8" shows the shape of a decomposition before anyone commits to it.
The semantic version of that judgment is `plan-reviewer`'s.

**Semantic (`plan-reviewer`, read-only, one agent, runs only if the above
passes):** five questions. Does any child issue describe needing an artifact
from a task it does not depend on; do two parallel-eligible tasks claim
overlapping file surfaces; does a stated acceptance criterion have no task that
could satisfy it, where every numbered user story in the epic body counts as a
stated criterion; does any criterion or instruction in a child issue need a
human decision, approval or secret (a key, a token, a login) during the run; and
does any one child issue contradict itself — its acceptance criteria, red tests,
waivers, launch or notes lines and stated rulings checked against each other
(`inconsistent_ticket`). It also
reports graph depth and the blast radius of each node, so wide-and-shallow
slicing gets feedback. It reports contradictions and **cannot** mutate the spec.
A contradiction aborts before any branch or worktree exists.

**What each finding is worth.** `missing_dependency` aborts unless the reviewer
marks it `severity: warning` to signal low confidence. `scope_overlap` never
aborts — this document's failure mode 2 below ships repo-wide scope as advisory. And
`unsatisfied_criterion` aborts *and the reviewer cannot downgrade it*, for as
long as at least one task it names has not started: it is the one class that
predicts a green run producing the wrong artifact, and it arrives at the only
moment when the repair is free. The repair is to put the criterion back onto the
child issue as an acceptance criterion its lane will be held to, through
`coduo-tickets` — which writes the child issues, the `tasks:` block and the
rendered Mermaid together. The runner refuses and hands that back rather than
patching one of the three itself. Once every task a criterion names has run the
repair no longer exists, so the reviewer's own severity applies again.

`needs_human` never aborts the plan review. The reviewer names one task and
quotes the sentence from that task's body; code drops the finding when the quote
(at least 12 characters, whitespace flattened) is not in that body, when it
names no task or more than one, or when the task already has `gate: before` or
`gate: after` ("the gate already covers it"). A kept finding becomes a stop of
kind `needs_human` in the stop forecast below: it blocks the task and every
transitive dependant, its line quotes the evidence, and under `--unattended` it
needs an answer in `stops:` like a declared gate.

`inconsistent_ticket` aborts on the `missing_dependency` terms: the reviewer may
mark it `severity: warning` to signal low confidence, and once the task it names
has started it warns, because the lane has already read the ticket. The reviewer
names one task and quotes two passages from its body, one in `evidence` and the
one that disagrees in `contradicts`. Code drops the finding when either quote
(at least 12 characters, whitespace flattened) is not in that task's body, when
it names no task or more than one, or when the two quotes are the same text.
Whether two passages really disagree stays the model's claim; code checks only
that the ticket says both. It refuses rather than warns because it predicts what
`unsatisfied_criterion` predicts, a green lane that built the wrong thing — the
builder satisfies one passage and the verifier holds it to the other — and the
repair, one ticket edit, is free until that lane starts. Unlike
`unsatisfied_criterion` the downgrade stays, because whether two lines conflict
can turn on a condition stated elsewhere in the ticket. The rendering prints
both passages. The case it exists for: on 2026-10-13 one ruling line of
atlas#1237 was edited after the owner withdrew it, two criteria still said the
seat add "fails closed", and the four questions before this one passed the
ticket twice.

**Standalone.** `afk review plan <epic> [--repo=]` runs the deterministic tier
and then this whole review, read-only, with no branch or worktree, and exits 1
on a refusing finding. Its transcript goes to `$TMPDIR` and it shares the
carry-forward store below. `--base=<branch>` names the base the epic's branch
is checked against (default: the `epicBase` the epic recorded in
`.afk/state.json`, else `main`). A branch the base has moved past, as on any
night where other epics merged first, prints `branch_divergent` as a warning
and the review still runs: it creates no branch, so the launch refusal does not
apply. `afk review ticket <issue> [--repo=]` asks only the
fifth question, of one issue (prompt `prompts/ticket-reviewer.md`, the same
read-only `plan-reviewer` profile and audit, any other kind dropped). It keeps
no carry-forward store. Run it right after any ticket edit, mid-run included.

**Carry-forward.** One review is one model sample, and a sample can miss what
the last one saw: the same epic body was once refused, passed two minutes
later, and refused again with the same correct finding. So after each review
every kept finding that refused the run, and every `needs_human` finding, is
written with the time it was raised to
`~/.afk-claude/plan-review/<owner>-<repo>/<epic>.json` (`AFK_PLAN_REVIEW_STORE`
replaces the `~/.afk-claude/plan-review` root, for tests). The next review
carries each stored finding forward while all its tasks are still in the DAG and
its quoted `evidence` (and `criterion` on `unsatisfied_criterion`) still
appears verbatim, whitespace flattened, in the epic or a child body. A carried
finding goes through the same audit as a new one, so adding the missing edge or
the gate also ends it. It counts like a new finding, is never counted twice
(same kind, same tasks, same evidence is one finding), and prints as `carried from the review at <time>`, in the output and in
`decisions.md`. `afk validate --plan-review`, `afk validate --unattended`,
`afk review plan` and `afk epic` share the store;
`afk validate` still creates nothing inside the repository.

`inconsistent_ticket` is never stored or carried. Whether two passages
disagree is the model's claim alone, and code checks only that the ticket says
both, so one sample must not refuse every later launch. It refuses the review
that raises it, and a later launch only when a fresh review raises it again; an
entry of that kind in an older store is ignored. Within one review, one edited
ruling against two stale criteria is still two findings: the key adds
`contradicts`.

A finding stops being carried only when its quoted text is edited out or its
task leaves the graph. There is no override flag, and that is the cost: a false
positive stays until the ticket is reworded.

Findings that do **not** abort are written to
`.afk/plan-review/<epic>/decisions.md` as `accepted`, appended per attempt.
Starting a run past a printed warning is a decision; that file is where the
decision is on the record rather than in scrollback. A finding that was actually
actioned leaves the record by not being raised again.

This is "validate rather than generate": the grilling session already had the
most context it will ever have, so it emits the DAG; the runner's job is to
refuse a bad one cheaply.

Both tiers re-run on restart, because the DAG is re-fetched rather than cached.

### Stop forecast

After the graph, `afk validate` and `afk epic` print every place the run will
wait for a human, what waits behind it, and the answer recorded in `stops:`.
Pure code in `scripts/forecast.mjs`: no model, no network.

```
Stop forecast (launch status: pre-launch):
  #204 gate: before. Parks 3 of 8 tasks (#204, #205, #208). Needs two launches: --task=204, then a plain relaunch. Answer: park.
  #211 gate: after. The epic cannot close until #211 is accepted. Answer: none.
  3 of 8 tasks (38%) cannot start until a human acts. 1 stop unanswered.
  Answer each stop in the afk: block's stops: key (park, last, delegate: <condition>). Deciding now is a plan edit: drop the gate or write the decision into the ticket, and the stop leaves the forecast.
UNATTENDED: not checked. Run `afk validate 203 --unattended` before saying nobody will be needed.
```

A `gate: before` stop blocks the task and every transitive dependant. A `gate:
after` stop blocks its dependants only, since the acceptance itself is not work,
and the epic cannot close until it is accepted. The parked count takes each
blocked task once across all stops. With no declared gate the section is
`Stop forecast: no declared stop.` and the same UNATTENDED line, because the
plan review has not run.

"Decided now" is not an answer: it is a plan edit that removes the stop, which
is what the footer's "Deciding now is a plan edit" line says. A `delegate` answer is
a record only; the line reads "delegated, parks until delegated acceptance
ships".

`--json` carries the same data as `forecast`: `launchStatus` (`value`,
`declared`), `stops` (each with `task`, `kind`, `blocks`, `share`, `note`,
`answer`), `parked` (`tasks`, `total`, `share`) and `unanswered`. The launch row
in `docs/measure` carries it too, and its `humanGates` comes from the same gate
computation.

**`--unattended`**, on `validate`, `epic` and `start`, turns "every stop has an
answer" into a refusal:

- `afk validate <n> --unattended` runs the plan review as `--plan-review` does,
  and exits 0 only when the deterministic tier passed, the plan review passed
  and no stop is unanswered. Its last line is `UNATTENDED: ready. N stops, all
  answered.` or `UNATTENDED: refused: <reason>. Nothing was created.`
- `afk epic <n> --unattended` runs the same check after the plan review and
  before the branch is created, and refuses with `No branch, worktree or pull
  request was created.` `afk start` forwards the flag to `afk epic`.

Without the flag neither command refuses on the forecast. Plain `afk validate`
stays offline and token-free.

### Delegation

A `gate: after` task parks the epic until someone accepts it. The owner can hand
that acceptance to the chief of staff at launch:

```
afk epic 186 --delegate=999 --delegate-condition="CI green and no must-fix left" \
  [--delegate-evidence=walkthrough] [--waive-user-facing="<reason>"]
```

`afk start` takes the same flags. Each delegation is saved in
`.afk/state.json` with its condition, its evidence requirement and the time,
and survives a restart. Like `--instructions`, it is additive: a restart may
delegate another gate, and a restart that changes an existing delegation's
condition or evidence is refused. `afk epic` refuses `--delegate` for a task
that is not `gate: after` in the `afk:` block, without a non-empty
`--delegate-condition`, or inside a lane. `--waive-user-facing` records a
reason the `launch-status` guardrail accepts for a launched project's
user-facing change; it is saved and shown the same way.

At the `awaiting_acceptance` park, after the closeout review, the fix pass and
its gate, the Runner evaluates the merge guardrails (`scripts/merge-guards.mjs`)
for each delegated gate. When all pass it records the acceptance as `{ by:
"delegate", condition, guards, review: { head, ranAt } }`, logs every guardrail
with its evidence, and closes the epic in the same run. When any fails or
waits, the gate stays parked, the log names each guardrail that did not pass,
and the closeout's human-acceptance line reads `delegated, waiting on
<guardrail>`. If the fix pass committed, the review no longer reads the head
and `review-at-head` fails; the next run reviews the new head first.

`afk epic <n> --accept=<id> --delegated` runs the same evaluation later, for
example once CI went green. It refuses a gate that was not delegated (`#<id> was
not delegated; a human must accept it`) and refuses `--force`. Plain `--accept`
is unchanged. The reopen rule covers both kinds of acceptance: a later closeout
review that recommends must-fix, and is not the review the acceptance was given
over, sends the gate back to `awaiting_acceptance`.

A gate delegated with `--delegate-evidence=walkthrough` also needs walkthrough
evidence at `~/.afk-claude/acceptance/<owner>-<repo>/<epic>/<task>/`
(`AFK_ACCEPTANCE_ROOT` overrides the root). It sits outside the repo, so
attaching it does not move the branch head, and outside `.afk/`, so `afk
finish` leaves it alone. The directory holds the PNG screenshots and
`walkthrough.json`:

```json
{ "schema": 1, "epic": 186, "task": 999, "head": "<sha>", "recordedAt": "<ISO time>", "by": "chief of staff",
  "steps": [ { "item": "<checklist line, verbatim>", "screenshot": "01-open.png", "observed": "<one line>" } ] }
```

It passes when `schema` is 1, `epic` and `task` match, `head` is the branch head
or differs from it only by status commits, there is one step per `- [ ]` line
in the gate task's issue body with the same text after trimming, each
screenshot is a non-empty PNG in the directory, no two steps share an image
with the same SHA-256, and every `observed` is non-empty.

## Roles

Five roles. Each is data, not a hardcoded prompt:
`{ prompt, model, permissions, phases, pane, timeoutMs }`.

### A prompt is a file, not a string literal

`<runner>/prompts/<role>.md` is the shipped default; a project overrides one by
committing `.afk-setup/prompts/<role>.md`. The override wins whole — there is no
per-section merge, because a three-way merge is not a thing a human can hold in
their head while answering "what did the agent actually read".

The template language has two features and no third: `{{name}}` for a value, and
`{{#name}}...{{/name}}` for a block that appears only when `name` is present.
Every list a prompt needs is formatted by the code that knows its shape and
arrives as one string, so there are no loops, no filters and no evaluation order
to be wrong about. Sections resolve before placeholders, so a ledger note or a
human's custom instruction cannot inject markup.

Two roles are parsed by taking the **last** fenced `json` block of their output.
An override for either that drops the instruction saying so is refused at load
time, naming the file — otherwise the run proceeds and fails minutes later as an
unparseable report with no cause attached.

### Skills are configuration, not prompt text

`.afk-setup/config.yaml` carries a `roles:` block, and it renders into the
prompt's `{{skills}}` mark:

```yaml
roles:
  implementer:
    always: [coduo-implement]    # a RULE: applied to every task
    offer:  [shadcn]             # a CHOICE: only when the task needs it
    notes:  "..."                # prose, for a stack with no skill at all
```

The list exists because a model that is not told which skills are installed
invents plausible names, and an invented name fails silently as "no such skill".
It is not a restriction: `offer` leaves the judgment with the agent, which is why
there is **no per-ticket signal** to author or maintain — a builder that can read
its own ticket can decide whether a design skill applies to it.

`afk stack detect` proposes the block from the plugins the repo already enabled
in `.claude/settings.json`, merged with the bindings the runner ships in
`plugin-roles.yaml`. It runs no agent and writes nothing. The detection is not
repeated here: `setup-coduo-agents` already classified this repo and recorded the
answer as the plugins it turned on, and a second detector would be a second
opinion that drifts from the first.

A config that grants a skill the **role** denies is refused, naming the file and
the field. `herdr` in `roles.implementer.offer` would otherwise produce an agent
instructed to use a skill its own settings block from loading.

| Role | Runs | Writes | One job |
|---|---|---|---|
| `plan-reviewer` | once, at `afk epic` | nothing | Validate the DAG against the child issues and the repo. Report contradictions. |
| `implementer` | per task | its worktree | Implement one issue. Never merges, never commits. |
| `integrator` | serialized, per integration | feature branch | Merge one lane, preserve intent, resolve conflicts. |
| `verifier` | once, whenever the epic stops — complete, incomplete, or parked on a gate | nothing | Run `/code-review` over the integrated branch, check it against the acceptance criteria on the epic's **children** (see below), produce the structured closeout. |
| `supervisor` | on events, and on demand | nothing directly | Judge ambiguous failures. Answer the human. |

> **Where the criteria actually live.** "The epic's acceptance criteria" is a
> shorthand: an epic body has no such section. `coduo-epic` builds it from
> `/to-spec`, whose headings are Problem Statement / Solution / User Stories /
> Implementation Decisions / Testing Decisions / Out of Scope / Further Notes.
> `PLANNER.md` Part 4 mandates `## Acceptance criteria` on every **child** issue,
> so that is what the verifier reads — the union of the children's, plus the
> epic's if it happens to carry the heading. An epic with none produces a
> diff-only review that says so, never a silent full pass.


`plan-reviewer`, `verifier`, and `supervisor` are read-only by intent, through
the existing permission preflight rather than a CLI flag. Only `implementer` and
`integrator` need `--dangerously-skip-permissions`.

> **The sandbox is not what enforces it.** Proven live on 2026-08-18
> (`docs/findings.md` 3.2): `filesystem.allowWrite` is an allow-list that only
> widens, so it cannot take away the working directory Claude Code grants by
> default. What actually holds is the tool `deny` list — and only for
> `plan-reviewer`, which denies `Bash` as well as `Write`. `verifier` and
> `supervisor` keep `Bash` and can write their own working directory with a
> shell redirect today.

A lane is therefore **one agent**, exactly as today. `maxParallel: 5` plus one
integrator is five plus one, which fits a six-agent machine ceiling with no
weighted budget and no second semaphore.

### The runner is code, not a role

`auto.mjs` owns the ready queue, slot accounting, integration serialization, and
the `passed`/`failed` transitions. These four must be identical after a crash
and must still be true six hours into a run, which is why they are not an agent.
The project's worst bugs have been state bugs (AGENTS.md failure modes 3 and 7);
they were findable because the state was inspectable.

### `supervisor`

An LLM with real authority over judgment, and none over the loop.

**It owns:** classifying an ambiguous failure as infra versus bad ticket
(AGENTS.md failure mode **7**, which `looksLikeInfra` closes only for the case a
regex can recognise: a run of sub-second failures across unrelated tasks. A
single slow ambiguous failure is still unclassified, and no regex can do it.
Failure mode **4**, hard-quota-retried-as-soft-limit, is separately OPEN and
also needs judgment: reading "try again at Aug 16th" out of prose is the job
this role exists for); deciding retry-clean versus salvage on a dead lane; triaging ledger
items; deciding whether something is worth waking the human for; drafting the
epic closeout; and answering the human in plain language about any of it.

**It does not own:** the ready queue, slot accounting, integration
serialization, or the `passed`/`failed` transitions.

**It is event-driven, not resident.** The runner starts a short session when a
lane fails, an integration fails, a lane blocks, a gate is reached, or the epic
ends — and when the human asks a question. No timer, no polling. A typical
8-task epic produces roughly 10–20 such calls, each reading logs, reports and
state rather than the codebase. Against ~16 large lane and merger sessions that
is roughly 2–5% more tokens. Estimate, not measurement; the per-lane token
telemetry already landed in slice 3 (`verification.tokens`) can measure it.

**It acts through the same `afk` commands a human would.** Not from distrust,
but so that every action it takes lands in the same log and state file as a
human action and stays debuggable. It is a supervisor, not a second source of
truth.

### Rejected: per-lane code review

An earlier draft added `coordinator`, `reviewer`, and `fixer` roles, reviewing
each lane's diff before integration. Rejected on two grounds.

**Cost.** It multiplied a per-run cost by the task count: roughly six sessions
per lane instead of one, ~48 sessions on an 8-task epic instead of ~16.

**Position.** Review already exists in this system and is already in the right
place — at the end, over the merged commits, standards, spec and reach read
against each other. That was the practice in the `afk-runner` and `parallel-lanes`
skills this runner replaced, and they argued the position explicitly:
integrators reliably find defects no lane could see, and the coherence read
confirms the features *compose*. A
per-lane reviewer sees an isolated diff and structurally cannot catch
composition defects. It would cost 5× to see less.

So review stays at epic end and becomes the `verifier`'s job: the automated
version of the step SKILL.md currently asks the human to remember.

What this forgoes is a bounded fixer — a fresh agent handed an explicit must-fix
list with its own retry limit. Must-fix items instead land on the epic closeout
for the human.

**Built, as `fixer`** (`scripts/fixer.mjs`, `prompts/fixer.md`). The list is the
runner's arithmetic over the verifier's report — must-fix, then blocker and
major findings, then unmet and partial criteria — so the model is never asked
what counts as a must-fix. `minor` findings and `unknown` criteria are excluded:
the first is tidying on a branch already reviewed, and the second is a gap in
the REVIEW, where an agent guessing what "fixed" means is worse than a human
reading it. One attempt, no retry. What it cannot fix is `deferred` with a
reason, which is the list that used to be the whole closeout.

### Rejected: librarian

Its output — the epic outcome written back to the issue and PR — is the
verifier's structured report rendered to markdown. Rendering is templating, so
**the runner does it in code**: deterministic, token-free.

This also preserves a safety property. The verifier's report lands on the thing
it just judged; a reviewer that can write to what it gates is honor-system,
which this project already rejected for task completion. That is also why the
review is advisory and can never halt the run. Verifier stays read-only, the
runner writes.

`fixer` does not weaken that. It writes code and nothing else: no issue, no pull
request, no lifecycle. It did not produce the review it is acting on, so it is
not a reviewer writing to what it gates — and because nothing re-judges the
branch afterwards, an epic with findings closes `completed_with_findings`
whether or not they were fixed. Its cap is its deny list rather than its cwd,
which is the one place it differs from every other sandboxed role: its whole
output is a commit on the branch, so it has to stand in the checkout that holds
it. `scripts/live-checks.test.mjs` scores that exception.

The artifact this forgoes is the *codebase explanation* ("how the system works
after this epic"), which is genuine judgment and would need an agent. Not in
scope.

**The run-shaped half of that is built, as `reflector`** (`scripts/reflect.mjs`,
`prompts/reflector.md`): what happened during this run, written from the state
file, the runner log, the closeout, the review and the fix pass. It is the
one output on this path a template cannot produce, which is the test the
rendering argument above sets — everything else the runner emits is a projection
of run state and is therefore code.

It writes ONE document, which the runner then places at
`docs/reflection/<project>/epic-<id>.md` (`AFK_REFLECTIONS_ROOT` overrides the
root), where the operator already keeps them. The agent never runs there and
cannot reach it. It runs in a scratch workspace under
`.afk/reflect/<epic>/workspace/`, the runner copies the run's artifacts in
first, and the runner moves the finished file out.

That indirection is the fix for a measured failure and is worth stating as a
rule: **the cwd-as-cap lever from findings 3.2 caps READS as well as writes.**
The first live run of this role produced nothing and said why in its own final
message — "reads are confined to <cwd>". The verifier never meets this, because
its cwd is a checkout of the branch it reviews and everything it needs is
already inside; this role's evidence is elsewhere. `allowWrite` does not govern
reads, so widening the sandbox would not have helped. Bringing the evidence to
the agent keeps the cap and in fact narrows it: the agent can now reach neither
the project nor the runner's repository, only a directory of copies.

It commits nothing: the file lands in a different repository from the one the
run touched, and a runner writing history into someone else's repo on a
project's behalf is not a thing to do quietly.

The codebase explanation proper — "how the system works after this epic" — is
still not in scope.

### Rejected: per-role auto-compaction

`claude --autocompact <auto|tokens>` would bound a lane's context and close
AGENTS.md failure mode 9 (a builder that exhausts its window keeps its diff and
loses its reasoning).

Recorded so it is not re-proposed without answering this: the global
`~/.claude/CLAUDE.md` overrides compaction output to a single line pointing at a
SessionStart hook. An unattended lane in a fresh worktree may have no such hook,
or one carrying nothing about the lane. Under that override, compaction is
near-total context loss rather than a summary — worse than the exhaustion it
replaces. Revisit only after verifying what a compaction actually emits inside a
lane worktree. Runner agents no longer load `~/.claude/CLAUDE.md` (#173), so
that override may no longer reach a lane either; verify before relying on it.

## Communication

**Lanes cannot talk to each other, on purpose.** One ticket, one sealed
worktree. Cross-talk produces two lanes negotiating a design decision neither
ticket authorized, unreproducibly.

**The ledger is the only cross-lane channel, and it is one-way.** #205 records
"checkout resolves Price by lookup_key, do not accept raw IDs" tagged
`applies_to: [209, 210]`; when #210 starts, only entries tagged for it enter its
prompt. Cross-agent memory without piping transcripts around. Asynchronous and
mediated by the runner, never lane-to-lane.

**The human can talk directly to a running lane.** A blocked herdr pane is a real
terminal. The runner tolerates intervention because the verifier inspects
artifacts rather than trusting claims.

**The human talks to the `supervisor` for everything else.** It holds the run's
context, so "why has 207 been running 40 minutes" gets an answer rather than a
log dump.

**Known hole: nothing pages you when a lane is quietly wrong.** Blocked lanes
fire an osascript notification and the progress deadline catches silence, but a
lane making bad decisions for 40 minutes looks identical to a lane working.

## Failure modes this design must handle

The numbered list below is **this document's**, and referenced as "this
document's failure mode N". A bare "failure mode N" elsewhere in the repo belongs
to `AGENTS.md`, which owns that numbering; a reference to its list says
"AGENTS.md failure mode N".

Found by running a 204 → 205/206/207 → 208/209/210 → 211 shape against the
current scheduler.

**1. Deep graphs amplify a single failure.** `dependenciesPassed` requires every
dependency `passed`, so a root failure strands the whole subtree — seven tasks
for the shape above. PLANNER.md 1.10 already says keep graphs wide and shallow
"so a single skip costs one leaf, not the plan". `plan-reviewer` reports depth
and blast radius; `coduo-tickets` should prefer wide slicing. A planning
constraint the tooling must surface, not a bug to code around.

**2. Scope overlap between concurrent lanes.** Handled by deriving
`allowed_paths` under the admission lock (above) — **deferred past v1**. Scope is
advisory: the worker keeps out-of-scope edits for review rather than failing, and
the merger resolves conflicts semantically. That is how AFK runs parallel lanes
today with no pre-check at all. v1 ships with no derivation and repo-wide
advisory scope; the admission lock is a later optimization that reduces merge
conflicts, not a correctness requirement.

The CROSS-EPIC half of this is now covered, at the other end. `--worktree` lets
two epics run at once against one clone, and there scope overlap is not a merge
cost paid inside one run but a 3am conflict between two — so `afk validate` and
`afk epic` enumerate every live epic on the clone (`liveEpics`, scripts/worktree.mjs)
and warn `epic_scope_clash` on a shared file before either has cut a lane. A
warning, not a hold: there is no scheduler that owns both epics, `allowedPaths` is
`**` for every lane until derivation lands, and a hold with no arbiter deadlocks.
See docs/failure-modes.md R17.

**3. Serialized integration is the real stall.** A three-lane wave produces three
queued merges, each running post-merge checks serially at 1.5–6 min. The next
wave waits on all of it. Depth makes this worse, and more concurrency does not
help — extra lanes queue behind the same single-file merge. Accepted cost; the
mitigation is wider, shallower graphs.

**4. A restart can see a changed DAG.** The accepted cost of holding no local
copy. The restart path diffs the re-fetched graph against the shape recorded in
`.afk/state.json` at run start and **refuses** on a structural change. A child
issue closed mid-run stops the runner; it does not silently orphan a lane.

**5. `gate: after` needed a lifecycle of its own.** `gate: before` maps onto the
existing `humanGated` skip. `gate: after` maps onto nothing: an acceptance gate
has no automatable work, so the task is never dispatched — no lane, no worktree,
no builder. On admission — the same test any other leaf gets, every dependency
`passed` — it resolves to the task lifecycle `awaiting_acceptance`, and
`afk epic <n> --accept=<id>` is its only exit. **That acceptance is the
verdict**: it writes `passed`, and nothing else does. Dispatching one instead
only ever bought a builder's guess — four epics ran the identical ticket shape
and recorded `blocked`, `failed` and `passed` for it. The epic parks at
`awaiting_acceptance` alongside it, and the closeout review runs *before* the
human accepts, which is the only order in which the review can inform the
acceptance. `--accept` enforces that order: it is refused unless the newest
review read the branch head (status-flush commits since do not count), and a
park over an older review re-runs it. `--force` accepts without one. At close,
a review that is still current is read back rather than re-run. A `must-fix`
review there voids any acceptance not given over that exact review, puts the
gate back to `awaiting_acceptance`, fires the gate event, and parks the epic
before the fixer runs (#145, from epic #715).

## Authoring and invocation skills

Three skills wrap the existing `/to-spec`, `/to-tickets`, `/beautiful-dag`, and
`/grill-with-docs` (all already installed under `~/.agents/skills/`).

### `coduo-epic`

`/to-spec` → epic issue containing the PRD and an `afk:` block with `branch` and
`max_parallel` only. No `tasks:` — the children do not exist yet, so they have no
numbers.

### `coduo-tickets`

`/to-tickets` → creates the child issues → numbers now exist → derives the
dependency map → `/beautiful-dag` renders the Mermaid from it → **writes the
`tasks:` block back onto the parent epic.**

That write-back is a distinct final step triggered after every ticket is pushed.
It is the step that is easy to forget, and the epic is inert without it.

### `coduo-afk`

Invocation: "Start afk run on #232". Reads the epic, runs `afk validate`, creates
the feature branch, starts the run. Also the entry point for talking to the
`supervisor` during and after a run.

Accepts free-form custom instructions for anything special about this epic. Two
rules:

- **Additive only.** They are extra context injected into every lane prompt.
  "This epic touches the payment path, be conservative with migrations" is in
  scope. "Skip the typecheck" is not — the runner refuses instructions that
  would disable a gate, on the same principle that gates are enforced in the
  report API rather than by prompt.
- **Persisted to `.afk/state.json` at run start.** A retry or a restart three
  hours in still carries them. Instructions that live only in the invoking
  conversation are lost on the first crash, silently.

Scope is epic-wide, one string. Per-task instructions belong in the child issue.

On validation failure or a human gate, the skill **stops and reports**. It does
not repair the DAG and does not decide a gate is probably fine.

DX detail that matters: on a fresh epic whose root task is `gate: before`, there
is nothing runnable and the run exits in seconds. Correct, but it reads as a
crash. The skill must say *"waiting on you for #204"*, naming the gated work and
the command that releases it.

## Build order

Phase 1 is the smallest thing that runs a GitHub-driven epic. It adds **no new
roles**: today's builder is the `implementer`, today's merger is the
`integrator`.

**Phase 1 — run an epic from GitHub**

- the `afk:` block, parsed and validated (deterministic tier only)
- `afk epic <id>` — fetch, validate, create the feature branch, start the run
- issue numbers as task ids, replacing `001`/`002`
- `.afk-setup/config.yaml` split out of `planning/manifest.json`
- graph-shape hash in `.afk/state.json` + refuse-on-change at restart
  (**this document's** failure mode 4, "A restart can see a changed DAG" — not
  AGENTS.md's, which numbers a different list; it cannot be built before the
  rest of this phase exists)
- `coduo-epic` / `coduo-tickets` emitting and writing back the block
- `coduo-afk` invocation

Deliberately absent from Phase 1: `allowed_paths` derivation, `gate: after`, the
ledger, and every role beyond the two that already exist.

**Phase 2 — judgment at the ends.** `plan-reviewer` (semantic tier) and
`verifier` (`/code-review` over the integrated branch).

**Phase 3 — `supervisor`.** Event-driven judgment plus the conversational
surface.

**Phase 4 — ledger and epic close.** `.afk/epic-ledger.yaml`, draft PR,
`afk ledger add`, `gate: after`, and the closeout that renders the verifier's
report back to the issue and PR.

**Later.** `allowed_paths` at admission, success-path cleanup, multi-epic
program DAG.

The largest unknown in Phase 1 is the id migration: issue numbers touch worktree
paths, branch names, `.afk/runs/<id>`, the worker's protected-file checks, and
the state file. Mechanical, but the blast radius decides whether Phase 1 is a
day or a week.

## What this does not cover

The ledger (`.afk/epic-ledger.yaml` + draft PR + `afk ledger add`), success-path
cleanup, and the multi-epic program DAG are separate documents. The ledger
depends on this one: it needs `afk epic` to exist before it has a lifecycle to
attach to, and the `verifier` closeout to resolve it.

`docs/findings.md` is the live record of what the build surfaced, including
accepted deviations from this document and gaps with no owner. Read it, and
`afk --help`, before concluding that something here is implemented — or that
something is not.
