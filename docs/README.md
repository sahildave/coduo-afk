# The docs/ directory

A map of what is in here, ordered by when you need it rather than
alphabetically.

The runner's own entry points live outside this directory: `README.md` at the
repo root for install and usage, `AGENTS.md` for the runner's contract and its
numbered failure modes, `PLANNER.md` for the mechanics a change must not break.

## Start here

**[`glossary.md`](glossary.md)** — the runner's vocabulary in one place: epic,
task, lane, worktree, gate, integration queue. Several of these words mean
something narrower here than you would assume, and each entry names the file or
command where the term is actually realised. Open it first, and open it again
any time another document uses a word confidently and you are not sure it means
what you think. It is authoritative for terminology; where another document
defines a term in passing, this one wins.

**`first-hour.md`** — the ordered checklist for a new
project adopting this runner, from empty repo to a first epic: what
`.afk-setup/config.yaml` needs, the `.gitignore` entry for `.afk/`, the project's own
`AGENTS.md`, running `afk validate` against a real epic before `afk epic`, why
the first epic should be disposable, and what to watch while it runs. Open it
before pointing the runner at anything you care about. Nothing else covers
setup — `runbook.md` starts from the assumption that a run already exists.

**[`faq.md`](faq.md)** — the questions an operator actually asks the first time
they point the runner at an epic, each answer naming the file or command that
settles it, and saying plainly where the honest answer is "nobody knows yet".
Open it when you have a specific question and no symptom. It is a re-cut of
material that lives in `findings.md`; where the two disagree, `findings.md` is
authoritative and this one is the summary.

## While a run is going

**`docs/progress/<epic id>.md`** — the human-readable table of one epic: a row
per task with its status and dependencies. Open it to see where a run stands
without reading `.afk/state.json`. It is a projection written by the runner, not
a document you edit; `.afk/state.json` is the source of truth for lifecycle and
this file is only its readable face.

One file per epic because a shared one conflicted on every multi-epic merge —
two branches appending to the same file collide textually even when they have
nothing to disagree about. Inside its file each epic still owns the section
between its `<!-- afk:progress:<id> -->` and `<!-- /afk:progress:<id> -->`
markers and rewrites only that, so anything you write outside them survives
every flush. A wave is not an exception: it carries an id like `wave-01` and
writes `docs/progress/wave-01.md`. Only a DAG with no epic id at all — `afk auto
--dag=<file>` over a hand-written one — falls back to the shared
[`progress.md`](progress.md), and an existing shared file is left exactly where
it is.

**[`closeout.md`](closeout.md)** — what runs between the last lane merging and
the pull request being ready to read: the verifier, the one-shot fixer and the
reflector, in order, with what each is allowed to write and where its output
lands. Open it when a run has finished and you are about to read its PR, or when
you want to know why the closeout left something for you. It is authoritative
for the close sequence; `runbook.md` covers a run that broke, not one that ended.

## When something breaks

**[`runbook.md`](runbook.md)** — recovery organised by what you see at 2am
rather than by which script is at fault: find the symptom, read what it means,
run the command. Open it the moment a run misbehaves. Every command in it is
real (it is checked against `afk --help`), and it is authoritative for recovery
procedure — `faq.md` may describe the same situation, but the steps here are the
ones to run.

**`failure-modes.md`** — one table of every failure mode
this runner has actually hit, drawn from `AGENTS.md` and from `findings.md`
sections 3 and 6: what you would see, what was really wrong, and where it is
guarded now, with the still-OPEN ones marked. Open it when a symptom looks
familiar or when you are about to change a file that has burned someone before.
It consolidates rather than replaces: `AGENTS.md`'s numbering stays
authoritative, and the table states where `findings.md` numbers things
differently. Its second half, "From the epic reflections", is the same
projection over twelve epic write-ups from three projects, ranked by how often
each cause recurred rather than by severity — read that one when deciding what
to fix next, since a cause that bit five times has already outvoted a worse one
that bit once.

**[`dx-proposals.md`](dx-proposals.md)** — the half of those reflections that is
not a bug: changes to what the runner says and what you type at it, each with
the decision it needs stated rather than assumed. Nothing in it is scheduled.
Open it when you have appetite for a workflow change, not when something is
broken.

## How the runner got its shape

**[`herdr-plan.md`](herdr-plan.md)** — the runtime and observability layer:
herdr workspaces and panes instead of a raw `claude` spawn, what AFK keeps
(scheduling, verification, serialized integration, recovery), and what herdr's
agent states are and are not allowed to decide. Open it before touching anything
that launches or watches an agent. It is built, and it stays authoritative for
how a single lane executes even where `epic-schema.md` touches the same ground.

**[`epic-schema.md`](epic-schema.md)** — the specification for the epic spec
layer: the three-way split between the GitHub epic (what to build),
`.afk-setup/config.yaml` (how it is verified) and `.afk/state.json` (what is happening
now), plus field rules for the `afk:` block and the role set. Open it when you
need to know what the runner is *supposed* to do with a spec. Status matters
here: the config/DAG split and the parser landed, but the roles, the authoring
skills and `gate: after`'s lifecycle are still design, so read it as a contract,
not as a description of the code.

**[`permissions.md`](permissions.md)** — what actually caps each of the five
roles, and why the three mechanisms that look like one are not: tool deny
rules, `bypassPermissions`, and the role's working directory — with a table
of which mechanism holds which role, the gotchas behind each, and the caps
still open. Open it before changing a role's permissions, or when an agent
wrote something you expected it could not. It describes what is enforced
today, checked live against a real `claude`, where `epic-schema.md` gives the
role set as a contract.

**[`notifications-and-agent-scope.md`](notifications-and-agent-scope.md)** — two
small operational changes found while watching a build run: making notifications
clickable so a blocked lane can be acted on, and tightening agent scope. Open it
if you are working on notifications or on what an agent is allowed to touch.
Still design, and independent of everything above, so it can land any time.

## What is still owed

**[`findings.md`](findings.md)** — everything the build surfaced that is worth a
ticket, each entry written so it can become one without further investigation,
with evidence, a rough size, and a blocking/non-blocking split. Open it when you
are deciding what to work on next. It records *what we learned*, including
things nobody planned to look for.

`deferred.md` (the build's ledger of what it knowingly skipped) and
`build-prompt.md` (the contract for building the runner in the first place) were
deleted once the build they described was done. `git log` has them if the
history of a decision ever matters; `findings.md` carries the evidence that is
still load-bearing.
