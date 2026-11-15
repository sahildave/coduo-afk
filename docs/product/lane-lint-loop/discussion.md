# Is the "mistake → lint rule" loop real in AFK lanes?

2026-11-15. Audit for Sahil. Plan only: nothing in the runner or the skills is changed.

**Status:** updated 2026-11-15 with the skills Sahil shared. See "Update" below.

## Verdict: partly used, and less every week

The loop is built and it worked for about two weeks. Since 2026-10-13 the runner has not
recorded one new rule.

The loop (#152, #153, #154, #215) lives in four places:

- **Fixer:** each fix must end in a lesson: `rule`, `standard` or `none`
  (`prompts/fixer.md:30-36`).
- **Verifier:** treats a repeat as a gap in a rule, and an edit to a rule as a loosening
  (`prompts/verifier.md:22-26`).
- **Builder:** a builder whose retry passes must report a `LESSON:` line
  (`prompts/implementer.md:50-53`).
- **Closeout:** counts the lessons (`scripts/fixer.mjs:796`, `scripts/defects.mjs:154`).

Counts from the "Closeout fixes" comments on every epic PR opened since 2026-09-28. That
covers 72 PRs in the `sahildave/*` repos plus 23 in `indhuja/shareling`. One lesson line is
counted once, even when the comment was posted again.

| Period | Epic PRs with lessons | rule | standard | none | missing | Total |
|---|---|---|---|---|---|---|
| 2026-09-28 to 10-13 | 23 | **8** | 31 | 24 | 6 | 69 |
| After 10-13 | 18 | **0** | 12 | 47 | 10 | 69 |
| **All** | 41 | **8 (6%)** | 43 | 71 | 16 | 138 |

Gitback has 5 of the 8 rules, at `lessons/...`. Gitsu has the other 3, in `.ast-grep/`.

The repos hold more rules than the fixer reported, because people and Orchestrator fix
passes also write them:

| Repo | Lesson rules on main | Where they came from |
|---|---|---|
| gitback | 17 (`eslint.lessons.mjs`) | 9 from AFK closeout fixes, 8 from task or hand commits. One added after 10-13 (`changelog-cites-need-board-votes`, `cf51fb81`, 11-12, a hand fix) |
| shareling | 15 (14 ast-grep + ESLint home) | Closeouts on 10-07 and 10-18, plus hand fixes up to 11-05. The fixer comments on its 23 epic PRs record **0** rules |
| gitsu | 30+ ast-grep architecture rules | 3 recorded by the fixer, the rest by hand |
| mac-notes, stage-manager | 5, 1 | Copied by hand from shareling |
| coduo-social-content | home exists, **0 rules** | 5 epics, none added one |
| mac-directory, managed-agents, gitsu-tools, open-seo, coduo-billing-infra, coduo-afk | **no lessons home** | the fixer flags `noLessonsHome`, and that is where it ends |

## Where the loop breaks

1. **"none" is now the default answer.** Before 10-13 it was 35% of lessons. After 10-13
   it is 68%. Of the 71 `none` reasons, 37 name a regression test or snapshot as the
   guard ("pinned by the new test; no lintable shape"). A test guards one site. A rule
   guards the whole category. The fixer chooses the test, and the PR comment shows it as
   `none`. Nothing pushes back on a thin `none`. The `coduo-afk` skill asks the closeout
   to send one back (`SKILL.md:657`), but that is a human-read step, and the counts say
   nobody does it.
2. **Hand fixes skip the loop.** Gitback epic #683 had 8 hand commits on its branch and 1
   lesson. After the runner's fix pass, the closeout's own fix pass runs as a
   `/coduo-implement` sub-agent (`coduo-afk/SKILL.md:661`). Its rule 10 asks for a
   lesson, but no report records one and no count shows it. Most of the rules added after
   10-13 came this way, and the runner cannot see them.
3. **A rule shares a commit with its fix, so a revert takes both.** The fixer reported
   gitback `decode-uri-needs-try` (#489) and `no-screenshot-diff-ratio` (#457). Neither
   is on main. `f289c646` reverted the whole closeout fix for #489, and `946cade7`
   reverted the other by a ruling. That is 2 of gitback's 5 recorded rules lost. No one
   decided to drop the rule. It went out with the fix.
4. **Repos with no lessons home lose the lesson.** Six active repos have none. The fixer
   only sets a flag, and the PR note points to `setup-coduo-toolchain`. Nobody ran it.
   mac-directory had 9 epics in 2 weeks with no place to put a rule.
5. **A rule can exist and never run.** stage-manager has an ast-grep rule, but its lane
   gate (`.afk-setup/config.yaml`) and CI never run `ast-grep scan`, so the rule has no
   effect. shareling, futari and mac-notes do run it. Nothing checks that the gate runs
   the lessons home.
6. **Rules spread between repos only when a person copies them.** mac-notes and
   stage-manager have shareling's Swift rules because someone copied them over.
   coduo-social-content has an empty template. This is the reflection-processing session's
   area, so I only note it here.

What works: when a rule lands and the gate runs it, it holds. Gitback has 11 inline
suppressions of `lessons/...`, each with a reason, so the rules fire on real code. The
verifier reads the lessons home every run. Gitback's own audit
(`docs/agents/lesson-rules-audit.md`, #414) showed that a rule written at the first
occurrence would have caught the second, for two classes of private-data exposure.

## Plan, smallest first

Nothing below is guarded in `docs/failure-modes.md` or `docs/validate-lints.md`. Neither
file mentions lessons, so none of these items repeats a fix already made.

1. **Put the rule in its own commit.** Fixer prompt, Step 4: commit each `rule` lesson
   separately from its fix, as `lesson: <id> (#<epic>)`. Reverting the fix then leaves
   the rule. Fixes break 3. Size: one prompt paragraph.
2. **Count `none` and `missing` in the fix-pass line.** The line now reads
   `lessons: 0 rule, 1 standard`. Make it `lessons: 0 rule, 1 standard, 6 none, 2 missing`
   so the drift shows on every PR. Fixes the visibility half of 1. Size: `lessonCounts`
   plus one test.
3. **Add a `test` lesson class, and make the fixer say why it is not a rule.** Shape:
   `test: <file>:<name>`, plus `whyNotRule`. A real one-off stays `none`. The counts then
   separate "guarded at one site" from "guarded nowhere", and every test lesson must
   answer "could this shape appear in another file?" Fixes the hidden half of 1. Size:
   `LESSON_FIELDS`, one prompt line, render.
4. **Add a validate lint, `lessons_home_unrun`.** `afk validate` warns when the repo has
   no lessons home, or has one that no `checks` / `laneChecks` command runs. It is a
   warning, not a block. It fires before launch, while setup can still be done. Fixes 4
   and 5. Size: one lint and one row in `docs/validate-lints.md`.
5. **Record lessons for hand commits on the epic branch.** At closeout, list each epic
   branch commit that no lane or fixer wrote, each with a `Lesson:` commit trailer, or
   `Lesson: missing`. It reuses the mid-run defect list (`scripts/defects.mjs`), which
   already renders `Lesson: missing`. Fixes 2. Size: medium. Do it last, and only if 1 to
   4 do not move the counts.

Left out on purpose: blocking the closeout on a thin `none` (see the open policy
decisions on must-fix), any automatic sync of rules between repos, and any measure of how
often a rule fires.

### Steps for Sahil

1. Send me the skill this loop comes from. I will read it and update the verdict.
2. Choose which items to build: all five, or 1 to 4 now and 5 only if the counts stay
   flat.
3. For each repo without a lessons home that you still run epics on (mac-directory,
   managed-agents, gitsu-tools), decide whether it gets one. If it does, run
   `setup-coduo-toolchain` in that repo.

## Update: the skills Sahil shared (2026-11-15)

Sahil shared five skills. Four are from `cursor/plugins` pstack:
`create-verification-skill`, `principle-prove-it-works`, `show-me-your-work` and
`typescript-best-practices`. The fifth is `e2e-inc/e2e`'s `create-verification-skill`.
`show-me-your-work` cites a sixth pstack skill, `principle-encode-lessons-in-structure`.
That one is the loop itself: *"If the fix is structural, only use the structural fix. The
instruction is the symptom."*

### The verdict against that skill: mostly not used

- **Rules:** 8 of 138 recorded lessons are structural.
- **Standards:** 43 are `standard` lessons, one line of prose added to a coding-standards
  doc. That is the "more text" the skill says to replace.
- **None:** 71 are `none`.

The runner's own `standard` class asks for the symptom.

### Two facts that change the reading

1. **On 2026-10-14 a session spent the day on journey checks for gitback.** Sahil does
   not remember choosing this. The sources are an agent memory
   (`verification-direction-2026-10-14`, which says "chose journey-based verification
   over ESLint lessons") and the page
   `afk-claude-archive/docs/research/verification-2026-10-14.html`. The page opens: "agents
   skip the ESLint lessons, and builders choose their own tests."
   - **What "journey" means here:** a check that drives one user path through the real
     app, such as "a Client saves a FAQ", and asserts what changed in the stores behind
     it, such as "a PR opened and `main` did not move". It does not judge the code.
   - **It did not switch the lint loop off.** `prompts/fixer.md` has not changed since
     2026-09-29. The fixer's last recorded rule (10-13) comes one day before that session,
     so the timing lines up, but nothing in the runner links the two.
   - **It never reached a lane.** `verify-gitback` is in gitback PR #613, open since
     2026-10-15 and unmerged. The page lists "none of this reaches an AFK run yet" under
     its open items.
2. **The fixer misses lessons homes that exist.** The reflection change-list session
   found this
   (`coduo-afk-data/reflection/backlog-2026-11.md`, about 23 reflections). The fixer
   reports `noLessonsHome` where `.ast-grep/rules/` exists. It also does not count a
   `node:test` guard test as a rule. Gitsu epic #1214 reported no home, while gitsu has
   30+ ast-grep rules. This is break 4 from the other side.

### What `verify-gitback` (gitback PR #613) does

PR #613 adds a skill at `.claude/skills/verify-gitback/` in gitback. It is the
`create-verification-skill` recipe written out for one repo.

- **`run.sh`** starts the app, plus fake GitHub and other emulators, on its own ports. It
  warms 81 routes, then runs the Playwright journeys, and `cleanup.sh` stops what it
  started.
- **A doctor check (`DOCTOR-01`)** runs first: are these servers ours, seeded, and can a
  Client reach the Dashboard?
- **Five journeys with IDs** (`LIVE-01`, `LIVE-02`, `FAQ-01`–`03`, `DASH-01`–`02`). Each
  asserts what the fake GitHub holds after the user's action. Example: a FAQ save opens one
  `gitback/faq-…` PR and leaves `main` where it was.
- **One `features/*.md` per feature,** with a "Stand-ins and what they hide" section that
  says what a pass does not prove.
- **`coverage.mjs`** counts journey IDs from the test titles: 8 covered, 16 declared and 8
  blocked when the PR was opened. It exits 1 when an ID loses its test.
- **Explore mode:** an explorer agent (Sonnet, agent-browser) follows a charter such as
  "bad input". A finding counts only when a repro test fails. A recorded path is kept only
  after it replays on a fresh fake GitHub. Its first charter found gitback #604 (an empty
  Question shows a raw internal error) and #605 (a 5,200-character Question saves with no
  limit).
- **Lanes cannot edit it.** It lives under `.claude/`, which lanes cannot write, so a
  builder cannot rewrite the journey that judges it.

Its teeth test is in the PR body. One planted line made a FAQ save also move `main`. Every
screen check stayed green, and `FAQ-03`, the fake GitHub check, went red.

### Why not spread the `e2e` version

These are the reasons the 2026-10-14 session gave
(`verification-2026-10-14.html`, memory `explore-driver-agent-browser`):

- **It was heavier.** `e2e` brings its own runner, config, MCP server and model calls.
  agent-browser plus Playwright already ran the journeys.
- **The trial was on agent-browser.** In four explorer runs, Sonnet at medium beat Haiku
  (74k vs 94k tokens, about half the time). The `e2e` path was dropped, but its method was
  kept: charters, findings with evidence, the repro gate, the freeze gate.
- **What went wrong in the trial was the driver, not the tool.** Two false findings came
  from an off-screen click and from a proxy that dropped WebSocket upgrades. Neither
  model's replay script survived a replay.

A gitback session added `e2e` on 2026-10-29 anyway (`a81cf9ba`). That is two drivers in
one repo. This is not a ban on `e2e`. Pick one, because two drivers means two sets of
selectors to keep in step.

### pstack as a whole (0.15.42)

The 10-14 page (`afk-claude-archive/docs/research/pstack-vs-afk-claude.html`, pstack
0.15.24) already covered poteto-mode, the verification skill, overnight mode and tickets.
Its conclusion still holds: *"pstack checks what the user sees. afk-claude makes the
runner check."* Every pstack gate is a prompt rule; the runner's gates are code. What to
pick is pstack's **content** of a check, enforced by the runner.

pstack skills that matter for lint, tests and verification:

| Skill | What it does | Pick? |
|---|---|---|
| `correct` | Find mistake classes in commits, reverts and review comments; a class counts once it has happened twice. Fix each class at the highest level that works: architecture, then types, then a lint or CI check, then a behavior test, and agent rules last. Keep a table in AGENTS.md pairing each rule with what enforces it. A correction that matches an unenforced rule is a repeat, and it must go up a level. If a pattern is already common, fail only when a change adds more | **Yes, the core of the loop.** It is the missing ladder above `rule`/`standard`/`none`. Put it into `coduo-implement` rule 10 (drafted) and the fixer's Step 2b |
| `principle-encode-lessons-in-structure` | A repeated instruction becomes a lint, flag, runtime check or script. "The instruction is the symptom" | Yes, as one line inside the ladder. Too short to stand alone |
| `principle-test-behavior-not-implementation` | A test must fail when the behavior breaks and survive a change to the internals | **Yes.** It answers 37 `none` lessons that lean on a test: the test must pass both edits. Drafted into `coduo-implement` check 7 |
| `create-verification-skill` | Generate `verify-<app>`: launch, doctor, drive, evidence, cleanup, a feature map. Prove it with one run | Yes; `verify-gitback` already follows it |
| `maintain-verification-skill` | Upkeep: one read-only sub-agent per feature file checks the map against source, then one live pass drives every feature. Outcome: clean, changed (one PR) or blocked | Later, once one `verify-<app>` is merged. It is what keeps a feature map from rotting |
| `create-formal-verification-skill` + `maintain-…` | Pick the riskiest promise in the code, check it with a model checker (TLA+ by default) or a prover, show it fails on a broken variant, record the sync commit | Not now. One candidate: the runner's own serial integration and its state file, where the bugs are about step order. Ask before building it |
| `reflect` | Three reviewers plus a synthesizer over a transcript; step 4 moves any item a lint or script could enforce to a backlog of structural fixes | The reflection-processing session's area. Its step 4 is the part to copy |
| `principle-build-the-lever` | Build the script or codemod that does or proves the work, so a reviewer can rerun it | Already how the runner works |
| `principle-fix-root-causes` | "Check for the pattern, not just the instance. Find every place with the same fault and fix them all" | Already in the verifier's Reach axis |
| `tdd`, `interrogate`, `statechart`, `benchmark-checklist` | Test-first loop; adversarial review; TLA+ result reader; benchmark hygiene | No new value over local skills (`tdd`, `code-review`) |

### What each skill is worth here

| Skill | Status | Use in AFK | Recommendation |
|---|---|---|---|
| `principle-encode-lessons-in-structure` | not installed | It is the loop's own rule | Install it. Read it in the fixer and in `coduo-implement` rule 10. Drop `standard` as a lesson class. A lesson the linter cannot see goes in as a regression test, or as a more prominent instruction with an example of the failure |
| `create-verification-skill` (pstack, generic) | not installed | Gives each product repo a `verify-<app>` skill: launch, doctor, drive, evidence, cleanup, and a feature map | Use this version, because it carries no new dependency. Drive with agent-browser for the web, `agent-device` for iOS and Atlas for macOS. That matches the 2026-10-14 decisions |
| `create-verification-skill` (e2e-inc) | already in gitback `.claude/skills/` (`a81cf9ba`, 10-29) | The same, but built on the `e2e` package | Do not spread it. It conflicts with the 10-14 ruling against `e2e` (memory `explore-driver-agent-browser`). Gitback adopted it anyway on 10-29, so that ruling needs one line from Sahil: keep `e2e` or remove it |
| `principle-prove-it-works` | on disk since 2026-08-26 (`.skill-lock.json`: source `cursor/plugins`) | Already covered by `coduo-implement` ("verification demonstrated, not described") and the fixer's fail-first rule | Wire nothing. Leave it as is |
| `show-me-your-work` | on disk since 2026-08-26 (`.skill-lock.json`: source `cursor/plugins`) | A decision log in TSV, an audit of the log against the transcript, and a review of the log by a model from another family | Use it only for the hand fix pass at closeout (break 2). Each hand commit gets a row with its evidence and its lesson. This replaces plan item 5. Skip the cross-model review for now: its subagent rules depend on `poteto-mode`, which is not installed here |
| `typescript-best-practices` | on disk since 2026-08-26 (`.skill-lock.json`: source `cursor/plugins`) | A table of TS rules | Most rows can be linted: no `as`, `unknown` over `any`, exhaustive `never`, no `console.log`. Under encode-lessons they belong in typescript-eslint config set up by `setup-coduo-toolchain`, not in a skill a lane reads. Add the skill to the implementer only in TS repos (`plugin-roles.yaml`), for the rows no linter sees |

### Revised plan, smallest first

Items 1 to 4 from the first plan stand. Item 4 now also covers the misdetection: the
validate lint and the fixer must use one detector, so they cannot disagree.

5. **Replaced:** the hand fix pass keeps a `show-me-your-work` log. Each hand commit gets
   a row: decision, evidence (the SHA) and lesson.
6. **New:** retire the `standard` lesson class. Its place goes to `test`, from item 3, and
   to a bolder instruction with an example of the failure. Source:
   `principle-encode-lessons-in-structure`.
7. **New, outside this repo:** land `verify-gitback` (gitback PR #613), or close it. Then
   generate `verify-<app>` for one more repo with the pstack `create-verification-skill`,
   and offer it to the verifier role.

### Steps for Sahil

1. Decide whether `e2e` stays in gitback (`a81cf9ba`). If not, the pstack version replaces
   it.
2. Decide what happens to gitback PR #613 (`verify-gitback`): merge it or close it.
3. Approve the plan items to build. I suggest items 1, 2 and 4 first, all inside this
   repo, then 3 and 6 together.

## Update: Sahil's replies, round 2 (2026-11-15)

### Correction: pstack is already bound to runner roles

`plugin-roles.yaml` has had a `pstack:` entry since `ff118bd` (2026-08-26). It offers
`typescript-best-practices` and `principle-make-operations-idempotent` to the implementer,
and `blast-radius`, `principle-prove-it-works` and `show-me-your-work` to the verifier. All of
them are `offer`, not `always`, and only reach a lane when its repo enables the pstack plugin.
The earlier line "no runner role uses them" was wrong.

### Goal: a `verify-<app>` for every product

Sahil liked `verify-gitback` because it stress-tests the user's happy paths. Gitback was
paused, so it stopped there. He wants the same for every project: a feature map of the flows,
journeys with IDs, a doctor, coverage, and explore mode.

**The one CLI that drives the real app is now a priority.** The talk (Lauren Tan, "All Code Is
Slop") has the same core: one reusable CLI per app (`app aria-click --accessible-name
"Settings"`, `app snapshot`, `app screenshot proof.png`) that every agent and skill reuses.
It saves tokens, the CLI itself can be tested, and a lane ends with proof instead of a claim.

### Drivers across platforms: pick the contract, not one framework

Sahil builds web apps, Mac apps, React Native apps and Tauri apps. No single framework covers
all of them today:

| Platform | `e2e` (e2e-inc, checked 2026-11-15) | Other driver |
|---|---|---|
| Web | Yes, through Playwright | agent-browser |
| iOS and Android, React Native, Expo | Yes, through `agent-device` (bumped to 0.21.37 on 11-13) | `agent-device` directly |
| macOS desktop | No. Issue #986 "Support for macOS Desktop applications" is open; the Cua desktop engine PR #180 was closed | Atlas (hidden helper login), or Vercel's `agent-desktop` |
| Tauri desktop | No | Same as macOS; a Tauri webview may also be reachable over WebDriver |

`e2e` changed a lot since 10-14: replay of agent steps with no model calls until the app
changes, `explore --changed-since` for a PR's diff (11-12), an MCP server in its Claude plugin,
Claude Code as the agent over ACP, and many hosted device providers. It is a good fit for web
and mobile and has nothing for desktop.

`agent-desktop` (vercel-labs, 24k stars, created 2026-02) reads the OS accessibility tree on
macOS, Windows and Linux and returns JSON with refs, like agent-browser does for the web. It
acts through the accessibility API "without moving the pointer or taking focus". It still runs
in Sahil's own login, so Atlas stays the default on his machine. Whether `agent-desktop` can
run inside the Atlas helper is the thing to test.

**Recommendation:** fix the shape of `verify-<app>` once (launch, doctor, feature map with
journey IDs, drive, evidence, coverage, explore, cleanup) and let each repo plug in the driver
for its platform. Web uses agent-browser or `e2e` web, mobile uses `agent-device` (directly or
through `e2e` mobile), and desktop uses Atlas. Do not choose between `e2e` and agent-browser
until a second product has a `verify-<app>`.

### `coduo-implement`: outdated and bloated

Sahil read the current and proposed copies and called the skill very outdated and bloated,
so the proposed revision is not enough. The line "a nine-day feature passed every gate and shipped unusable" refers to
`~/code/projects/github-projects/docs/architecture/agents-replacement/10-postmortem.md`
(2026-09-03). In nine days, six AFK epics built gitsu's Agents panel. Every lane, gate and
closeout passed, and the feature was still bad, because the tickets never asked for content
fidelity, streaming feel, resource bounds or turn cancellation. The skill calls the repo
"atlas", but the repo is `github-projects`, and the name no longer helps a lane.

Fable reviews of every skill the runner uses are in `skill-reviews/`.

### No comments, using pstack `no-comments`

`pstack/skills/no-comments` spawns a `comment-sicko` agent (`pstack/agents/comment-sicko.md`).
The agent deletes every comment except five kinds: license headers, a vendor or platform
behavior we cannot change, `prettier-ignore`, public API docs, and issue or RFC links. A
surprise in our own code is flagged `MUST KILL`, and the fix is a rename or a new type, not a
comment. A constraint comment ("do not remove") becomes a type, test or lint rule when someone
approves it.

To use it here, port two files into coduo-agents' pstack plugin, `no-comments` and
`comment-sicko`, and drop their links to `poteto-mode`, `/architect` and `/why`, which are not
installed. Then run it once per epic diff at closeout, with encodings pre-approved (unattended
mode needs that). Do the first run by hand on one repo before wiring it in.

## Method

- PR bodies and comments came from `gh` for every epic PR since 2026-09-28. Lesson lines
  were matched on `Lesson: (rule|standard|none|missing)` and de-duplicated per PR.
- Rule origins come from `git log -S<rule-id>` on each repo's `origin/main`.
- Gate wiring comes from each repo's `.afk-setup/config.yaml` on `origin/main`.
- Not checked: gitsu's gate wiring for ast-grep. Gitsu epics opened before 09-28. Repos
  outside `~/code/projects`.
