# Headless core

**Headless core** is the house name (Indhuja, 2026-11-27) for one pattern that grew up under
several names: `verify-gitback`, verify-app, "CLI-first app", "core, CLI and feature map".
Use this name in tickets, prompts and `AGENTS.md` files. The design record is
[`product/verify-app/discussion.md`](product/verify-app/discussion.md).

## What it is

An app has a headless core when an agent can prove a user journey works without opening the
frontend. It has three parts.

| Part | What it is | What keeps it honest |
|---|---|---|
| Core | All product logic in a package or folder that imports no UI framework | A build boundary (a separate package), plus a lint rule on imports |
| Driver | A CLI, or a test harness, that runs a journey against the core and prints the resulting state | The gate fails an app that has none |
| Feature map | One table, `docs/feature-map.md`: one row per user journey, with an ID and a proof | A coverage check in every gate |

A proof is one of `test:` (runs against the core), `snapshot:` (a recorded screen) or
`device:` (a check on real hardware, for what cannot run headless: cameras, radios, haptics).

The UI is a thin shell over the core. The CLI is a second thin shell over the same core, so
the two cannot drift into two implementations.

## The rule: the core stays in sync on every change

A change to product behaviour is not done until all three parts agree.

1. The behaviour changes in the core first. The UI calls the core; it holds no rule of its own.
2. The journey's row in the feature map is added or updated in the same commit, with a proof.
3. If the app has a CLI, a new journey gets a command, or an existing command reaches it.
4. A bug in a rule is reproduced against the core (CLI or test) before it is fixed.

This holds for interactive sessions and for AFK lanes alike.

## Where the rule is enforced today, and where it is not

| Place | State on 2026-11-27 |
|---|---|
| coduo-games `scripts/check` | Enforced. Fails a game whose `lib/core` imports Flutter or that has no `tool/game.dart`; `feature_map_test.dart` checks the map |
| health-app | Enforced. ESLint `no-restricted-imports` on `src/lib/**`; `src/__tests__/feature-map.test.ts` |
| shareling | Enforced for the core and the map: `kit-no-ui-import` ast-grep rule, `FeatureMapCoverageTests` |
| futari | Map enforced (`scripts/feature-coverage.sh`). Core is a folder, not a package, and the import rule does not catch what it misses (below) |
| `afk validate` | Not enforced. The `no_feature_map` check was written on a branch that never merged |
| Verifier prompt, Step 1d (`prompts/verifier.md`) | Out of date. It looks for a `.claude/skills/verify-*/features/` folder, the shape the verify-app discussion rejected, and skips when there is none |
| `coduo-implement` skill | Silent. Rules 11 to 14 ask for red-then-green and evidence; none names the core, the CLI or the feature map |
| `coduo-tickets`, `coduo-epic` | Silent. Tickets do not carry journey IDs |
| `setup-coduo-toolchain` | One line, for Flutter only |
| coduo-swiftui-factory | Generates a `<Name>Kit` package. Generates no CLI, no feature map and no import rule |

## What has to change for the rule to hold everywhere

In order. Each is its own change in its own repo.

1. **Verifier Step 1d** (this repo): read `docs/feature-map.md` and run the proofs of the rows
   whose code the diff touches, then the teeth test. Drop the `verify-*` skill lookup.
2. **`afk validate`** (this repo): warn `no_feature_map` when the repo has none.
3. **Ticket shape** (`coduo-tickets`): a ticket that changes behaviour names its journey IDs.
4. **`coduo-implement`**: add the rule above as one numbered rule, after "Show red, then green".
5. **`setup-coduo-toolchain`**: per platform, write the import rule and the coverage check.
6. **Factory**: recipes generate an empty feature map, its coverage test and the Kit import rule.

Items 4 and 5 ship from `coduo-agents-marketplace`; item 6 from `coduo-swiftui-factory`.

## History

| Date | Where | What appeared |
|---|---|---|
| 2026-09-02 | coduo-swiftui-factory `d9fdcf5` | Recipes generate a `<Name>Kit` package, "the package that holds testable product behavior" |
| 2026-09-14 | gitback `6d59838d` | Vendored `create-verification-skill`, whose generator already says "Seed the feature map" |
| 2026-09-28 | gitback `d9c37f06` | `assert-e2e-proof.mjs`: a pre-push gate that blocks a push with no e2e proof. The first enforcing gate |
| 2026-10-14 | gitback `9cddbb33`, `0b05099b` | `verify-gitback`: journey IDs, stand-ins, a coverage script. It never merged; a UI redesign later broke 4 of its 5 journeys unnoticed |
| 2026-11-04 | shareling `9170105b` | `SharelingCLI`: a CLI on the Kit. A shipped product surface (MCP, search, save), also used in tests |
| 2026-11-15 | coduo-afk `ddb4053` | The verify-app discussion: no separate verify skill; outcome tests on fakes, one thin UI test per feature, a one-table feature map, the teeth test. Sahil's "CLI-first app" idea |
| 2026-11-22 | health-app `7b8d0db` | "Core, CLI and feature map": `src/lib` with an import rule, the `healthy` CLI, a feature map with a coverage test |
| 2026-11-22 | futari `4202e6e` | `docs/feature-map.md`, a `Core/` folder and `scripts/feature-coverage.sh` |
| 2026-11-23 | shareling `4ecd3c9e` | Pilot epic #684: feature map, coverage test, SwiftUI split out of `SharelingKit` |
| 2026-11-25 | coduo-games `6bba11f`, `aa124cd` | Feature map, `scripts/check`, then `HeadlessGame` and `tool/game.dart`. The first gate that requires the core and the CLI: "Every game is tested without UI" |
| 2026-11-27 | this file | The name "headless core", and the sync rule |

