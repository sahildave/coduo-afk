# Wave mode — running a markdown task directory unattended

Wave mode runs a directory of markdown task files overnight, with no issue
tracker and no pull request. It is a **loader plus a driver** in front of the
existing runner: `afk auto --dag=` already accepts a tracker-free graph, and
`worker.mjs` already reads a task's text off `task.body` rather than fetching an
issue. Nothing in the scheduler, the lane lifecycle or integration changes.

Authored by `coduo-tasks`. The GitHub path (`coduo-epic` → `coduo-tickets` →
`afk epic`) is unchanged and unaffected.

## Operator verbs

`afk wave accept <dir> <task-id>` records a blocked task as terminal `no-op` in
the wave log. The release gate then treats it as satisfied, and a resumed run
does not schedule it again. The command refuses an id outside the loaded task
directory and names that id.

`afk wave stop` reads this checkout's `.afk/state.json`, sends SIGTERM to every
recorded builder and integrator pid, and prints the verified fate of each. It
exits non-zero when there is no run state or no recorded live lane pid.

## Vocabulary

Extends `CONTEXT.md`; the terms there keep their meanings.

- **Wave** — one `afk epic` run over a subset of the graph: its own branch, its
  own `.afk/`, its own worktree. Waves are strictly serial.
- **Wave log** — `tasks/.wave-log.json`, git-tracked. The driver's only memory,
  because `.afk/` is archived at every wave boundary.
- **Owns** — the exact paths a task may create or edit. Load-time refusal on
  collision, and a scheduling constraint at run time.
- **Grounded retry** — a retry whose prompt carries the prior attempt's failure
  evidence. Contrast with today's blind retry, which re-runs an identical prompt
  in a clean worktree.

## Why not the epic path

`epic-spec.mjs` validates that every task key is an issue number in six places
and `fetchEpic` is a GraphQL call, so teaching the epic path to read files means
threading a second source type through the most-tested file in the repo.
`epicToDag` also hardcodes `allowedPaths: ["**"]` (`epic.mjs:127`), so per-task
scope cannot survive it. The `--dag=` path already carries both. Wave mode is
therefore additive: one new loader, one new driver, two small runner changes
that stand on their own.

---

## 1. The directory contract

```
tasks/GOAL.md              handed to the plan reviewer as the epic body
tasks/tasks-todo/*.md      one file per task
tasks/tasks-done/          the driver files a task's file here when the wave
                           that passed it merged (§4)
tasks/.wave-log.json       driver state, git-tracked
```

### The split is status, not membership

`tasks-done/` is a **rendering of the wave log**, not a second source of truth.
The log says what passed; the tree says it again in the one form a human reads
at a glance, which is why the bug this fixes was not cosmetic: seven files still
sitting in `tasks-todo/` after two merged waves report that nothing happened.

Three rules follow, and each of them is a guard in code:

- **The driver moves the file; a task never moves its own.** An agent that files
  its own completion is an agent marking its own homework, and `owns` gives no
  task a claim on `tasks/`.
- **The loader reads BOTH directories as one graph.** A `blocked_by` edge naming
  a task whose file has moved must keep resolving. Scoping the loader to
  `tasks-todo/` alone would make the first merged wave turn every dependent into
  a `dangling_edge`, refuse the whole directory, and leave a run that had merged
  two waves unable to resume at all — the exact failure the wave log exists to
  prevent. The two sides are merged and sorted as one list, so the DAG's task
  order does not shift as files move. Either side may be absent: `tasks-done/`
  does not exist until the first wave merges, and `tasks-todo/` stops existing
  when the last file leaves it, because git does not track an empty directory.
- **One bit, done or not.** A failed or dead task keeps its file in
  `tasks-todo/`. There is no `tasks-failed/`: a third directory would be a
  second lifecycle vocabulary competing with the wave log, which is the only
  state that crosses a wave boundary and the only thing entitled to say why a
  task did not finish. The digest (§4) is where a dead task's reason lives.

Moving an already-moved file is a no-op, so re-running converges. A file present
on both sides at once is corruption the driver will not silently repair: it
moves nothing, and the loader refuses the directory with `duplicate_id`.

### Frontmatter

A closed set. An unknown key refuses the **whole directory**, not the file.

