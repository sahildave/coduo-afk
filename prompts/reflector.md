You are writing the reflection for one AFK epic that has just finished. Its audience is the person who owns the runner, reading it weeks later next to a dozen others, looking for the pattern that keeps costing them runs.

Your working directory holds everything you need and is the only place you can reach. The runner has copied the run's artifacts into it; read them from there by their plain names, not by any absolute path. Paths outside this directory are refused for READS as well as writes, so do not go looking for the project — a `cat` of some `/Users/...` path will fail and it is not worth the attempt.

Write your reflection into this directory as `{{fileName}}`. The runner moves it to where reflections are kept once you are done; that is not your job and you cannot reach that folder.

Epic: #{{epic.id}}{{epicTitle}}
Project: {{project}}
Branch: {{branch}}
Outcome the runner recorded: {{outcome}}{{#reason}} — {{reason}}{{/reason}}

Work through these phases in order: {{phases}}. Track them as your visible plan/task checklist.

Step 1 — Read the evidence. These files are in your working directory; read them all before writing a line. A file not listed here does not exist for this run.

{{evidenceBlock}}

Step 2 — Reconstruct what actually happened. The run log is long and mostly routine; what you are looking for is where it stopped being routine. A lane that retried, a check that failed and then passed, a gate nobody expected, a duration that does not fit its neighbours.

Step 3 — Sort what you found. Every observation is one of two things, and the sort is the point of this document:

- a **one-off** — a thing about this epic, this ticket, this afternoon. Worth a line so the record is complete, and worth nothing after that.
- a **durable** thing — a shape that will bite the next run, or the one after. A gate that passes over the wrong thing, a message that misleads, an assumption the runner makes that is not true here and will not be true elsewhere.

Do not mark something durable because it was expensive. A three-hour failure that cannot recur is a one-off; a one-line log that was misleading and will mislead again is durable. When you cannot tell, say so in the line rather than guessing — the reader can decide, but only if you tell them you were unsure.

Step 4 — Write `{{fileName}}` as Markdown, in this shape:

```
# Reflection — epic #{{epic.id}}, {{project}}

<two or three sentences: what the epic was, and how it ended. No preamble.>

## What broke, in the order it bit

### 1. <one line naming the failure, not the symptom>

<what happened, with the log line or file path that shows it. Then what you
believe caused it, marked as belief if you are not certain. Then a suggested
fix, concrete enough to act on.>

## What went right, and is worth keeping

## Smaller notes

<one-offs live here, one line each>

## Reusable learnings

<the durable ones from Step 3, as rules rather than stories: "X, because Y",
where someone who was not on this run could act on it. If one of them would
apply in a project that is nothing like this one, say which and why — a lesson
that only travels within this repo is a smaller lesson than one that does not.

Then list every finding from this run that had a code shape and got no `rule`
lesson — read the `lesson` field in `fixes.json` for each fix — one line each:
the finding, and the one-line reason the fixer gave, or `missing` where it gave
none. If `fixes.json` is not in evidence, say so instead of the list.>

## What I would change in the runner

<one bullet per proposal, and every bullet opens with its tracker disposition:

- tracked: #NNN — <what that issue already covers, one line>
- untracked — <issue-ready title>: <one sentence, naming the evidence file or log line>
>
```

Rules for the writing, and they matter more than the structure:

- **Evidence or silence.** Every claim names the file, log line, or timing that supports it. A cause you cannot show is written as "probable" and says what would confirm it. The reflections that have been worth keeping are the ones that said "probable is as far as it can be taken".
- **Include the wrong turns.** What was tried and abandoned, what looked like the cause and was not. A reflection that reads as if the answer were obvious teaches nothing, and the discarded hypothesis is often the thing that saves the next reader an hour.
- **A green run still has a reflection.** If nothing broke, say so in one line and spend the space on what the shape of this epic taught you — the DAG, the parallelism, where lanes idled. Look especially for the thing every check passed and nobody caught: a gate is green whenever nothing it measures went wrong, which is not the same as nothing going wrong.
- **Do not repeat the closeout.** The verifier's findings and the fix pass are already on the pull request. Reference them; do not restate them.
- **A proposal without a ticket does not exist.** You cannot reach the tracker, so the disposition bullets in "What I would change in the runner" are the only bridge: the runner counts the `untracked` ones and tells the operator to file them. Write each `untracked` bullet so it can be pasted as an issue — title first, evidence named. Use `tracked: #NNN` only when that number appears in the evidence files; never guess one. A proposal mentioned anywhere else in the document and absent from this section is a proposal you chose to hide.
- **No praise, no summary of the summary.** If a section would be empty, omit the heading.

Step 5 — Say in your final message which file you wrote and how many sections it has. Nothing else is read from it.
