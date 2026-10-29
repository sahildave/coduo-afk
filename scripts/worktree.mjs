import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { ensureDir, normalizeId, parseStatusPaths, run, shellQuote } from './lib.mjs';
// One definition of "is that pid still there", shared with the dashboard: a
// `running` lane and a live epic are the same question asked twice.
import { pidAlive } from './dashboard-data.mjs';

// `id` is the GitHub issue number as a string (lib.mjs normalizeId), so a lane
// for issue 204 is `afk/task-204` on disk, in `git worktree list`, and in
// `.afk/runs/`. Issue numbers are unique per repo, so lanes no longer collide
// across runs the way the old `001`/`002` numbering could.
export const taskBranch = (id) => `afk/task-${id}`;

/**
 * Where a lane's `verification.json` lives once the lane has committed: a git
 * note on the task commit, under a per-task notes ref — NOT a file on the
 * branch.
 *
 * It used to be committed as `.afk-runs/<id>/verification.json`, so the crash
 * sweep could `git show` it back off the branch. That put runner bookkeeping in
 * the consumer's history and under its own gates: five epics across two repos
 * failed `format:check` at integration on a JSON file no human wrote, and the
 * fix was `rm -f` by hand each time (#106). A note is attached to the exact
 * commit the checks verified, is visible from every worktree of the repo, is
 * never in any tree a gate reads, and needs no gitignore rule either way.
 *
 * One ref per task rather than one shared `refs/notes/afk` because lanes commit
 * concurrently and `git notes add` takes a lock on its ref: two lanes landing in
 * the same second would lose one note, and a lost note is a lane rebuilt on the
 * next restart. Deleted with the branch (`removeTaskWorktree`, `pruneLanes`);
 * an unmerged branch keeps its note, because that is its salvage record.
 *
 * The note is read off the branch TIP. Nothing in the runner adds a commit to
 * a task branch after the builder's — keep it that way, or attach the note to
 * the new tip too: a verified lane whose note sits on an ancestor is rebuilt.
 * A human's fix on top is the case `afk salvage` (scripts/salvage.mjs) covers:
 * it re-runs the checks at the new tip and attaches a fresh note there.
 */
export const laneVerificationRef = (id) => `refs/notes/afk-verification/${id}`;

/** Attach `file` (the lane's verification.json) to HEAD in `worktree`. Null on success, else the reason. */
export const attachLaneVerification = ({ worktree, id, file }) => {
  const result = run(`git notes --ref=${shellQuote(laneVerificationRef(id))} add -f -F ${shellQuote(file)} HEAD`, { cwd: worktree });
  return result.status === 0 ? null : String(result.stderr || result.stdout).trim() || `git notes exited ${result.status}`;
};

/** The verification attached to `branch`'s tip, or null when there is none or it does not parse. */
export const readLaneVerification = (root, id, branch) => {
  const result = run(`git notes --ref=${shellQuote(laneVerificationRef(id))} show ${shellQuote(branch)}`, { cwd: root });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
};

/** Forget a task's notes ref. Best-effort: a ref that is already gone is the outcome wanted. */
export const dropLaneVerification = (root, id) => {
  run(`git update-ref -d ${shellQuote(laneVerificationRef(id))}`, { cwd: root });
};

const realpath = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Every directory a checkout writes Git metadata into, absolute and deduped.
 * A plain checkout has one. A linked worktree has a per-worktree directory for
 * index.lock and a shared common directory for objects and refs.
 */
export const gitMetadataDirs = (root) => {
  const dirs = [];
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    const result = run(`git rev-parse ${flag}`, { cwd: root });
    if (result.status !== 0) continue;
    const dir = result.stdout.trim();
    if (!dir) continue;
    const absolute = realpath(resolve(root, dir));
    if (!dirs.includes(absolute)) dirs.push(absolute);
  }
  return dirs.length ? dirs : null;
};

// Canonical, for the same reason `worktreeRoot` canonicalises the project path:
// `foreignLane` compares a lane path against this base, and on macOS a base of
// `/var/folders/...` realpaths to `/private/var/folders/...` while the lane paths
// built on top of it do not (they name directories that may not exist yet, so
// `realpath` falls through). The prefix test then failed for EVERY lane, which
// reads as "no lane is foreign" — and that is the branch where `pruneLanes`
// force-removes a sibling epic's live lanes.
const worktreeBase = () => (process.env.AFK_WORKTREE_ROOT
  ? realpath(resolve(process.env.AFK_WORKTREE_ROOT))
  : legacyLaneBase());

/**
 * One worktree root (#228): `~/code/worktrees/<repo>/<kind>/<name>`, with kinds
 * `epic`, `lane`, `session` and `manual`, so cleaning up a repo is one folder.
 * The runner makes the first two. `AFK_WORKTREE_ROOT` and `AFK_EPIC_ROOT` still
 * override them, keeping the layout they always had (the suite sets both).
 *
 * The roots before #228 stay readable: a run whose `.afk/state.json` recorded a
 * lane there, or an epic worktree already standing there, keeps its path. Only
 * new runs and new lanes use the new root.
 */
const codeWorktrees = () => resolve(rootHome(), 'code', 'worktrees');
const legacyLaneBase = () => resolve(rootHome(), '.afk-claude', 'worktrees');
const legacyEpicBase = () => resolve(rootHome(), '.afk-claude', 'epics');

/**
 * The home the roots above hang off: `$HOME`, except that a test never gets the
 * real user's. Every test that builds a throwaway repo in $TMPDIR and makes a
 * lane without an override claimed a folder in the real `~/code/worktrees`
 * pointing at a repo that was gone a second later — about ten per suite run,
 * sixty found by hand on 2026-10-15. Node's test runner marks every file it
 * runs, and every child that inherits its environment, with NODE_TEST_CONTEXT;
 * there the real home is swapped for `AFK_TEST_HOME` (`afk selftest` sets one per
 * run and deletes it) or a shared folder under $TMPDIR for a file run on its own.
 * A test that points HOME somewhere else of its own (the #228 layout tests) keeps it.
 */
