// scripts/dashboard-launcher.test.mjs — `./dashboard` opens the dashboard on
// its own port (PORT, else the port derived from the caller's cwd), replaces a
// stale server from another checkout there, and never touches the hub port.
// Every test points AFK_HUB_PORT at a free port, so no run of this file (old
// launcher or new) can reach the real hub on 4099.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./free-port.mjs";
import { derivedDashboardPort } from "./dashboard-process.mjs";

const repo = resolve(fileURLToPath(import.meta.url), "../..");
const server = `import { createServer } from "node:http"; createServer((q, r) => r.end("ok")).listen(Number(process.argv[2]), () => console.log("up"));`;

const listening = (child) => new Promise((ok) => child.stdout.once("data", ok));
const exited = async (child) => child.exitCode != null || child.signalCode != null
  || await new Promise((ok) => { child.once("exit", () => ok(true)); setTimeout(() => ok(false), 2000); });

const bindable = (port) => new Promise((ok) => {
  const probe = createServer();
  probe.once("error", () => ok(false));
  probe.listen(port, () => probe.close(() => ok(true)));
});

// A checkout dir holding the launcher, the real dashboard-process.mjs it asks
// for the derived port, and a stub server that reports the PORT it was given.
// The fake `open` records the URL it was asked to open.
const checkout = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const co = join(dir, "co");
  mkdirSync(join(co, "scripts"), { recursive: true });
  copyFileSync(join(repo, "dashboard"), join(co, "dashboard"));
  copyFileSync(join(repo, "scripts", "dashboard-process.mjs"), join(co, "scripts", "dashboard-process.mjs"));
  writeFileSync(join(co, "scripts", "dashboard-server.mjs"), `console.log("started mine; PORT=" + process.env.PORT);`);
  writeFileSync(join(dir, "listener.mjs"), server);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const opened = join(dir, "opened");
  writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$1" >> "${opened}"\n`);
  chmodSync(join(bin, "open"), 0o755);
  return { dir, co, bin, opened };
};

const launch = ({ co, bin }, { cwd, env }) => {
  const { PORT: _ignored, ...base } = process.env;
  return spawnSync("sh", [join(co, "dashboard")], { cwd, env: { ...base, ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 15_000 });
};

test("./dashboard leaves the hub port alone and opens the dashboard's derived port", async (t) => {
  const c = checkout(t);
  // A caller dir whose derived port is free, so the launcher cannot touch a real dashboard.
  let cwd; let derived;
  for (let i = 0; i < 20; i++) {
    cwd = realpathSync(mkdtempSync(join(c.dir, "caller-")));
    derived = derivedDashboardPort(cwd);
    if (await bindable(derived)) break;
  }
  const hubPort = await freePort();
  const hub = spawn("node", [join(c.dir, "listener.mjs"), String(hubPort)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => hub.kill());
  await listening(hub);

  const run = launch(c, { cwd, env: { AFK_HUB_PORT: String(hubPort) } });
  const url = `http://127.0.0.1:${derived}/lanes.html`;
  assert.match(run.stdout, new RegExp(`AFK lanes: ${url}`));
  assert.match(run.stdout, new RegExp(`started mine; PORT=${derived}\\b`));
  assert.equal(readFileSync(c.opened, "utf8").trim(), url);
  assert.ok(hub.exitCode == null && hub.signalCode == null, "the listener on the hub port survives ./dashboard");
});

test("./dashboard stops another checkout's server on its own port and starts its own", async (t) => {
  const c = checkout(t);
  const port = await freePort();
  const stale = spawn("node", [join(c.dir, "listener.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => stale.kill());
  await listening(stale);

  const run = launch(c, { cwd: c.co, env: { PORT: String(port), AFK_HUB_PORT: String(await freePort()) } });
  assert.match(run.stdout, new RegExp(`AFK lanes: http://127.0.0.1:${port}/lanes.html`));
  assert.match(run.stdout, new RegExp(`started mine; PORT=${port}\\b`));
  assert.ok(await exited(stale), "the other checkout's server was stopped");
});

test("./dashboard reuses this checkout's server on its own port", async (t) => {
  const c = checkout(t);
  writeFileSync(join(c.co, "scripts", "dashboard-server.mjs"), server);
  const port = await freePort();
  const live = spawn("node", [join(c.co, "scripts", "dashboard-server.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => live.kill());
  await listening(live);
  const run = launch(c, { cwd: c.co, env: { PORT: String(port), AFK_HUB_PORT: String(await freePort()) } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, new RegExp(`AFK lanes: http://127.0.0.1:${port}/lanes.html`));
  assert.equal(readFileSync(c.opened, "utf8").trim(), `http://127.0.0.1:${port}/lanes.html`);
  assert.equal(live.exitCode, null, "this checkout's server keeps running");
});
