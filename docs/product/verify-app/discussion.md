# Verify every app: feature map, outcome tests, CLI-first apps

## Where this stands

**Status:** exploring
**Last session:** 2026-11-15

Gitback's `verify-gitback` (PR #613) was reviewed and replayed on today's
`staging`: its lessons are good, but as a system it failed. It never merged,
nothing ran it, and a UI redesign broke 4 of its 5 journeys without anyone
noticing. The direction now is no separate verify skill. Each product gets
outcome tests that call its real actions against fakes, one thin UI smoke test
per feature in the suite the app already has, and a one-table feature map, with
the runner's verifier running those plus a teeth test. Sahil raised a related
idea: build every app CLI-first, so the CLI and the UI share one core and the
CLI's commands become the outcome tests (and later the MCP or API). Next move:
answer the open questions on the CLI-first idea, then pick a pilot.

## The idea

Every product gets a way for an agent to prove a feature works, not claim it.
The proof comes from the cheapest layer that can give it (talk: Lauren Tan,
"All Code Is Slop (Except Mine)", https://youtu.be/O_zcc6Xl12g; summary in the
side-session notes `video-O_zcc6Xl12g/summary.md`).

Sahil's CLI-first app idea (2026-11-15): when starting a new app, build two
things in parallel. One is a CLI-only app that does everything the product does
(`gitback claim <repo>`, check claimed, check paid). The other is the frontend
prototype on mock data. The two merge into one app later, and the feature map
plus verification make that merge smooth. The CLI also makes an MCP server or
an API layer easy later.

## Why

Lanes end with claims, not proof. Human review of diffs does not scale. The
talk's answer is runtime verification on a feature map. Sahil liked
`verify-gitback` because it stress-tested the happy paths, and wants the same
for every product (web, Mac, React Native, Tauri).

## Decisions made

- **No separate `verify-<app>` skill folder.** Journeys go in the product's
  existing test suites. Because: `verify-gitback` was a second test setup next
  to `e2e/`, so the FAQ editor redesign (PR #627) broke it silently while `e2e/`
  kept passing.
- **Outcome tests carry most of the proof.** Call the app's real action (Server
  Action, Rust command, Swift core, RN store) against fakes and assert the
  external state. Because: the teeth test showed that only the emulator-state
  check (FAQ-03) caught a save that moved `main`; every screen check stayed
  green. Staging already does this in
  `src/features/footprint/no-default-commit.emulator.test.ts`.
