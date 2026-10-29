// scripts/orchestrator-herdr.test.mjs — the argv that starts an Orchestrator in
// a herdr pane (#208). Nothing here talks to herdr or a model.
import test from "node:test";
import assert from "node:assert/strict";
import { orchestratorStartArgs, ORCHESTRATOR_SETTINGS } from "./orchestrator-herdr.mjs";

const args = orchestratorStartArgs({ name: "orch-208", pane: "w1:p1", model: "opus", settingsPath: "/x/s.json" });
const claudeArgv = args.slice(args.indexOf("--") + 1);

test("starts a full interactive claude under herdr, in the given pane", () => {
  assert.deepEqual(args.slice(0, 6), ["agent", "start", "orch-208", "--kind", "claude", "--pane"]);
  assert.equal(args[6], "w1:p1");
});

test("the session is named and on Remote Control, so it shows in Desktop", () => {
  assert.equal(claudeArgv[claudeArgv.indexOf("--name") + 1], "orch-208");
  assert.equal(claudeArgv[claudeArgv.indexOf("--remote-control") + 1], "orch-208");
});

test("permissions come from the Orchestrator profile, never skip-permissions", () => {
  assert.ok(!claudeArgv.includes("--dangerously-skip-permissions"));
  assert.equal(claudeArgv[claudeArgv.indexOf("--permission-mode") + 1], "auto");
  assert.equal(claudeArgv[claudeArgv.indexOf("--settings") + 1], "/x/s.json");
  assert.equal(claudeArgv[claudeArgv.indexOf("--model") + 1], "opus");
});

test("the profile lets it run afk and start its own herdr lanes", () => {
  const allow = ORCHESTRATOR_SETTINGS.permissions.allow;
  for (const rule of ["Bash(afk:*)", "Bash(herdr:*)"]) assert.ok(allow.includes(rule), rule);
});

test("runs main when invoked through a symlinked path (macOS /tmp)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const link = join(mkdtempSync(join(tmpdir(), "orch-")), "scripts");
  symlinkSync(new URL(".", import.meta.url).pathname, link);
  // No <name>: main must run and fail with the usage error, not exit 0 silently.
  assert.throws(
    () => execFileSync(process.execPath, [join(link, "orchestrator-herdr.mjs")], { stdio: "pipe" }),
    (err) => err.status === 1 && /usage: orchestrator-herdr\.mjs/.test(err.stderr.toString()),
  );
});

