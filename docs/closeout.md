# Epic closeout

What happens between the last lane merging and the pull request being ready to
read. All of it runs without a human. This page says what runs, in what order,
what each step is allowed to do, and where its output lands.

The whole sequence is `closeEpic` in `scripts/auto.mjs`. It fires once, when the
epic **stops** — not when it succeeds. An epic that ends `incomplete` gets the
same closeout as one that ends `completed`, because the runs that most need a
review are the ones that did not finish.

Everything below is advisory. Nothing in the closeout can mark a task passed,
change the epic's outcome, or halt the runner. `close.outcome` is computed from
the DAG in code, and the only thing an agent can move is `completed` →
`completed_with_findings`.

## The sequence

1. **Verifier** — reads the integrated branch against the child issues'
   acceptance criteria and writes a structured report. `scripts/verifier.mjs`.
   It reviews three axes: **standards** and **spec** compare the diff to a
   document, and **reach** compares it to the rest of the repository. Reach is
   handed four lists rather than asked to find them — files two or more lanes
   both wrote, out-of-scope writes already recorded on the verification notes,
   declared paths no commit touched, and exports this epic added that nothing
   outside a test calls. `scripts/reach.mjs` builds them; the last needs the
   project to declare `reachReport` (see `docs/first-hour.md`) and is otherwise
   asked for by grep, which the prompt says on its face.
2. **Fixer** — one bounded pass over that report's must-fix list, its blocker
   and major findings, and the criteria it could not call met.
   `scripts/fixer.mjs`. What it is not handed is listed below, under "What the
   fix pass leaves out".
3. **Fix gate** — if that pass committed anything, the project's check chain is
   re-run over the commit it left. `runCloseoutGate` in `scripts/fixer.mjs`.
4. **PR render** — `ensureDraftPr` rewrites the epic's draft PR body from run
   state, now carrying the review. `scripts/pr.mjs`.
5. **Run-account comment** — the rendered closeout plus what the fixer changed,
   posted as a comment on that PR.
6. **Reflector** — reads the run's own artifacts and writes one reflection
   document, in the **runner's** repository. `scripts/reflect.mjs`.
7. **Reflection comment** — that document, posted as a second PR comment.
8. **Issue comment** — the same closeout markdown, posted on the epic issue.
9. **Minors comment** — the minor findings the fixer never queued, as one
   checklist comment on the epic issue. Skipped when there are none.

The order is not arbitrary. The fixer runs before the PR is rendered so the body
describes the branch as it will actually be read. The reflector runs last on this
path because it reads the fixer's report as evidence.

The fix gate exists because step 2 commits AFTER every check in the run has
already passed, so its output is the newest and least-verified code on the
branch. In an epic that is a one-time cost at the end; in wave mode the next
wave's baseline normally covers it within minutes, but the LAST wave of a run
has no next wave. quillnote wave-34 (2026-09-04) shipped `18cdd44` as the tip
with the wave's five gates recorded two commits below it. The chain only re-runs
when HEAD actually moved, which most closeouts do not do.

## When the review comes back as prose

