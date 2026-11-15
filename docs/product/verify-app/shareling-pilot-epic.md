# Draft epic: Shareling feature map and proven journeys

Draft for review before `gh issue create` in sahildave/shareling. Not filed yet.

## Problem Statement

Shareling has strong tests (SharelingKit fakes with CloudKit parity tests,
`docs/testing/stand-ins.md`, `swift test` in every lane), but nothing says
which user journeys they prove. A lane or a reviewer cannot ask "is sending a
link proven?" and get an answer, a journey with no test is invisible, and a
test can quietly stop covering the journey it was written for. The core
(`SharelingKit`) also imports SwiftUI and AppKit in two files, so the rule
"the core runs with no UI" is not true yet.

## Solution

One feature map, `docs/feature-map.md`: one row per user journey, with an ID,
how a user reaches it, and the test IDs that prove it. Tests carry the IDs in
their names. A lane check fails when a map ID has no test or a test names an
ID the map lacks. `SharelingKit` stops importing UI frameworks, enforced by a
rule. One Mac journey gets a UI smoke run with agent-desktop inside the Atlas
helper login, as the first proof that an agent can drive the real app.

## User Stories

1. As Sahil, I open `docs/feature-map.md` and see every main Shareling journey
   (first run, sign in, save, send, receive, invite, search, library, notch
   drop, buy Pro, MCP send), how a user reaches it, and which tests prove it.
2. As Sahil, when a lane adds a journey or a test and forgets the other half,
   the lane gate fails and says which ID is missing.
3. As Sahil, every journey on the map that changes data has an outcome test
   that runs against `SharelingKit` with no UI, so I trust the core without
   opening the app.
4. As Sahil, `SharelingKit` builds and tests with no SwiftUI or AppKit import,
   and a lane that adds one fails its gate.
5. As Sahil, I run one command and an agent drives the real Mac app through
   one journey inside the Atlas helper, leaving a screenshot and a log, without
   touching my desktop.

## Implementation Decisions

- **Map format:** a markdown table in `docs/feature-map.md`, columns
  `ID | Journey | How users reach it | Proof`. IDs are `AREA-NN` (SEND-01).
  Journeys come from the flow map's user cards (`docs/flow/launch/43-*` to
  `58-*`); the map does not replace the flow map.
- **Tests carry IDs in their names:** Swift Testing `@Test("SEND-01 …")` or
  XCTest `test_SEND_01_…`. Tag existing tests before writing new ones.
- **Coverage check:** a script in `scripts/`, added to `defaultChecks`.
  It prints `covered N/M` and exits 1 on an ID with no test or a test with an
  unknown ID. Pure-screen journeys list a UI test (AppTests snapshot) as proof.
- **Core boundary:** `Motion.swift` and `Metal/SilverMetal.swift` leave
  `SharelingKit` for the app target (or a separate UI package). An ast-grep
  rule with fixtures in the lessons home refuses `import SwiftUI|AppKit|UIKit`
  under `Sources/SharelingKit`.
- **UI smoke run:** `scripts/verify/ui-smoke.sh <ID>` builds the Debug app,
  opens it in the Atlas helper, drives one journey with agent-desktop, and
  saves the screenshot and log under `docs/evidence/`. Run by hand or at
  closeout, not in the lane gate (one helper login, lanes would queue).
- **No CLI work in this epic.** The `shareling` CLI and MCP server already
  call `SharelingKit`; tests call the core directly.
- One-way doors: none.

## Testing Decisions

- A good test here asserts the state the journey leaves in `FakeWorld` /
  the store, not that a call was made (coduo-implement item 5).
- Prior art: `FlagshipScenarioTests`, `CloudKitParityTests`,
  `FixtureStatesTests`.
- Each new test shows red first (revert or plant a bug), per coduo-implement.
- External services with no faithful local stand-in (CloudKit, Stripe,
  Sparkle) keep their existing real-service probe: the #524 human gate and the
  018 live protocol. This epic adds none.

## Outcome

- Number: journeys on the map with a passing test, over all journeys.
- Read today: nowhere. The coverage check is the first read (`covered N/M`).
- Checked at closeout. Must not get worse: the lane gate stays near its ~65 s.

## Out of Scope

- Runner changes (verifier reading the map, tickets naming IDs): the
  coduo-afk runner epic, after this pilot.
- iOS UI smoke runs, the web app, the Chrome extension.
- Any new CLI command or MCP tool.

## Further Notes

- Source of the design: coduo-afk `docs/product/verify-app/discussion.md`.
- Pilot done when: the map lists the main journeys, the coverage check gates
  lanes, `SharelingKit` has no UI import, and one agent-desktop run in Atlas
  has left a screenshot and log.
