/**
 * What a runner agent loads into its first API call that it never uses, and the
 * `--settings` keys that keep it out.
 *
 * Measured on atlas-workspace (epic #1023's lane #1014): a builder's first call
 * held ~60k tokens, re-read on every turn. Three of the biggest pieces were the
 * operator's own and nothing to do with the ticket:
 *
 * - the auto-memory index (MEMORY.md, ~16.9k tokens on that host), which is the
 *   operator's working notes, not the project's;
 * - the skill listing (441 skills, ~30k tokens), of which a lane's `roles:` block
 *   names about thirty;
 * - hooks from plugins the lane never uses (the coduo-radar vocabulary hook
 *   rewrote "Context"/"Plan" — the lane's own phase names — into billing terms).
 *
 * The CLAUDE.md files were the largest piece left (~31k of ~43k after the
 * above), most of it the operator's own. They are now switched off wholesale,
 * and the repo's instruction files are handed back once, verbatim
 * (`laneInstructions`), so a rule the repo makes mandatory still reaches every
 * role.
 *
 * Two mechanisms, because one does not reach the other's half:
 *
 * - `enabledPlugins: { "<plugin>@<marketplace>": false }` for every plugin the
 *   role's lists name no skill of. This removes the plugin's skills AND its
 *   hooks. `skillOverrides` does not reach plugin skills (measured), so this is
 *   the only way to drop them.
 * - `skillOverrides: { <name>: "off" }` for every loose skill (the four stores
 *   `stack.mjs` resolves unqualified names from) the role does not list.
 *
 * FAIL DIRECTION: every name the role's `always`/`offer` lists carry, plus the
 * role's own `requiredSkills` (a skill its prompt names outright), stays
 * reachable — a lane told to use a skill it cannot load fails in silence. A
 * plugin or store this reader does not know about is left alone, which costs
 * tokens and nothing else. Over-keeping is the safe error here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const readJsonOr = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};

/**
 * Enabled plugin KEYS (`<plugin>@<marketplace>`), three scopes deep: the user's
 * settings, then the repo's, then the repo's `settings.local.json` — later wins,
 * which is Claude Code's own precedence. The local file is real and in use:
 * coduo-swiftui-factory and quillnote each switch `pstack` off there and
 * nowhere else.
 */
export const enabledPluginKeys = (projectRoot, home = homedir()) => {
  const at = (dir, file) => readJsonOr(join(dir, ".claude", file), {}).enabledPlugins ?? {};
  const merged = {
    ...at(home, "settings.json"),
    ...at(projectRoot, "settings.json"),
    ...at(projectRoot, "settings.local.json"),
  };
  return Object.entries(merged).filter(([, on]) => on).map(([key]) => key);
};

/**
 * Plugins synced from the operator's claude.ai account. They load in every
 * session and appear in no `enabledPlugins` map, so a reader of settings alone
 * never sees them. Claude Code reports them as `<name>@synced` (init event's
 * `plugins[].source`), and that is the key that switches one off — measured
 * with figma, whose `figma@knowledge-work-plugins` (its marketplace name in the
 * manifest) is accepted in silence and changes nothing.
 */
export const syncedPluginKeys = (home = homedir()) => {
  const root = join(home, ".claude", "plugins", "synced");
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  return [...new Set(dirs.flatMap((dir) =>
    (readJsonOr(join(root, dir.name, "manifest.json"), {}).plugins ?? [])
      .map((plugin) => plugin?.name)
      .filter((name) => typeof name === "string" && name)
      .map((name) => `${name}@synced`)))];
};

/**
 * Where an UNQUALIFIED name can live. `~/.agents/skills` is the editor's store
 * and `~/.claude/skills` is usually symlinks into it; a repo may carry its own.
 */
export const skillStores = (projectRoot, home = homedir()) => [
  join(projectRoot, ".claude", "skills"),
  join(projectRoot, ".agents", "skills"),
  join(home, ".agents", "skills"),
  join(home, ".claude", "skills"),
];

