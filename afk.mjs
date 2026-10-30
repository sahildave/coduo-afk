#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Every command now pays for lib.mjs, because every command is argv-checked
// before it is spawned. `SPEC_VERSION` stays dynamic below: only `version`
// needs it.
import { BACKEND_ENV, RUNNER_VERSION, isMainModule, parseArgv, resolveBackend } from "./scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const commands = {
  validate: ["epic.mjs", null, ["validate"]],
  preflight: ["preflight.mjs"],
  epic: ["epic.mjs", null, ["epic"]],
  // The plan reviewer and the ticket reviewer on their own; `plan`/`ticket`
  // ride in as the first positional, as `wave`'s verbs do.
  review: ["review.mjs"],
  // `wave` is a verb group, not a command: the sub-verb rides in as the first
  // positional, so `wave.mjs` owns the `validate`/`run` split and the flag
  // table below stays one entry.
  wave: ["wave.mjs"],
  start: ["start.mjs"],
  auto: ["auto.mjs"],
  run: ["run.mjs"],
  status: ["status.mjs"],
  finish: ["finish.mjs"],
  merge: ["merge.mjs"],
  reset: ["reset-task.mjs"],
  salvage: ["salvage.mjs"],
  archive: ["archive.mjs"],
  measure: ["measure.mjs"],
  stats: ["agent-stats.mjs"],
  usage: ["usage.mjs"],
  stack: ["stack.mjs"],
  dashboard: ["dashboard-server.mjs"],
  ledger: ["ledger.mjs"],
  verify: ["verifier.mjs"],
  close: ["close.mjs"],
  supervise: ["supervisor.mjs"],
  heartbeat: ["heartbeat.mjs"],
  notify: ["notify-test.mjs"],
  // The chief of staff's CLI (#226), with the closeout's `fate` and `land`
  // and the machine-wide `hub`.
  cos: ["cos.mjs"],
  fate: ["fate.mjs"],
  land: ["land.mjs"],
  hub: ["hub.mjs"],
  selftest: ["selftest.mjs", "--test"],
};

// Verbs of one command that a different script owns.
const SUBCOMMAND_SCRIPTS = {
  measure: { dashboard: "measure-report.mjs", report: "measure-report.mjs" },
};

// The flags each subcommand accepts, beside the dispatch table because one
// enforcement point covers every subcommand and a table per script is how the
// enforcement rots. Derived from the help text below: a flag here with no help
// text is a flag no operator can discover, and scripts/argv.test.mjs fails on
// the drift for the commands it covers. `null` means "forward anything", and
// exists for `selftest` alone, whose tail is node's own `--test` arguments.
export const COMMAND_FLAGS = {
  validate: ["repo", "base", "json", "epic-body", "plan-review", "unattended"],
  preflight: ["runtime", "epic", "repo", "cos", "baseline", "base"],
  epic: ["repo", "base", "runtime", "worktree", "instructions", "task", "accept", "force", "delegate", "delegate-condition", "delegate-evidence", "delegated", "waive-user-facing", "epic-body", "unattended"],
  review: ["repo", "base"],
  wave: ["json", "base", "cap"],
  // `start` forwards its tail to `afk epic` verbatim, so its accepted set is
  // epic's; anything else would refuse in the child process, after the detach.
  start: ["repo", "base", "runtime", "worktree", "instructions", "task", "accept", "force", "delegate", "delegate-condition", "delegate-evidence", "delegated", "waive-user-facing", "epic-body", "unattended"],
  // The dev/test entry points. `auto` and `run` take flags the help text
  // summarises rather than lists (`--instructions=`, `--epic-base=`,
  // `--refresh-auth`, `--dry-run`): they are read by scripts/auto.mjs and
  // scripts/run.mjs today, and refusing them here would break working commands.
  auto: ["dag", "base", "task", "runtime", "instructions", "accept", "force", "epic-base", "refresh-auth"],
  run: ["task", "dag", "base", "runtime", "dry-run"],
  status: [],
  finish: ["discard-untracked"],
  merge: ["repo", "root", "dry-run", "wait"],
  reset: ["root"],
  salvage: ["commit", "lesson", "root"],
  archive: ["force"],
  measure: ["project", "days", "json"],
  stats: ["efficiency", "json"],
  usage: ["month", "json"],
  stack: ["json", "write", "dry-run"],
  dashboard: [],
  ledger: ["type", "source", "text", "applies-to", "json", "full"],
  verify: ["repo", "base", "reuse", "json", "markdown", "full"],
  close: ["redo", "repo", "base"],
  supervise: ["question", "context", "task", "dag", "consult", "json"],
  heartbeat: ["watch", "interval", "stall"],
  notify: ["workspace"],
  cos: ["mode", "kind", "ttl", "purpose", "notes-file", "auto", "id", "title", "why", "option", "rec", "from", "file", "append"],
  fate: ["epic", "finding", "accepted", "fixed", "dropped", "reason", "by"],
  land: ["repo", "dry-run"],
  hub: ["port", "out", "url", "in", "snapshot"],
  selftest: null,
};

// Commands whose `--root=<path>` is handled here: the script runs with that
// directory as its cwd, so an Orchestrator runs `afk salvage 548 --root=<epic
// checkout>` bare instead of `cd <epic> && afk ...`. A cd outside its working
// directories takes the command out of allow-rule matching and to the auto-mode
// classifier, which refused `afk salvage 548` on 2026-10-12. `afk merge` reads
// its own --root and is not listed.
const ROOT_AS_CWD = new Set(["reset", "salvage"]);

