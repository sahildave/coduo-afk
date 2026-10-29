// scripts/permission-broker.test.mjs — the runner-owned permission endpoint
// (incident #53). No test here spawns a real agent, opens a socket, or reaches a
// human surface: the ruling is a pure function, the timeout is driven by an
// injected answer channel, and the argv is asserted as data.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ESCALATION_TIMEOUT_MS,
  PERMISSION_BROKER_SERVER,
  PERMISSION_BROKER_TOOL,
  PERMISSION_BROKER_TOOL_NAME,
  actionSubjects,
  brokerDecide,
  brokerRuling,
  brokerToolResult,
  handleRpc,
  permissionBrokerArgs,
} from "./permission-broker.mjs";
import { laneAgentStartArgs } from "./runtime-herdr.mjs";

// The incident's own example, rendered the way a lane prompt would carry it:
// the ticket REQUIRES a fail-first demonstration that reverts a manifest.
const SANCTIONING_TICKET = [
  "## Acceptance criteria",
  "Every fix must fail first. To demonstrate it, revert package.json to its",
  "prior state and show the test red before your change, then restore it.",
  "Do not modify any lockfile.",
].join("\n");

test("a broker request the ticket sanctions is APPROVED", () => {
  const request = { tool_name: "Bash", input: { command: "git checkout -- package.json" } };
  const ruling = brokerRuling({ request, ticketText: SANCTIONING_TICKET });
  assert.equal(ruling.behavior, "allow", ruling.reason);
  assert.ok(ruling.matched.includes("package.json"));
});

test("a broker request with NO sanction is REFUSED", () => {
  // Same ticket, a different action the ticket never blesses.
  const request = { tool_name: "Bash", input: { command: "rm -rf ~/Library/Application/Secrets.plist" } };
  const ruling = brokerRuling({ request, ticketText: SANCTIONING_TICKET });
  assert.equal(ruling.behavior, "deny", "an unsanctioned action must not be approved");
  assert.deepEqual(ruling.matched, []);
});

test("a prohibition in the ticket vetoes a sanction on the same subject", () => {
  // The ticket names package-lock.json only to forbid it; "revert" elsewhere
  // must not reach across to bless it.
  const ticket = "Revert your change to show it red. Do not modify package-lock.json under any circumstance.";
  const request = { tool_name: "Bash", input: { command: "git checkout -- package-lock.json" } };
  assert.equal(brokerRuling({ request, ticketText: ticket }).behavior, "deny");
});

test("an action with no path subject is unrulable, and therefore denied", () => {
  const request = { tool_name: "Bash", input: { command: "curl https://evil.example" } };
  const ruling = brokerRuling({ request, ticketText: SANCTIONING_TICKET });
  assert.equal(ruling.behavior, "deny");
});

test("actionSubjects extracts path-like tokens from the tool input", () => {
  assert.deepEqual(
    actionSubjects({ tool_name: "Write", input: { file_path: "src/foo.ts", content: "x" } }).sort(),
    ["src/foo.ts"],
  );
});

test("an unanswered escalation resolves as a plain denial within the timeout, not a hang", async () => {
  const request = { tool_name: "Bash", input: { command: "rm -rf /Users/x/Data" } };
  // An answer channel that NEVER answers — the human is asleep. The broker must
  // still return, on its own timeout, as a denial.
  const neverAnswers = () => new Promise(() => {});
  // Test-side watchdog: if the broker fails to time out, this fires first and
  // fails the test loudly rather than letting it hang the suite.
  const watchdog = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("broker HUNG: it never resolved the escalation")), 2_000).unref(),
  );
  const decision = await Promise.race([
    brokerDecide({ request, ticketText: SANCTIONING_TICKET, timeoutMs: 40, waitForAnswer: neverAnswers }),
    watchdog,
  ]);
  assert.equal(decision.behavior, "deny");
  assert.equal(decision.resolution, "timeout");
  // Nothing reads a failed-attempt flag, and telling the lane its attempt
  // failed invites it to report failure over one refused tool call (#53).
  assert.equal("failedAttempt" in decision, false);
  assert.doesNotMatch(decision.message, /failed attempt/i);
  assert.match(decision.message, /proceed another way/i);
});

test("a sanctioned action is decided immediately, without parking", async () => {
  const request = { tool_name: "Bash", input: { command: "git checkout -- package.json" } };
  const started = Date.now();
  const decision = await brokerDecide({
    request,
    ticketText: SANCTIONING_TICKET,
    timeoutMs: 10_000, // long park; a ruled action must not wait on it
  });
  assert.equal(decision.behavior, "allow");
  assert.equal(decision.resolution, "ruled");
  assert.ok(Date.now() - started < 1_000, "an approved action must not park");
});

test("an in-time answer wins over the timeout", async () => {
  const request = { tool_name: "Bash", input: { command: "rm -rf /Users/x/Data" } };
  const decision = await brokerDecide({
    request,
    ticketText: SANCTIONING_TICKET,
    timeoutMs: 5_000,
    waitForAnswer: async () => ({ behavior: "allow", message: "operator said yes" }),
  });
  assert.equal(decision.behavior, "allow");
  assert.equal(decision.resolution, "answered");
});

