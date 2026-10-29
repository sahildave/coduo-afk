# Validate lints

`afk validate` (and `afk epic`, which validates first) runs four ticket lints from
`scripts/criteria-lints.mjs`. Each one is a rule that used to live only in prose.
All of them read text and config; none calls a model or the network.

The two line lints share the split `protectedPathsNamed` uses. A line inside the
ticket's `## Acceptance criteria` (or `**Done when**`) binds the lane, so it is an
**error**. The same line anywhere else in the body may only be context, so it is a
**warning**, one per lint per ticket. Every message quotes the line and names the fix.

## 1. `human_in_criteria`: a person asked for inside a lane

A lane runs with nobody there. A criterion that waits for a person either stalls
the lane or gets "answered" by the agent itself.

Applies only to tasks with no `gate:` in the `afk:` block. A gated task's approval
is what its gate is for, so a gated task is never checked.

Phrases, case-insensitive:

- `ask the owner`, `ask the owner`, `ask the human`, `ask the maintainer`
- `stop-and-ask`, `stop and ask`
- `sign-off`, `sign off`
- `human approval`, `owner's approval`, `manual approval`, `approved by`
- `confirm with`, `check with` or `wait for`, followed by `the owner`, `the owner`,
  `the human` or `the maintainer`
- `the owner decides`, `the owner approves`

Hits:

- harbour #492: "Its 30 baselines (aria + screenshot) re-record only where the
  fixture move changes nothing visible; any pixel change is a stop-and-ask to
  The owner, not a re-record."
- "Merge only with the owner's sign-off."
- "Ask the owner which price to use."

Does not hit: "the approval modal closes on Escape", "the dialog asks the user to
confirm deletion", a `Signed-off-by:` trailer, or #492's line in a `gate: before` task.

Fix: make the task `gate: before` or `gate: after`, or say what the lane does
instead ("any pixel change fails the lane and is reported").

## 2. `whole_suite_in_criteria`: a lane told to run the whole suite

The integrator runs the whole suite at every merge. A lane that runs it too spends
its budget on work that is done anyway, and fails on breakage it did not cause.

A line hits when it names any of:

- `check:all` or `test:all`
- a command in the config's `baselineChecks` that is not in `defaultChecks`,
  matched verbatim
- "the e2e suite passes", "the unit suite passes", "the test suite passes",
  "the browser suite passes", "the whole suite", "the full suite",
  "the entire suite", "all tests pass"

A line that also names a test file (`.spec.` or `.test.` in a path, or a path
under `e2e/`) is narrowed and does not hit.

Hits: atlas-workspace #930's "`npm run check:all` passes."; "the e2e suite
passes"; `npm run test:e2e` named in a criterion when it is in `baselineChecks`
and not in `defaultChecks`.

Does not hit: "`pnpm exec playwright test e2e/module-switches.spec.ts` passes";
"`node afk.mjs selftest` passes" when `selftest` is in both lists.

Fix: name the spec files this change adds or re-records.

## 3. `story_not_cited`: a user story no child carries

The epic's `## User Stories` section (heading case-insensitive) is read as a
numbered list. Each child cites the stories it carries in its own section:

```markdown
## User stories

Carries 1–4, 7 from epic #190.
```

Numbers and ranges, with a hyphen or an en dash. An issue reference is not a
story number: `#190`, or `epic`, `issue`, `task` or `PR` (singular or plural,
optionally followed by `#` or `:`) with the whole list or range after it on the
same line, as in `epics 190 and 191`, `PRs 198, 199`, `task 204–206` or
`issue: 12`. Any other number in the section is a story.

- When at least one child has the section, a story cited by no child is an error,
  `story_not_cited`, quoting the story's first 80 characters. A cited number the
  epic does not have is an error too, `story_not_in_epic`.
- When no child has the section, there is one warning, `stories_uncited`: coverage
  is left to the plan reviewer, so older epics keep validating.
- An epic with no user-stories section is not checked.

This is only the count. Whether a citing ticket really carries its story is still
the plan reviewer's call.

## 4. `one_way_door_ungated`: a path that cannot be taken back

A project lists its one-way doors in `.afk-setup/config.yaml`, under
`oneWayDoors:`, as a door name mapped to a list of path globs:

```yaml
oneWayDoors:
  migrations: [supabase/migrations/**]
  billing: [src/billing/**, src/app/api/billing/**]
  auth: [src/auth/**]
  deploy: [vercel.json, .github/workflows/deploy*.yml]
  deletion: [scripts/purge-*]
```

A value that is not a map of non-empty string lists is an error, `one_way_doors`.

A task's named paths are the path tokens in its `## Allowed paths` section. With
no such section, they are the tokens in its whole body minus its `## Prohibited`
section. A path hits a door when a door glob matches it, when the path covers the
door's directory (`supabase/migrations/**` in a ticket reaches the scanner as
`supabase/migrations`), when the path sits inside a wildcard-free door
(`supabase/migrations/001.sql` against `supabase/migrations`), or when the path
sits inside a globbed door's literal prefix (`.github/workflows/deploy` against
`.github/workflows/deploy*.yml`).

A task that hits a door must be `gate: before`, or be waived. Otherwise the
epic is refused with `one_way_door_ungated`, naming the door, the glob and the path.
`gate: after` is not enough: by then the lane has crossed the door.

### `waivers:` in the `afk:` block

An optional top-level key mapping a task id to the reason it needs no gate:

```yaml
afk:
  version: 1
  branch: feat/42-billing
  tasks:
    43:
      depends_on: []
  waivers:
    43: adds a nullable column only; nothing reads it yet
```

- The reason must be at least 10 characters; a shorter one is an error, `waivers`.
- A waiver key that is not a task in the block is an error, `waivers`.
- A waived hit is a warning, `one_way_door_waived`, that prints the reason.
- A waiver on a task that hits no door is a warning, `waiver_unused`.

### Never delegated

A task that hits a door and whose `stops:` answer is `delegate: …` is an error,
`one_way_door_delegated`, even when it is `gate: before`. Answer `park` or `last`.
