# AGENTS.md — AFK Claude runner

AFK Claude is a package-free Node.js task runner. It schedules DAG tasks into
isolated Git worktrees, runs a fresh builder per task, verifies and commits task
branches, serializes fresh-agent merges into `main`, verifies again, and marks
tasks passed. See `README.md` for usage and `docs/epic-schema.md` for where the
task DAG comes from.

Three sources of truth, none overlapping: the epic and its child issues say WHAT
to build and in what order, `.afk-setup/config.yaml` says HOW this stack is verified,
and `.afk/state.json` says WHAT is happening right now. The runner reads the
config, receives the DAG in memory, and owns state.

The runner implementation lives here and never inside a consuming project. Each
project supplies its own `AGENTS.md` and `.afk-setup/config.yaml`.

This is the v2 runner; the epic `afk:` block schema is still version 1 and did
not change with it (`SPEC_VERSION` in `scripts/epic-spec.mjs` stays 1 —
`RUNNER_VERSION` in `scripts/lib.mjs` is the one that moved). `CHANGELOG.md` is
the breaking-change contract for consuming projects and takes precedence over any
description of runner behaviour written in a consuming project's own docs — over
those descriptions only, not over that project's coding standards or review rules.

## Launch status: pre-launch

**Status: pre-launch.** Set 2026-10-06. The owner changes this section, and
`launchStatus` in `.afk-setup/config.yaml`, on launch day; no agent does.

## Failure modes this runner has already paid for

Found while running this runner against a real project (Lumina, 24 tasks). Each
one cost real time or real work. They are recorded here so the next change to the
relevant file starts from the failure, not from scratch. Five are fixed and held
by a test; one is open.

**Fail direction.** Every guard here names which error is worse and fails the
safer way — and says so at the guard, so the choice is visible in review instead
of re-decided from scratch. A transport failure fails **open**: the verifier
report channel falls back to harvested prose when the agent's report file is
missing, because a lost report must not sink a real verdict. A judgment gate
fails **closed**: the plan reviewer refuses an epic on an `unsatisfied_criterion`
before a branch exists, because the cheap moment to stop bad work is before it
runs. A new guard that cannot say which way it fails is not finished.

**Numbering.** This document is the single owner of failure-mode numbers. A bare
"failure mode N" anywhere in the repo means the N in the list below; a reference
to any other document's list must say so ("this document's failure mode 4").

### 1. A failed integration deletes the user's untracked files — FIXED

`restoreMain` used `git clean -fdq -e .afk`, whose only exclusion was `.afk`, so
**every untracked file anywhere in the repo was destroyed** — draft specs,
scratch notes, un-added assets. Two task spec files under `planning/tasks/` were
deleted twice with no warning.

`runIntegration` now snapshots the untracked file list before the merger starts
and passes it to `restoreMain`, which removes only what the merger itself wrote
and returns that list for the log. A caller that cannot supply a snapshot (the
crash-recovery paths) removes nothing but Git's own `.orig`/`.rej` leftovers.

### 2. Unrelated untracked files fail an otherwise clean integration — FIXED

The gate treated any dirty tree as failure, so a merge whose conflicts were
resolved correctly and whose build exited 0 was marked `integration_failed`
because one unrelated untracked `.md` file sat in `planning/tasks/`. The reason
lived only in `verification.json`.

The dirty check now subtracts the pre-existing untracked snapshot, and every
rollback path carries a `failureReason` string that the runner log prints.

### 3. Two files both claimed to know a task's status — FIXED, differently

The scheduler reads lifecycle from `.afk/state.json`, and a task added to
`planning/manifest.json` afterwards had no entry, so it defaulted to pending and
**already-merged work was rebuilt** — one wasted builder each time. The original
fix was `reconcileWithManifest`: seed absent tasks, adopt a manifest `passed`
over a state `pending`, log every disagreement, and let an in-flight lifecycle
outrank the manifest.

That fix patched a disagreement the design should never have permitted. The
manifest is gone, and with it the second opinion: the spec (the DAG, held in
memory) carries no `status` at all, and `.afk/state.json` is the sole owner of
lifecycle. Nothing can now disagree with state, so there is nothing to adopt.

What holds the property today is `reconcileWithDag`, which seeds a state entry
for every DAG task that has none and reports every state entry the DAG no longer
names. A missing entry now genuinely means "never run", rather than "possibly
already passed, ask the other file". The adoption branch was deleted rather than
ported: keeping it would have required inventing a second status source to adopt
from.

Held by "the DAG's task list is folded into runtime state on restart" and
"reconciling never overwrites a lifecycle state already holds" in
`scripts/selftest.mjs`.

### 4. A hard quota is retried as if it were a soft rate limit — OPEN

