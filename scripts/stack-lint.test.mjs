// scripts/stack-lint.test.mjs — `afk stack lint`, and the name resolution
// `afk stack detect` now runs over its own proposal.
//
// The property worth defending: a skill name that cannot load on this host is
// REPORTED, and the report says which half failed. Five checkouts in this
// estate hand agents eleven dead name-sites today, and nothing said so — the
// config is committed, hand-edited, and had never been checked against a disk.
//
// These tests move HOME, because the resolver reads the user's settings and the
// `~/.agents/skills` store. `os.homedir()` follows $HOME on POSIX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const load = async () => await import(`./stack.mjs?${Math.random()}`);

/** A host: a HOME with user settings, a plugin cache, and a skill store. */
const host = ({ userPlugins = {}, plugins = {}, store = [] } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "afk-lint-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: userPlugins }));
  const installed = { version: 2, plugins: {} };
  for (const [key, spec] of Object.entries(plugins)) {
    // The version segment is deliberate: reading the plugin name off the cache
    // path gets "0.1.0", which is the mistake `installPath` exists to prevent.
    const installPath = join(home, ".claude", "plugins", "cache", key.split("@")[1], key.split("@")[0], "0.1.0");
    mkdirSync(installPath, { recursive: true });
    for (const skill of spec.skills ?? []) {
      mkdirSync(join(installPath, "skills", skill), { recursive: true });
      writeFileSync(join(installPath, "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
    }
    // The other two layouts a real plugin uses.
    for (const command of spec.commands ?? []) {
      mkdirSync(join(installPath, "commands"), { recursive: true });
      writeFileSync(join(installPath, "commands", `${command}.md`), "# command\n");
    }
    if (spec.rootSkill) writeFileSync(join(installPath, "SKILL.md"), "---\nname: x\n---\n");
    installed.plugins[key] = [{ scope: spec.scope, projectPath: spec.projectPath, installPath }];
  }
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(installed));
  for (const skill of store) {
    mkdirSync(join(home, ".agents", "skills", skill), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
  }
  return home;
};

/** A repo: its own enabled plugins, and a committed `roles:` block. */
const repo = ({ plugins = {}, roles = null } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-lint-repo-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: plugins }));
  mkdirSync(join(dir, ".afk-setup"), { recursive: true });
  writeFileSync(join(dir, ".afk-setup", "config.yaml"), roles ?? "defaultChecks: []\n");
  return dir;
};

/** Run `fn` with HOME pointed at a fixture host, then put HOME back. */
const withHome = async (home, fn) => {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(await load()); } finally { process.env.HOME = previous; }
};

const clean = (...dirs) => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); };

test("a plugin installed project-scoped to ANOTHER repo cannot load here", async () => {
  // The real case: `vercel@claude-plugins-official` is installed scope:project
  // against atlas-workspace, and four other repos name `vercel:*` skills.
  // "Is it installed" says yes on this host and is the wrong question.
  const elsewhere = mkdtempSync(join(tmpdir(), "afk-lint-other-"));
  const home = host({
    plugins: { "vercel@official": { scope: "project", projectPath: elsewhere, skills: ["nextjs"] } },
  });
  const dir = repo({
    plugins: { "vercel@official": true },
    roles: "roles:\n  implementer:\n    offer: [vercel:nextjs]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.equal(report.named, 1);
    assert.deepEqual(report.dead.map((d) => d.name), ["vercel:nextjs"]);
    assert.match(report.dead[0].reason, /installed only for another project/);
    assert.match(stack.renderLint(report), /named, not installed on this host/);
  });
  clean(home, dir, elsewhere);
});

test("the same plugin installed for THIS repo resolves", async () => {
  const dir = repo({
    plugins: { "vercel@official": true },
    roles: "roles:\n  implementer:\n    offer: [vercel:nextjs]\n",
  });
  const home = host({
    plugins: { "vercel@official": { scope: "project", projectPath: dir, skills: ["nextjs"] } },
  });
  await withHome(home, (stack) => assert.deepEqual(stack.lint(dir).dead, []));
  clean(home, dir);
});

