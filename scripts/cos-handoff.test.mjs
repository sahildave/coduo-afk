// scripts/cos-handoff.test.mjs — the derived handoff (#229). A fixture store,
// fixture checkouts and a fixture `/peers` list; the handoff must name every
// pointer a fresh session needs, as literal values, and nothing it would have
// to search for. Fakes for herdr on PATH; no real store, session or dashboard.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./cos-handoff.mjs", import.meta.url));
const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const fixture = async ({ openRun = true, finished = false, queue = true, register = true } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "afk-handoff-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  const orchestrators = join(home, ".afk-claude", "orchestrators");
  mkdirSync(orchestrators, { recursive: true });
  writeFileSync(join(orchestrators, "orch-226.settings.json"), "{}");
  const projects = join(home, ".claude", "projects", "-fixture");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "sess-orch-226.jsonl"), "{}\n");
  const when = (Date.now() - 4 * 60_000) / 1000;
  utimesSync(join(projects, "sess-orch-226.jsonl"), when, when);
  writeFileSync(join(home, "bin", "herdr"), `#!/bin/sh
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"orch-226","agent_status":"idle","agent_session":{"value":"sess-orch-226"}}]}}';;
  *) echo '{}';;
esac
`, { mode: 0o755 });
  // Two epic checkouts. 226 has a gate open and a git head; 300 is on a deploy cap.
  const repo = (name, epic, state) => {
    const root = join(home, "repos", name);
    mkdirSync(join(root, ".afk"), { recursive: true });
    git(root, "init", "-q", "-b", `feat/${epic}`);
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fixture");
    writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ dag: { epic, branch: `feat/${epic}`, tasks: state.tasks }, tasks: state.lifecycles, ...(finished ? { epicClose: { lifecycle: "closed" } } : {}) }));
    return root;
  };
  const rootA = repo("alpha", 226, {
    tasks: [{ id: 227, dependsOn: [] }, { id: 229, dependsOn: [227], humanGated: true }],
    lifecycles: { 227: { lifecycle: "passed" }, 229: { lifecycle: "awaiting_acceptance" } },
  });
  const rootB = repo("beta", 300, { tasks: [{ id: 301, dependsOn: [] }], lifecycles: { 301: { lifecycle: "running" } } });
  const env = {
    ...process.env,
    HOME: home,
    AFK_COS_ROOT: join(home, "cos"),
    AFK_COS_PEERS: join(home, "peers.json"),
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  writeFileSync(env.AFK_COS_PEERS, JSON.stringify([
    { ok: true, root: rootA, port: 4123, project: "alpha", epic: 226, branch: "feat/226", status: "running", progress: { total: 2, passed: 1 } },
    { ok: true, root: rootB, port: 4188, project: "beta", epic: 300, branch: "feat/300", status: "running", progress: { total: 1, passed: 0 } },
  ]));
  const { appendEvent, createRun } = await import("./cos/store.mjs");
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
  sleeper.unref();
  let run = null;
  if (openRun) {
    run = createRun({ root: env.AFK_COS_ROOT, mode: "night", epics: ["226", "300"] });
    appendEvent(run.dir, "decision", { text: "salvage 548, the lane is past its budget" });
    if (register) appendEvent(run.dir, "process", { pid: sleeper.pid, startedMs: Date.now(), owner: "chief of staff", purpose: "watch PR 12 checks", ttlMin: 30, cmd: ["sleep", "300"], log: "/tmp/x.log" });
    appendEvent(run.dir, "checkin", {
      run: run.id,
      runs: [
        { root: rootA, port: 4123, epic: "226", gates: ["229"], pr: { number: 12, state: "OPEN", url: "https://github.com/o/r/pull/12" }, deploy: "green", stalled: false, finished },
        { root: rootB, port: 4188, epic: "300", gates: [], pr: { number: 13, state: "OPEN", url: "https://github.com/o/r/pull/13" }, deploy: "deploy_cap", stalled: false, finished },
      ],
      deploysLeft: 0,
      triggers: [],
      notified: [],
    });
  }
  // A queued comment for orch-226, written through the hub's inbox.
  const { queueComment } = await import("./hub/inbox.mjs");
  const queued = queue && queueComment({ target: "orch-226", anchor: { run: "alpha#226", field: "gates" }, text: "accept 229 only after the smoke test" }, env);
  const handoff = (args, input) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", input });
  return { home, env, run, rootA, rootB, sleeper, queued, handoff, headA: git(rootA, "rev-parse", "HEAD"), headB: git(rootB, "rev-parse", "HEAD") };
};

