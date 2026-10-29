# scripts/fixtures — real run artifacts, committed

Every file here was produced by a real AFK run and copied byte-for-byte out of
that repo's `.afk/` tree. Nothing was hand-edited. Three bugs shipped because an
invented fixture agreed with whoever invented it; these do not.

They used to be read straight out of `/Users/developer/code/projects/gitproj-demo/.afk/`.
That broke twice: `afk archive` moved the artifacts and the tests turned
themselves `skipped` while the suite stayed green. A skipped test is quieter
than a broken one, so the artifacts now live in the repo and the `skip:` guards
are gone.

Source repo: `example/gitproj-demo` (the playground). Paths below mirror the
`.afk/` layout they came from.

## gitproj-demo/epic-50/ — epic 50, run 2026-08-24

| file | from | pins |
| --- | --- | --- |
| `runs/45/builder-1/verification.json` | `.afk/archive/epic-50/runs/45/builder-1/verification.json`, lane 45, 2026-08-24 | `neverReachedApi` read the token counters only. This lane reports zero tokens and still produced and committed `src/cli.js`, so a lane that plainly reached the API was classified as an infra death. Files on disk outrank a counter that was never harvested. Read by `/tmp/afk-probe/probe-api.mjs`. |
| `fixer/50/report.json` | `.afk/archive/epic-50/fixer/50/report.json`, fixer pass on epic 50, 2026-08-24 | The fixer wrote "Same evidence as F1" as F4's deferral reason, in prose, with no schema slot to say it — so two entries for one defect were both charged to the human ("3 left for you"). Pins `duplicateOf` on the deferred path, including dangling refs. Read by `/tmp/afk-probe/probe-dupe.mjs`. |

## gitproj-demo/epic-56/ — epic 56, run 2026-08-24

| file | from | pins |
| --- | --- | --- |
| `fixer/56/report.json` | `.afk/archive/epic-56/fixer/56/report.json`, fixer pass on epic 56, 2026-08-24 | Five fixed items, two distinct defects (F1≡F3, F2≡F4≡F5). `duplicateOf` existed only on `deferred`, so the run announced "fixed 5 of 5 closeout item(s); 0 left for you". Pins the counts in both the epic comment and the log line. Read by `scripts/epic-close.test.mjs` and `/tmp/afk-probe/probe-fixer2.mjs`. |
| `verifier/56/report.json` | `.afk/archive/epic-56/verifier/56/report.json`, verifier pass on epic 56, 2026-08-24 | `counts.findings = { blocker: 1, major: 1, minor: 6 }`. Only blocker and major are queued by `fixerItems`, so the six minor findings were never attempted while the same line claimed "0 left for you". Pins `unqueuedFindings`. Read by `/tmp/afk-probe/probe-fixer2.mjs`. |

## gitproj-demo/epic-62/ — epic 62, run 2026-08-24 (halted mid-run)

| file | from | pins |
| --- | --- | --- |
| `supervisor/59-5e90cfff9f1a/decision.json` | `.afk/supervisor/59-5e90cfff9f1a/decision.json`, lane 59, 2026-08-24 | `salvage` verdict on a deliberately-ungateable lane. |
| `supervisor/60-4aa81fd1c1be/decision.json` | `.afk/supervisor/60-4aa81fd1c1be/decision.json`, lane 60, 2026-08-24 | The second `salvage` verdict. |
| `supervisor/62-44b8a1b264dc/decision.json` | `.afk/supervisor/62-44b8a1b264dc/decision.json`, epic 62, 2026-08-24 | The `epic_ended` verdict that arrived last. |

Together these three pin the whole defect: `state.supervisor` was a single
object, so the two `salvage` verdicts pointing at finished work on disk were
overwritten by the `epic_ended` verdict before anyone read them, and nothing
anywhere said so. Read by `scripts/epic-close.test.mjs`.

## wave/ — hand-authored, and the one exception to the rule above

Everything else here is a real artifact copied out of a real run. `wave/` cannot
be: no wave has ever run, and the artifact in question is the INPUT to a pure
function rather than the output of an agent. What keeps it from being an
invented fixture is that it is not invented from a description — the table in
`docs/wave-mode.md` §1 is the specification, and there is exactly one directory
per row of it.

