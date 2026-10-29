// scripts/herdr-orphan-reap.test.mjs — a retry must free its own previous
// attempt's orphaned herdr agent name before re-claiming it (issue #100).
//
// Under `runtime: herdr`, when attempt 1 fails, the agent name `afk-<task>` is
// not released — the pane's process died but the workspace lingers idle, still
// holding the name. Attempt 2's `agent start` then fails `agent_name_taken` and
// the lane is recorded failed for a reason belonging to neither the ticket nor
// attempt 1. The human workaround is `herdr workspace close <id>`, read off the
// error's candidate list (`… pane_id=w130:p1 workspace_id=w130 …`). This proves
// the runtime does that itself: reap the stale workspace, then re-claim.
//
// No live herdr: a fake `herdr` on PATH records every invocation and answers
// with the shapes runtime-herdr.mjs reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orphanFromNameTaken, reapTarget, runHerdrRole } from "./runtime-herdr.mjs";
import { roleFor } from "./roles.mjs";

// --- the pure decision ------------------------------------------------------

test("orphanFromNameTaken reads the workspace and pane the error names", () => {
  const message =
    'herdr agent start: {"error":{"code":"agent_name_taken","message":' +
    '"agent name afk-task-82-sidebar-list-and-row is already used; candidates: ' +
    'pane_id=w130:p1 workspace_id=w130 status=done"}}';
  assert.deepEqual(orphanFromNameTaken(message), { workspaceId: "w130", paneId: "w130:p1" });
});

test("orphanFromNameTaken ignores errors that are not a name collision", () => {
  assert.equal(orphanFromNameTaken('{"error":{"code":"agent_pane_busy"}}'), null);
  assert.equal(orphanFromNameTaken("herdr agent start not ready"), null);
  assert.equal(orphanFromNameTaken(undefined), null);
});

// A name collision herdr reports without a workspace to close is not reapable —
// closing nothing is right, and inventing a target is worse.
test("orphanFromNameTaken returns null when no workspace is named", () => {
  assert.equal(orphanFromNameTaken('{"error":{"code":"agent_name_taken","message":"in use"}}'), null);
});

// --- the reap guard: never close our own workspace --------------------------

const NAMED = (ws) =>
  '{"error":{"code":"agent_name_taken","message":"agent name afk-82-2 is already ' +
  `used; candidates: pane_id=${ws}:p1 workspace_id=${ws} status=done"}}`;

test("reapTarget names a foreign orphan's workspace to reap", () => {
  assert.deepEqual(reapTarget(NAMED("wSTALE"), "wLIVE"), { workspaceId: "wSTALE", paneId: "wSTALE:p1" });
});

// THE CATASTROPHIC GUARD: a collision naming our own workspace must never be
// reaped — closing it kills the lane we are starting. Without the guard this
// would return the workspace and the caller would close it out from under itself.
test("reapTarget never targets our own workspace", () => {
  assert.equal(reapTarget(NAMED("wMINE"), "wMINE"), null);
});

test("reapTarget returns null when there is nothing to reap", () => {
  assert.equal(reapTarget('{"error":{"code":"agent_pane_busy"}}', "wMINE"), null);
  assert.equal(reapTarget('{"error":{"code":"agent_name_taken","message":"in use"}}', "wMINE"), null);
});

// --- the reap-then-start sequencing -----------------------------------------

// The orphan holding the name is workspace `wSTALE`, pane `wSTALE:p1`. The fake
// fails `agent start` with `agent_name_taken` (naming wSTALE) until that
// workspace is closed; `pane rename wSTALE:p1 --clear` — the runtime's
// liveness probe — fails, marking the orphan dead. So the ONLY way to a green
// start is to close wSTALE first.
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-orphan-"));
  const worktree = join(dir, "lane");
  const bin = join(dir, "bin");
  const log = join(dir, "herdr.log");
  const reaped = join(dir, "reaped"); // written once `workspace close wSTALE` runs
  const started = join(dir, "agent-started");
  const startedPane = join(dir, "agent-pane");
  const stopped = join(dir, "agent-stopped");
  const ctrlCs = join(dir, "ctrl-c-count");
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
const reaped = ${JSON.stringify(reaped)};
const started = ${JSON.stringify(started)};
const startedPane = ${JSON.stringify(startedPane)};
const stopped = ${JSON.stringify(stopped)};
const ctrlCs = ${JSON.stringify(ctrlCs)};