`retryDelay` in `scripts/auto.mjs` falls back to `LIMIT_FALLBACK_MS` when the
provider sends no machine-readable `resetsAt`. Observed: a reply of
`You've hit your usage limit ... try again at Aug 16th` — six days out — put all
three builders into a 5-minute retry loop that could never succeed. Nothing in
the log distinguished this from an ordinary transient limit.

The 12h `LIMIT_TOTAL_MAX_MS` cap bounds the damage, so this now wastes a day
rather than a week. Fix direction: parse a reset timestamp out of the message
text when the structured field is absent, and halt the task with an explicit
"quota exhausted until <date>" error when the wait exceeds `LIMIT_MAX_SLEEP_MS`.

### 5. The merger agent has no prompt-size guard — FIXED

An integration whose diff included binary app-icon PNGs died with `Prompt is too
long · the request is ~1,344,071 tokens (limit 1,000,000)`. Both attempts failed
instantly and identically, then the task and every dependent was marked blocked.
The merge itself was trivial and completed by hand in minutes.

The merge prompt now uses a plain `git diff` — which renders a binary as one
"Binary files differ" line instead of the blob — and falls back to `--stat` plus
a pointer to the branch when the patch exceeds `DIFF_CHAR_BUDGET`.

### 6. In-repo worktrees poison the project's own checks — FIXED

Task worktrees lived at `.afk/worktrees/<id>`. A worktree is a full copy of the
repo, so any check that walks the tree walked them too: `eslint .` descended into
a lane, found a bundled vendor file inside it, and failed an integration whose
merge was perfect and whose own checks had passed. Gitignoring `.afk/` does not
help — eslint, ast-grep, prettier and vitest do not read `.gitignore`, and no
runner-side configuration fixes this for every project's toolchain.

Lanes now live outside the project entirely, at
`~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo>`, keyed by absolute path
so two checkouts of one repo never collide. `AFK_WORKTREE_ROOT` overrides it.
`.afk/` still holds state, logs, prompts, streams and recovery patches.

### 7. Tasks failing back to back march the whole plan into the same wall — FIXED

A broken baseline or a bad shared dependency fails every task for a reason no
builder can fix from inside its own scope. `MAX_CONSECUTIVE_FAILURES` stops the
scheduler from starting new builders after two terminal failures with no
intervening pass; in-flight work still drains and integrates. Any single pass
resets the count, so unrelated failures across a long plan never false-alarm.

The breaker could not tell an infra fault from a bad ticket, though. An expired
`claude` login made every builder exit non-zero in under two seconds; the
scheduler read each as a *task* failure, so two unauthenticated processes tripped
the breaker and good tickets were marked failed for a fault no builder could fix.