`wave/accepted/` is the directory that must load: `GOAL.md` plus three task
files, covering both gates, `checks` on the task and `checks` falling through to
the project's `defaultChecks`, and a legitimate shared path (`task-02-picker`
owns a file inside `task-01-model`'s directory and depends on it).

Every other directory is a copy of `accepted/` broken in exactly ONE way, and
named for the refusal code that break must produce. `scripts/wave-loader.test.mjs`
asserts the full set of codes each one yields, so a fixture that is broken in two
ways fails rather than passing quietly — which is how three of them were caught
while this landed.

| directory | the one break |
| --- | --- |
| `unknown_key` | `model: opus` in `task-01-model.md`'s frontmatter |
| `missing_key` | `status:` removed from `task-03-docs.md` |
| `id_mismatch` | `task-02-picker.md` claims `id: task-02-repo-picker` |
| `duplicate_id` | a fourth file claiming `task-03-docs`'s id |
| `dangling_edge` | `task-03-docs.md` is blocked by `task-00-nothing` |
| `cycle` | `task-01-model` is blocked by `task-02-picker`, which is blocked by it |
| `owns_empty` | `owns: []` on `task-03-docs.md` |
| `owns_glob` | `docs/*.md` in `task-03-docs.md`'s `owns` |
| `owns_escape` | `../elsewhere/docs/picker.md` in `task-03-docs.md`'s `owns` |
| `owns_root` | `.` in `task-03-docs.md`'s `owns` — the whole repository |
| `owns_collision` | `task-03-docs.md` owns inside `task-01-model`'s directory with no edge |
| `ungateable` | `checks: []` on `task-01-model.md` |
| `no_title` | `task-02-picker.md`'s `# ` heading demoted |
| `no_criteria` | `task-02-picker.md`'s `## Acceptance criteria` renamed |
| `bad_shape` | `status: draft` on `task-01-model.md` |
| `missing_goal` | `GOAL.md` deleted |

`duplicate_id` is the only row that cannot be a single break: `id_mismatch` pins
`id` to the filename stem, so two files claiming one id on the filesystem always
carry a mismatch too. The isolated case is driven straight at `loadWaveDag` in
the test file instead.

## xcodebuild/ — real tool output, not an AFK artifact

`failing-test.log` is 73,264 bytes of `xcodebuild test` output, captured
byte-for-byte on 2026-09-05 from Xcode's own `xcodebuild` (Apple Swift 6.3.3,
`arm64-apple-macosx26.0`) run against a throwaway two-test Swift package with
one deliberately failing `XCTAssertEqual`:

```
xcodebuild test -scheme ClipDemo-Package -destination 'platform=macOS'   # exit 65
```

It is the second exception to the "produced by a real AFK run" rule above, for
the same reason `wave/` is the first: the artifact needed is the INPUT to a pure
function, and no AFK run has ever driven Xcode. What keeps it honest is that
nothing about it is authored — it is a real tool's real output, and the property
it pins is a fact about that output rather than about the runner. The transcript
was NOT run inside this repo's checkout; the throwaway package lived in
`/tmp` and is gone.

Pins the shape `clipOutput` (`scripts/worker.mjs`) had backwards: `error:`
appears exactly once in the file, at character 71,803 of 73,262, and `Test Case
'-[ClipDemoTests.ClipDemoTests testGreetingIsGoodbye]' failed` 164 characters
after it.
Zero occurrences of either are in the first 2,000 characters, which is what the
head-clip carried into a retry prompt. Read by `scripts/worker.test.mjs`.

## atlas-workspace/ — real `git log` and `knip` output, not AFK artifacts

Captured 2026-09-19 from `developer/atlas-workspace`, byte-for-byte, for the
Reach axis (`scripts/reach.mjs`). Same standing as `xcodebuild/`: a real tool's
real output, which is the INPUT to a pure function — from a repo this runner
drove, but not out of the runner's own `.afk/` tree.

