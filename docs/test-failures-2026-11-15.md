# Baseline test failures on main, 2026-11-15

## Verdict

All 16 failures have one cause, and it is a stale test, not a runner bug.

PR #59 ("Closeout tells the truth") made the closeout run the project's full
check chain over the tip before the verifier, even when no fix commit moved it
(`gateCloseoutFix(headSha(root), { force: true })`, `scripts/auto.mjs:3741`).
That was intended, and #59 updated six test files to match. It missed two:
`scripts/baseline.test.mjs` and `scripts/gate-rerun.test.mjs`. Their fixtures
count baseline runs with a command that appends a line to a file, and the
closeout's tip gate runs that same command once more. Every failing assertion
is off by exactly one.

Nothing here is environment-specific: the failures reproduce in isolation, on
every run, in about 3 seconds.

## Run

`node afk.mjs selftest --test-reporter=tap` on `ddb4053` (main): 2070 tests,
2054 pass, 16 fail, 202 s.

| # | Test | Location | Got | Expected |
|---|------|----------|-----|----------|
| 46 | a cold start runs the baseline and records the green head and commands (#145) | `scripts/baseline.test.mjs:146` | 2 | 1 |
| 47 | a dashboard that cannot start does not stop the epic: one warning, then the baseline | `scripts/baseline.test.mjs:159` | 2 | 1 |
| 51 | a restart at the same head with the same commands skips the baseline and says so (#145) | `scripts/baseline.test.mjs:267` | 2 | 1 |
| 52 | the runner's own status commit between two starts does not cost a second baseline (#145) | `scripts/baseline.test.mjs:282` | 2 | 1 |
| 53 | a moved head or a changed check list still runs the baseline (#145) | `scripts/baseline.test.mjs:305` | 2 | 1 |
| 57 | the runner's own artefact sweep after a green fix gate does not cost a baseline (#176 W2) | `scripts/baseline.test.mjs:413` | 2 | 1 |
| 58 | a red fix gate, or a real commit after a green one, still runs the baseline (#176 W2) | `scripts/baseline.test.mjs:432` | 3 | 2 |
| 60 | a baseline skips the Rust checks only when nothing Rust-relevant changed since the last green (#176 W3) | `scripts/baseline.test.mjs:481` | 2 | 1 |
| 62 | the baseline waits for another epic's gate lock and records the wait (#178) | `scripts/baseline.test.mjs:527` | 2 | 1 |
| 63 | a relaunch's baseline waits for another epic's gate lock (#223) | `scripts/baseline.test.mjs:576` | 2 | 1 |
| 64 | a relaunch's baseline waits for load under the threshold before it starts (#223) | `scripts/baseline.test.mjs:611` | 2 | 1 |
| 65 | a relaunch whose tree differs from the green baseline only by integrated task merges skips it (#223) | `scripts/baseline.test.mjs:654` | 2 | 1 |
| 66 | a merge no passed task integrated, or a commit after an integrated merge, still runs the baseline (#223) | `scripts/baseline.test.mjs:675` | 3 | 2 |
| 550 | an environment-classed red baseline reruns once and the run goes on (#179) | `scripts/gate-rerun.test.mjs:132` | 3 | 2 |
| 557 | a baseline red on a GitHub 5xx waits for a quiet host and reruns once (#223) | `scripts/gate-rerun.test.mjs:263` | 3 | 2 |
| 560 | a baseline timeout in a test outside the epic's diff reruns once (#223) | `scripts/gate-rerun.test.mjs:315` | 3 | 2 |

All are `ERR_ASSERTION` from `assert.equal(fx.runs(), N)` or the
`gate-rerun.test.mjs` equivalent. The log of each shows the extra run:

```
AUTO: closeout tip `5e7adfc…` gated: **yes** — no fix commit; the full chain (1 check(s)) ran over the tip before the closeout review; all exited 0.
```

## Group

| Group | Tests | Cause | Introducing commit | Kind | Fix | Size |
|-------|-------|-------|--------------------|------|-----|------|
| 1 | all 16 above | The closeout's pre-review tip gate runs the baseline command again; the fixtures count every run of that command as a baseline | `aa8efbc` (#59) | Stale test | Count baseline runs from `.afk/runs/gate-events.jsonl` rows with `kind === "baseline"`, not from the command's counter file | Small: the `runs()` / `rustRuns()` helpers in `baseline.test.mjs` and the counter in `gate-rerun.test.mjs`, about 15 lines, no runner change |

## Evidence

- **Bisect point.** `node --test --test-name-pattern="a cold start runs the baseline" scripts/baseline.test.mjs`
  fails at `aa8efbc` (pass 0 / fail 1) and passes at `aa8efbc~1` (pass 1 / fail 0).
- **#59 knew about the extra run.** Its commit message says the closeout "now
  runs one extra chain over the tip before the review" and lists the tests it
  updated. Its changed test files are `close`, `closeout-gate`, `epic-close`,
  `epic-e2e`, `fixer` and `verifier`; `baseline` and `gate-rerun` are not among
  them.
- **The runner side is intended, not a bug.** A throwaway patch that skipped the
  forced tip gate when the tip equals the last green baseline turned 13 of the 16
  green, and broke four `closeout-gate.test.mjs` tests that lock #59's rule (34,
  35, 36, 41: the pre-review gate always runs). Changing the runner would undo
  #59, so the tests are what move.
- **The right counter already exists.** `gate-rerun.test.mjs:148` and
  `baseline.test.mjs:551,600` already read `kind === "baseline"` gate events;
  the closeout's run records `kind: "fix"`, so counting by kind separates the two.

## Not a cause

The pre-existing `wave-driver` failure #59's message mentions
("afk-codex wave run keeps Codex for nested auto preflight") passes on main
today. No herdr, sandbox, network or tool-version failure appeared in the run.
