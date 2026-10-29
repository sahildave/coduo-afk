# Permissions — how this runner caps its agents

Every agent this runner starts is one record in `scripts/roles.mjs` `ROLES`:
`{ prompt, model, permissions, phases, pane, timeoutMs }` plus two runner-facing
labels. Five roles exist — `implementer`, `integrator`, `plan-reviewer`,
`verifier`, `supervisor`.

What stops each of them doing damage is spread across three mechanisms that are
easy to mistake for one another. Read this section before the role table; the
table is only useful once the three are separate in your head.

## The three mechanisms

**1. Tool deny rules** — `permissions.deny` and `permissions.denySkills` in
`scripts/roles.mjs`, rendered by `preflightSettings` into the worktree's
`.claude/settings.local.json` and by `settingsArg` onto the invocation as
`claude --settings '<json>'`. A denied tool is *removed*, not refused: the agent
gets back *"No such tool available: Write. Write is disabled for this session"*,
and nothing lands in `permission_denials` (`docs/findings.md` 3.2, harness
mistake 2). Deny rules union across scopes, so the preflight file and the
`--settings` payload are additive. Bypass mode does **not** defeat a deny rule —
checked live against `claude 2.1.234` with `--dangerously-skip-permissions` in
force (`docs/notifications-and-agent-scope.md` §2, "Landed (Phase 2 Wave 1)").

The hole: a deny rule is tool-shaped. `Bash(git commit:*)` is a command name; a
shell redirect is not, so no allowlist of Bash verbs closes a `printf > file`
(`scripts/roles.mjs`, `verifier` note 2).

**2. `bypassPermissions: false`** — keeps `--dangerously-skip-permissions` off
the command line, so `--permission-mode` governs instead (`scripts/lib.mjs`
`buildAgentCommand`). Only `implementer` and `integrator` need bypass; the three
read-only roles set the field to `false` on their record. `roleAgent` in
`scripts/roles.mjs` forwards it, and `verifierAgent` (`scripts/verifier.mjs`)
and `supervisorAgent` (`scripts/supervisor.mjs`) apply it, deliberately leaving
the two older roles' command lines byte-identical.

The hole: this governs the *tools*. Under `acceptEdits` the Write tool refuses
anything outside the working directory whatever the sandbox says, while a Bash
redirect is governed by the sandbox instead — same role, same settings, opposite
outcome (`docs/findings.md` 3.2, the `/tmp` column).

**3. Where the role runs** — the agent's own working directory. This is the one
nobody expects, and it carries more weight than either of the other two for the
roles that keep `Bash`. Claude Code grants the agent's cwd unconditionally;
`sandbox.filesystem.allowWrite` can only ever *widen* that grant, never narrow
it. So the lever is the cwd: `scripts/worktree.mjs` `roleCwd` /
`createRoleCwd` put `verifier` and `supervisor` in a directory outside the
project, and the project then falls outside every `allowWrite` entry, which is
what the sandbox does enforce. See gotcha 1.

## The five roles

| Role | Runs in | Bypass | May write | What actually stops it |
|---|---|---|---|---|
| `implementer` | its own task worktree | yes | its worktree, `/tmp` | **where it runs** — a worktree outside the project — plus the worker's protected-file reverts, `denySkills: ['herdr']`, a PreToolUse hook that refuses its file tools the run's checkout (Claude only), and `Edit` denies on `~/.claude` and the credential dirs. Claude Code merges `Edit`/`Read` deny rules into the sandbox's `denyWrite`/`denyRead`, so those also bind its sandboxed `Bash`. Its `allowWrite` grants `/tmp`; it does not, and cannot, narrow anything (gotcha 1) |
| `integrator` | the project root | yes | the repo — by design | its prompt, plus deny rules on its invocation: credential reads, `Task`, `denySkills: ['herdr']`, and `Edit` on `~/.claude` and the credential dirs |
| `plan-reviewer` | the project root | no | nothing | **tool deny rules** — `Bash` denied outright |
| `verifier` | a disposable detached checkout | no | that checkout, `/tmp` | **where it runs** — it keeps `Bash` |
| `supervisor` | a bare scratch directory | no | that directory, `/tmp` | **where it runs** — it keeps `Bash` |

### `implementer`

