# Why an AFK orchestrator session opens half full (Nov 2026)

## Verdict

The coduo-agents marketplace is **a small part, not the cause**. A `/coduo-afk` start in the
gitsu repo (`github-projects`) went from **55.6k tokens on 19 Aug to 141.6k on 15 Nov (+86k)**.
The marketplace accounts for about **5k** of that growth (the `coduo-afk` SKILL.md grew from
10.9k to 16.2k). Most of the growth since mid-October is **claude.ai connectors attached to the
Desktop app**: their deferred tool names and server instructions grew from about 7k to 27k
tokens. The rest is app-side (Desktop system prompt and its own tools) and the memory files.

**Lanes are not affected.** Lane, supervisor, verify and reflect sessions start at 35–69k and
have been flat since August. They carry no connector names (about 0.1k) and do not load the
orchestrator's MEMORY.md or the `coduo-afk` skill.

## How it was measured

- **Series:** first assistant turn's `input + cache_creation + cache_read` tokens in every
  transcript under `~/.claude/projects/*/` whose first user message is `/coduo-afk`
  (169 starts, 19 Aug – 15 Nov). Scripts: `startsize.py`, `comp.py` (session scratchpad).
- **Exact category split today:** `claude -p "/context"` run in `github-projects` (CLI, so no
  Desktop connectors). Gives memory files per file, skills listing per source, MCP tools per
  server.
- **Bytes → tokens per component** (for history, where `/context` is not available):
  memory 0.39 tok/byte and skills listing 0.33 (both from `/context` today), skill text 0.36
  and MCP instructions 0.4 (regression over 1,306 Nov session starts), deferred tool names
  0.5 (within-group regression: same memory, listing and prompt, different connector set;
  UUID-heavy names tokenize badly). Component figures below are ±15%; totals are exact.

## The 15 Nov session, by part