| Key | Required | Shape | Maps to |
| --- | --- | --- | --- |
| `id` | yes | `task-NN-<slug>`, matching the filename stem | `task.id` |
| `blocked_by` | yes | list of ids in this directory (`[]` allowed) | `task.dependsOn` |
| `owns` | yes | non-empty list of repo-relative paths or directory prefixes | `task.allowedPaths` |
| `status` | yes | `ready-for-agent` | — |
| `checks` | no | list of shell commands | `task.checks` (absent → `defaultChecks`) |
| `gate` | no | `before` \| `after` | `humanGated` / `gateAfter` |

`title` is the first `# ` heading. `body` is the file from that heading down,
verbatim. There is no `model` or `effort` key: the executor is the runner's
`implementer` role.

### Refusal table

The loader either accepts the directory or exits non-zero naming every problem.
Refusals, not warnings — a warning at 3am is a warning nobody reads.

| Code | Condition |
| --- | --- |
| `unknown_key` | frontmatter key outside the table above |
| `missing_key` | a required key absent |
| `id_mismatch` | `id` disagrees with the filename stem |
| `duplicate_id` | two files claim one id |
| `dangling_edge` | `blocked_by` names an id not in the directory |
| `cycle` | the graph is not a DAG |
| `owns_empty` | `owns` is absent or empty |
| `owns_glob` | an `owns` entry contains `*`, `?` or `[` |
| `owns_escape` | an `owns` entry is absolute or escapes the repo root |
| `owns_root` | an `owns` entry claims the repo root — it normalises to nothing (`.`, `./`, `""`, `a/..`) |
| `owns_collision` | two tasks share an owned path with no edge between them |
| `ungateable` | no `checks` and the project sets no `defaultChecks` |
| `no_title` | no `# ` heading |
| `no_criteria` | no `## Acceptance criteria` section |

`owns_root` and `owns_escape` are neighbours, not duplicates: leaving the repo
root and claiming the whole of it are different mistakes with different fixes.
An entry that fits both descriptions — anything with a leading `/` — is reported
as `owns_escape`, the older and more specific of the two, so one break never
yields two codes. `owns_root` is where the `**` hole would otherwise reopen in
its unglobbed spelling; `owns_glob` already refuses `**` itself.

`no_criteria` is load-bearing rather than pedantic: a task with no criteria
section makes the closeout verifier diff-only, and it then reviews the code
against itself.

**Collision** is directory-prefix aware. `Sources/Feature/` and
`Sources/Feature/View.swift` collide; `Sources/A/` and `Sources/B/` do not.
Two tasks may share a path when one transitively depends on the other — that is
a sequencing decision the author made, not a mistake.

### CLI

```
afk wave validate <dir>            refuse or print the accepted graph
afk wave validate <dir> --json     the DAG JSON, for --dag= or for tests
afk wave run <dir> --base=<branch> the driver
```

`validate` is what `coduo-tasks` must exit 0 on before it is finished, which is
what makes the authoring rules mechanical instead of aspirational.

---

## 2. Loader

Pure: directory in, DAG JSON out or a refusal list. No git, no network, no
`.afk/` writes — so it is testable entirely from fixtures, and the fixture table
is the refusal table above, one malformed directory per code.

Output is exactly what `normalizeDag` already accepts:

```json
{
  "epic":   { "id": "wave-03", "title": "<first heading of GOAL.md>",
              "body":  "<GOAL.md from that heading down, verbatim>" },
  "branch": "wave-03",
  "tasks":  [ { "id", "title", "body", "dependsOn", "checks", "allowedPaths",
                "humanGated?", "gateAfter?" } ]
}
```

`normalizeId` is `String(id)` (`lib.mjs:463`), so `wave-03` and
`task-07-repo-picker` need no runner change.

`GOAL.md` becomes the epic body handed to the plan reviewer — the thing a wave
is checked *against*. Without it, review has only the tasks, and comparing
tasks to tasks produces confident nonsense.

The title alone does not keep that guarantee, which is why `epic.body` is on
the DAG above. `auditFindings` (`plan-review.mjs`) drops any
`unsatisfied_criterion` whose quoted criterion does not appear verbatim in the
epic body — so a DAG carrying only the title cannot keep a single criterion
finding, and the one class that predicts a green run producing the wrong
artifact is disabled while the review still reports itself clean.