test("an enabled, installed plugin that ships no such skill is reported as that", async () => {
  // coduo-billing-infra names `stripe:explain-error`. The stripe plugin is
  // enabled there and installed user-scope — it simply has no skill by that
  // name. "Plugin missing" and "skill missing" need different fixes, so the
  // reason has to say which.
  const home = host({
    plugins: { "stripe@official": { scope: "user", skills: ["stripe-pay"] } },
  });
  const dir = repo({
    plugins: { "stripe@official": true },
    roles: "roles:\n  implementer:\n    offer: [stripe:explain-error]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["stripe:explain-error"]);
    assert.match(report.dead[0].reason, /enabled and installed here, but has no skill or command "explain-error"/);
  });
  clean(home, dir);
});

test("a plugin enabled only at user scope resolves — reading the repo alone would false-alarm", async () => {
  // `superwall@coduo-agents` is true in ~/.claude/settings.json and absent from
  // every repo's. A repo-only reading calls its skills dead.
  const home = host({
    userPlugins: { "superwall@coduo-agents": true },
    plugins: { "superwall@coduo-agents": { scope: "user", skills: ["superwall"] } },
  });
  const dir = repo({ roles: "roles:\n  implementer:\n    offer: [superwall:superwall]\n" });
  await withHome(home, (stack) => assert.deepEqual(stack.lint(dir).dead, []));
  clean(home, dir);
});

test("a repo switching a user-enabled plugin off makes its skills dead there", async () => {
  // The repo wins on a key both scopes name — Claude Code's own precedence.
  const home = host({
    userPlugins: { "vercel@official": true },
    plugins: { "vercel@official": { scope: "user", skills: ["nextjs"] } },
  });
  const dir = repo({
    plugins: { "vercel@official": false },
    roles: "roles:\n  implementer:\n    offer: [vercel:nextjs]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["vercel:nextjs"]);
    assert.match(report.dead[0].reason, /not enabled for this repo/);
  });
  clean(home, dir);
});

test("an unqualified name resolves from the local store, and an unknown one does not", async () => {
  // harbour names a bare `vitest`. There is no such skill anywhere on this host.
  const home = host({ store: ["coduo-implement"] });
  const dir = repo({
    roles: "roles:\n  implementer:\n    always: [coduo-implement]\n    offer: [vitest]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.equal(report.named, 2);
    assert.deepEqual(report.dead.map((d) => d.name), ["vitest"]);
    assert.match(report.dead[0].reason, /no skill of that name/);
  });
  clean(home, dir);
});

test("one dead name in two roles is reported once, naming both sites", async () => {
  const home = host({ store: [] });
  const dir = repo({
    roles: "roles:\n  implementer:\n    offer: [ghost]\n  verifier:\n    offer: [ghost]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.equal(report.dead.length, 1);
    assert.deepEqual(report.dead[0].where, ["roles.implementer.offer", "roles.verifier.offer"]);
  });
  clean(home, dir);
});

test("a config with no roles block says so rather than passing clean", async () => {
  // Four checkouts are in this state. "0 dead names" would read as healthy.
  const home = host();
  const dir = repo();
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.equal(report.named, 0);
    assert.match(stack.renderLint(report), /no skill names to check/);
  });
  clean(home, dir);
});

test("detect checks the names in its own proposal", async () => {
  // The proposal is about to be pasted into a committed file. The catalogue it
  // comes from has shipped a name nothing can load before.
  const home = host();
  const dir = repo();
  await withHome(home, (stack) => {
    const report = stack.detect(dir);
    const baseline = report.roles.implementer.always;
    assert.ok(baseline.length, "the baseline names at least one skill");
    assert.deepEqual(report.deadNames.map((d) => d.name).filter((n) => baseline.includes(n)),
      baseline, "with an empty store, every baseline name reads as dead");
    assert.match(stack.renderDetect(report), /Proposed but not installed on this host/);
  });
  clean(home, dir);
});

