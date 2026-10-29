# Runbook

What to do when a run goes wrong, organised by what you actually see at 2am
rather than by which script is at fault. Find the symptom, read what it means,
run the command.

The vocabulary — lane, worktree, gate, integration queue — is defined in
[docs/glossary.md](glossary.md). Everything here uses it. "Shape" is not in the
glossary; entry 7 defines it where it is used.

Entries 1–7 and 9 are symptoms. Entry 8 is a habit: read it before you re-run anything. Entry 13 is a procedure: merging with `afk merge`.

Two rules that apply to every entry:

- **`afk` in the commands below is `node /path/to/afk-claude/afk.mjs`**, run from
  the project root. Every command named here appears in `afk --help`; nothing in
  this file is aspirational.
- **`afk reset` refuses while the runner holds the lock.** It exits with
  `Cannot reset tasks while` afk auto `owns runtime state. Stop it first.` Stop
  the runner before any recovery that resets a task.

Start every diagnosis the same way — it costs nothing and names the lifecycle
state the rest of this file keys off:

```bash
afk status
```

---

## 1. A lane has been "running" for hours and nothing is changing

**What it means.** The lane's agent is alive but not progressing, or it is dead
and the runner has not noticed yet. `agent.timeoutMs` bounds a lane in
wall-clock, so a truly stuck lane does eventually die — but that bound can be
hours, and it is not a substitute for looking.

The runner's own detector is the heartbeat: a lane that writes nothing to
`agent-auto.log` past the stall threshold is reported as `Runner looks stalled`.

**Do this.**

```bash
afk stats <id>          # tokens, turns and the last tool call for that lane
afk heartbeat           # one-shot health verdict for this project
```

`afk stats <id>` reads `.afk/agents/<id>.jsonl` while the lane is still in
flight. A last action from twenty minutes ago with no growth is a hang; a
growing context with the last turns near the limit is a lane about to die of
context exhaustion, which the runner does not yet relay out of (`AGENTS.md`
failure mode 9).

If it is genuinely stuck, stop the runner, then:

```bash
afk reset <id>
afk epic <n>            # or: afk auto --dag=<path>
```

The reset returns the task to `pending` and the restart rebuilds it in a clean
worktree. Nothing in the lane's tree is preserved by this, so look at
`~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo>` first if you think there
is work worth keeping.

Run `afk heartbeat --watch` for the next run so the stall pages you instead of
you discovering it.

---

## 2. A lane died to "You've hit your session limit", with uncommitted work

**What it means.** The lane's agent process was killed by the provider, not by
the runner. The worktree survives with a full, uncommitted tree and no commit —
the runner leaves it exactly as the agent left it. Nothing is lost; it is just
somewhere nobody thinks to look.

Distinguish this from an ordinary rate limit. A *soft* limit puts the task back
to `pending` with a `retryAt` and the log says `rate-limited; retrying
independently in Nm` — that one needs nothing from you but patience, up to a 12h
cap after which the task is marked `failed`.

**Do this.** Look at the tree before you reset anything:

```bash
git -C ~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo> status
git -C ~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo> diff
afk stats <id>          # the lane's last line usually says exactly where it was
```

If the work is nearly complete, finish it by hand in that worktree, commit on
`afk/task-<id>`, and let the run pick it up. If it is not, stop the
runner and start the lane over:

```bash
afk reset <id>
afk epic <n>
```

Beware the second-order damage this failure causes: a lane killed mid-edit can
leave a half-wired change that the suite catches but a diff read does not. Run
the project's checks in the worktree before deciding the work is salvageable.

---

## 3. An integration failed on a conflict

**What it means.** The task's own checks passed in its worktree, but the merge
into the base branch did not. The runner restored the base branch to its
recorded SHA, kept the task branch and worktree, and retried once with a fresh
merger. The task's lifecycle is `integration_failed`. **Integration failure
never deletes the completed task branch** — the work is safe on
`afk/task-<id>`.