// Every loose skill's SKILL.md text, first store wins (the order above).
const looseSkillTexts = (projectRoot, home) => {
  const texts = new Map();
  for (const store of skillStores(projectRoot, home)) {
    let entries = [];
    try { entries = readdirSync(store, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (texts.has(entry.name)) continue;
      try { texts.set(entry.name, readFileSync(join(store, entry.name, "SKILL.md"), "utf8")); } catch {}
    }
  }
  return texts;
};

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which loose skills each text points at: `/name`, `` `name` `` or
 * `` `name <args>` `` (a command line such as `agent-device screenshot`).
 * A listed skill that says "follow `/implement`" is useless if `implement` is
 * switched off, so the trim keeps the closure (`laneContextSettings`). A bare
 * word is not a reference — "check" and "research" are ordinary prose.
 * `names` are the loose skills a reference can land on; `texts` may also hold
 * plugin skills (`plugin:skill`), whose references count the same way.
 */
export const skillReferences = (texts, names = [...texts.keys()]) =>
  Object.fromEntries([...texts.keys()].map((name) => [name, names.filter((other) => other !== name
    && referencePattern(other).test(texts.get(name)))]));

const referencePattern = (name) =>
  new RegExp(`(?:\`/?${escape(name)}(?:\\s[^\`\\n]*)?\`|(?<![\\w/.-])/${escape(name)}(?![\\w-]))`);

/**
 * The files a plugin could be keeping `<plugin>:<skill>` in, in the order worth
 * trying: `skills/<skill>/SKILL.md`, `commands/<skill>.md`, and the
 * single-skill plugin whose `SKILL.md` sits at its root under the plugin's own
 * name (`claude-reflect:claude-reflect`). ONE definition: stack.mjs's
 * `resolveSkill` and manifest builder import it, and `pluginSkillTexts` below
 * enumerates the same three layouts.
 */
export const pluginSkillCandidates = (pluginRoot, plugin, skill) => [
  join(pluginRoot, "skills", skill, "SKILL.md"),
  join(pluginRoot, "commands", `${skill}.md`),
  ...(skill === plugin ? [join(pluginRoot, "SKILL.md")] : []),
];

const listOr = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/**
 * Every skill and command of every enabled plugin, as `plugin:skill` -> text,
 * across all three layouts of `pluginSkillCandidates`.
 * Installed plugins resolve through `installed_plugins.json` (every recorded
 * install path, so a stale version only over-reads); synced ones live under
 * `plugins/synced/<account>/<plugin>/skills`.
 */
const pluginSkillTexts = (pluginKeys, home) => {
  const texts = new Map();
  const pluginsDir = join(home, ".claude", "plugins");
  const installed = readJsonOr(join(pluginsDir, "installed_plugins.json"), {}).plugins ?? {};
  const syncedRoot = join(pluginsDir, "synced");
  const syncedAccounts = listOr(syncedRoot);
  for (const key of pluginKeys) {
    const plugin = key.split("@")[0];
    const dirs = key.endsWith("@synced")
      ? syncedAccounts.map((account) => join(syncedRoot, account, plugin))
      : (installed[key] ?? []).map((entry) => entry?.installPath).filter(Boolean);
    for (const dir of dirs) {
      const names = new Set([
        ...listOr(join(dir, "skills")),
        ...listOr(join(dir, "commands")).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)),
        plugin,
      ]);
      for (const skill of names) {
        const name = `${plugin}:${skill}`;
        // Every layout that exists counts: a name with both a skill and a
        // command loads both texts, so a reference in either keeps its target.
        const text = pluginSkillCandidates(dir, plugin, skill)
          .map((path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } })
          .filter(Boolean).join("\n");
        if (text) texts.set(name, `${texts.get(name) ?? ""}\n${text}`);
      }
    }
  }
  return texts;
};

// `@path`, Claude Code's import syntax in an instruction file.
const INCLUDE = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*)/g;

/**
 * Read every file in `seeds` that exists, and every `@path` it includes,
 * followed transitively to any depth, resolved against the including file.
 * Only a file inside `projectRoot` (symlinks resolved) that Git tracks is
 * read, so an include cannot reach `~/.claude/CLAUDE.md`, `~/.ssh` or
 * `CLAUDE.local.md`. A `~/` include is never followed.
 */