const rootHome = () => {
  const home = realpath(homedir());
  if (!process.env.NODE_TEST_CONTEXT) return home;
  // Fail direction: closed. With no passwd entry (a bare container) there is no
  // telling whether HOME is the real one, so the test home is used: a test that
  // moved HOME and now fails is loud, a test that wrote into a real home is not.
  let real = null;
  try { real = realpath(userInfo().homedir); } catch { real = home; }
  if (home !== real) return home;
  const testHome = resolve(process.env.AFK_TEST_HOME || resolve(tmpdir(), 'afk-test-home'));
  ensureDir(testHome);
  return realpath(testHome);
};
const slugOf = (root) => realpath(root).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The repository's name: the main checkout's directory, read from the shared
 * git directory so an epic worktree names the same repo as its clone. A
 * directory that is not a checkout names itself.
 */
const commonDir = (root) => {
  const common = run('git rev-parse --git-common-dir', { cwd: root });
  return common.status === 0 && common.stdout.trim() ? realpath(resolve(root, common.stdout.trim())) : null;
};
const REPO_CLAIM = '.afk-repo';
/**
 * The folder name a second clone of `name` gets: `<name>-<first 6 hex of the
 * sha1 of its git directory>`. `isHashedName` is its inverse; both read this.
 */
const HASH_HEX = 6;
const hashedName = (name, dir) => `${name}-${createHash('sha1').update(dir).digest('hex').slice(0, HASH_HEX)}`;
const isHashedName = (entry, name) => entry.length === name.length + 1 + HASH_HEX
  && entry.startsWith(`${name}-`) && new RegExp(`^[0-9a-f]{${HASH_HEX}}$`).test(entry.slice(-HASH_HEX));
/**
 * Two repositories cloned under one directory name (`~/work/app`, `~/side/app`)
 * must not share `~/code/worktrees/app` (#235 S5): the second would adopt the
 * first one's epic and lanes, and its end-of-run sweep would stop them. The
 * first clone to make a worktree there writes its git directory into
 * `<folder>/.afk-repo` and keeps the plain name; any other clone gets
 * `<name>-<6 hex of its git directory>`. Deterministic, and readable for the
 * usual one clone per name. Read-only: only `claimRepo`, called when a
 * worktree is created, writes the claim.
 */
const repoName = (root) => {
  const dir = commonDir(root);
  if (!dir) return checkoutName(root);
  const name = (dir.split('/').pop() === '.git' ? dirname(dir).split('/').pop() : dir.split('/').pop().replace(/\.git$/, ''))
    ?.replace(/[^A-Za-z0-9._-]+/g, '-') || checkoutName(root);
  let claim = null;
  try { claim = readFileSync(resolve(codeWorktrees(), name, REPO_CLAIM), 'utf8').trim(); } catch { /* unclaimed */ }
  return !claim || claim === dir ? name : hashedName(name, dir);
};
/** Write this clone's claim on its folder under the new root, when it has none. Default layout only. */
const claimRepo = (root) => {
  const dir = commonDir(root);
  if (!dir) return;
  const claim = resolve(codeWorktrees(), repoName(root), REPO_CLAIM);
  if (existsSync(claim)) return;
  ensureDir(dirname(claim));
  writeFileSync(claim, `${dir}\n`);
};

/**
 * The folder this checkout's lanes go in under `lane/`: the epic id when the
 * checkout is an epic worktree in the new root (`epic/<id>/<name>`), else the
 * checkout's path slug. Per checkout, never shared, because the end-of-run
 * sweep stops every process under it and `foreignLane` reads "ours" as "inside
 * it" — a `lane/` folder shared by two epics would let one stop the other's lanes.
 */
const laneKey = (root) => {
  const epics = resolve(codeWorktrees(), repoName(root), 'epic');
  const rel = relative(epics, realpath(root)).split('/');
  return rel.length === 2 && rel[0] && rel[0] !== '..' && /^\d+$/.test(rel[0]) ? rel[0] : slugOf(root);
};

/**
 * Where this project's task worktrees live — deliberately OUTSIDE the project.
 *
 * They used to sit in `.afk/worktrees/`, and a worktree is a full copy of the
 * repo, so any project check that walks the tree walked them too. `eslint .`
 * found a bundled vendor file inside a lane and failed an integration whose
 * merge was perfect; `.afk/` being gitignored does not help, because these tools
 * do not read .gitignore. Nothing a runner can configure fixes that for every
 * project — so the copies go somewhere the project's own tools will never look.
 *
 * Keyed by the project's absolute path, so two checkouts of the same repo never
 * share a lane. `.afk/` still holds state, logs, prompts and streams.
 */
export const worktreeRoot = (root) => (process.env.AFK_WORKTREE_ROOT
  ? resolve(
    worktreeBase(),
    // Canonical, so one checkout has exactly ONE slug. `/var/...` and its
    // realpath `/private/var/...` are the same directory and used to slugify to
    // two lane roots, which only stayed harmless while nothing compared them.
    slugOf(root),
  )
  : (legacyRun(root) ? legacyWorktreeRoot(root) : resolve(codeWorktrees(), repoName(root), 'lane', laneKey(root))));

/** Where this checkout's lanes were before #228, for a run that recorded them there. */
const legacyWorktreeRoot = (root) => resolve(legacyLaneBase(), slugOf(root));

/**
 * True when `.afk/state.json` records a lane under the pre-#228 root: that run
 * keeps ALL its lanes there (#235 S4), so the end-of-run sweep and the write
 * guard, which both take `worktreeRoot`, cover every lane of it.
 */
