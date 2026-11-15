// scripts/ask-autoclose.test.mjs — `afk cos checkin` closes an ask whose epic
// finished: an `answer` event marked `auto`, which the hub already reads as closed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

// A temp machine with a fake gh whose PR state is `prState`, and one peer run (sticky-notes #33).
const machine = (prState) => {
  const home = mkdtempSync(join(tmpdir(), "afk-autoclose-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: [
    "Running `afk cos` (any subcommand) is allowed.", "Running `afk cos stop` is allowed.", "Running `afk land` is allowed.",
  ] } }));
  const bin = (name, body) => writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  bin("launchctl", "true");
  bin("herdr", `echo '{"result":{"agents":[]}}'`);
  bin("gh", `echo '{"number":36,"state":"${prState}","url":"u","statusCheckRollup":[]}'`);
  bin("vercel-deploys-left", "echo 7");
  bin("terminal-notifier", "true");
  const env = {
    ...process.env, HOME: home, AFK_COS_ROOT: join(home, "cos"), AFK_GATE_LOCK_DIR: join(home, "gate-lock"),
    AFK_COS_PEERS: join(home, "peers.json"), PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  const root = join(home, "runs", "sticky-notes");
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ dag: { epic: "33", branch: "feat/33", tasks: [{ id: "1" }] }, tasks: { 1: { lifecycle: "running" } } }));
  writeFileSync(env.AFK_COS_PEERS, JSON.stringify([{ ok: true, root, port: null, project: "sticky-notes", epic: "33", branch: "feat/33", status: "no dashboard" }]));
  const cos = (...args) => spawnSync(process.execPath, [afk, "cos", ...args], { env, encoding: "utf8" });
  assert.equal(cos("start", "--mode=night").status, 0);
  const runs = readdirSync(env.AFK_COS_ROOT).filter((n) => existsSync(join(env.AFK_COS_ROOT, n, "run.json")));
  const file = join(env.AFK_COS_ROOT, runs.sort().at(-1), "events.jsonl");
  const events = () => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // Asks are written as events, with the `epic` field the ask verb records.
  const ask = (id, epic) => appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), kind: "ask", id, title: `Q ${id}`, why: "", options: [], rec: null, from: "orch-33", ...(epic ? { epic } : {}) })}\n`);
  return { env, cos, events, ask };
};

const answersFor = (m, id) => m.events().filter((e) => e.kind === "answer" && e.id === id);

test("a merged PR closes the ask that names its epic, and checkin says so", () => {
  const m = machine("MERGED");
  m.ask("q-merged", { project: "sticky-notes", epic: "33" });
  const r = m.cos("checkin");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /closed cos:q-merged: epic sticky-notes#33 merged \(PR #36\)/);
  const [a] = answersFor(m, "q-merged");
  assert.equal(a.auto, "epic merged");
});

test("an open PR leaves the ask open", () => {
  const m = machine("OPEN");
  m.ask("q-open", { project: "sticky-notes", epic: "33" });
  assert.equal(m.cos("checkin").status, 0);
  assert.equal(answersFor(m, "q-open").length, 0);
});

test("an ask with no epic is untouched, even when every epic is merged", () => {
  const m = machine("MERGED");
  m.ask("q-plain", null);
  assert.equal(m.cos("checkin").status, 0);
  assert.equal(answersFor(m, "q-plain").length, 0);
});

test("a second check-in appends no second close", () => {
  const m = machine("MERGED");
  m.ask("q-twice", { project: "sticky-notes", epic: "33" });
  m.cos("checkin");
  const second = m.cos("checkin");
  assert.doesNotMatch(second.stdout, /closed cos:/);
  assert.equal(answersFor(m, "q-twice").length, 1);
});

test("a closed ask no longer shows in the hub's open questions", async () => {
  const m = machine("MERGED");
  m.ask("q-hub", { project: "sticky-notes", epic: "33" });
  const { hubView } = await import("./hub/page.mjs");
  assert.deepEqual((await hubView(m.env)).waiting.map((q) => q.id), ["q-hub"], "precondition: open before the check-in");
  m.cos("checkin");
  assert.deepEqual((await hubView(m.env)).waiting.map((q) => q.id), []);
});
