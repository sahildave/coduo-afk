// The lane context trim: what a runner agent's first API call no longer carries.
// One test (or group) per change, each written to fail with that change reverted.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import * as auto from "./auto.mjs";
import { freePort } from "./free-port.mjs";
import { preflightBlockers } from "./scheduler.mjs";
import { hostInventory, laneContextSettings, laneInstructions, skillReferences, syncedPluginKeys } from "./lane-context.mjs";
import { agentConfig, buildAgentCommand } from "./lib.mjs";
import { roleAgent, roleFor, ROLES, settingsArg } from "./roles.mjs";
import { laneAgentStartArgs } from "./runtime-herdr.mjs";
import { permissionBrokerArgs } from "./permission-broker.mjs";
import { builderRunDir, staggerGate } from "./worker.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";

const PATHS = { nodeBin: "/runtime/bin", promptPath: "p.md", streamPath: "s.jsonl" };

// Hermetic when run on its own too (`afk selftest` sets this for the suite): a
// payload rendered without an explicit inventory reads an empty host, never the
// operator's ~/.claude. Read lazily by roles.mjs, so setting it here is in time.
process.env.AFK_CONTEXT_HOME ??= mkdtempSync(join(tmpdir(), "afk-ctx-empty-home-"));

// A host shaped like the measured one: plugins the lane names, plugins it does
// not, a synced plugin, and loose skills on both sides of the role's lists.
const INVENTORY = {
  plugins: ["coduo-radar@coduo-agents", "figma@synced", "posthog@claude-plugins-official", "pstack@coduo-agents", "stripe@claude-plugins-official"],
  looseSkills: ["code-review", "herdr", "karpathy-guidelines", "tdd", "unslop"],
};
const CONFIG = {
  roles: {
    implementer: { always: ["tdd", "karpathy-guidelines"], offer: ["pstack:blast-radius", "stripe:test-cards"] },
  },
};

// ---------------------------------------------------------------------------
// 1. Auto-memory off
// ---------------------------------------------------------------------------

test("every role's --settings payload switches the operator's auto-memory off", () => {
  for (const name of Object.keys(ROLES)) {
    const settings = JSON.parse(settingsArg(roleFor(name), CONFIG, INVENTORY));
    assert.equal(settings.autoMemoryEnabled, false, name);
  }
  // And it reaches the agent record the runtimes read, not just the helper.
  assert.equal(JSON.parse(roleAgent(roleFor("implementer"), CONFIG, "claude").settings).autoMemoryEnabled, false);
});

// ---------------------------------------------------------------------------
// 2. Per-role skill allowlist
// ---------------------------------------------------------------------------

test("plugins the role names no skill of are switched off; the ones it names stay", () => {
  const { enabledPlugins } = laneContextSettings(roleFor("implementer"), CONFIG, INVENTORY);
  assert.deepEqual(enabledPlugins, {
    "coduo-radar@coduo-agents": false,
    "figma@synced": false,
    "posthog@claude-plugins-official": false,
  });
});

test("loose skills the role does not list are overridden off, listed ones are not", () => {
  const { skillOverrides } = laneContextSettings(roleFor("implementer"), CONFIG, INVENTORY);
  assert.deepEqual(skillOverrides, { "code-review": "off", herdr: "off", unslop: "off" });
});

test("every skill a role is told to use stays reachable", () => {
  const config = {
    roles: {
      implementer: CONFIG.roles.implementer,
      integrator: { offer: ["unslop", "posthog:writing-simplified-technical-english"] },
      fixer: { always: ["code-review"], offer: ["figma:figma-use"] },
    },
  };
  for (const name of Object.keys(ROLES)) {
    const role = roleFor(name);
    const settings = laneContextSettings(role, config, INVENTORY);
    const listed = [...(config.roles[name]?.always ?? []), ...(config.roles[name]?.offer ?? []), ...(role.requiredSkills ?? [])];
    for (const skill of listed) {
      if (skill.includes(":")) {
        const plugin = skill.split(":")[0];
        const keys = Object.keys(settings.enabledPlugins ?? {}).filter((key) => key.split("@")[0] === plugin);
        assert.deepEqual(keys, [], `${name}: ${skill}'s plugin was switched off`);
      } else {
        assert.equal(settings.skillOverrides?.[skill], undefined, `${name}: ${skill} was overridden off`);
      }
    }
  }
});