// Commands whose tail after `--` is another program's argv (`afk cos run --ttl=5
// --purpose=x -- sleep 60`): only the part before `--` is checked against the
// flag table, and the script receives everything.
const DASHDASH_TAIL = new Set(["cos"]);

// Per-subcommand usage, keyed by `commands` above. `afk verify --help` prints
// this one section; the manual is ~170 lines and discovering one flag used to
// cost all of them, which a supervising agent pays for in context every time.
// A key here with no entry is a subcommand no operator can discover, and
// scripts/argv.test.mjs fails on it.
export const HELP_SECTIONS = {
  validate: `  validate <issue>             Check a GitHub epic's \`afk:\` block and print the
                               graph's depth and blast radius. Creates NOTHING:
                               no branch, no worktree, no .afk/, no issue edit.
                                 --repo=<owner/name>  default: the current repo
                                 --base=<branch>      default: main
                                 --json               machine-readable report
                                 --epic-body=<path>   check a local block against
                                       this epic's real sub-issues without
                                       writing it to the issue first
                                 --plan-review        opt in to the semantic
                                       tier: one read-only agent reads the epic
                                       and every child issue and reports
                                       contradictions. Costs tokens and needs a
                                       live login; without it \`validate\` stays
                                       deterministic, offline and free.
                                       \`afk epic\` always runs it.
                                 --unattended         refuse unless nobody will
                                       be needed: runs the plan review, and
                                       exits 0 only when it passes and every
                                       stop in the stop forecast has an answer
                                       in the afk: block's \`stops:\`. Last
                                       line: \`UNATTENDED: ready\` or
                                       \`UNATTENDED: refused: <reason>\`.`,
  review: `  review plan <epic> [--repo=] [--base=]
  review ticket <issue> [--repo=]
                               Run a reviewer on its own, at any time, without
                               a branch or a worktree. Read-only: the transcript
                               goes to $TMPDIR. Exit 1 on a refusing finding.
                               \`plan\`: the whole plan review \`afk epic\` runs
                               (all five questions), after the deterministic
                               tier. Shares the carry-forward store with
                               \`afk validate --plan-review\` and \`afk epic\`.
                               \`ticket\`: only the fifth question, on one
                               issue: does it contradict itself (a ruling or
                               waiver against a criterion or red test that
                               still says the old thing)? Prints both passages.
                               Run it after any ticket edit, mid-run included.
                                 --repo=<owner/name>  default: the current repo
                                 --base=<branch>      \`plan\` only: the base
                                       the epic's branch is checked against.
                                       Default: the base the epic recorded in
                                       .afk/state.json, else main. A branch
                                       the base has moved past (other epics
                                       merged) prints a warning; the review
                                       still runs.`,
  preflight: `  preflight [--runtime=] [--epic=] [--repo=] [--baseline [--base=]]
                               Run the probes a run makes before it spawns any
                               lane, in this checkout, and exit 1 on any
                               blocker: the agent login, \`requiredEnv\`, every
                               \`preflight.probes\` command, the herdr server
                               (herdr runtime only), each port
                               \`preflight.ports\` prints for this checkout
                               (named with the pid holding it), and the disk
                               floor; with an \`infisical run\` gate, the
                               Infisical login; with --epic and a ticket that
                               names agent-device/XCUITest, a macOS
                               automation session (off: preflight.macAutomation:
                               false) plus a Keychain warning. Run it before a
                               launch and before a relaunch. Fixes nothing and kills nothing.
                               Not offline: it runs project commands and one
                               trivial agent prompt — \`afk validate\` runs none.
                                 --runtime=direct|herdr  default: agent.runtime,
                                       then direct
                                 --epic=<issue>  read its tickets for the UI checks
                                 --repo=<owner/name>  default: the current repo
                                 --cos  also check that every afk verb a
                                       chief-of-staff run plans (\`afk cos\`,
                                       \`afk cos stop\`, \`afk land\`) is named
                                       in ~/.claude/settings.json autoMode.allow
                                       or the owner's owner-settings.json, and
                                       print the exact lines to add. Outside a
                                       configured checkout it checks only that.
                                       It does not run --baseline: that is
                                       minutes per repo under the gate lock.
                                 --baseline  also run the baseline gate now:
                                       every \`baselineChecks\` command (else
                                       \`defaultChecks\`), each one even after a
                                       red, on the base branch in a throwaway
                                       worktree, under the gate lock and the
                                       Infisical probe. Prints pass/fail per
                                       command with the tail of each failure;
                                       exit 1 if any fails. Use it instead of
                                       running a hand-picked check on the base.
                                 --base=<ref>  the branch --baseline runs on;
                                       default: main`,
  epic: `  epic <issue> [--base=]       Validate, create the epic's branch, and run it.
                                 --repo=<owner/name>  default: the current repo
                                 --runtime=direct|herdr
                                 --worktree
                                       Run the epic in a worktree of its own
                                       (~/code/worktrees/<clone>/epic/<id>/<clone>,
                                       <clone> being the local clone's directory
                                       name; a run already standing in the old
                                       ~/.afk-claude/epics/ keeps it) instead
                                       of taking this checkout over. The branch,
                                       .afk/, the dashboard and the integrator
                                       all move there, so this checkout stays
                                       yours and a second epic can run beside
                                       this one. Reused on a restart.
                                 --instructions="<text>"
                                       One free-form, epic-wide string added as
                                       extra context to every lane prompt, and
                                       persisted to .afk/state.json so a restart
                                       still carries it. Additive only: it
                                       cannot relax a gate, and a restart that
                                       supplies a different string is refused.
                                 --task=<id>
                                       Release that one \`gate: before\` gate and
                                       run only it. Re-fetches and re-validates
                                       the epic first, so a graph that moved
                                       while you were deciding stops the
                                       release. This is the epic-path equivalent
                                       of \`afk run --task=\`, which needs a --dag
                                       file the epic path deliberately never
                                       writes.
                                 --accept=<id>[,<id>]
                                       Accept a \`gate: after\` task: the work
                                       already ran and merged, and this is the
                                       human saying it is good, so the epic may
                                       close on it. Recorded once and survives a
                                       restart; a task that leaves \`passed\`
                                       loses its acceptance. Refused unless the
                                       newest closeout review ran at the branch
                                       head; run \`afk epic <issue>\` without it
                                       to get one. A later review that returns
                                       must-fix puts the gate back to
                                       awaiting_acceptance.
                                 --force
                                       With --accept only: accept without a
                                       closeout review at the branch head.
                                 --delegate=<id>[,<id>] --delegate-condition="<text>"
                                       Let the delegate accept those \`gate: after\`
                                       tasks, under that condition, when every
                                       merge guardrail passes at the park.
                                       Saved in .afk/state.json. Additive: a
                                       restart may delegate another gate, and
                                       one that changes a delegation is refused.
                                       Refused for a task that is not \`gate:
                                       after\`, or with no condition.
                                 --delegate-evidence=walkthrough
                                       The delegate must also attach a
                                       walkthrough of the gate's checklist
                                       under ~/.afk-claude/acceptance/.
                                 --waive-user-facing="<reason>"
                                       A launched project's user-facing change
                                       may pass the guardrail on this reason.
                                 --delegated
                                       With --accept only: accept a delegated
                                       gate now, if every guardrail passes.
                                       Refused for a gate nobody delegated, and
                                       with --force.
                                 --epic-body=<path>
                                       Run the epic from a local body file
                                       instead of the issue's, still against its
                                       real sub-issues — the \`validate\` flag,
                                       usable on \`epic\` too.
                                 --unattended
                                       After the plan review and before the
                                       branch: refuse unless every stop in the
                                       stop forecast has an answer in the afk:
                                       block's \`stops:\`. Nothing is created
                                       on a refusal.`,
  wave: `  wave validate <dir>          Check a markdown task directory — GOAL.md plus
                               tasks-todo/*.md and tasks-done/*.md, which are
                               one graph — and print the graph it loads, marking
                               the tasks already filed as done.
                               Creates NOTHING: no branch, no worktree, no
                               .afk/. Refuses the WHOLE directory, naming every
                               problem and the file and key it is in; a warning
                               at 3am is a warning nobody reads.
                                 --json               the DAG JSON, ready for
                                       \`afk auto --dag=\`, or the refusal list
  wave run <dir> --base=       Run the whole directory unattended, one wave at a
                               time. Each wave is cut from the base branch, run
                               in its own worktree, and fast-forwarded back onto
                               the base only when every task reached a terminal
                               outcome and the base is still an ancestor of the
                               wave branch — never \`--force\`. Writes a digest
                               per wave to docs/afk-runs/wave-NN.md and its only
                               state to <dir>/.wave-log.json, and files each
                               passed task's file under <dir>/tasks-done/ — all
                               three committed to the base branch as one
                               bookkeeping commit, and only when the wave
                               merged. Re-running resumes: merged waves
                               are skipped, anything else re-runs from its
                               recorded sha.
                                 --base=<branch>      required; the branch waves
                                       land on, and the branch this checkout
                                       must be on. No default, because a
                                       hardcoded \`main\` is how a wave lands on
                                       a stale base without saying so.
                                 --cap=<n>            tasks per wave; default 12
  wave accept <dir> <task-id>   Accept a blocked ledger record as a terminal
                               no-op. The task stays satisfied across resume.
  wave stop                     Signal every lane pid in this checkout's run
                               state and print each verified fate.
                               See docs/wave-mode.md.`,
  start: `  start <issue>                One terminal, one epic. Starts the epic's
                               orchestrator DETACHED — it outlives this terminal
                               and the Claude session in it — then prints the
                               run's identity and opens an interactive \`claude\`
                               session in this checkout, so there is always an
                               agent to ask about the run.
                                 Every other argument is forwarded verbatim to
                                       \`afk epic\`, so --repo=, --base=,
                                       --runtime=, --instructions= and the
                                       --delegate flags mean exactly what they
                                       mean there.
                                 --unattended         forwarded to \`afk epic\`:
                                       refuse before the branch unless every
                                       stop in the stop forecast is answered.
                                 The dashboard port is whatever the run itself
                                       resolves and records; this reads it back
                                       and reports it, and never picks one.
                                 Refuses on STDOUT, with the remedy named, if
                                       \`claude\` is not on PATH, if an
                                       orchestrator already holds this checkout,
                                       or if the run dies before it reports.`,
  auto: `  auto --dag=<path> [--base=]  Run all automatically runnable DAG tasks
                               (--dag is a JSON file of { epic, branch, tasks };
                               --base integrates into a non-main branch, and it
                               must be the currently checked-out branch)
                                 --task=<id>          release one gated task
                                 --runtime=direct|herdr
                                 --instructions="<text>"  epic-wide extra context
                                 --accept=<id>[,<id>] accept a \`gate: after\`
                                 --force              with --accept: accept
                                       without a closeout review at head
                                 --epic-base=<branch> the branch the epic's own
                                       feature branch was cut from
                                 --refresh-auth       re-check the claude login
                                       before the first lane starts`,
  run: `  run --task=<id> --dag=<path> Run one task, including a human-gated task
                                 --base=<branch>      integrate into this branch
                                 --runtime=direct|herdr
                                 --dry-run            print what the run would do
                                       and spawn nothing`,
  status: `  status                       Show the current run's tasks and runtime state,
                               including a full gate waiting on another epic's
                               gate lock (one full gate at a time per machine;
                               \`gateLock: false\` in config turns it off)`,
  finish: `  finish                       End-of-run checklist for a run whose tasks have
                               all stopped: print the closeout review already on
                               disk, remove the lane worktrees and branches the
                               run left behind, and print the merge command.
                               From an \`afk epic --worktree\` checkout whose
                               tasks all passed, also remove that checkout and
                               its epics/<slug>-<id>/ folder (build output
                               included), keeping .afk/ under the main
                               checkout's .afk/archive/epic-<id>/.
                               Local and reversible only — it MERGES NOTHING and
                               spawns no agent. Refuses while \`afk auto\` holds
                               the lock, while any lane is still moving, or while
                               a \`gate: after\` is unaccepted.
                                 --discard-untracked  remove a lane worktree that
                                       still holds untracked files, instead of
                                       refusing and naming them`,
  merge: `  merge <epic> [--root=] [--dry-run] [--wait[=]]
                               Merge the epic's PR when every guardrail passes.
                               Prints each as \`PASS|FAIL|WAIT <name>: <evidence>\`.
                               Any FAIL or WAIT: one PR comment, exit 1. All
                               pass: \`gh pr ready\` for a draft, then
                               \`gh pr merge <n> --<method> --match-head-commit
                               <sha>\`, the health probe, and the landing
                               (issues closed, remote branch deleted, lanes
                               pruned, a clean epic worktree removed). Exit 2:
                               merged, health probe red; revert by hand. One
                               merge per machine at a time; refuses inside a
                               lane. No flag skips a guardrail.
                                 --root=<path>        the epic's run root (the
                                       checkout, or the --worktree checkout);
                                       default: the current directory
                                 --repo=<owner/name>  default: the current repo
                                 --dry-run            print the guardrails and
                                       the command; write nothing
                                 --wait[=<hours>]     default 8: while only
                                       WAIT guardrails stand, poll every five
                                       minutes; a FAIL exits at once`,
  reset: `  reset <id> [<id>...] [--root=]
                               Reset tasks to pending
                                 --root=<path>        run against this checkout
                                       (an --worktree epic's checkout) instead
                                       of the current directory`,
  salvage: `  salvage <id> [--commit=<sha>] --lesson=<lesson> [--root=]
                               Integrate a lane branch someone fixed after its
                               builder finished, without rebuilding it. Re-runs
                               the lane's checks at the branch tip, in the lane
                               worktree, writes a fresh verification note there
                               and marks the task ready_to_integrate; relaunch
                               the run to merge it. The checks are the ones the
                               builder's note recorded, else defaultChecks.
                               A red check writes nothing. A tip already
                               verified runs no checks and keeps its note; it
                               is only marked ready_to_integrate. Refuses while
                               \`afk auto\` holds the lock, when the task
                               already succeeded, when a dependency has not,
                               when the builder's note does not parse, or when
                               the worktree has uncommitted changes (commit
                               them on the lane branch first).
                               \`afk reset\` instead would rebuild it. A
                               hand-made commit meets only these checks and the
                               post-merge gate, not the builder's protected-path
                               and lane-boundary checks.
                                 --root=<path>        run against this checkout
                                       (an --worktree epic's checkout) instead
                                       of the current directory
                                 --commit=<sha>       refuse unless the branch
                                       tip is this commit
                                 --lesson=<lesson>    required: what the fix
                                       teaches, as the closeout fixer's lessons
                                       do. rule:<id>:<file>:<redOn>,
                                       standard:"<line>" or none:"<reason>".
                                       Recorded in state as a defect found
                                       mid-run and listed in the closeout`,
  archive: `  archive [--force]            Put this checkout's finished run away, all of it,
                               under .afk/archive/epic-<id>/. \`.afk/\` holds one
                               run, so this is what a second epic in the same
                               checkout needs first — and \`afk epic\` does it for
                               you when the previous epic finished. MOVES, never
                               deletes, and leaves the tracked epic-ledger.yaml
                               alone. --force archives an unfinished epic.
                               (\`afk epic --worktree\` sidesteps this entirely:
                               each epic gets its own .afk/.)`,
  stack: `  stack detect [--json]        What this project is built with, and the
                               \`roles:\` block that follows from it. Reads
                               .claude/settings.json (the plugins this repo
                               enabled) and package.json. Runs no agent,
                               needs no login, and WRITES NOTHING: it prints
                               a proposal for you to paste or edit. Every skill
                               name in the proposal is resolved against this
                               host first.
  stack lint [--json]          Check the skill names in the COMMITTED
                               .afk-setup/config.yaml against this host and
                               report the ones that are named, not installed.
                               A name that does not resolve reaches an agent
                               and fails silently as "no such skill", which is
                               why nobody notices. Exits non-zero on a dead
                               name. Writes nothing.
                                 HOST-DEPENDENT: it answers "can this machine
                                 load these names", so a partner's machine
                                 legitimately reports names only the owner has.
                                 Never put it in defaultChecks.
  stack suggest [--dry-run]    The WIDE proposal: every installed skill a lane
                               here can reach, scored against this repo by Jev
                               (TYPESAFE_API_KEY required) and returned as
                               \`offer\` lists to MERGE into config.yaml. Where
                               detect proposes from enabled plugins, this
                               proposes from installed skills — which is the
                               only sanctioned way to widen an offer list on a
                               repo whose block was written by hand.
                                 Candidates are resolved against this host
                                 BEFORE they are scored, so a proposal never
                                 contains a name a lane cannot load. offer
                                 only: never always, never notes. Writes
                                 nothing. Names you reject go in
                                 .afk-setup/suggest-ignore.txt.
                                 No Jev, no output: it exits non-zero rather
                                 than falling back to detect.
                                 --dry-run shows the roster and every exclusion
                                 without calling Jev or spending anything.
                                 --write merges the proposal into config.yaml:
                                 a set union into \`offer\` per role, textual so
                                 every comment survives, never removing a name
                                 and never touching \`always\` or \`notes\`. It
                                 refuses an absent role, refuses a role with no
                                 \`offer:\` key, and refuses outright if
                                 .afk-setup/ is already dirty — checked BEFORE
                                 the model is called. Then it prints the commit
                                 line and stops; an uncommitted config reaches
                                 no lane worktree.
  stack manifest [--write]     Regenerate plugin-skills.json — the committed
                               record of which invocable names each plugin the
                               catalogue references actually ships. Read from
                               this host's install cache, falling back to the
                               marketplace checkout. Prints unless --write. A
                               plugin present on neither keeps its hand-written
                               entry verbatim and is reported as unverified.`,
  stats: `  stats [<id>...]              Show live/final agent stream statistics
                                 --efficiency  add a per-run efficiency report
                                       from the Claude stream's per-message
                                       usage: turns, tools, output split
                                       (estimate), cache use, cost units,
                                       first-call context share, env retries
                                       and attempts. An id may also be a
                                       path to a session transcript .jsonl
                                 --json        the efficiency report as JSON`,
  usage: `  usage [--month] [--json]     Token usage and cost of every AFK agent session
                               (any role, live or finished) at API prices, by
                               role, model, project, epic and lane, read from
                               the Claude Code transcripts. Spend is checked
                               against AFK_USAGE_BUDGET_USD (default 200)
                                 --month  month to date (UTC) only
                                 --json   the full report as JSON`,
  dashboard: `  dashboard                    Serve the live dashboard (PORT defaults to a port
                               derived from this checkout's path). /lanes.html
                               shows context and tool calls per lane;
                               /usage.html shows spending`,
  notify: `  notify [--workspace=<id>]    Fire one test notification and report which path
                               delivered it. macOS grants notification
                               permission per app, so a never-granted
                               terminal-notifier fails silently — this is the
                               only way to find that out.`,
  ledger: `  ledger add|list              Record and read cross-lane findings in
                               .afk/epic-ledger.yaml. The runner performs the
                               write; agents never rewrite the file.
                                 add  --type=<slug> --source=<id> --text=<s>
                                      [--applies-to=<id,id>]  tasks whose lane
                                      prompt should carry this entry
                                 list [--applies-to=<id>] [--type=<t>]
                                      [--source=<id>] [--json] [--full]
                                      Truncates to the newest entries and says
                                      how many it withheld; --full prints them
                                      all. A busy ledger otherwise floods the
                                      session that asked one question.`,
  verify: `  verify <issue>               Run the epic's closeout review: /code-review over
                               the integrated feature branch, checked against the
                               acceptance criteria in its child issues. Read-only,
                               and ADVISORY — it writes a structured report under
                               .afk/verifier/<issue>/ and marks nothing complete.
                                 --repo=<owner/name>  default: the current repo
                                 --base=<branch>      the fixed point; default main
                                 --reuse              return the report already on
                                       disk instead of paying for a second review
                                 --json | --markdown  machine / issue-ready output
                                 --full               print the whole report
                                       instead of the truncated head this
                                       prints by default`,
  close: `  close --redo <issue>         Redo a CLOSED epic's closeout at the branch's
                               current head: the closeout verifier, the fix
                               pass and its gate, written to the run state and
                               reports \`afk merge\` judges. The earlier review,
                               fix report and gate are kept (state.epicClose.redos
                               and .afk/epic-close/<issue>/redo/). Posts nothing
                               to the issue. Refuses while a run holds the lock,
                               a lane is in flight, a gate runs or waits, or the
                               epic is not closed.
                                 --redo               required
                                 --repo=<owner/name>  default: the current repo
                                 --base=<branch>      the fixed point; default main`,
  supervise: `  supervise <event>            Judge one run event — or answer a question about
                               the run in plain language. READ-ONLY and ADVISORY:
                               it proposes \`afk\` commands and changes nothing.
                               The runner owns the queue and the passed/failed
                               transitions whatever this says.
                                 <event>  lane_failed | integration_failed |
                                          lane_blocked | gate_reached |
                                          epic_ended | question
                                 --question=<text>   for \`question\`
                                 --context=<file>    the event's context as JSON
                                 --task=<id> --dag=<path>
                                 --consult=auto|always|never
                                       auto (default) spends a session only when
                                       the runner's own reading is ambiguous
                                 --json              machine-readable decision`,
  heartbeat: `  heartbeat [--watch]          Notify when this project's run dies or stalls
                                 --watch              keep checking until stopped
                                 --interval=<seconds> between checks; default 300
                                 --stall=<minutes>    quiet time that counts as a
                                       stall; default is derived from the run`,
  measure: `  measure backfill <path>      Build one close row for docs/measure from an
                               existing run: a project's .afk/ folder, or an
                               archive at .afk/archive/epic-<id>/. Fields the
                               files cannot answer are null, never guessed.
                               Appends to docs/measure/<project>.jsonl
                               (AFK_MEASURE_ROOT overrides the root); commits
                               nothing.
                                 --project=<name>     default: the GitHub repo
                                       of the checkout holding <path>
  measure dashboard            Write docs/measure/dashboard.html: inline SVG
                               graphs, one point per epic, with a project
                               filter. Regenerated every run; never edit it.
  measure report [--days=N] [--json]
                               Compare the last N days (default 7) with the N
                               days before, number by number, and say whether
                               each moved the better way. Reports, never
                               gates: exit 0 either way.
                                 --project=<name>     only this project's rows`,
  cos: `  cos start --mode=day|night [<epic>...]
                               Open a chief-of-staff run: check the allow lines
                               (\`afk preflight --cos\`), install the launchd
                               check-in (every 25 min by day, 45 at night),
                               adopt every epic already running, print the hub
                               URL. One run open at a time.
  cos log --kind=<kind> "<text>"
                               Append to the store, timestamped by the CLI.
                               Kinds: note, decision, grant, comment,
                               owner_intervention.
  cos ask --id=<slug> --title="<question>" [--why="<context>"]
      --option="<value>|<label>|<detail>"... [--rec=<value>]
                               Post a question to the hub's Needs you, with the
                               --rec option pre-checked. It stays until a hub
                               response answers [ask:cos:<id>]. An id is
                               asked once per run.
  cos ask --id=<slug> --title="<question>" --from=orch-<n> [--option=...]...
                               An Orchestrator's question to the chief of
                               staff; options are optional. \`cos checkin\`
                               prints it first, with its age, and the hub's
                               Needs you shows it as a card the owner can answer
                               in words (Respond queues them for cos, tagged
                               [ask:cos:<id>]), until \`cos answer\` closes it.
  cos answer --id=<slug> "<text>"
                               Close an ask and record the answer, in the open
                               run or, after stop, the newest. It does not
                               deliver it: relay it into the asking session.
  cos report --file=<path.md> [--append]
                               Store the morning report as report.md in the
                               open run, or the newest run when none is open.
                               --append adds it under "## Addendum <time>"
                               (with no report yet, it is the report).
                               Text before the first "## <repo>#<epic>" is the
                               summary; each such section is a hub card with
                               a Copy prompt for a chat in that checkout.
  cos plan --file=<plan.json>
                               Store tonight's planned rows in the open run;
                               the hub draws them as "Tonight's plan" beside
                               each epic's actual bars. JSON: {"epics": [{
                               "epic", "label", "launch", "project"?,
                               "caption"?, "phases": [{"kind", "start",
                               "minutes", "label"?, "caption"?}]}]}. Times
                               are ISO with a zone; kind is build, gate-human,
                               baseline, closeout or parked. A later plan
                               replaces it.
  cos run --ttl=<min> --purpose="<why>" -- <cmd>...
                               Start a background process and register its pid,
                               start time, owner, purpose and TTL. The only way
                               a session starts a poller or timer.
  cos checkin                  One check-in, no model and no session messages:
                               every run's state, the gate lock, Orchestrator
                               idle times, PR and Vercel status and
                               vercel-deploys-left. Appends one checkin event;
                               notifies on a stall, an open gate, a red deploy
                               or a finished run.
  cos handoff <session> [--notes-file=<path>] | --auto <session>
                               Write the derived handoff (pointers and state
                               from the store, the hub inbox and /peers) to
                               <run>/handoffs/ and print it. Notes: at most
                               8000 characters. --auto is the Stop-hook form:
                               it writes only at 150k context with work open.
  cos stop                     Kill every registered process (never a pid whose
                               start time changed), check each is gone, unload
                               the check-in and close the run. The summary
                               counts owner interventions.
                               Store: ~/.afk-claude/cos/<run>/ (AFK_COS_ROOT).`,
  fate: `  fate <epic> <finding> --accepted|--fixed|--dropped --reason="<why>" [--by=]
                               Record a closeout finding's fate in
                               .afk/fates/<epic>.jsonl; with no finding, list
                               the findings and their fates. --epic= and
                               --finding= are accepted too.`,
  land: `  land <pr> [--repo=] [--dry-run]
                               Merge a non-epic PR once CI is green, it is not
                               a base-branch push, and the owner approved it.
                               With \`land: { ownerApproval: delegated }\` in
                               .afk-setup/config.yaml the approval is not
                               needed (an owner request for changes still
                               blocks), and the PR gets a comment recording
                               the delegation.`,
  hub: `  hub [install|uninstall|queue <target>|ack <target> <id>...] [--port=]
                               Serve the machine-wide hub on 127.0.0.1:4099,
                               install or remove its launchd agent, or read and
                               acknowledge a target's queued comments.
  hub snapshot --out <file>    Write one hub snapshot for the hub artifact;
                               prints its doc_id.
  hub artifact --out <file> | --url <url>
                               Write the hub artifact page source, or save the
                               published hub artifact's URL machine-wide.
  hub threads --in <threads.json> [--snapshot <file>]
                               One action per hub artifact comment thread.`,
  selftest: `  selftest                     Test this runner without real agent calls`,
  version: `  version                      Print this runner's version and the \`afk:\` block
                               spec version it supports. The two are separate:
                               the runner is 2.x, the spec is still 1. Breaking
                               changes for consuming projects: CHANGELOG.md.`,
};

