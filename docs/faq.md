# FAQ — the first run

Answers an operator actually needs the first time they point AFK Claude at an
epic. `docs/findings.md` holds the same material organised by when it was
discovered; this file is organised by what someone wants to know.
Every answer names the file or command that settles it. Where the honest answer
is "nobody knows yet", it says so.

Terms in **bold** are defined in [`docs/glossary.md`](glossary.md).

## Where do task worktrees live, and why not inside the project?

Outside the project, at `~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo>`,
keyed by absolute path so two checkouts of one repo never collide. Set
`AFK_WORKTREE_ROOT` to move them. See **Worktree** in
[`docs/glossary.md`](glossary.md) and `worktreeRoot` in `scripts/worktree.mjs`.

Outside is deliberate. A **worktree** is a full second copy of the repo, so any
check that walks the tree walks the lanes too: `eslint .` once failed an
integration whose merge was perfect, on a vendor file it found inside a lane.
Gitignoring `.afk/` does not help, because eslint, prettier, ast-grep and vitest
do not read `.gitignore`. `AGENTS.md` failure mode 6 has the full history.

## What happens when a lane fails?

The task is marked terminally failed and every task that depends on it is
stranded — `dependenciesPassed` in `scripts/scheduler.mjs` requires every
dependency `passed`, so a root failure costs its whole subtree. This is why
`PLANNER.md` asks for wide, shallow graphs, and why `afk validate` prints each
task's **blast radius** (`docs/epic-schema.md`, "Failure modes this design must
handle", #1).

An integration failure is different: it never deletes the completed task branch,
and the merger's changes are rolled back from the base branch (`README.md`,
"Runtime and recovery"; `restoreMain` in `scripts/integrate.mjs`).

## What does the circuit breaker do?

`MAX_CONSECUTIVE_FAILURES = 2` in `scripts/auto.mjs` stops the scheduler from
starting *new* builders after two terminal failures with no pass in between.
In-flight lanes still drain and integrate, and any single pass resets the count,
so unrelated failures spread across a long plan never false-alarm.

The point is that a broken baseline or a bad shared dependency fails every task
for a reason no builder can fix from inside its own scope. See `AGENTS.md`
failure mode 7.

## The breaker tripped but my tickets were fine — what happened?

Probably an expired `claude` login, which used to make every builder exit
non-zero in under two seconds and read as a run of bad tickets. Two guards now
separate the two cases:

- `preflightBlockers` probes that `claude` answers a trivial prompt and that
  every `config.requiredEnv` secret is present, before the first builder is
  spawned, failing to STDOUT with `AUTO: not authenticated` /
  `AUTO: missing env <NAME>`.
- when the breaker does trip, `looksLikeInfra` classifies the cluster; a run of
  sub-second failures across unrelated tasks leaves the tickets `infra_failed`
  rather than `failed` — unproven, not bad, and re-runnable once the environment
  is fixed.

Both in `scripts/scheduler.mjs`; `AGENTS.md` failure mode 7.

## Why is `.afk/` gitignored, except for the ledger?

`.afk/` is live state — `state.json`, logs, prompts, JSONL streams and recovery
patches — and belongs to one machine and one run, so a consuming project
gitignores it (`README.md`, "Project interface").

`.afk/epic-ledger.yaml` is the exception, force-added and committed to the base
branch as it changes, because a cross-lane finding has to outlive the run that
recorded it. The force-add is needed precisely *because* the path is ignored; a
plain `git add` refuses it. See `flushStatuses` in `scripts/auto.mjs` and the
**Ledger** entry in [`docs/glossary.md`](glossary.md).

## Can lanes talk to each other?

No. A **lane** is one task's branch, worktree and single agent, and the only
channel between lanes is the ledger — one-way, into *later* lanes only. A lane
writes with `afk ledger add`; only entries tagged `applies_to: [<task>]` are
injected into a later lane's prompt (`scripts/ledger.mjs`,
`renderLedgerForPrompt`). Nothing flows backwards or sideways: no agent rewrites the ledger, there is no
`--set` or `--edit` path, and per [`docs/glossary.md`](glossary.md) a lane that
edits the file directly has the change reverted by `run.mjs`.

Open question: `applies_to: []` currently means the entry enters *no* lane's
prompt. Whether untargeted should instead mean *everyone* is unresolved — Lane J
chose the conservative reading and asked to be overruled if wrong
(`docs/findings.md` 2.3).

## What happens on restart if a child issue was closed?