const legacyRun = (root) => {
  let tasks = null;
  try { tasks = JSON.parse(readFileSync(resolve(root, '.afk', 'state.json'), 'utf8'))?.tasks; } catch { return false; }
  const legacy = `${legacyWorktreeRoot(root)}/`;
  return Object.values(tasks ?? {}).some((task) => typeof task?.worktree === 'string' && task.worktree.startsWith(legacy));
};

/**
 * The checkout's own directory name, reused as the name of every worktree of it.
 *
 * A worktree named after the repository is what a project's own tooling expects
 * to be sitting in, and it makes `~/.afk-claude/epics/<slug>-388/my-app` read as
 * a checkout rather than as a numbered slot.
 */
const checkoutName = (root) => realpath(root).split('/').filter(Boolean).pop()
  ?.replace(/[^A-Za-z0-9._-]+/g, '-') || 'checkout';

/**
 * A worktree gets a PRIVATE PARENT directory: `<parent>/<checkout name>`.
 *
 * Build configuration is routinely written as a path relative to the checkout
 * that escapes it — cargo's `target-dir = "../.atlas-target"`, a tsconfig
 * `outDir`, sccache, a shared `.venv`. Put two worktrees side by side under one
 * parent and every one of those resolves to the SAME directory, so two lanes (or
 * two epics) share a build lock and can hand each other the other's binary. The
 * runner cannot know which tools a project uses, and a shared build cache
 * between lanes is exactly the failure `worktreeSetup.link` is warned about —
 * this is the same failure arriving through a relative path.
 *
 * One level of nesting makes `../X` private, which is the form these settings
 * take in practice. It is NOT a general defence: `../../X`, or an absolute path,
 * still reaches shared ground. `sharedBuildPaths` below reports what it can of
 * the remainder.
 *
 * Falls back to the parent itself when that parent is already a checkout — a
 * worktree created by an earlier version, mid-epic, which must keep working
 * where it stands rather than be silently abandoned.
 */
const privately = (parent, root) => {
  const nested = resolve(parent, checkoutName(root));
  return !existsSync(nested) && existsSync(resolve(parent, '.git')) ? parent : nested;
};

export const taskWorktree = (root, id) => recordedLane(root, id) ?? privately(resolve(worktreeRoot(root), id), root);

/**
 * The lane path a run already recorded in `.afk/state.json`, while that lane
 * still stands, so a run started before #228 keeps its lanes where they are.
 * Default layout only: under an override the path is the one it always was.
 */
const recordedLane = (root, id) => {
  if (process.env.AFK_WORKTREE_ROOT) return null;
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(resolve(root, '.afk', 'state.json'), 'utf8'))?.tasks?.[id]?.worktree ?? null;
  } catch {
    return null;
  }
  return typeof recorded === 'string' && isAbsolute(recorded) && existsSync(resolve(recorded, '.git')) ? recorded : null;
};

/**
 * Where a read-only role runs — NOT the project checkout (docs/findings.md 3.2).
 *
 * `sandbox.filesystem.allowWrite` only ever widens, so it cannot take away
 * Claude Code's default grant of the agent's own working directory. Measured
 * live: `verifier` and `supervisor` deny the editing tools and then write the
 * repository root anyway with a shell redirect, which makes a gate that can
 * write the thing it gates. No list of denied Bash verbs closes that — a
 * redirect is not a command name.
 *
 * So the fix is the cwd, not the sandbox: give these roles a directory they are
 * allowed to write, somewhere the project is not. The default grant then covers
 * scratch space and the repository root falls outside every allowWrite entry,
 * which is what the sandbox does enforce.
 *
 * `verifier` gets a detached worktree of the branch it is reviewing, because
 * `/code-review` and `git diff` need to run inside a checkout; corrupting that
 * copy costs nothing and it is removed when the agent exits. `supervisor` reads
 * logs and run state by absolute path, so it gets a bare directory.
 */
export const roleCwd = (root, key) => resolve(worktreeRoot(root), `role-cwd-${key}`);

const git = (root, command, options = {}) => run(`git ${command}`, { cwd: root, ...options });

export const currentBaseSha = (root, branch = 'main') => {
  const result = git(root, `rev-parse ${shellQuote(branch)}`);
  if (result.status !== 0) throw new Error(`Cannot resolve ${branch}: ${result.stderr}`);
  return result.stdout.trim();
};

export const branchExists = (root, branch) => git(root, `show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`).status === 0;

/**
 * `present`, `absent`, or `unknown` when git could not answer. `show-ref
 * --verify --quiet` exits 1 for a missing ref and nothing else does; a spawn
 * that failed (#136) or a git error (128) is NOT evidence the branch is gone.
 * Callers that would delete something on `absent` must treat `unknown` as
 * "leave it": fail closed.
 */
export const branchState = (root, branch) => {
  const result = git(root, `show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`);
  if (result.error) return 'unknown';
  return result.status === 0 ? 'present' : result.status === 1 ? 'absent' : 'unknown';
};

/**
 * Make a fresh worktree buildable.
 *
 * `git worktree add` copies tracked files and nothing else, so a project whose
 * build needs installed dependencies or a gitignored credential file gets a lane
 * that cannot compile — and the error names the symptom, never the missing file.
 * Declare the gap in `.afk-setup/config.yaml`:
 *
 *   worktreeSetup:
 *     link: [node_modules, src-tauri/target]
 *     copy: [.infisical.json]
 *     run:  [npm run codegen]
 *     teardown: [xcrun simctl shutdown "lumina-lane-$(printf %s "$PWD" | shasum | cut -c1-8)" || true]
 *     finish:   [xcrun simctl delete   "lumina-lane-$(printf %s "$PWD" | shasum | cut -c1-8)" || true]
 *
 * `link` symlinks to the main checkout, which is why heavy build caches belong
 * there and anything a task might write belongs in `copy`. A missing source
 * throws by name: failing here beats failing 20 minutes into a builder with an
 * error that does not say why. `teardown` and `finish` are the other end of
 * the lane's life — `teardownWorktree` below.
 */