Session `1aa2d4c8…` (gitsu #1438). First turn 141.6k; the screenshot's 154.8k is after the
epic body (`gh issue view 1438`, +12.1k measured) and the field-notes grep.

| Part | Tokens | Source | Marketplace? |
|---|---|---|---|
| Connector tool names (829 names) | ~19.7k | Desktop + claude.ai connectors | no |
| ↳ Vercel connector alone (256 names) | ~8.2k | claude.ai connector | no |
| `coduo-afk` SKILL.md (46 KB) | ~16.2k | skill store | **yes** |
| Memory files (6) | 23.8k | see next table | no |
| Desktop loaded MCP tools | 21.1k | app tools (browser pane, ccd_*, visualize, docs) + box 3.0k | no |
| System tools + system prompt | 23.6k | Claude Code / Desktop | no |
| Skills listing (510 skills) | 9.8k | capped; store skills ~5.2k of it | partly |
| MCP server instructions | 7.7k | 15 servers; Doop 1.6k, Paper 0.8k, Doop dup 0.8k, Vercel 0.75k, PostHog 0.7k | no |
| SessionStart hooks | ~2k | brain-recall 3.4 KB output, claude-reflect, atlas, axi | axi only (0.1k) |
| Epic #1438 body (after turn 1) | ~12k | `gh issue view` | no |

Memory files (exact, `/context`):

| File | Tokens |
|---|---|
| `~/.claude/projects/-Users-sahildave-code-projects-github-projects/memory/MEMORY.md` (134-file index, 20.7 KB) | 8.7k |
| `github-projects/AGENTS.md` | 6.3k |
| `~/.claude/CLAUDE.md` | 5.6k |
| `~/CLAUDE.md` | 1.8k |
| `github-projects/CLAUDE.md` | 1.3k |
| `github-projects/CLAUDE.local.md` | 0.1k |

Memory has been flat for two months: 23.3k on 9 Sep (first date transcripts record it), a peak
of 29k on 27 Sep, 19.7k after a trim on 28 Sep, 23.8k now. It is large but it is not what grew.

## When it grew

Gitsu-repo session starts, non-skill part (first turn minus the loaded skill):

| Date | Start (non-skill) | What changed |
|---|---|---|
| 9–13 Aug | ~50k | baseline |
| 19–22 Aug | ~61k | SessionStart hook output +5k (later dropped), tools |
| 3 Sep | ~74k | tool/system growth (+10k, not visible in transcripts) |
| 9 Sep – 11 Oct | 75–84k | flat; memory 20–29k |
| **14 Oct** | ~92k | **Vercel claude.ai connector**: +256 names, +7.6k |
| 20–26 Oct | | Typefully, PostHog connectors |
| **29 Oct** | ~110k | Desktop system prompt +5k; Desktop tools +11k; xcode names |
| 7–12 Nov | ~120k | box plugin (3k loaded tools), treg, gitsu-remote, Gmail, Drive, shareling connectors |
| **14–15 Nov** | ~125k | Doop and Gitsu added again as claude.ai connectors (duplicates of local servers) |

Connector first-seen dates (first session whose tool list had it): Vercel 14 Oct, Typefully
20 Oct, PostHog 26 Oct, treg (claude.ai) 7 Nov, box 8 Nov, gitsu-remote 8 Nov, Gmail and Drive
9 Nov, Gitsu (claude.ai) 11 Nov, shareling (claude.ai) 12 Nov, Doop (claude.ai) 14 Nov.

The `coduo-afk` skill itself: 10.9k (19 Aug) → 12.6k (Sep) → 15.1k (28 Sep) → 16.2k (since 20 Oct).

## Hypotheses tested

1. **Marketplace plugins/skills grew the context.** Partly true: the skill +5.3k. Marketplace
   plugins enabled in gitsu (vitest, emilkowalski, react-doctor, vercel-react,
   next-cache-components, openseo) cost ~0.3k in the listing; the listing is capped at ~9.8k
   and flat. coduo-radar and coduo-cache-timers add no start text.
2. **field-notes.md is pulled in at start.** False for turn 1. The orchestrator reads 116 lines
   of it later (+3.6k).
3. **Memory files grew.** False over the last two months (flat ~24k), though MEMORY.md at 8.7k
   is the largest single file.
4. **Connectors and app tools grew.** True: names +15k and instructions +5k since 11 Oct,
   app-side +16k since 29 Oct.

## Cuts, smallest change first

All are orchestrator-only savings. None changes what a lane loads: lanes carry ~0.1k of
connector names, no MEMORY.md and no `coduo-afk` skill, so no cut below can break a lane.

| # | Cut | Saves at start | Lane impact |
|---|---|---|---|
| 1 | Turn off the **Vercel** claude.ai connector for Code sessions (the `vercel` and `vercel-indhuja` CLIs already cover it) | ~9k | none |
| 2 | Turn off the **duplicate** connectors: claude.ai Doop, Gitsu, gitsu-remote, treg, shareling (local servers already provide them); keep one of `coduo-brain` / `open-knowledge` (same 19 tools) | ~5k | none |
| 3 | Turn off **non-coding** connectors for Code sessions: Gmail, Drive, Calendar, Typefully, PostHog | ~3k | none |
| 4 | Trim the gitsu project **MEMORY.md** index (134 entries, 20.7 KB) to one short line per entry | ~5k | none (lanes use other project dirs) |
| 5 | Split **`coduo-afk` SKILL.md**: keep START in SKILL.md, move CHECK, STAGGER, watch and close-out into files read on demand (marketplace change) | ~8k | none (lanes do not load it) |

Cuts 1–5 together: about **30k**, taking a start from ~142k back to ~112k. Not cuttable from
here: the Desktop system prompt and the app's own tools (~45k), and the skills listing (capped).
Optional: disable the box plugin when no box work is planned (3k loaded tools).

## Outcome after review by Fable (15 Nov, evening)

| Cut | Status |
|---|---|
| 1 Vercel | **done**: off for Code sessions (Desktop connector switch, default for new sessions) |
| 2 duplicates | **done** for the true duplicates: claude.ai Doop, Gitsu, Treg. Dropped: `gitsu-remote` is a project-scoped server in `~/.claude.json`, not a connector (~0.2k); "Shareling Staging" is a different environment, not a duplicate; `coduo-brain` / `open-knowledge` dedupe saves ~0.25k |
| 3 non-coding | **done**: Gmail, Google Drive, Google Calendar, Typefully off for Code sessions. PostHog turned back on: mac-directory, gitback and shareling pull errors through it (only github-projects has its own `posthog` server) |
| 4 MEMORY.md | **dropped**: 133 entries at a median 157 chars; a 5k cut would strip the hook phrases that make recall work |
| 5 skill split | **already done** elsewhere: coduo-skills `dbe069f` rewrote SKILL.md to 17.8 KB (~10k saved). Unverified until one real `/coduo-afk` run |

These switches are Code-tab defaults; claude.ai chat keeps the connectors. `disableClaudeAiConnectors: true`
in `~/.claude/settings.json` does not stop Desktop sessions getting connectors, so do not rely on it.
Lanes are confirmed isolated: `scripts/lib.mjs:1362` and `:1412` pass `--strict-mcp-config --no-chrome`,
and `scripts/lane-context.mjs` turns off auto memory and CLAUDE.md files.

Not done, owner's call: the browser-pane tools (Settings → Claude Code → Browser) are ~22 KB of loaded
schema, about 6k tokens, in every Code session.

Terminal-mode Orchestrators already skip all of this. The herdr Orchestrators for epic #1438
(`orchestrator-herdr.mjs start`, entrypoint `cli`, in the epic worktree) started at 46.5k and
46.7k: no browser-pane tools (Desktop only), no claude.ai connectors (`disableClaudeAiConnectors`
is honoured by the CLI), only `afk-broker` and `easel` deferred. The 141.6k start was the
Desktop session where `/coduo-afk` was run by hand. No deny rule is needed.
