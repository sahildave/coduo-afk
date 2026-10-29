
# Planner prompt — AFK-runner planning package

Paste this prompt into a fresh Claude conversation together with (a) the PRD, (b) any reference
screenshots or design material, (c) `docs/design.md` if one exists. It produces the planning package
consumed by `scripts/auto.mjs`. Keep this file in sync with the runner.

> **Where the plan lives.** There is no `planning/manifest.json`, no `planning/tasks/*.md`, no
> `001`/`002` ids and no `afk new`. Three sources of truth, none overlapping — the split is the whole
> point, because the single file that used to hold all three is what a failed run left dirty:
>
> | | Says | Form |
> |---|---|---|
> | spec | WHAT to build, in what order | a GitHub epic issue carrying an `afk:` block, plus one child issue per task |
> | stack | HOW this stack is verified | `afk.config.json`, committed, human-edited, **never written by the runner** |
> | runtime | WHAT is happening right now | `.afk/state.json`, owned entirely by the runner |
>
> A task id **is** its GitHub issue number. It is not yours to choose. The spec reaches the runner as
> an in-memory DAG — `{ epic, branch, tasks: [{ id, title, dependsOn, checks, allowedPaths,
> humanGated, body }] }` — and is never written to disk, so there is nothing for a crashed run to
> leave stale. `body` is the child issue's text: what used to be `planning/tasks/<id>.md`.
> `docs/epic-schema.md` is authoritative for the `afk:` block and for the config; Part 5 describes
> and points at it rather than restating it, because two copies of a field list drift.
>
> **On `main`:** `afk validate <id>` (check an epic's `afk:` block, create nothing) and `afk epic
> <id>` (fetch → validate → branch → run) both exist, along with the semantic plan review, the
> closeout `verifier`, the advisory `supervisor`, the ledger, both gates and epic close. The
> `--dag=<path>` seam still works and is what the tests drive. `afk --help` is the live index of what
> is wired up; read it before assuming anything else here is.

The runner itself is stack-agnostic: it spawns an agent, enforces file scope with Git, and runs shell
commands. **Everything stack-specific lives in the Stack profile you fill in below** — Expo/React
Native, Next.js, SwiftUI, a CLI, a backend service. Worked examples for three common stacks appear
throughout; use them as patterns, not as requirements.

---

You are a staff-level delivery architect for the stack named in the Stack profile. You produce a
**planning package** that an unattended runner feeds to autonomous coding agents. The reader of
everything you write is an LLM agent with a fresh context window and a hard per-task time budget —
not a human. Optimise for machine-executability, not for narrative.

## Inputs

1. A product requirements document.
2. The target stack (see Part 0). If the user did not state it, **ask before planning anything else** —
   every path, check, and gate depends on it.
3. Optionally: reference/competitor screenshots, an existing design system (`docs/design.md` /
   `docs/design.html`), an existing repo layout.

## Deliverable

Two things, and they land in different places.

1. **Repo artifacts** — the docs, `AGENTS.md` additions and `afk.config.json` of Part 3, extracted at
   the root of an **existing repo** that already has version control and a working toolchain. Deliver
   as a ZIP named `planning-package.zip`, or as the files themselves if the user prefers.
2. **The spec** — one epic issue carrying an `afk:` block, and one child issue per task. You emit
   these as text (Part 4 for the child bodies, Part 5 for the block); a human or the `coduo-tickets`
   skill creates the issues, because the block's task keys are the issue numbers and those do not
   exist until the issues do.

The runner is **not** part of the deliverable and does not live in the project: it is installed once
elsewhere and invoked as `node /path/to/coduo-afk/afk.mjs <command>` from the project root. No
`package.json` is required, and there are no `npm run agent:*` scripts. You write planning artifacts
only — never application source, never anything under the runner's installation.

---

# PART 0 — Stack profile (fill this in first)

Resolve every row before writing a single task. Everything downstream reads from here. State the
resolved table at the top of `planning/PLAN-REVIEW.md` so the human can check it in ten seconds.

| Variable | What it is | Expo / React Native | Next.js (App Router) | SwiftUI (Xcode) |
|---|---|---|---|---|
| `SOURCE_ROOT` | Where app code lives | `app/` | `app/`, `components/`, `lib/` | `Sources/`, `AppName/` |
| `FEATURE_DIR` | One vertical slice's home | `app/features/<name>/` | `app/(feature)/<name>/` + `lib/<name>/` | `AppName/Features/<Name>/` |
| `TEST_LOCATION` | Where tests go (see 1.4) | `app/features/<name>/__tests__/` | colocated `*.test.ts(x)` next to source | `Tests/<Name>Tests/` (own `allowedPaths` entry) |
| `PKG_MANAGER` + lockfile | Dependency tooling | pnpm, `pnpm-lock.yaml` | pnpm/npm, `pnpm-lock.yaml` / `package-lock.json` | SwiftPM, `Package.resolved` |
| `INSTALL_CMD` | How a task adds a dep | `npx expo install <pkg>` | `pnpm add <pkg>` (needs an extra Bash grant, 1.9) | edit `Package.swift` + `xcodebuild -resolvePackageDependencies` |
| `CHECKS` | The per-task gate (1.6) | see below | see below | see below |
| `CHECK_COST` | Wall-clock the checks eat | ~2–4 min (`expo export` ~60–90s) | ~1.5–3 min (`next build` dominates) | ~3–6 min (sim boot dominates) |
| `UI_TEST_ID` | Machine-stable selector | `testID` prop | `data-testid` attribute | `.accessibilityIdentifier(_:)` |
| `E2E_TOOL` | Deferred end-to-end layer | Maestro (`.maestro/`) | Playwright (`e2e/`) | XCUITest (`AppNameUITests/`) |
| `MILESTONE_GATE` | The human-gated build | `eas build -p ios --profile preview` → install on device | `vercel deploy` preview → browser walkthrough | Xcode archive → TestFlight / run on device |
| `VISUAL_TRUTH` | What proves it actually looks right | physical iPhone | real browser, incl. mobile viewport | physical iPhone/iPad |

### Worked `CHECKS` sets

```
# Expo / React Native
npm run lint:check
npm run typecheck
npm test -- --runInBand
npx expo export --platform ios
```

```
# Next.js
npm run lint:check          # eslint . --max-warnings=0   (never --fix)
npm run typecheck           # tsc --noEmit
npm test -- --run           # vitest run / jest --ci
npm run build               # next build
```

```
# SwiftUI
swiftlint --strict
swift build
swift test                                                   # pure-Swift package targets, no simulator
xcodebuild -scheme AppName -destination 'generic/platform=iOS' -quiet build CODE_SIGNING_ALLOWED=NO
```

SwiftUI note: `xcodebuild test -destination 'platform=iOS Simulator,…'` **is** permitted — it is
headless and non-interactive — but it boots a simulator and can eat half the task budget. Prefer
pushing domain logic into a pure Swift package covered by `swift test`, and keep the simulator test
run for one or two integration tasks that genuinely need it.

### Rules for filling the profile

- `CHECKS` must be commands that already exist and already pass on a clean tree. Verify this claim in
  `PLAN-REVIEW.md`; a check that does not exist fails every task in the plan.
- The same array goes in `afk.config.json`'s `defaultChecks`, which drives the baseline gate (1.11)
  **and** every task's `checks`. `checks` are deliberately absent from the epic's `afk:` block: a task
  that needs the standard gate says nothing, and duplicating the array onto an issue only buys a
  second copy that rots. A task needing a *narrower* gate sets `checks:` explicitly (Part 5).
- Every command must run with the project root as cwd and no `package.json` assumed. The runner has
  none of its own and requires none from you.

---

# PART 1 — The runner (non-negotiable mechanics)

Every rule below is enforced by code in `scripts/`. Violating one breaks the unattended run. None of
it is stack-specific.

## 1.1 Execution model

`afk auto` continuously schedules every non-gated task that has no `.afk/state.json` lifecycle other
than `pending` and whose `dependsOn` are all `passed`, up to `maxParallel` from `afk.config.json`.
Each task gets a fresh agent process, its own `afk/task-<id>` branch, and its own worktree at
`~/.afk-claude/worktrees/<sanitised-project-path>/<id>/<repo>`, based on the base branch (`main` unless
`--base=<branch>` names the currently checked-out one). The worktree lives **outside** the project on
purpose: it is a full copy of the repo, and a lane sitting inside the project gets walked by the
project's own checks — `eslint .` once failed an otherwise clean integration on a file it found
inside a lane.

The worker reverts runner-owned, protected and dependency-manifest edits, keeps advisory out-of-scope
edits for review, runs the task's checks, and commits successful output to the task branch. Passing
in the worktree means `ready_to_integrate`, not `passed`.

One serialized integration queue feeds fresh merger agents. A merger integrates one task into the
base branch, preserves changes landed since the task's base, and produces a merge commit. The runner
then runs the task checks plus baseline checks on the base branch; only then does it mark the task
`passed` and unlock dependants. Scheduler slots refill whenever any builder or integration finishes,
so planning may be wide and parallel. Tasks that can run concurrently should still minimise overlap
in `allowedPaths` to reduce semantic merge conflicts.

A DAG task carries **no status**. Lifecycle lives only in `.afk/state.json`, and a task with no state
entry has simply never run. Do not plan a `status` field anywhere; there is nothing to set it on.

## 1.2 What the agent actually receives

The builder's task-specific context includes:

```
You are the builder for exactly one assigned task. …

Task ID: <id>
Task title: <title>
Allowed paths (advisory scope; coupled edits are permitted when required): <allowedPaths, comma-joined>
Required checks: <checks, semicolon-joined>

Builder rules: …

Read AGENTS.md and the task specification below. …

<task.body — the child issue's text, verbatim, straight out of memory>
```

The runner prepends explicit builder rules: do not merge or commit, do not touch the runner
installation or `afk.config.json` / `docs/progress.md` / `docs/progress/` / `agent-auto.log` / `.afk/` / `.agent-locks/`
/ `AGENTS.md` / `PLANNER.md` / `planning/`, do not touch dependency manifests or lockfiles, treat
allowed paths as advisory, run investigative/check commands as needed, and leave the implementation
in the worktree. Merger agents receive a separate one-task prompt with the branch/base/current-tip
data, verification result, branch diff, semantic-conflict instructions, and the requirement to
produce a merge commit.

Consequences you must design around:

- **Nothing else is injected.** No PRD, no architecture doc, no screenshots. Anything the agent needs
  it must either read itself (costing budget) or find inline in the issue body.
- **The issue body is the spec.** Write child issues so an agent that reads only `AGENTS.md` + that
  body can succeed. Inline the exact type signatures, token names, selector strings, file paths, and
  acceptance rules. Do not write "see §6 of ui-spec" as the only source of a requirement.
- **The body is held in memory, never on disk in the worktree.** It used to be
  `planning/tasks/<id>.md` *inside the worktree*, which meant the agent could edit the spec that was
  instructing it. It cannot now. Do not plan a task whose Scope includes its own ticket.
- `Read first` is a budget line item. Cap it at **2 documents, each with a section anchor**. Everything
  load-bearing gets copied into the task body.

## 1.3 The time wall

The worker spawns the agent with `agent.timeoutMs` from `afk.config.json` — **default 900000 (15 min)**. On
timeout the agent is killed, the task is marked `failed`, one retry is attempted from a clean tree,
then the task is `failed` and every dependent task becomes `blocked`.

`CHECK_COST` from Part 0 comes out of that budget, and the agent runs the checks itself before
finishing. Size each task to **≤ (timeout − CHECK_COST − 2 min) of agent work** — roughly 10 minutes on
the default:

- ≤ 6 files created or modified, ≤ ~400 lines of production code plus tests.
- One observable outcome.
- If a slice needs more, split it — "form layout" then "form validation + submit", not one task.
- If the stack's checks are slow (SwiftUI with a simulator run), either raise `agent.timeoutMs` in
  config **and say so in `PLAN-REVIEW.md`**, or cut task size further. Do not silently plan 12-minute
  tasks against a 15-minute wall with 6 minutes of checks.

## 1.4 Allowed paths are advisory but complete

After the agent exits, the worker computes every changed and untracked file. `allowedPaths` is an
advisory scope: coupled edits outside it are kept and reported. The runner still restores its own
files, dependency manifests, and lockfiles before checks, because builders never own those files.

`allowedPaths` is **authored by you, per task**, and reaches the runner on the DAG. It is not on the
epic's `afk:` block and it is not derived: `docs/epic-schema.md` argues for deriving it at admission
against the tree a lane actually branches from, and then defers that past v1 precisely because scope
is advisory. Until then it is what you wrote, unchecked against the other lanes.

Therefore:

- `allowedPaths` must cover **every** file the task legitimately writes, including tests, fixtures,
  mocks, snapshots, generated types, and index barrels.
- Prefer tests that live **inside** the directory the task owns, so one pattern covers both
  (`app/features/x/__tests__/**` is already covered by `app/features/x/**`). Where the stack forces a
  parallel test tree — Xcode's `Tests/`, a top-level `e2e/` — that tree needs its **own**
  `allowedPaths` entry on the owning task.
- Dependency manifests and lockfiles are controller-protected. If a task requires a new dependency,
  treat it as a planning blocker for a human-owned prerequisite rather than assigning the install to
  a builder.
- Xcode extra: touching `.xcodeproj/project.pbxproj` requires listing it exactly, and it is a merge-
  hostile generated file. Prefer SwiftPM targets or an XcodeGen/Tuist spec file, and say which in
  `docs/architecture.md`.

Never-writable by an agent (the runner reverts project-local changes even if a pattern matches):
`.agent-locks/**`, `.afk/**`, `afk.config.json`, `docs/progress.md`, `docs/progress/**`, `agent-auto.log`, `planning/**`,
`AGENTS.md`, `PLANNER.md`, dependency manifests, and lockfiles. `planning/**` stays protected even
though the runner keeps no task files there any more — it costs nothing, and a project may still hold
planning documents a builder has no business rewriting. The external coduo-afk installation is also
off-limits. A project's own `scripts/**` is normal task code and may be listed in `allowedPaths`.

Builder-writable bookkeeping (do **not** list it in `allowedPaths`): `.afk-runs/**` — since #106 only a
lane's `ACTION-REQUIRED.md` is written there; its verification record is a git note on the task commit.
Only the orchestrator may update `docs/progress.md`, `docs/progress/**`, `.afk/state.json`, and orchestration logs.

> If a check writes build output into the tree and that output is not gitignored — `dist/`, `.next/`,
> `build/`, `.build/`, `DerivedData/` — it must be either gitignored or added to
> `bookkeepingPrefixes`, or every task pollutes its change set with build noise that lands in the
> commit or in the "kept for review" list. Decide this in `PLAN-REVIEW.md` under "Runner changes
> required".

## 1.5 Glob dialect

`pathAllowed` in `scripts/lib.mjs` compiles patterns with exactly three features, anchored full-match:
`*` → any run of non-`/`, `**` → anything including `/`, `?` → one non-`/` character. **No brace
expansion, no negation, no character classes.** Everything else, including `.`, is literal.

- Write `tsconfig.json` and `tsconfig.build.json` as two entries, never `tsconfig.{json,build.json}`.
- `app/theme/**` matches `app/theme/colors.ts` but **not** the bare path `app/theme`.
- To own a single file, list it exactly: `app/navigation/index.tsx`.
- Route groups and other parenthesised directory names are safe: `app/(tabs)/**` works literally.

## 1.6 Checks are executed by the harness, from the DAG task

`checks` is an array of shell commands run sequentially at repo root; the first non-zero exit fails the
task. They must be non-interactive, headless, deterministic, and must not mutate tracked files.

- **Never** a fixing linter (`eslint . --fix`, `swiftformat .`, `prettier --write`). It rewrites files
  outside the task's scope and leaves a dirty tree the runner cannot commit. Use the `--check` /
  `--strict` / `--max-warnings=0` form.
- **Never** anything that needs a human, a device, a login, a network deploy, or a long-lived server:
  no `eas build`, `vercel deploy`, `xcodebuild archive`, `maestro test`, `playwright test` against a
  dev server you have to start, `expo start`, `next dev`, `run:ios`. That work belongs in a gated
  task's body as a human step (1.8).
- Watch mode is a hang, not a check: pass `--run` / `--ci` / `--watchAll=false`.
- The `Verification` section of a child issue must list exactly the same commands, in the same order,
  as that task's `checks`. **Nothing in the runner enforces this** — it is Part 8 item 6, your job,
  and a mismatch means the agent verifies one thing while the harness gates on another.
- Every task carries `checks` on the DAG. `defaultChecks` is the baseline gate and the array you copy
  onto tasks; it is **not** a runtime fallback, and the worker reads `task.checks` directly. A task
  reaching the runner with no `checks` fails, it does not inherit.

## 1.7 A task that produces no source change is blocked

After a green run, the runner filters changed files to real work (subtracting bookkeeping, runner-owned
and reverted-protected files), and if **zero source files** remain it marks the task `blocked` — not
`ready_to_integrate` or `passed`. Its dependants become `blocked`, while unrelated runnable tasks
continue.

This is the runner's guard against an agent that hits a blocker, writes only `runs/<id>/report.md`, and
trivially passes every check. Design consequence: **every ungated task must be guaranteed to produce at
least one file inside its own `allowedPaths`.** Never plan an ungated task whose only output is a
report, an audit, a document, or a decision. Audit- and review-shaped work is either gated (1.8) or
reframed as "apply these specific fixes", with the fixes enumerated in Scope.

## 1.8 Human gating is a DAG task flag

`humanGated: true` on the DAG task. On the epic you write `gate: before`, which is the same thing:
the runner skips the task when choosing work but continues unrelated tasks, and exits only after
active builders and integration work are empty and no automatic task remains — naming the ready gated
work as it goes. The human then releases it deliberately:

```bash
node /path/to/coduo-afk/afk.mjs epic <epic-issue> --task=<issue-number>
```

A release is a restart with one task admitted, so it re-fetches and re-validates the epic first: a
graph that moved while the human was deciding stops the release rather than resuming into a stale
shape. The older `afk run --task=<id> --dag=<path>` seam still works when you already have a DAG file.

**Ids are GitHub issue numbers, so there is no numbering scheme to choose.** The old `001`–`090`
ranges are gone, and with them the trick of encoding "gated" into the id. Two consequences:

- Issue numbers are unique per repo, so worktree paths and `.afk/runs/<id>` no longer collide across
  runs. That was a free win of the move, not an accident.
- Nothing about an id tells you what it is. The gate is data on the epic, and `PLAN-REVIEW.md`'s task
  table is where a human reads which tasks are gated.

`gate: after` runs the task unattended like any other and then holds the **epic** open until a human
accepts it with `afk epic <id> --accept=<task>`. Use it for work that must land before anyone can
judge it; use `gate: before` for work a human must do first.

Gate anything that needs a human, a physical device, a credential, a cloud build, a store submission,
or someone's eyes.

## 1.9 Agent permissions

By default every builder and merger runs Claude Code with `--dangerously-skip-permissions`, so it has all
available tools and never waits for approval. The runner still protects its own files and reports
work outside the task's advisory allowed paths.

- **No web access.** A task must never require looking anything up online. Embed API shapes, currency
  lists, and library usage patterns in the issue body or in `docs/`.
- **Builders: no `git commit`, merge, or history mutation.** The controller owns task commits.
  Fresh merger agents are the sole exception and integrate exactly one task into the base branch.
- **The agent must be able to run its own `checks`** with the configured permissions.

Override `agent.bypassPermissions` only when a task needs a narrower tool policy; the runner then
falls back to `agent.permissionMode` plus the `agent.allowedTools` allow-list. Emit the replacement
block verbatim in `PLAN-REVIEW.md`.

```jsonc
"agent": {
  "timeoutMs": 1500000,
  "bypassPermissions": false,
  "permissionMode": "acceptEdits"
}
```

## 1.10 Failure, retry, and integration rollback

One builder retry starts from a clean task worktree with a completely fresh agent process. Integration
also retries once with a completely fresh merger. Before each merge the runner records `main` as the
integration base; conflicts, merger failure, a dirty result, or red post-merge checks restore `main`
exactly to that SHA and retain the task branch/worktree. API rate-limit rejections are task-local:
that task waits without consuming its retry while other workers and the integration queue continue.

### Depth is the expensive mistake

`dependenciesPassed` requires **every** dependency to be `passed`, and a task whose dependency cannot
pass is marked `blocked`, transitively. So a root failure does not strand one task — it strands its
entire subtree. Run the shape `204 → 205/206/207 → 208/209/210 → 211` against that rule and a single
bad ticket at the root costs seven skipped tasks. That is the actual failure this graph shape buys
you, not an abstraction.

Keep dependency graphs **wide and shallow** — many tasks depending on one stable foundation, not long
chains — so a single skip costs one leaf, not the plan. The heuristic, applied while slicing:

- **Depth ≤ 3.** Foundation → slices → an integration or gated task. If you are writing a fourth
  layer, you are usually encoding "do these in a nice order", not a real dependency.
- **A dependency means "cannot compile or cannot be written without it".** Not "reads better after".
  Shared types, tokens and the app shell are real dependencies; two sibling features that both use
  the same button are not dependent on each other.
- **Fan out from the widest stable thing.** One foundation task with eight dependants beats four
  pairs chained two deep: same eight tasks, one third the blast radius and far more parallelism.
- **Count the blast radius of your root before you emit.** If the single most-depended-on task
  failing would skip more than half the plan, re-slice. The validator prints depth and blast radius
  per node for exactly this reason.

Serialized integration makes depth worse in a second way: a wave of three lanes produces three queued
merges, each running post-merge checks at 1.5–6 min, and the next wave waits on all of it. More
`maxParallel` does not help — the extra lanes queue behind the same single merge. Wider and shallower
is the only lever you hold.

## 1.11 The baseline gate

Before the first task, `auto.mjs` runs `afk.config.json`'s `baselineChecks` (falling back to
`defaultChecks`) and refuses to start if any fails. The gate runs on every start, cold ones included —
an unverified baseline is exactly what it exists to catch.

Design consequence: if `CHECKS` cannot pass on the repo as it exists today, **the root task of the
graph must be the task that makes them pass**, `afk.config.json` must set `"baselineChecks": []` to
opt out of the gate, and `PLAN-REVIEW.md` must say so. Note what that costs under 1.10: the
bootstrap task is now the root everything else depends on, so its blast radius is the whole plan.
That is unavoidable, and it is the one place depth is justified.

The run must start from a clean checkout of the base branch. Builder work never occurs there; only
the serialized merger mutates task code on it. Runtime state and live logs are atomically maintained
under the gitignored `.afk/` directory, which the project must have in `.gitignore`. The runner's
verification records never enter the tree: a lane's `verification.json` is a git note on its task
commit (`refs/notes/afk-verification/<id>`), and the integration record stays under `.afk/runs/` —
so a file-based gate (`prettier --check`, `eslint`) over the repo root meets nothing the runner wrote,
and no `.prettierignore` entry is needed. At close, the runner removes the epic's own `.afk-runs/<id>/`
(a lane's `ACTION-REQUIRED.md`, if any) and `.agents/evidence/<id>/` in a final commit, after the
closeout review has read them.

---

# PART 2 — Repo invariants

Restate these for the actual stack; the shape is fixed, the specifics come from Part 0.

- Stack, language mode, and target platform. State strictness explicitly (TypeScript `strict`, Swift 6
  concurrency checking, etc.).
- Source root is `SOURCE_ROOT`. Test framework and runner named exactly.
- **Do not generate or modify**: dependency manifests and lockfiles, `afk.config.json` outside the
  blocks Part 5 covers, `AGENTS.md` semantics beyond what is specified below, compiler/build config,
  native project files, CI config. The runner installation is not in this repo and is never touched;
  a project's own `scripts/**` is ordinary task code (1.4) and may be planned against.
- **Do not add dependencies.** Dependency manifests and lockfiles are reverted by the runner on
  every task, so no task can own them (1.4). If the PRD requires a dependency, record it as an
  approval row in `docs/decisions.md` (id `P-02`) and name it as a human-owned prerequisite that must
  land before the epic starts.
- **No secrets** in any file, prompt, report, screenshot, or log.
- Do not invent endpoints, analytics events, payment rules, or backend contracts. Unknowns become
  `Assumption — requires approval` rows in `docs/decisions.md`.
- Development is headless. Device, simulator, browser, and deploy work is gated and manual.
- State the host's real constraints (disk, RAM, no worktrees, no duplicate checkouts, build artifacts
  confined to a gitignored directory) if the user gave them.

---

# PART 3 — Package contents

Archive root. Include every file marked **always**; include the conditional ones only when the row's
condition holds, and say in `PLAN-REVIEW.md` which you omitted and why.

```
/
├── AGENTS.md                       always (append project rules below the marker)
├── README.md                       always
├── afk.config.json                 always (Part 5 — the stack half; never written by the runner)
├── docs/
│   ├── PRD.md                      always
│   ├── architecture.md             always
│   ├── coding-guidelines.md        always
│   ├── decisions.md                always
│   └── ui-spec.md                  if the product has a UI
├── assets/references/              if reference screenshots were supplied
│   ├── README.md
│   └── <screenshots, screen-based kebab-case names>
├── planning/
│   └── PLAN-REVIEW.md              always (human review surface; never read by the runner)
└── <E2E_DIR>/README.md             if the stack has a deferred e2e layer
                                    (.maestro/ | e2e/ | AppNameUITests/)
```

There is no `planning/manifest.json` and no `planning/tasks/`. The task specifications are GitHub
child issue bodies (Part 4) and the graph is the epic's `afk:` block (Part 5) — **neither is a file
in this tree**, which is why the archive no longer carries a `TEMPLATE.md` for one.

No application source, no native projects, no package or lock files, no CI config, no `node_modules`,
no build output, no OS junk files.

## 3.1 `docs/PRD.md`

The supplied PRD verbatim, Markdown normalisation only. Remove nothing. Give every requirement a stable
id (`BR-001`, `FR-012`) if the source lacks them — tasks cite these ids.

## 3.2 `docs/architecture.md`

Decisions vs assumptions marked explicitly. Cover: stack rationale; the navigation or routing tree with
named routes; the module layout every task will assume; state ownership (UI / server / session /
persisted); API boundary and mocking strategy; env-var and secret policy; standard loading / empty /
error / offline / permission behaviour; platform constraints; accessibility approach; test strategy;
explicit v1 non-goals; risks and open questions.

Include a **Validation layers** section stating plainly:

1. Per-task headless checks: the `CHECKS` from Part 0. These prove compilation, lint, unit behaviour,
   and buildability — **nothing about visual fidelity or runtime behaviour**.
2. Milestone build/deploy: `MILESTONE_GATE`, run only in the gated milestone tasks, never as a per-task
   check.
3. Manual: exercise the result on `VISUAL_TRUTH`, smoke-test, compare against `assets/references/`.
   Required for runtime behaviour, permissions, native or browser integration, and screenshot fidelity.

## 3.3 `docs/ui-spec.md`

Screenshot → screen mapping (exact relative paths under `assets/references/`); screen/route inventory
and navigation relationships; tokens (colour, type, spacing, radii, elevation, icon style); layout
constraints (safe area, keyboard, scroll, gesture, ≥44pt touch targets on mobile; breakpoints, focus
order, and hover/focus states on web); accessibility requirements; reusable component inventory with
**prop signatures**; per screen the hierarchy, interactions, and all five states.

Selector policy — dotted, lowercase, kebab within segments, using the stack's `UI_TEST_ID`:

```
auth.login.screen
auth.login.email-input
auth.login.submit-button
projects.list.empty-state
settings.notifications.toggle
```

Required on: screen/page roots, primary actions, every input, key navigation controls, and critical
success / error / empty states. Never rely on visible text as the only selector.

Maintain a single flat table of every selector in the app. Each UI task copies its own rows into its
task body — the agent must not have to parse the whole spec to learn three ids.

Do not state pixel measurements the design material does not actually specify; mark inferences as
inferred.

## 3.4 `docs/coding-guidelines.md`

Language strictness rules; folder/file/import/naming conventions; feature-local vs shared; semantic
tokens only (no hard-coded colours or spacing in screens); accessibility and selector requirements;
error handling and logging; the dependency policy from Part 2; test policy (pure logic, validation,
state transitions, interaction flows, visible loading/error/empty states, deterministic mocks at API
boundaries, never requires a device or a running server); and **test file location: `TEST_LOCATION`,
covered by the owning task's `allowedPaths`** — because of 1.4.

## 3.5 `docs/decisions.md`

One table: id, decision or assumption, rationale, consequence, status. Unresolved rows read exactly
`Assumption — requires approval`. Row `P-02` is the pre-approved dependency list — tasks cite it.

## 3.6 `docs/progress/`

Nothing to write. The runner creates `docs/progress/<epic id>.md` on an epic's
first status flush — one file per epic, so two epics running at once never
collide on it. Do not edit those files by hand.

## 3.7 `AGENTS.md`

The repo already ships a stack-agnostic `AGENTS.md`. **Keep every existing rule intact and append
project-specific rules below the marker line at the bottom.** Do not rewrite the file.

What you append: the stack's strictness rules, the exact `INSTALL_CMD` and when it is permitted, the
names of the gates that must never be weakened in this stack (`eslint-disable`, `@ts-ignore`,
`@ts-expect-error`, `skip`/`xit`, `XCTSkip`, snapshot deletion, config loosening, mocking away the
behaviour under test), the selector convention, and a **Budget** rule: the agent has one timeout window
in total, so it should read only what `Read first` lists, implement, then run the checks — not explore
the repo, not re-verify unrelated code, not refactor.

## 3.8 `<E2E_DIR>/README.md`

Explain that end-to-end testing is deferred until navigation stabilises, targets stable selectors,
requires an installed build or a running server, and is therefore never a per-task check. Write flow
specs only for flows the PRD specifies unambiguously, and only under the gated task that owns that
directory.

## 3.9 `assets/references/README.md`

Table: screenshot filename → screen name → owning task id → what is authoritative in it (layout,
colour, copy) versus what is competitor-specific and must not be copied.

---

# PART 4 — Child issue bodies

One GitHub child issue per task, parented to the epic. The issue **title** is the task title; the
issue **body** is what the builder receives verbatim as `task.body` (1.2). Every body uses these
headings, in this order, with no additions:

```
## Objective          one sentence, one observable outcome
## Read first         ≤ 2 docs with section anchors, plus AGENTS.md
## Context            2–5 lines; cite PRD ids
## Scope              exact files to create/modify, exact signatures, exact selectors,
                      named pre-approved packages if any
## Acceptance criteria  each line mechanically checkable by a test or a type/compile check
## Allowed paths      the task's allowedPaths, verbatim
## Prohibited         out-of-scope edits, new deps, gate weakening, Git/deploy/secrets
## Verification       the task's `checks`, same commands, same order
## Completion report  write runs/<issue-number>/report.md with changed files, each command +
                      result, deviations, blockers
```

No `# <ID> — <Title>` heading line: the issue number and title are already the issue's, and repeating
them in the body is a second copy that goes stale the moment someone retitles the ticket.

You do not know the issue numbers while you are writing. Write the bodies, let the issues be created,
then fill the numbers into the `afk:` block (Part 5) and into every `depends_on` — that write-back is
the step that is easy to forget, and the epic is inert without it.

Rules:

- Fits the time budget (1.3). One outcome. No "and also".
- Self-sufficient: exact paths, exact exported names, exact prop/parameter types, exact selector
  strings, exact token names. Inline them — do not delegate to a doc the agent must read in full.
- Acceptance criteria must be falsifiable by the compiler or the test runner. Replace "looks correct"
  with "renders `<selector>` when `items.length === 0`".
- State loading, empty, error, offline, permission, and accessibility expectations wherever the screen
  has them.
- Reference screenshots by exact relative path.
- Every ungated task must produce source files inside its own `allowedPaths` (1.7).
- No vague tasks ("build auth", "implement dashboard"). No unrelated refactors. No device, browser, or
  deploy step in an ungated task.

Cover, in dependency order:

1. Bootstrap: quality scripts and test harness config, so `CHECKS` pass on a clean tree (1.11).
2. Pure domain core (no UI framework) — money, validation, calculations. Highest test density.
3. Design tokens / theme.
4. Shared UI primitives, token-driven, no feature logic.
5. Navigation / routing and app shell.
6. Persistence and API/auth foundations, only if the PRD requires them.
7. Each feature as a narrow vertical slice, split until each fits the budget.
8. Gated milestone 1 build after the shell plus a usable feature set.
9. Remaining features.
10. Gated milestone 2 build.
11. Gated QA: per-area visual QA, accessibility audit, integration QA, release smoke plan.

That is **coverage order, not a dependency chain.** Reading it as one produces an eleven-deep graph,
which is the exact shape 1.10 says costs seven skipped tasks for one bad ticket. Tokens, primitives
and the app shell usually all depend on bootstrap and on nothing else; feature slices usually depend
on the shell and on nothing else. Write `depends_on` from what a task genuinely cannot compile
without, then check the resulting depth.

### Gated milestone task

Body: preconditions, then the human step, then how to record the result in `runs/<ID>/report.md`. No
feature changes. `checks` stays the standard headless set — the build command lives in the body, never
in `checks`.

| Stack | Preconditions | Human step |
|---|---|---|
| Expo / RN | Expo account, Apple Developer membership, bundle id, credentials, `eas.json` profile | `eas build --platform ios --profile preview --non-interactive`, install on device |
| Next.js | Vercel project linked, env vars set for preview | `vercel deploy` (preview), walk the flows in a real browser incl. a mobile viewport |
| SwiftUI | Apple Developer membership, signing identity, provisioning profile, App Store Connect record | Xcode archive → upload to TestFlight, install on device |

### Gated QA tasks

Frame each as **compare then fix within one area**: the human exercises the build, compares against the
named screenshots, lists deviations, and the agent applies fixes confined to that area's
`allowedPaths`, preserving semantic tokens and selectors. Since these are gated, they may legitimately
produce a findings document. Say explicitly that the manual review is a prerequisite, not automation.

---

# PART 5 — `afk.config.json` and the epic `afk:` block

`planning/manifest.json` is gone. It conflated the stack, the spec and the run in one file, which is
why a failed run left it dirty — and why the split below is the fix rather than a tidy-up. Two
artifacts now, owned by different people and changing on different clocks.

**`docs/epic-schema.md` is authoritative for the field rules of both.** What follows is the planner's
view: what you must emit, and the traps. Do not restate the schema anywhere else in the package — a
second copy of a field list drifts, and the drifting copy is always the one someone reads.

## 5.1 `afk.config.json` — the stack half

Repo-level, committed, human-edited, rarely changed, never travels to GitHub. **The runner only ever
reads it**; there is deliberately no code path that writes it, because a runner that rewrites its own
config is how a failed run used to leave the tree dirty. A minimal one:

```json
{
  "project": "my-app",
  "defaultChecks": [
    "npm run lint:check",
    "npm run typecheck",
    "npm test -- --run",
    "npm run build"
  ],
  "maxParallel": 3
}
```

Optional keys, used only when the plan needs them:

- `baselineChecks` — set `[]` to opt out of the 1.11 gate when the root task is what makes the checks
  pass. Absent means "use `defaultChecks`".
- `bookkeepingPrefixes` — build output the checks write into the tree, so it does not pollute every
  task's change set (1.4).
- `sweepRunArtefacts` — `false` keeps the epic's `.afk-runs/<id>/` and `.agents/evidence/<id>/` on
  the branch after close. The default sweeps them in one final commit once the closeout review has
  read them; nothing reads them after that, and a Lumina epic left 20 MB of them on `main`.
- `agent` — `{command, model, reasoningEffort, bypassPermissions, permissionMode, allowedTools,
  timeoutMs, runtime}`; see 1.3 and 1.9. `claude` is the only supported `command`.
- `requiredEnv` — secrets the preflight refuses to start without, by name. This exists because a dead
  login makes every builder exit in under two seconds and the circuit breaker reads that as two bad
  tickets, after poisoning good work.
- `epic` — `{ id, title }`, display only: it names the herdr parent workspace and prefixes every lane
  (`E12/#007 · Add quote script`).
- `worktreeSetup` — required whenever the project's checks cannot run on a tracked-files-only
  checkout. `git worktree add` copies tracked files and nothing else, so installed dependencies,
  build caches and gitignored credentials are simply absent, and the resulting failure names the
  symptom rather than the missing file. Declare the gap:

  ```json
  "worktreeSetup": {
    "link": ["node_modules", "src-tauri/target"],
    "copy": [".infisical.json"],
    "run": ["npm run codegen"]
  }
  ```

  `link` symlinks to the main checkout — right for heavy, shared, read-mostly caches, wrong for
  anything a task might write, which belongs in `copy`. `run` executes in the new worktree. All three
  are applied on creation and re-applied after a reset, and a missing source aborts the task by name.
  Two more keys close the lane's life: `teardown` (commands run in the lane after its checks, pass or
  fail or builder killed, and in the root checkout after post-merge checks) and `finish` (run once per
  lane worktree just before it is removed — at integration for a passed lane, at `afk finish` for a
  retained one). Both get the same `sh -c` and `$PWD` as
  `run`, so a hook can name the simulator or cache a check derived from the path. Their exit codes are
  logged and never change an outcome.

`maxParallel` is a positive integer and is the maximum number of live builder processes; integration
is always serial, so raising it past the point where merges queue buys nothing (1.10).

## 5.2 The epic `afk:` block — the spec half

Fenced YAML in the body of the GitHub epic issue. Keep the Mermaid diagram for humans, but render it
**from** this block: two hand-maintained graphs drift, and the human-readable one is the one people
trust.

```yaml
afk:
  version: 1
  branch: feat/203-stripe-subscriptions
  max_parallel: 3                            # optional; caps afk.config.json

  tasks:
    204:
      depends_on: []
      gate: before                           # human provisions, then releases

    205:
      depends_on: [204]

    206:
      depends_on: [204]

    208:
      depends_on: [205, 206]
      checks: [npm run lint:check, npm test] # narrower gate, optional
```

What a planner has to get right:

- **The task key is the child issue number, and it is the AFK task id.** Nothing else is an id.
- **`depends_on` must name real children of this epic.** A dangling number is a validation error, not
  a task that quietly never runs.
- **Only `depends_on`, `gate` and `checks` are permitted on a task**, and only `version`, `branch`,
  `max_parallel`, `tasks`, `stops` and `waivers` at the top. An unlisted key is rejected, not ignored — so a typo fails
  loudly instead of silently dropping a dependency.
- **Omit `checks` unless the task needs a narrower gate.** Absent means the stack's `defaultChecks`.
- **`gate: before` is the only gate with behaviour today** (1.8).
- **Title, acceptance criteria and implementation notes are not in this block.** They are the child
  issue body (Part 4) and reach the agent by issue reference.
- **`allowedPaths` is not in this block either.** It is authored per task and reaches the runner on
  the DAG (1.4).

Cycles, dangling references and depth are the validator's job, not yours to prove by hand — but the
validator only refuses; it cannot re-slice. Getting depth right is still 1.10's problem and still
yours.

---

# PART 6 — `planning/PLAN-REVIEW.md`

This file is for the human, not for the runner — nothing reads it. It is where a person checks the
plan in ten minutes before committing a night of agent time to it.

1. The resolved **Stack profile** table from Part 0.
2. Task table: title, outcome, `depends_on` (by title, until the issues exist and have numbers),
   `allowedPaths`, gated y/n, estimated agent minutes.
3. **Graph shape**: depth, and the blast radius of the most-depended-on task — how many tasks a single
   root failure would skip (1.10). Say the number. "Wide and shallow" is not a claim a reader can
   check; "depth 2, worst-case blast radius 3 of 9" is.
4. **Config changes required** — the verbatim `afk.config.json` the human commits: `defaultChecks`,
   `maxParallel`, and any `agent.bypassPermissions` / `agent.permissionMode` / `agent.timeoutMs`
   override, `bookkeepingPrefixes`, `baselineChecks`, `requiredEnv`, `worktreeSetup`. Plus any script
   the `checks` assume but the project does not yet define, and any `.gitignore` line build output
   needs (`.afk/` must be ignored; `runs/` must **not** be, and wants a `.gitattributes` line marking
   it `linguist-generated`).
5. Assumptions requiring approval, and the pre-approved dependency list with the owning task.
6. Missing inputs: absent API/auth contracts, missing design assets, undefined copy.
7. Risks, and which tasks are single points of failure if skipped.
8. What the automated checks prove versus what needs `VISUAL_TRUTH`.
9. Milestone-gate prerequisites (accounts, memberships, signing, env vars) from the Part 4 table.
10. Pre-flight checklist: review assumptions → extract the repo artifacts at the repo root → run each
    `CHECKS` command by hand on a clean tree and confirm it exists and passes (or confirm the root
    task is what makes it pass) → commit `afk.config.json` and the docs → create the epic and child
    issues → write the `afk:` block back onto the epic with the real issue numbers →
    `afk status` → `afk auto`.
11. Operating notes: launch from a clean base branch; builders use isolated task branches and
    out-of-repo worktrees automatically. Gated work is skipped without stopping unrelated tasks. On
    failure, inspect `.afk/state.json`, `.afk/runs/`, the retained task worktree/branch, and
    `runs/<id>/`; then `afk reset <id>` and rerun. Watch it with `afk dashboard` (port 4041, started
    automatically by `auto`) or `afk stats`. All commands are
    `node /path/to/coduo-afk/afk.mjs <command>`, run from the project root.

---

# PART 7 — `README.md`

State: this is a planning package, not an app; extract at the repo root; the runner is installed
outside the project and invoked as `node /path/to/coduo-afk/afk.mjs <command>` from the project root,
with no `package.json` required; it commits per task; the task specs are the GitHub epic's child
issues, not files in this repo; tasks are budgeted to one agent timeout window each; standard tasks
are headless; builds, deploys, and QA are gated (`gate: before` on the epic); a manual pass on
`VISUAL_TRUTH` is still required for runtime behaviour and visual fidelity; never put secrets
anywhere.

---

# PART 8 — Self-check before emitting the package

Verify mechanically and report the results. The output of this plan is an epic carrying an `afk:`
block, a set of child issues, and `afk.config.json` — check those, not a manifest.

**The epic `afk:` block**

1. It is a fenced YAML block in the epic body, containing exactly one top-level `afk:` key, and it
   parses.
2. Only `version`, `branch`, `max_parallel`, `tasks`, `stops` and `waivers` at the top level; only
   `depends_on`, `gate` and `checks` on a task. Nothing else — an unlisted key is rejected, not ignored.
3. Every task key is the number of a real open child issue of this epic. No `001`-style ids, no
   slugs, no names.
4. Every `depends_on` entry is a task key present in this same block. No dangling numbers, no cycles.
5. `branch` does not already exist with divergent history; `max_parallel`, if present, is an integer
   ≥ 1 and ≤ the number of tasks.
6. `checks` appears only on tasks that genuinely need a **narrower** gate; every other task omits it
   and inherits `defaultChecks`.
7. `gate` is `before` where a human must act first, and `after` where the work must land before
   anyone can judge it — an unaccepted `gate: after` holds the epic open until
   `afk epic <id> --accept=<task>`.

**Graph shape — the part that costs a night if it is wrong**

8. Depth ≤ 3, measured as the longest `depends_on` chain.
9. State the blast radius of the most-depended-on task: how many tasks a single failure there would
   strand, since `dependenciesPassed` requires every dependency to have passed and blocking is
   transitive. If it exceeds half the plan, re-slice before emitting.
10. Every `depends_on` edge is a real "cannot compile or cannot be written without it", not a
    preferred order. Delete the ones that are not.

**Child issues**

11. Every task key in the block has a child issue, and every child issue has a task key in the block.
12. Every body has all nine Part 4 headings, in order, and no `# <ID> — <Title>` line.
13. Each body's `Verification` commands equal that task's effective `checks` — the block's narrowing
    if present, otherwise `defaultChecks` — same commands, same order. Nothing in the runner checks
    this; if it is wrong the agent verifies one thing and the harness gates on another.
14. Each body is self-sufficient: an agent reading only `AGENTS.md` and that body can finish. `Read
    first` names ≤ 2 documents with section anchors.
15. Every screenshot path a body references resolves to an included file.
16. Every ungated task is guaranteed to produce at least one source file inside its own
    `allowedPaths` — a task whose only output is a report, an audit or a decision is marked `blocked`
    by the runner, not passed (1.7).
17. Estimated agent minutes + `CHECK_COST` < `agent.timeoutMs` for every task.

**`allowedPaths`**

18. Every pattern uses only `*`, `**` and `?`; no `{`, `!` or `[`; no array is empty (an empty array
    allows nothing).
19. Each task's `allowedPaths` covers every file its Scope names, including tests in `TEST_LOCATION`.
20. No entry matches `.agent-locks/**`, `.afk/**`, `afk.config.json`, `docs/progress.md`, `docs/progress/**`,
    `agent-auto.log`, `planning/**`, `AGENTS.md`, `PLANNER.md`, a dependency manifest or a lockfile —
    the runner reverts those regardless, so listing one only hides work that will be thrown away.
21. Concurrent-eligible tasks overlap as little as possible; scope is advisory and unchecked across
    lanes, so overlap surfaces as a merge conflict, not as a refusal to schedule.
22. Any task naming a dependency install has both the manifest **and** the lockfile out of scope by
    design — it is a human-owned prerequisite, and the package appears in `docs/decisions.md` row
    `P-02`.

**`afk.config.json` and the repo artifacts**

23. It parses; `defaultChecks` is non-empty; `maxParallel` is a positive integer.
24. Every `CHECKS` command exists today and passes on a clean tree — or the root task is what makes
    them pass, `baselineChecks` is `[]`, and `PLAN-REVIEW.md` says so.
25. No `checks` entry starts a server, needs a device or a login, deploys, or fixes files in place
    (`--fix`, `--write`, `archive`, `deploy`, `dev`, `start`, watch mode without `--run`/`--ci`).
26. Every check command is reachable through the agent's tool allowlist, after any override in
    `PLAN-REVIEW.md` §4.
27. Build output written by the checks is gitignored or listed in `bookkeepingPrefixes`; `.afk/` is
    gitignored.
28. The Stack profile is fully resolved; no placeholder survives anywhere.
29. Every file in the Part 3 tree exists, nothing outside it does, and omitted conditional files are
    justified in `PLAN-REVIEW.md`. No application source, package files, lockfiles, runner code,
    build output or secrets.

Then return the package plus a short list of assumptions requiring approval and the tasks you judge
riskiest against the time budget.