export const bootstrapWorktree = ({ root, worktree, setup }) => {
  const applied = { linked: [], copied: [], ran: [] };
  if (!setup) return applied;
  for (const entry of setup.link ?? []) {
    const source = resolve(root, entry);
    const target = resolve(worktree, entry);
    if (!existsSync(source)) throw new Error(`worktreeSetup.link: ${entry} does not exist in ${root}. Create it in the main checkout first.`);
    // lstat, not existsSync: a symlink to a since-removed target reports false
    // and we would then try to create one that is already there.
    try { lstatSync(target); continue; } catch {}
    ensureDir(dirname(target));
    symlinkSync(source, target);
    applied.linked.push(entry);
  }
  for (const entry of setup.copy ?? []) {
    const source = resolve(root, entry);
    const target = resolve(worktree, entry);
    if (!existsSync(source)) throw new Error(`worktreeSetup.copy: ${entry} does not exist in ${root}.`);
    if (existsSync(target)) continue;
    ensureDir(dirname(target));
    copyFileSync(source, target);
    applied.copied.push(entry);
  }
  for (const command of setup.run ?? []) {
    const result = run(command, { cwd: worktree });
    if (result.status !== 0) throw new Error(`worktreeSetup.run failed in ${worktree}: ${command}\n${result.stderr || result.stdout}`);
    applied.ran.push(command);
  }
  return applied;
};

/**
 * Run the project's `worktreeSetup.teardown` (or `.finish`) commands in a lane
 * once the runner is done with it.
 *
 * A check command can create a resource the runner has no record of — Lumina's
 * boots a simulator named after a hash of `$PWD` so parallel lanes do not share
 * one — and nothing the runner did afterwards could reach it: 21 devices,
 * 27 GB, 14 of them for worktrees long since pruned (#109). The project knows
 * the resource; the runner knows when the lane is finished. This is the seam:
 * the same `sh -c` in the same cwd as `worktreeSetup.run`, so the hook can
 * derive the name the check derived.
 *
 * `teardown` runs after a lane's checks — pass, fail, a builder that died or
 * was killed — and after the integration checkout's post-merge checks.
 * `finish` runs once per lane worktree just before it is removed — at
 * integration for a passed lane (`removeTaskWorktree`), at `afk finish` for a
 * retained one (`pruneLanes`).
 *
 * Never throws and never decides anything: a hook's exit code is returned for
 * the caller to log, and a hook that fails must not turn a passed lane into a
 * failed one or stop the hooks after it. A worktree whose directory is already
 * gone is reported rather than run — the hook's contract is `$PWD`, and there
 * is no honest `$PWD` to give it.
 *
 * Bounded, because one caller is the orchestrator's signal handler: a hook
 * that hangs (`simctl` waiting on CoreSimulatorService) would otherwise hold
 * the exit open with the lanes already dead. A timed-out hook reads
 * `status: null` with the reason; the next hook still runs.
 */
export const HOOK_TIMEOUT_MS = 60_000;
export const teardownWorktree = ({ worktree, setup, hook = 'teardown', timeoutMs = HOOK_TIMEOUT_MS }) => {
  const commands = setup?.[hook] ?? [];
  if (!commands.length) return [];
  if (!worktree || !existsSync(worktree))
    return commands.map((command) => ({ command, status: null, output: `skipped: ${worktree ?? 'no worktree'} is gone` }));
  return commands.map((command) => {
    const result = run(command, { cwd: worktree, timeout: timeoutMs });
    const output = String(result.stderr || result.stdout || '').trim();
    return result.error?.code === 'ETIMEDOUT'
      ? { command, status: null, output: `timed out after ${timeoutMs / 1000}s${output ? ` — ${output}` : ''}` }
      : { command, status: result.status, output };
  });
};

/** The log lines for the hooks that did not exit 0 — a hook's failure is said, never acted on. */
export const hookFailureLines = (taskId, hooks) =>
  (hooks ?? [])
    .filter((hook) => hook.status !== 0)
    .map((hook) => `teardown hook for ${taskId} exited ${hook.status ?? 'without running'}: ${hook.command}${hook.output ? ` — ${hook.output}` : ''}`);

/**
 * Where an epic runs when it is not run in the main checkout.
 *
 * `afk epic --worktree` exists so the checkout you work in stays yours: the
 * feature branch, `.afk/`, the dashboard and the integrator all move into a
 * worktree of their own, and two epics can therefore run at once against one
 * clone. Everything downstream is already keyed by root — the orchestrator
 * lock, `worktreeRoot`, the dashboard port — so a second root is a second run
 * with nothing shared.
 *
 * A directory of its own, NOT under `worktreeBase()`: lane pruning and the
 * foreign-lane test both reason about what lives there, and an epic root is
 * neither a lane nor foreign. `AFK_EPIC_ROOT` overrides it, as
 * `AFK_WORKTREE_ROOT` does for lanes.
 */
/**
 * Each place an epic worktree of this clone can be, as `{ base, parent }`: the
 * override's `<base>/<slug>-<id>`, or by default the new `~/code/worktrees/
 * <repo>/epic/<id>` (#228) and then the pre-#228 `~/.afk-claude/epics/<slug>-<id>`,
 * which only a run already standing there still uses.
 */
