// scripts/stack.test.mjs — `afk stack detect`.
//
// The property worth defending here is that nothing is dropped silently. A
// plugin with no bindings and a stack with no plugin are both REPORTED; the
// alternative reads as "covered" when it is "nobody wrote that entry yet".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detect,
  detectStacks,
  enabledPlugins,
  loadPluginRoles,
  loadStackMarkers,
  buildSkillManifest,
  catalogueGaps,
  invocableNamesIn,
  loadSkillManifest,
  mergeRoles,
  packageManagerFor,
  renderDetect,
  unloadablePlugins,
  mergeOffers,
  loadSuggestIgnore,
  askJev,
  combineSuggestions,
  renderSuggest,
  suggestCandidates,
  suggestQuestions,
  suggestState,
  collapseDuplicates,
  SUGGEST_ROLES,
} from "./stack.mjs";
import { ROLES } from "./roles.mjs";
import { skillsFor } from "./roles.mjs";

const project = ({ plugins = {}, pkg = null, files = [] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-stack-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: plugins }));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
};

test("the plugin half of the settings key is what identifies a plugin", () => {
  // The same capability from two marketplaces is one capability.
  const dir = project({
    plugins: { "supabase@coduo-agents": true, "supabase@supabase-community": true, "vercel@official": true },
  });
  assert.deepEqual(enabledPlugins(dir), ["supabase", "vercel"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a plugin switched off is not enabled", () => {
  const dir = project({ plugins: { "vercel@official": true, "expo@coduo-agents": false } });
  assert.deepEqual(enabledPlugins(dir), ["vercel"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a repo with no .claude/settings.json reports no plugins rather than throwing", () => {
  // A project that has never run setup-coduo-agents is the normal first case.
  const dir = mkdtempSync(join(tmpdir(), "afk-stack-"));
  assert.deepEqual(enabledPlugins(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("stacks are seen from dependencies and from marker files alike", () => {
  const dir = project({
    pkg: { dependencies: { next: "15" }, devDependencies: { vitest: "2" } },
    files: ["supabase/config.toml", "Package.swift"],
  });
  const stacks = detectStacks(dir);
  assert.ok(stacks.includes("nextjs"));
  assert.ok(stacks.includes("vitest"));
  assert.ok(stacks.includes("supabase"), "a marker file counts even with no dependency");
  assert.ok(stacks.includes("swift"));
  rmSync(dir, { recursive: true, force: true });
});

test("the baseline applies to a project with no plugins at all", () => {
  // A Python repo or a scripts-only repo still wants `coduo-implement`.
  const roles = mergeRoles([]);
  assert.ok(roles.implementer.always.includes("coduo-implement"));
  assert.ok(roles.verifier.offer.includes("diagnosing-bugs"));
});

test("two plugins asking for the same skill produce one skill", () => {
  const pluginRoles = {
    _baseline: { implementer: { offer: ["shared"] } },
    a: { implementer: { offer: ["shared", "only-a"] } },
    b: { implementer: { offer: ["shared", "only-b"] } },
  };
  assert.deepEqual(mergeRoles(["a", "b"], pluginRoles).implementer.offer,
    ["shared", "only-a", "only-b"]);
});

test("notes from several plugins are kept, not overwritten by the last one", () => {
  // A repo can be Expo AND Supabase; losing one note loses half the context.
  const pluginRoles = {
    a: { implementer: { notes: ["note A"] } },
    b: { implementer: { notes: ["note B"] } },
  };
  const notes = mergeRoles(["a", "b"], pluginRoles).implementer.notes;
  assert.match(notes, /note A/);
  assert.match(notes, /note B/);
});

test("an enabled plugin with no bindings is reported, never passed over", () => {
  const dir = project({ plugins: { "paper-desktop@paper": true, "vercel@official": true } });
  const report = detect(dir);
  assert.deepEqual(report.unmapped, ["paper-desktop"]);
  assert.match(renderDetect(report), /No role bindings shipped for: paper-desktop/);
  rmSync(dir, { recursive: true, force: true });
});

test("a stack in the repo with no plugin enabled is reported as a gap", () => {
  const dir = project({ plugins: {}, pkg: { dependencies: { expo: "51", "posthog-js": "1" } } });
  const report = detect(dir);
  assert.deepEqual(report.missingPlugins, ["expo", "posthog"]);
  assert.match(renderDetect(report), /not enabled as a plugin: expo, posthog/);
  rmSync(dir, { recursive: true, force: true });
});

test("the proposed block is exactly what the runner would consume", () => {
  // detect and skillsFor must agree, or the command proposes a shape the
  // prompt layer ignores — which is how `notes` was silently dropped once.
  const dir = project({ plugins: { "supabase@coduo-agents": true } });
  const report = detect(dir);
  const text = skillsFor({ roles: report.roles }, "implementer");
  assert.match(text, /Apply these skills to every task/);
  assert.match(text, /supabase\/migrations/, "the notes reach the prompt");
  rmSync(dir, { recursive: true, force: true });
});

test("a node project is told to link node_modules, or the verifier runs blind", () => {
  // Without the link the closeout verifier's checkout has no deps and the npm
  // registry is network-denied, so every JS gate reports "did not run" — the
  // exact failure that shipped on voice-studio PRs. The proposal must carry it.
  const dir = project({ pkg: { dependencies: { zod: "^3" } } });
  const report = detect(dir);
  assert.equal(report.needsNodeModules, true);
  const text = renderDetect(report);
  assert.match(text, /network-denied/);
  assert.match(text, /worktreeSetup:\n {2}link: \[node_modules\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("a project with no package.json is not nagged about node_modules", () => {
  const dir = project({ files: ["main.swift"] });
  const report = detect(dir);
  assert.equal(report.needsNodeModules, false);
  assert.doesNotMatch(renderDetect(report), /worktreeSetup/);
  rmSync(dir, { recursive: true, force: true });
});

test("every shipped binding names a role the runner has", () => {
  // A typo here would be a whole plugin contributing nothing, silently.
  const pluginRoles = loadPluginRoles();
  for (const [plugin, entry] of Object.entries(pluginRoles)) {
    for (const roleName of Object.keys(entry)) {
      assert.doesNotThrow(() => skillsFor({ roles: { [roleName]: {} } }, roleName),
        `${plugin} names role "${roleName}"`);
    }
  }
});

test("every marker that names a plugin names one plugin-roles.yaml has", () => {
  const pluginRoles = loadPluginRoles();
  for (const [stack, marker] of Object.entries(loadStackMarkers())) {
    if (!marker.plugin) continue;
    assert.ok(pluginRoles[marker.plugin], `${stack} points at unknown plugin "${marker.plugin}"`);
  }
});

test("a stack no plugin covers is reported, not counted as covered", () => {
  // `missingPlugins` cannot catch these: it only reports a stack that HAS a
  // plugin to be missing. A Python or Swift repo would otherwise read a
  // baseline-only proposal as "nothing more to add".
  const dir = project({ plugins: {}, files: ["pyproject.toml", "Package.swift"] });
  const report = detect(dir);
  assert.deepEqual(report.uncovered.sort(), ["python", "swift"]);
  assert.deepEqual(report.missingPlugins, [], "neither names a plugin at all");
  assert.match(renderDetect(report), /contributing nothing: python, swift/);
  rmSync(dir, { recursive: true, force: true });
});

test("a stack whose plugin is enabled and mapped is not called uncovered", () => {
  const dir = project({
    plugins: { "supabase@coduo-agents": true },
    files: ["supabase/config.toml"],
  });
  assert.ok(!detect(dir).uncovered.includes("supabase"));
  rmSync(dir, { recursive: true, force: true });
});

// --- Marker matching, one level deep -----------------------------------------
//
// These fixtures are real git repos, because `detectStacks` reads `git ls-files`
// — gitignore-aware, and the only way `ios/Pods` and a vendored crate stay out
// without a prune list to maintain. The non-git fallback is tested too: every
// fixture above is a bare temp directory and still works.

const gitProject = ({ pkg = null, files = [], ignore = null } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-stack-git-"));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  if (ignore) writeFileSync(join(dir, ".gitignore"), ignore);
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  return dir;
};

test("a Lumina-shaped repo — Xcode project one level down — is swift, and is not a node project", () => {
  // It reported `stacks: none` before this: its manifests are all under
  // `prototype/`, and the old matcher only looked at the root. `web/` carries
  // its own package.json, which must NOT flip needsNodeModules — the root has
  // no node_modules, and bootstrapWorktree throws by name on a missing link
  // source, which is every lane dead at bootstrap.
  const dir = gitProject({
    files: ["prototype/project.yml", "prototype/Lumina.xcodeproj/project.pbxproj", "web/package.json"],
  });
  const report = detect(dir);
  assert.ok(report.stacks.includes("swift"));
  assert.equal(report.needsNodeModules, false, "a subdirectory manifest is not the root's");
  assert.deepEqual(report.alsoSeenUnder, ["web"]);
  assert.match(renderDetect(report), /Also carrying their own package.json: web\//);
  // The PROPOSAL must carry no link. Matching the bare word would hit the
  // advice line above it, which mentions worktreeSetup on purpose.
  assert.doesNotMatch(renderDetect(report), /worktreeSetup:\n/);
  rmSync(dir, { recursive: true, force: true });
});

test("a vendored crate and an Expo Pods project do not match a one-level pattern", () => {
  // atlas-workspace has src-tauri/vendor/sacp-tokio/Cargo.toml, and every Expo
  // app has ios/Pods/Pods.xcodeproj. Both are two levels down.
  //
  // What excludes them is the PATTERN — `*/Cargo.toml` is two segments and `*`
  // does not cross a `/` — not the depth cap in markerCandidates. Removing that
  // cap leaves this test green, which is honest: the cap is a bound on the size
  // of the candidate set, and nothing else. Do not read it as the exclusion.
  const dir = gitProject({
    files: ["src-tauri/vendor/sacp-tokio/Cargo.toml", "ios/Pods/Pods.xcodeproj/project.pbxproj"],
  });
  const stacks = detectStacks(dir);
  assert.ok(!stacks.includes("rust"), "a vendored crate is not this repo's stack");
  assert.ok(!stacks.includes("swift"), "CocoaPods' generated project is not an Apple app");
  rmSync(dir, { recursive: true, force: true });
});

test("a Tauri repo is rust AND tauri, from src-tauri/ one level down", () => {
  const dir = gitProject({
    pkg: { dependencies: { react: "19" } },
    files: ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"],
  });
  const stacks = detectStacks(dir);
  assert.ok(stacks.includes("rust"));
  assert.ok(stacks.includes("tauri"));
  rmSync(dir, { recursive: true, force: true });
});

test("a React Native app with an ios/ Xcode project is not tagged swift", () => {
  // Insurance, not a live fix: both RN repos in this estate gitignore ios/
  // entirely, so nothing triggers this today. The shapes are identical one
  // level down, and the root manifest is what tells them apart.
  const dir = gitProject({
    pkg: { dependencies: { expo: "51", "react-native": "0.76" } },
    files: ["ios/TravelLedger.xcodeproj/project.pbxproj"],
  });
  const stacks = detectStacks(dir);
  assert.ok(stacks.includes("react-native"));
  assert.ok(!stacks.includes("swift"), "the root manifest settles it");
  rmSync(dir, { recursive: true, force: true });
});

test("a gitignored directory contributes no marker", () => {
  // This is why it is `git ls-files` and not `find`. voice-studio's whole ios/
  // tree is ignored; a filesystem walk tags it swift.
  //
  // No `expo` or `react-native` in this fixture on purpose. The first version
  // of this test had both, and the react-native precedence rule below stripped
  // `swift` before the gitignore ever mattered — a filesystem walk passed it.
  // An insurance rule masking the test for the mechanism it insures is the
  // exact shape that makes a suite read green while defending nothing.
  const dir = gitProject({
    pkg: { dependencies: { react: "19" } },
    files: ["vendored/Legacy.xcodeproj/project.pbxproj"],
    ignore: "vendored/\n",
  });
  assert.ok(!detectStacks(dir).includes("swift"));
  rmSync(dir, { recursive: true, force: true });
});

test("a directory that is not a git checkout still detects root markers", () => {
  // `git ls-files` fails outside a repo. Falling back to the root-only test is
  // the old behaviour, which is right: detect writes nothing either way.
  const dir = project({ files: ["Package.swift"] });
  assert.ok(detectStacks(dir).includes("swift"));
  rmSync(dir, { recursive: true, force: true });
});

test("a repo nobody has committed yet still detects its stack", () => {
  // The regression d8b8900 shipped: `git ls-files` on a fresh `git init` with
  // nothing staged returns an EMPTY list at status 0, so the null fallback
  // never fires and detect reported `stacks: none`. That is exactly the
  // setup-at-project-start moment this command exists to serve.
  const dir = mkdtempSync(join(tmpdir(), "afk-stack-fresh-"));
  writeFileSync(join(dir, "Package.swift"), "");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.ok(detectStacks(dir).includes("swift"), "nothing staged is still a Swift project");
  rmSync(dir, { recursive: true, force: true });
});

test("an unstaged file in a gitignored directory is still ignored", () => {
  // `--others` without `--exclude-standard` would drag Pods and vendored trees
  // back in, which is the whole reason this is git and not `find`.
  const dir = mkdtempSync(join(tmpdir(), "afk-stack-fresh-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
  writeFileSync(join(dir, ".gitignore"), "vendored/\n");
  mkdirSync(join(dir, "vendored", "Legacy.xcodeproj"), { recursive: true });
  writeFileSync(join(dir, "vendored", "Legacy.xcodeproj", "project.pbxproj"), "");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.ok(!detectStacks(dir).includes("swift"));
  rmSync(dir, { recursive: true, force: true });
});

// --- The worktreeSetup predicate ---------------------------------------------
//
// This is the first proposal in this command that is FATAL rather than advisory
// when wrong: `bootstrapWorktree` throws by name on a missing `link:` source
// (scripts/worktree.mjs:207), so a false `link: [node_modules]` kills every lane
// in the repo at bootstrap — and a false `link: []` silently takes the deps away
// from lanes that need them.

test("a Next repo gets no symlink, and the install line in the same block", () => {
  // Turbopack is the `next build` default from Next 16 and refuses a symlinked
  // node_modules. `link: []` must be EXPLICIT: an absent worktreeSetup key makes
  // bootstrapWorktree return immediately (worktree.mjs:203) and the install
  // would never run. This reproduces harbour's committed block exactly.
  const dir = project({ pkg: { packageManager: "pnpm@11.26.0", dependencies: { next: "16.3.3" } } });
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  const report = detect(dir);
  assert.deepEqual(report.worktreeSetup.setup, { link: [], run: ["pnpm install --frozen-lockfile"] });
  const text = renderDetect(report);
  assert.match(text, /worktreeSetup:\n {2}link: \[\]\n {2}run:\n {2}- pnpm install --frozen-lockfile/);
  assert.doesNotMatch(text, /pnpm NOTE/, "there is no symlink left to warn about");
  rmSync(dir, { recursive: true, force: true });
});

test("a atlas-workspace-shaped repo keeps its link: next in a SUBDIRECTORY is not this repo's", () => {
  // The live shape, and the reason the predicate reads the root manifest and
  // nothing else: atlas-workspace has no `next` at the root, `next@^16` in
  // landing/package.json, and Tauri lanes that need the symlink. Step 2 put
  // trackedPaths within reach of this function, which is exactly the temptation.
  const dir = gitProject({
    pkg: { dependencies: { react: "19" } },
    files: ["landing/package.json", "src-tauri/Cargo.toml"],
  });
  writeFileSync(join(dir, "landing", "package.json"), JSON.stringify({ dependencies: { next: "^16.0.0" } }));
  const report = detect(dir);
  assert.deepEqual(report.worktreeSetup.setup, { link: ["node_modules"] });
  assert.deepEqual(report.alsoSeenUnder, ["landing"], "reported, never acted on");
  rmSync(dir, { recursive: true, force: true });
});

test("npm gets `npm ci`, because `npm install --frozen-lockfile` is not a thing", () => {
  // npm accepts unknown flags as config, so that line would run a plain
  // `npm install` — which can rewrite package-lock.json, a CHECK_INPUT_FILES
  // member. After Step 6 that is a bootstrap hook dirtying a protected file by
  // construction. atlas-workspace is npm and is one root `next` away from this.
  const dir = project({ pkg: { dependencies: { next: "16" } } });
  writeFileSync(join(dir, "package-lock.json"), "{}");
  assert.deepEqual(detect(dir).worktreeSetup.setup.run, ["npm ci"]);
  rmSync(dir, { recursive: true, force: true });
});

test("next in devDependencies counts", () => {
  // Insurance: both estate repos keep it in dependencies, but a devDeps-next
  // repo breaks under Turbopack in exactly the same way.
  const dir = project({ pkg: { devDependencies: { next: "16" } } });
  assert.deepEqual(detect(dir).worktreeSetup.setup.link, []);
  rmSync(dir, { recursive: true, force: true });
});

test("the packageManager field beats the lockfile, and lockfiles resolve in a fixed order", () => {
  // A repo that has accidentally collected two lockfiles must resolve the same
  // way every run, not by directory order.
  const declared = project({ pkg: { packageManager: "bun@1.3.14", dependencies: { next: "16" } } });
  writeFileSync(join(declared, "pnpm-lock.yaml"), "");
  assert.deepEqual(detect(declared).worktreeSetup.setup.run, ["bun install --frozen-lockfile"]);
  assert.equal(packageManagerFor(declared).from, "the packageManager field");

  const twoLocks = project({ pkg: { dependencies: { next: "16" } } });
  writeFileSync(join(twoLocks, "pnpm-lock.yaml"), "");
  writeFileSync(join(twoLocks, "package-lock.json"), "{}");
  assert.equal(packageManagerFor(twoLocks).name, "pnpm", "first in LOCKFILES order wins");
  rmSync(declared, { recursive: true, force: true });
  rmSync(twoLocks, { recursive: true, force: true });
});

test("a repo with no packageManager field falls back to the lockfile name", () => {
  // voice-studio-website is exactly this, so the fallback is load-bearing.
  const dir = project({ pkg: { dependencies: { next: "16.2.6" } } });
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  const pm = packageManagerFor(dir);
  assert.equal(pm.name, "pnpm");
  assert.equal(pm.from, "pnpm-lock.yaml");
  assert.match(renderDetect(detect(dir)), /Package manager: pnpm, from pnpm-lock\.yaml/);
  rmSync(dir, { recursive: true, force: true });
});

test("the pnpm relink warning rides with the LINK, never with the install", () => {
  // coduo-billing-infra's gates call node_modules/.bin/tsc directly because
  // pnpm's pre-run check reinstalls over a symlinked node_modules. A Next repo
  // has no symlink left, so the same warning there is noise.
  const linked = project({ pkg: { dependencies: { react: "19" } } });
  writeFileSync(join(linked, "pnpm-lock.yaml"), "");
  assert.match(renderDetect(detect(linked)), /pnpm NOTE/);
  rmSync(linked, { recursive: true, force: true });
});

// --- The catalogue guard ------------------------------------------------------
//
// `plugin-roles.yaml` has shipped a name nothing could load. Checking it against
// THIS host is wrong twice: a valid binding fails on a machine that has not
// installed the plugin (react-doctor, right here), and a wrong one passes on a
// machine holding a stale copy. So the assertion runs against the committed
// manifest — deterministic on every machine — and the staleness check, which can
// only be right where the source exists, is separated out below.

test("every skill the catalogue names exists in the committed manifest", () => {
  // Pure fixture, no host reads. Runs identically on a partner's machine.
  const gaps = catalogueGaps();
  assert.deepEqual(gaps, [],
    gaps.map((g) => `${g.name}: ${g.reason}`).join("\n"));
});

test("a catalogue binding for a plugin with no manifest entry fails by name", () => {
  // The drift guard: adding a binding for a new plugin must force a manifest
  // regeneration in the same commit rather than silently shipping a dead name.
  const gaps = catalogueGaps(
    { madeup: { implementer: { offer: ["madeup:whatever"] } } },
    loadSkillManifest(),
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].reason, /no manifest entry for plugin "madeup"/);
});

test("a plugin that ships no skills at all makes its bindings fail deterministically", () => {
  // vitest, expo and supabase are listed in marketplace.json and ship no
  // skills/ directory. Their manifest entry is an empty list, so a binding
  // naming one fails on EVERY machine — which is the react-doctor asymmetry
  // solved: valid-but-uninstalled passes, named-but-nonexistent fails.
  const gaps = catalogueGaps(
    { vitest: { verifier: { offer: ["vitest:vitest"] } } },
    { plugins: { vitest: { source: "marketplace checkout", skills: [] } } },
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].reason, /ships no invocable "vitest"/);
});

test("the manifest lists invocable names only, by the resolver's own rules", () => {
  // The manifest and resolveSkill must not disagree about what counts, or the
  // guard passes a name lint then calls dead. Same three-layout walk, same
  // disable-model-invocation filter.
  const dir = mkdtempSync(join(tmpdir(), "afk-manifest-"));
  mkdirSync(join(dir, "skills", "live"), { recursive: true });
  writeFileSync(join(dir, "skills", "live", "SKILL.md"), "---\nname: live\n---\n");
  mkdirSync(join(dir, "skills", "hidden"), { recursive: true });
  writeFileSync(join(dir, "skills", "hidden", "SKILL.md"),
    "---\nname: hidden\ndisable-model-invocation: true\n---\n");
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "cmd.md"), "# cmd\n");
  writeFileSync(join(dir, "commands", "slash-only.md"),
    "---\nname: slash-only\ndisable-model-invocation: true\n---\n");
  writeFileSync(join(dir, "SKILL.md"), "---\nname: thing\n---\n");
  assert.deepEqual(invocableNamesIn(dir, "thing"), ["cmd", "live", "thing"]);
  rmSync(dir, { recursive: true, force: true });
});

test("regeneration carries over a plugin this machine cannot see, never drops it", () => {
  // react-doctor is installed nowhere here. A partner regenerating must not
  // delete the entry and the provenance line that is the only evidence for it.
  const previous = {
    plugins: { "react-doctor": { source: "external: verified by gh api", skills: ["react-doctor"] } },
  };
  const { manifest, unverified } = buildSkillManifest({
    marketplace: "/nonexistent",
    installs: {},
    previous,
    pluginRoles: { x: { implementer: { offer: ["react-doctor:react-doctor"] } } },
  });
  assert.deepEqual(manifest.plugins["react-doctor"], previous.plugins["react-doctor"]);
  assert.deepEqual(unverified, ["react-doctor"]);
});


test("the two config rules ride INSIDE the pasted block, not above it", () => {
  // A prose line above the block is not pasted; a `#` line inside it is. These
  // are the only part of coduo-afk Phase S.3 the runner does not already
  // document at the code that implements it — "singleton" appears nowhere in
  // scripts/, and the `baselineChecks ?? defaultChecks` reads carry no
  // explanation of the three-gate semantics.
  const dir = project({ files: ["main.swift"] });
  const text = renderDetect(detect(dir));
  const block = text.slice(text.indexOf("Proposed block for"));
  assert.match(block, /^# defaultChecks is the PER-LANE list/m);
  assert.match(block, /^# baselineChecks is read ALONE/m);
  assert.match(block, /singleton/, "the rule nothing in scripts/ states");
  assert.ok(block.indexOf("# defaultChecks") < block.indexOf("roles:"),
    "the comments must precede the YAML so a paste carries them");
  rmSync(dir, { recursive: true, force: true });
});

test("the rules are emitted for a repo with no worktreeSetup too", () => {
  // They are about keys this proposal does not write, so they cannot be
  // attached to the node-project branch.
  const swift = project({ files: ["Package.swift"] });
  const node = project({ pkg: { dependencies: { zod: "^3" } } });
  for (const dir of [swift, node]) assert.match(renderDetect(detect(dir)), /^# defaultChecks/m);
  rmSync(swift, { recursive: true, force: true });
  rmSync(node, { recursive: true, force: true });
});

// --- `afk stack suggest` ----------------------------------------------------
//
// The property worth defending: a proposal never contains a name a lane cannot
// load. Jev scores FIT and is silent about reachability, so the resolver runs
// BEFORE any question is written — the ordering these tests pin. Everything
// except `askJev` is exercised with no key and no socket.

const suggestRepo = (skills, { config = "", ignore = null } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-suggest-"));
  mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
  mkdirSync(join(dir, ".afk-setup"), { recursive: true });
  for (const [name, front] of Object.entries(skills)) {
    mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n${front}\n---\n`);
  }
  writeFileSync(join(dir, ".afk-setup", "config.yaml"), config);
  if (ignore !== null) writeFileSync(join(dir, ".afk-setup", "suggest-ignore.txt"), ignore);
  return dir;
};

test("suggest: a human-only skill is dropped before it is ever scored", () => {
  const dir = suggestRepo({
    reachable: "description: A reachable one.",
    "human-only": "description: A human-only one.\ndisable-model-invocation: true",
  });
  try {
    const { candidates, dropped } = suggestCandidates(dir, {});
    assert.deepEqual(candidates.map((c) => c.name).filter((n) => n.startsWith("human") || n === "reachable"), ["reachable"]);
    const why = dropped.unreachable.find((d) => d.name === "human-only");
    assert.match(why.reason, /disable-model-invocation/);
    // The ordering itself: no question exists for a name the resolver refused.
    const ids = Object.keys(Object.assign({}, ...candidates.map(suggestQuestions)));
    assert.equal(ids.some((id) => id.startsWith("human_only__")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: already-bound, denied and ignored names are excluded and counted", () => {
  const dir = suggestRepo(
    { alpha: "description: A.", herdr: "description: B.", beta: "description: C.", gamma: "description: D." },
    { config: "roles:\n  implementer:\n    offer: [alpha]\n", ignore: "beta # not for this repo\n# a whole-line comment\n" },
  );
  try {
    const { candidates, dropped } = suggestCandidates(dir);
    const names = candidates.map((c) => c.name);
    assert.equal(names.includes("gamma"), true);
    for (const name of ["alpha", "beta", "herdr"]) assert.equal(names.includes(name), false);
    assert.equal(dropped.bound.includes("alpha"), true);
    assert.equal(dropped.ignored.includes("beta"), true);
    assert.equal(dropped.denied.includes("herdr"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: a failed gate suppresses a role score of 0.99", () => {
  const { roles, rejected } = combineSuggestions([
    { name: "offstack-skill", answers: { offstack: 0.9, needs_human: 0.1, marginal: 0.9, role__implementer: 0.99 } },
    { name: "good-skill", answers: { offstack: 0.1, needs_human: 0.1, marginal: 0.9, role__implementer: 0.99 } },
  ]);
  assert.deepEqual(roles.implementer.map((r) => r.name), ["good-skill"]);
  assert.deepEqual(rejected.map((r) => [r.name, r.failed]), [["offstack-skill", ["offstack"]]]);
});

test("suggest: nothing is ever proposed for `always` or `notes`", () => {
  const rendered = renderSuggest({
    candidates: [], dropped: { bound: [], unreachable: [], denied: [], ignored: [], duplicate: [] }, rejected: [],
    roles: { implementer: [{ name: "alpha", score: 0.9 }], verifier: [], integrator: [], fixer: [], reflector: [], "plan-reviewer": [] },
  });
  assert.match(rendered, /offer:/);
  assert.equal(/\balways:/.test(rendered), false);
  assert.equal(/^\s*notes:/m.test(rendered), false);
});

test("suggest: no key is a non-zero exit with the reason, never a detect proposal", async () => {
  await assert.rejects(
    () => askJev({}, {}, { key: "" }),
    (error) => /TYPESAFE_API_KEY is not set/.test(error.message) && /no offline mode/.test(error.message),
  );
  const dir = suggestRepo({ alpha: "description: A." });
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "stack.mjs"), "suggest"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "", AFK_PROJECT_ROOT: dir } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TYPESAFE_API_KEY is not set/);
    assert.equal(/Proposed block/.test(result.stdout), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: the absent-stack list is derived, not hand-written", () => {
  const dir = suggestRepo({ alpha: "description: A." });
  try {
    const state = suggestState(dir, {});
    assert.match(state.absent_from_this_repository, /swift/);
    assert.match(state.absent_from_this_repository, /rust/);
    assert.equal(Object.keys(state.roles).length, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: a plugin-qualified binding excludes the bare name, and the reverse", () => {
  const dir = suggestRepo(
    { "blast-radius": "description: A.", "show-me": "description: B.", keep: "description: C." },
    { config: "roles:\n  implementer:\n    offer: [\"pstack:blast-radius\", show-me]\n" },
  );
  try {
    const { candidates } = suggestCandidates(dir);
    const names = candidates.map((c) => c.name);
    assert.equal(names.includes("keep"), true);
    // Both directions: the bare name behind a qualified binding, and vice versa.
    assert.equal(names.includes("blast-radius"), false);
    assert.equal(names.includes("show-me"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: one skill is one candidate, and the qualified name wins", () => {
  const { candidates, duplicate } = collapseDuplicates([
    { name: "typescript-best-practices", description: "A." },
    { name: "pstack:typescript-best-practices", description: "A." },
    { name: "alpha", description: "B." },
  ]);
  assert.deepEqual(candidates.map((c) => c.name), ["pstack:typescript-best-practices", "alpha"]);
  assert.deepEqual(duplicate, [
    { name: "typescript-best-practices", keptAs: "pstack:typescript-best-practices" },
  ]);
});

test("suggest: an unreachable qualified name never shadows a reachable bare one", () => {
  const dir = suggestRepo({});
  try {
    const { candidates } = suggestCandidates(dir, {}, {
      installed: new Set(["alpha", "nope:alpha"]),
      describe: () => "A description.",
      resolve: (name) => name.includes(":") ? { ok: false, reason: "plugin \"nope\" is not enabled for this repo" } : { ok: true },
    });
    assert.deepEqual(candidates.map((c) => c.name), ["alpha"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: suggestCandidates actually applies the collapse", () => {
  const dir = suggestRepo({});
  try {
    const { candidates, dropped } = suggestCandidates(dir, {}, {
      installed: new Set(["typescript-best-practices", "pstack:typescript-best-practices"]),
      describe: () => "A description.",
      resolve: () => ({ ok: true }),
    });
    assert.deepEqual(candidates.map((c) => c.name), ["pstack:typescript-best-practices"]);
    assert.deepEqual(dropped.duplicate, [
      { name: "typescript-best-practices", keptAs: "pstack:typescript-best-practices" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: an ignored skill stays ignored under its other spelling", () => {
  const dir = suggestRepo({}, { ignore: "pstack:blast-radius # already covered by the bound copy\n" });
  try {
    // The bug this pins: the ignore matched one spelling, the collapse then
    // promoted the bare twin, and the skill a human had just rejected came
    // straight back in the next proposal.
    const { candidates, dropped } = suggestCandidates(dir, {}, {
      installed: new Set(["blast-radius", "pstack:blast-radius", "keep"]),
      describe: () => "A description.",
      resolve: () => ({ ok: true }),
    });
    assert.deepEqual(candidates.map((c) => c.name), ["keep"]);
    assert.deepEqual(dropped.ignored.sort(), ["blast-radius", "pstack:blast-radius"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("suggest: two names differing only in separator get different question ids", () => {
  const ids = (candidate, index) => Object.keys(suggestQuestions(candidate, index));
  const a = ids({ name: "pstack:blast-radius", description: "A." }, 0);
  const b = ids({ name: "pstack-blast-radius", description: "B." }, 1);
  // questionId folds `:` and `-` to `_`, so without the index these two share
  // every id and trade answers inside a chunk.
  assert.equal(a.some((id) => b.includes(id)), false);
});

test("suggest: the deny gate fails CLOSED on a role name that drifted", () => {
  // The fail direction AGENTS.md asks for. A hand-written role list that no
  // longer matches roles.mjs made `ROLES[name]?.permissions?.denySkills ?? []`
  // yield [], so `herdr` would have reached a proposal with nothing said.
  assert.deepEqual(SUGGEST_ROLES.includes("supervisor"), false);
  for (const role of SUGGEST_ROLES) {
    assert.ok(ROLES[role], `SUGGEST_ROLES names "${role}", which roles.mjs does not have`);
    assert.ok(ROLES[role].permissions, `role "${role}" has no permissions block`);
  }
  assert.deepEqual([...SUGGEST_ROLES].sort(), Object.keys(ROLES).filter((r) => r !== "supervisor").sort());
});

test("suggest: a 429 is retried, a 400 is not, and an exhausted retry still throws", async () => {
  const call = (statuses) => {
    const seen = [];
    const fetchImpl = async () => {
      const status = statuses[seen.length] ?? 200;
      seen.push(status);
      return status === 200
        ? { ok: true, json: async () => ({ answers: {} }) }
        : { ok: false, status, statusText: "x", text: async () => "", headers: { get: () => null } };
    };
    return { seen, run: () => askJev({}, {}, { key: "k", fetchImpl, sleep: async () => {} }) };
  };
  const transient = call([429, 200]);
  await transient.run();
  assert.deepEqual(transient.seen, [429, 200]);

  const refused = call([400]);
  await assert.rejects(refused.run, /Jev answered 400/);
  assert.deepEqual(refused.seen, [400], "a 400 is the answer, not a blip — it must not be retried");

  const exhausted = call([429, 429, 429, 200]);
  await assert.rejects(exhausted.run, /Jev answered 429/);
  assert.equal(exhausted.seen.length, 3, "retries are bounded; an exhausted retry still fails the run");
});

test("suggest: the state names the real allowlist, not the word allowlist", () => {
  const dir = suggestRepo({});
  try {
    const withHosts = suggestState(dir, { roles: {
      verifier: { network: ["eu.infisical.com"] },
      implementer: { network: ["api.github.com", "eu.infisical.com"] },
    } });
    // Every role's hosts, de-duplicated — the same union the runner renders as
    // sandbox.network.allowedDomains.
    assert.match(withHosts.lane_limits, /api\.github\.com, eu\.infisical\.com/);
    assert.equal(/only an allowlist/.test(withHosts.lane_limits), false);
    // A repo that declares none has NO network, which is the stronger statement.
    assert.match(suggestState(dir, { roles: { verifier: {} } }).lane_limits, /no network access at all/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lint: an enabled plugin that loads nothing is reported and fails the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-lint-plugins-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".afk-setup"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: { "never-installed@somewhere": true },
    }));
    writeFileSync(join(dir, ".afk-setup", "config.yaml"), "roles:\n  implementer:\n    always: []\n");
    // Contains, not equals: enabledPluginKeys unions the repo's settings with
    // the USER's, so this machine's own enablements are legitimately in the
    // list and a deepEqual here would pass only on the author's laptop.
    const found = unloadablePlugins(dir);
    const mine = found.find((p) => p.name === "never-installed");
    assert.ok(mine, `expected never-installed in ${found.map((p) => p.name).join(", ")}`);
    assert.match(mine.reason, /not installed on this host/);
    // It fails the command: an enablement that does nothing is the silent half
    // of exactly what lint exists to end.
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "stack.mjs"), "lint"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, AFK_PROJECT_ROOT: dir } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /never-installed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- `afk stack suggest --write` --------------------------------------------
//
// The property worth defending: the merge is a set union into `offer` and
// nothing else in the file moves. These configs are two hundred lines of
// comments recording why each check and host is there, and a YAML round-trip
// would return a correct file with every one of them gone.

const CONFIG_WITH_COMMENTS = `# Top comment that must survive.
defaultChecks:
  - npm test
roles:
  implementer:
    # Why futari-design and not the v1 skill — a comment worth keeping.
    always: [coduo-implement]
    offer: [apple-hig, "pstack:blast-radius"]
    notes: "A note that must not move."
  verifier:
    always: [show-me]
    offer:
    - diagnosing-bugs
    - "pstack:show-me-your-work"
  fixer:
    always: [show-me]
`;

test("write: merges into offer, and every comment and other key is byte-identical", () => {
  const { text, applied, refused } = mergeOffers(CONFIG_WITH_COMMENTS, {
    implementer: ["graphify", "apple-hig", "pstack:new-one"],
    verifier: ["code-review"],
  });
  assert.match(text, /offer: \[apple-hig, "pstack:blast-radius", graphify, "pstack:new-one"\]/);
  assert.match(text, /^ {4}- code-review$/m);
  // apple-hig was already there: a set union adds it once, not twice.
  assert.equal((text.match(/apple-hig/g) ?? []).length, 1);
  assert.deepEqual(applied.find((a) => a.role === "implementer").added, ["graphify", "pstack:new-one"]);
  assert.deepEqual(refused, []);
  // Nothing but the two offer lines moved.
  const stripOffer = (s) => s.split("\n")
    .filter((line) => !/^ {4}offer:/.test(line) && !/^ {4}- /.test(line)).join("\n");
  assert.equal(stripOffer(text), stripOffer(CONFIG_WITH_COMMENTS));
  assert.match(text, /# Top comment that must survive\./);
  assert.match(text, /# Why futari-design and not the v1 skill/);
  assert.match(text, /notes: "A note that must not move\."/);
});

test("write: never creates a role, and never invents an offer key", () => {
  const { text, applied, refused } = mergeOffers(CONFIG_WITH_COMMENTS, {
    ghost: ["anything"],
    fixer: ["diagnosing-bugs"],
  });
  assert.equal(text, CONFIG_WITH_COMMENTS, "a refusal writes nothing at all");
  assert.deepEqual(applied, []);
  assert.deepEqual(refused.map((r) => r.role).sort(), ["fixer", "ghost"]);
  assert.match(refused.find((r) => r.role === "ghost").reason, /no such role/);
  assert.match(refused.find((r) => r.role === "fixer").reason, /declares no `offer:` key/);
});

test("write: `always` and `notes` are never touched, whatever is proposed", () => {
  const { text } = mergeOffers(CONFIG_WITH_COMMENTS, { implementer: ["show-me"] });
  assert.match(text, /always: \[coduo-implement\]/);
  assert.equal(/always: \[coduo-implement, show-me\]/.test(text), false);
});

test("write: an ignore entry with no reason is refused, with the line number", () => {
  const dir = suggestRepo({}, { ignore: "cleanup # writes task documents\nprototype\n" });
  try {
    assert.throws(() => loadSuggestIgnore(dir), (error) =>
      /line 2: prototype/.test(error.message) && /A bare name gets re-litigated/.test(error.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