**Write `GOAL.md` as the goal the whole directory is measured against, not as a
checklist of per-task criteria.** Per-task criteria belong in the task file's
own `## Acceptance criteria` section, which §1 already requires.

This used to carry a stronger warning — that a `GOAL.md` enumerating per-task
work would refuse wave 1 for work wave 4 does — and that warning was a symptom,
not a rule. The review was per wave, so wave 1 was checked against the whole
goal while holding three root tasks, and no wording of `GOAL.md` could fix a
refusal caused by tasks missing from the *prompt*. The review now runs once over
every task in the directory (§4), so the mismatch is gone.

---

## 3. Wave log

`tasks/.wave-log.json`, git-tracked. `.afk/` is archived wholesale at each
boundary, so this is the only thing that crosses one.

```json
{
  "version": 1,
  "base": "main",
  "planReview": { "status": "clean", "reviewedAt": "<ISO>", "tasks": 7 },
  "waves": [
    {
      "id": "wave-03",
      "branch": "wave-03",
      "baseSha": "<main before the wave>",
      "headSha": "<main after the fast-forward, or null>",
      "maxParallel": 3,
      "tasks": { "task-07-repo-picker": { "outcome": "passed", "attempts": 1 } },
      "verifier": "clean | disputed | unavailable",
      "digest": "docs/afk-runs/wave-03.md",
      "outcome": "merged | failed | halted"
    }
  ]
}
```

`planReview` is the run's one plan review (§4), `null` until it passes. It is
top-level because what was reviewed is the whole frozen graph, which is a
property of the run rather than of any wave — and because a resuming run has to
answer "has this decomposition been reviewed?" without picking a wave to ask.

`attempts` crosses the boundary on purpose: without it a task that burned two
grounded retries in wave 3 gets a fresh two in wave 4, and "two retries"
silently becomes unlimited.

Resume is reading this file. A wave recorded `merged` is skipped; anything else
re-runs under its own number from `baseSha`, on the branch it already cut, with
the frontier recomputed so a task that passed inside the crashed wave is not
built twice. Its results are folded into the existing record rather than
replacing it — replacing would drop the passed tasks out of the log and offer
them to the next frontier, rebuilding code already on the branch. That makes
`afk wave run` idempotent: re-run it after a crash and it converges rather than
repeating work.

---

## 4. Driver

Serial. One wave at a time, `--worktree` always, so the main checkout stays on
`main` and belongs to the driver alone.

```
plan review over GOAL.md + EVERY task, once   (refusal => stop; nothing cut)
                                              (skipped if the log records one)
loop:
  frontier   = tasks whose blocked_by are all passed in the log
  wave       = frontier, capped at WAVE_CAP (default 12)
  if wave is empty: break
  branch     = wave-NN, cut from main (an existing one is recreated when the
               log records no passed task, and refuses the cut when it does)
  write DAG  -> .afk/wave-NN.json
  afk auto --dag=.afk/wave-NN.json --base=wave-NN   (in the wave's worktree)
  on wave end:
    if every task is terminal, one passed, and main is an ancestor of wave-NN:
        fast-forward main
    write digest      -> docs/afk-runs/wave-NN.md
    archive .afk/ -> <repo>/.afk/archive/wave-NN/
    remove the wave worktree, and the branch too if no task reached a
      terminal outcome — worktree, prune, branch, each verified
    append to the wave log
    IF the wave merged: file every passed task's file under tasks-done/, and
      commit log + digest + the moves to main as one bookkeeping commit
    if dead tasks orphan > 25% of the remaining graph: halt
```

`afk auto`, not `afk epic`: `epic` takes an issue number and fetches it over
GraphQL, which is the whole reason wave mode exists. `maxParallel` is read from
`.afk-setup/config.yaml` like every other run — there is no `--max-parallel`
flag, and inventing one belongs to a change of its own. The wave's worktree is
made the way `afk epic --worktree` makes one (`createEpicWorktree`), so the main
checkout stays on the base branch and belongs to the driver alone.

The digest is written AFTER the fast-forward decision and BEFORE the archive:
after, so it can record where the base landed; before, so the failing attempts'
evidence is still on disk to copy.