test("the constructed lane argv includes the --permission-prompt-tool wiring", () => {
  const broker = permissionBrokerArgs({
    promptPath: "/w/lane/.afk-prompt.md",
    taskId: 61,
    runnerDir: "/runner",
  });
  const argv = laneAgentStartArgs({
    name: "afk-61-1",
    pane: "pane_1",
    agent: { model: "claude-fable-5", settings: '{"permissions":{"deny":["Write"]}}', reasoningEffort: "high" },
    broker,
    launchDir: mkdtempSync(join(tmpdir(), "afk-broker-argv-")),
  });
  // The lane runs at the role's effort, as the direct runtime's `--effort` does.
  // Without it a herdr lane silently ran at the CLI default.
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  const i = argv.indexOf("--permission-prompt-tool");
  assert.ok(i !== -1, "lane argv must carry --permission-prompt-tool");
  assert.equal(argv[i + 1], PERMISSION_BROKER_TOOL);
  // The broker is additive, not a replacement: the deny-rule settings survive.
  assert.ok(argv.includes("--settings"));
  assert.ok(argv.includes("--dangerously-skip-permissions"));
  // --strict-mcp-config: the broker is the lane's ONLY MCP server. The
  // operator's own servers cost every lane tool definitions and no lane used
  // them; the broker survives because it is named by --mcp-config.
  assert.ok(argv.includes("--strict-mcp-config"));
  // The mcp-config points the server at the broker script with context on env.
  // It rides a file, not the typed line (#161).
  const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
  const server = mcp.mcpServers[PERMISSION_BROKER_SERVER];
  assert.match(server.args[0], /permission-broker\.mjs$/);
  assert.equal(server.env.AFK_BROKER_TICKET, "/w/lane/.afk-prompt.md");
  assert.equal(server.env.AFK_BROKER_TASK, "61");
  // The decision log sits beside the prompt, in the attempt's run directory,
  // where worker.mjs reads it into verification.json.
  assert.equal(server.env.AFK_BROKER_LOG, "/w/lane/broker.jsonl");
});

test("the tool name is derived from the server name", () => {
  assert.equal(PERMISSION_BROKER_TOOL, `mcp__${PERMISSION_BROKER_SERVER}__${PERMISSION_BROKER_TOOL_NAME}`);
  assert.equal(ESCALATION_TIMEOUT_MS, 120_000);
});

test("brokerToolResult renders the Claude permission-prompt-tool contract", () => {
  const req = { tool_name: "Bash", input: { command: "git checkout -- package.json" } };
  assert.deepEqual(brokerToolResult({ behavior: "allow" }, req), {
    behavior: "allow",
    updatedInput: { command: "git checkout -- package.json" },
  });
  assert.deepEqual(brokerToolResult({ behavior: "deny", message: "no" }, req), {
    behavior: "deny",
    message: "no",
  });
});

test("the MCP server adapter answers tools/call from the ticket text", async () => {
  const listed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools[0].name, PERMISSION_BROKER_TOOL_NAME);

  const call = await handleRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: PERMISSION_BROKER_TOOL_NAME,
        arguments: { tool_name: "Bash", input: { command: "git checkout -- package.json" } },
      },
    },
    { ticketText: SANCTIONING_TICKET, timeoutMs: 50 },
  );
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.behavior, "allow");

  // A notification (no id) gets no response.
  assert.equal(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

// The real server process, driven over stdio with its env set the way
// `permissionBrokerArgs` sets it: one JSON line per tools/call must land in
// AFK_BROKER_LOG, or no denial can ever be observed after the run.
test("the served broker appends one decision line per tools/call to AFK_BROKER_LOG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-broker-log-"));
  const ticket = join(dir, "prompt.md");
  const log = join(dir, "broker.jsonl");
  writeFileSync(ticket, SANCTIONING_TICKET);
  const script = join(dirname(fileURLToPath(import.meta.url)), "permission-broker.mjs");
  const child = spawn(process.execPath, [script, "--serve"], {
    env: { ...process.env, AFK_BROKER_TICKET: ticket, AFK_BROKER_TASK: "61", AFK_BROKER_LOG: log, AFK_BROKER_TIMEOUT_MS: "30" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = [];
  let buffered = "";
  const gotTwo = new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("broker did not answer both calls")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
      if (replies.length >= 2) { clearTimeout(watchdog); resolve(); }
    });
  });
  const call = (id, args) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: PERMISSION_BROKER_TOOL_NAME, arguments: args } })}\n`);
  call(1, { tool_name: "Bash", input: { command: "git checkout -- package.json" } });
  call(2, { tool_name: "Write", input: { file_path: "src/secret.ts", content: "x" } });
  try {
    await gotTwo;
  } finally {
    child.kill();
  }
  const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(entries.length, 2);
  const byBehavior = Object.fromEntries(entries.map((e) => [e.behavior, e]));
  assert.equal(byBehavior.allow.task, "61");
  assert.equal(byBehavior.allow.tool_name, "Bash");
  assert.deepEqual(byBehavior.allow.subjects, ["package.json"]);
  assert.deepEqual(byBehavior.allow.matched, ["package.json"]);
  assert.equal(byBehavior.allow.resolution, "ruled");
  assert.deepEqual(byBehavior.deny.subjects, ["src/secret.ts"]);
  assert.equal(byBehavior.deny.resolution, "timeout");
  assert.match(byBehavior.deny.reason, /no ticket sentence sanctions src\/secret\.ts/);
  assert.ok(byBehavior.deny.ts, "each entry is timestamped");
});

test("an unwritable decision log never breaks the ruling", async () => {
  const call = await handleRpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: PERMISSION_BROKER_TOOL_NAME, arguments: { tool_name: "Bash", input: { command: "git checkout -- package.json" } } },
    },
    { ticketText: SANCTIONING_TICKET, timeoutMs: 50, logPath: "/nonexistent-dir/for/sure/broker.jsonl", taskId: "61" },
  );
  assert.equal(JSON.parse(call.result.content[0].text).behavior, "allow");
});
