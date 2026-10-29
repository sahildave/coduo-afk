# The first hour

The ordered checklist for a new project adopting this runner, from an empty
repo to a first epic. `docs/runbook.md` starts from the assumption that a run
already exists; this file is what you do before that is true.

The vocabulary — epic, task, lane, worktree, gate, integration queue — is
defined in [docs/glossary.md](glossary.md).

Two rules that apply to every step:

- **`afk` below is `node /path/to/afk-claude/afk.mjs`**, run from the project
  root. Every command named here appears in `afk --help`; nothing in this file
  is aspirational.
- **Nothing of the runner is copied into the project.** The project supplies
  three things — `.afk-setup/config.yaml`, a `.gitignore` entry and its own
  `AGENTS.md` — and no runner implementation.

Work the steps in order. Steps 1–5 are local: they cost nothing and create
nothing outside the project. Step 9 is the first one that spends tokens and
writes Git history.

---

## 1. Check the preconditions

Node 20 or newer, Git with a `main` branch, the agent CLI on `PATH` and logged
in, and a clean checkout of the base branch. No `package.json` is required.

**Which CLI depends on which executable you will type**, and that is the only
thing that chooses it — there is no flag and no config key:

| Executable | CLI | Log in with | Check with |
|---|---|---|---|
| `afk` | `claude` | `claude auth login` | `claude -p 'reply OK'` |
| `afk-codex` | `codex` | `codex login` | `codex login status` |

Pick one now and use it for the whole epic. `.afk/state.json` does not record
which one started a run, so a restart with the other is not refused — it simply
dispatches everything still pending to the other provider.

If you are on `afk-codex`, know two things before you write the config:
`--runtime=herdr` is refused (Codex is direct-runtime only), and the model in
your `agent:` block is ignored in favour of a per-role tier —
`gpt-5.6-luna`/`max` for `implementer` and `reflector`, `gpt-5.6-sol`/`medium`
for every reviewing and merging role. README's "Two entry points" has the table
and the `roles.<name>.codex` key that moves a role between tiers.

Prove the runner itself works in this environment before blaming your config
for anything later:

```bash
afk selftest
```

This makes no agent calls, so a failure here is the runner or the Node version,
never your tickets.

## 2. Write `.afk-setup/config.yaml`

Repo-level, committed, and read-only to the runner — a run never writes to it.
It says HOW this stack is verified; the epic says what to build. The minimum
that will actually gate a run:

```yaml
defaultChecks: [npm run lint:check, npm run typecheck, npm test]
baselineChecks: []
worktreeSetup:
  link: []
  copy: []
  run: []
maxParallel: 5
agent:
  timeoutMs: 900000
  runtime: herdr
```

YAML rather than JSON for one reason: the file ships with every optional key
commented out, so you discover a setting by uncommenting a line instead of
reading this page. It is a strict subset — mappings, lists, scalars and
comments, no anchors and no block scalars — parsed by the same hand-written
parser the epic's `afk:` block uses, so the runner stays dependency-free.

- **`defaultChecks`** is the one field you cannot skip. A task with no `checks:`
  of its own and no `defaultChecks` to fall back on is a task nothing can gate,
  and `afk validate` refuses the whole run over it, by id. These commands run
  inside a task worktree, so they must pass from a fresh checkout.
- **`baselineChecks`** run before the work to establish that a failure is the
  lane's fault and not a broken tree you inherited.
- **`worktreeSetup`** matters more than it looks. A task worktree starts with
  dependencies, build caches and gitignored credentials **absent**, so if your
  checks need `node_modules` or a `.env.local`, `link`/`copy`/`run` them here or
  every lane fails identically for a reason no builder can fix. If a check
  creates something the runner cannot see — a per-lane simulator — `teardown`
  shuts it down when the lane is done and `finish` deletes it when the
  worktree is removed; both run with the lane as `$PWD`.
- **`maxParallel`** is a floor on concurrent lanes, not a cap: the runner raises
  it to the DAG's root width when that is wider, never above this machine's core
  count and never below what you set. The epic's own `max_parallel` is the hard
  cap and blocks the raise. Integration is serial regardless.