const epicLayouts = (root, epicId) => {
  if (process.env.AFK_EPIC_ROOT) {
    const base = resolve(process.env.AFK_EPIC_ROOT);
    return [{ base, parent: resolve(base, `${slugOf(root)}-${epicId}`) }];
  }
  const base = resolve(codeWorktrees(), repoName(root), 'epic');
  return [
    { base, parent: resolve(base, String(epicId)) },
    { base: legacyEpicBase(), parent: resolve(legacyEpicBase(), `${slugOf(root)}-${epicId}`) },
  ];
};
const epicBases = (root) => epicLayouts(root, 0).map((layout) => layout.base);

export const epicWorktree = (root, epicId) => {
  const [current, legacy] = epicLayouts(root, epicId);
  if (legacy) {
    const standing = privately(legacy.parent, root);
    if (existsSync(standing)) return standing;
  }
  return privately(current.parent, root);
};

/**
 * True when `root` is a checkout `afk epic --worktree` made: strictly inside
 * the epics base. The main checkout, or any hand-made worktree, is false — the
 * end-of-run process sweep includes `root` only when this holds, because a
 * human's shells and editors live in the main checkout.
 */
export const isEpicCheckout = (root) => {
  const checkout = realpath(root);
  return epicBases(root).map(realpath).some((base) => checkout !== base && under(base, checkout));
};

/**
 * The directory `epicWorktree` put this epic's checkout in — `<base>/<slug>-<id>`,
 * the private parent that also collects whatever the project builds just outside
 * its checkout (`../.atlas-target`, 15–18 GB per epic) — or null when `root` is
 * not that checkout.
 *
 * This is the guard in front of a recursive delete, so it answers yes only for
 * the exact path the runner would create for this epic from this clone, and
 * only for a parent strictly inside the epics base. A checkout anywhere else —
 * the main checkout, a hand-made worktree, another epic's — gets null. Fail
 * direction: closed. A missed cleanup costs disk; a wrong one costs a checkout.
 *
 * `main` is the clone's main checkout (`mainCheckout` in runtime-herdr.mjs). In
 * the flat layout the checkout IS the parent, and that is what is returned.
 */
export const ownedEpicParent = ({ root, main, epicId }) => {
  if (epicId === undefined || epicId === null || epicId === '') return null;
  const checkout = realpath(root);
  if (checkout !== realpath(epicWorktree(main, epicId))) return null;
  for (const layout of epicLayouts(main, epicId)) {
    const base = realpath(layout.base);
    const parent = realpath(layout.parent);
    if (parent !== base && under(base, parent) && under(parent, checkout)) return parent;
  }
  return null;
};

/**
 * The epic's own worktree, checked out on `branch`. Idempotent: a restart finds
 * the worktree from the first run and reuses it.
 *
 * Refuses a worktree sitting on the wrong branch rather than moving it. That
 * directory holds a run's `.afk/` — its state, its logs, its verifier report —
 * and switching its branch underneath would strand all of it against work it
 * does not describe.
 */
export const createEpicWorktree = ({ root, branch, epicId, setup }) => {
  if (!process.env.AFK_EPIC_ROOT) claimRepo(root);
  const worktree = epicWorktree(root, epicId);
  if (existsSync(worktree)) {
    const actual = run('git rev-parse --abbrev-ref HEAD', { cwd: worktree });
    if (actual.status !== 0 || actual.stdout.trim() !== branch)
      throw new Error(
        `Existing epic worktree ${worktree} is on ${actual.stdout.trim() || 'an unknown branch'}, not ${branch}. `
        + 'Remove it with `git worktree remove` if that run is over.',
      );
    return { worktree, reused: true, setup: bootstrapWorktree({ root, worktree, setup }) };
  }
  const result = git(root, `worktree add ${shellQuote(worktree)} ${shellQuote(branch)}`);
  if (result.status !== 0)
    throw new Error(`Cannot create the epic worktree at ${worktree}: ${result.stderr || result.stdout}`);
  return { worktree, reused: false, setup: bootstrapWorktree({ root, worktree, setup }) };
};

export const createTaskWorktree = ({ root, id, baseSha, setup }) => {
  if (!process.env.AFK_WORKTREE_ROOT) claimRepo(root);
  const branch = taskBranch(id);
  const worktree = taskWorktree(root, id);
  if (existsSync(worktree)) {
    const actual = run('git rev-parse --abbrev-ref HEAD', { cwd: worktree });
    if (actual.status !== 0 || actual.stdout.trim() !== branch) {
      throw new Error(`Existing worktree ${worktree} is not checked out on ${branch}.`);
    }
    // Bootstrap is idempotent, and a reused lane may have been cleaned since —
    // `resetTaskWorktree`'s `git clean -fdq` removes copied files and symlinks
    // alike, so re-running it here is what keeps a retried task buildable.
    return { branch, worktree, reused: true, setup: bootstrapWorktree({ root, worktree, setup }) };
  }
  const branchArg = branchExists(root, branch)
    ? shellQuote(branch)
    : `-b ${shellQuote(branch)} ${shellQuote(baseSha)}`;
  const result = branchExists(root, branch)
    ? git(root, `worktree add ${shellQuote(worktree)} ${branchArg}`)
    : git(root, `worktree add ${shellQuote(worktree)} ${branchArg}`);
  if (result.status !== 0) throw new Error(`Cannot create worktree for ${id}: ${result.stderr || result.stdout}`);
  return { branch, worktree, reused: false, setup: bootstrapWorktree({ root, worktree, setup }) };
};