test("a plugin enabled here but installed nowhere says so, not \"wrong scope\"", async () => {
  // voice-studio-website enables `react-doctor@coduo-agents`; nothing on this
  // host has ever installed it. "Install it" and "install it somewhere this
  // repo can see" are different fixes, so the reason has to tell them apart.
  const home = host();
  const dir = repo({
    plugins: { "react-doctor@coduo-agents": true },
    roles: "roles:\n  verifier:\n    offer: [react-doctor:react-doctor]\n",
  });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["react-doctor:react-doctor"]);
    assert.match(report.dead[0].reason, /enabled here but not installed on this host/);
  });
  clean(home, dir);
});

test("a plugin whose skill is a command resolves — `codex:rescue` loads in a real session", async () => {
  // Reproduced against the real cache before this was written: `codex` ships
  // skills/{codex-cli-runtime,...} AND commands/rescue.md, and both halves are
  // invocable. Knowing only the skills/ layout calls a working name dead, and a
  // false dead is the damaging direction — it makes a human delete a live entry.
  const home = host({
    userPlugins: { "codex@openai-codex": true },
    plugins: { "codex@openai-codex": { scope: "user", skills: ["codex-cli-runtime"], commands: ["rescue"] } },
  });
  const dir = repo({ roles: "roles:\n  fixer:\n    offer: [codex:rescue, codex:codex-cli-runtime]\n" });
  await withHome(home, (stack) => assert.deepEqual(stack.lint(dir).dead, []));
  clean(home, dir);
});

test("a single-skill plugin with a ROOT SKILL.md and no skills/ dir resolves", async () => {
  // `claude-reflect` is exactly this shape: a root SKILL.md, a commands/ dir,
  // and no skills/ directory at all. It is healthy, not broken.
  const home = host({
    userPlugins: { "claude-reflect@mkt": true },
    plugins: { "claude-reflect@mkt": { scope: "user", rootSkill: true, commands: ["reflect"] } },
  });
  const dir = repo({
    roles: "roles:\n  implementer:\n    offer: [claude-reflect:claude-reflect, claude-reflect:reflect]\n",
  });
  await withHome(home, (stack) => assert.deepEqual(stack.lint(dir).dead, []));
  clean(home, dir);
});

test("the root SKILL.md only answers to the plugin's OWN name", async () => {
  // Otherwise every name under a single-skill plugin resolves, and the branch
  // that was meant to stop false deads starts hiding real ones.
  const home = host({
    userPlugins: { "claude-reflect@mkt": true },
    plugins: { "claude-reflect@mkt": { scope: "user", rootSkill: true } },
  });
  const dir = repo({ roles: "roles:\n  implementer:\n    offer: [claude-reflect:anything-else]\n" });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["claude-reflect:anything-else"]);
    assert.match(report.dead[0].reason, /has no skill or command "anything-else"/);
  });
  clean(home, dir);
});

test("settings.local.json is the third enablement scope, and it wins", async () => {
  // coduo-swiftui-factory and quillnote each switch `pstack` off there and
  // nowhere else. A resolver reading two scopes reports it enabled.
  const home = host({
    userPlugins: { "pstack@coduo-agents": true },
    plugins: { "pstack@coduo-agents": { scope: "user", skills: ["blast-radius"] } },
  });
  const dir = repo({ roles: "roles:\n  implementer:\n    offer: [pstack:blast-radius]\n" });
  writeFileSync(join(dir, ".claude", "settings.local.json"),
    JSON.stringify({ enabledPlugins: { "pstack@coduo-agents": false } }));
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["pstack:blast-radius"]);
    assert.match(report.dead[0].reason, /not enabled for this repo/);
  });
  clean(home, dir);
});

