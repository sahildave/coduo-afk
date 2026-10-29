// scripts/agent-stats.mjs — read a worker's JSONL log into live stats.
// `claude -p --output-format stream-json` emits one JSON object per line, so a
// run can be inspected while it is still in flight.
// Powers agent:stats, the dashboard, and auto.mjs's rate-limit detection.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isMainModule, parseArgv } from './lib.mjs';

// Keep the display denominator configurable because the model's effective
// context window is supplied by the service rather than exposed as a CLI flag.
export const CONTEXT_LIMIT = Number(process.env.AGENT_CONTEXT_LIMIT || 1_000_000);

// A command item carries the whole command string; other item types expose a
// useful detail under one of these common fields.
export const describeTool = (name, input = {}) => {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.path
    ?? input.prompt ?? input.url ?? input.query;
  return detail ? `${name}: ${detail}` : name;
};

const ACTION_TYPES = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'image_generation',
  'dynamic_tool_call',
  'collab_agent_tool_call',
]);

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  return asText(value.text ?? value.content ?? value.message ?? value.output);
};

const itemText = (item = {}) => asText(item.text ?? item.content ?? item.message ?? item.output);

const itemId = (item, event) => item.id ?? event.item_id ?? event.itemId ?? item.call_id ?? item.callId;

const itemLabel = (item = {}) => {
  switch (item.type) {
    case 'command_execution':
      return describeTool('command', { command: item.command ?? item.cmd });
    case 'file_change':
      return 'file change';
    case 'mcp_tool_call':
      // `McpToolCallItem` names the tool in `tool` and its server in `server`;
      // `name` is the older shape. Both, so a stream from either CLI reads.
      return describeTool(
        item.tool ? `${item.server ?? 'mcp'}/${item.tool}` : item.name ?? 'mcp tool',
        item.arguments ?? item.input ?? {},
      );
    case 'web_search':
      return describeTool('web search', { query: item.query });
    case 'image_generation':
      return describeTool('image generation', { prompt: item.prompt });
    case 'dynamic_tool_call':
    case 'collab_agent_tool_call':
      // `DynamicToolCallItem` is `{namespace, tool, arguments}`; `name` again is
      // the older shape.
      return describeTool(item.tool ?? item.name ?? item.type, item.arguments ?? item.input ?? {});
    default:
      return item.type ?? 'item';
  }
};

// --- claude stream-json ------------------------------------------------------
// `claude -p --output-format stream-json` reports one event per assistant turn:
// tool calls arrive as `tool_use` content blocks and finish when the matching
// `tool_result` comes back from the user side. The per-item event shape below
// is also accepted, so older stream logs still parse.
const contentBlocks = (event) => {
  const content = event.message?.content ?? event.content;
  return Array.isArray(content) ? content : [];
};

const toolUseLabel = (block) =>
  describeTool(block.name ?? "tool", block.input ?? {});

const claudeUsage = (usage = {}) => ({
  input_tokens:
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0),
  cached_input_tokens: usage.cache_read_input_tokens ?? 0,
  output_tokens: usage.output_tokens ?? 0,
});

const rateLimitInfo = (info) => {
  if (!info || typeof info !== 'object') return null;
  return {
    ...info,
    status: info.status ?? info.state,
    rateLimitType: info.rateLimitType ?? info.rate_limit_type ?? info.type,
    resetsAt: info.resetsAt ?? info.resets_at ?? info.resetAt ?? info.reset_at,
  };
};

const recordUsage = (stats, event) => {
  const usage = event.usage ?? {};
  if (Object.keys(usage).length > 0) stats.usageKnown = true;
  const input = usage.input_tokens ?? usage.inputTokens ?? 0;
  const cached = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0;
  const output = usage.output_tokens ?? usage.outputTokens ?? 0;
  const context = input + cached;
  if (context) stats.contextTokens = context;
  stats.outputTokens += output;
};

const limitText = (event) => [
  event.error?.code,
  event.error?.message,
  event.message,
  event.result,
  event.code,
].filter(Boolean).join(' ');

const LIMIT_RE = /(session[ _]limit|usage[ _]limit|rate[ _]limit|quota exceeded|too many requests|resets? (at )?\d)/i;