| file | command | pins |
| --- | --- | --- |
| `epic-654/git-log-name-only.txt` | `git log --format=%s --name-only 2ac213f2..origin/feat/654-reduce-filter-menu` | The lane-vs-lane list. Six lanes (#655–#661), and tasks **657 and 661 both wrote five files** under `src/features/filters/components/` — which that epic's closeout does not mention. Also carries the parse's hard case: `Merge task 659:` sits directly under a file line with no separator, because `--name-only` prints no file list for a merge. |
| `epic-625/git-log-name-only.txt` | `git log --format=%s --name-only 6a90db3c..origin/feat/625-macos-release-hardening` | The negative: two lanes (#626, #627) with disjoint surfaces, so the axis must report no seam. Its last line is a file, which is what caught the trailing-newline bug — `filesByTask` was reading the final file of every transcript as the next subject and dropping it. |
| `epic-654/knip-base.json` | `npx knip --reporter json --include exports,types` at `2ac213f2` | 495 unused exports before epic #654 ran. The baseline is red, which is why `newUnusedExports` is a ratchet and not a count. |
| `epic-654/knip-head.json` | the same, at `7c3d048b` (the #654 branch tip) | 496. The one new entry is `FieldKindIcon` in `src/features/shared/components/FieldGlyph.tsx`, and `grep -rn FieldKindIcon src/` on that tree returns its own `export function` line and nothing else. A real instance of the #365 shape, found by the axis rather than invented for it. |

The only thing removed from the two JSON files is the
`[stripe-catalog] No Stripe credentials` noise knip's run printed to stdout
ahead of its report; each file is the single `{"issues":…}` line that followed.

## claude/ — a Claude Code session transcript and a lane stream log, excerpted

| file | from | pins |
| --- | --- | --- |
| `session-excerpt.jsonl` | `~/.claude/projects/-Users-developer--afk-claude-worktrees-Users-developer-atlas-worktrees-epic391-wt-169-wt/10d47d5c-edb9-4040-a253-31b466d668f1.jsonl`, lane 169 builder, epic 391, session 2026-08-24, excerpted 2026-10-03 | `efficiency()` in `scripts/agent-stats.mjs`. Only `assistant` lines are kept, and of those only the first five messages plus the two that run `npx vitest run src/services/issue-reference-cache.test.ts` (the second with the sandbox disabled). Every line of each kept message id is kept, unmodified, so the usage dedupe sees the real block-per-line split. Expected values come from `/tmp/impl-eff/analyze.py`, the reference implementation, run on this file. |
| `stream-excerpt.jsonl` | `Lumina/.afk/archive/epic-19/verifier/19/stream.jsonl` (`developer/Lumina`), verifier pass on epic 19, run 2026-08-21, excerpted 2026-10-03 | Two defects in `efficiency()` on a lane's stream-json log. (1) Each assistant line's `usage.output_tokens` is a stub (1-3 here; 153 summed over the whole file) and only the closing `result` event has the final count (11,928, thinking 2,411). (2) Sub-agent messages carry a non-null `parent_tool_use_id` and no `isSidechain`, so they were counted as the lane's turns. Kept: source lines 12, 13, 20, 21 (two main-thread messages, every line of each), 86, 87, 90 (one sub-agent message, every line) and 259 (the `result` event), each unmodified and in source order. Everything else (system, user, rate-limit lines and the other 41 messages) was removed, so the per-message input and cache sums cover the excerpt only while the result event's totals cover the whole run. Read by `scripts/agent-stats.test.mjs`. |
| `stream-multi-result.jsonl` | `brightpath/.afk/archive/epic-9/verifier/9/stream.jsonl` (`developer/brightpath`), verifier pass on epic 9, run 2026-10-03, excerpted 2026-10-03 | Lines 12, 13, 367 and 374 of that file, unmodified: two assistant lines and the first two `result` events (output_tokens 19753 and 59, thinking 5778 and 0). A resumed or follow-up turn appends another `result`, and each one's usage covers only its own segment. `efficiency()` overwrote `result` and reported the last one alone; the whole file has four results (19753, 59, 27, 29 = 19868) and was reported as 29. This excerpt sums to 19812. |

## Adding to this directory

Copy the file unmodified and add a row naming the epic, the run, the date and
the one defect it pins. If a file is too large to commit whole, say in its row
exactly what was removed. A fixture whose provenance is lost is an invented
fixture again.