export const resetTaskWorktree = ({ worktree, baseSha, root, setup }) => {
  const reset = run(`git reset --hard ${shellQuote(baseSha)}`, { cwd: worktree });
  if (reset.status !== 0) throw new Error(`Cannot reset ${worktree}: ${reset.stderr}`);
  const clean = run('git clean -fdq -e runs', { cwd: worktree });
  if (clean.status !== 0) throw new Error(`Cannot clean ${worktree}: ${clean.stderr}`);
  // The clean above spares gitignored paths, so a linked `node_modules` normally
  // survives — but nothing guarantees a project's setup entries are ignored.
  // Re-applying costs nothing and a retry into an unbuildable lane costs a run.
  if (root && setup) bootstrapWorktree({ root, worktree, setup });
};

export const changedPaths = (worktree) => parseStatusPaths(run('git status --porcelain -uall', { cwd: worktree }).stdout);

export const removeTaskWorktree = ({ root, id, branch, setup = null }) => {
  const worktree = taskWorktree(root, id);
  // The project's `finish` hook, while the directory is still there to be
  // `$PWD`. This is where a PASSED lane's worktree goes — mid-run, at
  // integration — so without this the hook at `afk finish` would only ever
  // meet the failed lanes' worktrees, and the 14 devices for long-pruned
  // worktrees (#109) were exactly the passed ones.
  const hooks = teardownWorktree({ worktree, setup, hook: 'finish' });
  // Never throws. Every caller reaches here AFTER the merge has passed and been
  // recorded, so a throw cannot undo anything: it only killed the scheduler and
  // left the merged task without `worktreeRemoved` (#144, epic #790:
  // `Directory not empty` after all nine checks passed). Fail direction: open.
  // A lane directory left on disk costs space and a log line; a dead
  // orchestrator costs every lane still running. `removed: false` is what
  // reconcile retries on the next start (`retryPassedCleanup` in auto.mjs).
  const warnings = [];
  const remove = git(root, `worktree remove --force ${shellQuote(worktree)}`);
  if (remove.status !== 0 && existsSync(worktree))
    warnings.push(`git worktree remove failed (${remove.stderr.trim()}); fell back to rm -rf`);
  const rm = (path) => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`cannot remove ${path}: ${error.message}`);
    }
  };
  if (existsSync(worktree)) rm(worktree);
  // The lane's private parent goes with it: it exists only to hold this lane and
  // whatever the project's build configuration pointed just outside the checkout.
  // In the pre-nesting layout this IS the worktree, so the call is a no-op there.
  // Taken from the lane's own path, so a lane recorded under the pre-#228 root
  // takes its parent with it too.
  const parent = basename(dirname(worktree)) === String(id) ? dirname(worktree) : resolve(worktreeRoot(root), String(id));
  rm(parent);
  // And the folders above it, once this was their last lane: `lane/<key>/`,
  // then `lane/`. Default layout only, where both are the runner's own; an
  // override's base is the caller's to clean.
  if (!process.env.AFK_WORKTREE_ROOT) tidyRepoFolder(dirname(parent));
  // After the rm fallback git still lists the worktree, and `branch -d` refuses
  // a branch checked out there. Prune drops entries whose directory is gone.
  if (remove.status !== 0) git(root, 'worktree prune');
  // A branch that is already gone (a retried cleanup whose first pass deleted
  // it) counts as deleted: `branchDeleted` answers "is it gone", and a retry
  // must not flip a true back to false with a "not found" warning.
  // `unknown` (git could not answer) is never read as gone.
  const branchNow = branchState(root, branch);
  const deletion = branchNow === 'present' ? git(root, `branch -d ${shellQuote(branch)}`)
    : branchNow === 'absent' ? { status: 0, stderr: '' }
    : { status: 1, stderr: `could not check whether ${branch} exists; left it` };
  if (deletion.status === 0) dropLaneVerification(root, id);
  else warnings.push(deletion.stderr.trim());
  return {
    removed: !existsSync(worktree),
    branchDeleted: deletion.status === 0,
    warning: warnings.filter(Boolean).join('; ') || null,
    hooks,
  };
};