- **One thin UI smoke test per feature.** It proves only that a user can reach
  the feature and that errors show. Because: a backend check misses wiring
  bugs and error display (#604).
- **Feature map = one table per repo.** Columns: ID | feature | how users reach
  it | outcome test | UI test. No five-section prose file per feature. Because:
  about half of each journey's ~145 lines was prose that grows with every test
  and rots.
- **Keep the teeth test and the repro rule.** Break one line and confirm the
  test goes red; an explore finding counts only when a repro test fails.
  Because: these were the parts that proved real.
- **The CLI and the UI call the same core.** Sahil confirmed 2026-11-15
  ("yes exactly"). Because: a CLI with its own copy of the logic proves nothing
  about the app. The word for the shared logic is **the core**. This rule
  belongs in the skill used for every new feature and in
  `coduo-product-prototype` (which skill, still open).
- **Who writes the checks:** the lane that adds or changes a feature writes
  its CLI command, outcome test, UI smoke test and map row in the same PR. The
  verifier runs them and breaks one line (teeth test). Closeout turns a lesson
  into a new or tighter row. A new area from scratch starts with the CLI
  command and the map row in the first ticket, before the screens.
- **Lanes may edit the tests in the same PR as the UI change.** Because:
  locking the journeys under `.claude/` guaranteed they went stale; the teeth
  test guards against a lane weakening one.

## Rejected, and why

- **Merging PR #613 as it is.** It is 172 commits behind and fails today.
- **Bombadil now.** It checks what the screen shows (the `main`-moved bug never
  shows there), it covers web and terminal only, and it is at v0.7. The bad
  inputs it might find (#604, #605) are cheaper as a table of inputs against
  the save action. Revisit for one complicated web screen once it stops
  changing.
- **A per-app UI-driver CLI first** (the talk's `app aria-click …`). Fable said
  no CLI at all. Claude's view: a shared driver per platform (Atlas, agent-device)
  still saves lane tokens for proof screenshots, so add it after the outcome
  tests exist.

## Open questions

- **Blocking:** in the CLI-first idea, do the CLI and the UI call the same
  core functions, or is the CLI a separate build of the logic? Only a shared
  core makes the CLI proof of the app.
- Does the CLI run against fakes by default (emulators, mock store) or against
  real services?
- Is the CLI shipped to users, or internal only (agents, tests, later MCP)?
- Which repo pilots it: mac-directory (busy, Mac, tests Atlas) or gitback
  (half the work exists, but paused)?
- Does any CI run the tests? Gitback's only workflow is the Cloudflare deploy.

## Risks / unknowns

- The CLI and the UI drift into two implementations — a shared core with both
  as thin shells is what would tell us it is fine.
- Outcome tests against fakes pass while the real service differs (the gitback
  emulator never moves a PR's head on push) — the "stand-in hides" note per row.

## Next steps

- [ ] Answer the open questions on the CLI-first idea — this discussion
- [ ] Close gitback PR #613 and move its one unique check (UI save, then the
      fake GitHub's `main` is unchanged) into `e2e/edit.spec.ts` — /coduo-implement
- [ ] Add a feature map table to the pilot repo — /coduo-implement
- [ ] Point verifier Step 1d (`prompts/verifier.md:47-52`) at the feature map
      and the repo's own suites instead of `.claude/skills/verify-*/features/`,
      keeping the teeth test — /coduo-implement

## Adversarial take — 2026-11-15

Fable (reader sub-agent, read the branch and staging, ran nothing):

> Your review is mostly right, but the size criticism is aimed at the wrong
> thing, and staging already contains the shape Sahil is asking for. Do not
> build a per-app CLI or a new skill; build one small pattern inside the test
> suites the products already have.
>
> Bombadil: never used. Wrong bug class (the valuable bug is a backend fact),
> the cheap equivalent exists (a table of bad inputs against the save action),
> web and terminal only, v0.7.
>
> Size: the amortisation is hypothetical; it never reached journey 6, so the
> fixed 1,000 lines were paid for 5 tests. Explore mode's 425 lines bought two
> minor bugs, with 4 of 5 replay scripts rejected. The real cost is a second
> harness beside `e2e/`; that is why it drifted. In `e2e/` each journey costs
> about 40 lines and the redesign PR would have fixed it.
>
> Headless CLI: catches wrong writes, branch, PR, row; immune to UI drift.
> Misses #604, wiring bugs, reachability. Staging already has
> `no-default-commit.emulator.test.ts` (154 lines), FAQ-03's teeth generalised,
> with no browser. The test runner already is the entry point; a bespoke CLI per
> app is new surface for zero users. Shape: Layer A outcome tests at the action
> layer, Layer B one thin UI smoke test per feature, one feature-map table.
> `verify-<app>` becomes a ~20-line docs section, not a skill folder.
>
> Disagree: line count is the symptom, the parallel harness is the cause; the
> second-way lesson does not need a browser; keeping it under `.claude/`
> guaranteed the drift. Single recommendation: no CLI, no skill, no Bombadil.

**Reaction:** Claude checked the key claim: the emulator test exists (154
lines) and runs in `pnpm test`, but no CI job runs it. Accepted the shape.
Claude kept one disagreement: a shared UI driver per platform is still worth
adding later for proof screenshots. Sahil then raised the CLI-first app idea,
which is a different kind of CLI from the one Fable rejected (see Session log).

## Session log

### 2026-11-15

- Replayed PR #613 on `origin/staging` (`aab83966`) in a throwaway worktree:
  DOCTOR-01 passed; LIVE-01, LIVE-02, FAQ-01–03, DASH-01–02 failed waiting for
  `button "Save"` (removed in PR #627). Warm-up 233 s, run 10.7 min, cleanup
  left all ports free.
- What worked: the second-way proof (emulator state), the teeth test, explore
  mode finding #604 and #605, "Stand-ins and what they hide", journey IDs plus
  the coverage count, and cleanup.
- What failed: it never merged; verifier Step 1d has never fired in any repo
  (no repo has `.claude/skills/verify-*/features/`); the UI changed under it;
  it duplicated `e2e/`; 8 of 16 IDs were blocked; it was slow; it was ~1,770
  lines for 5 tests.
- Size split: setup files 597 lines and explore mode 425 (both shared), plus
  per-feature 751 lines for 5 tests (spec ~70 + write-up ~75 each). The shared
  part spreads out over more tests; the per-test prose grows linearly.
- Two kinds of CLI were being mixed: the talk's CLI drives the real UI
  ([10:37], `app aria-click`) to save agent tokens; Sahil's is a no-UI app
  CLI over the real logic (`gitback claim <repo>`). The second is close to
  Fable's outcome-test layer with a command line on top.
- "DuoCam agent" = the futari session "Preview lag on second device" (futari,
  a two-iPhone camera). Futari's core: pairing, the live link, shot saving,
  the Futari album; its CLI would run those on a Mac with no camera UI.
- `e2e` (e2e.tester.army) was not used by verify-gitback, which was plain
  Playwright plus agent-browser for explore. `e2e` adds natural-language agent
  steps (`agent.act`, `agent.assert`) that replay with no model calls, on web
  (Playwright) and mobile (agent-device); no desktop. Either can run the thin
  UI smoke test.

## In your words

> **2026-11-15** — We did something similar with Gitback. It already has an
> existing verify Gitback. Get the learnings from there and tell me what all
> things worked and did not in that particular repo and PR. Do an adversarial
> review about the whole exercise in that PR.

> **2026-11-15** — So by CLI and backend, what I always mean is non-UI
> Rendering tests so that they run fast without showing any UI at all. This
> means they are kind of parallel to what I have as a product prototype which
> runs on a mock. So for example, Even when I am thinking of a new app or a new
> concept, I create 2 parallel apps at the same time. One is CLI only, which
> let's say in terms of Gitback, it creates a CLI called Gitback, and it does
> everything the app is supposed to do with the front end, but it does
> everything through a CLI. So it would say Gitback claim repo name, then it
> would check if the board is claimed or not, is it paid or not, and everything
> Around it. This is then moved on and added to the existing CLI, and at the
> same time, the front end is created. with a product prototype with all the
> mock data and everything. And eventually this CLI and the frontend is merged
> into one. And since we have all the feature maps and verification written
> down, the CLI and frontend kind of merges smoothly into one another. Having a
> CLI like this can also help me create MCPs in the future smoothly and/or any
> API layer.
