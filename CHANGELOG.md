# Changelog

## Unreleased — lanes clean up after themselves, and nothing of the runner's is committed

- **`afk land` can land under the owner's delegation (2026-10-30).** New config
  key `land.ownerApproval`: `required` (default, unchanged) or `delegated`.
  With `delegated`, `afk land` skips the owner-approval requirement (an owner
  request for changes still fails it; CI and the base-branch check are
  unchanged) and posts a `<!-- afk:land-delegated -->` comment on the PR after
  the merge. Any other key under `land:` or value is refused.

- **The tier router sends each ticket to Opus, or to Sonnet/Codex by quota (#294, 2026-10-26).**
  Before the first lane, `afk epic` / `afk auto` asks Jev (TypeSafe System
  One) seven atomic questions per executable ticket, one request each, 20 s
  bound, no retry, and turns the answers into a tier in runner code
  (`scripts/tier-router.mjs`): `critical` → `claude-opus-5-5`; `routine` →
  `claude-sonnet-5-5` or Codex `gpt-6.1-sol` at `medium`, whichever has the
  higher `all_models` percent in one
  `quota-axi --provider claude,codex --json --no-credential-refresh` read at
  lane start (neither → `critical`). A routine task's builder retry runs on
  `critical`. No `TYPESAFE_API_KEY`, a 429/529, any error or a timeout makes
  that ticket `critical`; with no key nothing is written per task and lanes
  launch exactly as before. New state: `builderRouting.assignments.<id>` may
  be `{tier, reason, routerSkipped, jev: {model, answers, deciding}}` (no
  backend until the lane starts), `builderRouting.skipped.reason`, and
  `builderRuns[].tier`. A stored decision is reused on restart; Jev is not
  asked again. New config key: `routing.tiers.critical` / `routing.tiers.routine`,
  each an ordered list of `backend/model[@effort]` strings (the config's YAML
  subset refuses a mapping inside a list; a JS config may pass
  `{backend, model, reasoningEffort}`); a malformed list is refused at start.
  `afk status` adds tier, deciding answers, Jev version and
  `router skipped: <reason>` to each routing row, and says once when the run
  had no key. The PR body's task table (and `docs/progress.md`) gains Tier,
  Model and Jev answers columns once the router has run. New command:
  `node scripts/jev-calibrate.mjs --issues <file> [--out <file>]`.
  `afk selftest` now removes `TYPESAFE_API_KEY` from the suite's environment.

- **A task's builder can run on Codex in Herdr (#293, 2026-10-26).** Run
  state may carry `builderRouting.assignments.<id>` =
  `{preferredBackend: "claude" | "codex", model, reasoningEffort, reason}`;
  #292's router fills it. A task with no assignment builds exactly as before.
  Every non-builder role stays on Claude. A Codex-routed lane first runs
  `quota-axi --provider codex --json --no-credential-refresh` (20 s bound) and
  keeps its builder slot and scope claim while it waits. A failed, timed-out or
  malformed read sends that one lane to `claude-opus-5-5`. A Codex lane whose
  provider message names a quota or usage limit, or whose login fails, is
  retried on `claude-opus-5-5` within `maxBuilderRetries`; a bare 429 is an
  ordinary rate limit. Under Herdr a Codex lane is an interactive
  `herdr agent start --kind codex` with `--model`, `model_reasoning_effort`,
  `--sandbox` and `--cd <lane>`. New state per task: `builderRuns`
  (`[{attempt, dispatch, backend, model, reason, outcome}]`, the model each
  attempt actually ran on), `builderDispatchAttempt`, `codexFallbackReason`.
  A Codex attempt stopped by its quota or login does not ground the retry's
  prompt as a failed attempt.
  `afk status` prints one routing row per task (preferred → actual · reason).
  Launch rows, and merge rows given the run state, carry `builderOpusShare` and
  `firstAttemptPassRate`. A Herdr lane or merger whose agent cannot be proven
  stopped is left `infra_failed` with its tree untouched and the run halted,
  rather than reset under a live agent. New live check:
  `AFK_LIVE=1 node scripts/live-checks.mjs --check=herdr-codex`.

- **The lanes cache is replaced, not rewritten in place (#280, 2026-10-19).**
  `~/.cache/afk/lanes-cache.json` (or `AFK_LANES_CACHE`) is written to
  `<path>.<pid>.<threadId>.tmp` beside it and renamed over it, so a reader never
  parses half a file. A temp file left there is from a writer killed mid-write
  and is safe to delete. `/lanes` and `/lanes/compare` (dashboard and hub) now
  run in a worker thread per request and answer when it finishes; `/health`
  and every other request answer meanwhile. A failed scan answers 500 with
  `{error}`.

- **A no-dashboard run is listed by the hub in any checkout (#279, 2026-10-26).**
  A run carrying on without a dashboard now also writes its checkout root to
  `~/.afk-claude/cos/no-dashboard.json` (a JSON array of roots; under
  `AFK_COS_ROOT` when set), and removes it on every exit that clears
  `state.dashboardSkipped`. A failed write is a warning in the run log, never an
  exit. The hub lists a recorded root as `no dashboard` only while its
  `.afk/state.json` still says `dashboardSkipped`, so a checkout no chief of
  staff has adopted or checked in on is listed too. A throw between the
  dashboard step and the scheduler (a baseline gate that could not run) now
  clears `dashboard`, `dashboardSkipped` and `orchestratorPid`, stops the
  dashboard and releases the lock before it rethrows; it used to leave all
  three, and `afk start` read the dead run as up.

- **The hub artifact is redesigned (#273, 2026-10-19).** `afk hub artifact --out`
  writes the approved page (tabs Hub, Decide, Night log, Report when the snapshot has one, AFK spending, AFK lanes;
  a Gantt of tonight with a lanes-at-once row; per-epic task DAG, timeline,
  progress and spend graphs; a Respond sheet). It now needs capabilities
  `{comments: {}, db: {rules: [{path: "snapshots", read: "view", write: "owner"}]}}`:
  the full comments grant, since Respond sends through `comments.sendToClaude`.
  Republish the live artifact with it; `composer_only` cannot send. With no
  snapshot in the db the page says "No snapshot yet" and draws nothing else.
  `afk hub snapshot` adds to each run `timeline`, `planned`, `tasks`, `spend`
  (`[{at, usd}]`, cumulative per 30 min) and `activity`, and a top-level
  `laneCap` (the live runs' `maxParallel` summed, absent when any is unknown).
  Over 256 KB it drops the oldest night-log entries, then the oldest spend
  points, then the oldest closed timeline spans, one stderr line per kind. `afk hub
  threads` routes a Respond (a body starting `# Re: afk hub`) as `cos` with a
  `respond` field: `items` (each `[ask:cos:<id>]` answer as an `afk hub queue
  cos` item, printed, not written to the inbox), `gates` (reported, never
  accepted), `unanswered` and `comments`. Each item and gate carries `words`:
  The owner's `>` lines under that entry, prefix stripped, joined with `\n`,
  `""` when there are none. A `from` ask leaves out its first `>` line, the
  option label the page adds. The morning report is the Report tab's
  `#report` card, drawn only when the snapshot carries `report`. After a
  Respond is sent, each decision it carried and the Respond sheet read
  "sent · Claude replies in the comments on the header card", with a See reply
  button that opens the comments composer on `#cos`; a failed send keeps its
  "Not sent" line. An answer to the chief of staff's own ask (no `from`) is
  recorded at once, the way the local hub records a Respond, and the ask
  closes: a Respond item reads `status: "recorded"`, and a plain thread on its
  `#ask-<slug>` card routes as `recorded` with the owner's `words` (it was
  `record-decision`). A rerun records nothing new (`already recorded`, or
  `reply-only` for the plain thread). A relays.log line that does not parse
  still marks its thread relayed by its raw text, so it is never relayed twice.

- **The hub artifact path, beside the local hub (#274, 2026-10-19).** Four new
  `afk hub` verbs; the reply path (`POST /respond`, `POST /comment`, `afk hub
  queue`, `afk hub ack`) is unchanged. `afk hub snapshot --out <file>` writes one
  snapshot document (`{at, mode, cosRun, runs, gates, asks, nightLog, usage, lanes,
  report?}`, night log capped at 50 entries and the file under 256 KB, the oldest
  entries dropped with a note on stderr) and prints its `doc_id`
  (`20261019T1430Z`). Its usage scan is cached on disk at
  `~/.cache/afk/usage-cache.json` (`AFK_USAGE_CACHE` moves it; `afk selftest` sets
  it to a suite path). `afk hub artifact --out <file>` writes the hub artifact
  page; `afk hub artifact --url <url>` saves its URL in
  `~/.afk-claude/cos/hub-artifact.json`, and `afk cos start` prints
  `hub artifact: <url>` or `hub artifact: not set (afk hub artifact --url <url>)`.
  `afk hub threads --in <threads.json> [--snapshot <file>]` prints one action per
  comment thread as JSON lines and appends each acted-on thread to
  `~/.afk-claude/cos/hub-threads.jsonl`. `afk hub` accepts `--out`, `--url`, `--in`
  and `--snapshot`.

- **A dashboard that fails to start no longer stops the epic (2026-10-19).**
  `afk epic` logs `AUTO: warning: the dashboard did not start; carrying on
  without it.` with the reason and `.afk/dashboard.log`, then runs the baseline
  and the epic; `state.dashboard` stays `null`. A dashboard that bound its port
  but did not answer `/health` within 3 s is reported as exactly that and no
  longer sends the start walking 20 ports to a misleading "could not bind a
  port" error; only a port someone else holds (the server now binds
  `127.0.0.1`, the address the health probe dials, and exits 98 on
  `EADDRINUSE`) tries the next one. Bound to `::`, it had bound beside a
  process on `127.0.0.1:<port>` and the start died as a `/health` timeout. A
  run carrying on without a dashboard records `state.dashboardSkipped`
  (`{at, reason}`, cleared when the run ends): `afk start` reads it as started,
  and the hub lists the run as `no dashboard`, with no dashboard link. The lanes warm-up that read every Claude
  transcript inside the listen callback, blocking `/health` for 2-23 s, now runs
  in a worker thread. `afk selftest` sets `AFK_TRANSCRIPTS_ROOT` and
  `AFK_LANES_CACHE` to suite paths, so tests no longer read this machine's
  transcripts or rewrite `~/.cache/afk/lanes-cache.json`.

- **Lanes leave no folders behind in `~/code/worktrees`, and tests never
  reach it (2026-10-15).** Removing a repo's last lane now drops its
  `lane/<key>/` and `lane/` folders, and a repo folder left holding only a
  claim (`.afk-repo`) on a clone that no longer exists. `afk finish` and
  `afk merge` sweep those orphan claims and print `removed N orphan repo
  claim(s): …`. A claim that a `<name>-<hash>` sibling depends on, or a folder
  holding anything else, is kept; nothing there is deleted recursively. Under
  Node's test runner the real home is swapped for `AFK_TEST_HOME` (set and
  deleted by `afk selftest`) or `$TMPDIR/afk-test-home`, so a test file run on
  its own with `node --test` no longer leaves claim folders in the real
  `~/code/worktrees`.

- **The plan review asks a fifth question, and both reviewers are verbs
  (2026-10-14).** `inconsistent_ticket`: does one child issue contradict itself
  (a ruling, waiver or notes line against a criterion or red test)? The
  reviewer quotes both passages (`evidence`, `contradicts`); code drops the
  finding unless both are in that issue's body. It refuses the run while the
  task has not started, unless the reviewer marks it `warning`, so an epic that
  passed before can now be refused. `afk review plan <epic>` runs the whole plan
  review standalone; `afk review ticket <issue>` asks only the new question of
  one issue. Both are read-only and exit 1 on a refusing finding.
  Project overrides of `.afk-setup/prompts/plan-reviewer.md` do not get the
  fifth question until they copy it from `prompts/plan-reviewer.md`.

- **The chief of staff relays the owner's decisions to an Orchestrator (2026-10-12).**
  `scripts/orchestrator-herdr.mjs relay <name> --said "<verbatim>" --at "<HH:MM TZ>"
  --session "<title>"` sends `Relayed by the chief of staff. The owner said, in
  "<title>" at <time>, verbatim: "<quote>"`; `--decided "<text>"` sends a
  decision labelled as the chief of staff's own (rule 5), not the owner's. A
  quote without `--at` and `--session` is refused before anything is sent. Every
  relay is appended to the new `~/.afk-claude/orchestrators/relays.log`.
- **`orchestrator-herdr.mjs read` marks the greyed prompt suggestion.** It reads
  with `--format ansi`, replaces dim text after `❯` with `[greyed suggestion,
  not typed]`, strips ANSI, and heads the screen with the agent's herdr status and
  the minutes since its transcript last changed ("cache likely cold" from 60).
- **One profile per Orchestrator, plus the owner's additions.** `start` writes
  `~/.afk-claude/orchestrators/<name>.settings.json` (was the shared
  `settings.json`, which a new start rewrote under a running Orchestrator), and
  `stop`/`restart` remove it. When `~/.afk-claude/orchestrators/owner-settings.json`
  exists, its `permissions.allow` entries are appended to the profile's and its
  `autoMode` block is copied in. Only the owner writes that file; the script only
  reads it.
- **`afk reset` and `afk salvage` take `--root=<path>`** and run against that
  checkout, so an Orchestrator runs them bare instead of after `cd` into an
  `--worktree` epic checkout (a `cd` outside its working directories sent
  `afk salvage 548` to the auto-mode classifier, which refused it).

- **`afk merge` can merge as a configured author (#212).** New config keys
  `merge.author` (`{ name, email }`) and `merge.coAuthors` (`Name <email>`
  strings). With `merge.author` set, the verb merges locally instead of
  through `gh pr merge`: `git merge --no-ff` of the guarded head sha into the
  fetched base in a throwaway worktree, authored and committed as that author
  with one `Co-Authored-By:` trailer per co-author, then a non-forced push of
  the base. Same guardrails; just before merging it re-reads the PR head and
  `origin/<branch>` and refuses if either moved off the guarded sha. Unset,
  the merge goes through `gh pr merge` as before. `--dry-run` prints which
  path it would take and the author. New validate errors: a malformed
  `merge.author`, a `merge.coAuthors` entry that is not `Name <email>`, and
  `merge.coAuthors` without `merge.author`.

- **Breaking: `afk salvage` refuses without `--lesson` (#215).** A hand fix
  brought back through salvage is a defect caught mid-run, and it used to
  become no rule. `afk salvage <id>` now requires
  `--lesson=rule:<id>:<file>:<redOn>`, `--lesson=standard:"<line>"` or
  `--lesson=none:"<reason>"` — the closeout fixer's `LESSON_FIELDS` shapes,
  parsed by the new `parseLessonFlag` in `scripts/fixer.mjs` — and refuses,
  changing nothing, with `SALVAGE: a salvage needs a lesson: ...` otherwise.
  A script that called `afk salvage <id>` bare must add one.

- **Defects caught mid-run are recorded and owe a lesson (#215).** A post-merge
  check that fails twice on the same merged tree, not read as the environment
  (`earnsGateRerun`), is recorded in the new `.afk/state.json` key
  `midRunDefects` with `lesson: null`; a salvage of that task fills in its
  lesson (or, with no open defect, records the hand fix itself). The closeout
  and the PR body gain a `## Defects found mid-run` section listing each one
  with its lesson or `Lesson: missing`, rendered as fixer findings are. When
  the failing check is one the lane's own checks did not run, the log says
  ``AUTO: <id>: lane checks lack `<command>` ``.

- **A lane fixed by its own retry records a defect and is asked for a lesson
  (#215).** When a builder attempt goes red on one of its lane checks and a
  later attempt passes, the first failing command is added to `midRunDefects`
  with `source: "lane"`, `failedAttempt` and `fixedAttempt`, and the closeout
  and PR body list it as ``lane check `<command>` failed on attempt N; fixed by
  the builder's retry (attempt M)``. A retried builder's prompt now requires a
  closing `LESSON: rule:<id>:<file>:<redOn>`, `LESSON: standard:"<line>"` or
  `LESSON: none:"<reason>"` line; the worker records it as `lesson` in the
  attempt's `verification.json`, and without one the defect shows
  `Lesson: missing`. An expired agent or Infisical login, or a red read as the
  environment at high confidence, is no defect.

- **The Infisical login is probed again mid-run (#210).** The preflight
  probe before the first builder is the owner check below. On top of it, if
  any of `defaultChecks`, `baselineChecks` or a task's `checks:` contains
  `infisical run` or `npm run infisical` (the preflight's detector), the runner runs `infisical user get token` with stdin
  closed and a 15s bound before the baseline and each integration gate, and
  in `afk validate --unattended`, and refuses with one line: "Infisical login
  expired: run `infisical login --domain=<domain>`, then rerun." The domain
  comes from a check's `--domain`, else `INFISICAL_API_URL`/`INFISICAL_DOMAIN`,
  else a placeholder. A lane gate whose output carries "No valid login session
  found" is left `infra_failed` with its builder attempts reset, and halts new
  builders; an integration gate that does is kept `ready_to_integrate` and no
  further integration starts. Repos whose checks never call `infisical run`
  are never probed.

- **`afk close --redo <epic>` redoes a closed epic's closeout at the branch
  head (#213).** Once an epic closed, any later commit made `afk merge`
  unpassable: `review-at-head` and `must-fix-cleared` read `close.verifier`,
  and a relaunch leaves a closed closeout untouched. The new command runs
  `runAuto`'s own close path with `redoClose`: the closeout verifier, the fix
  pass and its gate, at the current head, written to `close.verifier`,
  `close.fixer`, `close.fixGate` and the reports on disk. The superseded
  records are pushed onto `state.epicClose.redos`, and the earlier verifier,
  fixer and gate reports are copied to `.afk/epic-close/<epic>/redo/<time>/`
  first (#140). It posts nothing to the issue. It refuses, exit 1, when the
  epic is not closed, while `.afk/orchestrator.lock` exists, while a lane is
  `running`, `ready_to_integrate` or `integrating`, or while a gate holds the
  gate lock for this project or waits for it (`redoCloseRefusal` in
  `scripts/auto.mjs`).

- **Preflight checks the owner's logins and macOS automation (#210).**
  `afk preflight` and the preflight `afk epic` runs now block on: `gh auth
  status` failing when origin is on GitHub; `infisical user get token` failing
  when any `*Checks` list or a task's `checks:` runs `infisical run`; and, on
  darwin with a ticket that names `agent-device`, `XCUITest` or `xcodebuild
  test`, a short agent-device TextEdit session that cannot snapshot. A device
  held by another session (`DEVICE_IN_USE`) warns instead. New warnings: a UI
  ticket may raise a Keychain prompt, and a ticket says `npm install <pkg>` for
  a package the base's package.json lacks. New config key
  `preflight.macAutomation` (boolean; `false` turns the macOS probe off), with
  a validate error when it is not a boolean. `afk preflight` gains `--epic=`
  and `--repo=` to read the child tickets.

- **A run that stops takes its lane processes with it.** After the 2026-10-01
  overnight runs ended normally, five lane `claude` sessions (each with an MCP
  and a permission-broker child) stayed alive 5 to 9 hours. Closing the herdr
  panes did not end them, and their argv names no lane. When `runAuto` returns
  (close, `awaiting_acceptance` park, breaker halt, nothing runnable), every
  process whose cwd is inside this checkout's lane directory, or inside the
  epic checkout when `afk epic --worktree` made it, gets SIGTERM, then SIGKILL
  after 3s. The runner and its ancestors are spared. One log line names the
  pids: `AUTO: stopped N leftover lane process(es): …`. A shell or editor you
  left open inside a lane worktree or an epic checkout is killed too. The main
  checkout is never swept.

- **`afk salvage <id> [--commit=<sha>]` integrates a lane someone fixed after
  its builder finished.** The restart path trusts a committed lane only when
  its branch tip carries a verification note, and a fix committed on top has
  none, so `afk reset` alone started a new builder and dropped the fix.
  Recovering Riverbend #109 task 110 took a hand `git notes copy` of the
  builder's note onto the fix, which recorded checks the fix never met.
  `salvage` re-runs the lane's checks in its worktree at the tip (the commands
  the builder's note recorded, else `defaultChecks`), attaches a fresh note
  there marked `salvage`, and sets the task `ready_to_integrate`; relaunch to
  merge it. `laneVerified` accepts a `salvage` record in place of a builder's
  `agentExitCode: 0`. A red check writes no note and leaves state alone. A tip
  that already carries a verified note runs no checks and keeps that note; the
  task is only marked `ready_to_integrate`, which an `integration_failed` lane
  with a pruned worktree needs because no restart path re-queues it. It
  refuses while `afk auto` holds the lock, when the task already succeeded
  (`passed`, `no-op`, `awaiting_acceptance`), when a dependency in `state.dag`
  has not succeeded, when the builder's note does not parse (rather than fall
  back to `defaultChecks`), on a dirty lane worktree, on a branch with no work
  over its base, when the branch moves while the checks run, and when
  `--commit` is not the branch tip. Writes
  `.afk/runs/<id>/salvage-verification.json`. `afk reset` and `afk salvage`
  now clear a task's runtime through one helper, `clearTaskRuntime`.

- **Lanes no longer load CLAUDE.md; the repo's instruction files are handed
  to them instead (#173).** Every Claude role's `--settings` env now sets
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, on both runtimes, so Claude Code loads no
  CLAUDE.md or AGENTS.md of its own: not `~/.claude/CLAUDE.md`, not
  `~/CLAUDE.md`, not `CLAUDE.local.md`. The repo's own files come back once,
  verbatim, appended to the system prompt after the standing instruction:
  the root `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`, every `AGENTS.md`
  and `CLAUDE.md` Git tracks deeper in the tree (headed with its path), and
  everything they `@`-include. A file is carried only if it resolves inside
  the repo and Git tracks it, so an `@~/...`, absolute or `@../` include, a
  symlink out of the repo, or an untracked or ignored file is never read
  (outside a git repo, containment alone applies). Every Claude role gets them, including the
  verifier and supervisor, which run outside the repo and never saw them
  before. Codex is unchanged: it reads AGENTS.md itself. The operator's
  simulator rules (use `agent-device`, leave no simulators behind) now reach
  every Claude role from `prompts/_host.md`, between the standing instruction
  and the repo's files. Any other rule that lived only in the operator's home
  CLAUDE.md files no longer reaches a lane: move it into the repo's AGENTS.md,
  or into `roles.<role>.notes` in `.afk-setup/config.yaml`. A skill only those files
  named is no longer kept on by the context trim. Measured on a fixture repo
  with a 120-line operator CLAUDE.md: 34.0k first-call tokens before, 30.6k
  after, and the repo's push rule still quoted back by the lane.

- **Lanes can no longer write the run's checkout, another lane or
  `~/.claude` with their file tools.** Claude backend only: Codex ignores
  `--settings`, so a Codex lane gets none of this. The `implementer` now
  carries a PreToolUse hook (`scripts/project-root-guard.mjs`) that refuses
  `Write`, `Edit`, `MultiEdit` and `NotebookEdit` under the run's checkout and
  anywhere in this project's lanes directory except the lane's own worktree,
  and `Edit` deny rules on `~/.claude`, `~/.ssh`, `~/.aws`, `~/.gnupg` and
  `~/.config/gh`. The run's checkout is the project root, or the epic worktree
  under `afk epic --worktree`; in that case the user's own checkout is not
  covered. The own lane is named when the settings are rendered, not read from
  the agent's cwd, so a `cd` into `/tmp` or into a sibling does not move it; it
  is allowed first, so `AFK_WORKTREE_ROOT` inside the checkout still works. The `integrator` gets the credential reads,
  `Task` and the home `Edit` denies, but no guard. Every role's credential
  reads now also cover `~/.npmrc` (pnpm warns that it cannot read it, and
  still runs).
  Claude Code merges `Edit(...)` deny rules into a rendered sandbox's
  `denyWrite` and `Read(...)` rules into its `denyRead`, so these rules also
  bind sandboxed `Bash`. That is why the checkout is guarded by a hook, not
  an `Edit` deny: the deny would also refuse git the shared `<root>/.git` a
  linked worktree writes to. It is also why `~/.infisical` is not
  read-denied: offline `infisical run` reads its secrets backup there.
  The guard resolves symlinks, so a `worktreeSetup.link` entry that points
  into the checkout is read-only to the builder's file tools, as its docs
  already said it should be; a build tool that writes there as a subprocess is
  unaffected. `settingsArg` and `roleAgent` take an optional `projectRoot`
  (default: the runner's cwd) and `lane` (default: none, which refuses every
  lane); `runBuilder` passes the run's root and the lane's worktree.

- **`afk merge <epic>` merges (#189).** The default is now a real merge;
  `--dry-run` keeps #187's print-only behaviour and adds the guardrail lines.
  The verb reads the run state in `--root=<path>` (default: the current
  directory) and refuses a root with no run state for the epic, so it runs
  before `afk finish`. It prints every guardrail from
  `scripts/merge-guards.mjs` plus two of its own, `epic-closed` and `pr-head`,
  as `PASS|FAIL|WAIT <name>: <evidence>`. Any `fail` or `wait` posts one PR
  comment (not repeated when it equals the verb's last one) and exits 1. When
  all pass it runs `gh pr ready` for a draft, then `gh pr merge <n> --<method>
  --match-head-commit <sha>`, with the method most of the repo's last five
  merged PRs used. Then `merge.healthProbe` (five-minute bound; exit 2 on red,
  nothing landed, the revert printed for a human), then the landing: the epic
  and its passed children closed, the remote branch deleted, lanes pruned, and
  the epic worktree removed only when `git status --porcelain` is empty.
  `--wait[=<hours>]` (default 8) polls every five minutes while only `wait`
  guardrails stand. New file outside the repo: `~/.afk-claude/merge.lock`
  (`AFK_MERGE_LOCK_DIR` overrides the directory), one merge per machine. New
  measure row: `type: "merge"` in `docs/measure/<project>.jsonl`.
  `removeEpicWorktree` in `scripts/finish.mjs` takes `force` (default true,
  unchanged for `afk finish`).

- **`afk merge <epic>`, print-only (#187).** A new verb finds the epic's PR
  from the branch in its `afk:` block and prints the PR number, URL, head sha,
  base, state, draft flag and the command a merge would run (`gh pr merge <n>
  --merge --match-head-commit <sha>`), then `MERGE: dry run, nothing merged.`
  It reads GitHub only and merges nothing. It exits 1 when the branch has no
  PR, and refuses inside a lane (`RUNNER_TASK_ID` set). It exists for the
  classifier trial in `docs/spikes/merge-verb-classifier.md`.

- **Delegated acceptance and the merge guardrails (#188).** `afk epic` and
  `afk start` take `--delegate=<id>[,<id>] --delegate-condition="<text>"`,
  optionally `--delegate-evidence=walkthrough` and
  `--waive-user-facing="<reason>"`. A delegation is saved in `.afk/state.json`
  (`delegations`, `userFacingWaiver`) and is additive across restarts; a
  restart that changes one is refused. At the `awaiting_acceptance` park the
  Runner now runs the closeout fix pass before evaluating a delegated gate, then
  accepts it as `by: "delegate"` only when every guardrail in the new
  `scripts/merge-guards.mjs` passes, and closes the epic in the same run.
  `--accept=<id> --delegated` retries that evaluation and refuses an
  undelegated gate and `--force`; plain `--accept` is unchanged. The reopen
  rule now voids delegate acceptances too. The config gains an optional
  `merge:` block (`userFacing`, `screenshotBaselines`, `ci`, `healthProbe`);
  an unknown key under it now fails `loadConfig`. `onlyStatusFlushSince` moved
  from `scripts/auto.mjs` to `scripts/lib.mjs` (still re-exported from
  auto.mjs), beside the new shared `reviewIsCurrentAt`.

- **`afk validate` refuses more epics, and prints a stop forecast (#190, #191,
  #192, #193).** An epic that validated before can now be refused. New validate
  errors: `human_in_criteria` (an ungated task's acceptance criterion asks a
  person to approve or decide), `whole_suite_in_criteria` (a criterion runs
  `check:all`, `test:all`, a `baselineChecks`-only command or "the whole
  suite"), `story_not_cited` and `story_not_in_epic` (once any child has a
  `## User stories` section, every numbered epic story must be cited and every
  cited number must exist), `one_way_door_ungated` (a task names a path under a
  door in the config's new `oneWayDoors:` map and is neither `gate: before` nor
  waived), `one_way_door_delegated`, `one_way_doors`, `waivers`, `stops` and
  `launch_status`. The same patterns outside the criteria are warnings, as are
  `stories_uncited`, `one_way_door_waived`, `waiver_unused` and
  `stop_without_gate`. Every project without the new `launchStatus` config key
  (`pre-launch` or `launched`) now gets a `no_launch_status` warning and is
  read as `launched`. The `afk:` block gains two optional top-level keys:
  `stops:` (task id to `park`, `last` or `"delegate: <condition>"`) and
  `waivers:` (task id to a reason of at least 10 characters). Neither is graph
  shape, so editing one mid-run refuses nothing. `afk validate` and `afk epic`
  print the stop forecast after the graph (`--json` carries it as `forecast`),
  and the `launch` row in `docs/measure` gains a `forecast` field; its
  `humanGates` now comes from the same computation. `--unattended` on
  `validate`, `epic` and `start` refuses unless the plan review passes and
  every stop has an answer in `stops:`. The plan reviewer asks a fourth
  question, `needs_human`, which never aborts the review and becomes a stop in
  the forecast. Refusing and `needs_human` findings are kept in
  `~/.afk-claude/plan-review/<owner>-<repo>/<epic>.json`
  (`AFK_PLAN_REVIEW_STORE` overrides the root) and carried into the next review
  until their quoted text is edited out or their task leaves the graph, so a
  verdict no longer flips between samples. See `docs/validate-lints.md` and the
  "Stop forecast" section of `docs/epic-schema.md`.

- **Every run is measured into `docs/measure/` (#177, #181, #182).** The runner
  appends JSON-lines rows (`schema: 1`) to `docs/measure/<project>.jsonl` in the
  runner's own checkout (`AFK_MEASURE_ROOT` overrides the root); it never
  commits them. A `launch` row is written at every launch and relaunch (`afk
  auto`, and `afk wave` through it): declared human gates and the tasks behind
  them, DAG depth, root width, lane cap, base sha. A `close` row is written when
  the epic closes, before the artefact sweep; `afk archive` and the wave driver
  write it first for a close the runner did not record, and never twice. Every
  baseline and integration gate run is appended to
  `.afk/runs/gate-events.jsonl`, which `afk archive` moves with the run. New
  verbs: `afk measure backfill <path>` (one close row from an existing run
  folder), `afk measure dashboard` (`docs/measure/dashboard.html`, inline SVG)
  and `afk measure report [--days=N] [--json]` (this window against the one
  before; exit 0 either way). A post-merge check that timed out is no longer
  re-run, and its integration is not retried whole.

- **The runner stops re-running gates it already knows are green (#176).**
  Three changes. (1) When a merge is clean and a post-merge check fails, only
  that command runs again, once, on the same merged tree. The integration is no
  longer retried whole for a failed check: a re-run that passes passes the
  integration, and one that fails fails it with no second merger. A merge
  conflict or a merger failure still gets the full retry. `verification.json`
  gains `checkReruns` (each re-run command, its first exit code and output, and
  whether the re-run passed); `checks` holds the re-run's result. (2) A passed
  closeout fix gate (`gate.json`) counts as a green baseline for its head, so
  a relaunch over the fixer's commit skips the baseline. The baseline skip also
  ignores the closeout's own artefact-sweep commits (`.afk-runs/`,
  `.agents/evidence/`), through a predicate of its own; branch deletion and
  stale-evidence checks are unchanged. (3) A baseline skips its Rust checks when
  the diff from the last green baseline touches nothing Rust-relevant: the
  lane's Rust paths plus `.cargo/`, `rust-toolchain(.toml)`, any file a `rust:*`
  package script names, and the text of the `rust:*` scripts. A skipped check is
  logged and recorded under `lastGreenBaseline.skipped` in `.afk/state.json`.
  With no earlier green, every check runs. Integration still runs every check.

- **Runner agents start with a smaller first call.** Measured on a
  atlas-workspace implementer lane: 53.9k tokens in the first API call before,
  41.3k after. Every role's `--settings` payload now carries
  `autoMemoryEnabled: false` (the operator's MEMORY.md no longer reaches a
  lane), `enabledPlugins: { <key>: false }` for every enabled or claude.ai-synced
  plugin (`<name>@synced`) its `roles:` lists name no skill of — which also drops
  that plugin's hooks, such as coduo-radar's vocabulary rewrite of "Context" and
  "Plan" — and `skillOverrides: "off"` for every loose skill it does not list.
  Every listed skill stays loadable, and so does every loose skill a kept one
  points at as `/name` or `` `name` `` (coduo-implement's `/implement`), except
  one the role denies; the verifier always keeps `/code-review`, which its
  prompt names. The payload also sets `env.AFK_AGENT_ROLE`, so a hook
  outside the runner can skip runner agents on both runtimes. Every Claude
  command line (direct and herdr) gains `--strict-mcp-config --no-chrome`; a
  herdr lane keeps the permission broker, which it names with `--mcp-config`.
  Lanes that start together now launch one at a time: the first, then the rest
  after its first API response (at most 20 s, and at once if it dies), so they
  read the shared prompt prefix from cache. The preflight auth probe runs on
  haiku with `--disable-slash-commands` and no MCP servers (53.4k first-call
  tokens on opus before, 27.0k on haiku after). It proves the login only: a
  project model the account cannot use is no longer caught at preflight, and
  surfaces as near-instant lane failures for the breaker instead. A project whose lanes relied on
  an MCP server, a plugin or a skill outside their `roles:` lists loses it:
  list the skill under `always` or `offer`.

- **Herdr lanes start again under the standing instruction (#161).** herdr
  types `claude <argv>` into the pane, and once `--append-system-prompt` carried
  the standing instruction that line reached ~4,800 characters. The pane kept
  ~3,150, stopping inside the quoted paragraph, so zsh waited for a closing
  quote and every lane failed with 0 tokens. The settings JSON, the standing
  instruction and the broker's MCP config now go to files in the attempt's run
  dir (`claude-settings.json`, `append-system-prompt.md`, `mcp-config.json`)
  and the pane gets `--settings <file>`, `--append-system-prompt-file <file>`
  and `--mcp-config <file>`: about 550 characters whatever the payloads. This
  covers every herdr role (builder and integrator). The direct runtime is
  unchanged.

- **Opus 5.5 unattended-run changes.** Four changes from Anthropic's Opus 5.5
  prompting guide. (1) Herdr lanes now pass `--effort` as the direct runtime
  already did; before, a herdr lane ran at the CLI default whatever its role
  asked for. (2) Implementer, integrator, verifier and fixer get
  `prompts/_unattended.md` through `--append-system-prompt`, on both runtimes.
  It names the early stops the runner does not want, and names
  `report.mjs --status failed` or the herdr blocked state as the stop it does
  want. The implementer prompt's partial copy of this is removed. (3) When a
  builder stops with its checklist still open (herdr: idle with no report;
  direct: `-p` exited 0), the runner sends it one message naming the open items,
  at most twice per attempt, and then falls back to the old behaviour. The
  direct runtime resumes the same session. An open `Report` phase alone does
  not count, because a healthy lane ticks it by reporting. No continuation is
  sent with less than min(5 min, a quarter of the budget) left. A continuation
  never makes the result worse: a resumed session that fails or times out is
  dropped and the lane keeps its earlier result, and a herdr lane that runs out
  its deadline mid-continuation is handed on as status 0, as the idle path
  did. (4) Builder and fixer lanes get a PostToolUse hook that prints
  `elapsed <N>s / <budget>s` after every tool call, and their prompts say the
  lane is killed at that budget. Codex has neither hooks nor
  `--append-system-prompt`, so under Codex the budget line is left out of the
  prompts and the implementer keeps its short "never end with an offer" line.

- **`autoRestart: N` relaunches `afk epic` after a scheduler fatal, at most N
  times (#146).** Off by default. All four epics in #144 resumed cleanly once
  someone relaunched by hand; this does the relaunch. Each restart is a new
  detached process with the same argv, so custom instructions carry over
  unchanged. Its stdin is closed and its output goes to
  `.afk/restart-<k>.log` (fresh per restart, archived with the epic), so a
  closed terminal or pipe cannot kill it. A restart that cannot be spawned is
  recorded as a stop, not counted as a restart. The
  restart variables are removed from its environment before it spawns
  anything. The old process takes its signal handlers off, exits within two
  seconds, and passes a signal in that window on to the successor; the new
  one waits for the old pid to be gone first. Only a fatal thrown in the
  scheduler restarts; refusals (preflight, disk floor, dirty tree, auth,
  baseline) never do. The chain stops early, logging why, when the new fatal
  matches the one the last restart was for once paths, sha-like hex and every
  number are taken out. `afk status` shows `restarted after fatal (k of N)`
  and why it stopped (`state.restart`). The count covers one launch: a restart
  keeps counting, a start you type resets it. Fails closed: when the lock is
  still held, state cannot be read or written, or the restarted process
  refuses to start, the run stays stopped, and the last case notifies.
- **A process that died on a fatal exits within two seconds (#146).** It used
  to linger about 15 minutes (#136), held open by the dashboard child and
  herdr output. This applies with or without `autoRestart`.
- **A dying orchestrator no longer removes a lock it does not own (#146).**
  `release` used to `rm` `.afk/orchestrator.lock` unconditionally, including
  from the `exit` handler of a process that died on a fatal and exited minutes
  later, by which time the lock could belong to its successor. It now removes
  the lock only when the lock names its own pid.

- **A closeout review that comes back as prose is no longer thrown away (#142).**
  Five atlas-workspace epics reviewed in prose, emitted no block, and recorded
  `(0)` findings on every axis while their prose held real ones. Now: a
  transcript whose last message is a wait gets one nudge, resuming the same
  session with `--resume`, before it is harvested; an `unparseable` report
  recovers its numbered findings from the prose (severity `unknown`,
  `recovered: "prose"`, axis from the nearest heading) and any unwired symbol
  the prose names; each axis renders `unknown (review unparseable)` instead of
  `(0)` / `_No findings._`; and the fixer runs on an `unparseable` review,
  queueing the recovered findings, the `unwired` entries and the runner's unread
  seams. Recovery takes the last message that yields findings (including a
  closing synthesis of bold-lead paragraphs), reads bullets and tables only
  under a findings heading, skips requests to the reader, criteria walks and
  clean results, keeps a severity stated in lead or trailing position, and is
  capped at 25 findings with the overflow counted. The nudge fires only on a wait for a command with
  no report in hand, is capped at ten minutes, reuses the first session's
  checkout, and is dropped (with a `problems` line) if it fails.
- **The fixer checks the `unknown` criteria only it can run (#143).** Every
  `unknown` the verifier gave a reason for is queued as a check-only item,
  unless the reason names a person or something the fixer cannot reach either
  (a sign-off, a device, TestFlight, production, a vendor's sandbox, a signed
  build, credentials, staging, the network). A check the fixer reports `already met` renders as met in the
  closeout, with its output. The outcome line and `close.fixer` count the
  `unknown` criteria left unqueued (`unknownNotQueued`). `prompts/fixer.md` says what to do
  with a check-only item. **Consuming projects with an
  `.afk-setup/prompts/fixer.md` override:** copy that paragraph in, or the fixer
  sees the item but not how to report it.
- **Minor findings get a follow-up, and a failed lane's feature stays out of
  the fix pass (#145).** The minors the fixer never queues are posted as one
  uncollapsed checklist comment on the epic issue at close, retried on the next
  run if the post fails, and edited in place after a reopen. Criteria of a task
  that did not pass are no longer queued to the fixer, and the closeout gains a
  "Tasks that did not pass" section naming each one's retained branch and its
  last attempt's check results.

- **`--accept` needs a closeout review of the current branch** (#145). On epic
  #715 a human accepted legal gate #720 at 09:42 against a review that
  predated #718's integration. The review that found the redaction leak ran at
  09:46, and the fixer then edited the signed document. `--accept=<id>` is now
  refused, with the reason and the remedy, unless the newest closeout review
  read the head, or a commit the head differs from only by the runner's status
  commits (`onlyStatusFlushSince`). `--force` beside it accepts anyway and
  marks the acceptance `forced`. The park re-runs a review that is not
  current, so running `afk epic <n>` without `--accept` always leaves one to
  accept against. Each acceptance records the review it was given over
  (`review: { head, ranAt, recommendation }`). At close, a review that is still
  current is read back from disk instead of re-run, since the acceptance's own
  status commit would otherwise force a fresh, differently worded review. A
  `must-fix` review at close voids every acceptance not given over that exact
  review (same `head` and `ranAt`), or given over none: the gate returns to
  `awaiting_acceptance`, `onGateReached` fires, and the epic parks before the
  fixer runs. Both guards fail closed. An acceptance given over the must-fix
  review in hand stands, so a human who read the findings is not asked again.
  `close.verifier` gains `head`. **State from an earlier runner:** a stored
  review has no `head`, so the first `--accept` after upgrading is refused
  until a park re-reviews; an existing acceptance has no `review`, so a
  `must-fix` at close reopens it.
- **A restart over an unchanged base skips the baseline** (#145). Epic #760
  paid for three full baselines across three `afk epic` launches, ~28 of 160
  minutes, with no commit between the second and third. A green baseline now
  writes `lastGreenBaseline: { headSha, commands, at }` to `.afk/state.json`,
  and a start whose head and resolved `baselineChecks` list both match it logs
  `AUTO: baseline check skipped — it went green at <sha> …` and goes straight
  to scheduling. The head counts as unchanged when every commit since the green
  one touches only the runner's status-flush paths (`isStatusFlushPath`, the
  list `markStaleEvidence` already uses, read with `--no-renames` so a move
  into `.afk/` is not mistaken for one), because every run that decides
  anything ends on a progress-table commit (`onlyStatusFlushSince`). A cold
  start (no record), a real commit since, a changed check list or a start
  outside git still runs it. It fails toward running the checks.
  The tree is already refused if dirty, so the head covers tracked files; it
  does not cover ignored ones. If `node_modules` or the environment changed
  under an unchanged head and you want the baseline anyway, delete
  `lastGreenBaseline` from `.afk/state.json` before restarting.
- **`claimedPaths` keeps paths, not words** (#145). `checkPaths` kept any
  token with a `/`, so epics #784 and #896 published `br` (from `<br/>`), `p`
  (from `/p/$projectId`), `.ts`, branch names, `401/403`, `null/empty` and
  `Close/Reopen` as claimed files, and `epicScopeClashes` counts a bare `p` as
  overlapping any `p/…` another epic owns. A token with a source extension
  counts when there is a name in front of it. Without one, it counts when it is
  `./x`; a single `x/` followed by a glob or a closing backtick and not
  preceded by `<` (`src-tauri/**`, `locales/*.json`); or two or more lowercase
  segments (`src/lib`, `tests/unit`) that are not all "or" words (`null/empty`,
  `local/staging/prod`). Branch-shaped refs (`origin/`, `feat/`, `fix/`,
  `salvage/`, `afk/`, …, bare or not), all-number or all-capitalised-word
  segments, a self-closing tag name (`br/`), a token after `@` (a scoped
  package: `@tauri-apps/*`, `pnpm --filter @app/web`) and a token after `\`
  or `/` inside a regex (`\bcargo\b`, `/^src\/lib/`) never count. A mixed-case directory named without a slash is no longer claimed.
  That fails toward silence, which both callers read as "no evidence".
- **A merger that fast-forwards no longer fails the integration** (#145). On
  epic #841, task 849's merger exited 0 and left a clean tree whose history held
  the task tip, but whose head had one parent. The gate rejected it as "merge
  commit is a fast-forward, not a real merge" before any check ran, and the
  task requeued behind two lanes for 27 minutes. When those four facts hold,
  `runIntegration` now resets to `integrationBase`, makes the merge itself with
  `--no-ff`, records `redoneNoFf: { singleParentHead, exitCode }` on the
  integration's `verification.json`, and runs the checks. It fails closed: a
  redo that exits non-zero or leaves anything but a clean two-parent merge is
  rolled back with its own reason, which names the one-parent head rather than
  calling it a fast-forward, since a merger that linearised a conflicting merge
  leaves the same shape. Any commit the merger added on top of the task is
  discarded by the redo; its head survives as `redoneNoFf.singleParentHead`.
- **A dead orchestrator now says so (#144).** Four atlas-workspace epics lost
  the scheduler mid-run (a TypeError, two ENOSPCs, a failed worktree removal)
  and sat for 7 minutes to 2h13m because the only trace was the last line of
  `agent-auto.log`. The fatal handler now records `fatal: { at, message }` in
  `.afk/state.json`; `afk status` prints `orchestrator exited at <time>:
  <message>` under the epic line and shows in-flight rows as
  `running (orchestrator exited)`; the dashboard's pill shows the same text.
  A restart clears the record once it has passed preflight, the disk check
  and the baseline, so a refused restart leaves it in place. `afk status` and
  the dashboard both hide it while the recorded orchestrator pid is alive. A
  failed final state write no longer replaces the error that ended the run,
  and the lock is released either way. A desktop notification fires with kind
  `orchestrator_fatal`, in a notification group of its own so an earlier gate
  banner cannot swallow it. The kind is now on the default `NOTIFY_ONLY` list beside
  `lane_blocked` and `gate_reached`: all three mean nothing moves until a human
  acts. **Consuming projects that set `AFK_NOTIFY_ONLY`:** add
  `orchestrator_fatal` to your list if you want the banner. Opt-in auto-restart
  is not in this change; it is #146.
- **Disk is checked before the baseline (#144).** Free space on the lane
  worktree root's volume is compared with `maxParallel × diskPerLaneBytes`
  (default 2 GiB per lane). Below that the run logs `AUTO: disk: … Lanes may
  fail with ENOSPC; continuing.` and carries on, because the per-lane figure is
  an estimate. Below `diskFloorBytes` (default 1 GiB) it refuses before any
  baseline command runs, through `refuse` like every other startup refusal.
  A volume that cannot be measured passes. A value that is not a number
  (`14G`) refuses the run by name: it used to read as `NaN` and switch the
  check off. **Set
  `diskPerLaneBytes` in `.afk-setup/config.yaml` if each lane builds its own
  target dir**; atlas's Rust target measured 14 GB.
- **ENOSPC fails the lane, not the run (#144).** A full disk in a lane's
  bootstrap (the first one or a retry's reset), in the builder's record write,
  or in the integrator's, used to kill the orchestrator. The builder paths now
  stop the lane's recorded agent (an agent that will not stop is still
  fatal), run its teardown hook, and leave the task `infra_failed` with a
  `diskFull: { at, where, message }` record. The ticket is left unmarked, as
  for a dead login, and the failure counts on the harness breaker, so a disk
  that stays full halts new lanes after two. An integration that hits it stops
  the merger, restores main to its pre-merge base (a failed restore is logged),
  and leaves the lane `ready_to_integrate` off the queue. It is not retried on
  the same full disk, the ticket is not marked, and the run exits non-zero.
  The next start re-queues it from its branch, even if the lane directory was
  deleted to free space. It trusts the branch when its tip is the commit state
  recorded as verified, or when its verification note says so. A branch that
  is gone or has moved fails the task by name. It is not `infra_failed`, because that state is rebuilt and a rebuild
  resets the committed branch. A disk-full error is recognised by the
  `ENOSPC` code or the OS's own "no space left on device" text, never by a
  bare `ENOSPC` in some command's output. Any other bootstrap throw (a
  `worktreeSetup.link` naming a missing path) is still fatal: that is config
  every lane shares.
- **`afk finish` removes an `--worktree` epic's own folder.** Lanes already
  delete their private parent; the epic's `~/.afk-claude/epics/<slug>-<id>/`
  was never removed, and a project that builds one level outside its checkout
  (`target-dir = "../.atlas-target"`) left 15–18 GB in it per epic — 48 GB
  across three closed epics. Run from the epic worktree with every task
  passed, `finish` now runs the `worktreeSetup.finish` hook there, then
  checks the checkout, copies the run's `.afk/` to the main checkout's
  `.afk/archive/epic-<id>/`, removes the worktree and deletes the whole
  `<slug>-<id>` folder, and prints the path. Every check fails closed and
  keeps the folder, naming why: a task did not pass (a rerun resumes from it;
  `finish` prints the `git worktree remove` and `rm -rf` to do it by hand);
  state lists no tasks; the checkout holds changes other than `.afk/` and the
  `worktreeSetup` link/copy entries, the hook's own output included; its HEAD
  is on no local branch; `git worktree remove` fails (a locked worktree — git's
  error is printed and nothing is deleted); the archive copy collides with an
  existing file; or, once the checkout is gone, the folder holds anything but
  build caches (directories with a `CACHEDIR.TAG`) — two clones such as
  `/x/a-b` and `/x/a/b` share one `<slug>-<id>`. Ignored files do not block,
  but the top-level ones deleted with the checkout are listed (build caches
  and the runner's own entries excepted), so a lost `.env.local` shows. It
  refuses any directory that is not the exact one `epicWorktree` makes for
  this epic under the epics base. The feature branch is kept. Your shell was
  in that directory; `finish` prints where to `cd`.
- **Cleanup can no longer kill a merged task (#144).** `removeTaskWorktree`
  never throws. When `git worktree remove --force` fails with the directory
  still there (epic #790: `Directory not empty`, after all nine checks had
  passed), it falls through to `rm -rf` plus `git worktree prune`, returns
  `removed` and a `warning`, and the task records `worktreeRemoved: false` and
  `cleanupWarning`. On the next start, any `passed` task whose
  `worktreeRemoved` is not `true` has its cleanup retried, once, and only when
  its branch is gone or merged into the base. An unmerged lane is left on disk
  and named in the log. A branch that is already gone counts as deleted.
- **A command that cannot spawn is a failed command (#136).** `run()` returned
  `stdout: null` when the spawn itself failed (EAGAIN under process pressure),
  and `ledgerDirty`'s `.stdout.trim()` turned that into the TypeError that
  ended epic #841. `run()` now gives back empty stdout, a non-zero status and
  the spawn error in `stderr`. `ledgerDirty` logs the error once per failing
  spell and checks again on every turn. `runIntegration` checks the status of
  its two `git rev-parse` reads and fails the integration by name rather than
  merging an empty sha, and `restoreMain` refuses an empty base.

- **A role moved to another model mid-run is now recorded, logged and shown in
  the PR body.** Anthropic's safeguards can move a flagged message to an older
  model and let the session carry on there; nothing failed, and the only trace
  was the `model` field on assistant turns in `stream.jsonl`.
  `scripts/model-check.mjs` compares each session against itself: the model its
  `system/init` event names against the model on every top-level assistant
  turn. The configured model is not an input, so aliases, provider ids and CLI
  defaults need no handling. It records
  `modelCheck: { started, observed: { <model>: <turns> }, status }` on the
  builder's verification (and its git note), the integrator's verification, the
  verifier, fixer and reflector reports, the supervisor decision and the plan
  review. A switch logs one `MODEL SWITCH —` line ("started on X, later
  replies came from Y ×N") and puts a "Model switches" section above the PR
  body's progress table. It never fails a lane. Sub-agent and `<synthetic>`
  turns are not counted; a stream with no init model or no assistant turns
  (herdr, Codex, a fast-forward merge) is `unknown` and raises nothing. It
  assumes init keeps the starting model when the safeguard moves the session;
  no captured stream shows a switch yet. A reused closeout review or cached
  supervisor decision does not log again, and a clean integration retry clears
  an earlier attempt's switch.
- **The implementer keeps its phase checklist in a scratch file outside the
  lane**, named in its prompt as `@@AFK_CHECKLIST_PATH@@` (the verifier's
  report-path mechanism), under `/tmp` so `git add -A` cannot commit it. It is
  told to re-read it after a context summary. The runner copies it to
  `.afk/runs/<id>/builder-<n>/checklist.md`, records `checklistPath` on the
  verification, and names it to the supervisor under `artifacts.checklist`.
  **Consuming projects with an `.afk-setup/prompts/implementer.md` override:**
  add the mark if you want the checklist; without it nothing is substituted and
  nothing breaks.
- **The implementer prompt names the finish line and the allowed stops**: done
  is every acceptance criterion met and every required check passing in its own
  shell; no closing offer, question or menu; a blocker goes in the report. The
  completion report uses `Needs a human` / `Changed` / `Found` /
  `Couldn't confirm`. Nothing parses that report; it is still saved as
  `agent-output.log`.
- **Verifier findings carry `howToShowItFails`**, required for blocker and
  major, and `mustFix` is now "the problems you would block the merge for". A
  report without the field still parses (`null`); a blocker or major that lacks
  it adds a decision note, not a blocker; the verifier is told to leave the
  field null or downgrade the finding rather than fill it with an excuse. The
  fixer sees it as `shows it fails:` and runs it first as its fail-first check,
  but only when it is a local, non-interactive command that terminates — never
  a server, a non-localhost network call, or a harness waiting on a human.

- **`afk stack suggest`, because `detect` can only propose what a plugin maps.**
  `detect` reads the plugins a repo enables; the ~300 `SKILL.md` files a lane can
  actually reach stay invisible to it, and since `roles:` merges field-level or
  refuses, a repo with a hand-written block had no path to a new skill except
  somebody remembering it exists. `afk stack suggest` scores every reachable
  skill against the repo with Jev (`TYPESAFE_API_KEY` required) and prints
  `offer` lists to MERGE — never `always`, never `notes`, and it writes nothing.
  **Candidates are resolved against this host BEFORE they are scored**, which is
  the ordering the whole verb turns on: the model scores a skill's fit and says
  nothing about whether an agent can reach it, so run the other way round it
  proposes `disable-model-invocation: true` names that reach a lane as "no such
  skill". 53 of 330 names drop on Lumina this way. Names you reject go in
  `.afk-setup/suggest-ignore.txt` and are matched under either spelling, so a
  rejected `pstack:x` does not come back as a bare `x`. No Jev means exit 1 with
  the reason — there is deliberately no fall back to `detect`, because a network
  blip must not silently swap a wide proposal for a narrow one. `--dry-run`
  shows the roster and every exclusion without calling anything.
- **`bun.lock` is protected, and the two lists that decide what that means can
  no longer drift.** `PROTECTED_FILES` decides what a lane's edit gets reverted;
  `CHECK_INPUT_FILES` decides whether that revert invalidates the lane's green.
  They were written out separately, and `bun.lock` — bun's newer TEXT lockfile,
  used by two repos here — was on neither, so a builder could move a dependency
  and nothing reverted or noticed. **Adding it to the protected list alone would
  have been worse than leaving it**: the lockfile reverted, the green still
  standing, the checks having run against a tree the manifest no longer
  describes, which is the exact lie the protected list exists to prevent. There
  is now one `MANIFEST_FILES` set in `lib.mjs`; `worker.mjs` imports it rather
  than re-listing it, and a test asserts the relationship so a manifest added
  later cannot land on one list only. **Consuming projects on `bun.lock`: a
  lane's edit to it is now reverted and invalidates that lane's checks, as it
  already was for `bun.lockb` and every other lockfile.**
- **A bootstrap hook's writes are no longer attributed to the builder.** The
  revert baseline was read after the agent ran and nowhere else, so everything a
  `worktreeSetup.run` hook wrote looked like the agent's work. With a lockfile
  protected that is not a mis-blame but a REVERT — the file goes back to
  `baseSha` and the lane's installed tree stops matching its manifest, and the
  lane's green is invalidated for an edit no agent made. `runBuilder` now takes
  a status snapshot at its top, which is after bootstrap on every path into it
  (fresh, reused and retried lanes alike), and subtracts it. Path-level, so one
  hazard is documented rather than fixed: an agent edit to a file the hook also
  dirtied is masked.
- **The runner's own skill catalogue is now checked, against a record rather
  than against a machine.** `plugin-roles.yaml` ships skill names to every
  project and had shipped one nothing could load. Checking it against the
  current host is wrong twice over: a valid binding fails on a machine that has
  not installed the plugin, and a wrong one passes on a machine holding a stale
  copy. `afk stack manifest --write` now generates `plugin-skills.json` — the
  invocable names each referenced plugin actually ships, read from the install
  cache and produced by the same three-layout walk and
  `disable-model-invocation` filter the resolver uses, so the two cannot
  disagree. The assertion that every catalogue name appears in it is pure
  fixture and runs everywhere; the staleness check runs only where a source
  exists and says out loud when it skips. A plugin installed nowhere keeps a
  hand-written entry with its own provenance and is carried over verbatim
  rather than deleted. Catalogue changes in the same commit: `superwall` added
  (not `superwall-editor`, which needs a live browser pairing code an
  unattended lane cannot obtain), and the `nextjs → vercel` marker mapping
  dropped — every repo with Next had deliberately switched that plugin off, so
  the mapping only produced a nag to enable something refused on purpose.
- **The proposed `worktreeSetup` stops assuming every node repo wants a
  symlink.** `detect` emitted `link: [node_modules]` for anything with a
  `package.json`. Turbopack is the `next build` default from Next 16 and refuses
  a symlinked `node_modules` outright, so harbour had already replaced that by
  hand with `link: []` plus a measured 4.1s `pnpm install --frozen-lockfile`;
  voice-studio-website still carries the link and passes only because its checks
  never run `next build`. `next` in the ROOT manifest now proposes the install
  instead of the link. The root manifest and nothing else: atlas-workspace has
  no `next` at the root, `next@^16` in `landing/package.json`, and Tauri lanes
  that need the symlink — reading deeper takes their deps away. The install line
  is per package manager, because `npm install --frozen-lockfile` is not a
  thing: npm accepts unknown flags as config and a plain `npm install` can
  rewrite `package-lock.json`, which is a `CHECK_INPUT_FILES` member, so npm
  gets `npm ci`. `link: []` is emitted explicitly alongside `run:`, since an
  absent `worktreeSetup` key makes `bootstrapWorktree` return before the install
  runs. Package-manager resolution is deterministic — the `packageManager` field
  first, then a fixed lockfile order — and the output says which signal chose
  it. Across the estate only harbour and voice-studio-website change, and
  harbour's proposal now matches the block it has been running in production.
- **`afk stack detect` sees a project that is not at the repo root.** Marker
  files were matched with `existsSync(root/<file>)`, which finds a stack only at
  the top level — so Lumina, whose whole Xcode project lives under `prototype/`,
  reported `Stacks seen in the repo (0): none`, and two Tauri repos had no
  `rust` or `tauri` marker to find in the first place. Matching now runs against
  `git ls-files` with **one extra level of depth**: enough for `prototype/`,
  `src-tauri/` and `ios/`, and no more. A recursive scan was measured and
  rejected — unpruned `find` at depth 3 on atlas-workspace returns 669
  `package.json`, and even the tracked set lies, because Lumina's
  `web/package.json` would flip `needsNodeModules` true for a repo whose root
  has no `node_modules`; `bootstrapWorktree` throws by name on a missing `link:`
  source, so that false positive is every lane in the repo dead at bootstrap.
  `needsNodeModules` therefore stays keyed on the ROOT manifest alone, and a
  subdirectory that carries its own gets a report line instead. New `rust` and
  `tauri` markers; `swift` now recognises `project.yml` and `*.xcodeproj` as
  well as `Package.swift`. A React Native app's `ios/` project is not tagged
  `swift` — the root manifest settles it. Across the 16-repo estate this is
  purely additive: Lumina gains `swift`, atlas-workspace and brightpath gain
  `rust` and `tauri`, no repo loses a stack, and no `needsNodeModules` changes.
  `detect` still writes nothing.
- **`afk stack lint`, because a skill name nobody checked fails silently.** A
  `roles:` block is a list of skill NAMES handed to an agent, and a name that
  does not resolve fails as "no such skill" with nothing said in any log. The
  block is committed, hand-edited and had never been checked against a disk.
  `afk stack lint` resolves every name in `.afk-setup/config.yaml` against this
  host and prints the ones that are named, not installed; `afk stack detect` now
  runs the same check over the proposal it is about to print. Both still write
  nothing; `lint` exits non-zero on a dead name. It is HOST-DEPENDENT by
  construction — a partner's machine legitimately reports names only the owner
  has — so it does not belong in `defaultChecks`.
  Run over the estate it found **15 dead name-sites in 4 of the 16 repos
  scanned, out of 128 names**, for three different reasons: `vercel:*` in four
  repos, where each repo's own settings turn that plugin off;
  `react-doctor:react-doctor`, enabled in the repo and installed nowhere on this
  host; and a bare `vitest` that exists nowhere. The report says which, because
  "switch it on", "install it" and "install it somewhere this repo can see" are
  three different fixes.
  Three resolver rules, each pinned by a test that fails when it is removed.
  **Installed is not enabled**: enablement is the user's settings, then the
  repo's, then the repo's `settings.local.json`, later winning; visibility is
  the install scope; a name needs both. **The install path comes from
  `installed_plugins.json`**, not from a cache directory whose name carries a
  version segment. And **a plugin skill is not always
  `skills/<name>/SKILL.md`** — `claude-reflect` ships a root `SKILL.md` and no
  `skills/` directory at all, `codex:rescue` and `stripe:explain-error` are
  `commands/`, and every one of them loads. A false dead is the damaging
  direction: it makes a human delete an entry that worked. Accepting a command
  widens what a `roles:` block names, and that is deliberate — if the Skill tool
  can invoke it, this must not call it dead. Nothing about how a lane runs
  changed.
- **One progress file per epic, so two epics stop conflicting over one.**
  `docs/progress.md` was a single file every epic appended to, and it conflicted
  on every multi-epic merge — five times across three repositories in one
  morning, with nothing genuinely in disagreement in any of them: appends from
  two branches collide textually however well the marker scheme behaves. A run
  now writes `docs/progress/<epic id>.md`, and the filesystem gives for free the
  guarantee the markers were bought to provide. The markers stay, so an epic
  still rewrites only its own section and a human's notes survive a re-flush;
  only a DAG with no epic id at all keeps the shared file, which a wave is not —
  it carries `wave-01` and writes `docs/progress/wave-01.md`; and an existing
  `docs/progress.md` is never migrated, rewritten or deleted. **Consuming
  projects get a new committed directory**, `docs/progress/`, written by the
  runner: if a formatter, link checker or docs gate runs over `docs/**` in your
  repo, it now sees one markdown file per epic there. The four literal-string couplings move with it — `isBookkeeping`,
  `isProtectedPath` and `isStatusFlushPath` all classify the new path, and the
  wave evidence archive takes the directory as well as the file — and the path
  is computed in one place (`writeProgress`), so the file a run stages and the
  file it wrote cannot drift apart. A project no longer supplies a progress
  file at setup: the runner creates the directory on the first flush.
- **The closeout has a third axis: Reach.** Standards and Spec are both
  diff-vs-document, so a change that is internally consistent and reaches too
  little of the codebase passes both. Three real epics proved it: one whose
  criteria named three files for a guard that needed five, one that shipped a
  settings toggle whose resolver had no non-test caller, and one where three
  lanes wrote outside their declared paths and two shared files, every gate
  green. Reach compares the diff against what it did NOT touch. The runner hands
  the reviewer the lists a script can produce — the files two or more lanes both
  wrote, the lanes that kept an out-of-scope edit (`keptOutsideDeclaredPaths`,
  recorded since the first release and shown to nobody), and the declared globs
  nothing matched — and asks it only for the two that need a grep: every other
  site each new mechanism must also cover, and every symbol this epic exports
  that nothing calls. `seams` and `unwired` join the report schema, counted by
  the runner like every other number in it, and both block in code: an unwired
  symbol, or a shared file the review did not open, is a must-fix whatever the
  model put in its own `mustFix` list. `scripts/reach.mjs` is the axis and is
  pure.
- **`unwired` is computed, not asked for.** A project that sets `reachReport` in
  `.afk-setup/config.yaml` — one command printing a `knip --reporter json`
  payload — gets the list set-diffed by the runner instead of grepped by the
  reviewer, and the runner keeps its answer whatever the model sends: `[]` is the
  easy answer and the one #365 got away with. The two runs happen in throwaway
  checkouts at the epic's merge-base and at its branch tip, bootstrapped by the
  project's own `worktreeSetup`, because the reviewer cannot do this itself —
  its sandbox reads `node_modules` through the main checkout's symlink but
  cannot write it (every closeout on atlas-workspace since 2026-09-09 reports
  its tests skipped for exactly that), and the base payload needs a second
  checkout it has no way to make. Same shape as `keptOutsideDeclaredPaths`:
  computed where the tooling exists, read later by the axis. Measured end to
  end on atlas-workspace' `feat/654-reduce-filter-menu`: two checkouts and two
  knip runs in 2.8s, one entry — `FieldKindIcon`, whose only reference on that
  branch is its own `export function` line. Unset, the reviewer still greps and
  the prompt says on its face that nobody computed it.
- **The suite was not flaky; it was colliding with itself.** Fourteen call sites
  across eight test files took a port from `process.pid` with a per-file base and
  modulus, and the ranges overlapped: `46900 + (pid % 90)` sits inside
  `46000 + (pid % 1000)`, and three formulas shared 47000. `selftest` runs files
  concurrently in processes with near-sequential pids, so their bases land a few
  ports apart, and `closeout-gate`, `epic-close` and `gate-lifecycle` each walk
  upward from theirs (`++portSeed` per test) onto a neighbour's. It presented as
  one failure per run, a different test each time, every one passing alone.
  `freePort()` in `scripts/free-port.mjs` binds 0 and lets the kernel choose;
  the four sites inside synchronous `spawnSync` helpers hoist one port to a
  module-level constant, which is what the pid formula gave them anyway. Three
  reds in four runs before, zero in four after. One test needed the coupling made
  explicit rather than removed: the stand-in dashboard in "a port held by another
  project is refused" has to occupy the port the child will probe, and the two
  agreed before only because both spelled out the same formula.
- **The dashboard draws the epic's DAG, and says how far each ticket has got.**
  The page had the graph in its hands all along — `.afk/state.json` carries
  every task's `dependsOn` — and rendered it as `← 57, 58` at the end of a row,
  so the shape of a run was something you reconstructed in your head. It now
  draws the epic as the root node and flows the work down the page, one band
  per dependency depth, an edge per `depends_on`, edges out of a passed ticket
  in green; a node opens the same lane log the list rows do. Each ticket
  carries five pips (queued, building, review, integrating, done) and the
  numbers behind them: the live agent's attempt, tool calls and output tokens
  while one is on the lane, and the recorded `n/m checks` and wall time once it
  has finished.
- **The header says which run you are looking at.** It read `AFK Runner` on
  every page of every project. It now leads with the project (`project:` from
  `.afk-setup/config.yaml`, else the checkout's own name), then the epic's
  number and title, its branch, liveness, phase tally and the one honest
  percentage — passed tickets over total, never a busy lane counted as a
  finished one. The page title matches, so a tab pinned per run is
  distinguishable, and the pill carries the run's age. The grid of big-number
  status cards is gone: it said the same thing as the bar directly above it,
  one card per status.
- **Every run on this machine, one tab each, at a fixed URL.** With several
  epics going you had several ports to remember and no way to see them
  together. Discovery needs no registry: the port is derived from the
  checkout's path, so the range is known, and `/health` — the probe the port
  scan already trusts — now also names the project, the epic and the run's
  status. `/peers` sweeps the range server-side (one request from the page, not
  four hundred), and clicking a tab repoints the page at that dashboard; every
  endpoint was already origin-relative and CORS was already open, so nothing
  else had to change. **http://localhost:4099** always shows the strip: it sits
  just below the derived range where no checkout can hash onto it, the first
  dashboard to start claims it as a second listener, and the others keep
  retrying so the bookmark survives that one exiting. A tab's dot is the run's
  own status in the same three words the header uses — running, stale, idle —
  because a dashboard answering says nothing about whether its run is alive. A
  peer that dies between the sweep and the click falls back to the local run
  rather than stranding the page on a dead port. A dashboard older than these
  fields — a long-lived process serving the code it booted with, which an AFK
  run's can be for days — says "restart to name it" and wears a hollow dot,
  rather than reporting "no epic" and "idle" as if they were facts about its
  run.
- **Every agent a run spawns is reachable from the page.** A run is more than
  its builders — the verifier, supervisor, fixer, reflector, plan reviewer and
  epic-close agent each come and go with their own stream under
  `.afk/<role>/<id>/` — and none of them had a way in. `/agents` lists them
  newest first, `/agent-log` serves one, and a chip opens the same panel a lane
  log uses. `recent` is a claim about the file's mtime (the runner records no
  pid for these) and says so; whether the agent actually answered is read from
  the stream.
- **The list below the graph is an inbox, not a second copy of it.** It
  repeated every ticket the DAG had just drawn. What is left is the work that
  is moving, stuck, or waiting on a person, carrying the detail a 196px node
  cannot hold: dependencies, which check went red, and what the agent on the
  lane is doing right now. The epic is likewise named once, in the header,
  rather than again as the root node of its own graph.
- **The dashboard is mobile first.** It is read on a phone at 3am at least as
  often as on a desktop, and at 375px it was unusable — the graph ran off the
  side and every list row squeezed its title to three words. A DAG band now
  wraps into sub-rows instead of scrolling sideways, list rows put their
  numbers under the title, and the lane log opens as a bottom sheet.
- **`worktreeSetup.teardown` and `worktreeSetup.finish`** (#109). A check command
  can create a resource the runner has no record of — Lumina's boots a simulator
  named after a hash of `$PWD` per lane — and nothing shut it down: 21 devices,
  27 GB, 14 of them for worktrees long since pruned, and a booted device per
  finished lane holding a gigabyte of RAM between waves. `teardown` runs in the
  lane (same `sh -c`, same `$PWD` as `run`) after its checks finish — pass, fail,
  a builder that died or was killed by the orchestrator's own shutdown or
  `afk wave stop` — and in the root checkout after the post-merge checks.
  `finish` runs once per lane worktree just before its directory is removed —
  at integration for a passed lane, at `afk finish` for a retained one, where
  each hook's exit and output print beside `pruned N lane(s)`. A hook's exit
  code never changes a lane's outcome, and a hook is cut off after 60 s so the
  orchestrator's own shutdown cannot hang on one.
- **A lane's `verification.json` is a git note, not a committed file** (#106).
  It rode every task branch as `.afk-runs/<id>/verification.json` so the crash
  sweep could `git show` it back, and landed in the consumer's history and under
  its `format:check` at integration — five epics across two repos, each fixed
  with `rm -f` by hand. It is now attached to the task commit under
  `refs/notes/afk-verification/<id>` (per task, so concurrent lanes never
  contend for one ref) and read back with `readLaneVerification`; the ref is
  dropped with the branch. The integration record is no longer copied to
  `.afk-runs/<id>/integration-verification.json` and committed by
  `flushStatuses` either — `.afk/runs/` holds it. `runsIgnoredRefusal` is gone
  with its reason. `ACTION-REQUIRED.md` still rides the branch under
  `.afk-runs/<id>/`, on purpose, on the rare lane that needs a human.

## Unreleased — baselines wait for a quiet host and read more reds as the environment

- **More baseline reds earn the one environment rerun (#223, extends #179).**
  A line saying GitHub answered with a 5xx (`GitHub returned HTTP 502`, or an
  `api.github.com` URL followed by a 5xx status) is now an environment sign, and
  so is Playwright's `Timeout 90000ms exceeded`. A timeout in a test file the
  epic's diff (fork point with `--epic-base` to `HEAD`) changed is now a code
  red: `ticket`, no rerun, even beside another sign. A timeout in a file the
  diff does not touch reruns as before.
- **A baseline waits for a quiet host (#223).** After it takes `gate.lock`,
  every baseline — first launch, relaunch, and the environment rerun — waits
  until the 1-minute load is under 20, saying
  `baseline gate waiting for a quiet host: load …, threshold 20`. New config key
  `quietHostLoad` (a number, or `false` to turn the wait off); the
  `AFK_QUIET_HOST_LOAD` environment variable (a number, or `off`) wins over it,
  and `afk selftest` sets it `off`. The wait gives up after 30 minutes and runs
  the gate anyway. The lock itself was already taken on a relaunch (#178); what
  #545 lacked was this wait, because another epic's lanes never take the lock.
- **A relaunch skips the baseline over integrated task merges (#223).** When
  every first-parent commit since the last green baseline is either a runner
  status commit or a merge a passed task recorded as its `integratedHead`, the
  baseline is skipped with `only integrated task merges (<ids>) and the runner's
  status commits have landed since`. Each of those merges passed its own
  integration gate; with `integrationChecks` set that gate is the lighter
  chain, and the full chain still runs at closeout.

## Unreleased — a lighter chain at integration, the full one at closeout

- **New config key `integrationChecks`.** When set, the post-merge gate runs
  `task.checks ∪ integrationChecks` instead of `task.checks ∪ baselineChecks`,
  so a project whose full chain takes minutes stops paying it once per
  integrated task. The closeout gate then runs `baselineChecks` over the final
  tip even when the fix pass committed nothing (it used to record `no_commit`
  and run nothing, trusting the last integration's full chain). Unset, nothing
  changes. `afk preflight`'s Infisical check reads the new list too.
- **Integration refuses a merge built from the task side.** A two-parent merge
  whose first parent is not the integration base is rolled back with "merge
  commit's first parent is …". HEAD^1 is the rollback anchor and what
  `vitest --changed HEAD^1` style checks diff from; with the parents swapped it
  names every other lane's work and none of this task's. Applies to every
  project, `integrationChecks` or not; the runner's own `--no-ff` merges always
  had the base first.

## Unreleased — an epic's run artefacts are swept at close

- **Closing an epic removes its own `.afk-runs/<id>/` and `.agents/evidence/<id>/`
  in one final commit on the run branch** (`afk: sweep run artefacts for epic <n>`),
  after the closeout verifier and the fix gate have read them and before the PR
  body is rendered. Scoped to the epic's task ids, so a sibling epic live in the
  same repo keeps its artefacts. Before this, Lumina's Futari v2 merge left 318
  artefact files (about 20 MB) on `main` that nothing reads once the epic is
  closed — and the obvious fix, gitignoring `.afk-runs/`, is the one the runner
  refuses, because the crash sweep reads `verification.json` back off task
  branches mid-run. `sweepRunArtefacts: false` in `.afk-setup/config.yaml` opts
  out. The result is recorded as `close.sweep` in `.afk/state.json`. One
  consequence: `afk verify` on a closed epic reviews a branch with no
  `.afk-runs/**.json` left to resolve as evidence — the closeout review that
  ran before the sweep is the one on record.
- **`coduo-afk setup` writes the `.gitattributes` line** (`.afk-runs/**
  linguist-generated=true`) instead of asking for it; the README no longer lists
  it as a file the project supplies.

## Unreleased — a check command is bounded, and its evidence is tail-clipped

- **`checkTimeoutMs` in `.afk-setup/config.yaml` bounds every check command**,
  in both places one runs: the builder's, inside a lane worktree, and the
  post-merge gate's, in the root checkout. Defaults to 30 minutes, matching
  `agent.timeoutMs`; a config without the key keeps working and gets the
  default. `runAsync` has always taken a timeout and neither call site passed
  one, so a check that never returned held its lane — quillnote v1 lost six
  hours to a `swift test` parked behind a macOS TCC consent dialog. Nothing
  reaped it.
- **A timed-out check does not read as a red one.** It fails the attempt with
  `check timed out after Ns: <command>` rather than `check failed: <command>`,
  and its entry in `verification.json` carries `timedOut: true` and
  `timeoutMs`. Its `code` is `124` — what `timeout(1)` reports — so that every
  existing reader that only asks `code !== 0` still counts it as a failure;
  recording the killed process's `null` status would have hidden it from
  `supervisor.mjs`, which excludes a null code to skip a skipped check.
- **The failure evidence a retry attempt is handed is tail-biased**, keeping
  the same 2,000-character budget: 500 characters of head, then the last 1,500.
  For `xcodebuild` and `swift test` the head is xcodegen chatter and compile
  progress while `Test Case '-[X testY]' failed` and the first `error:` are at
  the very end, so the previous head-clip handed a retry 2,000 characters of
  noise and it re-ran the same failure blind. `verification.json` still carries
  the full untruncated output.

## Unreleased — the closeout fix pass is gated

- **The closeout's fix pass no longer ships an unchecked commit.** The pass
  commits after every check in the run has already passed, so its output was the
  newest and least-verified code on the branch. When it commits anything,
  `afk auto` now re-runs `baselineChecks ?? defaultChecks` over the commit it
  left and records the result against that sha in `close.fixGate` and
  `.afk/fixer/<epic>/gate.json`. When it commits nothing — most closeouts — the
  tip is still the commit the gates ran over and nothing is re-run, so the cost
  is rare rather than per wave.
- **The wave digest now says which way the tip went**, in its own section:
  `closeout fix <sha> gated: yes`, `gated: no`, or `n/a` with the reason. Before
  it, a digest could not distinguish a wave whose tip had been checked from one
  whose tip had not, and the last wave of a run is where that difference is
  permanent — the next wave's baseline covers every other one by accident.
  Measured on quillnote wave-34 (2026-09-04), whose five gates were recorded two
  commits below the tip it shipped (#78).
- **A red gate does not sink the close.** It is recorded loudly, in state, in the
  orchestrator log and in the digest, and the epic closes and the wave
  fast-forwards exactly as before. Letting it change the outcome would hand the
  fixer the lifecycle authority `docs/epic-schema.md` refuses it.

## Unreleased — `afk wave run`, the wave driver

- **`afk wave run <dir> --base=<branch>`** runs a markdown task directory
  unattended, one wave at a time (`docs/wave-mode.md` §4). Each wave is the
  frontier of the frozen graph capped at `--cap=` (default 12), cut from the
  base branch, run in its own worktree by `afk auto`, and fast-forwarded back
  onto the base. There is no `--base` default: a hardcoded `main` is how a run
  lands on a stale base without saying so.
- **The fast-forward is `git merge-base --is-ancestor` plus `git update-ref`,
  and never `--force`.** If the base moved during the wave the driver stops,
  writes the digest, and leaves the wave branch in place. A verifier objection
  is advisory: recorded in the digest, and it does not hold a wave off the base.
- **`<dir>/.wave-log.json` is the driver's only memory** and is git-tracked,
  because `.afk/` is archived at every wave boundary. `attempts` accumulate
  across waves, so a task cannot earn a fresh retry budget by surviving into the
  next one. Re-running the command resumes: merged waves are skipped and
  anything else is replayed under its own number, so a run interrupted at 3am
  converges rather than repeating work.
- **A digest per wave at `docs/afk-runs/wave-NN.md`**, committed to the base
  branch, carrying each task's outcome, the first failing check's output for
  anything that failed, the verifier's disputed criteria, follow-up task files
  the agents wrote, and the pre-wave sha with the command that puts the base
  back. The evidence is copied out of `.afk/` before it is archived.
- **The plan review runs once, over the whole task directory, before the first
  branch is cut** — not per wave. Per wave was wrong and the first live run
  proved it: wave 1 was shown its three root tasks and the whole of `GOAL.md`,
  and refused with `unsatisfied_criterion` for a CLI that sat in wave 3. The
  graph is frozen at t0, so one review answers the question for every wave, and
  each later re-ask would have carried strictly less. The wave log records it
  in a top-level `planReview`, so a resumed run does not pay for a second.
- **The night stops when it stops being worth running:** if dead tasks orphan
  more than 25% of the remaining graph the driver halts and writes the digest.
- **The wave boundary discards nothing and adopts nothing.** A tracked file a
  human edits while a wave is running is stashed before the ref moves and
  restored after, instead of being destroyed by the `reset --hard` that follows
  the fast-forward; if the wave changed the same file the tree is left clean and
  the stash is named rather than left in conflict. And the bookkeeping commit
  now names exactly the paths the driver wrote — the log, one digest per
  recorded wave, and both sides of each file it moved — where `git add` on
  `tasks/tasks-todo` used to sweep every untracked draft under it into a commit
  authored by the human. There is no safe window to commit to the base during a
  run, so the working tree is the seam: edit it freely and commit when the run
  exits.
- **A cut never adopts an existing `wave-NN` branch.** A branch whose wave
  record holds no passed task carries nothing, so it is torn down and re-cut
  from the base as it stands now — dropping the recorded `baseSha` with it,
  since the reason for the re-run is usually a repair that has since landed. One
  that does hold passed work is never discarded: if the sha this cut wants is
  not in its history the run refuses and names both. A wave that reaches no
  terminal outcome leaves no worktree and no branch, removed in the only order
  that works (worktree, prune, branch) and verified rather than trusted.
- **A refused fast-forward prints the diagnosis**: which ref is not an ancestor
  of which, the sha the wave was based at, where the base is now, and how far
  ahead.
- Every one of those decisions is a pure function in `scripts/wave-driver.mjs`;
  `scripts/wave.mjs` is the git and process edge over them.

## Unreleased — `allowedPaths` as a scheduling constraint

- **Two tasks that claim overlapping paths no longer start at the same time.**
  The scheduler skips any runnable task whose `allowedPaths` overlaps a running
  lane's or an earlier pick on the same tick. Overlap is directory-prefix aware
  and compared per segment, so `Sources/Feature/` and
  `Sources/Feature/View.swift` conflict while `Sources/A/` and `Sources/B/` do
  not. A skipped task is **deferred**, not failed: nothing is written to state
  and the next tick reconsiders it.
- **A repo-wide scope takes no constraint, so nothing changes for an epic run
  from GitHub.** `epicToDag` gives every child `allowedPaths: ["**"]`, and a
  task claiming `**` — or omitting `allowedPaths` entirely — is scheduled
  exactly as before, in parallel with everything else. The filter only bites on
  a DAG that carries real per-task scope, which today means `--dag=`.

## Unreleased — grounded builder retries

- **A retried builder is told why the last attempt died.** Attempt 2 and later
  get a `Earlier attempts…` section in the implementer prompt carrying, per
  prior attempt, its number, its FIRST failing check with the command and
  clipped output, and the paths it touched — read from the per-attempt
  `.afk/runs/<task>/builder-<n>/verification.json` that the runner has always
  written and never read. Only the first failing check, because a prompt
  carrying all of them is failure mode 5 in a new place.
- **`agent.maxBuilderRetries` in `.afk-setup/config.yaml`**, defaulting to `1`
  — the two-attempt behaviour every epic has had, so nothing changes until an
  operator raises it. A non-integer or negative value refuses the run at start
  rather than being coerced into a budget nobody wrote.
- An attempt that never reached the API (zero token counters and no produced
  files) grounds nothing: its failure is a fact about the harness, and the
  retry runs plain.

## Unreleased — runner hardening (epic #27)

Operator-facing changes from the firstmate/AXI review:

- **Unknown flags fail loud.** A mistyped or unknown flag on any subcommand is
  refused by name, with the accepted set printed, instead of being silently
  dropped. `--epic-body=` is accepted on `epic`, not only `validate`.
- **Bare `afk` prints the run's status** rather than the ~170-line manual, and
  `afk <subcommand> --help` prints only that subcommand's usage. The refusals
  the top-level CLI itself makes — an unknown command, an unknown flag — and
  everything that goes through `lib.die` now print on stdout. The subcommand
  scripts were not migrated: `epic.mjs`, `verifier.mjs` and the rest still write
  their own preflight refusals and usage text to stderr, so a caller reading
  stdout alone still misses those.
- **`afk validate` refuses a child with no acceptance criteria** — a missing or
  empty `## Acceptance criteria` / `**Done when**` section is an error, and a
  top-level `or` escape hatch inside a criteria bullet is a warning.
- **`afk status` prints the release command on a gated row**, and `afk finish`
  stamps a verifier review that predates the branch's current HEAD.
- Long verifier and ledger output truncates by default; pass `--full` for all of it.
- **Under `--runtime=herdr`, an integrator rebuilding the parent workspace no
  longer reaps live lane panes** — the replacement is built and the lanes
  re-opened onto it before the old workspace is closed, and a lane that will not
  answer expires against a budget instead of holding integration up. **Still
  unproven, and a human check on the first live run:** the two tests in
  `scripts/herdr-handshake.test.mjs` assert the ordering and the non-blocking
  degradation against a recorded command sequence from a fake `herdr` on PATH.
  Nothing on this branch drives a real herdr session, so that a real session's
  lane panes survive a rebuild is not demonstrated here.

## 2.0.0 — the v2 runner

`afk --version` prints this number and the spec version beside it:

```
$ node afk.mjs --version
afk-claude 2.0.0
epic spec version: 1 (the `afk:` block; unchanged by the v2 runner)
```

## The runner is v2. The epic spec is not.

Read this before anything else, because it is the confusion the two numbers
invite.

`SPEC_VERSION` in `scripts/epic-spec.mjs` is **still 1, and was not touched.** It
versions the `afk:` block an epic author types into a GitHub issue body —
`version`, `branch`, `max_parallel`, `tasks` — and nothing on this branch changed
that schema. Every epic written for the v1 runner still validates unchanged, and
`version: 1` remains the only accepted value.

`RUNNER_VERSION` (`scripts/lib.mjs`) is 2.0.0 and versions the **orchestrator**:
how it reads config, what it writes into its reports, when it halts, what it
posts to a pull request. That is what moved.

They are two clocks. Bumping `SPEC_VERSION` alongside the runner would refuse
every existing epic in every consuming repo for no reason, so it stays at 1 until
the block itself changes.

---

## Breaking changes

Ordered by how likely a consuming project is to be bitten.

### 1. `maxParallel` is a floor, not a cap

**What changed.** `effectiveMaxParallel` (`scripts/epic.mjs:154`) raises the
`maxParallel` in `.afk-setup/config.yaml` toward the DAG's **root width** — the
number of tasks with no dependencies — bounded by `cpus().length`, and never
lowers a value the operator set higher. The epic's own `max_parallel` in the
`afk:` block is still a hard cap and, when present, blocks the raise outright:
the function returns `Math.min(configured, max_parallel)` and never consults root
width at all. `afk validate` emits a new `parallelism_raised` warning naming the
old value, the new one, the root width and the core cap.

**What breaks if you ignore it.** A project that set `maxParallel: 2` to hold
concurrency down now runs as many lanes as it has roots, up to its core count. On
a repo where lanes touch shared files — a locale JSON, a command registration
file, `package.json` — the extra width buys merge conflicts, not speed. Nothing
refuses; the run just gets wider than the number in your config says.

**Migration.** If your `maxParallel` was a deliberate ceiling rather than a
default, set `max_parallel` in the epic's `afk:` block. That is now the only lever
that caps:

```yaml
afk:
  version: 1
  branch: feat/203-stripe
  max_parallel: 2      # hard cap; blocks the root-width raise
```

Run `afk validate <n>` before every epic and read the `parallelism_raised`
warning. It tells you the width the run will actually use.

### 2. The closeout review now parses, so epics that closed clean may not

**What changed.** `FENCE_RE` in `scripts/verifier.mjs` only recognised ` ```json `
as a fence **opener**. Any review whose prose quoted code — which is most of them,
since citing files is the job — opened a ` ```js ` or ` ```bash ` block whose
closer then matched as an opener, and every fence after it was off by one. The
report's own block was consumed as a closing fence and never read. The parser now
accepts any info string.

**What breaks if you ignore it.** Nothing breaks; things start working, which has
the same practical effect. Reviews that silently returned "unparseable" and zero
findings now return their real criteria, findings and must-fix items. Epics that
closed `completed` can now close `completed_with_findings`. The fixer reads the
same report, so a run that previously fixed nothing may now commit fixes to the
branch.

**Migration.** If any automation of yours gates on the epic outcome string, or
assumes the closeout is usually empty, re-check it against a run. Expect the
closeout comment to be longer and the must-fix list to be non-empty on branches
where it used to be silent.

### 3. `Task` is denied to the `implementer` and `fixer` roles

**What changed.** `SUBAGENT_DENY = ['Task']` in `scripts/roles.mjs` is added to
the deny list of both roles that run unattended against a deadline.
`prompts/implementer.md` now instructs builders to run every check in their own
shell.

**What breaks if you ignore it.** A project whose ticket text, `CLAUDE.md` or
`AGENTS.md` tells a builder to delegate work to a sub-agent now has lanes that
either refuse the tool or, worse, follow the old instruction and stall. The
measured case: a builder finished its file in minutes, delegated the project's
selftest to a sub-agent, and sat on "Waiting for task" for 14m53s until the
deadline killed it, twice, losing the epic. The check took 27 seconds run
directly.

**Migration.** Grep your repo for instructions telling agents to delegate, spawn
sub-agents, or use the `Task` tool, and remove them from anything a lane reads.
One ticket, one agent, one worktree.

### 4. `status: "ok"` on a verifier report no longer means every gate ran

**What changed.** The verifier's `report.json` gained `skipped: [{tool, reason}]`
— gates that could not execute in the review sandbox. It is taken from the
agent's own declaration where it makes one, and detected from prose where it does
not.

**What breaks if you ignore it.** Any reader that treats `status: "ok"` as "the
branch passed every gate" is now wrong in the same way the runner was: a criterion
marked `met` may rest on a tool that never ran. The v1 report had no way to say
so, which is why this was invisible rather than absent.

**Migration.** If you parse `report.json`, read `skipped` before you trust
`status` or `criteria`. An empty `skipped` array is the strong signal — it is the
agent declaring every gate ran.

### 5. Cached reviews and reflections are keyed on the commit, not on existence

**What changed.** `runVerifier({reuse:true})` and `runReflector` used to reuse any
artifact that existed on disk. Both now record a `head` sha (`headSha` in
`scripts/lib.mjs`) and reuse only when the commit then equals the commit now.

**What breaks if you ignore it.** Nothing silently; the cost changes. A `--reuse`
that was free now pays for a fresh review whenever HEAD has moved, and a report
written before `head` existed has `null` and never matches, so the first run after
upgrading re-reviews. Two deliberate consequences: outside a git repository both
sides are `null` and reuse stays free.

**Migration.** Budget one extra verifier session on the first v2 close of an epic
whose artifacts predate the upgrade. This replaced a real failure — an epic posted
a review of its own empty first attempt onto a PR that by then carried everything.

### 6. The pull request now opens at the first merge and re-renders on every merge

**What changed.** `refreshEpicPr` ran twice, both at the epic's end, so the feature
branch sat unpushed for the whole run. `finishIntegration` now queues a push and a
re-render after every merge that passes post-merge verification. The closeout
account also goes out as a **PR comment** rather than only into the PR body, which
is re-rendered from run state and would overwrite it.

**What breaks if you ignore it.** CI, required checks, review-request automation
and anything else triggered by PR-opened or PR-synchronize now fire **during** the
run, once per merged lane, instead of once at the end. A repo with expensive
required checks will pay for them N times.

**Migration.** Check what your CI triggers on. If per-lane CI is not what you
want, gate the workflow on the PR being marked ready, or on a path filter.

### 7. Archived run state moved to `.afk/archive/epic-<id>/`

**What changed.** The auto-archive wrote `.afk/epics/<id>/` and moved two of the
directories a run produces. There is now one path, `.afk/archive/epic-<id>/`, and
one list — `state.json`, `runs/`, `verifier/`, `fixer/`, `reflect/`, `recovery/`,
`supervisor/`, `plan-review/`, `epic-close/` — used by both the auto-archive and
the new `afk archive` command. `.afk/epic-ledger.yaml` is deliberately left alone
because it is tracked.

**What breaks if you ignore it.** Anything reading `.afk/epics/<id>/` finds
nothing. And the old hand-rolled advice — `rm .afk/state.json` and start again —
now leaves seven directories of the previous run in place for the next epic to
inherit under its own paths.

**Migration.** Use `afk archive <id>` between epics in one checkout. It refuses a
half-failed epic (naming the unfinished tasks) unless given `--force`, which moves
and never deletes. An epic parked in `awaiting_acceptance` archives without
`--force`, because that is where a correct epic waits.

### 8. When a run halts has changed

**What changed.** Two related fixes.

- An infra death no longer charges the ticket breaker. Infra failures get their
  own counter, and `breakerVerdict` (`scripts/scheduler.mjs:104`) is exported so
  the halt is provable: three cluster-shaped failures, three harness failures, or
  three consecutive real failures. Every failure increments exactly one counter.
- `neverReachedApi` (`scripts/scheduler.mjs:68`) now returns `false` as soon as
  `producedFiles` is non-empty, before the token counters are consulted. Two lanes
  recorded `{"input":0,"output":0,"cacheRead":0}`, wrote their files, passed and
  merged — the counters were never harvested and the lane was fine.

**What breaks if you ignore it.** A run that used to halt on one terminal failure
plus two infra deaths now continues. A lane that genuinely failed after real work,
on a runtime with a metering gap, is no longer filed as "the harness broke" with
its ticket left unmarked.

**Migration.** None required. If you have a runbook that says "three failures in a
row halts", it is still true, but the three must now be three of a kind.

### 9. `afk validate --json` carries three new warning codes

**What changed.** `parallelism_raised` (see 1), `epic_scope_clash` (see 12) and
`checks_unrelated` — the last fires when **every** path a gate names sits outside
the work the epic and its children describe. It stays silent when a check names no path at all, because
`npm test` yields no evidence and a false alarm on every such project would be
worse than the bug.

**What breaks if you ignore it.** Automation asserting an empty `warnings` array
now fails. Warnings are still never errors; `report.ok` is unaffected.

**Migration.** Filter by `code` rather than asserting the array is empty. And read
`checks_unrelated` when it fires: it caught an epic whose four lanes all ran the
project's `defaultChecks` against a file no ticket in the epic touched. The board
was green because the gate was green before the run started.

### 10. Reflections are written to a new path, and skipped without a GitHub remote

**What changed.** Reflections land at `docs/reflection/<project>/epic-<id>.md` in
the **runner's** repository (was `docs/<project>/reflection/`), overridable with
`AFK_REFLECTIONS_ROOT`. `projectName` returns `null` when there is no GitHub
remote and the reflector skips entirely, and nothing is created until there is
content to put in it.

**What breaks if you ignore it.** Little for a consuming project — the file lands
in the runner's checkout, not yours. Before this, 41 empty directories accumulated
in the runner's `docs/` because `projectName` fell back to `basename(root)`, which
under a test is a temp directory.

**Migration.** Move any existing `docs/<project>/reflection/` with `git mv`. Set
`AFK_REFLECTIONS_ROOT` if you keep reflections elsewhere.

### 11. Every worktree gained a private parent directory

**What changed.** A lane is now `~/.afk-claude/worktrees/<slug>/<id>/<repo>` (was
`.../<slug>/<id>`) and an epic worktree `~/.afk-claude/epics/<slug>-<id>/<repo>`
(was `.../<slug>-<id>`). One extra level, named for the repository, so each
worktree owns the directory it sits in.

**Why.** Build configuration is routinely a path relative to the checkout that
escapes it — atlas-workspace has `target-dir = "../.atlas-target"` in
`.cargo/config.toml`, and tsconfig `outDir`, Gradle, sccache and a shared `.venv`
all do the same thing. With the worktrees as siblings, every one of those
resolved to ONE directory: two lanes, or two epics, blocking on a single cargo
build lock and able to hand each other a binary the other compiled. This is the
shared build cache `worktreeSetup.link` is warned about, arriving through a
relative path instead of a symlink, and no gate detects it. The runner cannot
know a project's tools, so the fix is the layout: `../X` is now private per
worktree without naming cargo or anything else.

`afk epic` also **warns** — never refuses — when `.cargo/config.toml` sets a
`build.target-dir` that climbs two levels or is absolute, naming the file, the
key and the resolved path. That is the remainder the private parent cannot cover.
Cargo is the only case checked, because it is the only one whose resolution rule
is documented and readable from a config file; a project whose build path comes
from a script or an env var gets no warning, and this says so rather than
guessing.

**What breaks if you ignore it.** Anything that reconstructs a worktree path by
hand, or reads `~/.afk-claude/epics/<slug>-<id>` as a checkout — a `git -C` in a
runbook, a dashboard bookmark, a script that lists lanes. The runner itself is
fine: it builds every path through `scripts/worktree.mjs`, and a worktree left on
disk in the old flat layout is detected and reused where it stands, so an epic
that is mid-run when you upgrade keeps its worktree, its `.afk/` and its branch.

**Migration.** None required. Add the repository name to any hardcoded path:
`~/.afk-claude/worktrees/<slug>/204` becomes `~/.afk-claude/worktrees/<slug>/204/<repo>`.

### 12. Starting an epic beside a live one warns `epic_scope_clash`

**What changed.** `afk validate` and `afk epic` now look for every OTHER epic
running against this clone — the main checkout plus every registered worktree
under the epics base — and warn when its tickets name a file this epic's tickets
name too. `.afk/state.json` gained a `claimedPaths` key, written at run start
from the same prose scan `checks_unrelated` uses, which is what the next epic
reads.

Two epics can run at once against one clone, one per epic worktree, and until now
nothing reconciled their scopes. Scope is enforced per **file** and never per key
or per region inside one, so #388 owning `agents.*` in `locales/en.json` and #389
owning `compose.*` in the same file are, to the runner, the same claim: two lanes
edit that file on two branches and the merge is the first thing that notices.

**A warning, never a hold or a refusal.** The signal is prose, two epics may
legitimately share a file, and there is no cross-epic scheduler to hold a lane
against — `allowedPaths` is `**` for every lane, so a hold at admission would
either fire on all of them or deadlock with no arbiter to break it. The warning
fires once, at the moment a human is present, and names the other epic, its
branch, the shared files and its root. A claim of `**` counts as claiming
everything, never as claiming nothing.

**What breaks if you ignore it.** Nothing refuses. Automation asserting an empty
`warnings` array fails, as under 9.

**Migration.** None. If the warning names an epic that is already over, archive
its `.afk/state.json` — liveness is read from `orchestratorPid` and nothing else,
so a state file whose orchestrator has exited or died is ignored rather than
blocking a new run.

---

## New in v2 (additive — nothing to migrate, but a run does more now)

These change what a run *does* without breaking a v1 contract, because no v1
contract covered them.

- **The `fixer` role** (`scripts/fixer.mjs`, `prompts/fixer.md`). One bounded pass
  over the closeout review, then a commit on the epic's branch and a PR comment.
  Its work list is the runner's arithmetic over the verifier's report — must-fix,
  then blocker and major findings, then unmet and partial criteria — so the model
  is never asked what counts as a must-fix. `minor` findings and `unknown`
  criteria are excluded and counted in `notQueued`. One attempt, no retry. Its cap
  is a deny list of Bash verbs (push, merge, rebase, reset, checkout, branch,
  worktree, every `gh` verb), not its cwd, because its output is a commit on the
  branch it stands in. **Note:** the fixer's report shape (`rawPath`/`rawTail`
  rather than an embedded `raw`, plus `aliases`, `kind`, `duplicateOf`,
  `notQueued`) settled *within* this branch. No v1 consumer ever saw `fixes.json`,
  so none of that is a breaking change — it is the shape v2 ships with.
- **The `reflector` role** (`scripts/reflect.mjs`, `prompts/reflector.md`). Reads
  the run and writes one reflection document, posted as its own PR comment. It
  runs in a scratch workspace with the evidence copied in, including the
  `.afk/runs/<id>/` lane verification reports — capped, **failing lanes first**,
  announcing the truncation rather than letting it read as coverage. It commits
  nothing.
- **`afk epic --worktree`.** Runs the epic in a worktree of its own under
  `~/.afk-claude/epics/<repo>-<id>/<repo>`, leaving your checkout alone including a dirty
  tree. Two epics can now run against one clone. This also lifted the herdr
  refusal that forced `.afk/state.json` to hold one epic at a time.
- **`afk archive`.** See breaking change 7.
- **`afk version` / `--version` / `-v`.**
- **`state.supervisorLog`** (append-only, capped at 200, announcing what it drops)
  and **`state.salvage`**. `state.supervisor` is unchanged and still holds the
  latest observation as a single object, because `afk status` reads it that way
  and wants one live diagnosis. A `salvage` verdict now records the lane's
  worktree path and uncommitted files and prints them at the halt and in the
  closeout. Nothing is committed, merged or opened as a PR.
- **Notification delivery is timeout-bounded.** `NOTIFY_DELIVER_TIMEOUT_MS`
  (10s) plus an injected `deliver` seam. The lesson generalises and is worth
  stating for consuming projects: **your `defaultChecks` runs unattended inside
  every lane, so anything reachable from it that waits for a human waits for the
  agent deadline instead** — and presents as the lane failing at whatever it
  happened to be doing.

---

## Internal — only matters if you import from `scripts/`

Signature and export changes with no CLI or artifact surface.

- `renderCloseout(dag, state, report)` → `renderCloseout(dag, state, report, fixReport)`.
  The closeout used to list must-fix items as outstanding that the fixer had
  repaired in the same minute; it now matches them by title and by the aliases
  dedup displaced.
- `pruneLanes(root)` → `pruneLanes(root, taskIds = null)`. `git branch` answers for
  the repository, so with two epics in two worktrees of one checkout the
  unscoped version was about to `git branch -d` a sibling epic's live lane. `null`
  keeps the old behaviour.
- `breakerVerdict` newly exported from `scripts/scheduler.mjs`.
- `appendSupervisorObservation`, `salvageLines`, `SUPERVISOR_LOG_MAX` newly
  exported from `scripts/auto.mjs`.
- `headSha` newly exported from `scripts/lib.mjs`.
- `RUNNER_VERSION` newly exported from `scripts/lib.mjs`.
- `effectiveMaxParallel` newly exported from `scripts/epic.mjs`; `report.effectiveMaxParallel`
  added to the validation report.
- `epicWorktree` / `createEpicWorktree` / `liveEpics` added to `scripts/worktree.mjs`.
- `epicScopeClashes` newly exported from `scripts/epic.mjs`; `report.modifiedPaths`
  added to the validation report, and `validateEpic` takes an optional `liveEpics`
  (default `[]`, so an existing caller is unaffected).
- `runAuto` takes an optional `claimedPaths` (default `[]`), persisted to
  `.afk/state.json`. A run that passes none keeps whatever the state file holds.
- `adoptLane` passes `--cwd <main checkout>` instead of `--workspace <parent id>`
  to herdr; `worktreeRoot` slugifies the canonical path, so `/var/...` and
  `/private/var/...` no longer produce two slugs for one checkout.
- `markStaleEvidence` and `artifactCommitAt` newly exported from
  `scripts/verifier.mjs`; criteria may carry `unverified`, and
  `counts.criteriaUnverified` is new. A `met` whose evidence is a
  `runs/**.json` artifact written at a different commit than the review read
  now renders `⚠️` with both commits named, is counted in the criteria heading,
  and gets its own line in the decision's notes. The verdict is unchanged —
  the reviewer judged, this says what the judgement rests on. Non-artifact
  evidence, non-`met` verdicts and unreadable artifacts are untouched.
- `mergeProgress` newly exported from `scripts/lib.mjs`, and it is what writes
  `docs/progress.md` now. `renderProgress` is unchanged and still renders ONE
  epic — `scripts/pr.mjs` wants exactly that for the PR body — but the status
  flush used to write that single epic's table over the whole file, so every
  epic deleted every earlier epic's table. Each epic now owns the section between
  its own `<!-- afk:progress:<id> -->` and `<!-- /afk:progress:<id> -->` markers
  and rewrites only that; everything outside them survives, including a whole
  unmarked file written before the markers existed. A run with no epic id keeps
  the whole-file behaviour, having nothing to key a section on.
- The fixer's report carries `reviewHead` — the commit the verifier's report was
  written about — and `runFixer({ reuse: true })` returns a stored report only
  when the review on the table is still that review. Reuse used to be keyed on
  the file existing, so an epic that closed twice replayed the first pass's
  report over a branch it no longer described. It is deliberately NOT keyed on
  the working HEAD the way the verifier and reflector are: the fixer commits
  (`prompts/fixer.md` step 4), so a HEAD key would compare against a tree the
  pass itself moved, never match, and buy a second attempt at every restart for
  an agent that gets exactly one by design. The report also carries `head`, the
  commit the pass started from, for reading later.
- `epicClose.closeout` carries `head`. The retry described above posts only while
  that is still the branch tip; if a human has committed in between it says so,
  names both commits, points at `afk verify`, and posts nothing.
- `epicClose.history[]` entries carry the `verifier`, `closeout`, `fixer` and
  `reflection` of the close they supersede, and reopening now clears all four
  rather than the first two.
- `criteriaLinesIn` reads one criterion per BULLET, not per physical line. An
  indented continuation line now folds into the preceding bullet, joined with a
  single space; a blank line ends the fold, so a paragraph after a bullet stays
  the ignored preamble it always was, and a nested bullet stays its own
  criterion. A soft-wrapped criterion used to lose everything after its first
  line silently — the Spec axis judged half a sentence and the fixer queued that
  half sentence as an item title. Criterion ids and ordering are unchanged, but
  a criterion's TEXT may now be longer than a previous run recorded.
- `markStaleEvidence` takes an optional third seam, `changedPaths(from, to)`,
  and `changedPathsBetween` and `isStatusFlushPath` are newly exported from
  `scripts/verifier.mjs` and `scripts/lib.mjs`. This narrows the entry above:
  a `met` is caveated only when a file the reviewer could have read changed
  between the artifact's commit and the review head — not merely when the two
  SHAs differ. `flushStatuses` commits `docs/progress.md`, the integration
  verification and the ledger after every merge, so the artifact commit is
  essentially never the head and the SHA comparison fired on every epic. When
  git cannot answer (unknown commit, no repo, no seam injected) it falls back to
  the SHA comparison, because an unanswerable question is not evidence of
  freshness. Expect FEWER `⚠️` criteria and a lower `counts.criteriaUnverified`
  than v2.0.0 produced; the ones that remain now mean something.
- `epicClose.fixer` changed shape: `{status, fixed, deferred, ranAt}` became
  `{status, items, distinct, restating, open, noOp, notQueued, ranAt}`, built by
  the newly exported `fixerStateRecord` from `scripts/fixer.mjs`. The old `fixed`
  and `deferred` were raw array lengths, so state.json — the surface a tool
  reads — disagreed with the log line and the closeout markdown, which had both
  already been moved onto the partitions, and it carried no `notQueued` at all.
  `restating` sums restatements across BOTH branches, as `renderFixerOutcome`
  does, so the raw lengths are not recoverable from the record; the full arrays
  remain in `.afk/fixer/<epic>/report.json`. Nothing in the runner read the old
  keys — `epicClose.history[]` copies the record whole — so an old-shape record
  written by a v2.0.0 run survives a reopen unchanged.

---

## Precedence: v2 supersedes a project's own description of runner behaviour

**The rule.** Where a consuming project's own documentation, `AGENTS.md`,
`CLAUDE.md`, runbook or ticket text makes a claim about **how the AFK runner
behaves or what its configuration keys mean**, this document supersedes it. Those
descriptions were written against v1, several of them are now factually wrong, and
a stale local description is to be corrected rather than obeyed.

**The limit, and it is narrow.** This applies *only* to claims about AFK runner
behaviour. It is not licence to disregard a project's own coding standards, review
rules, architecture constraints, security policy, or any other instruction that is
not a claim about how the runner works — those remain fully in force, and where
they conflict with nothing in this document there is no conflict to resolve.

**The worked example.** A project doc that reads:

> `maxParallel` caps concurrent lanes.

was true under v1 and is false under v2. An operator who sizes an epic against
that sentence will set `maxParallel: 2`, expect two lanes, and get one per
dependency-free root up to their core count — which on a repo whose lanes share
files is bought entirely in merge conflicts. The correct reading is breaking
change 1: `maxParallel` is a floor, and `max_parallel` in the epic's `afk:` block
is the cap. Fix the sentence in the project's docs; do not follow it.

### Checklist: find your own stale claims

Run these in a consuming repo and read every hit against the sections above.

```bash
# 1. The config semantics that inverted.
grep -rn "maxParallel" --include="*.md" --include="*.yaml" --include="*.yml" .

# 2. Readers of report shapes that changed.
grep -rn "report\.raw\|fixes\.json\|state\.supervisor\b" .

# 3. Anything asserting a verifier report's status without reading skipped.
grep -rn "status.*\"ok\"\|skipped" --include="*.md" .

# 4. The archive path that moved.
grep -rn "\.afk/epics\|rm .*\.afk/state\.json" .

# 5. Instructions telling a lane agent to delegate — now denied.
grep -rni "sub-agent\|subagent\|Task tool\|delegate" --include="*.md" .

# 6. CI triggered on PR open or synchronize, which now fires per merged lane.
grep -rn "pull_request" .github/workflows/ 2>/dev/null
```

---

## What v2 is actually proven on

A reader deciding whether to adopt v2 needs this more than the feature list above.

v2 is proven on **three epics on one throwaway playground** — `gitproj-demo`: six
files, no dependencies, no linter, no build step — plus **the runner's own
repository**. The reflections behind most of these fixes come from real runs on
real projects, but the *fixes themselves* were validated in the playground.

Two specific gaps follow from that, and both matter on a first real adoption:

- **The `skipped[]` path has never met a project with a real install or a real
  linter.** Its detector is deliberately narrow and pinned against three false
  positives from this repo's own vocabulary, but this repo's vocabulary is not
  yours. Expect to tune it. Related and untested: whether a live fixer agent
  actually populates `duplicateOf`. The contract and the counting are pinned; the
  behaviour is not.
- **The `maxParallel` raise was validated where lanes touched disjoint one-line
  files.** That is the best case for concurrency and tells you nothing about
  yours. On a real repo, more concurrent lanes means more merge-conflict surface,
  and every lane is a full agent session with its own bill. **On a first real v2
  run, set `max_parallel` in the epic's `afk:` block deliberately** rather than
  discovering the root width at 3am. One real run already went serial on purpose
  because its two roots both appended to `package.json`.

Two more things worth knowing about the evidence itself. The semantic plan review
is an LLM agent and is not deterministic — the same epic body passed clean and was
refused four minutes later. And every gate in this runner can pass over a control
wired to nothing: a settings toggle shipped with zero non-test callers while
typecheck, lint, both test suites and the build were green, because no gate traces
a setting to its consumer.
