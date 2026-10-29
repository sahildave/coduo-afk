# Notifications and agent scope

Two small operational changes, found while watching a build run. Independent of
the epic spec layer; both can land any time.

Status: design. Facts below marked **verified** were checked on this machine on
2026-08-18; the rest need a one-line check before implementation.

## 1. Notifications should be clickable

Today AFK notifies through `osascript display notification`. It works, but the
notification is inert — clicking it goes nowhere, which is the wrong outcome for
the one event that most needs a human: a blocked lane.

Two call sites:

- `scripts/heartbeat.mjs:162` — stall and health notifications
- `scripts/runtime-herdr.mjs:48` — blocked lane, auth death

### What to use instead

`terminal-notifier` is **verified installed** at
`/opt/homebrew/bin/terminal-notifier`. It supports `-execute`, which runs a
command when the notification is clicked. `osascript` has no equivalent.

`herdr workspace focus <id>` is **verified to exist**. (`herdr pane focus` is
directional — neighbouring panes only — and is not what we want.)

Together those give the behaviour worth having:

```
notification: "#207 blocked — Claude is asking for confirmation"
click        → -activate com.apple.Terminal   (raise the window)
             → -execute /Users/<you>/.local/bin/herdr workspace focus w23
             → you are looking at the lane
```

Two details, both learned the hard way — the first shipped version of this did
nothing at all when clicked, and failed silently, because a dead click and an
inert click look identical:

- **The command needs an absolute path.** terminal-notifier does not run
  `-execute` in the runner's shell. It hands it to `/bin/sh` with launchd's
  `PATH`, where `~/.local/bin/herdr` does not exist. `runtime-herdr.mjs`
  resolves the binary once at module load. **Partly verified:** `env -i sh -c
  'command -v herdr'` finds nothing, so the mechanism is real for a bare shell;
  the PATH a *click* runs under has not been measured yet — that is what
  `--check=notify-click` takes, and it needs a human to click.
  If it does not resolve at all (cron, launchd, a machine without herdr) the
  click is attached as `null` rather than as a bare `herdr`: the bare-name
  fallback would rebuild the exact bug, and this file already holds that a
  failing click is worse than an inert one.
- **Focusing a workspace does not raise a window.** `herdr workspace focus`
  changes what herdr draws; if you were in a browser you stayed in the browser.
  The other half is `-activate $__CFBundleIdentifier`, the app macOS launched
  the runner from. **Verified** both flags fire on one notification:
  `-[AppDelegate userActivatedNotification:]` calls `activateAppWithBundleID:`
  and falls through to `executeShellCommand:` on an independent branch, so the
  window is raised first and the workspace focused second. Re-checkable offline
  with `--check=notify-click`; it reads the shipped binary, not the README,
  which documents the two flags separately and says nothing about combining.

AFK already holds each lane's workspace id in its herdr registry, so the id is
in hand at the moment the notification fires. No new state.

### Shape

```
terminal-notifier \
  -title "AFK runner — <repo>" \
  -subtitle "#207 blocked" \
  -message "<detail>" \
  -sound Basso \
  -execute "herdr workspace focus w23"
```

### Requirements

- **Fall back to `osascript` when `terminal-notifier` is absent.** It is a brew
  binary, not something the runner may assume. The runner stays package-free;
  this is an optional external tool, not a dependency.
- **Only attach `-execute` when a workspace id exists.** Direct-runtime runs have
  no workspace, and a click that runs a failing command is worse than a click
  that does nothing.
- **Check the notification permission.** macOS requires notification permission
  per app; if it was never granted to `terminal-notifier`, delivery fails
  silently. Verify one fires before relying on it for unattended runs.

**Landed.** `notify()` in `scripts/lib.mjs` is the one renderer; both call sites
and the supervisor go through it. `afk notify` fires one of each severity and
reports which path delivered them.

### The full event list, and what each one sounds like

Every notification the runner can fire, and nothing else does:

| Event | `kind` | Where | Sends by default |
|---|---|---|---|
| lane blocked, needs input | `lane_blocked` | `runtime-herdr.mjs`, `auto.mjs` | **yes** |
| stopped at a human gate | `gate_reached` | `heartbeat.mjs --watch`, `auto.mjs` | **yes** |
| agent failed to start | `lane_start_failed` | `runtime-herdr.mjs` | no |
| agent process died | `lane_died` | `runtime-herdr.mjs` | no |
| claude login expired | `auth_expired` | `runtime-herdr.mjs` | no |
| runner stalled / not running | `runner_stalled` | `heartbeat.mjs --watch` | no |
| lane or integration failed | `lane_failed`, `integration_failed` | `auto.mjs` | no |
| epic finished | `epic_ended` | `auto.mjs` | no |
| runner died on a fatal | `orchestrator_fatal` | `auto.mjs` | **yes** |

Level, sound, click target and grouping are unchanged and still live in
`NOTIFY_LEVELS` / the call sites; the column that decides whether you hear
anything at all is the last one.

### The allow-list

`NOTIFY_ONLY` in `scripts/lib.mjs` holds the `kind`s that still interrupt.
Default is `lane_blocked,gate_reached,orchestrator_fatal` — the three events
where the run cannot continue until a human does something. The third was added
by #144, after four epics sat dead for up to 2h13m with nothing said. Everything else is still logged, still in
`afk status`, and no longer produces a banner.

**The cost, stated plainly:** with the default set, an unattended run whose
login expires or whose runner stalls at 2am dies silently. Widen it per run:

```
AFK_NOTIFY_ONLY=lane_blocked,gate_reached,orchestrator_fatal,auth_expired,runner_stalled afk auto
```

`notify()` called without a `kind` is unfiltered — it is the renderer, and `afk
notify` has to fire one of every severity whatever the policy says.

Four notes on the shape of that table:

- **Nothing routine is on it.** The runner used to notify when an agent started.
  It no longer does: a lane starting needs nothing from a human, and macOS gives
  a sender no way to deliver quietly — `-group` replaces the Notification Centre
  entry but still shows a banner and still plays a sound. A ticket is worked by
  two agents in sequence, so a three-ticket epic interrupted six times to say
  something the dashboard and the pane titles already showed. There is no `info`
  level any more, and `scripts/selftest.mjs` fails if one comes back.
- **Grouping is per TICKET, not per lane or per event.** A ticket is worked by
  the builder lane (`15`) and then the integrator lane (`merge-15`); keying the
  group on the lane let one ticket leave two live notifications. Keyed on the
  ticket, #15 leaves ONE notification saying the latest thing.
- **Every notification raises the window; only a lane can also focus one.** The
  heartbeat and the supervisor watch from outside a lane, so neither has a pane
  a click should land in — that much of the old "an inert notification is the
  honest one" still holds. But it was doing less than it could: the other half
  of "take me there" needs no workspace at all. `notify()` in `lib.mjs` attaches
  `-activate` to everything it sends, so a stall alert now brings the terminal
  forward and only the *focus* is missing. A lane adds `-execute` on top.
- **Everything the allow-list lets through pierces Do Not Disturb.** Both
  defaults are `error`/`warn`, both of which set `ignoreDnD`. That is the point
  of cutting the rest: what remains is only the run waiting on you, so it is
  allowed to be loud.

### Coalescing: the allow-list was not enough

The allow-list decides WHICH events send. It does nothing about the shape that
still produced a wall of banners, because that shape contains no repeats:

- **Fan-out.** Five lanes reaching a phase boundary together each correctly send
  their own `lane_blocked`. Five calls, five banners, and the per-ticket group
  cannot merge them — they are five different tickets.
- **Two voices, one lane.** The lane says it is blocked; the supervisor finishes
  judging that same lane a session later and asks to be heard about it too. Both
  are correct and the second interrupts a human who is already looking.

No notifier package changes either one: they all faithfully deliver the calls
the runner made. So the runner makes fewer calls.

- **A declared event buffers for `AFK_NOTIFY_COALESCE_MS` (default 5s)** and
  leaves as ONE notification. Alone, it is delivered as itself — click, sound
  and all. With company, they merge: worst level wins, and the merged message
  names every subject (`#207 blocked · #208 blocked · #209 blocked`) so a
  quieter banner is never a vaguer one. The click is attached only when every
  event in the burst wanted the same one; otherwise `-activate` still raises the
  terminal and the operator picks the lane. `notify()` returns `coalesced`.