/** Remove `dir` if it is an empty directory: `rmdir`, which the kernel refuses for any other. Never throws. */
const rmdirIfEmpty = (dir) => {
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove a folder `orphanClaim` approved: unlink the claim, then `rmdir`. Never
 * a recursive delete, so a folder that gained an entry after the check (another
 * tool's worktree, a file) is kept with that entry. Never throws.
 */
const removeClaimFolder = (folder) => {
  try { unlinkSync(resolve(folder, REPO_CLAIM)); } catch { /* already gone */ }
  return rmdirIfEmpty(folder);
};

/**
 * A repo folder under `~/code/worktrees` that is only a stale claim: it holds
 * `.afk-repo` and nothing else, and the git directory that file names is gone.
 * A folder holding anything else, or a claim whose git directory still stands
 * (a live clone that has no worktree right now), is not one.
 */
const orphanClaim = (folder) => {
  let entries = [];
  try { entries = readdirSync(folder); } catch { return false; }
  if (entries.length !== 1 || entries[0] !== REPO_CLAIM) return false;
  let dir = '';
  try { dir = readFileSync(resolve(folder, REPO_CLAIM), 'utf8').trim(); } catch { return false; }
  if (!dir || !isAbsolute(dir) || existsSync(dir)) return false;
  // A second clone of the same name lives in `<name>-<hash>` only while this
  // claim stands (`repoName`). Deleting it would move that clone's lanes and
  // epic to `<name>` mid-run, so the claim stays while such a folder exists.
  const name = basename(folder);
  let siblings = [];
  try { siblings = readdirSync(dirname(folder)); } catch { return false; }
  return !siblings.some((entry) => isHashedName(entry, name));
};

/**
 * After a lane is removed from `<repo>/lane/<key>/<id>`: drop `<key>/` and then
 * `lane/` when each is empty, and `<repo>/` when only an orphan claim is left.
 * Fail direction: closed. Nothing is deleted recursively: every folder goes by
 * `rmdir`, which the kernel refuses for a non-empty one, and a claim file only
 * when `orphanClaim` says so (`removeClaimFolder`).
 */
const tidyRepoFolder = (laneKeyDir) => {
  const lanes = dirname(laneKeyDir);
  const repo = dirname(lanes);
  if (basename(lanes) !== 'lane' || dirname(repo) !== codeWorktrees()) return;
  if (rmdirIfEmpty(laneKeyDir)) rmdirIfEmpty(lanes);
  if (orphanClaim(repo)) removeClaimFolder(repo);
};

/**
 * Remove every repo folder under `~/code/worktrees` that is only an orphan
 * claim (`orphanClaim`). The end-of-run sweep (`pruneLanes`) calls it: lane
 * removal cannot catch these itself, because a lane is removed through git while
 * the claim's git directory still exists. The claim goes stale when the clone is
 * deleted later. Default layout only: under `AFK_WORKTREE_ROOT` claims do not
 * live there, and it returns nothing. Never throws.
 *
 * @returns {string[]} the folders removed
 */
export const pruneOrphanClaims = () => {
  if (process.env.AFK_WORKTREE_ROOT) return [];
  const base = codeWorktrees();
  let names = [];
  try { names = readdirSync(base); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const folder = resolve(base, name);
    if (orphanClaim(folder) && removeClaimFolder(folder)) removed.push(folder);
  }
  return removed;
};

/**
 * Create the cwd a read-only role runs in, and return its path.
 *
 * With `ref`, it is a detached worktree of that ref — a real checkout the agent
 * may write and cannot damage, because nothing reads it back and nothing merges
 * it. Without one, a plain empty directory.
 *
 * `setup` is the project's `worktreeSetup`, applied exactly as a lane's is: a
 * `git worktree add` copies tracked files and nothing else, so a role that runs
 * the stack's gates gets a checkout with no `node_modules` and every gate dies
 * at "Cannot find package" — with the npm registry network-denied in the review
 * sandbox, it cannot install its way out. Passing the same `link: [node_modules]`
 * the lanes use symlinks the deps in for free: no install, no copy, works
 * offline. A bare empty dir (no `ref`) needs nothing and ignores `setup`.
 *
 * Never throws: a closeout review must not die because a scratch directory
 * could not be made. On failure the caller is handed `null` and falls back to
 * the project root, which is what this code did before the fix — degraded, not
 * broken, and said out loud by the caller rather than silently.
 */
export const createRoleCwd = ({ root, key, ref = null, setup = null, onError = null }) => {
  if (!process.env.AFK_WORKTREE_ROOT) claimRepo(root);
  const cwd = roleCwd(root, key);
  // `onError` hears why the answer is null; callers that pass none see no change.
  const fail = (message) => {
    try { onError?.(message); } catch {}
    return null;
  };
  try {
    if (!ref) {
      ensureDir(cwd);
      return cwd;
    }
    if (existsSync(cwd)) removeRoleCwd({ root, key });
    ensureDir(dirname(cwd));
    const result = git(root, `worktree add --detach ${shellQuote(cwd)} ${shellQuote(ref)}`);
    if (result.status !== 0) return fail(`git worktree add ${ref} failed: ${String(result.stderr || result.stdout || '').trim()}`);
    if (setup) bootstrapWorktree({ root, worktree: cwd, setup });
    return cwd;
  } catch (error) {
    return fail(String(error?.message ?? error));
  }
};

/** Remove a role cwd. Never throws — the run it belongs to is already over. */
export const removeRoleCwd = ({ root, key }) => {
  const cwd = roleCwd(root, key);
  try {
    git(root, `worktree remove --force ${shellQuote(cwd)}`);
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    // `git worktree remove` on a directory git does not know about leaves the
    // administrative entry behind when the directory was deleted by hand.
    git(root, 'worktree prune');
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove every role cwd left behind by a killed run.
 *
 * A task worktree is deliberately retained across a restart — it may hold
 * unverified work. A role cwd never does: it exists for one short read-only
 * session and is written by nobody the runner reads back. A crash mid-review
 * would otherwise leave a detached worktree that `git worktree list` keeps
 * reporting forever, since these are keyed per event and never reused.
 *
 * @returns {string[]} the paths removed
 */
export const pruneRoleCwds = (root) => {
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(worktreeRoot(root));
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith('role-cwd-')) continue;
    if (removeRoleCwd({ root, key: name.slice('role-cwd-'.length) })) removed.push(name);
  }
  return removed;
};

const under = (parent, path) => path === parent || path.startsWith(`${parent}/`);

/**
 * A lane worktree that belongs to a DIFFERENT checkout of this repo.
 *
 * `git worktree list` answers for the whole repository, not for the checkout it
 * was run from, so two epics running concurrently — one per worktree, which is
 * the point of running an epic outside the main checkout — each see the other's
 * lanes. `pruneLanes` has no DAG to filter against and would `git worktree
 * remove --force` a sibling epic's live lanes.
 *
 * Stated as an EXCLUSION on purpose. `worktreeRoot` is per-checkout, so an
 * inclusion test would also drop lanes sitting outside it — an older layout, a
 * changed `AFK_WORKTREE_ROOT` — and those are exactly the strays `pruneLanes`
 * exists to catch (it reads `git worktree list` rather than reconstructing
 * paths for that reason). A lane is foreign only when it sits under the shared
 * base beside ours, in another checkout's slug.
 */
export const foreignLane = (root, path) => {
  const lane = realpath(path);
  // Each shared base beside the folder that is ours in it: the override's, or
  // the new root and the pre-#228 base (#228).
  const pairs = process.env.AFK_WORKTREE_ROOT
    ? [[worktreeBase(), worktreeRoot(root)]]
    : [[codeWorktrees(), worktreeRoot(root)], [legacyLaneBase(), legacyWorktreeRoot(root)]];
  return pairs.some(([base, mine]) => under(realpath(base), lane) && !under(realpath(mine), lane));
};

/** How many levels above `root` a resolved path sits; 0 when it is inside it. */
const levelsAbove = (root, path) => {
  const rel = relative(root, path).split('/');
  let levels = 0;
  while (rel[levels] === '..') levels += 1;
  return levels;
};

/**
 * Build configuration that reaches a directory the worktrees SHARE.
 *
 * The private parent (`privately` above) already makes a one-level escape —
 * `target-dir = "../target"`, the form these settings almost always take — land
 * inside the worktree's own parent. What it cannot cover is a path that climbs
 * two levels or is absolute: those resolve to the same directory from every
 * worktree, and two concurrent cargo runs then block on one build lock and can
 * hand each other a binary the other compiled.
 *
 * Deliberately ONE case, cargo's `build.target-dir`. It is the case that was
 * actually observed, its resolution rule is documented (a relative path in
 * `.cargo/config.toml` is relative to the parent of `.cargo/`), and it is
 * parseable with a line reader. The same exposure exists for tsconfig `outDir`,
 * Gradle, sccache and a shared `.venv`, and there is no honest cheap check for
 * those — a project's real build path may come from a script, an env var or an
 * extends chain, and a check that guessed would cry wolf on the majority of
 * repos that are fine. So this reports what it can prove and stays quiet about
 * the rest, and it WARNS rather than refuses: pointing a cache at a fixed
 * directory is legitimate for a project that never runs two lanes.
 *
 * @returns {{file: string, key: string, value: string, resolved: string}[]}
 */
export const sharedBuildPaths = (root) => {
  const found = [];
  // Cargo reads `config.toml` and ignores the extension-less `config` when both
  // are present, so the first one that exists is the one in force.
  const name = ['.cargo/config.toml', '.cargo/config'].find((entry) => existsSync(resolve(root, entry)));
  if (!name) return found;
  let text = '';
  try { text = readFileSync(resolve(root, name), 'utf8'); } catch { return found; }
  let section = '';
  for (const line of text.split('\n')) {
    const heading = line.match(/^\s*\[([^\]]+)\]/);
    if (heading) { section = heading[1].trim(); continue; }
    const setting = line.match(/^\s*target-dir\s*=\s*["']([^"']*)["']/);
    if (!setting || section !== 'build') continue;
    const value = setting[1];
    const resolved = resolve(root, value);
    // Absolute is shared however deep it is: it does not move with the worktree.
    if (isAbsolute(value) || levelsAbove(root, resolved) >= 2)
      found.push({ file: name, key: 'build.target-dir', value, resolved });
  }
  return found;
};

export const listAfkWorktrees = (root) => {
  const output = git(root, 'worktree list --porcelain').stdout;
  return output.split('\n\n').map((block) => Object.fromEntries(block.split('\n').filter(Boolean).map((line) => {
    const [key, ...value] = line.split(' ');
    return [key, value.join(' ') || true];
  })))
    .filter((entry) => String(entry.branch || '').startsWith('refs/heads/afk/task-'))
    .filter((entry) => !foreignLane(root, String(entry.worktree ?? '')));
};

/**
 * Every epic running RIGHT NOW against this clone, other than `exclude`.
 *
 * `--worktree` lets two epics run at once against one clone, and each one owns a
 * `.afk/state.json` under its own root. Nothing merges their scopes: the runner
 * enforces scope per FILE, so two epics that both name `locales/en.json` — even
 * for disjoint keys inside it — collide at integration and nobody is told until
 * the merge. This is what tells the second epic the first one is there.
 *
 * The candidate roots are the main checkout plus every registered worktree
 * sitting under the epics base. `git worktree list` answers for the whole
 * repository (the same property `foreignLane` reasons about), so one call from
 * any checkout sees them all, and a directory git no longer knows about is not a
 * candidate at all.
 *
 * **Liveness is the recorded pid and nothing else.** A state file outlives its
 * run: `runAuto` nulls `orchestratorPid` on the way out, and a crash leaves a pid
 * nothing answers to. Either way the epic is dead, and a dead epic must not hold
 * up a new one forever — that would be worse than the collision. An ABSENT pid
 * reads as dead for the same reason: no evidence is not evidence.
 *
 * @param {string} args.root any checkout of the clone
 * @param {string|number|null} args.exclude the epic being started, by id
 * @returns {{id: string, branch: string|null, root: string, paths: string[]}[]}
 */
export const liveEpics = ({ root, exclude = null, alive = pidAlive }) => {
  const bases = epicBases(root).map(realpath);
  const roots = [resolve(root)];
  for (const block of git(root, 'worktree list --porcelain').stdout.split('\n\n')) {
    const line = block.split('\n').find((entry) => entry.startsWith('worktree '));
    const path = line?.slice('worktree '.length).trim();
    if (path && bases.some((base) => under(base, realpath(path)))) roots.push(resolve(path));
  }
  const skip = exclude === null ? null : normalizeId(exclude);
  const found = [];
  for (const candidate of [...new Set(roots)]) {
    let state;
    try {
      state = JSON.parse(readFileSync(resolve(candidate, '.afk', 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!alive(state.orchestratorPid)) continue;
    const id = state.epic?.id ?? state.epic;
    if (id === undefined || id === null || id === '') continue;
    if (skip !== null && normalizeId(id) === skip) continue;
    found.push({
      id: normalizeId(id),
      branch: state.branch ?? null,
      root: candidate,
      // Absent on a state file written before this existed, which reads as "no
      // evidence" and stays silent — the same rule `unrelatedChecks` follows.
      paths: state.claimedPaths ?? [],
    });
  }
  return found;
};