const recordFailure = (stats, event) => {
  const status = event.api_error_status
    ?? event.apiErrorStatus
    ?? event.error?.status
    ?? event.error?.status_code
    ?? event.error?.http_status;
  const text = limitText(event);
  if (status === 429 || LIMIT_RE.test(text)) {
    stats.apiErrorStatus = stats.apiErrorStatus ?? 429;
    stats.rateLimit = stats.rateLimit ?? { status: 'rejected', rateLimitType: 'rate limit' };
  }
  const info = rateLimitInfo(event.rate_limit_info
    ?? event.rateLimitInfo
    ?? event.rate_limit
    ?? event.rateLimit
    ?? event.error?.rate_limit_info);
  if (info) stats.rateLimit = info;
};

export const parseStream = (text) => {
  const s = {
    turns: 0,
    toolCalls: 0,
    tools: {},
    contextTokens: 0,
    outputTokens: 0,
    usageKnown: false,
    costUsd: null,
    model: null,
    rateLimit: null,
    lastText: '',
    result: null,
    apiErrorStatus: null,
    activeAction: '',
    lastActivity: '',
  };
  const seenActions = new Set();
  const activeItems = new Map();
  // Every message the agent emitted, not just the last one. `lastText` is the
  // right thing for a progress line and the WRONG thing for harvesting a
  // deliverable: anything that wakes an agent after it answers — a stale timer,
  // a late tool result — replaces the answer with whatever it says next.
  const texts = [];
  const recordText = (message) => {
    s.lastText = message;
    // The `result` line usually repeats the final assistant message verbatim.
    if (texts.at(-1) !== message) texts.push(message);
  };

  const refreshActive = () => {
    const current = [...activeItems.values()].at(-1) ?? '';
    s.activeAction = current;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    // A Codex stream names the model NOWHERE today — `thread.started` carries
    // only a thread id — so this stays null for a Codex run and the model on a
    // lane's row comes from the role tier that built the command. `e.thread`
    // is read anyway so that a CLI which starts reporting it is picked up
    // without a code change; see scripts/fixtures/codex/README.md.
    s.model = e.model ?? e.model_slug ?? e.modelSlug ?? e.item?.model
      ?? e.message?.model ?? e.thread?.model ?? s.model;

    if (e.type === 'assistant') {
      s.turns++;
      recordUsage(s, { usage: claudeUsage(e.message?.usage ?? e.usage) });
      for (const block of contentBlocks(e)) {
        if (block.type === 'tool_use') {
          const id = block.id ?? toolUseLabel(block);
          if (!seenActions.has(id)) {
            seenActions.add(id);
            s.toolCalls++;
            s.tools[block.name ?? 'tool'] = (s.tools[block.name ?? 'tool'] || 0) + 1;
          }
          const label = toolUseLabel(block);
          activeItems.set(id, label);
          s.lastActivity = label;
        } else if (block.type === 'text') {
          const message = asText(block.text).trim();
          if (message) {
            recordText(message);
            s.lastActivity = message;
          }
        }
      }
      refreshActive();
    }

    if (e.type === 'user') {
      for (const block of contentBlocks(e)) {
        if (block.type === 'tool_result') activeItems.delete(block.tool_use_id);
      }
      refreshActive();
    }

    if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
      const item = e.item ?? {};
      const id = itemId(item, e) ?? itemLabel(item);
      if (ACTION_TYPES.has(item.type)) {
        if (!seenActions.has(id)) {
          seenActions.add(id);
          s.toolCalls++;
          s.tools[item.type] = (s.tools[item.type] || 0) + 1;
        }
        const label = itemLabel(item);
        if (e.type !== 'item.completed') {
          activeItems.set(id, label);
          s.lastActivity = label;
          refreshActive();
        } else {
          activeItems.delete(id);
          refreshActive();
        }
      }
      if (e.type === 'item.completed' && item.type === 'agent_message') {
        const message = itemText(item).trim();
        if (message) {
          recordText(message);
          s.lastActivity = message;
          activeItems.clear();
          refreshActive();
        }
      }
    }

    if (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.aborted') {
      s.turns++;
      recordUsage(s, e);
      if (e.type === 'turn.completed') s.result = 'success';
      else s.result = e.type === 'turn.aborted' ? 'aborted' : 'failed';
      if (e.type !== 'turn.completed') recordFailure(s, e);
    }

    if (e.type === 'rate_limit_event') {
      s.rateLimit = rateLimitInfo(e.rate_limit_info ?? e.rateLimitInfo) ?? s.rateLimit;
    }

    if (e.type === 'error') {
      s.result = 'error';
      recordFailure(s, e);
    }

    if (e.type === 'result' || e.total_cost_usd !== undefined) {
      s.result = e.subtype ?? (e.is_error ? 'error' : 'success');
      s.costUsd = e.total_cost_usd ?? s.costUsd;
      if (typeof e.result === 'string' && e.result.trim()) recordText(e.result.trim());
      recordFailure(s, e);
      activeItems.clear();
      refreshActive();
    }
  }
  s.allText = texts.join('\n\n');
  s.texts = texts;
  return s;
};