- **A group already reported stays quiet for `AFK_NOTIFY_REPEAT_MS`
  (default 10m)**, unless it comes back at a higher level — an escalation is new
  information. The supervisor's banner now carries the *ticket's* group
  (`afk-lane-<id>`), so its opinion about #207 and #207's own report are one
  event rather than two. `notify()` returns `deduped`.
- **A notification is never lost to the buffer.** The flush timer is `unref`'d
  so it cannot hold a run open, and an `exit` hook flushes synchronously — a run
  whose last act is "gate reached" still tells you.

Undeclared notifications (`kind` omitted) skip both: that is `afk notify`, whose
whole job is to put a banner on screen right now and report which path did it.

### Checking these claims: `--check=notify-click`

```bash
AFK_LIVE=1 node scripts/live-checks.mjs --check=notify-click
```

Three claims this section rests on, none reachable from `afk selftest`:

| # | Claim | How it is checked | Needs |
|---|---|---|---|
| 1 | a click's `-execute` runs under a PATH without `herdr` | the click writes its own `$PATH` to a file | a human to click |
| 2 | `-activate` and `-execute` both fire on one click | disassembles the click handler | nothing — offline, repeatable |
| 3 | `-group` replaces the entry but still shows a banner | fires two same-group notifications 5s apart | a human to watch |

It **exits 1 when a notification is not clicked**, and says so in as many words.
That is the point: an unclicked notification and a dead click are the same
absence, and reading the second as the first is exactly how the bare-`herdr`
bug survived a whole epic. Silence is not an answer here, the same rule
`--check=herdr-env` applies to a pane that printed nothing back.

Status on this machine (2026-08-19): **claim 2 verified** by the disassembly.
Claims 1 and 3 are not yet measured — the check has been run, but nobody
clicked the notification and nobody reported what they saw. The code is correct
either way (an absolute path is right whether or not the bare name would have
worked), but do not repeat claims 1 and 3 as facts until this exits 0.

### What the sender cannot control: banner versus alert

**A notification that stays on screen until dismissed is a per-app setting, not a
flag.** System Settings → Notifications → *terminal-notifier* → **Alerts**.
`terminal-notifier -help` has no timeout or style option, and neither does
`osascript display notification`. For an unattended run this is the setting worth
changing: a blocked lane whose banner slid away after five seconds is a lane you
find an hour later. `afk notify` prints the reminder.

## 2. The herdr skill must not reach lane agents

**Verified:** the herdr skill is installed at user level —
`~/.claude/skills/herdr/SKILL.md`, linked from `~/.agents/skills/herdr`.

### Why that matters

The skill lets an agent create sibling panes and start other agents inside
herdr. AFK lanes run interactive `claude` inside herdr panes, and the skill
activates on `HERDR_ENV=1`, which a herdr pane sets in its shell environment.

If that holds, **a builder can currently spawn work outside its own lane**, and
nothing in the runner would notice. That breaks the invariant the whole design
rests on: one ticket, one agent, one sealed worktree. The runner's protections
are filesystem-scoped (sandbox `allowWrite` — weaker than it looks, see
`docs/findings.md` 3.2 — and protected-file reverts); none of them stop a lane
from starting a second agent somewhere else.