Two guards now distinguish the two. A preflight (`preflightBlockers`) runs before
the first builder is spawned: it probes that `claude` answers a trivial prompt
and that every `config.requiredEnv` secret is present, and fails to STDOUT with
`AUTO: not authenticated` / `AUTO: missing env <NAME>` — not just the background
log, the same trap as the base-branch guard in #8. And when the breaker does
trip, `looksLikeInfra` classifies the cluster: a run of sub-second failures
across *unrelated* tasks (the worker now records each builder's `durationMs`) is
reported as suspected-infra and the tickets are left `infra_failed`, not `failed`
— unproven, not bad, and re-runnable once the environment is fixed. A genuine
run of bad tickets still halts and marks them as before.

The same split holds for a secret store's login (#210): when any check runs
`infisical run`, preflight (and each baseline and integration gate) probes the
session non-interactively and refuses with "Infisical login expired: run
`infisical login --domain=<domain>`, then rerun.", and a gate red on "No valid
login session found" is classified infra, not the ticket.

### 8. The main-only guard refuses feature-branch checkouts, silently — FIXED

`auto.mjs` hard-required the current branch to be `main`, though nothing in the
merge logic does — `integrate.mjs` merges into whatever `HEAD` is. On a real
run, five `afk.mjs run` invocations against a feature-branch checkout exited
instantly with the refusal visible only in a background log; the work looked
hung, not rejected.

`--base=<branch>` now makes the checked-out branch the integration target
(branching, ancestry recovery, cleanliness checks and the merger prompt all
follow it), and the refusal message names the exact flag to pass.

### 9. A builder that exhausts its context loses its reasoning, not its diff — OPEN

`agent.timeoutMs` bounds a task in wall-clock, and nothing bounds it in tokens.
A long vendoring or migration task can fill its context window and die
mid-thought. The diff survives on disk; what is lost is everything the builder
learned and never wrote down — which source files it deliberately skipped, why
a workaround exists, which trap it already hit and solved. A successor re-derives
all of it, or worse, re-introduces the bug that the workaround fixes.

The counters needed to see this coming are already being written. Each turn in
`.afk/agents/<id>.jsonl` carries a `usage` object, and
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from the
**last** one is the live context size. Reading those numbers costs nothing and
does not require reading the transcript body.

Shape of the fix, if this is built into the runner:

- an `agent.contextRelayAt` fraction (0.45 is a reasonable default — a relay
  must leave the builder enough room to write a good handoff, which is itself
  expensive);
- the worker polls the counters and, on crossing, sends the builder a relay
  instruction rather than killing it;
- the builder brings the tree to a coherent state, commits, and writes
  `.afk-runs/<id>/HANDOFF.md`: acceptance criteria as done / in-progress /
  not-started, the exact next action, incomplete files by path, the current
  exported API, and every non-obvious decision;
- a fresh builder starts on the **same worktree and branch**, so the commits are
  inherited, with the handoff prepended to the original task prompt.

This is a relay, not a retry: the existing retry path deliberately starts from a
clean worktree with a fresh agent, which is right for a failed builder and wrong
for a full one.

Read the counters from inside the worker's existing supervision of its child, not
from a separate poller. The worker already owns the builder's PID and already
waits on it, so "has this builder finished?" is answerable directly. A poller
that infers liveness from the transcript instead has to guess a terminal marker,
and the retired `parallel-lanes` skill leaked nine such watchdogs doing exactly
that: it guessed `"type":"result"`, which the Agent tool's session JSONL never
writes, so the only exit path that could fire was a token threshold and every
lane that finished cleanly left its watcher polling — the oldest for six hours.
It orchestrated through the Agent tool and had no PID to hold. The runner does,
and must not throw that away.

Not built in yet. Until it is, a builder that runs out of context is lost work.

## Working on this runner

- `node afk.mjs selftest` exercises the runner without making real agent calls.
  Run it before and after any change to `scripts/`.
- A test that needs a port takes one from `freePort()` in `scripts/free-port.mjs`,
  which binds 0 and lets the kernel choose. Fourteen call sites used to compute
  one from `process.pid` with a per-file base and modulus; the ranges overlapped,
  and three files walked upward from their base onto a neighbour's port. The
  suite runs files concurrently, so it read as flake — one failure per run, a
  different test each time, every one passing in isolation. Three reds in four
  runs became zero in four. Where the call site is a synchronous `spawnSync`
  helper, hoist one port to a module-level constant: the collision was between
  files, never within one.
- What the suite structurally cannot check — whether Claude Code HONOURS the
  permission payload the runner builds — lives in `scripts/live-checks.mjs`,
  opt-in behind `AFK_LIVE=1` so the suite stays hermetic and offline. Re-run it
  after any change to a role's `permissions` block. `sandbox.filesystem.allowWrite`
  only ever WIDENS, so it can never deny a role its own working directory: what
  keeps `verifier` and `supervisor` off the repository they judge is that
  neither runs there (`roleCwd` in `scripts/worktree.mjs`; `docs/findings.md`
  1.3 and 3.2, and `docs/permissions.md` for the whole model). If this check
  goes red, do not make it pass by widening the sandbox.
- A lane's `verification.json` is INPUT, not build output, and it lives as a git
  note on the task commit (`refs/notes/afk-verification/<id>`, `readLaneVerification`
  in `scripts/worktree.mjs`), never as a file on the branch. `auto.mjs` reads it back
  on restart to decide whether a committed lane is safe to integrate. It used to be
  committed as `.afk-runs/<id>/verification.json`, which put runner bookkeeping under
  the consumer's `format:check` at integration on five epics across two repos (#106).
  What still reaches a branch under `.afk-runs/<id>/` is `ACTION-REQUIRED.md`, and
  `closeEpic` removes this epic's `.afk-runs/<id>/` and `.agents/evidence/<id>/` from
  the RUN branch in one final commit, after the verifier and the fix gate have read
  them (`scripts/sweep.mjs`). Task branches are never swept: an `incomplete` close
  leaves failed lanes alive and their salvage path still reads the note off them.
  The pre-rename `runs/` path is still recognised on read for history from before
  the move. A commit added on top of the builder's has no note, so the restart path
  rebuilds the lane; `afk salvage <id>` (`scripts/salvage.mjs`) re-runs the lane's
  checks at the new tip and attaches a fresh note there. Never copy the builder's
  note onto a commit it did not verify.
- Generated or provider-specific command strings belong in `buildAgentCommand`
  and its neighbours in `scripts/lib.mjs`, so the runner and its self-tests
  cannot drift apart.
- A gate is green on the commands that ran. A command it skipped on purpose (the
  #176 W3 Rust skip) goes on the gate event as `skipped`, and is never counted as
  a command that is missing (#177 F1).
- A file written by appending JSON lines is read as JSON lines (`readJsonl`),
  never with `JSON.parse` over the whole file: one line parses, two do not (#177 F2).
- A number built from several parts is null when any part is null (`allKnown`).
  Dropping the null parts and summing the rest reads unknown as zero (#177 F3).
- A sum of costs never writes `costOf(...) ?? 0`: an unpriced part makes the sum null, and a cumulative series stays null from that point on. The spend buckets in `collectUsage` read an unpriced message as $0 and drew a curve that understated the run (#273 F1).
- If a report number needs a value the measure rows do not hold, add the value to
  the row writer (`scripts/measure.mjs`). Do not ship the number as always null (#177 F4).
- A row-writer parameter added with a `null` default is tested through its production
  caller, not by passing the value by hand: `buildMergeRow` gained `state`, its test
  supplied it, and `merge.mjs` never did, so every real merge row was null (#292 F1).
- A batch of calls to a rate-limited API (Jev) runs through a bounded pool, never
  `Promise.all` over the whole list, and a skipped answer shows as `skipped` in any
  table a human reads, not as its fallback value: `jev-calibrate` sent 2xN requests
  at once and printed a 429 as `critical` (#292 F2).
- A safety check ported for one backend is gated on that backend unless the ticket
  asks for it everywhere. The Codex stop check ran on every Herdr lane, so a Claude
  lane that reported done but could not be proven stopped halted the epic, where
  main returned it as done (#292 closeout).
- A path matcher's tests cover every pattern shape the config accepts. A door or
  scope with no wildcard is a directory too, and a file inside it must match;
  `doorHit` failed open on `supabase/migrations/001.sql` (#190 F1).
- A constant nothing reads is deleted, not exported for later (#190 F3).
- Once a run has passed preflight, a side surface (the dashboard) that fails to
  start is a warning, not an exit. A server's startup warm-up never does
  synchronous work sized by the machine (a scan of every transcript) on the
  thread that answers its health check.
- A server listens on the host its health probe dials. On macOS a `::` bind
  succeeds beside another process on `127.0.0.1:<port>`, so the probe reached
  that process and a taken port read as a `/health` timeout (#277). Its printed
  URL names that same host, never `localhost`: `localhost` resolves to ::1 first,
  and with a process on `::` at the port a `localhost` link opened that process.
  The probe opens a fresh connection each time (`agent: false`): a kept-alive
  socket to that process outlived the dashboard's bind (#277).
- Making a component optional means finding every reader that took its
  presence as "the run is up" and giving them a signal of their own: `afk start`
  and the hub both keyed on `state.dashboard` (#277). Every exit clears that
  signal, early refusals included (the Infisical refusal left it set, so a dead
  run read as up), and every reader of the old status learns the new one (the
  check-in's stall check knew only "running") (#277).
- Two readers of one question share one predicate. The hub kept its own copy
  of "has an open gate" and missed the `gate: before` gates the check-in's
  `openGates` counts; clearing `state.dashboard` also dropped closed runs from
  `listRuns`, so the artifact's 24 h closed card worked only in a test that
  hand-built `closedAt` (#273). A drawer reads an object field by its parts:
  `esc(run.fatal)` printed `[object Object]` on the artifact (#273).
- A change that adds a validate error, a config key, an `afk:` key, a flag or a
  file the runner writes outside the repo adds its CHANGELOG.md line in the same
  change, even when CHANGELOG.md is outside the ticket's allowed paths (#190 F4).
- A guardrail that matches evidence against a list fails when the list is empty.
  Zero steps matching zero checklist lines is no evidence; `walkthrough` passed a
  gate issue with no `- [ ]` line (#186 F1).
- A `run` that returns a file's bytes passes a `maxBuffer`, and its caller checks
  `result.error` before it reads `status`. The 1 MB default reported every real
  screenshot as "a new baseline" (#186 F2).
- A ticket that rewrites another ticket's test file keeps every test the earlier
  ticket's criteria name. #189 replaced `scripts/merge.test.mjs` and dropped #187's
  no-PR test and its read allowlist (#186 F5).
- An `Edit(...)` or `Read(...)` deny on a role that renders a sandbox also binds
  its sandboxed `Bash`: Claude Code merges them into `filesystem.denyWrite` and
  `denyRead`. Check what the role's shell must reach before adding one. A
  project-root `Edit` deny broke git in every linked worktree, and a
  `~/.infisical` `Read` deny broke offline `infisical run` (#204).
- A reader of a cos store event re-checks its payload against the schema its
  writer used; the store checks only `ts` and `kind`. A hub section reads its
  files fail-soft and renders inside a try that prints one line, so one bad
  line never turns the page into a 500 (#269).
- A span read from a log opens only on the Runner line that starts it, never on
  the first line in the reader's window: a log adopted mid-epic otherwise draws
  a span that never closes (#269).