test("afk cos handoff from a fixture store prints every listed pointer and no Grep-dependent prose", async (t) => {
  const f = await fixture();
  t.after(() => { try { process.kill(f.sleeper.pid); } catch { /* gone */ } });
  const r = f.handoff(["cos"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  // The run.
  assert.match(out, new RegExp(`Run: ${f.run.id}`));
  // Per epic: Orchestrator, dashboard port, state.json path, PR, head, Vercel.
  assert.match(out, /## Epic #226/);
  assert.match(out, /Orchestrator: orch-226 \(warm 4m\)/);
  assert.match(out, /Dashboard: http:\/\/127\.0\.0\.1:4123/);
  assert.ok(out.includes(`State: ${join(f.rootA, ".afk", "state.json")}`), out);
  assert.match(out, /PR: #12 https:\/\/github\.com\/o\/r\/pull\/12 \(OPEN\)/);
  assert.ok(out.includes(`Head: ${f.headA} (feat/226)`), out);
  assert.match(out, /Vercel: green/);
  assert.match(out, /## Epic #300/);
  assert.match(out, /Orchestrator: orch-300 \(no session\)/);
  assert.match(out, /Dashboard: http:\/\/127\.0\.0\.1:4188/);
  assert.ok(out.includes(`Head: ${f.headB} (feat/300)`), out);
  assert.match(out, /Vercel: deploy_cap/);
  // Open gates.
  assert.match(out, /Open gates: 229/);
  // Pending relays, with the commands that read and acknowledge them.
  assert.ok(out.includes(f.queued.id), out);
  assert.match(out, /afk hub queue orch-226/);
  assert.ok(out.includes(`afk hub ack orch-226 ${f.queued.id}`), out);
  // The events tail and the register.
  assert.match(out, /decision: salvage 548/);
  assert.ok(out.includes(`pid ${f.sleeper.pid} alive`), out);
  assert.match(out, /watch PR 12 checks/);
  // One next action per epic.
  assert.equal(out.match(/^- Next: /gm)?.length, 2, out);
  assert.match(out, /Next: read `afk hub queue orch-226` first/);
  assert.match(out, /Next: .*deploy cap/i);
  // Pointers, not instructions to go looking.
  assert.doesNotMatch(out, /\bgrep\b|\bsearch\b|look (for|up|through)|find (the|out)|explore/i);
  // Written to the store, and a handoff event names the file.
  const handoffs = join(f.run.dir, "handoffs");
  const files = readdirSync(handoffs);
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(handoffs, files[0]), "utf8"), out.slice(out.indexOf("# Handoff")).replace(/\nHANDOFF: .*\n?$/, "\n"));
  const events = readFileSync(join(f.run.dir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const event = events.find((e) => e.kind === "handoff");
  assert.equal(event?.session, "cos");
  assert.equal(event?.path, join(handoffs, files[0]));
});

test("handoff notes are capped at about 2k tokens", async (t) => {
  const f = await fixture();
  t.after(() => { try { process.kill(f.sleeper.pid); } catch { /* gone */ } });
  const notes = join(f.home, "notes.md");
  writeFileSync(notes, "The owner prefers the salvage over a rebuild.\n");
  const ok = f.handoff(["cos", `--notes-file=${notes}`]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /## Notes\n\nThe owner prefers the salvage/);
  writeFileSync(notes, "x".repeat(8_001));
  const tooLong = f.handoff(["cos", `--notes-file=${notes}`]);
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stdout, /notes are 8001 characters; the cap is 8000/);
});

// The Stop hook: Claude Code hands it {session_id, transcript_path} on stdin.
const transcriptAt = (home, tokens) => {
  const path = join(home, `t-${tokens}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 10, cache_read_input_tokens: tokens - 1_010, cache_creation_input_tokens: 1_000, output_tokens: 50 } } }),
  ].join("\n"));
  return JSON.stringify({ session_id: "s-1", transcript_path: path, hook_event_name: "Stop" });
};

test("the end-of-turn handoff is written only at 150k context or more, and only with work open", async (t) => {
  const f = await fixture();
  t.after(() => { try { process.kill(f.sleeper.pid); } catch { /* gone */ } });
  const handoffs = join(f.run.dir, "handoffs");
  const below = f.handoff(["--auto", "cos"], transcriptAt(f.home, 149_999));
  assert.equal(below.status, 0, below.stdout + below.stderr);
  assert.match(below.stdout, /HANDOFF: skipped, context 149999 tokens is under 150000/);
  assert.ok(!existsSync(handoffs));
  const at = f.handoff(["--auto", "cos"], transcriptAt(f.home, 150_000));
  assert.equal(at.status, 0, at.stdout + at.stderr);
  assert.match(at.stdout, /HANDOFF: wrote /);
  assert.equal(readdirSync(handoffs).length, 1);

  const done = await fixture({ finished: true });
  t.after(() => { try { process.kill(done.sleeper.pid); } catch { /* gone */ } });
  // Finished epics, but a queued comment is still open work: written.
  assert.match(done.handoff(["--auto", "cos"], transcriptAt(done.home, 200_000)).stdout, /HANDOFF: wrote /);

  const idle = await fixture({ finished: true, queue: false, register: false });
  t.after(() => { try { process.kill(idle.sleeper.pid); } catch { /* gone */ } });
  const idleRun = idle.handoff(["--auto", "cos"], transcriptAt(idle.home, 200_000));
  assert.match(idleRun.stdout, /HANDOFF: skipped, no open work/);
  assert.ok(!existsSync(join(idle.run.dir, "handoffs")));

  const none = await fixture({ openRun: false });
  t.after(() => { try { process.kill(none.sleeper.pid); } catch { /* gone */ } });
  const skipped = none.handoff(["--auto", "cos"], transcriptAt(none.home, 200_000));
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /HANDOFF: skipped, no afk cos run is open/);
});

// The same handoff through the operator's command, `afk cos handoff`: afk.mjs
// checks the flags, scripts/cos.mjs routes the verb, and both flags arrive.
test("`afk cos handoff` routes to the derived handoff with its flags", async (t) => {
  const f = await fixture();
  t.after(() => { try { process.kill(f.sleeper.pid); } catch { /* gone */ } });
  const viaAfk = (args, input) => spawnSync(process.execPath, [afk, "cos", "handoff", ...args], { env: f.env, encoding: "utf8", input, timeout: 30_000 });
  const notes = join(f.home, "notes.md");
  writeFileSync(notes, "The owner prefers the salvage over a rebuild.\n");
  const r = viaAfk(["cos", `--notes-file=${notes}`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`Run: ${f.run.id}`));
  assert.match(r.stdout, /Orchestrator: orch-226 \(warm 4m\)/);
  assert.match(r.stdout, /Dashboard: http:\/\/127\.0\.0\.1:4123/);
  assert.ok(r.stdout.includes(`State: ${join(f.rootA, ".afk", "state.json")}`), r.stdout);
  assert.ok(r.stdout.includes(`Head: ${f.headA} (feat/226)`), r.stdout);
  assert.match(r.stdout, /Open gates: 229/);
  assert.ok(r.stdout.includes(`afk hub ack orch-226 ${f.queued.id}`), r.stdout);
  assert.ok(r.stdout.includes(`pid ${f.sleeper.pid} alive`), r.stdout);
  assert.match(r.stdout, /## Notes\n\nThe owner prefers the salvage/);
  assert.match(r.stdout, /HANDOFF: wrote /);
  // The space form of --notes-file carries the notes too.
  const spaced = viaAfk(["cos", "--notes-file", notes]);
  assert.equal(spaced.status, 0, spaced.stdout + spaced.stderr);
  assert.match(spaced.stdout, /## Notes\n\nThe owner prefers the salvage/);
  assert.match(spaced.stdout, /HANDOFF: wrote .*\/cos-/);
  // The Stop-hook form: --auto, with the hook's JSON on stdin.
  const auto = viaAfk(["--auto", "cos"], transcriptAt(f.home, 149_999));
  assert.equal(auto.status, 0, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /HANDOFF: skipped, context 149999 tokens is under 150000/);
});