The run stops. There is no local copy of the spec, so a restart re-fetches the
epic and diffs the graph against the shape recorded in `.afk/state.json` at run
start; any structural change — a task added, removed, re-pointed or newly gated
— is refused by id. A closed child issue is a structural change, so it halts the
runner rather than silently orphaning a lane. A retitled issue is not a change.
See `docs/epic-schema.md` #4 and `README.md`, "Usage".

## Why can't the verifier block an epic from closing?

By decision, not by omission. `verifierDecision` returns `clean`,
`criteria-unmet`, `must-fix` or `inconclusive`, and `closeEpic` closes in all
four cases — the first two become `completed_with_findings`, the others
`completed`. The reasoning: the merge has already happened, and the human's
`gate: after` acceptance (`afk epic <n> --accept=<id>`) is the gate, not the
review. Findings land in the closeout and the issue comment instead.

This is still on the list for a human to overrule; it is a one-line change in
`closeEpic`. See `docs/findings.md` 4.1.

## Does anything run the verifier automatically?

Yes. `closeEpic` runs it when the last task passes and every `gate: after` is
accepted, and the recommendation lands in the closeout comment on the epic
issue. `afk verify <issue>` runs the same review by hand at any point; `--reuse`
returns the report already on disk instead of paying for a second one.

## Is the runner's sandbox actually enforced?

Now we do, and the answer is **no**. Measured live on 2026-08-18
(`AFK_LIVE=1 node scripts/live-checks.mjs --check=sandbox`):
`sandbox.filesystem.allowWrite` only ever **widens** what an agent may write. It
cannot narrow, so an empty `allowWrite: []` adds nothing rather than forbidding
everything, and Claude Code's own default grant — the session's working
directory — stands underneath it regardless. With the tool denials taken out of
the way, every read-only role wrote a file into the directory it runs in — which
is the sandbox layer measured on its own.

That is why the fix was the **cwd**, not the sandbox. `verifier` and
`supervisor` no longer run at the project root: `createRoleCwd` in
`scripts/worktree.mjs` gives each one a directory outside the project — a
disposable detached checkout for the `verifier`, a bare scratch directory for the
`supervisor` — so Claude Code's default grant covers somewhere harmless and the
repository falls outside every `allowWrite` entry, which is the part the sandbox
does enforce. Their `Write`/`Edit` denials still hold on top, and a shell
redirect still walks around those, which is precisely why the cwd is what the
guarantee rests on. `plan-reviewer` is read-only for a third reason again: it
denies `Bash` outright.

The second unknown resolved cleanly: `--permission-mode acceptEdits` under `-p`
**auto-denies and does not hang**, recording each refusal in the result line's
`permission_denials`. `docs/findings.md` 3.2 has the full table and the three
directions a fix could take; widening the sandbox is not one of them.

## Is any of that true for `afk-codex`?

**No, and do not assume it transfers.** Everything above measured Claude Code.
The Codex CLI has no `--settings` payload and no `--permission-mode`; its cap is
an OS-level sandbox mode named on the command line, `--sandbox read-only` or
`--sandbox workspace-write`, chosen from the same role profile by `codexSandbox`
in `scripts/roles.mjs`. So a read-only Codex role has **one** cap where a
read-only Claude role has three, and the two layers that mask the sandbox under
Claude — the finding this FAQ entry is about — are simply absent.

The Codex equivalent of the check above is:

```bash
AFK_LIVE=1 node scripts/live-checks.mjs --check=codex
```

It asks a `read-only` session and a `workspace-write` session to write the same
file with a shell redirect, and scores the pair. The `workspace-write` row is
the positive control: without a write there, "read-only did not write" and "the
agent never tried" are the same observation, and the check reports
`inconclusive` rather than passing.

## Which CLI does a Codex run tell me to log into?

`codex login` — and `codex logout`, without the `auth`. `codex auth login` is
not a command. The preflight probes whichever backend the executable you typed
selected and names that backend's remedy, so `afk` says `claude auth login` and
`afk-codex` says `codex login`; the mid-run refresh offer and the circuit
breaker's message name the same one. A refusal naming a CLI you never ran means
you are in the wrong executable.

## Can I run a Codex epic under herdr?

No, and it is refused before anything is spent — before the plan review, the
branch and any model call. The herdr runtime drives an *interactive* agent in a
pane: it types a pointer prompt in and reads the lane's report back out of the
scrollback. `codex exec --json` is a non-interactive pipe with no pane and no
scrollback, so a lane dispatched that way would produce no report at all,
minutes later, with nothing anywhere saying why. `afk --runtime=herdr` is
unchanged; `afk-codex` runs on the direct runtime only.

