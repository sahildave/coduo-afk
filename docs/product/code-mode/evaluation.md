# Code Mode for the AFK runner: evaluation (15 Nov 2026)

## Verdict: skip for now

Code Mode cannot run anywhere the runner runs today, and it does not touch the cost that
prompted the question.

1. **It cannot run in our sessions.** Code Mode works only in an interactive `claude` in a
   terminal. It does not work with `claude -p`, the Agent SDK, the Desktop app, or Remote
   Control. Direct lanes, the default runtime, are `claude -p`. The Orchestrator runs in
   Desktop, or in herdr with `--remote-control`. Supervisor, verify, fixer and reflect run
   the same way lanes do.
2. **It does not shrink the 142k start.** The doc says Code Mode changes how Claude makes
   tool calls: it batches them in JavaScript and returns only the part of the output it
   needs. Nothing in the doc says the tool list, deferred connector names or MCP schemas
   leave the starting context. The 142k start is mostly those, so the cuts in
   `docs/context-bloat-2026-11.md` (about 30k, connector toggles first) are still the fix.
3. **It is one day old in public.** v2.1.323 shipped on 12 Nov. The only user reports are
   one Reddit thread from 14 Nov. It is marked experimental, "may change or be removed".

Look again when Code Mode supports `-p` or the SDK
([anthropics/claude-code#109679](https://github.com/anthropics/claude-code/issues/109679),
open). That is the only change that would let lanes use it, and lanes are where long
read-heavy tool loops happen.

## What Code Mode is

Source: https://code.claude.com/docs/en/code-mode (read 15 Nov 2026) and the v2.1.323
release notes (published 2026-11-12).

- **What it does.** Claude writes JavaScript that calls its tools. One program can run
  calls in parallel, feed one result into the next, and return only what Claude needs to
  read. The tool that runs the code is named `REPL`.
- **How to turn it on.** `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` in the shell or in user
  settings, then confirm once ("Yes, turn on Code Mode"). `0` anywhere turns it off;
  managed settings can block it but not force it on.
- **Requirements.** v2.1.323+ (we have 2.1.325), native build, subscription or Console
  account, Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.2, no HIPAA or zero data retention,
  interactive terminal only.
- **Permissions.** Each tool call inside the code still goes through deny/ask rules and
  `PreToolUse` hooks. In auto mode the classifier reviews the whole program once, not each
  call, and does not see values computed at run time.
- **Limits.** Code waits up to 10 minutes, or runs in the background up to 2 hours in auto
  or bypass mode. A `PreToolUse` hook that fails or times out refuses the call. A
  `UserPromptSubmit` hook can block code output. No Remote Control, no Claude in Chrome, no
  computer use. Resume only in the terminal with Code Mode on. The session cannot move to
  Desktop or become a background session.
- **Cost.** No price of its own. Any saving comes from fewer turns and smaller tool results
  in context. The doc gives no numbers.

## Evidence

All user reports come from one thread:
[r/ClaudeCode, "Claude Code 2.1.323: experimental Code Mode…", 14 Nov 2026](https://www.reddit.com/r/ClaudeCode/comments/1xvw576/)
(160 points, 28 comments). Hacker News has no thread on the built-in feature yet.

### Measured (by us)

| What | Result | Date |
|---|---|---|
| Interactive `claude` started from this Desktop session with the env var set | Refused at startup: "Code Mode (experimental) isn't available: for now it only works in the interactive terminal. Starting with the ordinary tools." The session carries `CLAUDE_CODE_ENTRYPOINT=claude-desktop` and `CLAUDE_CODE_CHILD_SESSION=1`. | 15 Nov |
| Same startup screen | "You've used 93% of your weekly limit." | 15 Nov |

### Measured (reported by others, not checked)

| Claim | Source | Date |
|---|---|---|
| JS wrapper ~200 tokens, saves ~800 per batch on long reads; 10% of write-task runs lost to JS syntax errors | Reddit comment (Motor_Weird_5695), thread above | 14 Nov 2026 |
| Eight searches: raw results averaged 20.3 KB, key fields only 2.95 KB (bytes, not tokens) | Reddit comment (Scary-Sandwich-7433), thread above | 14 Nov 2026 |
| "99.2% cost reduction" from agent-written scripts | [HN item 49019979](https://news.ycombinator.com/item?id=49019979), about desplega-ai's own swarm, not Claude Code's Code Mode | 23 Jul 2026 |

### Opinions and anecdotes

| Report | Source | Date |
|---|---|---|
| A week on one repo: real win on read-heavy tasks, worse on writes, "one bad js line killed the whole batch" | Reddit (Far_Reindeer8428) | 14 Nov 2026 |
| Wins on long read tasks, loses on short ones | Reddit (Far_Reindeer8428) | 14 Nov 2026 |
| Keeps edits as normal tool calls, uses code only for reads | Reddit (omppulse) | 14 Nov 2026 |
| Less visibility into what Claude does, because it reads code, not tool calls | Reddit (HolPomperV12) | 14 Nov 2026 |
| Worry that it defeats hook guardrails; answered from the doc: hooks still see each call | Reddit (joseph-edmondscomm, cafesamp) | 14 Nov 2026 |
| Not offered to every account yet | Reddit (antonation) | 14 Nov 2026 |

### Bugs and gaps

| Issue | Date |
|---|---|
| [#110180](https://github.com/anthropics/claude-code/issues/110180): a mod with an `agent.offer` hook turns Code Mode off; the warning does not name the plugin; background sub-agent results arrive differently | 15 Nov 2026 |
| [#109679](https://github.com/anthropics/claude-code/issues/109679): support in Agent SDK sessions (open) | 13 Nov 2026 |
| [#109847](https://github.com/anthropics/claude-code/issues/109847): support in Remote Control sessions (open) | 14 Nov 2026 |

The idea predates the feature: third-party MCP "code mode" plugins such as
[gabe4coding/claude-code-mode](https://github.com/gabe4coding/claude-code-mode)
(Show HN, 11 and 20 Oct 2026), Cloudflare MCP portals and Bifrost routing (per the Reddit
thread).

## Mapping onto coduo-afk

| Session | How it runs | Code Mode? |
|---|---|---|
| Orchestrator | Desktop app, or `orchestrator-herdr.mjs` with `--remote-control` | **No.** Desktop and Remote Control are both unsupported. Dropping `--remote-control` would remove it from the Desktop sidebar, which the chief of staff relies on. |
| Lanes, direct runtime (default) | `claude -p --output-format stream-json` (`scripts/lib.mjs`) | **No.** `-p` is unsupported. `agent-stats.mjs` also parses stream-json per tool call; a `REPL` call would change what it counts. |
| Lanes, herdr runtime | interactive `claude` in a herdr pane, `--dangerously-skip-permissions` | **Maybe.** The surface is supported, but we could not confirm it starts: a pane launched from a Desktop session may inherit `CLAUDE_CODE_CHILD_SESSION`, which refused it here. Lanes resume with `--resume`, which Code Mode allows only in the terminal. |
| Supervisor, verify, fixer, reflect | same launch path as direct lanes | **No.** |

Where it would help if it could run: herdr lanes doing read-heavy work (grep across a repo,
reading many files, polling `gh`/`afk status`). Where it would hurt: lane builds that
edit many files (one bad line drops the batch), the runner's hooks (a hook timeout now
refuses the call instead of letting it through), and per-call accounting in
`agent-stats.mjs`.

Token bill: no change today, since none of our sessions can turn it on. The start-size
problem is connector names and app tools, which Code Mode does not remove.

## Trial

Not run. A fair trial needs an interactive `claude` in Sahil's own terminal (not one this
Desktop session starts) and two runs of the same task, and the weekly limit is at 93%.

## Smallest pilot, if wanted later

Only once the weekly limit resets, and only by hand. No runner change.

1. Open a plain terminal (not one started from Desktop or herdr).
2. In a coduo-afk checkout, run `claude --model sonnet` and send: "List every script in
   `scripts/` that spawns `claude`, with the flags it passes." Note the session id.
3. Run `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --model sonnet`, confirm the prompt,
   and send the same line.
4. Compare total `input + cache_creation + cache_read + output` tokens in the two
   transcripts under `~/.claude/projects/`.

If Code Mode wins clearly on that read-heavy task, the next question is whether a herdr lane
can start it at all. Until `-p` support lands, that is the only lane where it could run.