The builder. One task, one agent, one sealed worktree. It is *meant* to write
code, so it keeps `--dangerously-skip-permissions`; the cap is the sandbox
profile `{ allowWrite: [CWD, '/tmp', '/private/tmp', '/var/tmp'] }`, rendered
into the worktree's `.claude/settings.local.json` by `preflightSettings` with
`CWD` substituted for the real worktree path (`scripts/roles.mjs`). Here
`allowWrite` widening-only is harmless: the worktree is granted by default
anyway and the extra entries are additions.

**The worktree is not a boundary against the editing tools.** Measured
2026-08-19, from inside a real lane under the shipped profile
(`docs/findings.md` 3.15, and gotcha 6 below): a `Bash` redirect to the main
checkout and to a *sibling lane's* worktree was refused both times
(`operation not permitted`) while `/tmp` succeeded — the sandbox delivered,
honoured and correctly scoped. The **`Write` tool wrote both**, with no error
and `permission_denials: []`. The sandbox governs the shell; the permission mode
governs `Write`, and bypass is what removes it. The run's checkout is now
capped for the file tools by a PreToolUse hook (`scripts/project-root-guard.mjs`,
Claude backend only), and so is every lane in the run's lanes directory except
the builder's own, which the runner names when it renders the settings. Do not
close what is left by widening the sandbox. The cap is a hook, not an
`Edit(<root>/**)` deny, because Claude Code merges `Edit` denies into the
sandbox's `denyWrite`, and that one refused sandboxed git the shared
`<root>/.git` of a linked worktree.

**What holds today is detection, not prevention.** `foreignWrites`
(`scripts/worker.mjs`) reads every builder's own transcript for editing-tool
calls outside its lane; one that lands fails the task and stops the run instead
of retrying, because the retry path would reset the lane and leave the foreign
file in place. It is not a cap — the write has already happened when it is seen
— but it is the difference between an escape that surfaces as a merge conflict
nobody can explain and one the runner names, with the tool and the path. Its
limits are real and listed in 3.15: a `Task` subagent's writes and MCP tools are
invisible to it, and only the `Bash` route has a second layer behind it.

Denied: the credential paths (`CREDENTIAL_DENY` — `~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config/gh`) and the `herdr` skill, because that skill lets an agent start
sibling agents in other panes and would break "one ticket, one agent, one sealed
worktree" with nothing in the runner noticing
(`docs/notifications-and-agent-scope.md` §2).

Not a permission, but worth knowing: after the builder exits, `worker.mjs`
`restoreProtected` reverts anything it touched in `PROTECTED_FILES`
(`scripts/lib.mjs` — `docs/progress.md`, `agent-auto.log`, the dependency
manifests and lockfiles) or under `PROTECTED_PREFIXES` (`.afk-setup/`, so the
config that says how a lane is verified and the prompt overrides that instruct
the lane itself, and `docs/progress/`, where the runner writes each epic's
table). That is a post-hoc revert, not a prohibition: the write
happens and is then undone.

### `integrator`

The merger. Runs at the project root, with bypass. Its enforced restrictions
are `denySkills: ['herdr']` (*"Same, and it has feature-branch write"*,
`docs/notifications-and-agent-scope.md` §2 roles table), the credential reads,
`Task`, and `Edit` on `~/.claude` and the credential dirs. It has no
project-root guard: merging there is its job.
It gets `sandbox: null` for the same reason it gets no preflight file: at the
project root, `.claude/` belongs to the project and the runner must not write it
(`scripts/roles.mjs`). Its whole profile therefore travels on the invocation via
`settingsArg`.

This is the least capped role in the runner, deliberately — merging is a write
job at the repo root. Its containment is the runner around it (`integrate.mjs`
snapshots untracked files and rolls `main` back on failure), not its permissions.

### `plan-reviewer`

Runs once inside `afk epic`, before the feature branch exists, over the epic and
child issues already in its prompt (`scripts/plan-review.mjs`). It runs at the
project root — no `roleCwd` — so mechanism 3 is *not* what holds it.

**Read-only because it denies `Bash` outright.** With `Write`, `Edit`,
`MultiEdit`, `NotebookEdit` and `WebFetch` gone as well, it has nothing left to
write with: its `full` probe attempted both writes, was refused both, and
reported having no shell at all (`docs/findings.md` 3.2). This role has no
reason to run a command, and `Bash` is the one read tool that can write.

Its `sandbox: { allowWrite: [] }` is deliberate and is **not** what makes it
read-only — with the deny list removed, the same role wrote straight into the
repository root (`docs/findings.md` 3.2, `plan-reviewer sandbox-only`). See
gotcha 1.