## Can a builder edit files outside its task?

Yes. A task's `allowedPaths` is advisory — nothing blocks the write, and the
edit is kept. `pathAllowed` in `scripts/worker.mjs` only *records* the strays, as
`keptOutsideDeclaredPaths` in `.afk/runs/<id>/builder-<n>/verification.json`, so
that is the file to read when a lane's diff is bigger than its ticket.

**The worktree is not the boundary it was documented as.** Measured on
2026-08-19, now that `scripts/live-checks.mjs` probes the builder too: from
inside a real lane, under the shipped profile, a builder **wrote the main
checkout and a sibling lane's worktree** with the `Write` tool — no error, no
recorded denial. Asked for a shell redirect instead, the same session was
refused both (`operation not permitted`) while `/tmp` still succeeded.

So the cap is real but only covers `Bash`: the sandbox governs the shell, the
permission mode governs `Write`, and `--dangerously-skip-permissions` is exactly
what takes the second one away. A builder reaches for `Write` by default.

**What protects you today is that the runner now watches for it.**
`foreignWrites` in `scripts/worker.mjs` reads every builder's own transcript and
fails the task the moment it *lands* an edit outside its lane, then stops the
whole run rather than retrying — a retry would reset the lane and leave the
stray file sitting where it was written, and a builder that reached into another
lane may have damaged work that lane is still doing. So a crossing is named,
with the tool and the path, instead of surfacing later as a merge conflict
nobody can explain. A write that was *refused* is recorded but does not stop
anything: that is a cap doing its job.

Be clear about what that is and is not: it is detection, not a cap. The write
has already happened when the runner sees it, and a write made by a program the
builder *launches* goes through `Bash`, which the sandbox does still stop.
For a Claude builder there is now a cap as well: a PreToolUse hook
(`scripts/project-root-guard.mjs`) refuses its file tools the run's checkout and
every lane but its own. A Codex builder ignores `--settings` and has only the
detection. [`docs/findings.md`](findings.md) 3.15 has the table, the
transcripts and the four directions; widening the sandbox is not one of them.

One thing *is* not advisory: `PROTECTED_FILES` in `scripts/lib.mjs`
(`.afk-setup/config.yaml`, `docs/progress.md` and `docs/progress/`,
`agent-auto.log`, the dependency
manifests and lockfiles) is reverted by `restoreProtected` in
`scripts/worker.mjs` before the commit. Note the scope, given the above — it
reverts those paths *inside the lane's worktree*, so a write to the same file in
the main checkout is never seen by it. See
[`docs/permissions.md`](permissions.md), "`implementer`", for the mechanism.

## Can the closeout reviewer modify the branch it is reviewing?

No, and not because it was asked not to. `spawnVerifier` (`scripts/verifier.mjs`)
starts the `verifier` in a **disposable detached checkout** of the branch, made by
`createRoleCwd` in `scripts/worktree.mjs`; the project root is then outside
everything it may write, and the copy it *can* write is thrown away. The Git
verbs that could move a ref, and the `gh` verbs that could write the issue, are
denied on top — the runner posts the report, never the reviewer.

The exception is written into the code and printed out loud: if the checkout
cannot be made, `spawnVerifier` falls back to the project root and says
*"reviewing from the project root, where this role can write what it is gating"*.
[`docs/permissions.md`](permissions.md), "`verifier`", has the measurement that
this cap, and not the deny rules, is what holds.

## Why did my pull request get two comments from the runner?

Because the closeout posts two different documents, and merging them would lose
one of them to whoever came for the other. The first is the **run account** —
the rendered closeout plus what the fixer changed, about the code, read before
you merge. The second is the **reflection** — about the run itself, read the
next time the same thing goes wrong. Both are steps 4 and 6 of `closeEpic` in
`scripts/auto.mjs`; [`docs/closeout.md`](closeout.md) has the full sequence.

Neither is in the PR body on purpose. `renderPrBody` (`scripts/pr.mjs`)
regenerates the body from `.afk/state.json` on every refresh and never reads it
back, so anything written there is overwritten with nothing left to show it
existed. A comment is append-only and carries a marker
(`<!-- afk:run-account:<epic> -->`), so it survives every later render.

## Where did the reflection go, and why is it not on my branch?