**The graph is frozen at t0.** Agents that write follow-up task files still
write them; those files sit in `tasks-todo/` for morning triage and join
tomorrow's run. A driver that re-read the directory each wave would schedule an
agent's excuse for not doing the work, and the graph would stop being finite.

**Waves are strictly serial.** A level-capped wave already *is* the disjoint
set — two waves that could run concurrently are the same wave, and running them
wider is a `maxParallel` change. Concurrent waves would also mean two writers
racing for one fast-forward onto `main`, which is the single serialization point
that makes a hundred unattended merges safe.

### Plan review

**Once per run, over the whole task directory**, at the project root, before the
first branch is cut — the same ordering `cliEpic` uses, and for the reason
`plan-review.mjs` states: "a contradiction aborts before any branch or worktree
exists". A refusal stops the driver with no branch, no worktree and no lane, and
nothing written to the log or the digest, so the repository is exactly as it was.

**It was per wave, and that was wrong.** The first live run proved it in one
shot. `.afk/plan-review/wave-01/prompt.md` carried wave 1's three root tasks and
the whole of `GOAL.md`, which describes a CLI reading stdin and writing an
aligned table. The reviewer refused with `unsatisfied_criterion` — "no child task
builds the CLI wire or the table-assembly/column-width logic, so the epic's
defining stdin-to-aligned-table behavior cannot be produced by this
decomposition" — and it was right about what it was shown and wrong about the
project: the CLI is `task-06-cli`, in wave 3. The run exited 1 with no branch
cut. Reviewing one slice of a graph against the whole goal structurally
guarantees that false refusal on wave 1 of any project whose goal needs more than
one wave. It is not an authoring problem and rewording `GOAL.md` cannot fix it —
the missing tasks are missing from the prompt, not from the directory.

The justification for reviewing once is already load-bearing above: **the graph
is frozen at t0**, so the decomposition the reviewer judges at wave 5 is the one
it judged at wave 1. Reviewing it once is both correct and cheaper; reviewing it
per wave re-asks a fixed question with strictly less information each time.

**Resume does not re-review.** A run resuming from `tasks/.wave-log.json` is
resuming a decomposition that has already been reviewed and cannot have changed,
so a second review is one paid agent session that can only re-derive the first
verdict. The wave log is the only state that crosses a wave boundary (§3), so
that is where the fact lives: a top-level `planReview` object, `null` until the
review passes.

Top-level rather than a field on a wave record, because the thing reviewed is the
whole frozen graph — a property of the run, not of any wave — and hanging it off
`waves[0]` would imply the answer could differ between waves. It is written in
the same `atomicWrite` as the first wave's record, so a run that dies before any
wave is recorded re-reviews on the next attempt, and so does a log written before
the field existed. Both are the safe direction: a wasted review costs one short
read-only session, a skipped one costs the gate.

Anything `runPlanReview` reports as not `ok` blocks — a contradiction, an
expired login, or a reviewer that returned nothing usable twice. The wave does
not re-decide that split; `cliEpic` blocks on `!outcome.ok` and a second,
quieter policy for the same question is how two paths drift apart. A verdict
that never arrived blocks too: "no review ran" is not "a review found nothing".
The decision is `planReviewDecision` in `wave-driver.mjs`; spawning the
reviewer is `wave.mjs`, like every other effect.

Three details the spec did not pin down, decided here:

- **The children are every task in the directory, carrying their real
  `blocked_by` edges** — not a wave's slice, and not the stripped edges a run
  is handed. Stripping is a scheduling fact (a wave's dependencies are already
  merged onto the base it was cut from); telling the reviewer a dependent is a
  root would invite a `missing_dependency` for an artifact already on the
  branch.
- **No graph metrics.** `graphMetrics` computes depth and blast radius from an
  `afk:` block keyed by issue numbers (`epic-spec.mjs`), which a task directory
  is not; porting it to this shape is a change of its own, listed under Open
  below. The prompt omits the line when the row is absent. The old reason — a
  wave has no internal edge, so every row would read depth 0 — died with the
  per-wave review and is no longer why.