// The newest attempt's raw stream log for a task, or null.
const readStream = (taskId) => {
  try {
    const dirs = readdirSync(`.afk/runs/${taskId}`).filter((name) => /^(builder|integration)-\d+$/.test(name)).sort();
    return readFileSync(`.afk/runs/${taskId}/${dirs.at(-1)}/stream.jsonl`, 'utf8');
  } catch {
    try { return readFileSync(`.afk-runs/${taskId}/stream.jsonl`, 'utf8'); } catch { return null; }
  }
};

export const readStats = (taskId) => {
  const text = readStream(taskId);
  return text == null ? null : parseStream(text);
};

// Final agent text — what the runner stores in agent-output.log.
export const finalText = (text) => parseStream(text).lastText;

// Everything the agent said, oldest first — what a REPORT is read from. Every
// consumer scans it backwards for the last block that parses, so a trailing
// message that is not the deliverable costs nothing, while a missing one cost a
// whole review.
export const reportText = (text) => parseStream(text).allText;

// The same messages one by one, oldest first, for a reader that has to know
// which message a line came from (scripts/verifier.mjs, prose recovery).
export const reportMessages = (text) => parseStream(text).texts;

export const format = (id, s) => {
  if (!s) return `${id}: no stream log yet`;
  const usage = s.contextTokens
    ? `context ${(s.contextTokens / 1000).toFixed(1)}k/${CONTEXT_LIMIT / 1000}k (${Math.round((s.contextTokens / CONTEXT_LIMIT) * 100)}%)`
    : 'usage pending (reported on the first turn)';
  const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}x${c}`).join(' ');
  const util = Number.isFinite(s.rateLimit?.utilization) ? ` ${Math.round(s.rateLimit.utilization * 100)}% used` : '';
  const rl = s.rateLimit ? ` | ${s.rateLimit.rateLimitType ?? 'rate limit'}${util}${s.rateLimit.status ? ` (${s.rateLimit.status})` : ''}` : '';
  const cost = s.costUsd != null ? ` | $${s.costUsd.toFixed(2)}` : '';
  const active = s.activeAction ? ` | active ${summarize(s.activeAction)}` : '';
  const latest = !s.activeAction && s.lastActivity ? ` | latest ${summarize(s.lastActivity)}` : '';
  return `${id} ${s.result ? `[${s.result}]` : '[running]'} | ${usage} | ${s.turns} turns | ${s.toolCalls} tools${top ? ` (${top})` : ''} | out ${(s.outputTokens / 1000).toFixed(1)}k${active}${latest}${cost}${rl}`;
};

// --- efficiency --------------------------------------------------------------
// Where a lane's tokens went, from the per-message `usage` a Claude stream-json
// log (or the session transcript under ~/.claude/projects) carries. Codex
// streams report usage per turn only, so they yield `turns: 0` here.
//
// Deliberately NOT computed: narration ratio and tokens-per-changed-line. Both
// are gameable and measured at ~0.1% of cost on ten lanes. No composite score
// either — the components are printed and the reader weighs them.
export const COST_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

// A rough chars-per-token ratio. Thinking text is stored empty (signature
// only), so thinking tokens are what is left of output after visible text and
// tool input — an estimate, and labelled one wherever it is shown.
const CHARS_PER_TOKEN = 4;

export const efficiency = (text) => {
  const messages = new Map();
  const tools = {};
  const seenTools = new Set();
  const commands = new Map();
  let sandboxDisabled = 0;
  // stream-json only: the `result` events. Their usage carries the final
  // output count; each assistant line's own output_tokens is a stub (1-20)
  // written before the message finished. A transcript has no result event.
  // A resumed or follow-up turn appends another result whose usage covers only
  // its own segment, so output and thinking are summed over all of them.
  let resultCount = 0;
  let resultOutput = 0;
  let resultThinking = null;
  let streamJson = false;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    // Only stream-json carries `parent_tool_use_id`; a transcript has `isSidechain`.
    if ('parent_tool_use_id' in e) streamJson = true;
    if (e.type === 'result' && e.usage) {
      resultCount++;
      resultOutput += e.usage.output_tokens ?? 0;
      const thinking = e.usage.output_tokens_details?.thinking_tokens;
      if (thinking != null) resultThinking = (resultThinking ?? 0) + thinking;
      continue;
    }
    // Sub-agent turns are billed to the sub-agent, not this lane's context.
    // A transcript marks them `isSidechain`; stream-json sets
    // `parent_tool_use_id` to the Agent call that spawned them.
    if (e.type !== 'assistant' || e.isSidechain || e.parent_tool_use_id) continue;
    const m = e.message ?? {};
    // stream-json emits one line per content block, each repeating the
    // message's usage — so usage is per message id, never per line.
    const id = m.id ?? `line-${messages.size}`;
    if (!messages.has(id)) messages.set(id, { usage: {}, textChars: 0, toolChars: 0 });
    const msg = messages.get(id);
    const usage = m.usage ?? {};
    if ((usage.output_tokens ?? 0) >= (msg.usage.output_tokens ?? 0)) msg.usage = usage;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === 'text') msg.textChars += String(block.text ?? '').length;
      if (block.type !== 'tool_use') continue;
      const key = block.id ?? `${id}:${JSON.stringify(block.input)}`;
      if (seenTools.has(key)) continue;
      seenTools.add(key);
      const input = block.input ?? {};
      msg.toolChars += JSON.stringify(input).length;
      tools[block.name ?? 'tool'] = (tools[block.name ?? 'tool'] ?? 0) + 1;
      if (input.dangerouslyDisableSandbox) sandboxDisabled++;
      if (typeof input.command === 'string') commands.set(input.command, (commands.get(input.command) ?? 0) + 1);
    }
  }
  const all = [...messages.values()];
  const sum = (field) => all.reduce((n, msg) => n + (msg.usage[field] ?? 0), 0);
  const turns = all.length;
  // 'stub': stream-json with no result yet (running or killed lane), so the
  // per-message sum is a stub count, not the output.
  const outputSource = resultCount ? 'result' : streamJson ? 'stub' : 'transcript';
  const output = resultCount ? resultOutput : sum('output_tokens');
  const reportedThinking = resultCount ? resultThinking ?? undefined : undefined;
  const input = sum('input_tokens');
  const cacheRead = sum('cache_read_input_tokens');
  const cacheWrite = sum('cache_creation_input_tokens');
  const textTokens = Math.round(all.reduce((n, msg) => n + msg.textChars, 0) / CHARS_PER_TOKEN);
  const toolInputTokens = Math.round(all.reduce((n, msg) => n + msg.toolChars, 0) / CHARS_PER_TOKEN);
  const first = all[0]?.usage ?? {};
  const firstContext = (first.input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0)
    + (first.cache_creation_input_tokens ?? 0);
  return {
    turns,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    tools,
    tokens: {
      output,
      outputSource,
      outputEstimate: {
        text: textTokens,
        toolInput: toolInputTokens,
        thinking: reportedThinking ?? Math.max(0, output - textTokens - toolInputTokens),
      },
      // 'reported' when the result event counted thinking tokens, else the
      // remainder above.
      thinkingSource: reportedThinking == null ? 'estimate' : 'reported',
      input,
      cacheRead,
      cacheWrite,
    },
    costUnits: Math.round(input * COST_WEIGHTS.input + cacheWrite * COST_WEIGHTS.cacheWrite
      + cacheRead * COST_WEIGHTS.cacheRead + output * COST_WEIGHTS.output),
    firstContext,
    // The fixed starting context is re-read on every turn after the first
    // (which creates it); this is the share of all cache reads that
    // re-reading accounts for.
    firstContextShare: cacheRead ? (firstContext * Math.max(0, turns - 1)) / cacheRead : null,
    cacheReadPerTurn: turns ? Math.round(cacheRead / turns) : 0,
    retries: {
      sandboxDisabled,
      repeatedCommands: [...commands.values()].reduce((n, count) => n + count - 1, 0),
    },
  };
};

const NO_STREAM = 'no stream log; pass the session transcript path';

// An archived stream log for a task id: .afk/archive/<epic>/<role>/<id>/stream.jsonl.
const findArchived = (taskId, dir = '.afk/archive', depth = 0) => {
  if (depth > 4) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.name === String(taskId) && existsSync(`${path}/stream.jsonl`)) return `${path}/stream.jsonl`;
    const found = findArchived(taskId, path, depth + 1);
    if (found) return found;
  }
  return null;
};

const noStreamMessage = (taskId) => {
  const archived = findArchived(taskId);
  return archived ? `${NO_STREAM}; an archived log exists at ${archived}` : `${NO_STREAM}, or check .afk/archive`;
};

const k = (n) => `${(n / 1000).toFixed(1)}k`;

export const formatEfficiency = (id, e, attempts = null) => {
  if (!e?.turns) return `${id}: no Claude per-message usage in this log`;
  const t = e.tokens;
  const tools = Object.entries(e.tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}x${c}`).join(' ');
  const unattributed = t.output - t.outputEstimate.thinking - t.outputEstimate.text - t.outputEstimate.toolInput;
  const thinking = t.thinkingSource === 'reported'
    ? `thinking ${k(t.outputEstimate.thinking)} (reported) + text ~${k(t.outputEstimate.text)} + tool input ~${k(t.outputEstimate.toolInput)} (estimate: chars/4) + unattributed ~${k(unattributed)}`
    : `text ~${k(t.outputEstimate.text)} + tool input ~${k(t.outputEstimate.toolInput)} + thinking ~${k(t.outputEstimate.thinking)} (estimate: chars/4, thinking is the remainder)`;
  const share = e.firstContextShare == null ? 'n/a' : `${Math.round(e.firstContextShare * 100)}%`;
  const w = COST_WEIGHTS;
  return [
    `${id} efficiency`,
    `  turns          ${e.turns}${attempts ? ` | attempts builder ${attempts.builder ?? 0}, integration ${attempts.integration ?? 0}` : ''}`,
    `  tool calls     ${e.toolCalls}${tools ? ` (${tools})` : ''}`,
    t.outputSource === 'stub'
      ? '  output         n/a (run has no result event yet)'
      : `  output         ${k(t.output)} = ${thinking}`,
    `  input          ${k(t.input)} | cache read ${k(t.cacheRead)} | cache write ${k(t.cacheWrite)}`,
    `  cost units     ${k(e.costUnits)} (input x${w.input} + cache write x${w.cacheWrite} + cache read x${w.cacheRead} + output x${w.output})`,
    `  first context  ${k(e.firstContext)} | first context x (turns - 1) = ${share} of cache read`,
    `  cache read/turn ${k(e.cacheReadPerTurn)}`,
    `  env retries    sandbox disabled ${e.retries.sandboxDisabled} | repeated commands ${e.retries.repeatedCommands}`,
  ].join('\n');
};