- **`diskPerLaneBytes`** and **`diskFloorBytes`** (optional) size the disk
  check that runs before the baseline. Below `maxParallel × diskPerLaneBytes`
  free on the lane worktree root's volume the run warns and continues; below
  `diskFloorBytes` it refuses. Both are plain byte counts (`15000000000`, not
  `14G`; a non-number refuses the run). Defaults are 2 GiB per lane and a 1 GiB floor,
  right for a Node project with linked `node_modules`. If every lane builds its
  own target directory, set the per-lane figure from `du -sh` of one: atlas's
  Rust target is 14 GB, so `maxParallel: 5` needs about 70 GB.
- **`autoRestart`** (optional, default `0`, off) is how many times `afk epic`
  relaunches itself after the scheduler dies on a fatal. Each restart is a new
  process with the same arguments, started once the old one has exited. It
  stops early when the new fatal matches the one the last restart was for, and
  it never restarts a refusal (preflight, disk floor, dirty tree, auth,
  baseline). `2` is a reasonable value for an overnight run. A value that is
  not a non-negative integer refuses the run.
- **`protectedEdits`** (optional) says which top-level keys of a protected JSON
  file a lane is allowed to edit. It defaults to `{package.json: [scripts]}`,
  which is the one edit a builder MUST be able to make — wiring its own new test
  file into the `test` chain. An edit that stays inside those keys survives; one
  that also moves `dependencies`, a version or anything else is reverted whole,
  and a reverted `package.json` or lockfile now blocks the lane rather than
  letting it report a green that ran against the old chain. Widen it if your
  builders own more of the manifest, or set `package.json: []` to revert every
  edit as before.
- **`testScripts`** (optional) names the paths this project registers by hand,
  as globs, and defaults to `["scripts/test-*"]`. A lane that produces a file
  matching one that nothing in `package.json` reaches — no `scripts` entry names
  it or its directory, and no file those entries name imports it — gets a human
  action item: the gate never ran that file, and a check that does not run is
  indistinguishable from one that passes. It reads one lane's own output, so a
  file already dark on the base branch is not its business. Leave it alone if your suites are
  glob-discovered — a file the runner picks up without an entry must not be
  flagged, and `testScripts: []` switches the check off entirely.
- **`reachReport`** (optional) is one command that prints a
  `knip --reporter json` payload — `{"issues": [{"file", "exports", "types"}]}` —
  to stdout. The runner runs it at the epic's merge-base and at its branch tip,
  each in a throwaway checkout bootstrapped by your `worktreeSetup`, and the
  closeout's Reach axis reports the difference: an export this epic ADDED that
  nothing reaches. A ratchet, not a gate, because most repositories have a red
  baseline — atlas-workspace carries 495 unused exports before any epic runs, so
  an absolute count says nothing and only what the branch added is the epic's
  business. Set it to something that reads test files OUT of the graph
  (`knip --production`): default knip counts an import from a test as usage, so a
  symbol whose only caller is its own test looks wired, which is exactly the
  shape #365 shipped. Unset, the closeout asks the reviewer for the list by grep
  and says on its face that nobody computed it. The command's exit code is
  ignored — knip exits non-zero whenever it finds anything.
- **`checkTimeoutMs`** (optional) bounds a single check command, in both places
  one runs: inside a lane worktree, and in the post-merge gate where a hang
  holds the whole epic because integration is serial. Defaults to `1800000` —
  30 minutes, matching `agent.timeoutMs`, and deliberately not 10, because a
  cold `xcodebuild` lane pays for a full Swift compile before the first test
  runs. A check that hits the bound fails its attempt with `check timed out
  after Ns: <command>`, which reads differently from `check failed: <command>`
  in the log, in `verification.json` (`timedOut: true`) and in the evidence the
  retry is handed. Raise it if your suite is genuinely slower. There is no way
  to switch it off: "no bound" is how a `swift test` sat behind a macOS consent
  dialog for six hours with nobody awake to click it.