- **Budgets.** `EPIC_BODY_BUDGET` is 24,000 characters and `TASK_BODY_BUDGET`
  9,000, applied per body. The review now carries every task rather than
  `WAVE_CAP` of them, so the bound is **24,000 + N × 9,000 characters** for a
  directory of N tasks. Over the per-body cap, `clip` truncates loudly rather
  than dropping or overpaying.

  Where that starts to strain, in the units that matter. Against a 200,000-token
  context that is roughly 800,000 characters, so the worst case — every task
  written to the full 9,000-character cap — binds at
  (800,000 − 24,000) / 9,000 ≈ **86 tasks**. That is the number to watch, not
  `WAVE_CAP`.

  It is a long way from real. The throwaway run's seven task files measured 743
  to 1,179 characters each and its `GOAL.md` 813; its wave-1 prompt was 6,439
  characters in total, of which about 3,250 is the template. At ~1,000
  characters a task, **a 100-task directory renders in roughly 104,000
  characters — about 26,000 tokens, a quarter of the budget** — so the real
  target is comfortable. The constraint to hold instead is per-task: a
  100-task directory stays inside a 200,000-token window while the median task
  body is under (800,000 − 24,000) / 100 ≈ **7,700 characters**, which is below
  the cap `clip` already enforces. A model with a 1,000,000-token window has no
  problem at any N the loader will accept.

### Fast-forward

Lanes merge `--no-ff` into the wave branch (`integrate.mjs:100`), never into
base. The driver moves `main` afterwards:

```bash
git merge-base --is-ancestor main wave-NN   # refuse if this fails
git update-ref refs/heads/main wave-NN
```

The ancestor assertion is the whole safety mechanism. Never `--force`. If it
fails, something moved `main` during the wave: stop, write the digest, leave the
branch for a human. The refusal prints the diagnosis, not just the verdict —
``main` is not an ancestor of `wave-31`; `wave-31` is based at `cc58a9d`, `main`
is at `dafafa8` (2 commits ahead)` — because the operator's next move depends
entirely on those two shas and reconstructing them from the ledger afterwards is
a morning.

**Your uncommitted work is carried across the boundary, never run over.** The
fast-forward moves the ref out from under the base checkout and brings the
working tree back to it with `reset --hard`, which used to discard any tracked
modification a human had made while the wave was running. It is stashed before
the ref moves and popped after, and the boundary says which paths it carried.
If the wave changed the same file, the pop is refused: the tree is left clean at
the new HEAD and the stash is NAMED (`afk wave: wave-NN boundary`), because a
conflicted base checkout would refuse every remaining wave of the night.

**That is the seam for a mid-run repair, and it is the only one.** There is no
safe window to commit to the base during a run — a commit there breaks the
ancestor assertion and strands the wave — so edit the working tree freely, let
the driver carry it, and commit once the run exits. A repair that must reach the
next cut (a `blocked_by` edge fixing an `owns` collision, say) has to be
committed to exist, and the run exiting is when to do it. An edit that is
already in the tree when `afk wave run` starts is a different case and is
refused up front: nothing has been cut yet, so committing it costs nothing.

**A cut never adopts an existing `wave-NN` branch.** `-B` is not used, because
an existing wave branch can carry a replayed wave's earlier lane merges. What
decides is whether the wave log records a task as `passed` — the only outcome
that puts a commit on that branch. With none, the branch is one an attempt that
died before any lane ran left behind: it is deleted and re-cut from the base as
it stands NOW, and the recorded `baseSha` is dropped with it, because the whole
reason the wave is being re-run is usually a repair that has since landed on the
base. With one, and with the recorded sha not in the branch's history, the cut
refuses and names both shas rather than discarding merges nobody can rebuild.

A wave that reaches no terminal task outcome leaves nothing behind — no
worktree, no branch. The order is worktree, prune, branch, and every removal is
re-read rather than trusted: `git branch -D wave-NN` fails while a worktree
still holds the ref and its stderr goes to a log nobody reads.

Gated on **every task in the wave reaching a terminal outcome, and at least one
passing**. This is looser than "every task passed", deliberately, and the
driver's implementation says so at the guard: a *dead* task is terminal and is
already accounted for by the halt rule below, so treating it as a reason to
withhold the fast-forward would make "the driver carries on with whatever else
is still reachable" unreachable code — the night's first dead task would strand
every passing sibling off the base branch and the 25% rule would never fire.
What is not tolerated is a task that is neither passed nor dead: that means the
wave did not finish, and a half-finished wave on the base branch is a base
branch nobody can reason about. Wave tasks are independent by construction (an
edge is only satisfied by a PASS in an earlier wave), so no task in a wave is
waiting on a sibling when this is evaluated.