if (pair === 'workspace close') {
  if (argv[2] === 'wSTALE') fs.writeFileSync(reaped, '1');
  out({ result: { type: 'ok' } });
} else if (pair === 'pane rename') {
  // The liveness probe on the dead orphan pane must fail; every other rename
  // (label updates, the reused-pane clear) succeeds.
  if (argv[2] === 'wSTALE:p1') { process.stderr.write('{"error":{"code":"pane_not_found"}}'); process.exit(1); }
  out({ result: { type: 'ok' } });
} else if (pair === 'agent prompt') {
  fs.writeFileSync(${JSON.stringify(join(worktree, ".afk-report.json"))}, JSON.stringify({ status: 'done' }));
  out({ result: { type: 'ok' } });
} else if (pair === 'worktree open') {
  out({ result: { workspace: { workspace_id: 'wT1' }, root_pane: { pane_id: 'wT1:p1' } } });
} else if (pair === 'workspace create') {
  out({ result: { workspace: { workspace_id: 'wP1' }, root_pane: { pane_id: 'wP1:p1' } } });
} else if (pair === 'agent start') {
  if (!fs.existsSync(reaped)) {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_name_taken', message: 'agent name ' + argv[2] + ' is already used; candidates: pane_id=wSTALE:p1 workspace_id=wSTALE status=done' } }));
    process.exit(1);
  }
  fs.writeFileSync(started, '1');
  fs.writeFileSync(startedPane, argv[argv.indexOf('--pane') + 1]);
  out({ result: { agent: { pid: 4242 } } });
} else if (pair === 'agent send-keys') {
  if (fs.existsSync(started) && argv[2] === fs.readFileSync(startedPane, 'utf8') && argv[3] === 'ctrl+c') {
    const count = (Number(fs.existsSync(ctrlCs) ? fs.readFileSync(ctrlCs, 'utf8') : 0) || 0) + 1;
    fs.writeFileSync(ctrlCs, String(count));
    if (count >= 2) fs.writeFileSync(stopped, '1');
  }
  out({ result: { type: 'ok' } });
} else if (pair === 'agent get') {
  if (fs.existsSync(stopped)) {
    process.stderr.write('{"error":{"code":"agent_not_found"}}');
    process.exit(1);
  }
  out({ result: { agent: { status: 'working' } } });
} else {
  out({ result: { type: 'ok' } });
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  return { dir, worktree, bin, log };
};

const calls = (fx) => readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean);

const runLane = async (fx) => {
  const previous = process.env.PATH;
  process.env.PATH = `${fx.bin}:${previous}`;
  try {
    return await runHerdrRole({
      role: roleFor("implementer"),
      root: fx.dir,
      task: { id: "82", title: "Sidebar list and rows" },
      worktree: fx.worktree,
      agent: { model: "claude-opus-5", settings: null, timeoutMs: 30_000 },
      promptPath: join(fx.dir, ".afk", "runs", "82", "builder-2", "prompt.md"),
      attempt: 2,
      say: () => {},
    });
  } finally {
    process.env.PATH = previous;
  }
};

// On HEAD (no reap): `agent start` keeps failing `agent_name_taken`, the backoff
// ladder exhausts (~30s of 2/4/8/16s sleeps) and the lane is recorded failed to
// start — for a reason belonging to a previous attempt. With the fix: the orphan
// workspace is closed and the second start succeeds. Timeout is generous so the
// red run reaches its assertion rather than tripping the test harness.
test("a retry reaps its own orphaned agent name before re-claiming it", { timeout: 90_000 }, async () => {
  const fx = fixture();
  try {
    const result = await runLane(fx);
    const list = calls(fx);

    assert.equal(result.status, 0, `the retry should recover, not die agent_name_taken:\n${list.join("\n")}`);
    assert.ok(
      list.some((call) => call === "workspace close wSTALE"),
      `the stale orphan workspace was never reaped:\n${list.join("\n")}`,
    );
    const starts = list.filter((call) => call.startsWith("agent start"));
    assert.equal(starts.length, 2, `expected one blocked start and one recovery:\n${list.join("\n")}`);
    // The reap must precede the successful re-claim, not follow it.
    const close = list.findIndex((c) => c === "workspace close wSTALE");
    const lastStart = list.lastIndexOf(starts[starts.length - 1]);
    assert.ok(close < lastStart, `the name was re-claimed before the orphan was reaped:\n${list.join("\n")}`);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