The verifier is asked for a fenced `json` block, written to a scratch file and
repeated as the last thing in its final message. When neither arrives the report
is `unparseable`, and three things keep the review from being lost (#142):

- **One nudge first.** If the transcript's last message is a wait on a command
  ("Still running. I'll check again when it finishes.", "Let me wait for the
  build to finish") and no review has arrived by either channel (a fenced block
  that carries no summary, findings or criteria, such as a quoted
  `verification.json`, does not count), the runner
  resumes that same session once with `--resume`, in the checkout the first
  session left, and tells it to finish in the foreground and write the report.
  A finished review that mentions waiting ("waiting on a human sign-off",
  "nothing is still running") is not nudged. The nudge gets ten minutes, or the
  role's timeout if that is shorter, and never a second try. If it exits
  non-zero, times out or dies on auth, the first session's review stands and
  `problems` says why. A stream with no session id to resume (Codex) is
  harvested as it stands, and the report says so.
- **Findings are recovered from the prose.** The messages are read from the
  last one back, and the first that yields any finding is used: real verifiers
  keep numbered findings in their axis messages and close with a synthesis or
  "Report above." Numbered lines count anywhere, and so does a paragraph that
  opens with a bold title ending in a full stop, or with `**→ Title**`. Bullets
  and table rows count only under a heading that names findings, violations,
  deviations, issues or gaps, or in a table whose header does. A sub-heading
  inherits its parent's axis, and a bold line on its own (`**Spec**`) is a
  heading. The severity is the one the line states in lead position
  ("Blocker —", "**Major**:") or trailing ("— major.", "(minor)"), else
  `unknown`; a mid-sentence "minor" is not a severity. Every entry carries
  `recovered: "prose"`. Skipped: lines inside a fence, a criteria walk (a line
  opening with a verdict or a criterion id, a table row with a verdict cell,
  anything under a criteria heading), a request to the reader ("Grant Bash
  permission…", anything ending in "?"), and a clean result ("none found",
  "npm test — 120 pass"). Findings are deduplicated on their words and capped at
  25; the overflow is counted in `problems`. A line saying a
  backticked symbol has no non-test caller becomes an `unwired` entry unless
  the runner computed that list, and the runner's own seam list is kept as
  unread. This fails open: a loose finding a human can dismiss beats a real one
  nobody sees.
- **The counts say unknown.** Each axis renders `unknown (review unparseable)`,
  never `(0)` and `_No findings._`, to match the criteria table above it.

The fixer runs on an `unparseable` review too, over the recovered findings, the
`unwired` entries and the unread seams. It still does not run on `agent_failed`
or `auth_failed`. The closeout's Verifier row then says the findings came from
the prose, rather than that nothing was reviewed.

## What the fix pass leaves out

The fixer gets one attempt on a merged branch, so what it is handed is narrow.
Everything it is not handed is still reported:

| Left out | Why | Where it goes |
| --- | --- | --- |
| Minor findings | tidying a merged, reviewed branch is a diff nobody can read | counted on the outcome line, and posted as one uncollapsed checklist comment on the epic issue (`issue-minors.md`) |
| `unknown` criteria that need a person, a device or a live service, or name no sandbox limit | the fixer cannot reach them either, and its answer would be a guess | counted on the outcome line: "N unknown criteria never queued and still unchecked" |
| Every criterion of a task that did not pass | its feature is not on this branch, and building it there writes a lane's worth of code outside any lane's scope (#803) | the closeout's "Tasks that did not pass" section names each task's retained branch and its last attempt's checks, or says it is waiting on a human's acceptance |

The minors checklist is recorded as owed when the closeout is rendered, so a
failed post or a crash before it is retried the next time the closed epic is
entered; if the branch has moved since, it is not posted and the log says it is
still owed. A close after a reopen edits the comment the earlier close posted
instead of adding a second one, and posts a new one if that comment was
deleted.

Most `unknown` criteria ARE handed over, as **check only** (#143): every one
the verifier gave a reason for, unless that reason names a person or a thing the
fixer cannot get either. That means a human sign-off or manual check, a physical
or real device (an iOS 18 device, a simulator), TestFlight or an owner,
production or a live database, a vendor's sandbox or a test account, a signing
entitlement or notarised build, live webhooks, credentials or a named secret,
staging or a deployed URL, or the network. Those words win over any mention of
the review's own sandbox. An `unknown` with no reason at all is one the review
never answered, and stays out. This fails open: a wrong queue costs one fixer
check that reports it could not run, while a wrong drop loses a teeth check
nobody else will run. The fixer runs the check. If it holds, the closeout shows the
criterion as met, in the stage header's count and in the criteria table, with
the output and "not re-reviewed" on its face; if it fails, it becomes an
ordinary finding.

Every step is wrapped. A verifier that cannot run leaves a `skipped` string; a
fix pass that throws leaves every finding for you; a GitHub call that fails is a
warning and the artifact is still on disk. The epic closes either way.

## The three agents

| Role | May | May not |
| --- | --- | --- |
| `verifier` | read the branch, produce a report | write anything — no edits, no commits, no `gh` |
| `fixer` | edit and commit on the branch | push, merge, checkout, or post to GitHub |
| `reflector` | write one document in the reflections folder | touch the project it just read, or commit |

One sentence explains the split: **the verifier judges and cannot write, the
fixer writes and did not judge, and the reflector writes one document in the
runner's own repository.** That is the same property `docs/epic-schema.md`
protects under "Rejected: librarian" — a gate that can write to the thing it
gates is honor-system. The fixer is not that librarian, because it did not
produce the review it is acting on.

Two consequences worth knowing before you read a closeout:

- **The fixer cannot change the epic's outcome.** Nothing re-judges the branch
  after it, so an epic with findings closes `completed_with_findings` whether or
  not they were fixed. A green fix report is a claim, not a second review.
- **A red fix gate does not sink the close.** It is recorded in `close.fixGate`,
  in the runner log and in the wave digest, and the epic closes exactly as
  it would have. A gate that could change the outcome would hand the fixer the
  lifecycle authority the split above refuses it — and the worse error is an
  ungated tip nobody can see, not a gated-and-red one they can.
- **The fixer gets one attempt.** A finding it cannot fix is `deferred` with a
  reason, and a finding it did not mention at all is also `deferred` — silence
  never reads as success.

The caps are enforced by where each role runs and what its deny list refuses, in
`scripts/roles.mjs`. The verifier and the reflector are capped by their working
directory (a throwaway checkout, and the reflections folder respectively); the
fixer cannot be, because its whole output is a commit on the branch, so its cap
is the deny list alone.

## Where the artifacts land

Paths are relative to the project root unless noted. `<epic>` is the epic issue
number.

| Artifact | Path |
| --- | --- |
| Verifier prompt and stream | `.afk/verifier/<epic>/prompt.md`, `stream.jsonl` |
| Verifier report | `.afk/verifier/<epic>/report.json`, `report.md`, `review.md` |
| Fixer prompt and stream | `.afk/fixer/<epic>/prompt.md`, `stream.jsonl` |
| Fixer report | `.afk/fixer/<epic>/report.json` |
| Fix gate result | `.afk/fixer/<epic>/gate.json` |
| Rendered closeout | `.afk/epic-close/<epic>/closeout.md` |
| Run-account comment, as posted | `.afk/epic-close/<epic>/pr-comment.md` |
| Reflection comment, as posted | `.afk/epic-close/<epic>/pr-reflection.md` |
| Issue comment, as posted | `.afk/epic-close/<epic>/issue-comment.md` |
| Minors comment, as posted | `.afk/epic-close/<epic>/issue-minors.md` |
| Verifier nudge prompt and stream, when one was sent | `.afk/verifier/<epic>/nudge.md`, `stream-nudge.jsonl` |
| Reflector prompt, stream, draft | `.afk/reflect/<epic>/` |
| The reflection itself | `<runner>/docs/reflection/<project>/epic-<id>.md` |

The reflection is the one artifact that does not land in the project. It goes in
the runner's repository, under a folder named for the project, because that is
where the operator already keeps them — and the reflector cannot commit it, so
committing it there is yours. It shipped first as
`docs/<project>/reflection/epic-<id>.md` and was moved: a top-level folder per
project put forty-one near-empty directories beside `docs/README.md`, so a run
with a junk project name now makes a junk folder inside `docs/reflection/`
instead. A run with no GitHub remote has no project name and gets no reflection
at all.

Every step reuses what is already on disk (`reuse: true`), so a close that
happens twice across a restart costs one review, one fix pass, one chain re-run
and one reflection — and cannot overwrite a reflection you have since edited.

## Why the run account is a comment, not the PR body

**The run account is posted as a PR comment because the PR body is re-rendered
from run state on every refresh.** `renderPrBody` regenerates the body from
`.afk/state.json` each time and never reads it back, so anything written into the
body is silently overwritten by the next render with nothing to show it existed.
A closeout put there would survive exactly until the next refresh.

A comment is append-only and carries a marker
(`<!-- afk:run-account:<epic> -->`), so it survives every later render and can be
found again. Five separate epic reflections reached this conclusion
independently before it was code
(`docs/reflection/voice-studio/epic-{1,4,5,47}.md`,
`docs/reflection/brightpath/epic-1.md`).

The reflection is a **second** comment rather than an appendix to the first, on
purpose. The run account is about the code and is read before merging; the
reflection is about the run and is read when the same thing goes wrong again.
One comment carrying both gets scrolled past by whichever reader came for the
other half.

## What is still yours

The closeout ends with a branch, a PR, two comments and a closed epic. Three
things are deliberately left undone:

- **`afk finish`.** The end-of-run checklist: it reads the closeout review off
  disk (it never spawns one, so it is free and offline), warns about lanes that
  did not pass, names untracked files sitting in retained lane worktrees, and
  prints the merge command.
- **The merge.** `afk finish` prints it; you run it. The merge is the last human
  checkpoint in a run nobody watched, and a runner that landed its own work on
  `main` would be trusting the agents that wrote the code to also decide it
  ships.
- **Every deferred finding.** Whatever the fixer could not or did not fix is in
  the run-account comment with its reason, and in
  `.afk/fixer/<epic>/report.json`. Nothing else will pick it up.

If the epic closed `completed_with_findings`, the runner log says so and
names the blocking items. The work is merged and accepted; those items are
yours.