The log and the digest are committed to the base branch **only when the wave
moved onto it**. A withheld wave leaves them in the working tree for the next
merged wave to carry. Committing them unconditionally would advance the base
past the `baseSha` a replay resumes from, so the ancestor assertion on the
replay would fail against a base the driver moved itself, and the wave could
never land however many times it was re-run.

**The task-file moves ride that same commit, on that same condition.** §1 used
to say the runner moved them "at integration", and it does not: per-task
integration happens inside the `afk auto` subprocess, where the driver has no
seam and no authority over the base branch. The wave boundary is the honest
moment — it is where the driver already knows which tasks passed, already holds
the base checkout, and already writes the night's record. Filing the files there
puts them under the same "only when the wave merged" rule for exactly the reason
above: an unconditional commit moves the base past the `baseSha` a replay
resumes from.

The commit names **exactly the paths the driver wrote** — the log, one digest
per recorded wave, and both sides of each file it moved — never a directory.
`git add tasks/tasks-todo` sweeps every untracked file under it, and that put
two unreviewed agent-authored draft task files into a repository's history under
the human's name, in a commit whose message said only that a wave merged.
Anything else in those directories belongs to whoever wrote it.

It is a **bookkeeping commit, not part of the integration merge**. A lane merge
is the work; a file being filed is a statement about the work, the same class as
the log and the digest sitting beside it in that commit — and keeping it out of
the merge means a `git show` of the merge is still only the diff a reviewer
cares about. A withheld wave files nothing, so a resumed wave finds the files
where it left them.

A verifier objection is
advisory — it is recorded in the digest and leads the morning report with the
exact `git revert -m 1 <sha>`, but it does not hold the wave off `main`. Holding
would make one disputed criterion at 1am cost the rest of the night, and the
checkpoint sha makes it reversible.

### Failure

Two grounded retries per task (§5). A task that fails all three attempts is
**dead**: its dependents never become runnable, and the driver carries on with
whatever else is still reachable. If dead tasks orphan more than 25% of the
remaining graph, halt and write the digest — draining the night on 8% of a graph
produces the same morning as stopping at 1am, and costs six hours.

### Digest

`docs/afk-runs/wave-NN.md`, committed to `main`. Per wave: tasks attempted and
their outcome, the first failing check's output for anything that failed, the
verifier's disputed criteria verbatim, whether the closeout's fix commit was
gated, follow-up task files the agents wrote, and the pre-wave `main` sha with
its revert command. Full artifacts stay in
`.afk/archive/wave-NN/`; the failing attempts' evidence is copied into the
digest **before** archiving, or a dead task's reason is in a directory nobody
opens.

This is how a failed task is documented on `main` even though its code is not.

### The closeout fix gate

A wave's order is lanes → their gates → integration → the closeout review → **the
fix pass's commit**. That commit lands after the gates that just passed, so
nothing in the wave checks it. Between waves it does not matter: the next wave's
baseline runs the full chain over a tree containing it within a minute or two.

**The last wave of a run has no next wave.** quillnote wave-34 (2026-09-04)
ended on `18cdd44 fix: closeout findings for #wave-34` while its five gates were
recorded at `f2e2fa1`, the merge two commits below. Running the chain by hand
afterwards passed — but that was a human choosing to check.

So `afk auto`'s closeout now re-runs `baselineChecks ?? defaultChecks` over
whatever the fix pass committed, and only then. Most closeouts commit nothing,
and for those the tip is still the commit the wave's own gates ran over, so the
gate records `no_commit` and costs nothing. The result lands in
`.afk/fixer/<wave>/gate.json`, is read beside the verifier's report before the
archive, and gets its own digest section either way — `gated: yes`, `gated: no`,
or `n/a` with the reason. Before it, the digest could not distinguish a wave
whose tip had been checked from one whose tip had not.

A project that sets `integrationChecks` breaks that assumption: no integration
ran the full chain over the tip, so the gate runs `baselineChecks` over it even
when the fix pass committed nothing, and the line reads `closeout tip … gated`.

