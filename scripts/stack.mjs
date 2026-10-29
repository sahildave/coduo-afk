/**
 * `afk stack detect` — what this project is built with, and the `roles:` block
 * that follows from it.
 *
 * This command is DETERMINISTIC and READ-ONLY. It runs no agent, needs no
 * login, and costs nothing, which is the same discipline `afk validate` keeps.
 * It writes nothing: it prints a proposal, and a human (or step 7 of
 * `setup-coduo-agents`) decides whether it lands in `.afk-setup/config.yaml`.
 *
 * ## Why it reads `.claude/settings.json` rather than detecting from scratch
 *
 * `setup-coduo-agents` already classifies a repo and records the answer as the
 * plugins it enables. That file is a FACT on disk. A second detector would be a
 * second opinion, and the two would drift — so the enabled plugins are the
 * input here, and `stack-markers.yaml` exists only to catch the gap in the
 * other direction: a stack that is plainly in `package.json` with no plugin
 * enabled for it.
 *
 * ## Nothing is dropped silently
 *
 * An enabled plugin with no entry in `plugin-roles.yaml` is REPORTED, in
 * `unmapped`. The alternative — passing over it — reads as "this plugin
 * contributes nothing", which is indistinguishable from "nobody has written
 * its entry yet". Most plugins are currently the second.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite, isMainModule, loadConfig, root, run, runnerRoot } from "./lib.mjs";
import { ROLES } from "./roles.mjs";
import { enabledPluginKeys, pluginSkillCandidates, skillStores } from "./lane-context.mjs";
import { parseYamlSubset, toYamlSubset } from "./epic-spec.mjs";

const readYaml = (path) => parseYamlSubset(readFileSync(path, "utf8"));
const readJsonOr = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};

export const loadPluginRoles = () => readYaml(join(runnerRoot, "plugin-roles.yaml"));
export const loadStackMarkers = () => readYaml(join(runnerRoot, "stack-markers.yaml"));

/**
 * The plugin names a repo has enabled. Keys are `"<plugin>@<marketplace>"`, and
 * only the plugin half is meaningful here: the same plugin from two
 * marketplaces is the same capability.
 */
export const enabledPlugins = (projectRoot) => {
  const settings = readJsonOr(join(projectRoot, ".claude", "settings.json"), {});
  return [
    ...new Set(
      Object.entries(settings.enabledPlugins ?? {})
        .filter(([, on]) => on)
        .map(([key]) => key.split("@")[0]),
    ),
  ].sort();
};

/**
 * ## Why marker files are matched against `git ls-files`, one level deep
 *
 * The first version asked `existsSync(root/<file>)`, which sees a marker only at
 * the repo root. That misses the common layout: Lumina's Xcode project is
 * `prototype/`, atlas-workspace' and brightpath's crates are `src-tauri/`, an
 * Expo app's Xcode project is `ios/`. All three reported `stacks: none` or
 * close to it, for repos that plainly are what they are.
 *
 * A recursive scan fixes that and buys a worse problem. Measured on
 * atlas-workspace: an unpruned `find` at depth 3 returns **669** `package.json`.
 * Even the tracked set lies — coduo-swiftui-factory carries five `Package.swift`
 * of which four are recipe templates, and Lumina's `web/package.json` would flip
 * `needsNodeModules` true for a repo whose root has no `node_modules` at all.
 * That last one is not cosmetic: `bootstrapWorktree` THROWS by name when a
 * `link:` source is missing (`scripts/worktree.mjs:207`), so the false positive
 * fails every lane in the repo at bootstrap.
 *
 * So: `git ls-files`, which is gitignore-aware and ~14ms, and **one extra level,
 * no more**. One level reaches every real case above and excludes the false ones
 * by construction — `src-tauri/vendor/sacp-tokio/Cargo.toml` and
 * `ios/Pods/Pods.xcodeproj` are both deeper. `needsNodeModules` stays keyed on
 * the ROOT manifest alone, and a manifest found in a subdirectory gets a
 * report line rather than a stack tag.
 */
const trackedPaths = (projectRoot) => {
  // `--others --exclude-standard` as well as `--cached`, because the moment
  // this command is most useful is a repo nobody has committed yet: `git init`
  // plus a Package.swift and nothing staged reported `stacks: none`, which is
  // precisely the setup-at-project-start case. Still gitignore-aware — that is
  // what `--exclude-standard` preserves, and it is what keeps `ios/Pods` out.
  const listed = run("git ls-files -z --cached --others --exclude-standard", { cwd: projectRoot });
  if (listed.status !== 0) return null;
  return listed.stdout.split("\0").filter(Boolean);
};

/**
 * The paths a marker may name: every tracked file at the root, and every
 * depth-2 prefix. The prefix is what makes `*.xcodeproj` work at all — it is a
 * DIRECTORY, so what git lists is `prototype/Lumina.xcodeproj/project.pbxproj`
 * and the marker has to match the bundle, not a file inside it.
 *
 * The depth cap bounds the SIZE of this set on a large repo. It is not what
 * excludes a crate vendored under `src-tauri/vendor/` — the pattern does that,
 * because `*` does not cross a `/` — and removing the cap changes no result
 * against any marker shipped today. Demonstrated: the suite stays green.
 */
export const markerCandidates = (paths) => {
  const candidates = new Set();
  for (const path of paths) {
    const segments = path.split("/");
    candidates.add(segments[0]);
    if (segments.length > 1) candidates.add(`${segments[0]}/${segments[1]}`);
  }
  return candidates;
};

/** A marker pattern, where `*` matches within one path segment and nothing else. */
const markerMatches = (pattern, candidates) => {
  if (!pattern.includes("*")) return candidates.has(pattern);
  const source = `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`;
  const re = new RegExp(source);
  return [...candidates].some((candidate) => re.test(candidate));
};

/** Subdirectory `package.json` — reported, never a stack tag. See the note above. */
export const alsoSeenUnder = (paths) => [
  ...new Set(paths
    .filter((path) => path.split("/").length === 2 && path.endsWith("/package.json"))
    .map((path) => path.split("/")[0])),
].sort();

/** Stacks visible in the repo itself, whatever the plugins say. */
export const detectStacks = (projectRoot, markers = loadStackMarkers(), paths = trackedPaths(projectRoot)) => {
  const pkg = readJsonOr(join(projectRoot, "package.json"), {});
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  // A repo git cannot list — no checkout, a fresh `git init` — falls back to the
  // root-only test rather than reporting nothing. Advisory either way.
  const candidates = paths === null ? null : markerCandidates(paths);
  const fileSeen = (file) => (candidates
    ? markerMatches(file, candidates)
    : !file.includes("*") && existsSync(join(projectRoot, file)));
  const seen = Object.entries(markers)
    .filter(([, marker]) =>
      (marker.deps ?? []).some((dep) => deps.has(dep))
      || (marker.files ?? []).some(fileSeen))
    .map(([name]) => name);
  // An Expo or React Native app ships an Xcode project under `ios/`, which is
  // the same shape as a native Swift app one level down. The root manifest
  // settles it. No repo in this estate triggers the rule today — both RN repos
  // gitignore `ios/` entirely — so it is insurance against the next one, not a
  // fix for a case anybody has.
  const reactNative = deps.has("react-native") || deps.has("expo");
  return seen.filter((name) => !(reactNative && name === "swift")).sort();
};

/**
 * Merge the baseline and every enabled plugin's bindings into one `roles:`
 * block. Lists union and de-duplicate; `notes` concatenate in plugin order.
 * Nothing here resolves a conflict, because there is none to resolve: two
 * plugins asking for the same skill is one skill.
 */
export const mergeRoles = (plugins, pluginRoles = loadPluginRoles()) => {
  const roles = {};
  const add = (entry) => {
    for (const [roleName, binding] of Object.entries(entry ?? {})) {
      const target = (roles[roleName] ??= {});
      for (const field of ["always", "offer"]) {
        if (!binding[field]?.length) continue;
        target[field] = [...new Set([...(target[field] ?? []), ...binding[field]])];
      }
      if (binding.notes?.length) {
        // A list of lines only because the parser has no block scalar.
        const text = [binding.notes].flat().join(" ");
        target.notes = target.notes ? `${target.notes}\n\n${text}` : text;
      }
    }
  };
  add(pluginRoles._baseline);
  for (const plugin of plugins) add(pluginRoles[plugin]);
  return roles;
};