const HELP_BANNER = `coduo-afk — package-free parallel task runner

Usage:
  node /path/to/coduo-afk/afk.mjs <command> [arguments]

Commands:`;

// `afk help` stays the whole manual: the index does not stop being useful
// because the sections became addressable.
export const fullHelp = () =>
  [
    HELP_BANNER,
    Object.values(HELP_SECTIONS).join("\n"),
    "",
    "Run project commands from the project root. No package.json is required.",
  ].join("\n");


// The executables' names, keyed by the backend each one selects. Both are this
// same file: `afk` is the Claude entry point, `afk-codex.mjs` imports `main`
// below and passes the other backend. There is one dispatch table, one flag
// table and one manual, because a copied dispatcher is two that drift.
const EXECUTABLES = { claude: "afk-claude", codex: "afk-codex" };

/**
 * The dispatcher. The backend is chosen ONCE, by the executable the operator
 * ran — `afk` passes nothing (Claude), `afk-codex` passes "codex" — and rides
 * into every subcommand this spawns in `AFK_BACKEND`, where `resolveBackend`
 * reads it back. That env var is the single source of truth: an omitted
 * `backend` here falls through to it, so a nested `afk.mjs` — a wave's `auto`,
 * say — inherits the parent's choice instead of silently resetting to Claude.
 */
