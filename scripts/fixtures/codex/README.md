# Codex `codex exec --json` fixtures

What the shipped Codex CLI actually writes to the file the runner reads back
(`scripts/lib.mjs` `codexAgentCommand` redirects `> stream.jsonl 2>&1`), so
`scripts/agent-stats.mjs` can be pinned against real bytes rather than against
somebody's memory of the schema. Captured with codex-cli **0.147.0** on
2026-09-02.

Every file here carries the CLI's own stderr interleaved with the JSONL, because
`2>&1` is what the runner ships and those lines are the ones that make a naive
parser throw. Do not clean them out.

| file | how it was captured |
| --- | --- |
| `success.jsonl` | `codex exec --json --oss --local-provider ollama --model qwen3:4b`. A complete turn: `thread.started`, `turn.started`, `item.completed` for `reasoning` and `agent_message`, and `turn.completed` with the usage block. |
| `rate-limit.jsonl` | the same invocation against the real backend on an exhausted ChatGPT quota. This is failure mode 4 in `AGENTS.md` in its Codex form — the reset is a wall-clock time in the message and nowhere else. |
| `auth-failure.jsonl` | the same invocation with `CODEX_HOME` pointed at an empty directory, i.e. no credentials: five WebSocket retries, a transport fallback, five more, then `turn.failed`. |
| `tool-calls.jsonl` | **assembled, not captured.** The account's quota was exhausted for the whole window this ticket was built in and the local `--oss` provider exposes no tools, so no live run produced a tool item. The envelope (`item.started`/`item.completed`, the `type` tag on `item`) is copied verbatim from the captured files; the item bodies use the field names in the shipped binary's own serde tables — `CommandExecutionItem{command, parsed_cmd, stdout, stderr, aggregated_output, exit_code}`, `FileChangeItem{changes}`, `McpToolCallItem{server, tool, arguments, result}`, `WebSearchItem{query}`. Re-capture it live when the quota allows and delete this paragraph. |
| `bare-429.jsonl` | **assembled, not captured** (#292). The envelope of `auth-failure.jsonl` with a `429 Too Many Requests` message: a transient throttle that names no quota. It must classify as a rate limit, never as exhaustion. |
| `quoted-history.jsonl` | **assembled** (#292). A successful turn whose `agent_message` quotes old usage-limit and 401 text. Agent prose is not a failure event and must classify as nothing. |
| `herdr-*.txt` | **assembled** (#292). Interactive Codex pane text as `herdr pane read` returns it: a usage-limit error, a 401, a bare 429, and prose quoting an old error mid-sentence. Read by `codexTerminalFailure` in `scripts/runtime-herdr.mjs`; tests in `scripts/herdr-codex.test.mjs`. |

Re-capture attempted again on 2026-09-02 during the closeout fix pass, with
codex-cli 0.147.0 and a logged-in ChatGPT account: the run returned
`turn.failed` with *"You've hit your usage limit"* before any tool item, and
`AFK_LIVE=1 node scripts/live-checks.mjs --check=codex` reported
`CODEX RATE-LIMIT: the CLI could not answer.` So `tool-calls.jsonl` is still
assembled, and the tool-count assertions that read it are pinned against a
hand-written fixture rather than against captured bytes. Say that, rather than
"captured fixtures prove tool counts", until a live capture replaces it.


## What the captures already settled

- The tag on an item is `type`, not `item_type`. The parser was right.
- `turn.completed` carries `usage` at the top level, with `input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` and
  `reasoning_output_tokens`.
- **No event in a Codex stream names the model.** Claude's `stream-json` puts it
  on every assistant message; `thread.started` carries only a `thread_id`. So
  `parseStream(...).model` is `null` for a Codex run and the model on a lane's
  dashboard row comes from the role tier that built the command, not from the
  stream. `codex-model-null` in `scripts/live-checks.test.mjs` pins this so it
  reads as a known property rather than as a parser bug.