/**
 * ## The `worktreeSetup` proposal, and why `link: [node_modules]` is not universal
 *
 * Symlinking the main checkout's `node_modules` into each lane is right for
 * most node repos: `git worktree add` copies tracked files only, the verifier
 * runs with the npm registry network-denied, and without deps every JS gate
 * reports "did not run".
 *
 * Next 16 makes Turbopack the `next build` default, and Turbopack refuses a
 * symlinked `node_modules` outright. harbour hit this and its committed config
 * records the answer — `link: []` plus `pnpm install --frozen-lockfile`, a
 * measured 4.1s per lane. voice-studio-website still carries the link and
 * passes only because its checks never run `next build`: a masked case, not a
 * counterexample.
 *
 * The predicate reads the ROOT manifest and nothing else. atlas-workspace is
 * the shape that makes this matter: no `next` at the root, `next@^16` in
 * `landing/package.json`, and a Tauri lane that needs the symlink. Reading any
 * deeper flips it to `link: []` and takes the deps away from lanes that depend
 * on them.
 *
 * The install command is NOT uniform across package managers. `npm install
 * --frozen-lockfile` is not a thing — npm accepts unknown flags as config and a
 * plain `npm install` can rewrite `package-lock.json`, which is on
 * `CHECK_INPUT_FILES`. After Step 6 that is a bootstrap hook dirtying a
 * protected file by construction. npm gets `npm ci`.
 */
const INSTALL_COMMAND = {
  // yarn 1's flag. Berry wants `--immutable`; no repo in this estate is on
  // yarn at all, so this stays one line until one is.
  yarn: "yarn install --frozen-lockfile",
  pnpm: "pnpm install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
  npm: "npm ci",
};

// Checked in this order, so a repo that has accidentally collected two
// lockfiles resolves the same way every time rather than by directory order.
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Which package manager this repo uses, and what said so. */
export const packageManagerFor = (projectRoot) => {
  const declared = readJsonOr(join(projectRoot, "package.json"), {}).packageManager;
  const named = typeof declared === "string" ? declared.split("@")[0] : null;
  if (named && INSTALL_COMMAND[named]) return { name: named, from: "the packageManager field" };
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(projectRoot, file)));
  // voice-studio-website has no `packageManager` field, so this fallback is
  // load-bearing rather than a nicety.
  if (lockfile) return { name: lockfile[1], from: lockfile[0] };
  return { name: "npm", from: "nothing — no packageManager field and no lockfile" };
};

/**
 * The `worktreeSetup` block to propose, or null for a repo with no root
 * manifest. `link: []` is emitted EXPLICITLY alongside the run line: an absent
 * `worktreeSetup` key makes `bootstrapWorktree` return immediately
 * (`scripts/worktree.mjs:203`), so the install would never run.
 */
export const worktreeSetupFor = (projectRoot) => {
  const pkg = readJsonOr(join(projectRoot, "package.json"), null);
  if (!pkg) return null;
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  // pnpm's pre-run check reinstalls over a symlinked node_modules, so the
  // warning belongs with the LINK, never with the install branch — harbour has
  // no symlink left to warn about.
  if (!deps.has("next")) {
    return { setup: { link: ["node_modules"] }, pnpmRelinks: existsSync(join(projectRoot, "pnpm-lock.yaml")) };
  }
  const pm = packageManagerFor(projectRoot);
  return { setup: { link: [], run: [INSTALL_COMMAND[pm.name]] }, pm };
};

/**
 * The whole report. `unmapped` and `missingPlugins` are the two honest halves:
 * a plugin this runner has no bindings for, and a stack in the repo with no
 * plugin enabled to cover it.
 */
export const detect = (projectRoot = root) => {
  const pluginRoles = loadPluginRoles();
  const markers = loadStackMarkers();
  // The repo's declared plugins, MINUS anything a later scope switches off.
  //
  // Two readings of "enabled" used to meet in this one report and disagree.
  // `enabledPlugins` reads the committed `.claude/settings.json` alone, which is
  // right for a PROPOSAL — a user-scope plugin is not this repo's declaration
  // and dragging every one of them in would make the block noise. But
  // `settings.local.json` is machine-private and it DISABLES: coduo-swiftui-factory
  // and quillnote each switch `pstack` off there and nowhere else, and detect
  // proposed six `pstack:*` skills and then flagged all six of them dead, in the
  // same report, four lines apart.
  //
  // So: declared here, and not refused anywhere. Intersecting is what keeps the
  // proposal the repo's own without proposing names that cannot load.
  const loadable = new Set(enabledPluginKeys(projectRoot).map((key) => key.split("@")[0]));
  const plugins = enabledPlugins(projectRoot).filter((plugin) => loadable.has(plugin));
  const paths = trackedPaths(projectRoot);
  const stacks = detectStacks(projectRoot, markers, paths);
  const known = plugins.filter((plugin) => pluginRoles[plugin]);
  const report = {
    plugins,
    stacks,
    roles: mergeRoles(known, pluginRoles),
    unmapped: plugins.filter((plugin) => !pluginRoles[plugin]),
    missingPlugins: stacks
      .map((stack) => markers[stack]?.plugin)
      .filter((plugin) => plugin && !plugins.includes(plugin))
      .filter((plugin, index, all) => all.indexOf(plugin) === index)
      .sort(),
    // A stack that reaches the roles block through nothing at all: it names no
    // plugin, or it names one that ships no bindings. `missingPlugins` misses
    // these by construction — it can only report a stack that HAS a plugin to
    // be missing — and they are most of the list: react, react-native, vitest,
    // jest, swift, python. Left unreported, a Python repo would read the
    // baseline-only proposal as "correctly, nothing to add".
    uncovered: stacks.filter((stack) => {
      const plugin = markers[stack]?.plugin;
      return !plugin || !pluginRoles[plugin];
    }),
    // A node project runs its gates against installed dependencies, and the
    // verifier runs those gates in a disposable checkout with the npm registry
    // network-denied — so unless `node_modules` is linked in, every JS gate
    // reports "did not run" and the closeout rests on structural guesswork.
    // `git worktree add` copies tracked files only, and `node_modules` is
    // gitignored, so the link is the one thing that carries deps into both the
    // lanes and the verifier. Presence of package.json is the signal.
    needsNodeModules: existsSync(join(projectRoot, "package.json")),
    worktreeSetup: worktreeSetupFor(projectRoot),
    // Subdirectories with their own manifest. REPORTED, never a stack tag and
    // never an input to `needsNodeModules`: Lumina's `web/package.json` would
    // otherwise propose `link: [node_modules]` for a repo whose root has none,
    // and `bootstrapWorktree` throws by name on a missing link source
    // (`scripts/worktree.mjs:207`) — every lane dead at bootstrap.
    alsoSeenUnder: alsoSeenUnder(paths ?? []),
  };
  // The proposal is a list of names about to be pasted into a committed file,
  // so it is checked against this host before it is printed. A name that does
  // not resolve fails silently in a lane as "no such skill", and the catalogue
  // this proposal comes from has been wrong before — `nextjs` mapped to a
  // plugin nobody enables, `vitest` listed in a marketplace that ships no
  // skills/ directory at all. The COMMITTED block is `afk stack lint`'s job.
  report.deadNames = deadNames(skillNamesIn(report.roles), projectRoot);
  return report;
};

/**
 * ## Name resolution — `afk stack lint`
 *
 * A `roles:` block is a list of skill NAMES handed to an agent, and a name that
 * does not resolve fails silently as "no such skill". Four repos in this estate
 * name ten skills that cannot load on this host, and nothing said so: the
 * config is committed, hand-edited, and never checked against a disk.
 *
 * The two mistakes a hand-rolled resolver makes, both made here before this was
 * written:
 *
 * - **Installed is not enabled.** `vercel@claude-plugins-official` sits in the
 *   plugin cache, so "is it installed" says yes everywhere. It is installed
 *   `scope: project` against ONE repo, and three others switch it off in their
 *   own settings. Enablement comes from settings; visibility comes from the
 *   install scope; a name needs both.
 * - **The cache path carries a version segment.** `.../coduo-agents/superwall/0.1.0/skills`.
 *   Reading the plugin name off the path gets `0.1.0`. `installed_plugins.json`
 *   already records `installPath` exactly, so nothing has to be parsed out of it.
 * - **A plugin skill is not always `skills/<name>/SKILL.md`.** `claude-reflect`
 *   ships a ROOT `SKILL.md` and no `skills/` directory at all; `codex` ships
 *   both `skills/` and `commands/`, and `codex:rescue` is a command. All three
 *   are invocable in a real session, so a resolver that knows only the one
 *   layout calls working names dead — and a false dead is the damaging
 *   direction, because it makes a human delete an entry that worked.
 *
 * Accepting a `commands/<name>.md` widens what a `roles:` block means: the
 * prompt paragraph says "apply these skills" and a slash command is not quite
 * that. Taken deliberately, on the same reasoning — if the Skill tool can
 * invoke the name, this must not call it dead.
 */
