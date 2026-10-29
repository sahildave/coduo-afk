// The permission broker (incident #53).
//
// Lanes run the desktop app's binary, whose safety classifier sits ABOVE the
// CLI permission system: `--dangerously-skip-permissions` does not reach it, and
// with Remote Control paired those escalations land on the human's PHONE
// mid-run. The owner's ruling: "they should ask the orchestrator."
//
// So the lane is given a `--permission-prompt-tool` that points here instead of
// at a human surface. When the classifier wants approval, the CLI calls this
// broker's one MCP tool. The broker answers from the runner's own context — the
// lane's rendered prompt file (which carries the ticket text and the cross-lane
// ledger notes) and the task id:
//
//   - APPROVE what the ticket text sanctions. The incident's own example is a
//     fail-first manifest-revert demonstration the ticket itself REQUIRED: the
//     lane reverts a manifest to prove a test was red before the fix, the
//     classifier escalates, and the broker approves because the ticket asked
//     for exactly that.
//   - REFUSE everything it cannot rule on. No answer channel exists (#66 was
//     closed), so an escalation with no ticket sanction waits out the timeout
//     and DENIES — a lane must never hang on a human surface until morning. A denial is one
//     refused tool call, nothing more: the attempt is not failed, and the lane
//     is told to proceed another way or report why the ticket needs the action.
//     Only the supervisor's existing wake-human path may ever reach a phone.
//
// Every ruling is appended to a decision log (`AFK_BROKER_LOG`, `broker.jsonl`
// in the attempt's run directory), which worker.mjs folds into
// verification.json and the wave digest names per lane. Without it a denial
// happens and leaves no trace.
//
// The module is deliberately shaped to be unit-testable without a live server:
// `brokerRuling` is a pure function of (request, ticket text), `brokerDecide`
// layers the park-then-timeout on top with an injectable answer channel, and
// `permissionBrokerArgs` builds the argv fragment the herdr runtime appends. The
// stdio MCP server in `serve()` is a thin adapter over those three, plus the
// decision-log append in `handleRpc` — no network listener; it speaks
// newline-delimited JSON-RPC over stdin/stdout.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainModule } from "./lib.mjs";

// The MCP server name and the fully-qualified tool name the CLI is pointed at.
// Claude Code addresses an MCP tool as `mcp__<server>__<tool>`, so these two
// must stay in lock-step — a test asserts the tool name is derived from the
// server name for exactly that reason.
export const PERMISSION_BROKER_SERVER = "afk-broker";
export const PERMISSION_BROKER_TOOL_NAME = "permission_prompt";
export const PERMISSION_BROKER_TOOL = `mcp__${PERMISSION_BROKER_SERVER}__${PERMISSION_BROKER_TOOL_NAME}`;

// How long an unrulable escalation parks before it times out into a denial. Two
// minutes is "briefly" against an overnight run and nowhere near "until
// morning"; a project may shorten it via AFK_BROKER_TIMEOUT_MS. It is bounded on
// purpose: the whole point of the incident is that a lane must resolve its own
// escalation rather than wait on a sleeping human.
export const ESCALATION_TIMEOUT_MS = 120_000;

// The decision log's file name inside an attempt's run directory.
export const BROKER_LOG_FILE = "broker.jsonl";

// A sentence in the ticket sanctions an action only if it carries one of these
// cues. Default-deny is the safety property: the broker approves a narrow,
// evidence-backed set and refuses the rest, so a cue list that is too small
// only ever fails safe (a legitimate action is refused and retried), never
// unsafe (an unsanctioned action approved).
const SANCTION_CUES =
  /(revert|restore|undo|reinstate|demonstrat|fail-first|fail first|red before|red then green|manifest-revert|must fail|to prove|show (?:the |it |that )?(?:test|failure|red|fail))/;