`timeoutMs` is pinned to 300 s rather than inherited: it stands between the
human and the run starting, and fifteen minutes of it is a hang, not a deep
think (`scripts/roles.mjs`).

### `verifier`

The epic's closeout review. It keeps `Bash`, because `/code-review` and
`git diff` are how it works.

**Read-only because of where it runs.** `createRoleCwd({ root, key, ref: branch })`
gives it a disposable *detached worktree of the branch it is reviewing*
(`scripts/worktree.mjs`, `spawnVerifier` in `scripts/verifier.mjs`). It may
write that copy freely: nothing reads it back, nothing merges it, it holds no
ref anything could move, and it is removed when the agent exits. The project
root is then outside every `allowWrite` entry. Measured: at the project root
this role **wrote** the repo with a shell redirect while every editing tool was
denied; started in its `roleCwd` with the identical payload, the same write was
**blocked** (`docs/findings.md` 3.2, the `shipped-cwd` rows).

The deny rules are real but secondary: the editing tools, plus the Git verbs
that could move a ref (`commit`, `push`, `merge`, `reset`, `checkout`, `branch`)
and the `gh` verbs that could write the issue or PR. The runner writes the
report to the issue and the PR; this role never does — a gate that can write to
the thing it gates is honor-system (`docs/epic-schema.md`, "Rejected:
librarian").

Degraded path, said out loud rather than silently: if the checkout cannot be
made, `spawnVerifier` falls back to the project root and prints *"reviewing from
the project root, where this role can write what it is gating"*
(`scripts/verifier.mjs`).

**What it can run.** It runs `--permission-mode default` under `-p`, so a
command the sandbox cannot hold falls through to a permission prompt nobody
answers, and is denied. Two consequences, both once-recurring:

- It does not read GitHub. The `gh` deny is verb-shaped (`gh issue:*`, `gh
  pr:*`) and the sandbox names no network host, so `gh issue view` was denied
  as surely as `gh issue comment`. The runner already holds the epic and child
  bodies, so `prompts/verifier.md` carries them verbatim and tells the agent —
  and `/code-review`'s Spec axis — that the spec is inline. `gh` is not a gate
  and is not a valid `skipped` entry.
- Native toolchains need to be declared. `xcodebuild` writes DerivedData and
  `xcrun simctl` talks to CoreSimulator; neither runs inside the sandbox, so
  epic #391's verifier ran zero of six gates. List them:

  ```yaml
  roles:
    verifier:
      gates: [xcodebuild, "xcrun simctl", agent-device]
  ```

  Each entry becomes a `sandbox.excludedCommands` pattern (runs outside the
  sandbox) and a `Bash(<entry>:*)` allow rule (auto-approved under `-p`), via
  `gateRules` in `scripts/roles.mjs`. Only the listed prefix is allowed:
  `xcrun simctl` leaves `xcrun git push` unsandboxed *and* unallowed, which is
  a denial, and deny rules outrank allow rules, so no gate re-enables a denied
  verb. `allowWrite` is untouched. The verifier's prompt also names
  `defaultChecks` (`{{checks}}`), the same list the fixer gets, so it runs the
  project's gates rather than guessing at them.

- Network egress is denied by default and is opt-in **by host**. The sandbox
  names no host unless a project lists one, which is why `next/font` could not
  reach `fonts.googleapis.com`, SPM resolution returned `CONNECT 403`, and the
  Infisical-wrapped test gate died on `eu.infisical.com`. List them:

  ```yaml
  roles:
    verifier:
      network: ["eu.infisical.com"]
  ```

  Rendered as `sandbox.network.allowedDomains` by `networkRules` in
  `scripts/roles.mjs`. There is deliberately no "allow everything" value, and
  `gh` is in no default list: the epic and child issues are already inline in
  the prompt, and a reviewer that can reach the GitHub API is one `gh pr
  review` from writing to what it gates.

  **Set it from a closeout that named a host, never in advance.** Measured
  across seven closeouts on 2026-09-18, egress accounted for only four of
  roughly fifteen skipped gates. The other eleven were filesystem — a
  `node_modules` symlink outside the writable roots, `../.atlas-target`,
  `~/.supabase` — and no host fixes those. A `network:` list that grew by
  guesswork would read as if the gates now run when they still do not.

  **Granting egress is what makes a destructive gate succeed.** `pnpm run
  test:db` failed on every atlas-central closeout because `supabase db reset`
  could not start a local stack; the cwd cap is a *filesystem* cap and protects
  nothing about a local Postgres, a Docker volume or a simulator's data. So
  `DESTRUCTIVE_DENY` in `scripts/roles.mjs` denies `supabase db reset|push|stop`,
  `prisma migrate reset`, `dropdb`, `docker volume rm`, `docker system prune`,
  `xcrun simctl erase|delete` and `git clean -xfd` to every role, and deny rules
  outrank allow rules — so a `gates:` entry cannot re-enable one. A command that
  destroys a shared resource is not a review step.

### `supervisor`

The event-driven advisor. It keeps `Bash` by necessity — its whole input is
logs, run state and panes, all read with a command.

**Read-only because of where it runs**, by the same cap as the verifier:
`createRoleCwd({ root, key })` with no `ref`, so a bare empty directory
(`scripts/worktree.mjs`, `spawnSupervisor` in `scripts/supervisor.mjs`). Its
prompt names every input by absolute path, so it loses nothing. `.afk/supervisor/`
is written by the *runner* around the agent, never by the agent.

Two denials are specific to it, and they are the authority split expressed as
permissions (`scripts/roles.mjs`):

- `Bash(afk:*)` and `Bash(node afk.mjs:*)` — it *proposes* actions;
  `scripts/supervisor.mjs` renders the allowlisted ones to argv and the runner
  spawns them. The LLM never executes an action, so a hallucinated `afk reset`
  cannot reach a shell (decided in `docs/findings.md` 4.2: advise, not execute).
- the five mutating `herdr` verbs — `Bash(herdr agent:*)`,
  `Bash(herdr worktree:*)`, `Bash(herdr workspace create:*)`,
  `Bash(herdr workspace close:*)`, `Bash(herdr pane rename:*)` — the ones
  `scripts/runtime-herdr.mjs` itself uses to change the pane layout.

It is **the one role that keeps the `herdr` skill**: `denySkills: []`, because
reading panes is how it answers "what is 207 doing"
(`docs/notifications-and-agent-scope.md` §2 roles table). That asymmetry is held
by two tests — `scripts/selftest.mjs` skips it in the every-role deny loop and
asserts the `[]` separately, and `scripts/supervisor.test.mjs` walks `ROLES`
asserting `denied === (name !== 'supervisor')` — so a later sweep that denies
the skill everywhere for symmetry fails loudly instead of quietly blinding it.

## The same three mechanisms under `afk-codex`

Everything above describes Claude Code, and two of the three mechanisms do not
exist on the Codex CLI: there is no `--settings` payload and no
`--permission-mode`. What Codex has is an OS-level sandbox mode named on the
command line, plus mechanism 3, which is unchanged.

| | `afk` | `afk-codex` |
|---|---|---|
| 1. tool deny rules | `--settings` / `.claude/settings.local.json` | **none** — the CLI has no equivalent |
| 2. permission mode | `--permission-mode` vs `--dangerously-skip-permissions` | **none** — `--ask-for-approval never` is unattendedness, not a cap |
| 3. where the role runs | the role's cwd | the role's cwd, and `--cd` names it explicitly on every command line |
| the sandbox | `sandbox.filesystem.allowWrite`, which only widens | `--sandbox read-only` or `--sandbox workspace-write` |

`codexSandbox` in `scripts/roles.mjs` renders each role's existing intent into a
mode, from the same test `settingsArg` uses, so the two renders of one profile
cannot drift: a role that names its own cwd in `sandbox.allowWrite` is a writer
and gets `workspace-write`; a role whose sandbox never widens to cwd is a
reviewer and gets `read-only`. `integrator` has no sandbox profile at all — it
runs at the project root by design — and is a writer.

| Role | Codex sandbox | Model / effort |
|---|---|---|
| `implementer` | `workspace-write` | `gpt-5.6-luna` / `max` |
| `reflector` | `workspace-write` | `gpt-5.6-luna` / `max` |
| `integrator` | `workspace-write` | `gpt-5.6-sol` / `medium` |
| `plan-reviewer` | `read-only` | `gpt-5.6-sol` / `medium` |
| `verifier` | `read-only` | `gpt-5.6-sol` / `medium` |
| `fixer` | `workspace-write` | `gpt-5.6-sol` / `medium` |
| `supervisor` | `read-only` | `gpt-5.6-sol` / `medium` |

`fixer` is the row worth reading twice: it reviews like the other `sol` roles
but it *writes* — its output is a commit on the branch the epic just merged
(`scripts/roles.mjs`, `fixer.permissions`) — so its profile names its own cwd
and `codexSandbox` returns `workspace-write`. Under Claude the cap on that role
is its deny list, and under Codex there is no deny list, so `afk-codex`'s fixer
is capped by its cwd and by nothing else. `scripts/selftest.mjs` asserts the
mode for all seven roles, so this table cannot drift from the code again.

The `verifier` row is the mode `codexSandbox` returns, and `spawnVerifier`
widens it in one place for one reason: `prompts/verifier.md` tells the agent to
write its report to a scratch path with a heredoc, and a `read-only` session can
write nothing, so every `afk-codex` closeout lost the file channel and fell back
to harvesting the final prose. The spawn therefore passes the scratch directory
as `--add-dir` and asks for `workspace-write` — but ONLY when the role got its
disposable checkout, which is thrown away when the review ends. Without that
checkout the cwd is the project being gated and the session stays `read-only`.
`verifierSpawnPlan` in `scripts/verifier.mjs` is the whole rule, and
`scripts/verifier.test.mjs` pins both halves.

Two consequences worth stating plainly, because neither is obvious:

- **A read-only Codex role has ONE cap, not three.** Under Claude the deny rules
  and the permission mode sit in front of the sandbox and mask it — that is
  gotcha 1 and finding 3.2, and it is why `--check=sandbox` has a
  `sandbox-only` variant to look underneath them. Under Codex there is nothing
  in front: `--sandbox read-only` is the whole answer. That is a simpler story
  and a less forgiving one.
- **The evidence for the Claude side does not transfer.** `docs/findings.md` 3.2
  and 3.15 measured Claude Code. `AFK_LIVE=1 node scripts/live-checks.mjs
  --check=codex` is the Codex equivalent and is the only thing that has
  measured the Codex modes on this machine: it asks a `read-only` session and a
  `workspace-write` session to write the same file via a shell redirect, and
  scores the pair. The `workspace-write` row is the positive control — without
  a write there, "read-only did not write" and "the agent never tried" are the
  same observation, and that is not a pass.

Every Claude live check is unchanged and still runs:
`--check=sandbox`, `--check=herdr-env`, `--check=notify-click`.

## The merge verb

`afk merge <epic>` (`scripts/merge.mjs`, #189) is the one command that lets an
agent merge a PR. It merges only when every guardrail in
`scripts/merge-guards.mjs` passes, plus its own `epic-closed` and `pr-head`.
Each merge uses `--match-head-commit`. No flag skips a guardrail.

**Who runs it.** The chief of staff, the orchestrating session outside the
run, or the owner. A lane never does: with `RUNNER_TASK_ID` set the verb refuses
before it calls anything. None of the five roles above has a rule for it.

**The allow rule**, one string, added by hand:

```json
{ "permissions": { "allow": ["Bash(afk merge:*)"] } }
```

**Why it is scoped by directory.** The rule lives in
`~/code/projects/afk-claude/.claude/settings.local.json`, so it applies only to
a session started in the runner's checkout. A session in any other project
gets no merge permission from it, and merge permission is never global (the
decision rule in `docs/spikes/merge-verb-classifier.md`). It allows the
wrapped verb only. No settings file may allow `gh pr merge` directly: that
command has no guardrails.

**Why the local file and not the committed one.** `.claude/settings.json` is
committed, so a rule there would reach every clone, every worktree and every
AFK lane checked out from this repo. It would also reach any lane whose builder
can edit that file. `settings.local.json` is git-ignored (today through
`~/.config/git/ignore`; check with `git check-ignore -v
.claude/settings.local.json`), so the rule exists only on the machine where
The owner added it. No agent writes it, and no test touches it.

## Gotchas

**1. `sandbox.filesystem.allowWrite` only widens. It cannot deny the working
directory, and `[]` is a no-op, not a prohibition.** This is the one to read
first, because the instinct on finding a role that can write too much is to add
paths to that list — and adding paths is the only thing that list can do.

Proven live on 2026-08-18 with `AFK_LIVE=1 node scripts/live-checks.mjs
--check=sandbox` (`docs/findings.md` 3.2). The control row shows the payload is
delivered and honoured: an agent with no sandbox is *refused* `/tmp`, while
`verifier` with `/tmp` in `allowWrite` writes it. The same table shows
`allowWrite` has no power to take the default cwd grant away: `plan-reviewer`
with its tool denials removed wrote the repository root while carrying
`allowWrite: []`.

The fix is the cwd, not the sandbox (`scripts/worktree.mjs` `roleCwd`). Do not
"fix" a role here by widening the sandbox; the cap is the point.

**2. A denied tool is removed, so "the agent never tried" and "the agent was
stopped" look identical.** A deny rule does not reject the call — the refusal
arrives as a tool_result error and `permission_denials` stays empty. The
sandbox-check harness scored the one role whose read-only property genuinely
holds as "never tried" because of this (`docs/findings.md` 3.2, harness mistake
2). `denialsFor` in `scripts/live-checks.mjs` now reads both kinds of evidence.

**3. `/tmp` succeeding or failing tells you nothing about the sandbox on its
own.** A Bash redirect is governed by the sandbox; the Write tool is governed by
the permission mode, and `acceptEdits` refuses anything outside the working
directory whatever the sandbox says. Same role, same settings, opposite outcome
depending on which tool the model reached for (`docs/findings.md` 3.2). Read
gotcha 6 next: for a bypass role this stops being a quirk of the `/tmp` column
and becomes the hole.

**4. A read-only role has no worktree the runner owns, so its profile must
travel on the invocation.** `preflightSettings` writes
`.claude/settings.local.json` only into a worktree the runner created; at the
project root, `.claude/` is the project's and the runner must not write it.
`settingsArg` in `scripts/roles.mjs` renders the *whole* profile — sandbox
included — for any role whose sandbox names no `CWD`, which is every read-only
role. This is also the only path that reaches the role under `--runtime=direct`.

**5. Denying the `herdr` skill is enforcement; the skill's own description is
not.** The installed skill carries no `disable-model-invocation` field, so it is
model-invocable and is preloaded into subagents — measured and written up in
`docs/notifications-and-agent-scope.md` §2, which is the citable record here;
the skill file itself lives outside this repository. Without
the deny rule the only thing discouraging a lane from spawning a sibling agent
is a sentence asking the model not to (`docs/notifications-and-agent-scope.md`
§2). `HERDR_ENV=1` is set inside a live AFK lane on both runtimes, so the hole
is real, not theoretical (`docs/findings.md` 3.3).

**6. "The cwd is the cap" only holds for a role that keeps the permission
mode.** Gotcha 1's fix — move the role, do not widen the sandbox — was measured
on the three roles that set `bypassPermissions: false`. It does not transfer to
`implementer`, and the difference is not a detail: under
`--dangerously-skip-permissions` the layer that refuses an out-of-directory
`Write` is simply gone, and the sandbox underneath it never covered `Write` in
the first place (gotcha 3). Measured 2026-08-19 — a builder in its own lane
wrote both the main checkout and a *sibling lane* (`docs/findings.md` 3.15).
Before reasoning that any cap "carries over" to a bypass role, probe it:
`AFK_LIVE=1 node scripts/live-checks.mjs --check=sandbox` covers `implementer`
now, in two variants, because one tool's answer is not the other's.

## Still open

- **A Codex builder can write another lane's worktree**, through the editing
  tools. A Claude builder is now refused the run's checkout and every other
  lane in its lanes directory (the guard hook above); under
  `afk epic --worktree` the checkout is the epic worktree, not the user's own,
  and another epic's lanes sit in a different lanes directory the hook does not
  name. Those remaining crossings are **detected but not prevented**:
  `foreignWrites` in `scripts/worker.mjs` fails and halts a lane that crosses
  the boundary (`docs/findings.md` 3.15, direction 3).

- **A role handed a path *inside* the project and asked to write it can still do
  so through `Bash`.** Not fixed by the cwd change, deliberately. What changed is
  that it can no longer happen by accident, from a shell whose cwd is the repo
  (`docs/findings.md` 3.2, "Not fixed by this").
- **The supervisor's `herdr` deny list was written from the runner's own call
  sites, not from `herdr --help`.** Which read verbs exist, and whether any of
  them is a prefix of a denied one, is **not verified live**
  (`docs/notifications-and-agent-scope.md` §2).
- **The `integrator` has no permission cap at all beyond the skill deny.**
  That is a design position, not an oversight, but nothing in `ROLES` records it
  as reviewed (`scripts/roles.mjs`).
- **A `must-fix` verifier review does not block the epic close** —
  `docs/findings.md` 4.1, open and awaiting a human. A gate whose finding does
  not gate is worth knowing about when reading the verifier's caps above.