const withIncludes = (projectRoot, seeds) => {
  // One `git ls-files` for the whole tree. If it fails (not a git repo, no
  // git), the tracked check is skipped and containment alone applies: in-repo
  // files are still carried, per FAIL DIRECTION open below, and nothing
  // outside the repo is.
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: projectRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const tracked = listed.status === 0
    ? new Set(listed.stdout.split("\0").filter(Boolean).map((rel) => resolve(projectRoot, rel)))
    : null;
  const realRoot = (() => { try { return realpathSync(projectRoot); } catch { return projectRoot; } })();
  const inside = (root, path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const texts = new Map();
  const visit = (path) => {
    if (texts.has(path) || !inside(projectRoot, path) || (tracked && !tracked.has(path))) return;
    let text;
    try {
      if (!inside(realRoot, realpathSync(path))) return;
      text = readFileSync(path, "utf8");
    } catch { return; }
    texts.set(path, text);
    for (const [, ref] of text.matchAll(INCLUDE)) {
      if (!ref.startsWith("~/")) visit(resolve(dirname(path), ref));
    }
  };
  for (const path of seeds) visit(path);
  return texts;
};

/**
 * The repository's own instruction files, which a runner agent is handed
 * verbatim (`laneInstructions`) now that Claude Code's CLAUDE.md loading is off
 * for it (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `laneContextSettings`): the root
 * `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`, every `AGENTS.md` /
 * `CLAUDE.md` Git tracks deeper in the tree, and whatever they `@`-include.
 * Seeds and includes alike are carried only if they sit inside `projectRoot`
 * and Git tracks them (`withIncludes`).
 *
 * What is NOT carried is the operator's: `~/.claude/CLAUDE.md`, a `CLAUDE.md`
 * above the repo (`~/CLAUDE.md`), and `CLAUDE.local.md`. Those are one person's
 * working style on one host; a rule a lane must follow belongs in the repo, or
 * in `roles.<role>.notes` in `.afk-setup/config.yaml`.
 *
 * FAIL DIRECTION: open. A repo rule a lane never sees is the failure this
 * exists to prevent (harbour's AGENTS.md refuses a push touching screen inputs
 * unless `pnpm test:e2e` passed on that exact tree), so every repo-scope file
 * is carried, including a CLAUDE.md whose rules were never moved to AGENTS.md.
 * Over-carrying costs tokens and nothing else.
 */
export const repoInstructionFiles = (projectRoot) => {
  const top = ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md")];
  const listed = spawnSync("git", ["ls-files", "-z", "--", ":(glob)**/AGENTS.md", ":(glob)**/CLAUDE.md"], {
    cwd: projectRoot, encoding: "utf8",
  });
  const nested = listed.status === 0 ? listed.stdout.split("\0").filter(Boolean).sort() : [];
  return withIncludes(projectRoot, [...new Set([...top, ...nested])].map((rel) => resolve(projectRoot, rel)));
};

/**
 * The repository's instruction files as one block for the system prompt
 * (`roleAgent` appends it after the standing instruction), or "" when the repo
 * has none. Each file under its repo-relative path, so a nested one reads as
 * scoped to its directory.
 */
export const laneInstructions = (projectRoot) => {
  const files = [...repoInstructionFiles(projectRoot)].filter(([, text]) => text.trim());
  if (!files.length) return "";
  const label = (path) => {
    const rel = relative(projectRoot, path);
    return rel.startsWith("..") ? path : rel;
  };
  return [
    "This repository's instruction files follow, verbatim. Claude Code's own CLAUDE.md loading is off for runner agents, "
      + "so this is the only copy you get: follow them as you would a CLAUDE.md or AGENTS.md. A file in a subdirectory "
      + "applies to work under that directory. An `@path` a file names is included below under its own heading when it resolves to a file "
      + "Git tracks inside this repository; any other `@path` was left out on purpose.",
    ...files.map(([path, text]) => `## ${label(path)}\n\n${text.trim()}`),
  ].join("\n\n");
};

/** What a Claude session started in `projectRoot` on this host would load. */
export const hostInventory = (projectRoot, home = homedir()) => {
  const loose = looseSkillTexts(projectRoot, home);
  const plugins = [...new Set([...enabledPluginKeys(projectRoot, home), ...syncedPluginKeys(home)])].sort();
  const looseSkills = [...loose.keys()].sort();
  const instructions = [...repoInstructionFiles(projectRoot).values()].join("\n");
  return {
    plugins,
    looseSkills,
    references: skillReferences(new Map([...loose, ...pluginSkillTexts(plugins, home)]), looseSkills),
    instructionSkills: looseSkills.filter((name) => referencePattern(name).test(instructions)),
  };
};

/**
 * The `--settings` keys that trim one role's context. Pure: the host is read by
 * `hostInventory`, so a test hands in the inventory it wants.
 */
export const laneContextSettings = (role, config, inventory) => {
  const spec = config?.roles?.[role.name] ?? {};
  const listed = [...(spec.always ?? []), ...(spec.offer ?? []), ...(role.requiredSkills ?? [])];
  const keepPlugins = new Set(listed.filter((name) => name.includes(":")).map((name) => name.split(":")[0]));
  const keepLoose = new Set(listed.filter((name) => !name.includes(":")));
  // ...and every loose skill a kept one tells the agent to load, transitively.
  // A skill the role denies (`herdr`) is never pulled back in this way.
  const denied = new Set(role.permissions?.denySkills ?? []);
  const pull = (names) => { for (const ref of names ?? []) if (!denied.has(ref)) keepLoose.add(ref); };
  // Seeds beyond the role's lists: skills the repo's instruction files, which
  // every role is handed (`laneInstructions`), tell the agent to use
  // (`agent-device` for a UI lane's screenshot), and skills any kept plugin's
  // skills point at — the whole plugin stays loaded, so every one of its skills
  // is reachable. The operator's own CLAUDE.md files no longer reach a lane, so
  // a skill only they name is no longer kept.
  pull(inventory?.instructionSkills);
  for (const [name, refs] of Object.entries(inventory?.references ?? {})) {
    if (name.includes(":") && keepPlugins.has(name.split(":")[0])) pull(refs);
  }
  for (const name of keepLoose) {
    for (const ref of inventory?.references?.[name] ?? []) if (!denied.has(ref)) keepLoose.add(ref);
  }
  const enabledPlugins = Object.fromEntries((inventory?.plugins ?? [])
    .filter((key) => !keepPlugins.has(key.split("@")[0]))
    .map((key) => [key, false]));
  const skillOverrides = Object.fromEntries((inventory?.looseSkills ?? [])
    .filter((name) => !keepLoose.has(name))
    .map((name) => [name, "off"]));
  return {
    // The operator's auto-memory is their notes across every session on this
    // host; a lane reads its ticket, the repo and the epic ledger instead.
    autoMemoryEnabled: false,
    // A hook outside this repo cannot be switched off from here (`--settings`
    // hooks add to the user's, and `disableAllHooks` would also kill the
    // runner's own time-budget hook). This gives such a hook something to test
    // on BOTH runtimes — `RUNNER_TASK_ID` is set only by the direct runtime's
    // shell prefix, never in a herdr pane: `[ -n "$AFK_AGENT_ROLE" ] && exit 0`.
    //
    // `CLAUDE_CODE_DISABLE_CLAUDE_MDS` stops Claude Code loading any CLAUDE.md
    // (the operator's ~/.claude/CLAUDE.md and ~/CLAUDE.md, the repo's, nested
    // ones). Here rather than in the direct runtime's shell prefix because
    // `--settings` env is the one channel both runtimes share, and it is read
    // before the files are (measured on 2.1.289: a CLAUDE.md word stops
    // reaching the agent). The repo's own files come back through
    // `laneInstructions`, appended to the system prompt.
    env: { AFK_AGENT_ROLE: role.name, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
    ...(Object.keys(enabledPlugins).length ? { enabledPlugins } : {}),
    ...(Object.keys(skillOverrides).length ? { skillOverrides } : {}),
  };
};
