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

## Entry points, CLI logic, pure-screen features — 2026-11-15

- **Several ways to reach one feature.** The map row lists every way in
  (`Editor → Save; ⌘S`). One outcome test per feature, because every way in
  calls the same core function; one short UI test per way in. Removing a way in
  turns its UI test red, and the lane that removed it deletes the test and the
  map entry in the same PR. The coverage check fails on an ID with no test and
  on a test with no ID.
- **Logic that creeps into a CLI:** input checks, defaults, chained steps
  (`claim` that also pays), retries, picking a backend from an env var. Kept
  out by: one command calls one public core function; checks and defaults live
  in the core; the CLI folder imports only the core's public API (lint rule).
- **Pure-screen features** change only what is on screen: open the Settings
  modal, switch tabs, collapse the sidebar, sort a loaded list. UI test only.
  A theme saved to the account is core.
- **Tests call the core directly.** The CLI is optional, for people and agents
  driving the core by hand: try the product before screens exist, reproduce a
  bug, set up a state before a UI check, show proof in a lane log, become MCP
  tools later.

## What will fail — adversarial pass, 2026-11-15

1. **Nobody runs it.** The only reason verify-gitback died. Gitback's CI does
   not run tests today. Every repo needs the outcome tests and UI tests in a
   gate that blocks a merge, or the rest of this is decoration.
2. **The core does not exist yet in most apps.** Logic sits in Server Actions,
   SwiftUI views, React Native screens. Pulling it out is a refactor per
   product, and doing it everywhere at once is the over-engineering trap. Do it
   per feature, when a lane touches that feature.
3. **The CLI and the prototype mock drift apart.** The prototype runs on an
   in-memory store; the CLI runs on the core. If the mock store and the core
   do not share one interface, the "merge" at the end is a rewrite. The
   prototype skill's seam (the store) must be the core's interface, typed once.
4. **Fakes lie.** Outcome tests run against a GitHub emulator, a mock database,
   a fake payment provider. A pass proves the core against the fake. One
   smoke run against the real service per release is still needed.
5. **Platform UI is the expensive part, and it is where the bugs users see
   live.** Camera, permissions, notifications, drag and drop, windows. No core
   test reaches them. On DuoCam most of the risk is there.
6. **The map becomes paperwork.** If the coverage check is not a hard gate,
   rows rot like verify-gitback's 75-line feature files. Keep rows one line.
7. **Lanes weaken tests to go green.** Letting lanes edit tests (the fix for
   staleness) opens this. The verifier's teeth test is the guard; it has
   never fired yet, so prove it on the pilot before trusting it.
8. **UI tests on Mac and Tauri have no shared runner.** e2e has no desktop
   support; Atlas drives one helper login. Parallel lanes will queue on it.

## Does it work on every platform

| Platform | Core | Outcome tests | CLI | UI smoke test | Weak spot |
|---|---|---|---|---|---|
| Web (Next.js) | `src/core/` TS module; Server Actions call it | vitest against emulators | `tsx bin/app.ts` (node) | Playwright or e2e | Server Actions mix auth and logic; split them |
| Tauri | Rust crate; `#[tauri::command]` calls it | `cargo test` | Rust binary on the same crate (best fit of all) | Atlas (no WebDriver on macOS) | Desktop UI runner is Atlas only |
| SwiftUI (Mac/iOS) | Swift package, no SwiftUI import | `swift test` / XCTest | `swift run app-cli` (ArgumentParser), Mac only | XCUITest; Atlas for Mac proof | Camera, permissions, windows stay UI-only |
| React Native / Expo | TS package outside `app/` | jest | `tsx` node CLI if the core avoids native modules | Maestro or e2e; agent-device | Core that imports a native module cannot run in node; keep those behind an interface |

It works on all four if one rule holds: the core never imports the UI
framework or a native-only module. Where it must (camera, file pickers),
that piece sits behind an interface the tests fake.

## Flows

**A. New product from scratch (with `coduo-product-prototype`)**

1. Write the feature map first: ID, feature, ways in, proof. One line each.
2. Define the core interface (the store/seam) from the map. Types only.
3. Two tracks in parallel:
   - Core track: implement the core against fakes, an outcome test per map
     row that changes data, a thin CLI over it.
   - Prototype track: `coduo-product-prototype` builds the screens on an
     in-memory store that implements the same interface.
4. Freeze the prototype (owner approval).
5. Wire: swap the in-memory store for the core. Add one UI test per way in.
6. Gate: outcome tests + UI tests + coverage check block every merge.

**B. New feature on an existing product (with the prototype skill)**

1. Add the map rows first (new IDs).
2. If the feature changes data: core function + outcome test + CLI command.
3. Prototype the screens on the in-memory store; freeze.
4. Wire; add a UI test per way in; the ticket names the IDs.
5. In AFK the lane runs the named IDs and attaches the output; the verifier
   runs the teeth test.

**C. New feature without the prototype**

1. Add the map rows.
2. Core function + outcome test (+ CLI command) first, test failing first.
3. Build the screen directly on the core.
4. One UI test per way in. Same gate.
A pure-screen feature skips step 2.

**Edit or remove a feature:** the lane changes the test and the map row in
the same PR; the coverage check catches orphans.

## Feature folders, mocks, platform order — 2026-11-15

- **Folder rule (from the talk, widened).** The talk shows two top-level
  folders, `electron-renderer` and `electron-main`, with imports between them
  banned, types included, by a dependency-graph check and lint [06:10]
  [06:30]. It does not show per-feature folders. Our version: one folder per
  feature or area; a feature imports only its own files, the core's public API
  and a small `shared/`; never another feature's internals. Enforced by a lint
  or dependency rule (dependency-cruiser / eslint-plugin-boundaries for TS, Swift
  package targets for SwiftUI, crates for Rust), not by prose.