Only one integration runs at a time, so a stuck one stalls the whole queue
behind it.

**Do this.** Read the reason first; it is written down, not only in the log:

```bash
cat .afk/runs/<id>/integration-<attempt>/verification.json
afk supervise integration_failed --task=<id> --dag=<path>
```

`afk supervise` is read-only and advisory: it reads the failure and proposes
`afk` commands. It changes nothing and the runner ignores it — use it for the
reading, not the authority.

Then either merge by hand on the base branch and let the run continue, or,
having stopped the runner, requeue it:

```bash
afk reset <id>
afk epic <n>
```

Two known non-conflict causes look identical from `afk status`: an unrelated
untracked file used to fail a clean merge (fixed — the dirty check now subtracts
a pre-merge snapshot), and a diff containing binary blobs once blew the merger's
prompt budget. If both attempts failed instantly and identically, suspect the
second and check what the branch touches.

---

## 4. Every lane dies in seconds and the log blames the tickets

**What it means.** The agent CLI's login expired mid-run. It is the failure the
runner has been burned by most: an expired session makes every builder exit
non-zero in about two seconds, which reads exactly like a run of bad tickets.

Two guards separate them now. When the transcript proves the login died, the
runner marks the task `infra_failed` — unproven, not bad — resets its attempt
count and halts:

```
AUTO: builder <id> died on an expired claude login; scheduling no further builders.
```

When it cannot prove it but the shape looks wrong (several unrelated tasks
failing near-instantly and uniformly), it says `looks like infra, not tickets`
and leaves the tickets unmarked.

Either way the tickets are **not** poisoned, and `infra_failed` tasks are
re-runnable without a reset.

**Do this.**

```bash
claude auth login       # afk-codex: codex login
afk epic <n>            # or: afk auto --dag=<path>
```

The preflight probes the login and every `requiredEnv` secret before the first
builder is spawned, so a still-dead login fails to STDOUT with
`AUTO: not authenticated — run \`claude auth login\`` rather than costing you
another circuit-breaker trip.

**Which login.** The probe runs whichever backend the executable you typed
selected, and names that backend's remedy: `afk` says `claude auth login`,
`afk-codex` says `codex login`. `codex auth login` is not a command — the verbs
are `codex login` and `codex logout`, without the `auth`. If a refusal names a
CLI you did not run, you are in the wrong executable, not the wrong login.

If the log claims an auth death but `claude -p` answers fine, do not trust the
claim blindly — a merger once bound to the operator's own Claude Code session in
the repo root and read a sentence from a human conversation as the login
expiring. That binding is fixed, but the lesson stands: verify the login
independently before you go looking for a fault that is not there.

---

## 4b. A Codex run refuses at once, or every lane dies without saying why

**What it means.** Two Codex-specific shapes, with opposite causes.

**`afk-codex` exits immediately: "supports only the direct runtime".** You asked
for `--runtime=herdr`, or `agent.runtime: herdr` is in the committed
`.afk-setup/config.yaml`. This is a refusal, not a failure, and it lands before
the plan review, the branch and any model call — nothing was created and nothing
was billed. The herdr runtime drives an interactive agent in a pane and reads
the lane's report out of that pane's scrollback; `codex exec --json` is a
non-interactive pipe with neither.

```bash
afk-codex epic <n> --runtime=direct     # or drop the flag; direct is the default
afk epic <n> --runtime=herdr            # herdr, on Claude, unchanged
```

A config key is refused the same way, and a `--runtime=direct` flag beats it.

**A lane produced nothing and the log has no reason.** Read the lane's stream
before theorising:

```bash
afk stats <id>
tail -5 .afk/runs/<id>/builder-*/stream.jsonl
```

A Codex stream is one JSON object per line with the CLI's own stderr interleaved
(the runner redirects `2>&1`, deliberately — those lines are where the transport
failures show up). Three endings, three different remedies:

| Last events | Means | Do this |
|---|---|---|
| `{"type":"error","message":"You've hit your usage limit …"}` then `turn.failed` | a quota rejection | wait — the reset is a wall-clock time inside that message and is not machine-readable anywhere, so the runner cannot schedule around it (`AGENTS.md` failure mode 4) |
| repeated `401 Unauthorized` / `Missing bearer` then `turn.failed` | no credentials | `codex login` |
| `turn.started` with no `turn.completed` or `turn.failed` | the stream was cut off | the lane was killed — a deadline or a signal, not the ticket |

Captured examples of all three are in
[`scripts/fixtures/codex/`](../scripts/fixtures/codex/README.md), and
`scripts/live-checks.test.mjs` asserts the runner reads each one correctly.

To check the CLI itself rather than the run:

```bash
codex login status
AFK_LIVE=1 node scripts/live-checks.mjs --check=codex
```

---

## 4c. The run refuses before any lane: a probe, the herdr server, or a held port

**What it means.** The preflight found a host fault before anything was spent on
lanes. It checks the agent login, every `requiredEnv` secret, each command under
`preflight.probes` in `.afk-setup/config.yaml`, the herdr server when the
runtime is herdr, and each port `preflight.ports` prints for the epic checkout.
Each blocker is one line, then the run stops:

```
AUTO: preflight "container runtime is up" failed (exit 1): `docker info`
    Cannot connect to the Docker daemon at unix:///var/run/docker.sock
AUTO: herdr server is not running — start it with `herdr`, then rerun
AUTO: port 4173 (for /path/to/checkout) is held by pid 81234 (node)
AUTO: preflight failed; no builders were spawned. Fix the above, then rerun.
```