- **`requiredEnv`** (optional) names secrets the preflight verifies are present
  before the first builder is spawned, so a missing token fails with a message
  instead of looking like a run of bad tickets.
- **`merge`** (optional) is what the merge guardrails read
  (`scripts/merge-guards.mjs`) before a delegate accepts a gate or a merge
  goes ahead unattended. Four optional keys; any other key under `merge:` is a
  validation error:
  - `userFacing`: globs of paths a user sees. A project with `launchStatus:
    launched` must declare it, or the `launch-status` guardrail fails.
  - `screenshotBaselines`: globs of the PNG baselines that cover those paths. A
    user-facing change passes when every changed user-facing path is a baseline
    whose pixels moved by 1% or less (8-bit RGB or RGBA, not interlaced; a new,
    deleted or resized baseline counts as above 1%).
  - `ci`: `required` (the default) or `none`. With `none`, a PR with zero
    checks passes `ci-green` only when the Runner recorded a green gate (fix
    gate or baseline) at the head.
  - `healthProbe`: a shell command; exit 0 means healthy. A launched project
    must declare it.
  - `author`: `{ name, email }`. When set, `afk merge` merges the PR itself
    (`git merge --no-ff` of the guarded head into the base, authored and
    committed as this author, then a plain push of the base) instead of
    `gh pr merge`, for repos that deploy only one author's commits.
  - `coAuthors`: a list of `Name <email>` strings, one `Co-Authored-By:`
    trailer each on that merge commit. Needs `author`.

  ```yaml
  merge:
    userFacing: ["app/**", "ui/**"]
    screenshotBaselines: ["ui/__snapshots__/**"]
    ci: required
    healthProbe: curl -fsS https://example.com/health
  ```
- **`preflight`** (optional) declares the host checks only this project knows
  about. Each runs before any lane is spawned, and also on demand with
  `afk preflight`; `afk validate` checks the block's shape and runs none of
  them. The block is closed: a key other than these and `macAutomation: false` (which
  turns off the macOS automation probe for UI tickets) is a validation error.

  ```yaml
  preflight:
    probes:
      container runtime is up: docker info
      pnpm shim answers: pnpm --version
    ports: node scripts/gate-ports.mjs
  ```

  `probes` maps a one-line label to a command run from the checkout. Every one
  must exit 0; a failure prints the label, the command and the last ten lines
  of its output, and the run spawns nothing. `ports` is ONE command, given the
  checkout path as its last argument, that prints the ports that checkout's
  gates bind (whitespace- or comma-separated). It is a command and not a list
  because a project like Harbour derives its ports from a hash of the path. The
  runner checks each port on the epic checkout with `lsof` and refuses while one
  is held, naming the pid and command holding it. A ports command that fails or
  prints something that is not a port also refuses: a port check that checked
  nothing is the collision it exists to stop. Under `agent.runtime: herdr` the
  preflight also checks that the herdr server is running. Preflight fixes
  nothing and kills nothing.
- **`roles`** (optional) is which skills each agent gets. You do not write it by
  hand; `afk stack detect` proposes it from the plugins this repo already
  enabled. See step 3.

## 3. Let `afk stack detect` write the `roles:` block

```bash
afk stack detect
```

Deterministic, offline, free, and it **writes nothing** — it prints a proposal
you paste into `.afk-setup/config.yaml`. It reads `.claude/settings.json` for
the plugins this repo enabled and `package.json` for the stacks it can see,
then merges the bindings the runner ships for each.

Two lines of its output are the ones worth reading: a plugin it has no bindings
for contributes nothing until someone writes them, and a stack in your
`package.json` with no plugin enabled is a gap. Neither is silently skipped.

The block it proposes has two lists per role. `always` is a rule the agent
applies to every task. `offer` is a choice it applies only when the task needs
it — which is why there is no per-ticket signal to maintain: the builder is
told which skills exist and judges for itself. `notes` is prose for a stack
that has no skill at all, which today is most of them.