It is in the **runner's** repository, not in your project: under
`docs/reflection/<project>/epic-<id>.md`, where `<project>` is the GitHub repo
name (`reflectionPath` in `scripts/reflect.mjs`). Set `AFK_REFLECTIONS_ROOT` to
override the root if you keep reflections somewhere else. It shipped first as
`docs/<project>/reflection/epic-<id>.md` and was moved so that a run with a junk
project name makes a junk folder inside `docs/reflection/` rather than beside
`docs/README.md`. A run with no GitHub remote has no project name and gets no
reflection at all.

It is not on your branch because the reflector is capped to the reflections
folder and **the runner does not commit the reflection** — committing it in the
runner's repo is yours to do. The copy posted to the PR is a comment, and the
prompt, stream and draft stay in `.afk/reflect/<epic>/`.

## What happens if an agent tries to write something it may not?

Three different things, which is why the answer to "was it stopped?" needs the
mechanism named — all three are in [`docs/permissions.md`](permissions.md), "The
three mechanisms".

- **A denied tool** comes back *"No such tool available: Write"*. The tool is
  removed, not refused, so `permission_denials` in the result line stays empty
  and a stopped agent looks exactly like one that never tried (gotcha 2).
- **A sandboxed path** refuses the shell redirect, from outside the role's cwd.
- **A protected or out-of-scope file** is not stopped at all: the write happens,
  and is then either reverted (`revertedProtected`) or merely recorded
  (`keptOutsideDeclaredPaths`) in that lane's `verification.json`. The revert
  narrows by JSON key rather than by file — `protectedEdits` in
  `.afk-setup/config.yaml` names the top-level keys of a protected JSON file a
  lane may legitimately edit, and defaults to `package.json`'s `scripts` so a
  builder can wire its own tests into the gate. Whatever is still reverted comes
  back as `needsHumanAction`, on the runner log and in a committed
  `ACTION-REQUIRED.md`; if it was the manifest or a lockfile the lane is marked
  `blocked` rather than integrated, because its checks ran against a tree that
  file no longer describes. A ticket whose **acceptance criteria**
  require an edit to a protected path builders are granted no keys on never gets
  that far: `afk validate` refuses it as an `unsatisfiable_criterion`, where the
  fix is still a ticket edit rather than a merged green lie. The same path named
  in the surrounding prose is a warning, not a refusal — pointing a builder at
  `AGENTS.md` is ordinary, and an epic halted over a pointer teaches people to
  work around the validator.

## What is still not guaranteed?

Plenty, and the list is the "Still open" section of
[`docs/permissions.md`](permissions.md) rather than anything reassuring here.
The two worth knowing before the first unattended run:

The `integrator` has **no permission cap** beyond the `herdr` skill deny. It
merges at the project root with bypass and `deny: []` (`scripts/roles.mjs`).
What contains it is the runner around it — `restoreMain` in
`scripts/integrate.mjs` rolls the base branch back on failure — not its
permissions.

Any role that keeps `Bash` and is *handed a path inside the project* can still
write it. The cwd cap stops that happening by accident; it does not stop it
happening on purpose (`docs/findings.md` 3.2, "Not fixed by this").

## Can I skip the plan review if the model is down?

No, and that is currently a known problem rather than a settled answer. The
`plan-reviewer` runs on every `afk epic`, including restarts, with no escape
hatch by design — a flag would recreate the "disable a gate" surface this project
rejected. The counter-argument is that a flaky dependency now sits in front of
the only entry point. Four options are on the table and none has been chosen:
leave it, a documented override flag, degrade to deterministic-only with a loud
warning, or let the `supervisor` authorise the bypass. See `docs/findings.md`
1.2.

## How do I try the runner without spending money on agents?

`node afk.mjs selftest` (equivalently `node scripts/selftest.mjs`) exercises the
runner end to end with a fake `claude`, making no real agent calls. `AGENTS.md`
asks for it before and after any change to `scripts/`.

For the epic path specifically, `afk validate <n>` reads the epic and its child
issues and prints depth and blast radius while creating nothing — no branch, no
worktree, no `.afk/`, and it never edits the issue (`README.md`, "Usage").

## Has anyone actually run an epic end to end?

Yes — three, all of them deliberately throwaway, and each found bugs the test
suite could not. `docs/findings.md` 1.1 recorded the era when none had run; that
is history now.

Treat that as the standing caveat on everything above rather than reassurance.
The first live attempt (epic #3, 2026-08-18) found `afk epic` doing its expensive
work before its cheapest preflight (`docs/findings.md` 3.5) and a merger lane
binding to the operator's own Claude session (3.6). Three runs is enough to find
that class of bug and nowhere near enough to have found them all.