// coduo-implement says "follow `/implement`"; atlas-tickets says "Read
// `coduo-afk` first". Switching those off fails as silently as an unlisted name.
test("a skill a kept skill tells the agent to load stays on, transitively, but never a denied one", () => {
  const texts = new Map([
    ["tdd", "Then follow `/implement` as usual."],
    ["implement", "Run /code-review when done. Never start herdr; see `herdr`."],
    ["code-review", "No references here, only the words unslop and check."],
    ["herdr", "pane control"],
    ["unslop", "prose"],
    ["check", "gate"],
  ]);
  const inventory = { plugins: [], looseSkills: [...texts.keys()].sort(), references: skillReferences(texts) };
  const { skillOverrides } = laneContextSettings(roleFor("implementer"), { roles: { implementer: { always: ["tdd"] } } }, inventory);
  assert.deepEqual(skillOverrides, { check: "off", herdr: "off", unslop: "off" });
});

test("the verifier keeps /code-review even when its project lists nothing", () => {
  const settings = laneContextSettings(roleFor("verifier"), {}, INVENTORY);
  assert.equal(settings.skillOverrides["code-review"], undefined);
});

// docs/notifications-and-agent-scope.md: the supervisor is the one role that
// reads panes. Its `denySkills: []` keeps the herdr deny off; this keeps the
// trim from switching the skill off behind it.
test("the supervisor keeps herdr even when its project lists nothing", () => {
  const settings = laneContextSettings(roleFor("supervisor"), {}, INVENTORY);
  assert.equal(settings.skillOverrides?.herdr, undefined, JSON.stringify(settings.skillOverrides));
  assert.equal(laneContextSettings(roleFor("implementer"), {}, INVENTORY).skillOverrides.herdr, "off");
});

// A host laid out on disk: a home holding ~/.claude/CLAUDE.md and ~/CLAUDE.md,
// a project under it with CLAUDE.md including AGENTS.md, loose skills, and an
// installed plugin whose skills point at loose ones.
const fixtureHost = (base) => {
  const home = join(base, "home");
  const project = join(home, "code", "repo");
  const file = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  for (const name of ["agent-device", "unslop", "diagnosing-bugs", "herdr", "graphify", "show-me-your-work", "tdd", "check", "research"])
    file(join(home, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  file(join(home, ".claude", "CLAUDE.md"), "Apply the `unslop` skill to all prose.\n");
  file(join(home, "CLAUDE.md"), "Use `agent-device` to drive simulators.\nScreenshot: `agent-device screenshot --out <path>`\n");
  file(join(project, "CLAUDE.md"), "Read @AGENTS.md for all project instructions.\n");
  file(join(project, "AGENTS.md"), "Split a hard bug: `/diagnosing-bugs` first. Never `herdr`. Do some research and check it.\n");
  const pstack = join(home, ".claude", "plugins", "cache", "coduo-agents", "pstack", "0.1.2");
  file(join(pstack, "skills", "blast-radius", "SKILL.md"), "Write the report per the `unslop` rules.\n");
  file(join(pstack, "skills", "show-me-your-work", "SKILL.md"), "Load `show-me-your-work` and `graphify` first.\n");
  file(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2, plugins: { "pstack@coduo-agents": [{ scope: "user", installPath: pstack }] },
  }));
  file(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "pstack@coduo-agents": true } }));
  return { home, project };
};

test("a skill reference may carry arguments: `agent-device screenshot` names agent-device", () => {
  const refs = skillReferences(new Map([["a", "Run `agent-device screenshot --out x.png`."], ["agent-device", ""], ["check", "`check:all` is a script"], ["a2", ""]]));
  assert.deepEqual(refs.a, ["agent-device"]);
  assert.deepEqual(refs.check, [], "a colon is not an argument separator");
});