What each step taught:

- **gitback:** a verification setup that lives beside the real test suite rots. Proofs belong
  in the suites the app already runs.
- **shareling:** a Kit is only UI-free if the build proves it. The SwiftUI half had to move to
  its own target.
- **coduo-games:** the pattern holds when the gate refuses an app without it, and when
  `device:` proofs reopen as the code they cover changes.

## Apps

| App | Core | Driver | Feature map |
|---|---|---|---|
| coduo-games | `<game>/lib/core`, gated | `tool/game.dart` (`run`, `next`, `solve`, `play`), gated | 22 rows, gated; `device:` rows tied to a hash of the covered code |
| health-app | `src/lib/**`, gated | `pnpm healthy` (`day`, `goal`, `check-in`, `meal log`) | 13 rows, gated |
| shareling | `SharelingKit`, gated | `shareling` CLI; `scripts/verify/ui-smoke.sh <ID>` | 17 rows, gated |
| futari | `Core/` folder, leaks (below) | none | 11 rows, gated one way |
| mico | `StageManagerKit`, UI-free today, no rule | none | none |
| walkie-talkie | `WalkieTalkieKit`, 1 of 17 files imports UI | none | none |
| mac-notes | `MacNotesKit`, 14 of 82 files import UI | none | none |
| sticky-notes | `StickiesKit`, 11 of 41 files import UI | none | none |
| gitback | none named | `e2e/` | none |

## Futari: why it can work, and what it takes

Futari is a two-phone camera app. The question was whether a camera app can have a headless
core at all. It can, for the state half. Checked on 2026-11-27 with an adversarial review.

**What can be headless.** Routing, pairing, consent, roles, hold and reconnect, ending a
session and the paywall gate. `FlowReducer` and the `PeerLink` state machine already run
without a screen, and ADR-0012 put a transport seam under `PeerLink` with an in-process
loopback wire. 35 of the map's 43 `test:` proofs are this kind of logic.

**What cannot.** Capture, the Photos album, preview encoding, purchase, the local-network
prompt and Bonjour over real radios. The two `device:` rows stay two-phone checks.

**What is in the way today.**

- `Core/` imports only Foundation, but it is in the app's module, so it uses app types with
  no import: `FutariStatusDial.SegmentState` (declared inside a SwiftUI view),
  `CameraEngineState` (holds a `UIImage`), `AppPermissionStatus`, `PhotoSaveResult`,
  `SessionRole`. The `core-no-ui-import` rule matches import lines only, so it passes.
- `PeerLink.swift` needs UIKit for a thumbnail and the device name, and calls PostHog
  analytics directly.
- No test runs at the lane gate. All 539 tests run under `xcodebuild` on a simulator, at
  integration and baseline only.
- `ControlMessage.swift`, `PeerLink.swift` and `project.yml` are one-way doors, so an AFK
  lane cannot make the move. A person must gate it.

**The smallest change that delivers it.** One human-gated move that changes no behaviour:

1. Create a local `FutariKit` package (Swift 5 mode, builds for iOS and macOS).
2. Lift about ten value types out of UI and media files, then move `Core/`, the `PeerLink`
   state machine with its transport and discovery seams, and `FlowDriver` into it.
3. Inject the device name, thumbnail decoding and analytics.
4. Move the tests that need no simulator under `swift test`; add `swift test` to
   `defaultChecks` and `baselineChecks`. Integration keeps `xcodebuild test`.
5. Point `scripts/feature-coverage.sh` at the new test path and make it check both ways: a
   row with no proof, and a test that names an unknown ID.
6. Last, add a thin CLI target to the package: two in-process peers on the loopback wire,
   with commands such as `pair`, `decline`, `roles see`, `drop` and `end`, printing each
   state. It holds no logic of its own. Give it a `run` command that walks every journey
   that is not a `device:` row, and put `run` in `defaultChecks`, as coduo-games does. A CLI
   that no gate runs rots.

The package boundary is what makes the sync rule mechanical: a UI type in the core stops
compiling.