const summarize = (value) => String(value).replace(/\s+/g, ' ').trim().slice(0, 100);

// Recent activity, readable — raw JSONL lines are unreadable in a panel.
export const timeline = (text, limit = 14) => {
  const rows = [];
  const pending = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') {
      for (const block of contentBlocks(e)) {
        if (block.type === 'tool_use') {
          pending.set(block.id ?? toolUseLabel(block), rows.length);
          rows.push(`… ${summarize(toolUseLabel(block))}`);
        } else if (block.type === 'text') {
          const message = asText(block.text).trim();
          if (message) rows.push(`· ${summarize(message)}`);
        }
      }
      continue;
    }
    if (e.type === 'user') {
      for (const block of contentBlocks(e)) {
        const at = block.type === 'tool_result' ? pending.get(block.tool_use_id) : undefined;
        if (at !== undefined) {
          rows[at] = `✓ ${rows[at].slice(2)}`;
          pending.delete(block.tool_use_id);
        }
      }
      continue;
    }
    if (e.type !== 'item.started' && e.type !== 'item.completed') continue;
    const item = e.item ?? {};
    const id = itemId(item, e) ?? itemLabel(item);
    if (e.type === 'item.started' && ACTION_TYPES.has(item.type)) {
      pending.set(id, rows.length);
      rows.push(`… ${summarize(itemLabel(item))}`);
    }
    if (e.type === 'item.completed' && ACTION_TYPES.has(item.type)) {
      if (pending.has(id)) {
        const at = pending.get(id);
        rows[at] = `✓ ${rows[at].slice(2)}`;
        pending.delete(id);
      } else {
        rows.push(`✓ ${summarize(itemLabel(item))}`);
      }
    }
    if (e.type === 'item.completed' && item.type === 'agent_message') {
      const message = itemText(item).trim();
      if (message) rows.push(`· ${summarize(message)}`);
    }
  }
  return rows.slice(-limit).join('\n');
};