// The repo's AGENTS.md says "/diagnosing-bugs first"; every role is handed it,
// so a trim that switches that skill off contradicts the lane's own
// instructions. ~/.claude/CLAUDE.md ("unslop") and ~/CLAUDE.md
// ("agent-device") no longer reach a lane (CLAUDE_CODE_DISABLE_CLAUDE_MDS), so
// they no longer keep a skill on either (#173).
test("skills the repo's instruction files name stay on, except a denied one; the operator's files keep none", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-instr-"));
  try {
    const { home, project } = fixtureHost(base);
    const inventory = hostInventory(project, home);
    assert.deepEqual(inventory.instructionSkills, ["diagnosing-bugs", "herdr"]);
    const { skillOverrides } = laneContextSettings(roleFor("implementer"), { roles: { implementer: { always: ["tdd"] } } }, inventory);
    assert.equal(skillOverrides["diagnosing-bugs"], undefined, "diagnosing-bugs was switched off");
    for (const name of ["agent-device", "unslop"])
      assert.equal(skillOverrides[name], "off", `${name} kept on by an operator file no lane loads`);
    assert.equal(skillOverrides.herdr, "off", "a role-denied skill came back through an instruction file");
    assert.equal(skillOverrides.research, "off", "bare prose is not a reference");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// pstack:blast-radius says "per the `unslop` rules"; pstack:show-me-your-work
// names `graphify`. The plugin stays loaded whole, so what its skills point at
// must too — and nothing they point at survives once the plugin is off.
test("loose skills a kept plugin's skills point at stay on", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-plugin-"));
  try {
    const { home, project } = fixtureHost(base);
    const inventory = { ...hostInventory(project, home), instructionSkills: [] };
    assert.deepEqual(inventory.references["pstack:blast-radius"], ["unslop"]);
    const kept = laneContextSettings(roleFor("implementer"), { roles: { implementer: { offer: ["pstack:blast-radius"] } } }, inventory);
    for (const name of ["unslop", "show-me-your-work", "graphify"])
      assert.equal(kept.skillOverrides[name], undefined, `${name} was switched off`);
    const dropped = laneContextSettings(roleFor("implementer"), { roles: { implementer: { always: ["tdd"] } } }, inventory);
    assert.equal(dropped.enabledPlugins["pstack@coduo-agents"], false);
    assert.equal(dropped.skillOverrides.unslop, "off");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// claude-reflect ships a ROOT SKILL.md and no skills/ dir; codex's `rescue` is
// commands/rescue.md. Both are loaded with the plugin, so what they name stays.
test("a kept plugin's root SKILL.md and commands/<name>.md count as its skills", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-layouts-"));
  try {
    const { home, project } = fixtureHost(base);
    const pstack = join(home, ".claude", "plugins", "cache", "coduo-agents", "pstack", "0.1.2");
    writeFileSync(join(pstack, "SKILL.md"), "Run `/research` before anything.\n");
    mkdirSync(join(pstack, "commands"), { recursive: true });
    writeFileSync(join(pstack, "commands", "audit.md"), "Finish with `/tdd`.\n");
    const inventory = { ...hostInventory(project, home), instructionSkills: [] };
    assert.deepEqual(inventory.references["pstack:pstack"], ["research"]);
    assert.deepEqual(inventory.references["pstack:audit"], ["tdd"]);
    const kept = laneContextSettings(roleFor("implementer"), { roles: { implementer: { offer: ["pstack:blast-radius"] } } }, inventory);
    for (const name of ["research", "tdd"])
      assert.equal(kept.skillOverrides[name], undefined, `${name} was switched off`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The spec says @-includes are followed transitively; a depth cap silently
// dropped the seventh file of a chain and the skill it names.
test("@-includes are followed to any depth", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-deep-"));
  try {
    const { home, project } = fixtureHost(base);
    writeFileSync(join(project, "AGENTS.md"), "Start at @docs/1.md\n");
    mkdirSync(join(project, "docs"), { recursive: true });
    for (let i = 1; i <= 7; i++)
      writeFileSync(join(project, "docs", `${i}.md`), i < 7 ? `next @${i + 1}.md\n` : "Use `/research` here.\n");
    assert.ok(hostInventory(project, home).instructionSkills.includes("research"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// figma ships from the operator's claude.ai account, not from any settings
// file. Its manifest names marketplace "knowledge-work-plugins", but the key
// Claude Code honours is `figma@synced` (measured: the former changes nothing).
test("a synced plugin is inventoried under the `@synced` key Claude Code honours", () => {
  const home = mkdtempSync(join(tmpdir(), "afk-ctx-home-"));
  try {
    const dir = join(home, ".claude", "plugins", "synced", "org_account");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      plugins: [{ name: "figma", marketplaceName: "knowledge-work-plugins" }],
    }));
    assert.deepEqual(syncedPluginKeys(home), ["figma@synced"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the inventory reads all three settings scopes, synced plugins and every skill store", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-inv-"));
  try {
    const home = join(base, "home");
    const project = join(base, "project");
    const json = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
    const skill = (store, name) => { mkdirSync(join(store, name), { recursive: true }); writeFileSync(join(store, name, "SKILL.md"), "---\nname: x\n---\n"); };
    json(join(home, ".claude", "settings.json"), { enabledPlugins: { "a@m": true, "off@m": false, "b@m": true } });
    json(join(project, ".claude", "settings.json"), { enabledPlugins: { "c@m": true } });
    json(join(project, ".claude", "settings.local.json"), { enabledPlugins: { "b@m": false } });
    json(join(home, ".claude", "plugins", "synced", "x", "manifest.json"), { plugins: [{ name: "figma" }] });
    skill(join(home, ".claude", "skills"), "tdd");
    skill(join(home, ".agents", "skills"), "unslop");
    skill(join(project, ".claude", "skills"), "check");
    mkdirSync(join(project, ".claude", "skills", "no-skill-md"), { recursive: true });
    assert.deepEqual(hostInventory(project, home), {
      plugins: ["a@m", "c@m", "figma@synced"],
      looseSkills: ["check", "tdd", "unslop"],
      references: { check: [], tdd: [], unslop: [] },
      instructionSkills: [],
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The fixer, reflector and supervisor build their own agent record and re-render
// `settings`; without the project config they would switch off every skill
// their `roles:` lists name.
test("the fixer, reflector and supervisor payloads keep the skills their config lists", async () => {
  const { fixerAgent } = await import("./fixer.mjs");
  const { reflectorAgent } = await import("./reflect.mjs");
  const { supervisorAgent } = await import("./supervisor.mjs");
  const config = { roles: { fixer: { always: ["show-me"] }, reflector: { always: ["show-me"] }, supervisor: { always: ["show-me"] } } };
  for (const [name, build] of [["fixer", fixerAgent], ["reflector", reflectorAgent], ["supervisor", supervisorAgent]]) {
    const settings = JSON.parse(build(roleFor(name), config).settings);
    assert.equal(settings.skillOverrides?.["show-me"], undefined, `${name} switched off show-me`);
  }
});

// ---------------------------------------------------------------------------
// 5. A guard personal hooks can read
// ---------------------------------------------------------------------------

// `--settings` env reaches hook processes (measured: a SessionStart hook echoed
// it), on the herdr runtime too, where RUNNER_TASK_ID is never exported.
test("every role's payload names the role in env, for hooks outside the repo to skip lanes", () => {
  for (const name of Object.keys(ROLES)) {
    assert.equal(JSON.parse(settingsArg(roleFor(name), CONFIG, INVENTORY)).env.AFK_AGENT_ROLE, name, name);
  }
});

// ---------------------------------------------------------------------------
// 4. --strict-mcp-config and --no-chrome
// ---------------------------------------------------------------------------

test("the direct runtime's agent loads no MCP server it did not name, and no Chrome", () => {
  const command = buildAgentCommand(roleAgent(roleFor("implementer"), CONFIG, "claude"), PATHS);
  assert.match(command, / --strict-mcp-config /);
  assert.match(command, / --no-chrome /);
});

test("a herdr lane keeps the broker's --mcp-config and loads nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-ctx-herdr-"));
  try {
    const argv = laneAgentStartArgs({
      name: "afk-1-1", pane: "p", launchDir: dir,
      agent: roleAgent(roleFor("implementer"), CONFIG, "claude"),
      broker: permissionBrokerArgs({ promptPath: join(dir, "prompt.md"), taskId: "1", runnerDir: "/r" }),
    });
    assert.ok(argv.includes("--strict-mcp-config"), argv.join(" "));
    assert.ok(argv.includes("--no-chrome"), argv.join(" "));
    const mcp = argv.indexOf("--mcp-config");
    assert.ok(mcp !== -1, "the broker's MCP config is gone");
    assert.match(readFileSync(argv[mcp + 1], "utf8"), /permission/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. The auth probe
// ---------------------------------------------------------------------------

test("the auth probe runs on haiku with no skills and no MCP servers", () => {
  const command = buildAgentCommand(auto.authProbeAgent(agentConfig({})), PATHS);
  assert.match(command, /--model 'haiku'/);
  assert.match(command, / --disable-slash-commands/);
  assert.match(command, / --strict-mcp-config/);
  assert.doesNotMatch(command, /--effort/);
  assert.match(command, /--settings '\{"autoMemoryEnabled":false\}'/);
});

// An org whose allowlist excludes haiku must not be refused with "log in":
// the probe retries on the lanes' own model, and only a login error says login.
test("a failed haiku probe retries on the lane model and never blames the login for a model error", () => {
  const agents = auto.authProbeAgents({ ...agentConfig({}), model: "opus" });
  assert.deepEqual(agents.map((agent) => agent.model), ["haiku", "opus"]);
  assert.equal(agents[1].disableSlashCommands, true);
  assert.equal(auto.authProbeBlocker([{ ok: false, output: "model haiku is not available" }, { ok: true, output: "OK" }]), null);
  const notAuth = auto.authProbeBlocker([{ ok: false, output: "model not available for your organization" }, { ok: false, output: "model not available" }]);
  assert.doesNotMatch(notAuth, /not authenticated/);
  assert.equal(auto.authProbeBlocker([{ ok: false, output: "Invalid API key · Please run /login" }]), "not authenticated");
  assert.deepEqual(preflightBlockers({ config: {}, checkAuth: () => notAuth }), [notAuth]);
});

test("the auth probe leaves a Codex agent alone", () => {
  const codex = agentConfig({}, "codex");
  assert.deepEqual(auto.authProbeAgent(codex), codex);
});

// ---------------------------------------------------------------------------
// 3. Staggered sibling launch
// ---------------------------------------------------------------------------

test("the stagger gate opens on the leader's first response", async () => {
  let seen = false;
  setTimeout(() => { seen = true; }, 30);
  assert.equal(await staggerGate({ responded: () => seen, leaderDone: new Promise(() => {}), maxWaitMs: 5_000, pollMs: 5 }), "first-response");
});

test("the stagger gate never waits on a dead leader", async () => {
  const leaderDone = Promise.reject(new Error("lane crashed"));
  assert.equal(await staggerGate({ responded: () => false, leaderDone, maxWaitMs: 5_000, pollMs: 5 }), "leader-ended");
});

test("the stagger gate is bounded when the leader never answers", async () => {
  const started = Date.now();
  assert.equal(await staggerGate({ responded: () => false, leaderDone: new Promise(() => {}), maxWaitMs: 60, pollMs: 5 }), "timeout");
  assert.ok(Date.now() - started < 2_000);
});

// Through the real scheduler: three ready lanes at maxParallel 3. The first
// lane writes its first assistant turn 300 ms in; the other two must not start
// until it has, and must be released by that response, not by the timeout.
test("lanes that start together launch after the first lane's first response (and the run's auth probe is the cheap one)", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-ctx-stagger-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeConfig(repo, { maxParallel: 3, defaultChecks: ["true"], baselineChecks: [] });
  git("add", "-A");
  git("commit", "-qm", "base");
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(base, "claude-argv.log"))}\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const previous = { root: process.env.AFK_WORKTREE_ROOT, path: process.env.PATH, port: process.env.PORT };
  process.env.AFK_WORKTREE_ROOT = join(base, "lanes");
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.PORT = String(await freePort());
  t.after(() => {
    for (const [key, value] of [["AFK_WORKTREE_ROOT", previous.root], ["PATH", previous.path], ["PORT", previous.port]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  const events = [];
  const tasks = ["501", "502", "503"].map((id) => ({ id, title: id, dependsOn: [], body: "" }));
  await auto.runAuto({
    config: readConfig(repo), root: repo, interactive: false,
    dag: { branch: "main", tasks },
    builder: async ({ root, task, worktree, attempt, startGate }) => {
      if (startGate) events.push(`${task.id} released: ${await startGate}`);
      else {
        events.push(`${task.id} launched`);
        const runDir = builderRunDir(root, task.id, attempt);
        mkdirSync(runDir, { recursive: true });
        await new Promise((done) => setTimeout(done, 300));
        events.push(`${task.id} responded`);
        writeFileSync(join(runDir, "stream.jsonl"), `${JSON.stringify({ type: "assistant", message: {} })}\n`);
        // A real lane keeps working after its first turn; outlive the gate's poll.
        await new Promise((done) => setTimeout(done, 1_500));
      }
      writeFileSync(join(worktree, `${task.id}.txt`), "x\n");
      execFileSync("git", ["add", "-A"], { cwd: worktree });
      execFileSync("git", ["commit", "-qm", task.id], { cwd: worktree });
      return { outcome: "ready_to_integrate", commitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), verification: { checks: [] } };
    },
    integrate: async ({ root, branch, onPid }) => {
      const integrationBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      onPid(null, integrationBase);
      execFileSync("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: root });
      return { outcome: "passed", integrationBase, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), verification: { checks: [] } };
    },
  });
  // The run's preflight auth probe is the one real `claude` call here.
  assert.match(readFileSync(join(base, "claude-argv.log"), "utf8"),
    /--model haiku --strict-mcp-config --no-chrome --disable-slash-commands/);
  assert.deepEqual(events.slice(0, 4), [
    "501 launched",
    "501 responded",
    "502 released: first-response",
    "503 released: first-response",
  ], events.join("\n"));
});

// ---------------------------------------------------------------------------
// 6. CLAUDE.md off; the repo's instruction files handed back once (#173)
// ---------------------------------------------------------------------------

// harbour's AGENTS.md, lines 148-153: a push that touches screen inputs needs
// `pnpm test:e2e` to have passed on that exact tree. A rule like that is the
// reason the repo's files are carried rather than dropped with the rest.
const E2E_RULE = "Never push a change that touches screen inputs unless `pnpm test:e2e` passed on that exact tree.";
const OPERATOR_NOTE = "OPERATOR-ONLY: leave no simulators behind.";

// A real git repo under a fake home: AGENTS.md with the rule, a CLAUDE.md that
// only points at it, a tracked nested CLAUDE.md, an untracked CLAUDE.local.md,
// and the operator's two home files.
const instructedRepo = (base) => {
  const home = join(base, "home");
  const project = join(home, "code", "harbour");
  const file = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  file(join(home, ".claude", "CLAUDE.md"), `${OPERATOR_NOTE}\n`);
  file(join(home, "CLAUDE.md"), `${OPERATOR_NOTE} (home root)\n`);
  file(join(project, "AGENTS.md"), `# harbour\n\n## Pushing\n\n${E2E_RULE}\nSee @docs/testing.md\n`);
  file(join(project, "docs", "testing.md"), "E2E-INCLUDE: run the suite headless.\n");
  file(join(project, "CLAUDE.md"), "@AGENTS.md\n");
  file(join(project, "packages", "ui", "CLAUDE.md"), "NESTED-UI: every input needs a test id.\n");
  file(join(project, "CLAUDE.local.md"), `${OPERATOR_NOTE} (local)\n`);
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["add", "AGENTS.md", "CLAUDE.md", "docs", "packages"], { cwd: project });
  return { home, project };
};

test("every role's payload switches Claude Code's CLAUDE.md loading off", () => {
  for (const name of Object.keys(ROLES)) {
    assert.equal(JSON.parse(settingsArg(roleFor(name), CONFIG, INVENTORY)).env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1", name);
  }
});

test("the repo's instruction files are carried, includes and nested ones too; the operator's are not", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-carry-"));
  try {
    const { project } = instructedRepo(base);
    const text = laneInstructions(project);
    assert.ok(text.includes(E2E_RULE), "the AGENTS.md rule was dropped");
    assert.ok(text.includes("E2E-INCLUDE"), "an @-included file was dropped");
    assert.ok(text.includes("NESTED-UI"), "a tracked nested CLAUDE.md was dropped");
    assert.match(text, /^## packages\/ui\/CLAUDE\.md$/m, "a nested file is not labelled with its directory");
    assert.ok(!text.includes(OPERATOR_NOTE), "an operator-scope file reached the lane");
    assert.equal(laneInstructions(join(base, "empty")), "", "a repo with no instruction files gets no block");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an include or seed outside the repo, or not tracked by git, is not carried", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-contain-"));
  const savedHome = process.env.HOME;
  try {
    const home = join(base, "home");
    const project = join(base, "repo");
    const file = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
    file(join(home, ".claude", "CLAUDE.md"), "LEAK-HOME-CLAUDE\n");
    file(join(base, "abs-outside.md"), "LEAK-ABSOLUTE\n");
    file(join(base, "outside.md"), "LEAK-PARENT\n");
    file(join(project, "AGENTS.md"), [
      "# repo", "@~/.claude/CLAUDE.md", `@${join(base, "abs-outside.md")}`, "@../outside.md",
      "@CLAUDE.local.md", "@notes/ignored.md", "@docs/tracked.md", "",
    ].join("\n"));
    file(join(project, "CLAUDE.local.md"), "LEAK-UNTRACKED-LOCAL\n");
    file(join(project, ".gitignore"), "notes/\n.claude/\n");
    file(join(project, "notes", "ignored.md"), "LEAK-GITIGNORED\n");
    file(join(project, ".claude", "CLAUDE.md"), "LEAK-IGNORED-SEED\n");
    file(join(project, "docs", "tracked.md"), "KEPT-TRACKED-INCLUDE\n");
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["add", "AGENTS.md", ".gitignore", "docs"], { cwd: project });
    process.env.HOME = home;
    const text = laneInstructions(project);
    assert.ok(text.includes("KEPT-TRACKED-INCLUDE"), "a tracked in-repo include was dropped");
    const leaks = ["LEAK-HOME-CLAUDE", "LEAK-ABSOLUTE", "LEAK-PARENT", "LEAK-UNTRACKED-LOCAL", "LEAK-GITIGNORED", "LEAK-IGNORED-SEED"];
    assert.deepEqual(leaks.filter((leak) => text.includes(leak)), [], "out-of-repo or untracked content reached the lane");
  } finally {
    process.env.HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  }
});

// End to end, in a child process so roles.mjs reads a real project root and
// home rather than the suite's empty AFK_CONTEXT_HOME: an implementer lane's
// command, on both runtimes, hands claude the rule in its system prompt and
// switches CLAUDE.md off. The direct command runs through a real shell against
// a fake `claude` that prints its argv.
test("a repo rule reaches an implementer lane on both runtimes, with CLAUDE.md off", () => {
  const base = mkdtempSync(join(tmpdir(), "afk-ctx-lane-"));
  try {
    const { home, project } = instructedRepo(base);
    const fake = join(base, "claude");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const promptPath = join(base, "prompt.md");
    writeFileSync(promptPath, "hi\n");
    const streamPath = join(base, "stream.jsonl");
    const launchDir = join(base, "launch");
    mkdirSync(launchDir);
    const scripts = new URL(".", import.meta.url).pathname;
    const probe = `
      const { roleAgent, roleFor } = await import(${JSON.stringify(join(scripts, "roles.mjs"))});
      const { buildAgentCommand } = await import(${JSON.stringify(join(scripts, "lib.mjs"))});
      const { laneAgentStartArgs } = await import(${JSON.stringify(join(scripts, "runtime-herdr.mjs"))});
      const agent = { ...roleAgent(roleFor("implementer"), {}, "claude"), command: ${JSON.stringify(fake)} };
      const direct = buildAgentCommand(agent, { nodeBin: "", promptPath: ${JSON.stringify(promptPath)}, streamPath: ${JSON.stringify(streamPath)}, taskId: "t", processName: "p" });
      const herdr = laneAgentStartArgs({ name: "afk-1-1", pane: "p", agent, launchDir: ${JSON.stringify(launchDir)} });
      process.stdout.write(JSON.stringify({ direct, herdr }));`;
    const env = { ...process.env, HOME: home };
    delete env.AFK_CONTEXT_HOME;
    const { direct, herdr } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: project, env, encoding: "utf8" }));

    // bash, not sh: `exec -a` in the launch prefix is not POSIX, and dash rejects it.
    execFileSync("bash", ["-c", direct], { cwd: project });
    const argv = JSON.parse(readFileSync(streamPath, "utf8"));
    const system = argv[argv.indexOf("--append-system-prompt") + 1];
    assert.ok(system.startsWith("A standing instruction from the runner"), "the standing instruction no longer leads");
    assert.ok(system.includes(E2E_RULE), "direct runtime: the repo rule did not reach claude");
    assert.ok(!system.includes(OPERATOR_NOTE), "direct runtime: an operator file reached claude");
    assert.equal(JSON.parse(argv[argv.indexOf("--settings") + 1]).env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");

    const file = readFileSync(herdr[herdr.indexOf("--append-system-prompt-file") + 1], "utf8");
    assert.equal(file, system, "herdr and direct lanes carry different system prompts");
    const settings = JSON.parse(readFileSync(herdr[herdr.indexOf("--settings") + 1], "utf8"));
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1", "herdr runtime: CLAUDE.md loading is still on");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