// Prohibition cues veto a sanction even when the subject matches: a ticket that
// says "do not touch package.json" must never be read as sanctioning a write to
// it because a later sentence happens to say "revert". Checked per-sentence, so
// only the sentence that names the subject can veto it.
const PROHIBITION_CUES = /(do not|don't|never|must not|forbidden|prohibited|may not)/;

// The concrete things an action touches, as lower-cased path-like tokens: file
// names with an extension (`package.json`, `afk.mjs`) and slash-bearing paths
// (`src/foo.ts`, `~/Library/x`). These are what a ticket sentence can plausibly
// name; a bare verb like `rm` is not a subject and cannot be matched, which is
// why an action with no path subject is unrulable and therefore denied.
export const actionSubjects = (request = {}) => {
  const parts = [String(request.tool_name ?? "")];
  const walk = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(request.input ?? {});
  const haystack = parts.join(" ").toLowerCase();
  const found = haystack.match(/[~.\w-]*\/[~./\w-]+|\b[\w-]+\.[a-z0-9]+\b/g) ?? [];
  // Drop tokens too short or too generic to identify anything (a bare `.md`).
  return [...new Set(found.map((t) => t.trim()).filter((t) => t.length >= 4))];
};

const allow = (matched) => ({
  behavior: "allow",
  reason: `approved: the ticket text sanctions this action (${matched.join(", ")})`,
  matched,
});
const deny = (reason) => ({ behavior: "deny", reason, matched: [] });

/**
 * Pure ruling: does the ticket text sanction this action?
 *
 * @param {object}  args
 * @param {object}  args.request    the CLI's permission payload: { tool_name, input }
 * @param {string}  args.ticketText the lane's rendered prompt (ticket body + ledger notes)
 * @returns {{behavior:'allow'|'deny', reason:string, matched:string[]}}
 */
export const brokerRuling = ({ request = {}, ticketText = "" } = {}) => {
  const subjects = actionSubjects(request);
  if (!subjects.length) return deny("no file or path subject the ticket could sanction");
  const corpus = String(ticketText ?? "").toLowerCase();
  if (!corpus.trim()) return deny("no ticket text to rule against");
  // Sentence boundaries are coarse on purpose: the sanction and its subject must
  // co-occur closely, so a boundary keeps "revert" from reaching across
  // paragraphs to bless an unrelated file. The split is on newlines, `;`, and
  // sentence-ending punctuation FOLLOWED BY SPACE — never a bare `.`, or
  // `package.json` would be torn into `package` and `json` and never match.
  const sentences = corpus.split(/[\n;]+|[.!?]\s+/);
  const matched = [];
  for (const subject of subjects) {
    const naming = sentences.filter((s) => s.includes(subject));
    if (!naming.length) continue;
    if (naming.some((s) => PROHIBITION_CUES.test(s))) continue; // vetoed
    if (naming.some((s) => SANCTION_CUES.test(s))) matched.push(subject);
  }
  return matched.length ? allow(matched) : deny(`no ticket sentence sanctions ${subjects.join(", ")}`);
};

const TIMEOUT = Symbol("broker-timeout");

/**
 * The ruling plus the park-then-timeout the incident demands.
 *
 * A sanctioned action is approved immediately. Anything else waits out
 * `timeoutMs` and resolves as a plain denial. No answer channel is wired (#66
 * was closed; the supervisor's wake-human path is the only thing that reaches a
 * human), so in production the timeout is always what decides. `waitForAnswer`
 * exists only so tests can prove the timeout wins. It never hangs: the timeout
 * always fires.
 *
 * @param {object}   args
 * @param {object}   args.request
 * @param {string}   args.ticketText
 * @param {number}   [args.timeoutMs]
 * @param {Function} [args.waitForAnswer] injectable answer channel returning a
 *   Promise<{behavior, message}|null>; used by tests to prove the timeout wins
 *   over a channel that never answers.
 */
export const brokerDecide = async ({
  request = {},
  ticketText = "",
  timeoutMs = ESCALATION_TIMEOUT_MS,
  waitForAnswer = null,
} = {}) => {
  const ruling = brokerRuling({ request, ticketText });
  if (ruling.behavior === "allow") {
    return { behavior: "allow", message: ruling.reason, resolution: "ruled", matched: ruling.matched };
  }
  let timer;
  // The timer is NOT unref'd: it is the whole point of this call that it fires,
  // and an unref'd timer can be skipped if the loop has nothing else pending —
  // which would turn "times out into a denial" back into the hang it replaces.
  const parked = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  let answer = TIMEOUT;
  try {
    answer = await Promise.race([
      waitForAnswer ? Promise.resolve().then(() => waitForAnswer()) : parked,
      parked,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (answer && answer !== TIMEOUT) {
    return {
      behavior: answer.behavior === "allow" ? "allow" : "deny",
      message: answer.message ?? null,
      resolution: "answered",
    };
  }
  return {
    behavior: "deny",
    message:
      "No ticket sanction for this action, so it is denied. "
      + "Proceed another way, or report why the ticket needs it.",
    resolution: "timeout",
    reason: ruling.reason,
  };
};

/**
 * The decision rendered to the exact object Claude Code's permission-prompt-tool
 * contract expects: `{behavior:'allow', updatedInput}` or `{behavior:'deny',
 * message}`. The input is passed through unchanged on allow — the broker rules
 * on whether the action may proceed, it does not rewrite it.
 */
export const brokerToolResult = (decision, request = {}) =>
  decision.behavior === "allow"
    ? { behavior: "allow", updatedInput: request.input ?? {} }
    : { behavior: "deny", message: decision.message ?? "denied by the afk permission broker" };

/**
 * The argv fragment the herdr runtime appends to a lane's `claude` invocation so
 * its classifier escalations reach this broker instead of a human. Additive: it
 * does not replace the role's deny-rule `--settings`. The lane runs with
 * `--strict-mcp-config` (runtime-herdr.mjs `laneAgentStartArgs`), so this
 * `--mcp-config` is the only MCP server it loads.
 *
 * Context reaches the server process out-of-band, through env, so nothing
 * sensitive rides on a command line: `AFK_BROKER_TICKET` is the path to the
 * lane's rendered prompt file (ticket body + ledger), which the server reads
 * when it must rule. `AFK_BROKER_LOG` is `broker.jsonl` beside that prompt —
 * the attempt's run directory, where worker.mjs reads it back.
 */
export const permissionBrokerArgs = ({
  promptPath,
  taskId,
  runnerDir,
  brokerPath = null,
  node = "node",
  timeoutMs = null,
} = {}) => {
  const serverPath = brokerPath ?? join(runnerDir, "scripts", "permission-broker.mjs");
  const mcpConfig = {
    mcpServers: {
      [PERMISSION_BROKER_SERVER]: {
        command: node,
        args: [serverPath, "--serve"],
        env: {
          AFK_BROKER_TICKET: promptPath ?? "",
          AFK_BROKER_TASK: String(taskId ?? ""),
          AFK_BROKER_LOG: promptPath ? join(dirname(promptPath), BROKER_LOG_FILE) : "",
          ...(timeoutMs ? { AFK_BROKER_TIMEOUT_MS: String(timeoutMs) } : {}),
        },
      },
    },
  };
  return ["--permission-prompt-tool", PERMISSION_BROKER_TOOL, "--mcp-config", JSON.stringify(mcpConfig)];
};

// ---------------------------------------------------------------------------
// The stdio MCP server. A thin adapter over the three functions above; it holds
// no logic of its own so the tests exercise the logic directly. Newline-
// delimited JSON-RPC 2.0 over stdin/stdout, which is the MCP stdio transport —
// no network socket is ever opened.
// ---------------------------------------------------------------------------

const readTicketText = () => {
  const path = process.env.AFK_BROKER_TICKET;
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const serverTimeoutMs = () => {
  const raw = Number(process.env.AFK_BROKER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ESCALATION_TIMEOUT_MS;
};

const TOOL_SCHEMA = {
  name: PERMISSION_BROKER_TOOL_NAME,
  description:
    "Runner-owned permission broker. Rules on a lane's classifier escalation from the "
    + "ticket text: approves what the ticket sanctions, denies what it cannot rule on.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
    },
  },
};

// One line per ruling. A log that cannot be written must never change the
// ruling, so every write error is swallowed.
const logDecision = (logPath, entry) => {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch { /* the ruling stands whether or not it was recorded */ }
};

export const handleRpc = async (message, { ticketText, timeoutMs, logPath = null, taskId = null } = {}) => {
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: PERMISSION_BROKER_SERVER, version: "1.0.0" },
      });
    case "tools/list":
      return reply({ tools: [TOOL_SCHEMA] });
    case "tools/call": {
      const request = params?.arguments ?? {};
      const decision = await brokerDecide({ request, ticketText, timeoutMs });
      logDecision(logPath, {
        ts: new Date().toISOString(),
        task: taskId,
        tool_name: request.tool_name ?? null,
        subjects: actionSubjects(request),
        behavior: decision.behavior,
        resolution: decision.resolution,
        reason: decision.reason ?? decision.message ?? null,
        matched: decision.matched ?? [],
      });
      return reply({
        content: [{ type: "text", text: JSON.stringify(brokerToolResult(decision, request)) }],
      });
    }
    default:
      // Notifications (no id) get no response; unknown requests get an error.
      if (id === undefined || id === null) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
};

export const serve = () => {
  const ticketText = readTicketText();
  const timeoutMs = serverTimeoutMs();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // a partial or non-JSON line is not ours to answer
    }
    const response = await handleRpc(message, {
      ticketText,
      timeoutMs,
      logPath: process.env.AFK_BROKER_LOG || null,
      taskId: process.env.AFK_BROKER_TASK || null,
    });
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
};

if (isMainModule(import.meta.url) && process.argv.includes("--serve")) {
  serve();
}