// --- lane exploration metrics ------------------------------------------------
// Does a lane that reads docs/CODE-MAP.md spend less finding its way around
// before it starts editing? These are the numbers that answer it, per lane.
//
// "Before the first edit" is every assistant message before the one carrying
// the first Edit/Write/MultiEdit/NotebookEdit call (or a Codex `file_change`).
// A message's tokens are its input (uncached + cache write + cache read) plus
// its output, so they add up to what the lane was billed for, cached or not.
// Each message is charged to the category of its first tool call: `explore`
// (ls/grep/find/sed/cat/head/tail/rg via the shell, or Read/Grep/Glob),
// `graphify` (graphify explain/path/query), `other` (any other tool, or none).
// `tokens` is the billed sum, so it counts the context once per turn; the
// context the exploration ADDED is `contextGrowth`: the last pre-edit message's
// input minus the first message's (the system prompt and the task brief).
// Codex reports usage only when its single turn completes, so a Codex lane's
// pre-edit TOKENS read 0; its pre-edit tool calls are still exact.
// Messages are de-duplicated by id: a session transcript writes one message
// per content block, each carrying the same usage.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CODE_MAP = /(?:^|[\s/'"])docs\/CODE-MAP\.md\b/;
const EXPLORE_SHELL = /^\s*(?:cd\s+\S+\s*(?:&&|;|\n)\s*)?(?:ls|grep|rg|find|sed|cat|head|tail|wc|tree)\b/;
const GRAPHIFY = /\bgraphify\s+(?:explain|path|query)\b/;

