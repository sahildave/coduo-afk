// scripts/cos-epic-refs.test.mjs — `afk cos ask --epic` and `start owner/repo#n`
// store normalised epic refs. Temp HOME and AFK_COS_ROOT, fake launchctl.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));
const ALLOW_ALL = [
  "Running `afk cos` (any subcommand) is allowed.",
  "Running `afk cos stop` is allowed.",
  "Running `afk land` is allowed.",
];

// A hub stand-in answering 200 on /favicon.ico, in this process.
const fakeHub = async () => {
  const server = createServer((req, res) => { res.writeHead(req.url === "/favicon.ico" ? 200 : 404); res.end(); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
};

const machine = (hubUrl) => {
  const home = mkdtempSync(join(tmpdir(), "afk-cos-gates-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: ALLOW_ALL } }));
  writeFileSync(join(home, "bin", "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(home, "peers.json"), "[]");
  const env = {
    ...process.env,
    HOME: home,
    AFK_COS_ROOT: join(home, "cos"),
    AFK_GATE_LOCK_DIR: join(home, "gate-lock"),
    AFK_COS_PEERS: join(home, "peers.json"),
    AFK_HUB_URL: hubUrl,
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  // Async spawn: the fake hub lives in this process and must keep answering.
  const sh = (args) => new Promise((done) => {
    const child = spawn(process.execPath, [afk, ...args], { env, cwd: home });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (status) => done({ status, stdout }));
  });
  const runDir = () => {
    const runs = readdirSync(env.AFK_COS_ROOT).filter((n) => existsSync(join(env.AFK_COS_ROOT, n, "run.json")));
    return join(env.AFK_COS_ROOT, runs.sort().at(-1));
  };
  return {
    env, runDir,
    cos: (...args) => sh(["cos", ...args]),
    events: () => readFileSync(join(runDir(), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    meta: () => JSON.parse(readFileSync(join(runDir(), "run.json"), "utf8")),
  };
};

test("start stores epicRefs for owner/repo#n, project#n and bare n; epics stays as given", async () => {
  const hub = await fakeHub();
  try {
    const m = machine(hub.url);
    const start = await m.cos("start", "--mode=day", "coduo/gitback#510", "shareling#72", "99");
    assert.equal(start.status, 0, start.stdout);
    const meta = m.meta();
    assert.deepEqual(meta.epics, ["coduo/gitback#510", "shareling#72", "99"]);
    assert.deepEqual(meta.epicRefs, [
      { project: "gitback", epic: "510" },
      { project: "shareling", epic: "72" },
      { project: null, epic: "99" },
    ]);
  } finally { await hub.close(); }
});

test("ask --epic normalises the three forms and stores epic on the ask event", async () => {
  const hub = await fakeHub();
  try {
    const m = machine(hub.url);
    assert.equal((await m.cos("start", "--mode=day")).status, 0);
    const forms = [["a", "coduo/gitback#510", { project: "gitback", epic: "510" }],
      ["b", "gitback#511", { project: "gitback", epic: "511" }],
      ["c", "512", { project: null, epic: "512" }]];
    for (const [id, value] of forms) {
      const r = await m.cos("ask", `--id=${id}`, "--title=Q?", "--option=y|Yes", "--option=n|No", `--epic=${value}`);
      assert.equal(r.status, 0, r.stdout);
    }
    const asks = m.events().filter((e) => e.kind === "ask");
    assert.deepEqual(asks.map((e) => e.epic), forms.map((f) => f[2]));
    const none = await m.cos("ask", "--id=d", "--title=Q?", "--option=y|Yes", "--option=n|No");
    assert.equal(none.status, 0);
    assert.equal(m.events().find((e) => e.id === "d").epic, undefined);
  } finally { await hub.close(); }
});

test("ask with a malformed --epic is refused and stores nothing", async () => {
  const hub = await fakeHub();
  try {
    const m = machine(hub.url);
    assert.equal((await m.cos("start", "--mode=day")).status, 0);
    for (const bad of ["gitback#", "#5", "abc", "a/b/c#1", "gitback#x"]) {
      const r = await m.cos("ask", "--id=z", "--title=Q?", "--option=y|Yes", "--option=n|No", `--epic=${bad}`);
      assert.equal(r.status, 1, `${bad}: ${r.stdout}`);
      assert.match(r.stdout, /COS: ask: --epic=.* is not an epic/);
    }
    assert.equal(m.events().some((e) => e.kind === "ask"), false);
  } finally { await hub.close(); }
});
