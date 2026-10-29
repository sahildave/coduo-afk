// scripts/herdr-handshake.test.mjs — the order in which a lane is started and
// then told what to do.
//
// `herdr agent start` returns when the agent PROCESS exists, not when claude can
// read a prompt. Prompting on the next line dropped the keystrokes into a
// booting CLI: the agent sat there having been told nothing, wrote no report and
// was killed 90s later as "idle without a report" — with exit code 0, zero
// tokens and an empty log, which is indistinguishable from success to anything
// that only reads an exit code. Epic #7's lane 8 died exactly that way and took
// both its dependants with it (docs/findings.md 3.13).
//
// No live herdr: a fake `herdr` on PATH records every invocation and answers
// with the shapes runtime-herdr.mjs reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recreateParent, runHerdrRole } from "./runtime-herdr.mjs";
import { roleFor } from "./roles.mjs";

// `status` is what `herdr agent get` reports after the first prompt: "working"
// is an agent that heard us, "idle" is one that did not.
// `reportOnPrompt` is the prompt (1-based) on which the fake agent writes its
// done report; 0 means it never does, as an agent that ends on a text-only turn.
// `workingFromPrompt` (1-based, 0 = never) makes `agent wait` report the agent
// busy from that prompt on, as one that keeps working until its deadline.
const fixture = ({ status = "working", busyPanes = [], liveBusy = false, unknownBusy = false, stopOnCtrlC = true, slowOpenMs = 0, reportOnPrompt = 1, reportStatus = "done", workingFromPrompt = 0 } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-handshake-"));
  const worktree = join(dir, "lane");
  const bin = join(dir, "bin");
  const log = join(dir, "herdr.log");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(dir, ".afk"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  writeFileSync(
    join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n');
const pair = argv[0] + ' ' + argv[1];
const out = (o) => process.stdout.write(JSON.stringify(o));

// The lane's report lands only when it is actually prompted — that is the whole
// point of the handshake, so the fake models it rather than writing it at start.
const busy = ${JSON.stringify(busyPanes)};
const liveBusy = ${JSON.stringify(liveBusy)};
const unknownBusy = ${JSON.stringify(unknownBusy)};
const stopOnCtrlC = ${JSON.stringify(stopOnCtrlC)};
const startedPath = ${JSON.stringify(join(dir, "agent-started"))};
const startedPanePath = ${JSON.stringify(join(dir, "agent-pane"))};
const stoppedPath = ${JSON.stringify(join(dir, "agent-stopped"))};
const keyCountPath = ${JSON.stringify(join(dir, "agent-keys"))};
// Every open hands back a pane herdr has never handed back before, so a test
// can tell "started in a fresh pane" from "retried into the same one".
const next = (kind) => {
  const seq = ${JSON.stringify(join(dir, "seq"))} + '-' + kind;
  const n = (Number(fs.existsSync(seq) ? fs.readFileSync(seq, 'utf8').trim() : 0) || 0) + 1;
  fs.writeFileSync(seq, String(n));
  return n;
};

if (pair === 'agent prompt') {
  const prompts = next('prompt');
  // The report lands in whichever cwd the role runs in: the worktree for a
  // lane, the project root for the integrator.
  if (prompts === ${JSON.stringify(reportOnPrompt)}) for (const at of [${JSON.stringify(join(worktree, ".afk-report.json"))}, ${JSON.stringify(join(dir, ".afk-report.json"))}])
    fs.writeFileSync(at, JSON.stringify({ status: ${JSON.stringify(reportStatus)}, updatedAt: new Date().toISOString() }));
  out({ result: { type: 'ok' } });
} else if (pair === 'worktree open') {
  // A lane that will not answer: the fake blocks here so a test can prove the
  // rebuild does not wait on it. The pid goes on disk so the test can reap this
  // process once it has its answer, rather than the suite waiting out the sleep.
  const slow = ${JSON.stringify(slowOpenMs)};
  if (slow) {
    fs.writeFileSync(${JSON.stringify(join(dir, "slow.pid"))}, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow);
  }
  const n = next('T');
  out({ result: { workspace: { workspace_id: 'wT' + n }, root_pane: { pane_id: 'wT' + n + ':p1' } } });
} else if (pair === 'workspace create') {
  const n = next('P');
  out({ result: { workspace: { workspace_id: 'wP' + n }, root_pane: { pane_id: 'wP' + n + ':p1' } } });
} else if (pair === 'agent start') {
  const pane = argv[argv.indexOf('--pane') + 1];
  if (busy.includes(pane)) {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_pane_busy', message: 'agent target pane ' + pane + ' is not an available shell' } }));
    process.exit(1);
  }
  fs.writeFileSync(startedPath, '1');
  fs.writeFileSync(startedPanePath, argv[argv.indexOf('--pane') + 1]);
  out({ result: { agent: { pid: 4242 } } });
} else if (pair === 'agent send-keys') {
  if (stopOnCtrlC && fs.existsSync(startedPath) && argv[2] === fs.readFileSync(startedPanePath, 'utf8') && argv[3] === 'ctrl+c') {
    const count = (Number(fs.existsSync(keyCountPath) ? fs.readFileSync(keyCountPath, 'utf8') : 0) || 0) + 1;
    fs.writeFileSync(keyCountPath, String(count));
    if (count >= (stopOnCtrlC === true ? 2 : stopOnCtrlC)) fs.writeFileSync(stoppedPath, '1');
  }
  out({ result: { type: 'ok' } });
} else if (pair === 'agent get') {
  if (stopOnCtrlC && fs.existsSync(stoppedPath)) {
    process.stderr.write('{"error":{"code":"agent_not_found"}}');
    process.exit(1);
  }
  if (busy.includes(argv[2]) && unknownBusy) {
    process.stderr.write('server disconnected');
    process.exit(1);
  }
  if (busy.includes(argv[2]) && !liveBusy) {
    process.stderr.write('{"error":{"code":"agent_not_found"}}');
    process.exit(1);
  }
  out({ result: { agent: { status: ${JSON.stringify(status)} } } });
} else if (pair === 'agent wait' && ${JSON.stringify(workingFromPrompt)}) {
  const seq = ${JSON.stringify(join(dir, "seq"))} + '-prompt';
  const sent = Number(fs.existsSync(seq) ? fs.readFileSync(seq, 'utf8').trim() : 0) || 0;
  out({ result: { agent: { status: sent >= ${JSON.stringify(workingFromPrompt)} ? 'working' : 'idle' } } });
} else {
  out({ result: { type: 'ok' } });
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  return { dir, worktree, bin, log };
};

// The real record, not a stub: it carries the permission profile the preflight
// renders, and a stub that drifts from it would test nothing.
const ROLE = roleFor("implementer");
// A lane that is allowed to reach its report, so a recovery test can assert the
// whole run survives rather than only that the calls were made.
const DONE_AGENT = { model: "claude-opus-5", settings: null, timeoutMs: 30_000 };
const CODEX_AGENT = {
  backend: "codex",
  command: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  sandbox: "workspace-write",
  approvalPolicy: "never",
  timeoutMs: 30_000,
};

const calls = (fx) => readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean);
const indexOf = (list, prefix) => list.findIndex((call) => call.startsWith(prefix));

// `timeoutMs` is the completion deadline; the order-of-calls tests do not need
// the poll loop to run at all, so they leave it unset.
const runLane = async (fx, role = ROLE, agent = { model: "claude-opus-5", settings: null }, extra = {}) => {
  const previous = process.env.PATH;
  process.env.PATH = `${fx.bin}:${previous}`;
  try {
    return await runHerdrRole({
      role,
      root: fx.dir,
      task: { id: "8", title: "Map the docs" },
      worktree: fx.worktree,
      agent,
      promptPath: join(fx.dir, ".afk", "runs", "8", "builder-1", "prompt.md"),
      attempt: 1,
      say: () => {},
      ...extra,
    });
  } finally {
    process.env.PATH = previous;
  }
};

test("a lane waits until its agent can hear it before sending the prompt", async () => {
  const fx = fixture();
  await runLane(fx);
  const list = calls(fx);

  const start = indexOf(list, "agent start");
  const waitIdle = list.findIndex((call) => call.startsWith("agent wait") && call.includes("idle"));
  const prompt = indexOf(list, "agent prompt");

  assert.ok(start >= 0, `no agent start:\n${list.join("\n")}`);
  assert.ok(waitIdle > start, `no readiness wait after start:\n${list.join("\n")}`);
  assert.ok(prompt > waitIdle, `the prompt was sent before the readiness wait:\n${list.join("\n")}`);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("the prompt is confirmed to have landed, and not sent twice when it did", async () => {
  const fx = fixture({ status: "working" });
  await runLane(fx);
  const list = calls(fx);

  const prompt = indexOf(list, "agent prompt");
  const confirm = list.findIndex(
    (call, i) => i > prompt && call.startsWith("agent wait") && call.includes("working"),
  );
  assert.ok(confirm > prompt, `the prompt was never confirmed:\n${list.join("\n")}`);
  assert.equal(
    list.filter((call) => call.startsWith("agent prompt")).length,
    1,
    `an agent that picked up its prompt must not be prompted again:\n${list.join("\n")}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });
});

test("a Codex implementer is a real interactive Herdr agent in its lane worktree", async () => {
  const fx = fixture({ stopOnCtrlC: true });
  const result = await runLane(fx, ROLE, CODEX_AGENT);
  const list = calls(fx);
  const start = list.find((call) => call.startsWith("agent start"));

  assert.match(start, /--kind codex/);
  assert.match(start, /--model gpt-5\.6-luna/);
  assert.match(start, /model_reasoning_effort=max/);
  assert.match(start, /--sandbox workspace-write/);
  assert.ok(start.includes(`--cd ${fx.worktree}`), start);
  assert.doesNotMatch(start, /dangerously-skip-permissions|--settings|append-system-prompt|permission-prompt-tool/);
  assert.ok(list.some((call) => call.startsWith("agent prompt")), list.join("\n"));
  assert.ok(list.some((call) => /report\.mjs --status working --phase/.test(call)), list.join("\n"));
  assert.ok(list.some((call) => /report\.mjs --status done/.test(call)), list.join("\n"));
  assert.equal(result.status, 0);
  assert.equal(result.report?.status, "done");
  assert.equal("tokens" in result, false, "missing Codex telemetry stays unknown");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("a live busy pane is never replaced by a second agent", async () => {
  const fx = fixture({ busyPanes: ["wT1:p1"], liveBusy: true });
  const result = await runLane(fx, ROLE, DONE_AGENT);
  const starts = calls(fx).filter((call) => call.startsWith("agent start"));
  assert.equal(starts.length, 1, calls(fx).join("\n"));
  assert.equal(result.status, 1);
  assert.equal(result.agentStillRunning, true, "a prior live writer must block worker reset");
  assert.match(result.paneOutput ?? "", /^$/);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("an unknown busy pane remains unsafe to retry", async () => {
  const fx = fixture({ busyPanes: ["wT1:p1"], unknownBusy: true });
  try {
    const result = await runLane(fx, ROLE, DONE_AGENT);
    assert.equal(result.status, 1);
    assert.equal(result.agentStillRunning, true, "unproven liveness must block reset");
    assert.equal(calls(fx).filter((call) => call.startsWith("agent start")).length, 1);
    assert.equal(calls(fx).some((call) => call.startsWith("workspace close")), false);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("a timed-out lane stops its agent before the result can be retried", async () => {
  const fx = fixture({ stopOnCtrlC: true, reportOnPrompt: 0, workingFromPrompt: 1 });
  const result = await runLane(fx, ROLE, { ...DONE_AGENT, timeoutMs: 250 });
  const list = calls(fx);
  assert.equal(result.timedOut, true, list.join("\n"));
  assert.equal(result.agentStillRunning, undefined, list.join("\n"));
  assert.equal(list.filter((call) => call.startsWith("agent start")).length, 1);
  assert.equal(list.filter((call) => call.startsWith("agent send-keys")).length, 4);
  rmSync(fx.dir, { recursive: true, force: true });
});

// #295 live run: a Claude agent still running a command when the lane ends
// spends the first Ctrl-C interrupting that command and the second only arms
// "press again to exit". It is still running after one pair, so one pair and a
// 5 s wait halted the epic with "agent is still running" on a lane that was done.
test("an agent that needs a second pair of interrupts is still proven stopped", async () => {
  const fx = fixture({ stopOnCtrlC: 3, reportOnPrompt: 1 });
  try {
    const result = await runLane(fx, ROLE, DONE_AGENT);
    const list = calls(fx);
    assert.equal(result.agentStillRunning, undefined, list.join("\n"));
    assert.equal(result.status, 0, list.join("\n"));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("an unproven stop leaves the live agent's pane unsafe to retry", async () => {
  const fx = fixture({ stopOnCtrlC: false, reportOnPrompt: 0 });
  const result = await runLane(fx, ROLE, { ...DONE_AGENT, timeoutMs: 250 });
  const list = calls(fx);
  const start = list.find((call) => call.startsWith("agent start"));
  const pane = start?.match(/--pane (\S+)/)?.[1];
  const interrupts = list.filter((call) => call.startsWith("agent send-keys"));

  assert.equal(result.status, 1, list.join("\n"));
  assert.equal(result.agentStillRunning, true, list.join("\n"));
  assert.equal(list.filter((call) => call.startsWith("agent start")).length, 1, list.join("\n"));
  assert.ok(pane, `agent start did not name a pane:\n${list.join("\n")}`);
  assert.ok(interrupts.length >= 4, `expected pane preparation and stop signals:\n${list.join("\n")}`);
  assert.ok(
    interrupts.every((call) => call.startsWith(`agent send-keys ${pane} ctrl+c`)),
    `stop signals escaped the recorded lane pane:\n${list.join("\n")}`,
  );
  assert.equal(list.includes("workspace close wT1"), false, `a live agent's workspace was closed:\n${list.join("\n")}`);
  rmSync(fx.dir, { recursive: true, force: true });
});

// #292 closeout: the stop check came with the Codex port (#293). A Claude lane
// whose report says done returned status 0 on main whatever its pane did next,
// and still must; only a Codex lane halts on an unproven stop.
test("a Claude lane that reports done stays done when its stop cannot be proven", async () => {
  const fx = fixture({ stopOnCtrlC: false, reportOnPrompt: 1 });
  try {
    const result = await runLane(fx, ROLE, DONE_AGENT);
    const list = calls(fx);
    assert.equal(result.status, 0, list.join("\n"));
    assert.equal(result.agentStillRunning, undefined, list.join("\n"));
    assert.equal(result.report?.status, "done");
    assert.ok(list.some((call) => call.startsWith("agent send-keys")), `the stop was still attempted:\n${list.join("\n")}`);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("a Codex lane that reports done but cannot be proven stopped is unsafe to retry", async () => {
  const fx = fixture({ stopOnCtrlC: false, reportOnPrompt: 1 });
  try {
    const result = await runLane(fx, ROLE, CODEX_AGENT);
    const list = calls(fx);
    assert.equal(result.status, 1, list.join("\n"));
    assert.equal(result.agentStillRunning, true, list.join("\n"));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("a failed report stays failed and is handed to worker verification", async () => {
  const fx = fixture({ reportStatus: "failed", stopOnCtrlC: true });
  const result = await runLane(fx, ROLE, DONE_AGENT);
  assert.equal(result.status, 1);
  assert.equal(result.report?.status, "failed");
  rmSync(fx.dir, { recursive: true, force: true });
});

// A pane held by an agent that outlived the orchestrator that started it never
// frees itself, so the boot-race backoff just failed slower — four retries, ~30s,
// then a zero-token lane failure that the supervisor reads as a shared infra
// cause and trips the circuit breaker on. Both incidents in issue #18 killed an
// epic that way, one of them with six tasks that had never started.
test("a lane whose pane is held by a stale agent moves to a fresh one", async () => {
  const fx = fixture({ busyPanes: ["wT1:p1"] });
  const result = await runLane(fx, ROLE, DONE_AGENT);
  const list = calls(fx);

  assert.equal(result.status, 0, `the lane should survive a busy pane:\n${list.join("\n")}`);
  assert.ok(
    list.some((call) => call.startsWith("workspace close wT1")),
    `the busy lane workspace was never given up:\n${list.join("\n")}`,
  );
  const starts = list.filter((call) => call.startsWith("agent start"));
  assert.equal(starts.length, 2, `expected one failed start and one recovery:\n${list.join("\n")}`);
  assert.ok(starts[1].includes("--pane wT2:p1"), `the retry reused the busy pane: ${starts[1]}`);
  rmSync(fx.dir, { recursive: true, force: true });
});

// The integrator's pane is pinned to the one main checkout, so it has no
// alternate worktree to retry into: before this, a busy pane there took the
// whole epic down (auto-closed incomplete) rather than one merge.
test("the integrator rebuilds its parent workspace when that pane is held", async () => {
  const fx = fixture({ busyPanes: ["wP1:p1"] });
  const result = await runLane(fx, roleFor("integrator"), DONE_AGENT);
  const list = calls(fx);

  assert.equal(result.status, 0, `the integrator should survive a busy pane:\n${list.join("\n")}`);
  assert.ok(
    list.some((call) => call.startsWith("workspace close wP1")),
    `the busy parent workspace was never given up:\n${list.join("\n")}`,
  );
  const starts = list.filter((call) => call.startsWith("agent start"));
  assert.equal(starts.length, 2, `expected one failed start and one recovery:\n${list.join("\n")}`);
  assert.ok(starts[1].includes("--pane wP2:p1"), `the retry reused the busy pane: ${starts[1]}`);
  rmSync(fx.dir, { recursive: true, force: true });
});

// Epic #27's lane 37: `parent workspace <id> rebuilt for the integrator` was
// followed one line later by `lane 37 agent process died`. The lane workspaces
// are grouped under the parent, so giving the parent up reaped a builder that
// had already written its files and spent 12k output tokens — for a reason with
// nothing to do with its ticket. Two such deaths tripped the circuit breaker on
// a ticket that then passed in three minutes, untouched.
const parentFixture = (options = {}) => {
  const fx = fixture(options);
  writeFileSync(
    join(fx.dir, ".afk", "herdr.json"),
    JSON.stringify({
      parentWorkspaceId: "wP1",
      parentPaneId: "wP1:p1",
      tasks: { 8: { workspaceId: "wT1", paneId: "wT1:p1", worktree: fx.worktree, label: "#8 · Map the docs" } },
    }),
  );
  return fx;
};

const rebuildParent = async (fx, options) => {
  const previous = process.env.PATH;
  process.env.PATH = `${fx.bin}:${previous}`;
  try {
    return await recreateParent(fx.dir, () => {}, options);
  } finally {
    process.env.PATH = previous;
  }
};

test("a parent rebuild does not reap a lane whose pane is live", async () => {
  const fx = parentFixture();
  await rebuildParent(fx);
  const list = calls(fx);

  const readopt = list.findIndex(
    (call) => call.startsWith("worktree open") && call.includes(fx.worktree),
  );
  const close = indexOf(list, "workspace close wP1");
  assert.ok(readopt >= 0, `the live lane was never re-adopted:\n${list.join("\n")}`);
  assert.ok(
    close === -1 || close > readopt,
    `the parent was closed on top of a live lane:\n${list.join("\n")}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });
});

// The degradation is rebuild-and-re-adopt, never wait-forever: a wedged lane
// plus a wedged parent must not deadlock integration, which is the worse error.
test("a wedged lane does not deadlock the parent rebuild", { timeout: 8_000 }, async () => {
  // Longer than this test can possibly take: a rebuild that waits on the lane
  // fails on the test timeout, and only a bounded one gets to the assertions.
  const fx = parentFixture({ slowOpenMs: 120_000 });
  await rebuildParent(fx, { rescueMs: 200 });
  const list = calls(fx);
  try { process.kill(Number(readFileSync(join(fx.dir, "slow.pid"), "utf8"))); } catch {}

  assert.ok(
    list.some((call) => call.startsWith("worktree open") && call.includes(fx.worktree)),
    `the rebuild never tried to re-adopt the lane:\n${list.join("\n")}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });
});

// Opus 5.5 ends some turns with a progress note and no tool call. The pane goes
// idle, no report arrives, and the lane used to be handed to the verifier as
// finished with half its checklist open. The checklist is the implementer's own
// record of what is left, so the runner reads it and sends the agent back.
const checklistLane = async ({ reportOnPrompt, checklist, workingFromPrompt = 0, agent = DONE_AGENT, idleUnreportedMs = 0 }) => {
  const fx = fixture({ reportOnPrompt, workingFromPrompt, stopOnCtrlC: true });
  const checklistPath = join(fx.dir, "checklist.md");
  writeFileSync(checklistPath, checklist);
  const result = await runLane(fx, ROLE, agent, { checklistPath, idleUnreportedMs });
  const prompts = calls(fx).filter((call) => call.startsWith("agent prompt"));
  rmSync(fx.dir, { recursive: true, force: true });
  return { result, prompts };
};

const OPEN = "- [x] Resolve\n- [x] Implement\n- [ ] Test\n- [ ] Self-check\n- [ ] Report\n";

test("an idle lane with open checklist items is sent back to them", async () => {
  const { result, prompts } = await checklistLane({ reportOnPrompt: 2, checklist: OPEN });
  assert.equal(prompts.length, 2, prompts.join("\n"));
  assert.match(prompts[1], /Your checklist still has open items: Test; Self-check\. Continue with them\. If one is blocked, say what is blocking it\./);
  assert.equal(result.status, 0);
});

test("continuations stop at two, then the lane goes to the verifier as before", async () => {
  const { result, prompts } = await checklistLane({ reportOnPrompt: 0, checklist: OPEN });
  assert.equal(prompts.length, 3, `one prompt and two continuations:\n${prompts.join("\n")}`);
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
});

test("an idle lane whose checklist is all ticked is not continued", async () => {
  const { prompts } = await checklistLane({ reportOnPrompt: 0, checklist: "- [x] Test\n- [X] Report\n" });
  assert.equal(prompts.length, 1, prompts.join("\n"));
});

// The terminal phase is ticked by reporting, which is the text a healthy lane
// ends on. An open `Report` alone is a finished lane, not an unfinished one.
test("a lane whose only open item is the Report phase is not continued", async () => {
  const { prompts, result } = await checklistLane({ reportOnPrompt: 0, checklist: "- [x] Test\n- [x] Self-check\n- [ ] Report\n" });
  assert.equal(prompts.length, 1, prompts.join("\n"));
  assert.equal(result.status, 0);
});

// A continuation must never make the outcome worse than not sending it: the
// old idle path handed the lane on as status 0, so running out the deadline
// after a continuation does too.
test("a continued lane that runs out its deadline is handed on as it was before", async () => {
  const { result, prompts } = await checklistLane({
    reportOnPrompt: 0, checklist: OPEN, workingFromPrompt: 2,
    agent: { ...DONE_AGENT, timeoutMs: 4_000 },
  });
  assert.equal(prompts.length, 2, prompts.join("\n"));
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
});

test("a lane with too little budget left is not continued", async () => {
  // Floor is min(5 min, a quarter of the budget) = 3s. Idle fires 9s into the
  // poll loop, which starts a second or so after the clock: under 3s left, and
  // still before the 12s deadline so the handoff path is the one exercised.
  const { result, prompts } = await checklistLane({
    reportOnPrompt: 0, checklist: OPEN, idleUnreportedMs: 9_000,
    agent: { ...DONE_AGENT, timeoutMs: 12_000 },
  });
  assert.equal(prompts.length, 1, prompts.join("\n"));
  assert.equal(result.status, 0);
});