// Codex wraps every command in a login shell: `/bin/zsh -lc "sed -n 1,9p f"`.
const shellCommand = (command) =>
  String(command ?? '').replace(/^\s*(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/, '$2');

const toolCategory = (name, input = {}) => {
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'explore';
  if (name === 'Bash' || name === 'command_execution') {
    const command = shellCommand(input.command);
    if (GRAPHIFY.test(command)) return 'graphify';
    if (EXPLORE_SHELL.test(command)) return 'explore';
  }
  return 'other';
};

const readsCodeMap = (name, input = {}) =>
  (name === 'Read' && CODE_MAP.test(` ${input.file_path ?? ''}`))
  || ((name === 'Bash' || name === 'command_execution')
    && /\b(?:cat|head|tail|sed|less|bat)\b/.test(String(input.command ?? ''))
    && CODE_MAP.test(String(input.command ?? '')));

export const laneMetrics = (text) => {
  const empty = () => ({ tokens: 0, toolCalls: 0 });
  const m = {
    readCodeMap: false,
    edited: false,
    beforeFirstEdit: { tokens: 0, toolCalls: 0, contextGrowth: 0, explore: empty(), graphify: empty(), other: empty() },
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  // One step per assistant message (calls merged across its transcript lines)
  // or per Codex turn/item, in order.
  const steps = [];
  const byId = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') {
      const calls = contentBlocks(e).filter((block) => block.type === 'tool_use')
        .map((block) => ({ name: block.name, input: block.input ?? {} }));
      const id = e.message?.id;
      if (id && byId.has(id)) { byId.get(id).calls.push(...calls); continue; }
      const u = e.message?.usage ?? e.usage ?? {};
      const step = {
        calls,
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cached: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
      if (id) byId.set(id, step);
      steps.push(step);
    } else if (e.type === 'item.started' && ACTION_TYPES.has(e.item?.type)) {
      steps.push({ calls: [{ name: e.item.type, input: { command: e.item.command, file_path: e.item.path } }], input: 0, cached: 0, output: 0 });
    } else if (e.type === 'turn.completed') {
      const u = e.usage ?? {};
      steps.push({ calls: [], input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0 });
    }
  }
  let startContext = null;
  for (const { calls, input, cached, output } of steps) {
    m.inputTokens += input;
    m.cachedInputTokens += cached;
    m.outputTokens += output;
    if (calls.some((call) => readsCodeMap(call.name, call.input))) m.readCodeMap = true;
    if (m.edited) continue;
    if (calls.some((call) => EDIT_TOOLS.has(call.name) || call.name === 'file_change')) {
      m.edited = true;
      continue;
    }
    const before = m.beforeFirstEdit;
    if (input) {
      startContext ??= input;
      before.contextGrowth = input - startContext;
    }
    before.tokens += input + output;
    before[calls.length ? toolCategory(calls[0].name, calls[0].input) : 'other'].tokens += input + output;
    for (const call of calls) {
      before.toolCalls++;
      before[toolCategory(call.name, call.input)].toolCalls++;
    }
  }
  return m;
};

export const formatLane = (m) => {
  const b = m.beforeFirstEdit;
  return `  code map ${m.readCodeMap ? 'read' : 'not read'} | before first edit${m.edited ? '' : ' (no edit)'}: ${k(b.tokens)} tok billed, context +${k(b.contextGrowth)}, ${b.toolCalls} calls`
    + ` (explore ${k(b.explore.tokens)}/${b.explore.toolCalls}, graphify ${k(b.graphify.tokens)}/${b.graphify.toolCalls}, other ${k(b.other.tokens)}/${b.other.toolCalls})`
    + ` | total in ${k(m.inputTokens)} (cached ${k(m.cachedInputTokens)}), out ${k(m.outputTokens)}`;
};


if (isMainModule(import.meta.url)) {
  // Same reading as `afk`'s own flag check: `--json=1` is `--json`.
  let parsed;
  try { parsed = parseArgv(process.argv.slice(2), ['efficiency', 'json'], { command: 'stats' }); } catch (error) {
    console.log(`afk: ${error.message}`);
    process.exit(1);
  }
  const json = Boolean(parsed.flags.json);
  const wantEfficiency = json || Boolean(parsed.flags.efficiency);
  const ids = parsed.positional;
  // With no id given, "which tasks are running" is a runtime question, and
  // `.afk/state.json` is the only thing that can answer it.
  let tasks = {};
  try { tasks = JSON.parse(readFileSync('.afk/state.json', 'utf8')).tasks ?? {}; } catch {}
  const running = Object.entries(tasks).filter(([, task]) => task.lifecycle === 'running').map(([id]) => id);
  const targets = ids.length ? ids : running;
  if (!targets.length) { console.log('No task is running. Pass a task id to inspect a finished run.'); process.exit(0); }
  const reports = [];
  for (const id of targets) {
    // A path to a .jsonl (a session transcript) is read as-is; anything else
    // is a task id under .afk/runs.
    const isFile = id.endsWith('.jsonl') && existsSync(id);
    const text = isFile ? readFileSync(id, 'utf8') : readStream(id);
    if (!wantEfficiency) {
      console.log(format(id, text == null ? null : parseStream(text)));
      if (text != null) console.log(formatLane(laneMetrics(text)));
      continue;
    }
    const task = tasks[id];
    const attempts = task ? { builder: task.builderAttempt ?? 0, integration: task.integrationAttempt ?? 0 } : null;
    // A herdr lane writes no stream.jsonl; its usage is in the session
    // transcript under ~/.claude/projects, which has to be named directly.
    if (text == null) {
      const message = noStreamMessage(id);
      if (json) reports.push({ id, attempts, error: message });
      else console.log(`${id}: ${message}`);
      continue;
    }
    const report = efficiency(text);
    if (json) reports.push({ id, attempts, costWeights: COST_WEIGHTS, ...report });
    else console.log(formatEfficiency(id, report, attempts));
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
}

/** The Claude session id a stream-json transcript carries, or null. */
export const sessionIdOf = (raw) => {
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.includes('session_id')) continue;
    try {
      const id = JSON.parse(line).session_id;
      if (typeof id === 'string' && id) return id;
    } catch { /* not a JSON line */ }
  }
  return null;
};