const readInstalledPlugins = () =>
  readJsonOr(join(homedir(), ".claude", "plugins", "installed_plugins.json"), {}).plugins ?? {};

const samePath = (a, b) => {
  if (!a || !b) return false;
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(a) === real(b);
};

// `enabledPluginKeys` and `skillStores` live in lane-context.mjs, which the
// runner reads at launch to trim a lane's skills; re-exported here unchanged.
export { enabledPluginKeys, skillStores };

/**
 * What this repo can do with each plugin: `{ root }` — the install directory —
 * when it is reachable, `{ reason }` when it is not. The reasons are different
 * FIXES — switch it on, install it, or install it at a scope this repo can see
 * — and collapsing them into "not available" sends the reader back to the
 * plugin cache to work out which.
 *
 * This keeps the INSTALL root rather than its `skills/` subdirectory, because
 * `skills/` is only one of the three places a plugin puts an invocable name and
 * a plugin with no `skills/` at all (claude-reflect) is perfectly healthy.
 *
 * Keyed by the plugin half of the settings key, because that is how a skill
 * name qualifies itself: the same plugin from two marketplaces is one plugin.
 */
export const pluginSkillDirs = (projectRoot, installs = readInstalledPlugins()) => {
  const state = {};
  const enabled = new Set(enabledPluginKeys(projectRoot).map((key) => key.split("@")[0]));
  const byPlugin = {};
  for (const [key, entries] of Object.entries(installs)) {
    (byPlugin[key.split("@")[0]] ??= []).push(...entries);
  }
  for (const plugin of enabled) {
    const entries = byPlugin[plugin] ?? [];
    if (!entries.length) {
      state[plugin] = { reason: `plugin "${plugin}" is enabled here but not installed on this host` };
      continue;
    }
    const found = entries
      .filter((entry) => entry.scope === "user" || samePath(entry.projectPath, projectRoot))
      .map((entry) => entry.installPath)
      .find((dir) => dir && existsSync(dir));
    state[plugin] = found
      ? { root: found }
      : { reason: `plugin "${plugin}" is installed only for another project, so its skills do not load here` };
  }
  return state;
};

/**
 * Whether a skill file is one an AGENT can reach. `disable-model-invocation:
 * true` in the frontmatter means a human types it and no model can call it, so
 * naming it in a `roles:` block hands a builder a name that fails exactly the
 * way an unresolvable one does.
 *
 * This matters most for `commands/`, which the resolver started accepting in
 * 3b88a86: `codex` ships eight, of which six carry the flag. Existence was the
 * wrong test — `codex:cancel` and `codex:transfer` exist, resolve, and cannot
 * be invoked. It applies to `skills/` and the local store too;
 * `setup-coduo-agents` carries the flag today, which is the whole subject of
 * §16 Step 5.
 *
 * Reads the leading `---` block when there is one, so a body that merely
 * mentions the flag is not mistaken for a file that sets it.
 */
const HUMAN_ONLY =
  "exists, but is user-invocable only (disable-model-invocation) — no agent can reach it";

export const modelInvocable = (path) => {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  const lines = text.split("\n");
  const front = lines[0]?.trim() === "---"
    ? lines.slice(1, lines.indexOf("---", 1) === -1 ? 15 : lines.indexOf("---", 1))
    : lines.slice(0, 15);
  return !front.some((line) => /^\s*disable-model-invocation:\s*true\s*$/.test(line));
};

/**
 * Resolve one name. `<plugin>:<skill>` goes to the plugin's skills dir;
 * anything else to the local stores. Returns `{ ok }` or `{ ok: false, reason }`
 * — the reason names WHICH half failed, because "not installed" and "installed
 * but not enabled here" need different fixes.
 */
export const resolveSkill = (name, { pluginDirs, stores }) => {
  if (name.includes(":")) {
    const [plugin, skill] = name.split(":");
    const state = pluginDirs[plugin];
    if (!state) return { ok: false, reason: `plugin "${plugin}" is not enabled for this repo` };
    if (!state.root) return { ok: false, reason: state.reason };
    const found = pluginSkillCandidates(state.root, plugin, skill).find((path) => existsSync(path));
    if (!found) {
      return { ok: false, reason: `plugin "${plugin}" is enabled and installed here, but has no skill or command "${skill}"` };
    }
    return modelInvocable(found) ? { ok: true } : { ok: false, reason: HUMAN_ONLY };
  }
  const found = stores.map((dir) => join(dir, name, "SKILL.md")).find((path) => existsSync(path));
  if (!found) {
    return { ok: false, reason: "no skill of that name in .claude/skills, ~/.agents/skills or ~/.claude/skills" };
  }
  return modelInvocable(found) ? { ok: true } : { ok: false, reason: HUMAN_ONLY };
};

/** Every skill name a `roles:` block hands to an agent, with where it came from. */
export const skillNamesIn = (roles = {}) =>
  Object.entries(roles ?? {}).flatMap(([roleName, binding]) =>
    ["always", "offer"].flatMap((field) =>
      (binding?.[field] ?? []).map((name) => ({ name, where: `roles.${roleName}.${field}` }))));