- **CI:** gitback has no test CI because GitHub Actions minutes ran out. The
  gate can run in the AFK lane on this machine instead; that is enough.
- **Next.js / Astro extraction does not break server rendering.** Server
  Actions and server components keep calling functions; the function just
  lives in `core/`. What must stay outside the core: `cookies()`, `headers()`,
  `redirect()`, `revalidatePath()` and auth reads. The action becomes a thin
  wrapper: read the session, call the core, revalidate. One risk: a client
  component importing the core would bundle server code; ban that with the
  folder rule, not with `server-only` (that package throws in plain node, so the
  CLI and vitest would break).
- **When to fake and when not** (Google, *Software Engineering at Google*
  ch. 13; Fowler, "Mocks Aren't Stubs"; Freeman and Pryce, "don't mock what you
  don't own"):
  1. Use the real thing when it is fast and deterministic: your own code, the
     database (a local Postgres or SQLite, Testcontainers).
  2. Use a fake when the real thing is slow, paid, rate-limited or external
     (GitHub, Stripe, Apple): a working stand-in, ideally the provider's own
     (GitHub emulator, Stripe test mode), with a contract test that runs the
     same checks against the real service so the fake cannot drift.
  3. Use mocks (checking "was X called") rarely; they test how the code is
     written, not what it does, and break on refactors.
  4. Run the full happy path once against real services (test accounts) before
     merge to the shipping branch. Fast fakes for every lane, real services for
     the final gate.
- **Platform UI is driven by agents, not by Sahil:** agent-device for iOS and
  React Native, Atlas for macOS, agent-browser for web. Camera is the hard
  case (simulators have no camera); it needs a device or an injected test feed.
- **Platform priority:** 1. SwiftUI (macOS, then iOS); 2. React Native;
  3. web (Next.js, Astro, React); Tauri only for Gitsu. The pilot should be a
  SwiftUI Mac app (see the pilot note below; mac-directory is a web app).

## Example layout, fakes rule, Mac driver, pilot — 2026-11-15

- **Next.js layout (example).** `src/app/` holds routes only.
  `src/features/<f>/core/` is plain TypeScript with no React or Next imports,
  and its `index.ts` is the public API. `src/features/<f>/ui/` holds the
  components. `src/features/<f>/actions.ts` is the thin `"use server"` wrapper.
  `src/adapters/` holds the real store and the in-memory store the prototype
  uses. `src/shared/ui/` holds design-system components (Button) that any `ui/` may import; `src/shared/lib/` holds plain helpers (formatDate) that the core may import too. The core never imports `shared/ui/`. `src/cli/` imports only `features/*/core`.
  The rules are enforced with eslint-plugin-boundaries or dependency-cruiser.
- **Gitback and fakes:** gitback runs on emulate (the GitHub emulator) plus
  MSW for Stripe, and has no test that runs the same checks against real
  GitHub. Under the fake rules, that is the missing piece: keep emulate for
  speed, and add one contract run against a real test repo and Stripe test
  mode before merge to the shipping branch.
- **agent-desktop (vercel-labs):** an accessibility-tree CLI for macOS,
  Windows and Linux. It snapshots an app as JSON with refs, then clicks or
  types by ref. It is headless by default (no pointer, no focus) and ships an
  MCP server. It is the Mac version of agent-browser. On Sahil's own login,
  the apps still open on his screen, so run it inside the Atlas helper login.
  Atlas gives isolation; agent-desktop gives the driver. Not tested yet.
- **Decision:** Mac UI tests run agent-desktop inside the Atlas helper login (Sahil, 2026-11-15). Not tested yet.
- **Correction:** mac-directory is a Next.js web app, not a Mac app.
- **Pilot candidates:** shareling already has the pattern: `SharelingKit`
  (core), `SharelingCLI` (the `shareling` command and an MCP server on the same
  core), and `SharelingCLITests`. One leak: `SharelingKit/Motion.swift` and
  `Metal/SilverMetal.swift` import SwiftUI/AppKit. stage-manager has
  `StageManagerKit` and tests but no CLI. Recommended pilot: shareling.

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
- Gitback's `e2e/` on staging: 462 `getByRole` calls, 0 `agent.act` or
  `agent.assert`, and many "re-record baselines" commits. Lanes wrote exact
  selectors even with plain-language steps available, and screenshot
  baselines cost steady upkeep.
- Adversarial pass on the whole plan: it stays alive only if (1) every check
  runs on every PR, (2) the CLI is a thin shell over the core, not a second
  app, and (3) a CLI command exists only for features that change core state;
  pure-UI features (open the Settings modal) get only the smoke test. The real
  gain is forcing logic out of the screens into a testable core; the map
  table is the part most likely to rot unless a coverage check enforces it.
- pstack on staleness (cursor/plugins, read 2026-11-15): `maintain-verification-skill`
  opens with "a feature map rots the moment the app changes" and answers with
  a periodic audit pass (one reader per feature, one live pass, one PR of
  fixes). `create-verification-skill` says a proof that drives one entry point
  is incomplete when the map lists others. The formal pair records the files
  each check covers plus a sync commit, and warns that a pass on a stale model
  is the dangerous case. Our plan differs: tests live in the product suite and
  run on every PR, so drift shows as a red test instead of waiting for an
  audit. Borrow the covered-files idea for the map.
- Tests call the core directly; the CLI is for people and agents to drive the
  core by hand (explore, reproduce, set up a state, show proof, later MCP).
  CLI rule: one command calls one public core function, parses arguments and
  prints the result; validation and defaults live in the core; the CLI folder
  may import only the core's public API (a lint rule can enforce it).

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