test("a store directory with no SKILL.md in it is not a skill", async () => {
  // A half-deleted or half-synced store entry. Weakening this check to "the
  // directory exists" passed all ten of the first tests written here.
  const home = host();
  mkdirSync(join(home, ".agents", "skills", "hollow"), { recursive: true });
  const dir = repo({ roles: "roles:\n  implementer:\n    offer: [hollow]\n" });
  await withHome(home, (stack) =>
    assert.deepEqual(stack.lint(dir).dead.map((d) => d.name), ["hollow"]));
  clean(home, dir);
});

// --- The CLI layer -----------------------------------------------------------
//
// Everything above tests the module. None of it touches the verb split, the
// `--json` branch or the exit code: inverting `process.exit(dead ? 1 : 0)` left
// all fifteen green. A lint whose exit code is backwards reports success on
// every broken repo and failure on every healthy one, and nothing would say so.

test("`lint` exits non-zero on a dead name and zero on a clean one", async () => {
  const home = host({ store: ["coduo-implement"] });
  const dirty = repo({ roles: "roles:\n  implementer:\n    offer: [ghost]\n" });
  const clean_ = repo({ roles: "roles:\n  implementer:\n    always: [coduo-implement]\n" });
  const run = (dir) => spawnSync(process.execPath, [join(import.meta.dirname, "stack.mjs"), "lint"],
    { cwd: dir, env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(run(dirty).status, 1, "a dead name must fail the command");
  assert.match(run(dirty).stdout, /ghost/);
  assert.equal(run(clean_).status, 0, "a clean config must pass");
  clean(home, dirty, clean_);
});

test("the verb is the first positional, and `detect` is still the default", async () => {
  const home = host({ store: ["coduo-implement"] });
  const dir = repo();
  const run = (...args) => spawnSync(process.execPath,
    [join(import.meta.dirname, "stack.mjs"), ...args],
    { cwd: dir, env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.match(run("detect").stdout, /Proposed block for/);
  assert.match(run().stdout, /Proposed block for/, "no verb means detect, as before");
  assert.match(run("lint").stdout, /no skill names to check/);
  // A flag before the verb must not be read as the verb.
  assert.match(run("--json", "lint").stdout, /"dead"/);
  clean(home, dir);
});

test("--json prints parseable output for both verbs, and lint still exits non-zero", async () => {
  const home = host({ store: [] });
  const dir = repo({ roles: "roles:\n  implementer:\n    offer: [ghost]\n" });
  const run = (...args) => spawnSync(process.execPath,
    [join(import.meta.dirname, "stack.mjs"), ...args],
    { cwd: dir, env: { ...process.env, HOME: home }, encoding: "utf8" });
  const lint = run("lint", "--json");
  assert.equal(lint.status, 1, "--json must not swallow the exit code");
  assert.deepEqual(JSON.parse(lint.stdout).dead.map((d) => d.name), ["ghost"]);
  assert.ok(Array.isArray(JSON.parse(run("detect", "--json").stdout).deadNames));
  clean(home, dir);
});

test("a name that exists but is user-invocable only is dead, not alive", async () => {
  // `codex` ships eight commands; six carry `disable-model-invocation: true`
  // and are absent from a real session's skill list. Accepting commands/ in
  // 3b88a86 made all eight resolve, so `codex:cancel` and `codex:transfer` —
  // the names most likely to be miscopied into an offer list — read alive.
  // Existence was the wrong test.
  const home = host({
    userPlugins: { "codex@openai-codex": true },
    plugins: { "codex@openai-codex": { scope: "user", commands: ["rescue"] } },
  });
  writeFileSync(
    join(home, ".claude", "plugins", "cache", "openai-codex", "codex", "0.1.0", "commands", "cancel.md"),
    "---\nname: cancel\ndisable-model-invocation: true\n---\n# cancel\n",
  );
  const dir = repo({ roles: "roles:\n  fixer:\n    offer: [codex:rescue, codex:cancel]\n" });
  await withHome(home, (stack) => {
    const report = stack.lint(dir);
    assert.deepEqual(report.dead.map((d) => d.name), ["codex:cancel"],
      "the one without the flag stays alive");
    assert.match(report.dead[0].reason, /user-invocable only/);
  });
  clean(home, dir);
});

test("the flag is read from the frontmatter block, not from anywhere in the file", async () => {
  // A skill that DOCUMENTS the flag must not be mistaken for one that sets it.
  // Two shapes, and only the second pins the frontmatter parsing: an inline
  // mention is already excluded by the line-anchored match, but a fenced block
  // near the top puts the flag on a line of its own. A skill about authoring
  // skills is exactly where that happens.
  const home = host({ store: [] });
  const write = (name, body) => {
    mkdirSync(join(home, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", name, "SKILL.md"), body);
  };
  write("mentions-inline",
    "---\nname: mentions-inline\n---\n\nSet `disable-model-invocation: true` to hide a skill.\n");
  write("shows-an-example",
    "---\nname: shows-an-example\n---\n\nFrontmatter for a slash-only skill:\n\n```yaml\nname: whatever\ndisable-model-invocation: true\n```\n");
  const dir = repo({
    roles: "roles:\n  implementer:\n    offer: [mentions-inline, shows-an-example]\n",
  });
  await withHome(home, (stack) => assert.deepEqual(stack.lint(dir).dead, []));
  clean(home, dir);
});

test("a plugin the repo declares but a later scope refuses is not PROPOSED either", async () => {
  // Two readings of "enabled" used to meet in one report and disagree.
  // coduo-swiftui-factory and quillnote each declare `pstack` in their committed
  // settings and switch it off in `settings.local.json`; detect proposed six
  // `pstack:*` skills and flagged all six dead, four lines apart in the same
  // output. A proposal that contradicts its own warning teaches the reader to
  // ignore one of them.
  const home = host({
    plugins: { "pstack@coduo-agents": { scope: "user", skills: ["blast-radius"] } },
  });
  const dir = repo({ plugins: { "pstack@coduo-agents": true } });
  writeFileSync(join(dir, ".claude", "settings.local.json"),
    JSON.stringify({ enabledPlugins: { "pstack@coduo-agents": false } }));
  await withHome(home, (stack) => {
    const report = stack.detect(dir);
    assert.deepEqual(report.plugins, [], "refused anywhere means not proposed from");
    assert.deepEqual(report.deadNames.filter((d) => d.name.startsWith("pstack:")), [],
      "and so nothing to warn about — the proposal and the warning agree");
  });
  clean(home, dir);
});

test("a plugin the repo declares and nothing refuses is still proposed from", async () => {
  // The intersection must not become "propose nothing": the ordinary case is a
  // repo declaring a plugin that no later scope touches.
  const home = host({
    plugins: { "pstack@coduo-agents": { scope: "user", skills: ["blast-radius"] } },
  });
  const dir = repo({ plugins: { "pstack@coduo-agents": true } });
  await withHome(home, (stack) => assert.deepEqual(stack.detect(dir).plugins, ["pstack"]));
  clean(home, dir);
});

test("a plugin enabled ONLY at user scope stays out of a repo's proposal", async () => {
  // The other half, and the reason `detect` does not simply use the three-scope
  // merge: `superwall` is on at user scope for every repo on this machine. It is
  // not any of their declarations, and proposing it everywhere is noise.
  const home = host({
    userPlugins: { "superwall@coduo-agents": true },
    plugins: { "superwall@coduo-agents": { scope: "user", skills: ["superwall"] } },
  });
  const dir = repo();
  await withHome(home, (stack) => assert.deepEqual(stack.detect(dir).plugins, []));
  clean(home, dir);
});