## 4. Add the `.gitignore` entry

```
.afk/
```

`.afk/` holds live state, prompts, JSONL agent streams and recovery patches —
local runtime, not history. One file inside it is deliberately exempt:
`.afk/epic-ledger.yaml` is force-added and committed by the runner, because a
cross-lane finding has to outlive the run that recorded it. You do not need a
negation rule for it; the runner force-adds it.

Skipping this step is how a run's entire scratch state ends up in a lane's diff.

## 5. Write the project's `AGENTS.md`

This is the contract every fresh builder reads before touching your code, and
each lane starts with no memory of the last one. Anything the project knows and
a new contributor would not, it has to be here or it does not exist: how to run
the build, which directories are off limits, the conventions you actually
enforce, and the mistakes this codebase has already paid for.

You do not need to create a progress file. The runner writes each epic's task
table to `docs/progress/<epic id>.md`, creating the directory on the first
flush; it is a projection, not a file you maintain by hand.

## 6. Write the epic and its child issues

The spec lives on GitHub, not in the repo: one epic issue whose body carries a
fenced `afk:` block, and one child issue per task. The task key **is** the child
issue number.

```yaml
afk:
  version: 1
  branch: feat/203-first-run
  max_parallel: 3

  tasks:
    204:
      depends_on: []
    205:
      depends_on: [204]
    206:
      depends_on: [204]
      checks: [npm test]
```

Prefer wide and shallow. A lane that fails strands every task that depends on
it, so depth is the thing that turns one bad ticket into a lost afternoon.
`PLANNER.md` is the agent-facing prompt for sizing and shaping this.

## 7. Validate against the real epic, before `afk epic`

```bash
afk validate 255
```

`validate` reads the epic and its children and prints the graph's depth and
blast radius. It creates **nothing** — no branch, no worktree, no `.afk/`, and
it never edits the issue — so it is safe to run against anything, as often as
you like. It refuses rather than guessing: a task with no child issue, a task
nothing can gate, a `gate: after` with no lifecycle yet. Each refusal names the
id.

Two flags worth knowing on the first run:

```bash
afk validate 255 --epic-body=./epic.md   # check a local block against the epic's
                                         # real children before writing it up
afk validate 255 --plan-review           # a read-only agent reads the epic and
                                         # every child and reports contradictions
```

`--plan-review` costs tokens and needs a live login; without it `validate` stays
deterministic, offline and free. `afk epic` always runs it, so the cheap way to
find a self-contradicting plan is here, not after the branch exists.

Do not move on while `validate` still refuses. Every refusal it prints is a
failure you would otherwise discover with a builder already running.

## 8. Prove the notification path

```bash
afk notify --workspace=w1   # any live workspace id from `herdr workspace list`
```

macOS grants notification permission per app, so a terminal that was never
granted it fails **silently**. This command fires one test notification per
severity and reports which path delivered them. Running unattended without
knowing this works means a lane that hits a human gate waits until you happen
to look.

**Click one of them.** Without `--workspace` you only prove delivery, and the
click-through is the half that fails silently — a command that resolves to
nothing and a notification that was never clickable look identical. A correct
click raises this terminal and lands you in that workspace.

While you are in System Settings → Notifications → *terminal-notifier*, set its
alert style to **Alerts**, not Banners. Banners slide away after a few seconds
and no sender flag can override it; a blocked lane you did not see is a lane
that waits until you check on it.

## 9. Make the first epic a throwaway

**The first epic on a new project should be disposable work you would be happy
to delete.** Three small, independent tasks against something that does not
matter — a docs pass, a scratch directory, a chore.

The reason is that the first run is testing the *setup*, not the tickets. Nearly
everything that goes wrong on a project's first epic is environmental: checks
that pass locally and fail in a bare worktree, a missing gitignored credential,
a `defaultChecks` command that assumes `node_modules`, an expired login, a
notification path that never delivered. You want to find those with work whose
loss costs nothing, not with the feature you actually need on Friday.