**Verified 2026-08-18 — it holds.** `HERDR_ENV=1` is set inside an AFK lane, by
two independent routes: the herdr *server* exports it into every pane it
creates (so every `--runtime=herdr` lane has it), and `worker.mjs` spawns the
builder with `{ ...process.env }` (so a `--runtime=direct` lane inherits it from
the operator's shell, which is normally itself a herdr pane). Measured with
`AFK_LIVE=1 node scripts/live-checks.mjs --check=herdr-env`; see
`docs/findings.md` 3.3. Nothing here is theoretical: the deny below is the only
thing standing between a lane and a sibling agent.

### Who should have it

| Role | Herdr skill | Why |
|---|---|---|
| `implementer` | no | Could escape its lane |
| `integrator` | no | Same, and it has feature-branch write |
| `plan-reviewer` | no | Runs before any pane exists |
| `verifier` | no | Read-only, one branch, no runtime concern |
| `supervisor` | **yes** | Reading panes is how it answers "what is 207 doing" |

The runner itself does not need it. `runtime-herdr.mjs` drives herdr through the
CLI from Node, deterministically. A skill is for an LLM.

### Where the fix belongs

The permission preflight already writes `.claude/settings.local.json` per
worktree (`scripts/runtime-herdr.mjs`, `writePreflight`). That file is the
natural place to deny the skill for lane agents.

**Verified 2026-08-18.** Skills go through the same permission system as any
other tool, so the deny rule is `Skill(herdr)` (or `Skill(herdr *)` to match with
arguments). `.claude/settings.local.json` is the highest-precedence scope, so a
worktree rule beats the user-level skill. Two alternatives exist: `skillOverrides:
{ "herdr": "off" }`, which hides the skill from the model's context and the `/`
menu entirely rather than refusing it at call time; and `--disallowedTools
"Skill(herdr)"` on the `claude -p` invocation, which would live in
`buildAgentCommand` instead of the preflight file.

Prefer the preflight file over the CLI flag. `buildAgentCommand` is shared by
every role, and Phase 2 gives each role its own permission profile — putting a
per-role rule in a shared command builder now is a seam we would have to unpick.

**Also verified, and it raises the priority:** `~/.claude/skills/herdr/SKILL.md`
carries **no `disable-model-invocation` field**. That field would keep the skill
out of the model's context and, explicitly, stop it being preloaded into
subagents. Without it the skill is model-invocable and is preloaded, so the only
thing currently discouraging a lane from using it is a sentence in its own
description asking the model not to. That is prompt-level, not enforcement —
the same honor-system shape this project already rejected for task completion.

Checked live on 2026-08-18: `HERDR_ENV=1` **is** set inside an AFK lane pane.
`scripts/runtime-herdr.mjs` neither sets nor clears it — the herdr server puts
it there, and a `--runtime=direct` lane inherits it from the operator's shell
instead. `docs/findings.md` 3.3 has the measurement and the reason clearing it
in the spawn env was rejected.

This lands properly in Phase 2's roles-as-data, where each role carries its own
permission profile and the skill list stops being a user-level global. Until
then, denying it in the preflight is the stopgap.

**Landed (Phase 2 Wave 1, Lane F).** `permissions.denySkills: ['herdr']` is a
field on both role records in `scripts/roles.mjs`, rendered two ways: into the
worktree's `.claude/settings.local.json` for the `implementer`, and onto the
invocation as `claude --settings '<json>'` for the `integrator`, which runs at
the project root where `.claude/` is the project's and the runner must not
write it. Both paths were checked live on 2026-08-18 against
`claude 2.1.234`, with `--dangerously-skip-permissions` in force and
`HERDR_ENV=1` set: the model issued `Skill(herdr)` and got back *"Skill
execution blocked by permission rules"*, recorded in `permission_denials`.
Bypass mode does **not** defeat a deny rule.

Settled 2026-08-18: `HERDR_ENV=1` **is** set inside a live AFK lane pane, on
both runtimes (`docs/findings.md` 3.3). The deny was closing a real hole.

**Landed (Phase 3, Lane I): the table's one `yes`.** `supervisor` in
`scripts/roles.mjs` carries `denySkills: []`, and it is the only role that does.
Two tests hold the asymmetry in both directions — `scripts/selftest.mjs` skips
it in the every-role deny loop and asserts its `[]` separately, and
`scripts/supervisor.test.mjs` walks `ROLES` asserting `denied === (name !==
'supervisor')` — so a later sweep that denies the skill everywhere for symmetry
fails loudly instead of silently blinding the one role whose job is to look at
panes.

The escape the deny closes for lane roles is closed differently here. A
supervisor has no lane to escape from, so instead of losing the skill it loses
the mutating `herdr` verbs: `Bash(herdr agent:*)`, `Bash(herdr worktree:*)`,
`Bash(herdr workspace create:*)`, `Bash(herdr workspace close:*)`,
`Bash(herdr pane rename:*)` — the five `scripts/runtime-herdr.mjs` itself uses to
change the pane layout. Reading a pane is untouched. **Not verified live:** which
`herdr` read verbs exist and whether any of them is a prefix of a denied one; the
deny list was written from the runner's own call sites, not from `herdr --help`.