// A fake `herdr` on PATH that logs each call, so main's ordering is testable.
const runWithFakeHerdr = async (argv, env = {}) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = env.FAKE_HOME ?? mkdtempSync(join(tmpdir(), "fake-herdr-"));
  if (env.FAKE_OWNER) {
    mkdirSync(join(dir, ".afk-claude", "orchestrators"), { recursive: true });
    writeFileSync(join(dir, ".afk-claude", "orchestrators", "owner-settings.json"), env.FAKE_OWNER);
  }
  if (env.FAKE_TRANSCRIPT_AGE_MIN) {
    const proj = join(dir, ".claude", "projects", "-x");
    mkdirSync(proj, { recursive: true });
    const t = join(proj, "sess-1.jsonl");
    writeFileSync(t, "{}\n");
    const when = (Date.now() - Number(env.FAKE_TRANSCRIPT_AGE_MIN) * 60_000) / 1000;
    utimesSync(t, when, when);
  }
  // The chief of staff's store lives in this temp home; an open run is opened
  // through the store module, as `afk cos start` would leave it.
  const cosRoot = join(dir, "cos");
  if (env.FAKE_OPEN_RUN) {
    const { createRun } = await import("./cos/store.mjs");
    createRun({ root: cosRoot, mode: "day", epics: [] });
  }
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "agent get") case "$FAKE_GET" in
    missing) echo '{"error":{"code":"agent_not_found"}}'; exit 1;;
    down) echo 'connect: connection refused' >&2; exit 1;;
    *) echo '{}';; esac;;
  "agent list") echo '{"result":{"agents":[{"name":"o","workspace_id":"w9","agent_status":"idle","agent_session":{"value":"sess-1"}}]}}';;
  "agent read") printf '  done.\\r\\n\\342\\235\\257\\302\\240\\033[0m\\033[2mgo with salvage\\033[0m\\r\\n';;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"w1:p1"},"workspace":{"workspace_id":"w1"}}}';;
  "agent wait") [ "$FAKE_WAIT" = fail ] && { echo timeout >&2; exit 1; }; echo '{}';;
  *) echo '{}';;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "launch.md"), "go");
  const res = spawnSync(process.execPath, [new URL("./orchestrator-herdr.mjs", import.meta.url).pathname, ...argv.map((a) => a.replace("$DIR", dir))], {
    env: { ...process.env, ...env, HOME: dir, AFK_COS_ROOT: cosRoot, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8",
  });
  return { ...res, home: dir, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
};

test("restart with a bad --prompt-file leaves the running Orchestrator alone", async () => {
  for (const extra of [[], ["--prompt-file", "$DIR/missing.md"]]) {
    const r = await runWithFakeHerdr(["restart", "o", "--cwd", "$DIR", ...extra]);
    assert.equal(r.status, 1);
    assert.ok(!/workspace close/.test(r.calls), r.calls);
  }
});

test("stop fails loudly when herdr itself fails, instead of 'no agent named'", async () => {
  const r = await runWithFakeHerdr(["stop", "o"], { FAKE_GET: "down" });
  assert.equal(r.status, 1, r.stdout);
  const gone = await runWithFakeHerdr(["stop", "o"], { FAKE_GET: "missing" });
  assert.equal(gone.status, 0);
  assert.match(gone.stdout, /no agent named o/);
});

test("start never sends the launch line to a claude that did not reach idle, and closes its workspace", async () => {
  const r = await runWithFakeHerdr(["start", "o", "--cwd", "$DIR", "--prompt-file", "$DIR/launch.md"], { FAKE_WAIT: "fail", FAKE_OPEN_RUN: "1" });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(!/agent prompt/.test(r.calls), r.calls);
  assert.match(r.calls, /workspace close w1/);
});

// --- Chief-of-staff command over Orchestrators (2026-10-12) ---
import { formatRelay, markSuggestion, orchestratorProfile } from "./orchestrator-herdr.mjs";

test("read marks Claude Code's greyed prompt suggestion instead of passing it off as typed text", () => {
  // `herdr agent read --format ansi` of an idle Orchestrator: the input line is ❯ + a dim (SGR 2) suggestion.
  const ansi = "  done.\r\n❯ \x1b[0m\x1b[2mgo with salvage if the fixer gate is green\x1b[0m\r\n";
  const out = markSuggestion(ansi);
  assert.ok(!/go with salvage/.test(out), out);
  assert.match(out, /❯\s*\[greyed suggestion, not typed\]/);
  assert.ok(!/\x1b/.test(out), "ANSI codes are stripped");
  // Text the user really typed is not dim, and stays.
  assert.match(markSuggestion("❯ \x1b[0mmerge it\x1b[0m"), /❯ merge it/);
});

test("a relay quotes the owner verbatim with source and time, or says it is the chief of staff's own decision", () => {
  assert.equal(
    formatRelay({ said: "I approve the force-push", at: "13:14 IST", session: "CoS 2026-10-12" }),
    'Relayed by the chief of staff. The owner said, in "CoS 2026-10-12" at 13:14 IST, verbatim: "I approve the force-push"',
  );
  assert.match(formatRelay({ decided: "salvage 548, not reset" }), /^Chief of staff decision \(rule 5, not a the owner quote\): salvage 548, not reset$/);
  // A quote with no source is the laundering shape.
  assert.throws(() => formatRelay({ said: "x", at: "13:14 IST" }), /--session/);
  assert.throws(() => formatRelay({ said: "x", session: "s" }), /--at/);
  assert.throws(() => formatRelay({ said: "x", decided: "y", at: "a", session: "s" }), /one of/);
  assert.throws(() => formatRelay({}), /one of/);
});

test("the profile appends the owner's own allow rules and autoMode block, never replacing the base", () => {
  const p = orchestratorProfile({ permissions: { allow: ["Bash(afk salvage *)"] }, autoMode: { allow: ["$defaults", "x"] } });
  assert.deepEqual(p.permissions.allow, [...ORCHESTRATOR_SETTINGS.permissions.allow, "Bash(afk salvage *)"]);
  assert.deepEqual(p.autoMode, { allow: ["$defaults", "x"] });
  assert.deepEqual(orchestratorProfile(null), ORCHESTRATOR_SETTINGS);
});

test("start writes a per-name profile with the owner file merged in, and stop removes it", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const r = await runWithFakeHerdr(["start", "o", "--cwd", "$DIR", "--prompt-file", "$DIR/launch.md"], {
    FAKE_OWNER: JSON.stringify({ permissions: { allow: ["Bash(afk salvage *)"] } }),
    FAKE_OPEN_RUN: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  const settingsArg = r.calls.match(/--settings (\S+)/)[1];
  assert.match(settingsArg, /orchestrators\/o\.settings\.json$/);
  assert.ok(JSON.parse(readFileSync(settingsArg, "utf8")).permissions.allow.includes("Bash(afk salvage *)"));
  // The shared profile the running Orchestrators were started with is never rewritten.
  assert.ok(!existsSync(join(settingsArg, "..", "settings.json")));
  const s = await runWithFakeHerdr(["stop", "o"], { FAKE_HOME: r.home });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(!existsSync(settingsArg), "stop removes the per-name profile");
});

test("relay sends the fixed shape through herdr and logs it; a bare quote is refused before anything is sent", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const r = await runWithFakeHerdr(["relay", "o", "--said", "allow the four files -- option A", "--at", "16:01 IST", "--session", "CoS"], { FAKE_TRANSCRIPT_AGE_MIN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /agent prompt o Relayed by the chief of staff\. The owner said, in "CoS" at 16:01 IST, verbatim: "allow the four files -- option A"/);
  const log = readFileSync(join(r.home, ".afk-claude", "orchestrators", "relays.log"), "utf8");
  assert.equal(JSON.parse(log.trim()).name, "o");
  const bad = await runWithFakeHerdr(["relay", "o", "--said", "x"]);
  assert.equal(bad.status, 1);
  assert.ok(!/agent prompt/.test(bad.calls), bad.calls);
});

test("read heads the screen with the agent's state and transcript age, and marks the suggestion", async () => {
  const r = await runWithFakeHerdr(["read", "o"], { FAKE_TRANSCRIPT_AGE_MIN: "75" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split("\n")[0], /^o: idle · last transcript write 7\dm ago · cache likely cold/);
  assert.match(r.stdout, /\[greyed suggestion, not typed\]/);
  assert.ok(!/go with salvage/.test(r.stdout));
});

// --- Cold guard and start gate (#227) ---

test("cold guard: a prompt to a session idle 56 min exits non-zero with the restart line; at 54 min it is delivered", async () => {
  const cold = await runWithFakeHerdr(["prompt", "o", "status?"], { FAKE_TRANSCRIPT_AGE_MIN: "56" });
  assert.notEqual(cold.status, 0, cold.stdout);
  assert.ok(!/agent prompt/.test(cold.calls), cold.calls);
  assert.match(cold.stdout, /idle 56 min/);
  assert.match(cold.stdout, /orchestrator-herdr\.mjs restart o --cwd \S+ --prompt-file <handoff>/);
  const warm = await runWithFakeHerdr(["prompt", "o", "status?"], { FAKE_TRANSCRIPT_AGE_MIN: "54" });
  assert.equal(warm.status, 0, warm.stdout + warm.stderr);
  assert.match(warm.calls, /agent prompt o status\?/);
});

test("cold guard: a relay to a session idle 56 min is refused before it is logged or sent; at 54 min it is delivered", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const relay = ["relay", "o", "--decided", "salvage 548"];
  const cold = await runWithFakeHerdr(relay, { FAKE_TRANSCRIPT_AGE_MIN: "56" });
  assert.notEqual(cold.status, 0, cold.stdout);
  assert.ok(!/agent prompt/.test(cold.calls), cold.calls);
  assert.match(cold.stdout, /orchestrator-herdr\.mjs restart o --cwd \S+ --prompt-file <handoff>/);
  assert.ok(!existsSync(join(cold.home, ".afk-claude", "orchestrators", "relays.log")), "a refused relay is not logged as sent");
  const warm = await runWithFakeHerdr(relay, { FAKE_TRANSCRIPT_AGE_MIN: "54" });
  assert.equal(warm.status, 0, warm.stdout + warm.stderr);
  assert.match(warm.calls, /agent prompt o Chief of staff decision/);
});

test("start gate: start without an open afk cos run exits non-zero and touches no herdr; with one, it starts", async () => {
  const refused = await runWithFakeHerdr(["start", "o", "--cwd", "$DIR", "--prompt-file", "$DIR/launch.md"]);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stdout, /no afk cos run is open/);
  assert.equal(refused.calls, "", "nothing reached herdr");
  const started = await runWithFakeHerdr(["start", "o", "--cwd", "$DIR", "--prompt-file", "$DIR/launch.md"], { FAKE_OPEN_RUN: "1" });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.calls, /agent prompt o go/);
});

test("cold guard fails closed: a session whose idle age is unknown is refused with the restart line", async () => {
  // No transcript under ~/.claude/projects: the age cannot be read.
  for (const argv of [["prompt", "o", "status?"], ["relay", "o", "--decided", "salvage 548"]]) {
    const r = await runWithFakeHerdr(argv);
    assert.notEqual(r.status, 0, `${argv[0]}: ${r.stdout}`);
    assert.ok(!/agent prompt/.test(r.calls), r.calls);
    assert.match(r.stdout, /idle age unknown/);
    assert.match(r.stdout, /orchestrator-herdr\.mjs restart o --cwd \S+ --prompt-file <handoff>/);
  }
});