The second reason is that you are calibrating your own trust. Watching a run you
do not care about is how you learn what normal looks like — how long a lane
takes, what the dashboard shows during integration, what a stalled lane reads
like — and that baseline is what makes the next run's anomaly visible.

```bash
afk epic 255
```

`epic` runs the same validation, then creates the epic's branch and starts the
run.

If you drive your runs the way most people here do — one terminal per epic, with
a Claude session in it to ask about the run — use `afk start` instead:

```bash
afk start 255
```

It starts the same runner **detached, in its own process group**, so the
run outlives the terminal and the session; waits until the run reports its
branch and its dashboard port; prints those with the checkout and the commands
to check on it; and then opens an interactive `claude` session here. Ask that
session about the run — do not start the epic again from inside it, it is
already going. Every other argument is forwarded to `afk epic`.

## 10. Watch the first run

Do not walk away from this one. Four views, cheapest first:

```bash
afk status              # lifecycle state of every task — start here
afk dashboard           # live view at http://127.0.0.1:<port>
afk stats <id>          # tokens, turns and last tool call for one lane
afk heartbeat --watch   # notifies when the run dies, stalls, or hits a gate
```

`afk auto` starts the dashboard on its own; `afk dashboard` is for the times you
closed the tab. With more than one run going, every dashboard shows
them all as tabs — project, epic, and a dot for whether that run is running,
stale or idle — so any run's own URL is a way into the others.
**http://localhost:4099** is the fixed one to bookmark: it is the hub
(`afk hub`, kept running by `afk hub install`), which lists every run and links
each dashboard on its own port. **In review** on the dashboard means a lane passed verification
and is waiting its turn in the serial integration queue — that is normal, not a
stall.

The header names the run — project, epic number and title, branch, elapsed,
and passed tickets over total. Below it the dashboard draws the epic's
children as a DAG: work flowing down the page, one band per dependency depth,
an edge per `depends_on`. The epic itself is not a node; the header already
names it. A ticket's five pips are the stages it has left — queued, building,
review, integrating, passed — and the line beside them is what it has
actually done: tool calls and output tokens while an agent is on the lane,
`n/m checks` and wall time once it has finished. Clicking any node opens that
lane's log. Below the graph is the inbox — only the tickets moving, stuck or
waiting on you — and below that a chip per non-lane agent the run has spawned
(verifier, supervisor, fixer, reflector, plan review, epic close), newest
first, each opening its own stream. The page is built for a phone first, so
checking a run from bed works without pinching.

What to actually watch for in the first hour:

- **Every lane failing fast and identically.** That is the environment, not the
  tickets — a dead login or a missing dependency in the worktree. The circuit
  breaker stops new builders after two consecutive terminal failures with no
  pass between.
- **A lane running with no growth.** Compare two `afk stats <id>` calls a few
  minutes apart. A last action from twenty minutes ago is a hang; a context near
  the limit is a lane about to die of exhaustion.
- **The first integration.** Serial merges into the base branch are where the
  runner touches history. Confirm the first one lands before you trust the rest.
- **A gate.** A `gate: before` task waits for you; release it with
  `afk epic <issue> --task=<id>`. A `gate: after` task waits for your acceptance
  before the epic can close: `afk epic <issue> --accept=<id>`.

If you want a second opinion on something you are seeing, `afk supervise
question --question="..."` answers in plain language. It is read-only and
advisory — it proposes commands and changes nothing.

## 11. Close the loop

```bash
afk verify 255
```

The epic's closeout review: `/code-review` over the integrated feature branch,
checked against the acceptance criteria in the child issues. Read-only and
**advisory** — it writes a report under `.afk/verifier/<issue>/` and marks
nothing complete.

Then delete the throwaway branch, and write down what your setup got wrong.
Fix `.afk-setup/config.yaml` and `AGENTS.md` while the evidence is fresh. That
correction is the entire point of step 9, and the reason the next epic can be
one you care about.

---

When a run misbehaves after this, stop reading here and open
[docs/runbook.md](runbook.md) — it is organised by symptom and is authoritative
for recovery.