It is advisory in exactly the sense the verifier is: a red gate is recorded and
named, and does not hold the wave off the base branch (#78).

---

## 5. Grounded retries (runner-wide)

Ships to the epic path too. Today `MAX_BUILDER_RETRIES = 1` (`auto.mjs:77`) and
a retry re-runs an identical prompt in a clean worktree — the implementer
template has no slot for a prior attempt. The evidence exists and is never read:
`runDir` is per-attempt (`worker.mjs:400`), specifically so a retry cannot
overwrite why the last one died.

**Config.** `agent.maxBuilderRetries`, defaulting to `1`, so no existing epic
changes behaviour. The wave driver sets `2`.

**Prompt.** A new `{{#priorAttempts}}` section in `prompts/implementer.md`,
absent on attempt 1. Per prior attempt: the attempt number, the first failing
check's command and trimmed output, and the paths that attempt touched. First
failing check only — a prompt carrying all of them reproduces the 1.3M-token
death that `supervisor.mjs:259` already documents.

**Grades.**

| Attempt | What it gets |
| --- | --- |
| 1 | the ticket |
| 2 | raw evidence from attempt 1 |
| 3 | evidence from both, plus a diagnostician's note |

Attempt 2 is raw because retry-1 failures are mostly infra — a herdr kill, an
expired auth — and a stack trace plus a clean worktree fixes them without paying
for an agent. Only a second real failure justifies diagnosis, and by then there
are two failures to compare, which is where diagnosis beats a stack trace.

**Zero-token attempts get no grounding.** `verification.json` carries `tokens`
and `producedFiles`; an attempt with neither never reached the API, so its
"failure" carries no information about the ticket. Re-run it plain. Feeding a
model an infra error as if it were its own mistake sends it to fix the wrong
thing.

The diagnostician runs only when `maxBuilderRetries > 1`, so a repo that never
raises the knob never pays for it.

---

## 6. Owns as a scheduling constraint (runner-wide)

`allowedPaths` is reported today, not enforced, which is why per-task scope
surfaces as a 3am merge conflict rather than a refusal.

In `nextBuilderTasks` (`scheduler.mjs:169`), filter the runnable set so no task
is started whose `owns` overlaps an **active** lane's or an **earlier pick in
the same batch**. An excluded task is deferred to the next tick, not failed.

A deferral is logged once per deferral, not once per tick, at the `auto.mjs`
call site: the scheduler loop spins continuously, so a memo of what has already
been announced is what stops one idle lane from filling the log with the same
sentence until the lane it lost to frees.

**`["**"]` opts out.** This is not a nicety: `epicToDag` gives every GitHub task
`["**"]`, which overlaps everything, so without the opt-out the filter would
serialize every existing epic to one lane — a silent, catastrophic regression on
the path that runs every week. A task whose scope is repo-wide takes no
constraint.

Deriving real `allowedPaths` on the epic path from each child issue's "Allowed
paths" section is worth doing and is **not** in this design. It changes the path
you run weekly and deserves its own review.

---

## 7. Order of work

Each lands and is verified alone.

1. **Grounded retries + `maxBuilderRetries`** — universal, useful tomorrow,
   independent of everything here.
2. **The owns filter + the `["**"]` opt-out** — universal, small, and the
   opt-out is what stops it being a landmine under existing epics.
3. **The loader + `afk wave validate`** — pure, fixture-tested, no runtime.
4. **`coduo-tasks`** — needs the loader to validate against; produces the real
   directory the driver needs for testing.
5. **The driver + `afk wave run`** — untestable before 3 and 4. **Landed.**
   `scripts/wave-driver.mjs` holds the decisions (frontier, cap, log fold, halt
   rule, fast-forward permission, digest) as pure functions;
   `scripts/wave.mjs` is the git and process edge over them.

First outing is a throwaway: six to eight tasks over three waves on a scaffold
nobody cares about, run overnight to find what breaks at 3am before a hundred
tasks do.

## Open

- Deriving `allowedPaths` on the epic path (§6).
- Graph metrics for the wave plan review. `graphMetrics` (`epic-spec.mjs`) reads
  an `afk:` block keyed by issue numbers and sorts by `byIssueNumber`; a task
  directory is keyed by `task-NN-slug`. Now that the reviewer holds the whole
  graph, depth and blast radius would say something real, so this is worth
  porting — as its own change, over its own tests.