/** The names that do not resolve, de-duplicated by name, each with every site. */
export const deadNames = (named, projectRoot = root) => {
  const context = { pluginDirs: pluginSkillDirs(projectRoot), stores: skillStores(projectRoot) };
  const dead = new Map();
  for (const { name, where } of named) {
    const seen = dead.get(name);
    if (seen) { seen.where.push(where); continue; }
    const result = resolveSkill(name, context);
    if (!result.ok) dead.set(name, { name, reason: result.reason, where: [where] });
  }
  return [...dead.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * ## The skill manifest — `afk stack manifest`
 *
 * `plugin-roles.yaml` names skills the runner ships to every project, and it has
 * shipped a name nothing could load. Checking it against THIS host is the wrong
 * test twice over: a valid binding fails on a machine that has not installed the
 * plugin, and a wrong one passes on a machine holding a stale copy.
 *
 * So the check runs against `plugin-skills.json`, a committed record of the
 * invocable names each referenced plugin ships. Three rules keep it from
 * becoming a second catalogue to maintain:
 *
 * - **It is GENERATED, never hand-edited.** `afk stack manifest --write` reads
 *   this host's install cache, falling back to the marketplace checkout. Drift
 *   is then a one-command fix rather than an editing chore.
 * - **It covers only plugins the catalogue names a SKILL from** — three today,
 *   because most entries are `notes:` only. Adding a binding for a new plugin
 *   fails the unit test by name until the manifest is regenerated in the same
 *   commit.
 * - **One flat list of invocable names per plugin**, produced by the same
 *   three-layout walk and `disable-model-invocation` filter `resolveSkill` uses,
 *   so the manifest and the resolver cannot disagree about what counts.
 *
 * A plugin that is neither installed here nor in the marketplace checkout —
 * `react-doctor` — keeps a hand-written entry carrying its own provenance, and
 * the generator preserves it verbatim while saying it could not re-verify. That
 * is the whole hand-maintained residue: one entry, with an evidence trail.
 */
const MANIFEST_PATH = join(runnerRoot, "plugin-skills.json");

export const loadSkillManifest = () => readJsonOr(MANIFEST_PATH, { plugins: {} });

/** The plugins whose SKILLS the catalogue names. `notes:`-only entries have none. */
export const pluginsNamedByCatalogue = (pluginRoles = loadPluginRoles()) => [
  ...new Set(
    Object.values(pluginRoles).flatMap((entry) =>
      Object.values(entry ?? {}).flatMap((binding) =>
        ["always", "offer"].flatMap((field) => binding?.[field] ?? [])))
      .filter((name) => name.includes(":"))
      .map((name) => name.split(":")[0]),
  ),
].sort();

/** Every invocable name a plugin directory ships, by the resolver's own rules. */
export const invocableNamesIn = (pluginRoot, plugin) => {
  const listed = (dir, strip) => {
    const path = join(pluginRoot, dir);
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .filter((entry) => !strip || entry.endsWith(strip))
      .map((entry) => (strip ? entry.slice(0, -strip.length) : entry));
  };
  // Enumerate the NAMES a plugin could offer, then ask `resolveSkill`'s own
  // candidate list where each one would live. That is what makes the sentence
  // above true rather than aspirational: one encoding of the three layouts,
  // used by the generator and the resolver alike.
  const candidates = [...listed("skills", null), ...listed("commands", ".md"), plugin];
  const names = [...new Set(candidates)].filter((name) =>
    pluginSkillCandidates(pluginRoot, plugin, name).some(
      (path) => existsSync(path) && modelInvocable(path)));
  return names.sort();
};

/**
 * Where a plugin's source lives on this machine: the install cache first,
 * because it reaches seven of the nine catalogue plugins and the marketplace
 * checkout reaches one.
 */
const pluginSourceDir = (plugin, { marketplace, installs }) => {
  for (const [key, entries] of Object.entries(installs)) {
    if (key.split("@")[0] !== plugin) continue;
    const found = entries.map((entry) => entry.installPath).find((dir) => dir && existsSync(dir));
    if (found) return { dir: found, source: `install cache (${found.split("/").pop()})` };
  }
  const local = join(marketplace, "plugins", plugin);
  return existsSync(local) ? { dir: local, source: "marketplace checkout" } : null;
};

/**
 * Regenerate the manifest. Entries for plugins with no source here are carried
 * over verbatim — that is the external-source case, and dropping them would make
 * a partner's regeneration delete evidence they cannot reproduce.
 */
export const buildSkillManifest = ({
  marketplace = join(runnerRoot, "..", "coduo-agents-marketplace"),
  installs = readInstalledPlugins(),
  previous = loadSkillManifest(),
  pluginRoles = loadPluginRoles(),
} = {}) => {
  const plugins = {};
  const unverified = [];
  for (const plugin of pluginsNamedByCatalogue(pluginRoles)) {
    const source = pluginSourceDir(plugin, { marketplace, installs });
    if (source) {
      plugins[plugin] = { source: source.source, skills: invocableNamesIn(source.dir, plugin) };
      continue;
    }
    const carried = previous.plugins?.[plugin];
    if (carried) { plugins[plugin] = carried; unverified.push(plugin); continue; }
    plugins[plugin] = { source: "NOT FOUND on this machine", skills: [] };
    unverified.push(plugin);
  }
  return { manifest: { _generated: "by `afk stack manifest --write` — do not hand-edit", plugins }, unverified };
};

/** Catalogue names the manifest says cannot exist. Deterministic on every host. */
export const catalogueGaps = (pluginRoles = loadPluginRoles(), manifest = loadSkillManifest()) => {
  const gaps = [];
  // Walked directly rather than through `skillNamesIn`: that helper labels a
  // site `roles.<role>.<field>`, which would name a file these entries are not
  // in. This one is `plugin-roles.yaml: <plugin>.<role>.<field>`.
  const named = Object.entries(pluginRoles).flatMap(([plugin, entry]) =>
    Object.entries(entry ?? {}).flatMap(([role, binding]) =>
      ["always", "offer"].flatMap((field) =>
        (binding?.[field] ?? []).map((name) => ({
          name,
          where: `plugin-roles.yaml: ${plugin}.${role}.${field}`,
        })))));
  for (const { name, where } of named) {
    if (!name.includes(":")) continue;
    const [plugin, skill] = name.split(":");
    const entry = manifest.plugins?.[plugin];
    if (!entry) { gaps.push({ name, where, reason: `no manifest entry for plugin "${plugin}" — regenerate with \`afk stack manifest --write\`` }); continue; }
    if (!entry.skills.includes(skill)) gaps.push({ name, where, reason: `"${plugin}" ships no invocable "${skill}" (source: ${entry.source})` });
  }
  return gaps;
};

/**
 * `afk stack lint` — the committed config, checked against this host. This is
 * the verb that finds the rot nobody sees, and it is the whole hand-off to a
 * second machine: a partner runs it and gets "named, not installed on this
 * host" for exactly the names only the owner has.
 */
/**
 * Enabled in `.claude/settings.json` and unable to load a single skill here.
 * `pluginSkillDirs` already computes this — an entry with a `reason` and no
 * `root` is one — and until now only a name that happened to reference such a
 * plugin surfaced it. harbour enables `vercel-react` and `vitest`, neither
 * installed on this host, so both contributed nothing and nothing said so.
 *
 * FAIL DIRECTION: reported and non-zero, like a dead name. Both are the same
 * failure — a declaration that looks live and does nothing — and the whole
 * command exists to end the silent half of it. The cost of being wrong is a
 * red lint on a machine that has not installed a plugin yet, which is a true
 * statement about that machine; `lint` is host-dependent by design and the
 * help already says never to put it in `defaultChecks`.
 */
export const unloadablePlugins = (projectRoot = root) =>
  Object.entries(pluginSkillDirs(projectRoot))
    .filter(([, state]) => !state.root)
    .map(([name, state]) => ({ name, reason: state.reason }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const lint = (projectRoot = root) => {
  const config = loadConfig(projectRoot);
  const named = skillNamesIn(config?.roles);
  return {
    named: named.length,
    dead: deadNames(named, projectRoot),
    unloadable: unloadablePlugins(projectRoot),
  };
};

const renderUnloadable = (unloadable) => unloadable.length
  ? [
    `\n${unloadable.length} plugin(s) enabled for this repo load no skills here:\n`,
    ...unloadable.map(({ name, reason }) => `  ${name}\n    ${reason}`),
    "\n  An enabled plugin that cannot load is the same silent failure as a dead",
    "  skill name, one level up: every skill it would have shipped is absent and",
    "  no role binding has to mention it for that to bite. Install it, or drop it",
    "  from .claude/settings.json so the file says what is true.",
    "    A plugin enabled for its MCP SERVER rather than its skills is the one",
    "    honest exception — it ships no skills by design and this line is noise",
    "    for it. `atlas-mcp` is the case in this estate. Whether MCP-only",
    "    enablements belong in this report is the open `MCP scope` question in",
    "    docs/product/setup-skill-routing/discussion.md §32; until that is",
    "    settled, read this list as skills-only.",
  ].join("\n")
  : null;

export const renderLint = (report) => {
  const plugins = renderUnloadable(report.unloadable ?? []);
  if (!report.named) {
    // The plugin half still reports. A repo with no `roles:` block can still
    // enable a plugin that loads nothing, and exiting non-zero while printing
    // "nothing to check" is the command contradicting itself.
    return ["No `roles:` block in .afk-setup/config.yaml — no skill names to check.\n"
      + "  Run `afk stack detect` for a proposal.", plugins].filter((line) => line !== null).join("\n");
  }
  if (!report.dead.length) {
    return [`All ${report.named} skill names in .afk-setup/config.yaml resolve on this host.`, plugins]
      .filter((line) => line !== null).join("\n");
  }
  return [
    `${report.dead.length} of ${report.named} skill names are named, not installed on this host:\n`,
    ...report.dead.map(({ name, reason, where }) =>
      `  ${name}\n    ${reason}\n    named at: ${where.join(", ")}`),
    "\n  Each of these reaches an agent as a name that fails silently as \"no such",
    "  skill\". Remove it from the config, or make it resolve — the reason above",
    "  says which of the two fixes this one needs.",
    plugins,
  ].filter((line) => line !== null).join("\n");
};

/**
 * ## `afk stack suggest` — the wide proposal, and why it needs a model
 *
 * `detect` proposes from ENABLED PLUGINS. `suggest` proposes from INSTALLED
 * SKILLS. Different sources, so both survive: `plugin-roles.yaml` maps a
 * handful of plugins, and the ~150 `SKILL.md` files a lane can actually reach
 * stay invisible to `detect` forever.
 *
 * It exists because re-seeding is forbidden — `roles:` merges field-level or
 * refuses — so on a repo with a hand-written block this is the only sanctioned
 * way to widen an `offer` list. Without it the path to a new skill is somebody
 * remembering it exists.
 *
 * ## Resolve first, score second
 *
 * The hard-won ordering. Jev scores a skill's FIT and says nothing whatever
 * about whether an agent can reach it. Run by hand on 2026-09-21 against
 * Lumina, harbour and atlas-workspace, the design proposed eight
 * `disable-model-invocation: true` names — `fixing-accessibility`,
 * `userinterface-wiki`, `frontend-design`, `stripe-best-practices`,
 * `stripe-recurring-subscriptions`, `review-animations` among them. Every one
 * scored well on fit and reaches a lane as "no such skill". `afk stack lint`
 * caught them afterwards, which is the gate working and the wrong place to
 * catch them: a proposal a human pastes should never contain a name that
 * cannot load. So `suggestCandidates` runs the SAME `resolveSkill` the lint
 * runs, before a single question is written, and only survivors are scored.
 *
 * ## What it will not do
 *
 * - `offer` only. Never `always` — 5 of 116 skills crossed the bucket boundary
 *   when the Choice options were reversed, so the bucket is not stable enough
 *   to put a skill in a lane's context unasked.
 * - Never `notes`. Jev returns probabilities, never text.
 * - Writes nothing. It prints a block; a human pastes it.
 * - No fallback to `detect` when Jev is unreachable. A network blip must not
 *   silently swap a wide proposal for a narrow one — it exits non-zero.
 */

/**
 * The roles a proposal may name: every role the runner has except `supervisor`,
 * which is the one role that keeps `herdr` (`denySkills: []`) and is not a
 * builder anyone widens an `offer` list for.
 *
 * Derived from `ROLES` rather than written out, and the derivation is the
 * guard. FAIL DIRECTION: a hand-written list drifts silently against
 * `roles.mjs`, and a name that no longer matches makes
 * `ROLES[name]?.permissions?.denySkills ?? []` yield `[]` — the deny gate
 * failing OPEN, which is how `herdr` would reach a proposal. So this fails
 * CLOSED instead: an unknown role name throws at load rather than quietly
 * denying nothing.
 */
export const SUGGEST_ROLES = Object.keys(ROLES).filter((name) => name !== "supervisor");

const ROLE_JOB = {
  implementer: "Writes and changes the application code, tests and configuration for one ticket.",
  integrator: "Merges one finished lane branch into the shared branch and resolves conflicts.",
  verifier: "Reviews finished work against the ticket's written acceptance criteria and decides whether it genuinely passed.",
  fixer: "Repairs a lane whose checks failed.",
  reflector: "Writes one retrospective document about how the run went.",
  "plan-reviewer": "Reads the tickets before any code exists and judges whether they are coherent and correctly ordered.",
};

/**
 * Names already decided against, one per line, `#` for a comment.
 *
 * Everything mechanical is filtered before this: bound, unreachable, denied,
 * duplicate, and the three gates. What reaches here resolves, is on-stack and
 * is not redundant — and is still not wanted. That is a JUDGEMENT, and this
 * file is the only place one can be recorded, so without it the same reject is
 * proposed every run and the command trains its reader to skim.
 *
 * Written by whoever trims the proposal, which in this estate is usually an
 * agent rather than a person: the same five names were rejected across three
 * repos in one session and none was recorded. Append the name AND the reason —
 * a bare name is re-litigated, a reason is not. Nothing here writes this file;
 * `suggest` only reads it.
 */
for (const name of SUGGEST_ROLES) {
  if (!ROLE_JOB[name]) throw new Error(`No ROLE_JOB description for role "${name}" — Jev would be asked about an empty job.`);
}

const IGNORE_FILE = join(".afk-setup", "suggest-ignore.txt");

export const loadSuggestIgnore = (projectRoot = root) => {
  let text;
  try { text = readFileSync(join(projectRoot, IGNORE_FILE), "utf8"); } catch { return new Set(); }
  const lines = text.split("\n").map((line, at) => ({ at: at + 1, raw: line }))
    .filter(({ raw }) => raw.trim() && !raw.trim().startsWith("#"));
  // A bare name gets re-litigated — the doc says so, and then the next agent
  // re-derives the reasoning or pastes the skill back. The reason is the entry.
  const bare = lines.filter(({ raw }) => !raw.includes("#"));
  if (bare.length) {
    throw new Error(
      `${IGNORE_FILE} has ${bare.length} entr${bare.length === 1 ? "y" : "ies"} with no reason:\n`
      + bare.map(({ at, raw }) => `  line ${at}: ${raw.trim()}`).join("\n")
      + "\n  Write the reason after a # on the same line. A bare name gets re-litigated\n"
      + "  by whoever reads this next; a reason does not.",
    );
  }
  const named = lines.map(({ raw }) => raw.replace(/#.*/, "").trim()).filter(Boolean);
  // Normalised BOTH ways, like `bound`. Writing `pstack:blast-radius` in the
  // file used to suppress only that spelling — and because the collapse runs
  // afterwards, the bare `blast-radius` twin was promoted into its place, so
  // the skill a human had just rejected came back in the very next proposal.
  // An ignore entry names a SKILL, not one of its two spellings.
  return new Set(named.flatMap((name) => [name, name.split(":").pop()]));
};

/** Every `<name>` with a `SKILL.md`, across the plugin dirs and the four stores. */
export const installedSkillNames = (projectRoot = root) => {
  const names = new Set();
  const note = (name) => names.add(name);
  for (const [plugin, state] of Object.entries(pluginSkillDirs(projectRoot))) {
    if (!state.root) continue;
    for (const dir of ["skills", "commands"]) {
      let entries = [];
      try { entries = readdirSync(join(state.root, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const skill = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, "");
        if (entry.isFile() && !entry.name.endsWith(".md")) continue;
        note(`${plugin}:${skill}`);
      }
    }
  }
  for (const store of skillStores(projectRoot)) {
    let entries = [];
    try { entries = readdirSync(store, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (existsSync(join(store, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return names;
};

/**
 * The roster Jev is allowed to see: installed, resolvable, model-invocable, not
 * already bound anywhere in this repo's `roles:`, denied to NO role (the union
 * of every role's `denySkills`, so one role's deny is enough), not on the
 * ignore list. Each exclusion is COUNTED and returned, because a
 * candidate silently missing from a proposal is indistinguishable from one the
 * model rejected.
 */
export const suggestCandidates = (
  projectRoot = root,
  config = loadConfig(projectRoot),
  // Injectable so a test can hand in a store/plugin name pair without building
  // a plugin install cache in a tmpdir. Nothing else passes it.
  { installed = installedSkillNames(projectRoot), describe = skillDescription, resolve = resolveSkill } = {},
) => {
  // Normalised on BOTH sides. A repo binding `pstack:blast-radius` already has
  // that skill, so the bare `blast-radius` in the store is not a candidate —
  // stripping the prefix off the candidate alone let it through to be scored
  // and caught by the `marginal` gate, which is a model call standing in for a
  // string comparison. Measured on Lumina: four names reached Jev this way.
  const bound = new Set(skillNamesIn(config?.roles)
    .flatMap(({ name }) => [name, name.split(":").pop()]));
  const ignored = loadSuggestIgnore(projectRoot);
  const denied = new Set(SUGGEST_ROLES.flatMap((name) => {
    const permissions = ROLES[name]?.permissions;
    if (!permissions) throw new Error(`No role "${name}" in roles.mjs — the deny gate would pass everything.`);
    return permissions.denySkills ?? [];
  }));
  const context = { pluginDirs: pluginSkillDirs(projectRoot), stores: skillStores(projectRoot) };
  const dropped = { bound: [], ignored: [], denied: [], unreachable: [], duplicate: [] };
  const candidates = [];
  for (const name of [...installed].sort()) {
    if (bound.has(name) || bound.has(name.split(":").pop())) { dropped.bound.push(name); continue; }
    if (ignored.has(name) || ignored.has(name.split(":").pop())) { dropped.ignored.push(name); continue; }
    if (denied.has(name.split(":").pop())) { dropped.denied.push(name); continue; }
    const resolved = resolve(name, context);
    if (!resolved.ok) { dropped.unreachable.push({ name, reason: resolved.reason }); continue; }
    const description = describe(name, context);
    if (!description) { dropped.unreachable.push({ name, reason: "no description in its frontmatter" }); continue; }
    candidates.push({ name, description });
  }
  const collapsed = collapseDuplicates(candidates);
  return { candidates: collapsed.candidates, dropped: { ...dropped, duplicate: collapsed.duplicate } };
};

/**
 * One skill, one candidate. The store and an enabled plugin routinely carry the
 * same skill under `x` and `<plugin>:x` — the store is where the editor edits
 * it and the plugin is how it ships — and scoring both proposes a block that
 * loads it twice, the exact clash `setup-coduo-agents` warns about. Measured on
 * atlas-workspace: `typescript-best-practices` and
 * `principle-separate-before-serializing-shared-state` each came back under two
 * names in one proposal.
 *
 * The qualified name wins. A bare name resolves only through this machine's
 * store, so it is the one that vanishes on a partner's checkout; the plugin
 * form says where the skill comes from and travels.
 *
 * This runs AFTER resolution, never before. An unqualified name backed by the
 * store must not be shadowed by a `<plugin>:<name>` whose plugin this repo does
 * not enable — that would collapse a reachable candidate into an unreachable
 * one and propose nothing where something was available.
 */
export const collapseDuplicates = (candidates) => {
  const kept = new Map();
  const duplicate = [];
  for (const candidate of candidates) {
    const key = candidate.name.split(":").pop();
    const rival = kept.get(key);
    if (!rival) { kept.set(key, candidate); continue; }
    const [winner, loser] = rival.name.includes(":") ? [rival, candidate] : [candidate, rival];
    kept.set(key, winner);
    duplicate.push({ name: loser.name, keptAs: winner.name });
  }
  return { candidates: [...kept.values()], duplicate };
};

/** A skill's own one-line `description:`, which is all Jev is shown of it. */
export const skillDescription = (name, context) => {
  const paths = name.includes(":")
    ? (() => {
        const [plugin, skill] = name.split(":");
        const state = context.pluginDirs[plugin];
        return state?.root ? pluginSkillCandidates(state.root, plugin, skill) : [];
      })()
    : context.stores.map((dir) => join(dir, name, "SKILL.md"));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const match = /^description:\s*(.+?)\s*$/m.exec(readFileSync(path, "utf8").slice(0, 4000));
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
};

/**
 * The `state` Jev is asked about, derived — never hand-written per repo. The
 * absent list is the marker vocabulary minus what this repo actually has, and
 * it is the field that does the most work: without it every iOS skill scores
 * well on a Next.js repo, because the question "would this help an
 * implementer" is true in the abstract for almost anything.
 */
export const suggestState = (projectRoot = root, config = loadConfig(projectRoot)) => {
  const alreadyBound = [...new Set(skillNamesIn(config?.roles).map(({ name }) => name))].sort();
  const report = detect(projectRoot);
  const seen = new Set([...report.stacks, ...report.plugins]);
  const absent = Object.keys(loadStackMarkers()).filter((name) => !seen.has(name));
  const checks = [config?.defaultChecks, config?.baselineChecks].flat().filter(Boolean);
  // The REAL allowlist, not the phrase "an allowlist". Every role that declares
  // hosts declares them here, and a skill whose whole job is reading the open
  // web — `research` is the recurring one — scores differently against three
  // named hosts than against an abstraction. Derived, so no repo maintains it
  // twice: this is the same list the runner renders as
  // `sandbox.network.allowedDomains`.
  const hosts = [...new Set(Object.values(config?.roles ?? {}).flatMap((role) => role?.network ?? []))].sort();
  return {
    repo: `This repository is built with: ${report.stacks.join(", ") || "no stack this runner recognises"}.`,
    absent_from_this_repository: absent.length
      ? `None of these appear anywhere in this repository: ${absent.join(", ")}.`
      : "Every stack this runner recognises appears in this repository.",
    checks_a_lane_runs: checks.length ? checks.join(" ; ") : "no checks are configured",
    // The `marginal` question quotes this key by name, so it is assembled HERE
    // with the rest of the state. Appended by the caller it went missing for
    // anyone calling `suggestState` directly, and Jev was asked to compare a
    // skill against a field the state did not carry.
    skills_the_agent_already_has: alreadyBound.join(", ") || "none",
    what_an_afk_lane_is:
      "An unattended agent handed one ticket. It edits files in a git worktree, runs the checks above, and writes a report. No human is present at any point.",
    lane_limits:
      "No human to answer a question or look at a screen. No physical device. No interactive terminal. No web browser driven by a person. It cannot install packages."
      + (hosts.length
        ? ` The ONLY hosts it can reach over the network are: ${hosts.join(", ")}. Every other host, including any documentation site, package registry or search engine, is refused.`
        : " It has no network access at all: every host is refused."),
    roles: Object.fromEntries(SUGGEST_ROLES.map((name) => [name, ROLE_JOB[name]])),
  };
};

const questionId = (name) => name.replace(/[^a-z0-9]/gi, "_").toLowerCase();

/** The one place an answer key for a role's score is spelled. */
const roleKey = (role) => `role__${questionId(role)}`;

/**
 * Eight questions per candidate, every one answerable by someone shown only the
 * state and that question. The wide question — "which role should get this?" —
 * is the one Jev is worst at, so it is never asked: code combines the
 * observations below into the verdict.
 */
export const suggestQuestions = (candidate, index = 0) => {
  const base = { skill_name: candidate.name, what_the_skill_does: candidate.description.slice(0, 600) };
  // The index, not the name alone, is what makes this injective. `questionId`
  // folds `:` and `-` to `_`, so `pstack:blast-radius` and a hypothetical
  // `pstack-blast-radius` produced ONE id and silently traded answers inside a
  // chunk. Ids never reach the model, so the prefix costs nothing.
  const id = `q${index}_${questionId(candidate.name)}`;
  const questions = {
    [`${id}__offstack`]: { type: "noul", instructions: { ...base, question:
      "Is this skill SPECIFIC to one of the technologies listed in `absent_from_this_repository` — so specific that its guidance would have nothing to say about the technologies in `repo`? Answer true only for that case. Answer false for a skill about a process, a way of working, reviewing, testing, diagnosing or writing, whichever technology its examples happen to name." } },
    [`${id}__needs_human`]: { type: "noul", instructions: { ...base, question:
      "Does following this skill REQUIRE at least one of the things listed in `lane_limits` — a human answering a question, a human looking at a screen, a physical device, an interactive terminal, a web browser, or a network host outside the allowlist? Answer false when the skill can be carried out by reading files, editing files, and running the commands in `checks_a_lane_runs`, even if it mentions screens or users in passing." } },
    [`${id}__marginal`]: { type: "noul", instructions: { ...base, question:
      "An agent already has every skill listed in `skills_the_agent_already_has`. Would adding this skill change what that agent does, rather than repeating guidance it already has?" } },
  };
  for (const role of SUGGEST_ROLES) {
    questions[`${id}__${roleKey(role)}`] = { type: "noul", instructions: { ...base,
      role_name: role, role_job: ROLE_JOB[role], question:
      "Would this skill improve the work described in `role_job`, as that work happens in this repository? Answer only about that one role's job; ignore whether the skill would help some other role." } };
  }
  return questions;
};

/** Every gate a candidate must clear before any role score is read. */
export const SUGGEST_THRESHOLDS = { offstack: 0.5, needs_human: 0.5, marginal: 0.5, role: 0.6 };

/**
 * Observations in, `offer` lists out. Deliberately a plain AND over three gates
 * and one per-role score: the thresholds are the policy, they live here in code
 * where they can be read and changed, and no part of the verdict is the model's.
 */
export const combineSuggestions = (scored, thresholds = SUGGEST_THRESHOLDS) => {
  const roles = Object.fromEntries(SUGGEST_ROLES.map((role) => [role, []]));
  const rejected = [];
  for (const { name, answers } of scored) {
    const gates = {
      offstack: (answers.offstack ?? 1) < thresholds.offstack,
      needs_human: (answers.needs_human ?? 1) < thresholds.needs_human,
      marginal: (answers.marginal ?? 0) >= thresholds.marginal,
    };
    const failed = Object.entries(gates).filter(([, ok]) => !ok).map(([gate]) => gate);
    const best = Math.max(...SUGGEST_ROLES.map((role) => answers[roleKey(role)] ?? 0));
    if (failed.length) { if (best >= thresholds.role) rejected.push({ name, failed, best }); continue; }
    for (const role of SUGGEST_ROLES) {
      const score = answers[roleKey(role)] ?? 0;
      if (score >= thresholds.role) roles[role].push({ name, score });
    }
  }
  for (const role of SUGGEST_ROLES) roles[role].sort((a, b) => b.score - a.score);
  return { roles, rejected: rejected.sort((a, b) => b.best - a.best) };
};

/**
 * The one network call. Isolated so every other export above is testable with
 * no key and no socket, and so the failure below has exactly one place to live.
 */
/**
 * Retried only where retrying is honest. A 429 or a 5xx is the service asking
 * for a moment — the docs say rate limits move without notice and tell callers
 * to honour `retry-after` — and a 24-request run that throws away twenty good
 * answers over one blip helps nobody. Observed live on Lumina: one run exited
 * non-zero mid-sweep and the identical run straight after it succeeded.
 *
 * Everything else still fails on the first answer, and an exhausted retry still
 * exits non-zero. This narrows WHICH failures are transient; it does not soften
 * §18's rule that no Jev means no proposal.
 */
const RETRYABLE = (status) => status === 429 || status >= 500;
const ATTEMPTS = 3;

export const askJev = async (state, questions, { key = process.env.TYPESAFE_API_KEY, model = "jev-1.13.0", fetchImpl = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) => {
  if (!key) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. `afk stack suggest` needs Jev and has no offline mode:\n"
      + "  falling back to `afk stack detect` would silently swap a wide proposal for a\n"
      + "  narrow one, which is the failure this command exists to end.",
    );
  }
  const body = JSON.stringify({ state, model, questions });
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      last = new Error(`Jev could not be reached: ${error.message}`);
      if (attempt === ATTEMPTS) break;
      await sleep(1000 * attempt);
      continue;
    }
    if (response.ok) return response.json();
    last = new Error(`Jev answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 400)}`);
    if (!RETRYABLE(response.status) || attempt === ATTEMPTS) break;
    const after = Number(response.headers?.get?.("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * attempt);
  }
  throw last;
};

/**
 * Chunked by QUESTIONS, not by state: one request carries the state plus every
 * question inside one budget, and repeating the state across requests re-ingests
 * and re-charges it. 12 candidates is 108 questions, comfortably inside the 64k
 * budget for the descriptions this estate has.
 */
const CHUNK = 12;

export const scoreCandidates = async (state, candidates, options = {}) => {
  const scored = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const questions = Object.assign({}, ...chunk.map((candidate, at) => suggestQuestions(candidate, at)));
    const body = await askJev(state, questions, options);
    const answers = body.answers ?? body;
    for (const [at, candidate] of chunk.entries()) {
      const prefix = `q${at}_${questionId(candidate.name)}__`;
      scored.push({
        name: candidate.name,
        answers: Object.fromEntries(Object.keys(questions)
          .filter((key) => key.startsWith(prefix))
          .map((key) => [key.slice(prefix.length), answers[key]?.noul])),
      });
    }
    options.onChunk?.(Math.min(i + CHUNK, candidates.length), candidates.length);
  }
  return scored;
};

/**
 * Refuse to write into a working tree that already has changes under
 * `.afk-setup/`. Not a lock and not a substitute for one: it is the cheapest
 * check that makes the write attributable, which is the thing that failed when
 * two sessions shared a checkout and one session's config edits ended up inside
 * the other's commit.
 */
export const afkSetupIsDirty = (projectRoot) => {
  const status = run("git status --porcelain -- .afk-setup", { cwd: projectRoot });
  return String(status?.stdout ?? "").trim();
};

export const suggest = async (projectRoot = root, options = {}) => {
  const config = loadConfig(projectRoot);
  const { candidates, dropped } = suggestCandidates(projectRoot, config);
  const state = suggestState(projectRoot, config);
  if (options.dryRun) return { dryRun: true, candidates, dropped, state };
  const scored = await scoreCandidates(state, candidates, options);
  return { ...combineSuggestions(scored), candidates, dropped, state, scored };
};

/**
 * ## `--write`, and why the merge is TEXTUAL
 *
 * §18 said "writes nothing. Prints candidates for a human to paste." That
 * constraint was never principled here and it cost real work: §16's "neither
 * machine's config is ever written by an agent" was broken the same day by
 * Step 5, which made `setup-coduo-agents` model-invocable with a merge-or-refuse
 * step 8 — so agents already write `roles:`. `suggest` only made them do it by
 * hand, unaudited, and on 2026-09-21 a hand-pasted block in atlas-workspace was
 * lost to another session's branch switch because it sat uncommitted.
 *
 * Parsing and re-emitting the file is not an option. `.afk-setup/config.yaml`
 * in this estate is two hundred lines of comments recording WHY each check and
 * host is there — measurements, incident numbers, rulings — and
 * `parseYamlSubset` → `toYamlSubset` would return a correct file with every one
 * of them gone. So the merge edits the `offer:` line in place and every other
 * byte is untouched.
 *
 * What it will not do, each one a refusal rather than a best effort:
 * - Touch `always`, `notes`, or any key but `offer`.
 * - Remove a name. It is a set union; a name already there is left alone.
 * - Create a role. An absent role is `detect`'s job, not this one.
 * - Write into a dirty `.afk-setup/`. Two agents in one checkout is how the
 *   last edits were lost, and a clean tree is the cheapest thing that makes
 *   the write attributable.
 */
const OFFER_INLINE = (role) => new RegExp(`(^ {2}${role}:\\n(?: {4}[^\\n]*\\n| *#[^\\n]*\\n)*? {4}offer: \\[)([^\\]]*)(\\])`, "m");
const OFFER_BLOCK = (role) => new RegExp(`(^ {2}${role}:\\n(?: {4}[^\\n]*\\n| *#[^\\n]*\\n)*? {4}offer:\\n(?: {4}- [^\\n]*\\n)*)`, "m");

export const mergeOffers = (text, additions) => {
  let merged = text;
  const applied = [];
  const refused = [];
  for (const [role, names] of Object.entries(additions)) {
    if (!names.length) continue;
    if (!new RegExp(`^ {2}${role}:$`, "m").test(merged)) {
      refused.push({ role, reason: "no such role in this config — `afk stack detect` creates roles, this does not" });
      continue;
    }
    const inline = OFFER_INLINE(role).exec(merged);
    if (inline) {
      const present = new Set(inline[2].split(",").map((n) => n.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      const fresh = names.filter((n) => !present.has(n));
      if (!fresh.length) { applied.push({ role, added: [] }); continue; }
      merged = merged.replace(OFFER_INLINE(role),
        (_, head, body, tail) => `${head}${body}${body.trim() ? ", " : ""}${fresh.map(quoteIfNeeded).join(", ")}${tail}`);
      applied.push({ role, added: fresh });
      continue;
    }
    const block = OFFER_BLOCK(role).exec(merged);
    if (block) {
      const present = new Set([...block[1].matchAll(/^ {4}- (.+)$/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, "")));
      const fresh = names.filter((n) => !present.has(n));
      if (!fresh.length) { applied.push({ role, added: [] }); continue; }
      merged = merged.replace(OFFER_BLOCK(role), (whole) => whole + fresh.map((n) => `    - ${quoteIfNeeded(n)}\n`).join(""));
      applied.push({ role, added: fresh });
      continue;
    }
    refused.push({ role, reason: "the role exists but declares no `offer:` key — add an empty one by hand, so the shape is yours" });
  }
  return { text: merged, applied, refused };
};

/** A plugin-qualified name carries a colon, which bare YAML reads as a mapping. */
const quoteIfNeeded = (name) => (name.includes(":") ? `"${name}"` : name);

const CONFIG_PATH = join(".afk-setup", "config.yaml");

/**
 * Merge the proposal into the repo's config and say what to do next. Returns
 * the report; the caller prints it. Refuses loudly rather than half-writing.
 */
export const writeSuggest = (projectRoot, report) => {
  const dirty = afkSetupIsDirty(projectRoot);
  if (dirty) {
    throw new Error(
      `${CONFIG_PATH.split("/")[0]}/ already has uncommitted changes:\n${dirty.split("\n").map((l) => `  ${l}`).join("\n")}\n`
      + "  Refusing to write into it. Commit or stash those first — an edit that\n"
      + "  lands on top of somebody else's is how the last one was lost.",
    );
  }
  const additions = Object.fromEntries(Object.entries(report.roles)
    .map(([role, list]) => [role, list.map(({ name }) => name)]));
  const path = join(projectRoot, CONFIG_PATH);
  const before = readFileSync(path, "utf8");
  const { text, applied, refused } = mergeOffers(before, additions);
  if (text !== before) atomicWrite(path, text);
  return { applied, refused, changed: text !== before };
};

export const renderWrite = ({ applied, refused, changed }) => [
  changed
    ? `Merged into ${CONFIG_PATH}:\n`
      + applied.filter(({ added }) => added.length)
        .map(({ role, added }) => `  ${role}.offer += ${added.join(", ")}`).join("\n")
    : `Nothing to merge — every proposed name is already in ${CONFIG_PATH}.`,
  applied.some(({ added }) => !added.length)
    ? `\n  Already present, left alone: ${applied.filter(({ added }) => !added.length).map(({ role }) => role).join(", ")}`
    : null,
  refused.length
    ? "\nRefused:\n" + refused.map(({ role, reason }) => `  ${role} — ${reason}`).join("\n")
    : null,
  changed
    ? "\nOnly `offer` was touched; nothing was removed and no comment moved. Check it,"
      + "\nthen commit it NOW rather than later — an uncommitted config never reaches a"
      + "\nlane worktree, and in a shared checkout it is lost or attributed to someone"
      + "\nelse:\n\n"
      + `  git add ${CONFIG_PATH} && git commit -m "afk: widen role offers from afk stack suggest"\n`
      + "\nNames you did NOT want go in .afk-setup/suggest-ignore.txt with a # reason,"
      + "\nor the next run proposes them again."
    : null,
].filter((line) => line !== null).join("\n");

export const renderSuggest = (report) => {
  const counted = [
    `${report.candidates.length} candidates ${report.dryRun ? "would be scored" : "scored"}`,
    `${report.dropped.bound.length} already bound`,
    `${report.dropped.unreachable.length} unreachable`,
    `${report.dropped.denied.length} denied to a role`,
    `${report.dropped.ignored.length} on the ignore list`,
    `${report.dropped.duplicate.length} the same skill under a second name`,
  ].join(", ");
  if (report.dryRun) {
    return [
      `Dry run — Jev was not called. ${counted}.`,
      "",
      "Unreachable, and therefore never offered to the model:",
      ...report.dropped.unreachable.map(({ name, reason }) => `  ${name}\n    ${reason}`),
    ].join("\n");
  }
  const roles = Object.fromEntries(Object.entries(report.roles)
    .filter(([, list]) => list.length)
    .map(([role, list]) => [role, { offer: list.map(({ name }) => name) }]));
  return [
    counted + ".",
    report.rejected.length
      ? "\nScored well for a role but stopped by a gate — read before overriding:\n"
        + report.rejected.map(({ name, failed, best }) =>
          `  ${best.toFixed(2)}  ${name} — ${failed.join(", ")}`).join("\n")
      : null,
    "\nMERGE these `offer` lists into .afk-setup/config.yaml — do not replace the\n"
      + "block. `offer` only: nothing here is proposed for `always` or `notes`.\n"
      + `Then run \`afk stack lint\`. Names you reject belong in ${IGNORE_FILE},\n`
      + "one per line, or this command proposes them again next time.\n",
    Object.keys(roles).length ? toYamlSubset({ roles }).trimEnd() : "  (nothing cleared every gate)",
  ].filter((line) => line !== null).join("\n");
};

/**
 * The two rules a `.afk-setup/config.yaml` needs that nothing else states, as
 * comments that survive the paste. Both are about keys this proposal does NOT
 * write — which is the point: this is the moment a human has the file open.
 */
const CONFIG_RULES = [
  "# Two rules for the keys you write by hand, which nothing else will tell you:",
  "#",
  "# defaultChecks is the PER-LANE list. Lanes run in parallel, so name the host",
  "#   singleton each command touches — a database, a fixed port, a simulator, a",
  "#   derived-data path — and either key it off $PWD or hoist it into",
  "#   baselineChecks. Two lanes reaching one shared thing is the failure that",
  "#   looks like a flaky test.",
  "#",
  "# baselineChecks is read ALONE by the branch-cut baseline and by the fix gate,",
  "#   and unioned with defaultChecks at integration (unless integrationChecks",
  "#   is set, which replaces it there). So write it as the FULL",
  "#   list including the lane commands, not as the extras — it is not a",
  "#   supplement, and a partial list silently narrows two of the three gates.",
].join("\n");

export const renderDetect = (report) => [
  `Enabled plugins (${report.plugins.length}): ${report.plugins.join(", ") || "none"}`,
  `Stacks seen in the repo (${report.stacks.length}): ${report.stacks.join(", ") || "none"}`,
  report.unmapped.length
    ? `\nNo role bindings shipped for: ${report.unmapped.join(", ")}\n`
      + "  These contribute nothing until plugin-roles.yaml gains an entry."
    : null,
  report.missingPlugins.length
    ? `\nIn the repo but not enabled as a plugin: ${report.missingPlugins.join(", ")}\n`
      + "  Run setup-coduo-agents to enable them, then run this again."
    : null,
  report.uncovered.length
    ? `\nSeen in the repo but contributing nothing: ${report.uncovered.join(", ")}\n`
      + "  No plugin covers these, so the block below says nothing about them.\n"
      + "  Add a `notes:` line by hand if a builder needs to know."
    : null,
  report.worktreeSetup?.setup.link.length
    ? "\nThis is a node project. The verifier runs the stack's gates (tests,\n"
      + "  typecheck, build, lint) in a disposable checkout with the npm registry\n"
      + "  network-denied, so without `node_modules` linked in it can install\n"
      + "  nothing and every gate reports 'did not run'. `link:` symlinks the\n"
      + "  deps from the main checkout — no install, no extra storage, offline.\n"
      + "  The proposal below includes it; keep it or the closeout runs blind."
      + (report.worktreeSetup.pnpmRelinks
        ? "\n  pnpm NOTE: its pre-run check reinstalls over a symlinked node_modules.\n"
          + "  That is why coduo-billing-infra's gates call node_modules/.bin/tsc\n"
          + "  directly rather than going through a pnpm script."
        : "")
    : null,
  report.worktreeSetup?.pm
    ? `\nThis project depends on \`next\`, so the proposal does NOT link node_modules.\n`
      + "  Turbopack is the `next build` default from Next 16 and refuses a symlinked\n"
      + "  node_modules outright — harbour measured a fresh install at 4.1s per lane\n"
      + "  and switched. The install runs in the runner process, outside the agent's\n"
      + `  network sandbox. Package manager: ${report.worktreeSetup.pm.name}, from ${report.worktreeSetup.pm.from}.`
    : null,
  report.alsoSeenUnder.length
    ? `\nAlso carrying their own package.json: ${report.alsoSeenUnder.map((dir) => `${dir}/`).join(", ")}\n`
      + "  Not counted as a stack and not linked: the proposal below describes the\n"
      + "  ROOT of this repo. If a lane needs to build in one of these, say so in\n"
      + "  `notes:` or give it its own worktreeSetup entry by hand."
    : null,
  report.deadNames?.length
    ? `\nProposed but not installed on this host: ${report.deadNames.map((d) => d.name).join(", ")}\n`
      + "  Each fails silently in a lane as \"no such skill\". Drop them from the\n"
      + "  block below, or install the plugin at a scope this repo can see."
    : null,
  "\nProposed block for .afk-setup/config.yaml:\n",
  // These two rules ride INSIDE the block, because the block is pasted and a
  // prose line above it is not. They are the only part of `coduo-afk` Phase
  // S.3 that the runner does not already document at the code that implements
  // it: `teardown`/`finish` and the 21-devices incident are in worktree.mjs's
  // own comments, and the rest of S.3 is setup procedure rather than runner
  // mechanics. "singleton" appears nowhere in scripts/, and the
  // `baselineChecks ?? defaultChecks` reads (fixer.mjs:738, auto.mjs:1296)
  // carry no explanation of the three-gate semantics — so these two rules are
  // learnable today only by having been told.
  CONFIG_RULES,
  toYamlSubset(
    report.worktreeSetup
      ? { worktreeSetup: report.worktreeSetup.setup, roles: report.roles }
      : { roles: report.roles },
  ).trimEnd(),
].filter((line) => line !== null).join("\n");

if (isMainModule(import.meta.url)) {
  const projectRoot = root;
  const json = process.argv.includes("--json");
  // `stack` is a verb group: the sub-verb rides in as the first positional, the
  // same shape `wave` uses. `detect` stays the default so the existing command
  // is unchanged.
  const verb = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "detect";
  if (verb === "manifest") {
    const { manifest, unverified } = buildSkillManifest();
    if (process.argv.includes("--write")) {
      atomicWrite(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`Wrote ${MANIFEST_PATH}`);
    } else {
      console.log(JSON.stringify(manifest, null, 2));
    }
    if (unverified.length) {
      console.log(
        `\nCould not re-verify on this machine: ${unverified.join(", ")}.\n`
        + "  Their entries were carried over verbatim with their own provenance.\n"
        + "  That is the external-source case; do not delete them to make this quiet.",
      );
    }
    process.exit(0);
  }
  if (verb === "suggest") {
    // Top-level await: this file is ESM and this branch only runs as a CLI.
    // Any failure — no key, a 429, a socket — exits non-zero with the reason
    // and prints NOTHING else. There is deliberately no `detect` fallback.
    try {
      const write = process.argv.includes("--write");
      // Checked BEFORE the money is spent. Discovering a dirty tree after
      // twenty-four requests is a bill for nothing.
      if (write) {
        const dirty = afkSetupIsDirty(projectRoot);
        if (dirty) throw new Error(`.afk-setup/ already has uncommitted changes:\n${dirty.split("\n").map((l) => `  ${l}`).join("\n")}\n  Refusing to write into it. Commit or stash those first.`);
      }
      const report = await suggest(projectRoot, {
        dryRun: process.argv.includes("--dry-run"),
        onChunk: (done, total) => { if (!json) process.stderr.write(`\r  scored ${done}/${total}`); },
      });
      if (!json) process.stderr.write("\r\u001b[K");
      if (write && !report.dryRun) {
        const result = writeSuggest(projectRoot, report);
        console.log(renderWrite(result));
        process.exit(0);
      }
      console.log(json ? JSON.stringify(report, null, 2) : renderSuggest(report));
      process.exit(0);
    } catch (error) {
      if (!json) process.stderr.write("\r\u001b[K");
      console.error(`afk stack suggest: ${error.message}`);
      process.exit(1);
    }
  }
  if (verb === "lint") {
    const report = lint(projectRoot);
    console.log(json ? JSON.stringify(report, null, 2) : renderLint(report));
    // Non-zero on a dead name OR an unloadable plugin: this is a lint, and a
    // silent pass is what the command exists to end.
    process.exit(report.dead.length || report.unloadable.length ? 1 : 0);
  }
  const report = detect(projectRoot);
  console.log(json ? JSON.stringify(report, null, 2) : renderDetect(report));
}