**Do this.** Fix what the line names: start the container runtime, start herdr,
or stop the process holding the port (`ps -p <pid>` first: it may be another
run's gate). The runner never kills it for you. Then check again without
launching, and launch only when it says ok:

```bash
afk preflight            # add --runtime=herdr if you will launch with it
afk epic <n>
```

`afk preflight` exits 1 on any blocker, so an Orchestrator can run it before a
launch and before every relaunch. A relaunch on the same path uses the same
derived ports, which is how one collision cost 85 minutes twice.

### Is the base green? Run the whole baseline, not a check you picked

If you want to know before a launch whether the base will pass the run's
baseline gate, run the gate itself:

```bash
afk preflight --baseline              # on main
afk preflight --baseline --base=dev   # on another base
```

It runs every `baselineChecks` command (else `defaultChecks`), the list the
gate reads, on the base branch in a throwaway worktree with `worktreeSetup`
applied. It takes the machine-wide gate lock and waits for a quiet host the way
the gate does, so it never overlaps another epic's gate. It probes the
Infisical session first when a check calls `infisical run`. Unlike the gate, it
does not stop at the first red: every command runs, and each prints `pass` or
`FAIL` with the last 20 lines of its output. It exits 1 if any command fails.

```
PREFLIGHT: baseline pass: `npm run test:e2e`
PREFLIGHT: baseline FAIL (exit 1): `npm run test:db`
    Error: remaining connection slots are reserved (max 512)
PREFLIGHT: baseline red — 1 of 2 baselineChecks command(s) failed on a clean worktree of `main` @ 3f2a9c1e04b7 (gitignored files not listed in worktreeSetup.copy are absent).
```

A red here is proven on a fresh worktree, not in the checkout the gate runs
in. The gate runs in the epic's own checkout, where a gitignored `.env`,
generated files or caches may exist. If a check needs one, list it under
`worktreeSetup.copy` (or `link`) and rerun. If `worktreeSetup` itself fails,
the worktree is removed and the setup's own error is printed.

Before harbour#583 the base was checked by hand with `test:e2e` alone. It was
green, `test:db` was red on `main` as well, and the epic launched five times.
`--cos` does not imply `--baseline`: a baseline costs minutes per repo under the
gate lock, and `--cos` runs from no particular checkout. Run `--baseline` in
each epic's checkout before its launch.

---

## 4d. A task routed to Codex ran on Claude, or a Codex lane misbehaves in Herdr

A task's builder can run on Codex when `.afk/state.json` carries a routing
assignment for it (`builderRouting.assignments.<id>.preferredBackend: codex`).
Every other role stays on Claude. `afk status` prints one routing row per task:

```
builder routing (preferred → actual · reason):
  #401: codex/gpt-5.6-luna → claude/claude-opus-5-5 · Codex reported its usage limit exhausted; retried on Claude Opus
```

The reason says why a Codex task ran on Claude Opus:

- **`quota-axi … ; this dispatch only`**: the quota read failed, timed out or
  came back malformed. Only that lane fell back. The next Codex lane reads again.
- **`Codex reported its usage limit exhausted`** or **`Codex login failed`**:
  the Codex lane ran and failed, and its retry went to Claude Opus. The retry
  spends the ordinary `maxBuilderRetries` budget. For a login failure, run
  `codex login`.

A bare `429` / "too many requests" from Codex is a transient throttle. It waits
like any rate limit and retries on Codex.

`AUTO: builder <id> was not retried because its Herdr agent is still running`
means the runner could not prove the lane's previous agent stopped, so it left
the worktree as it was. Stop that pane (`herdr agent get <pane>`, then Ctrl-C
it), then `afk reset <id>` and rerun.

After changing Herdr's Codex launch or lifecycle, run the paid check by hand
with both Herdr and Codex logged in:

```sh
AFK_LIVE=1 node scripts/live-checks.mjs --check=herdr-codex
```

It opens a disposable lane as a real interactive Codex pane and asks it to
write one proof file. It records the pane output, the report status, and the
resolved Codex model and effort in `.afk/live-checks/`. Then it closes the
lane's Herdr workspace and removes the probe worktrees. The JSON evidence path
is printed at the end. `afk selftest` does not run it; its setup and cleanup are
covered offline in `scripts/live-checks.test.mjs`.

## 4e. Which tier a ticket got, and why the router was skipped

At launch the runner asks Jev about each ticket and writes a tier into
`builderRouting.assignments.<id>`. `afk status` shows it on the routing row:

```
builder routing (preferred → actual · reason):
  #501: routine tier → codex/gpt-6.1-sol · routine: codex has the most quota (70%) · tier routine · pattern_named 0.90, concrete_criteria 0.85, scope 0 (confidence 0.88) · jev jev-1.14.2
  #502: critical tier → claude/claude-opus-5-5 · critical: sensitive 0.91, scope 1 (confidence 0.80) · tier critical · …
```

- **`tier router skipped: no TYPESAFE_API_KEY …`** (once, at the top): the run
  had no key, so every lane built as it did before routing. Export the key and
  start a new epic; a resumed run keeps the decisions it already stored.
- **`router skipped: Jev answered 429 …`** on one row: that ticket is
  `critical`. Nothing to do; it costs Opus tokens, not correctness.
- **`routine, but no provider has quota`**: the lane's quota read found
  neither Claude nor Codex usable, so it ran on Opus.
- A routine task's retry always runs on `critical`.

The models per tier live in `DEFAULT_TIERS` (scripts/builder-routing.mjs).
Override them in `.afk-setup/config.yaml`:

```yaml
routing:
  tiers:
    routine:
      - claude/claude-sonnet-5-5
      - codex/gpt-6.1-sol@medium
```

To recalibrate the thresholds (`TIER_THRESHOLDS` in scripts/tier-router.mjs)
against tickets with known outcomes, on a machine with the key and `gh`:

```sh
node scripts/jev-calibrate.mjs --issues issues.json --out calibration.md
```

`issues.json` is `[{"repo": "owner/name", "number": 123, "outcome": "first_try" | "retried" | "needed_human"}]`.
The report prints the Jev version to pin as `JEV_MODEL`, and lists the
tickets whose tier changed when the Score's levels were reversed.

## 5. The dashboard port, and "already serving a different project"

**What it means.** The dashboard's default port is derived from the checkout's
absolute path — a hash into `4100-4499` — so two checkouts of one project never
land on the same port, and one checkout lands on the same port every run. If the
derived port is held by another project, `afk epic` scans upward for the next
free one automatically. You should never see a collision on the default path.

There are two ways to still see one:

- **You set `PORT=` yourself.** An explicit port wins outright and is never
  scanned past — if it is taken, the run refuses with the owner's path and the
  remedy on STDOUT, before the plan review and before the branch. Drop the `PORT=`
  and let the derivation pick, or pick a free one.
- **Twenty consecutive ports are taken.** The message names the range. That is
  twenty live dashboards; find the strays and stop them.

Either way the epic is not affected once it has passed preflight: if the
dashboard then fails to start, or starts and does not answer `/health` within
3 s, the run logs `AUTO: warning: the dashboard did not start; carrying on
without it.` with the reason and `.afk/dashboard.log`, and goes on to the
baseline without a dashboard.

**Do this.** Ask a port who owns it — the health endpoint names the project it
is serving:

```bash
curl -s http://127.0.0.1:4137/health
```

Let the runner choose, which is the normal case:

```bash
afk epic <n>            # derives its own port, scans past anything taken
```

The port check and the clean-tree check both run in `afk epic`'s preflight, in
the same phase as validation — before the plan review is paid for, before the
feature branch exists, before `.afk/state.json` is written. A refusal there
leaves the repository exactly as it was and there is nothing to clean up.

---

## 6. The run stopped starting new lanes but did not exit

**What it means.** The circuit breaker halted the scheduler. Two consecutive
terminal failures with no intervening pass stop new builders from starting;
work already in flight still drains and integrates, which is why the process is
still alive.

The log line says which of two verdicts it reached:

- `N tasks failed in a row … Likely a shared cause, not the tasks.` — the
  tickets are marked `failed`. A broken baseline or a bad shared dependency
  fails every task for a reason no lane can fix from inside its own scope.
- `looks like infra, not tickets` — the tickets are left unmarked. See entry 4.

A single pass resets the count, so unrelated failures spread across a long plan
never trip it.

**Do this.** Find the shared cause before restarting anything, or the restart
marches into the same wall:

```bash
afk status
afk supervise lane_failed --task=<id> --dag=<path>
afk selftest
```

Fix the baseline, then stop the runner, reset what was wrongly marked, and
restart:

```bash
afk reset <id> [<id>...]
afk epic <n>
```

If the plan stopped because a human gate was reached rather than because
anything failed, that is not this — `afk status` shows the task as
`pending (gated)`. Release it explicitly:

```bash
afk epic <n> --task=<id>            # epic path
afk run --task=<id> --dag=<path>    # DAG path
```

---

## 7. A restart is refused: "the epic's graph has changed since this run started"

**What it means.** The shape guard. The epic is never cached — a restart
re-fetches it — so a child issue closed, unlinked, re-pointed or newly gated
while the run was in flight produces a different graph from the one the run
started on. Continuing would silently orphan a lane, so the runner refuses and
names what moved:

```
  - task 207 is no longer in the epic — it was closed, unlinked, or removed from the `afk:` block mid-run
```

Shape is **ids, edges and gates only**. A retitled issue is not a shape change
and never refuses a restart. A sibling refusal has the same cause and the same
cure: restarting with a different `--instructions=` string is a mid-run spec
change and is refused too.

**Do this.** Decide which graph you want. To keep the current run, put the epic
back the way it was — reopen the closed child issue, restore the `afk:` block —
and restart unchanged:

```bash
afk validate <n>        # confirms the shape before you pay for anything
afk epic <n>
```

To adopt the new graph instead, you must abandon the old run: finish or reset
its tasks, archive it, and start again. That is deliberate — there is no flag
that waves the guard through, because the whole point of the refusal is that the
runner cannot know which lanes the new shape invalidates.

```bash
afk reset all
afk archive <n>         # moves state.json AND runs/, verifier/, fixer/,
                        # reflect/, recovery/, supervisor/, plan-review/,
                        # epic-close/ to .afk/archive/epic-<n>/
afk epic <n>
```

Use `afk archive`, not `rm .afk/state.json`. A run writes nine directories under
`.afk/` and removing the state file alone leaves the other eight for the next
epic to inherit under its own paths. `afk archive` refuses a half-failed epic and
names the unfinished tasks; `--force` overrides, and it moves rather than deletes.

Archiving loses the run's lifecycle, not its work: task branches, worktrees and
`.afk/recovery/*.patch` all survive it.

---

## 8. A lane failed and you are about to re-run it from scratch

**What it means.** Usually nothing is wrong. It is the reflex that is wrong.

A failed lane has not thrown its work away, because the runner is built not to.
A failed integration keeps the task branch and its worktree. An interrupted run
saves unverified changes as patches under `.afk/recovery/` before it rebuilds
anything. A rollback preserves untracked files it did not create. A builder that
committed has its commits reset `--mixed`, so the work survives in the tree even
though the history does not.

So a re-run from scratch does not recover the lane. It discards a nearly
finished implementation that is sitting on disk and pays for it again.

**Do this. Finish the work by hand.** Re-apply what the runner reverted, fix
what the report or the review found, run the lane's checks yourself, and write
`.afk-runs/<id>/report.md` if the agent never got that far. Then mark it:

```bash
afk status                       # which lifecycle it actually stopped in
ls .afk/recovery/                # patches from an interrupted run
git log --oneline <branch>       # the task branch is still there
```

Re-run only when the worktree really is empty — a lane that died in its first
seconds to an expired login or a missing secret has nothing to salvage, and
entries 2 and 4 cover those.

**Then check the one thing no gate checks.** Diff `producedFiles` in
`.afk/runs/<id>/builder-<n>/verification.json` (or `git notes --ref=afk-verification/<id>
show <branch>`, the copy on the task commit) against what the ticket actually asked for, every
time. Builders have repeatedly deleted a *previous* ticket's committed fixes —
one task removed another's props twice, the second time after the spec
explicitly forbade it. Allowed paths are advisory and would not have caught it;
the checks pass because the tree still compiles; the integrator sees a coherent
diff. Nothing in the runner catches this, and that is why it is the last step
here rather than a gate.

---

## 9. `afk status` says "orchestrator exited at <time>: <message>"

**What it means.** The scheduler threw and the run is over. The lanes it owned
were sent SIGTERM (a lane whose pid was never recorded can survive; find it by
cwd, see `docs/failure-modes.md` R11), and nothing will integrate or start
until you restart. In-flight rows show `running (orchestrator exited)` rather
than `running`. The message is the first line of the error; the full stack is
the `AUTO: fatal —` line in `.afk/agent-auto.log`.

Some things that used to end a run no longer do, so if you see one of them it
is in the lane, not here:

- A full disk in a lane's bootstrap or record write leaves that task
  `infra_failed` with a `diskFull` record, and two in a row halt new lanes
  (entry 6). Free space, then `afk reset <id>`.
- A full disk during an integration leaves the lane `ready_to_integrate`
  with a `diskFull` record, and the base branch restored. Free space and
  restart; the lane is queued again.
- A worktree that would not delete after a passed merge is a
  `cleanupWarning` on the task, retried at the next start.
- A run that starts below `diskFloorBytes` free refuses with `AUTO: disk:`
  before the baseline. Free space and start again.

**Do this.** Read the cause, fix it if it is config, then restart. A restart
clears the record once it gets past its baseline; one that is refused keeps it.

**With `autoRestart: N` set** (#146), `afk epic` has already restarted itself
up to N times, and `afk status` says so under the fatal line:

```
orchestrator exited at 2026-09-28T05:11:59.162Z: TypeError: Cannot read properties of undefined (reading 'dirty')
restarted after fatal (2 of 2)
auto-restart stopped: the auto-restart budget is spent (2 of 2)
```

It stops for one of these reasons, each logged as `AUTO: not restarting after
the fatal — <reason>` in `.afk/agent-auto.log`: the budget is spent; the new
fatal repeated the one the last restart was for; the lock was still held;
state could not be read or written (a full disk); a signal arrived during the
hand-over; or the restarted process refused to start (a dirty tree, a failed
preflight, its predecessor still alive after 60 seconds). The last one also
sends the `orchestrator_fatal` notification, since nothing else would.

"Repeated" does not compare the messages raw. It takes out paths, anything
that looks like a commit sha, and every number (timestamps, pids, ports,
durations, attempt counts, task ids), then compares what is left: the wording,
error codes and config keys. A raw comparison let the same wall through
whenever a pid or a temp-file name differed, which is every time. The cost is
that two faults differing only in a number count as one, so the chain can stop
one restart early. A fatal that repeats is almost always config or disk, so
read it before you restart.

Each restart is a new detached process with stdin closed and its output in
`.afk/restart-<k>.log`, named in the restart line. The old one spawns it and
exits within two seconds, and the new one waits for the old pid to be gone
before it starts. A Ctrl-C (or SIGTERM, SIGHUP) in those two seconds is passed
on to the new process and recorded as the stop reason. After that, stop a
restarted run with `kill` on the `orchestratorPid` in `.afk/state.json`;
Ctrl-C in the launching terminal does not reach it. A fatal with no restart
exits within the same two seconds, instead of lingering as #136's did.

The launching terminal gets only the first hand-over line. Follow a restarted
run with `tail -f .afk/restart-<k>.log`; each restart's file starts empty and
moves with the epic when it is archived.

The count covers one launch. A restart keeps counting, and an `afk epic` you
type starts again from zero once it gets past its baseline. A restarted run
that got past its baseline shows `restarted once after a fatal at <time>, then
ran on` instead of the count.

```bash
afk status
grep 'AUTO: fatal' .afk/agent-auto.log
afk epic <n>            # same flags as before
```

## 10. `afk status` says "waiting for gate lock held by <project> #<epic>"

**What it means.** A full gate in this epic (the baseline, an integration's
post-merge checks, or the closeout fix gate) is parked behind another epic's
full gate on this machine (#178). One full gate runs at a time across every
epic and repo, through the lock file `~/.afk-claude/gate.lock`. Lane checks do
not take the lock, so lanes keep running. The log says the same thing, once on
entry and then every 30 seconds:

```
AUTO: integration gate waiting for the gate lock held by atlas-workspace #928 (baseline, pid 41234, since 2026-10-05T09:12:03.000Z).
```

The wait does not count against the gate's own time bound
(`baselineTimeoutMs`, `checkTimeoutMs`); those start once the gate holds the
lock. The gate-event line records the wait as `lockWaitS`.

**Do this.** Usually nothing: the holder's own time bound kills a hung check,
and the lock is released when its gate ends, however it ends. A holder that
died (crash, `kill -9`) is detected by pid and taken over by the next waiter,
and so is one whose pid now belongs to a process that started later (pid reuse
after a crash): the lock records the holder's start time.

- If the holder is alive but should not be (a run you meant to stop), stop that
  run. Do not delete `gate.lock` under a live holder: its gate is still running.
- If the lock file names a pid that is now a different, unrelated process and
  the wait does not end (a lock written before the start time was recorded, or
  `ps` unavailable), delete `~/.afk-claude/gate.lock`.
- If this machine does not need gates serialized, set `gateLock: false` in each
  project's `.afk-setup/config.yaml`. The default is on.

Once it holds the lock, a baseline also waits for the 1-minute load to fall
under 20 (#223), because the lock cannot hold back another epic's lanes:

```
AUTO: baseline gate waiting for a quiet host: load 24.0, threshold 20. Set `quietHostLoad: false` to turn this off.
```

It gives up after 30 minutes and runs anyway. Set `quietHostLoad: <n>` to move
the threshold, or `false` to turn the wait off.

## 11. `afk status` says "gate rerun · baseline · … · environment (high)"

**What it means.** A baseline went red, and its output had a line that names
the machine rather than the code: a held port (`EADDRINUSE`), a refused local
connection (`ECONNREFUSED`), a schema cache not ready, a GitHub 5xx, or a test
that timed out waiting in a file the epic's diff does not touch (#179, #223; a
timeout in a test the epic changed halts with no rerun). The rerun waits for a
quiet host first. The runner ran the whole baseline once more, through the gate
lock like any gate, on the same tree. `passed on rerun` means the run went on;
`red again` means it halted as before. A post-merge check that failed and was
re-run (#176) is listed the same way, as `post-merge #<task>`, with the reading
of its first red. `.afk/state.json` holds the entries under `gateReruns`.

A red with no such line (`unclear`), or with a broken assertion or compile error
(`ticket`), halts with no rerun. A command killed at its own time bound is never
rerun. The rerun changes nothing in the tree, and there is never a second one.

**Do this.** If it says `red again`, read the evidence on the line: the same
sign twice usually means the conflict is still there (a dev server another run
left behind, a database not started). Fix that, then restart. If the evidence
names something your code does on purpose, the reading was wrong and cost one
extra gate run; nothing else.

## 12. `afk status` says "epic: not_delivered … push refused: …"

**What it means.** Every task passed and the epic closed, but its branch never
reached the remote, so there is no PR (#179). The text after `push refused:`
(or `PR create failed:`) is the refusing step's own output, usually a pre-push
hook's message. Before the epic closes the same failure shows as `PR not
delivered · push refused at <time>: <message>` (or `PR create failed at …`). `.afk/state.json` holds it
under `prDelivery`; the next push and PR render that land clear it.

**Do this.** Fix what the hook complained about on the epic branch, then run
`afk finish --push`. It pushes the branch, opens or refreshes the PR from run
state whatever the `pr:` mode, and clears `prDelivery` once both land. A failed
PR-body refresh on a PR that already exists does not count as undelivered.

## 13. Merging an epic's PR with `afk merge`

**What it is.** `afk merge <epic>` merges the epic's PR only when every
guardrail passes (#189). It reads the run state, so run it **before** `afk
finish`, which removes that state. For a `--worktree` run, point `--root` at
the epic worktree.

**Do this.**

1. Run `afk merge <epic> --root=<run root> --dry-run`. It prints one
   `PASS|FAIL|WAIT <name>: <evidence>` line per guardrail and the merge
   command, and writes nothing.
2. Read the lines. A `FAIL` names what to fix. A `WAIT` is usually a CI check
   that is still running.
3. Run `afk merge <epic> --root=<run root>`. If any guardrail is not `PASS`,
   it posts one comment on the PR and exits 1. It does not post the same
   comment twice. If all pass, it merges, runs the health probe and lands the
   PR: the epic and its passed tasks closed, the remote branch deleted, lanes
   pruned, and a clean epic worktree removed.
4. If it says `WAIT merge-lock`, another project's merge is running. Wait for
   it to finish, then run the command again.

**To merge while you are away**, launch it detached. It polls every five
minutes while only `WAIT` guardrails stand, for 8 hours by default. A `FAIL`
stops it at once:

```sh
nohup afk merge <epic> --root=<run root> --wait > ~/.afk-claude/merge-<epic>.log 2>&1 &
```

**If the probe is red (exit 2).** The PR is merged and nothing is landed: no
issue closed, no branch deleted. The PR has a "merged; health probe red"
comment with the probe's last output lines. The verb never reverts.

1. Read the probe output in the comment or the log.
2. If the base branch is broken, revert with the command the verb printed:
   `git revert -m 1 <merge sha>` for a merge commit, or `git revert <merge sha>`
   for a squash or rebase. Push it through your usual review.
3. If the probe itself was wrong (flaky, or it checked the wrong thing), fix
   the probe. Then land by hand: close the issues, delete the branch, and run
   `afk finish` in the run root.