export const main = async (argv, { backend } = {}) => {
  // Resolve against AFK_BACKEND when the caller passed nothing, and fail here —
  // before anything is spawned — on a backend nobody implements.
  const selectedBackend = resolveBackend(backend);
  // Bare `afk` runs `status`, not `help`: the commonest question about a run is
  // "what is happening", and the manual is ~170 lines of context that answers
  // it with something else. `help`, `--help` and `-h` still print the manual.
  const [command = "status", ...args] = argv;
  // Both versions, always, because they are two clocks and reading one as the other
  // is the mistake this command exists to prevent: the RUNNER is 2.x, the `afk:`
  // block schema an epic author types is still version 1. `SPEC_VERSION` is
  // imported dynamically so no other command pays for epic-spec.mjs.
  if (command === "version" || command === "--version" || command === "-v") {
    const { SPEC_VERSION } = await import("./scripts/epic-spec.mjs");
    console.log(`${EXECUTABLES[selectedBackend]} ${RUNNER_VERSION}`);
    console.log(`epic spec version: ${SPEC_VERSION} (the \`afk:\` block; unchanged by the v2 runner)`);
    process.exit(0);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(fullHelp());
    process.exit(0);
  }

  const selected = commands[command];
  // Refusals go to STDOUT, like `afk start`'s: a supervising agent reads stdout,
  // and a decline it cannot see is a command that failed for no stated reason.
  // The exit status is unchanged — only the channel moves.
  if (!selected) {
    console.log(
      `Unknown command: ${command}. Run with "help" for available commands.`,
    );
    process.exit(1);
  }

  // `afk <command> --help` prints that command's section and nothing else, and
  // is answered here rather than by the subcommand script: every script would
  // otherwise need its own flag, and the ones that have none would print the
  // manual or nothing. Checked before the flag table, which does not list
  // `--help` for anybody.
  if (args.includes("--help") || args.includes("-h")) {
    const section = HELP_SECTIONS[command];
    // A dispatched command with no usage text is undiscoverable. Say so and
    // exit non-zero rather than printing an empty help that reads as success.
    if (!section) {
      console.log(`afk ${command}: no usage text. Add a HELP_SECTIONS entry in afk.mjs.`);
      process.exit(1);
    }
    console.log(section);
    process.exit(0);
  }

  // Fail loud on a flag this subcommand does not know, BEFORE anything is
  // spawned: a typo forwarded verbatim is silently ignored by the script that
  // receives it, and the run proceeds with the operator's intent dropped.
  const acceptedFlags = COMMAND_FLAGS[command];
  let parsed = null;
  if (acceptedFlags) {
    try {
      const dash = DASHDASH_TAIL.has(command) ? args.indexOf("--") : -1;
      parsed = parseArgv(dash === -1 ? args : args.slice(0, dash), acceptedFlags, { command });
    } catch (error) {
      console.log(`afk: ${error.message}`);
      process.exit(1);
    }
  }
  let cwd = process.cwd();
  if (ROOT_AS_CWD.has(command) && parsed?.flags.root !== undefined) {
    const root = parsed.flags.root === true ? "" : resolve(parsed.flags.root);
    if (!root || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.log(`afk: --root=${parsed.flags.root === true ? "" : parsed.flags.root} is not a directory`);
      process.exit(1);
    }
    cwd = root;
    args.splice(0, args.length, ...args.filter((arg) => arg !== "--root" && !arg.startsWith("--root=")));
  }

  const [defaultScript, mode, prefix = []] = selected;
  // `afk measure backfill` writes rows (measure.mjs); `dashboard` and `report`
  // read them back (measure-report.mjs). One verb group, two scripts.
  const script = SUBCOMMAND_SCRIPTS[command]?.[args[0]] ?? defaultScript;
  // `afk selftest` runs the whole suite: the main harness plus every
  // scripts/*.test.mjs file, so a new test file is picked up by adding the file.
  const scriptsDir = resolve(here, "scripts");
  const testFiles =
    mode === "--test"
      ? [
          resolve(scriptsDir, script),
          ...readdirSync(scriptsDir)
            .filter((name) => name.endsWith(".test.mjs"))
            .sort()
            .map((name) => resolve(scriptsDir, name)),
        ]
      : null;
  const nodeArgs = testFiles
    ? // Cap file-level parallelism at half the cores: 26 of the 39 files spawn
      // child processes, so at the default (one file per core) the suite over-
      // subscribes and tests with tight deadlines (herdr 8s, fixer 10s) lose
      // whichever one is scheduled during a load spike — the #98 flake.
      ["--test", `--test-concurrency=${Math.max(2, Math.floor(availableParallelism() / 2))}`, ...testFiles, ...args]
    : [resolve(scriptsDir, script), ...prefix, ...args];
  // Lane worktrees live outside the repo (see worktree.mjs `worktreeRoot`), so a
  // test that builds a throwaway repo in $TMPDIR still writes lanes into the real
  // ~/.afk-claude/worktrees. Removing the temp repo does not remove them, and they
  // are keyed by a path that will never exist again — thousands of orphans built up
  // this way. Point the whole suite at one directory the suite itself deletes.
  const suiteWorktrees = testFiles
    ? mkdtempSync(join(tmpdir(), "afk-suite-worktrees-"))
    : null;
  // The backend travels to the subcommand in the environment: every script
  // under scripts/ is shared by both executables, and this is the one channel
  // that reaches them all without a flag on each.
  const env = { ...process.env, [BACKEND_ENV]: selectedBackend };
  // Unattended lanes have no human to read a "run /compact" hint, and their
  // transcripts (private-repo code) should not ship to TypeSafe. Disable the
  // compact-adviser plugin for the runner and every lane it spawns
  // (worker.mjs inherits this env verbatim). Only defaulted, so an explicit
  // COMPACT_ADVISER_DISABLE in the launch environment still wins.
  if (env.COMPACT_ADVISER_DISABLE === undefined) env.COMPACT_ADVISER_DISABLE = "1";
  if (suiteWorktrees) {
    env.AFK_WORKTREE_ROOT = suiteWorktrees;
    env.AFK_EPIC_ROOT = join(suiteWorktrees, "epics");
    // A test that clears both overrides to measure the default layout, or a
    // child that drops them, falls back to the home's ~/code/worktrees.
    // worktree.mjs swaps the real home for this one under the test runner.
    env.AFK_TEST_HOME = join(suiteWorktrees, "home");
    // A test that reaches a launch or close must not append a row to the
    // runner's real docs/measure (scripts/measure.mjs).
    env.AFK_MEASURE_ROOT = join(suiteWorktrees, "measure");
    // The plan reviewer's carry-forward store (scripts/plan-review.mjs) lives
    // under ~/.afk-claude; a test's refusing finding must not reach the real
    // one, nor carry into another test's review.
    env.AFK_PLAN_REVIEW_STORE = join(suiteWorktrees, "plan-review");
    // The lane context trim reads the host's plugins, skills and CLAUDE.md
    // files (scripts/lane-context.mjs). Under the suite that host is an empty
    // directory, so no assertion depends on what this machine has installed.
    env.AFK_CONTEXT_HOME = join(suiteWorktrees, "context-home");
    // The machine-wide gate lock (scripts/gate-lock.mjs) lives in the runner's
    // home. A suite gate must neither wait on a real epic's gate nor hold one up.
    env.AFK_GATE_LOCK_DIR = join(suiteWorktrees, "gate-lock");
    // Every dashboard a suite test starts warms its lanes view by reading the
    // Claude transcripts (scripts/usage.mjs) and rewriting the lanes cache
    // (scripts/lanes.mjs). Not this machine's ~15k transcripts, nor its cache.
    // The directory need not exist: a missing root scans as empty.
    env.AFK_TRANSCRIPTS_ROOT = join(suiteWorktrees, "transcripts");
    env.AFK_LANES_CACHE = join(suiteWorktrees, "lanes-cache.json");
    env.AFK_USAGE_CACHE = join(suiteWorktrees, "usage-cache.json");
    // The chief of staff's store (scripts/cos/store.mjs): a suite test must
    // never open, read or close a real run.
    env.AFK_COS_ROOT = join(suiteWorktrees, "cos");
    // Nor wait for the host to quiet (#223): the suite's own parallel files are
    // the load. A test that exercises the wait sets its own threshold.
    env.AFK_QUIET_HOST_LOAD = "off";
    // The self-test suite asserts BOTH backends explicitly, so it must not be
    // reconfigured by whichever executable launched it — otherwise
    // `afk-codex selftest` would fail every Claude command assertion, and the
    // Claude backend would go untested exactly when it was changed.
    delete env[BACKEND_ENV];
    // A lane or fixer running the suite carries its own RUNNER_TASK_ID, which
    // trips auto.mjs's "--accept inside a lane" refusal in every test that
    // spawns the runner. The suite is not a lane; its children must not be one.
    delete env.RUNNER_TASK_ID;
    // The tier router (#294) asks Jev about every ticket when this key is set,
    // so a suite run on a machine that has it would reach the real service
    // and route every test's lanes. The suite stays offline; a test that
    // exercises the router passes its own key and a fake transport.
    delete env.TYPESAFE_API_KEY;
  }
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (suiteWorktrees) rmSync(suiteWorktrees, { recursive: true, force: true });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
};

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
