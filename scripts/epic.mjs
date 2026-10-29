// scripts/epic.mjs — the bridge from a GitHub epic to a running DAG.
//
//   afk validate <id>   fetch, parse, validate, print. Creates NOTHING.
//   afk epic <id>       the same, then branch, draft PR, state, and runAuto.
//   afk epic <id> --task=<t>   the same, releasing one human gate and running
//                              only that task. See cliEpic for why it re-validates.
//
// scripts/epic-spec.mjs is pure and offline: it parses the `afk:` block, checks
// the schema, and does the graph math. This file owns everything that needs a
// process — `gh` for the epic and its sub-issues, `git` for the branch — plus
// the map→array translation into the DAG shape declared in scripts/lib.mjs.
//
// docs/epic-schema.md, "No local copy of the spec": the DAG is fetched at start
// and held in memory. Nothing here writes a spec file, and `afk validate` writes
// nothing at all — it is the acceptance path and must stay side-effect-free.
import { infisicalBlocker } from "./infisical.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EpicSpecError,
  findEpicBlocks,
  formatGraphMetrics,
  graphMetrics,
  parseEpicBlock,
  validateEpicSpec,
} from "./epic-spec.mjs";
import { configPath, currentRepo, DEFAULT_PROTECTED_EDITS, dirtyTreeLines, isMainModule, isProtectedPath, loadConfig, normalizeId, parseStatusPaths, run, shellQuote } from "./lib.mjs";
import { createEpicWorktree, epicWorktree, liveEpics, sharedBuildPaths } from "./worktree.mjs";
import { preflightConfigErrors } from "./scheduler.mjs";
import {
  buildForecast,
  LAUNCH_STATUSES,
  renderForecast,
  renderParked,
  renderStop,
  unattendedVerdict,
  withReviewStops,
} from "./forecast.mjs";
import { childLints, epicLints } from "./criteria-lints.mjs";
import { mergeDelegations } from "./merge-guards.mjs";

export class EpicBridgeError extends Error {
  constructor(errors) {
    super(errors.map((error) => error.message).join("\n"));
    this.name = "EpicBridgeError";
    this.errors = errors;
  }
}

// Issue numbers sort numerically; anything else falls back to string order so a
// non-numeric id can never crash the sort.
const byIssueNumber = (a, b) => {
  const left = Number(a);
  const right = Number(b);
  if (Number.isInteger(left) && Number.isInteger(right)) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Seam 1: the parser → DAG bridge
// ---------------------------------------------------------------------------

/**
 * Turn a parsed `afk:` block plus its child issues into the in-memory DAG that
 * `runAuto` takes.
 *
 * The block is a mapping keyed by issue number and carries dependencies only;
 * `title` and `body` come from the child issues, because docs/epic-schema.md
 * keeps the specification text on the issue and out of the block.
 *
 *   tasks: { "204": {...} }  →  tasks: [{ id: "204", ... }]
 *   depends_on               →  dependsOn
 *   gate: before             →  humanGated: true
 *
 * `checks` falls back to `config.defaultChecks`; `allowedPaths` is repo-wide
 * advisory scope until derivation at admission lands (docs/deferred.md).
 *
 * @param {object} spec parseEpicBlock output
 * @param {{number: number|string, title: string, state: string, body: string}[]} issues child issues
 * @param {object|null} config .afk-setup/config.yaml, or null when the project has none
 * @param {{number: number|string, title: string}} epic
 * @returns {{epic: object, branch: string, tasks: object[]}}
 * @throws {EpicBridgeError} carrying every problem at once, each naming a task id
 */
export const epicToDag = (spec, issues, config, epic = {}) => {
  const byNumber = new Map(
    (issues ?? []).map((issue) => [normalizeId(issue.number), issue]),
  );
  const ids = Object.keys(spec.tasks ?? {}).sort(byIssueNumber);
  const errors = [];
  const fail = (code, taskId, message) => errors.push({ code, taskId, message });

  // A task whose resolved `checks` list is empty reaches integration and merges
  // having run nothing. Whether the list is empty because .afk-setup/config.yaml has no
  // `defaultChecks` key or because it sets an empty one is not a distinction
  // worth drawing — the lane is ungated either way. Same rule as `normalizeDag`
  // in scripts/auto.mjs, so the epic path and the `--dag=` path admit exactly
  // the same tasks. `config === null` means no .afk-setup/config.yaml was found at all,
  // which `afk validate` tolerates so it stays useful in an unconfigured repo.

  const tasks = ids.map((id) => {
    const entry = spec.tasks[id] ?? {};
    const issue = byNumber.get(id);
    if (!issue) {
      fail(
        "no_child_issue",
        id,
        `task ${id}: no child issue #${id} was fetched for this epic — the block names a task the epic does not own`,
      );
    }
    // Copied, not aliased: without the spread every defaulted task shares ONE
    // array with .afk-setup/config.yaml, so one downstream mutation would rewrite the
    // stack config and every other task's gate at once.
    const checks = [
      ...(Array.isArray(entry.checks) ? entry.checks : (config?.defaultChecks ?? [])),
    ];
    if (!checks.length && config !== null) {
      fail(
        "ungateable",
        id,
        `task ${id}: no \`checks:\` on the task and .afk-setup/config.yaml's \`defaultChecks\` supplies none — nothing would verify this lane`,
      );
    }
    return {
      id,
      title: issue?.title ?? "",
      body: issue?.body ?? "",
      dependsOn: (entry.depends_on ?? []).map(normalizeId),
      checks,
      // v1 ships repo-wide advisory scope; derivation at admission is deferred.
      allowedPaths: ["**"],
      ...(entry.gate === "before" ? { humanGated: true } : {}),
      // `gate: after` — the task runs and integrates unattended, and the EPIC
      // then waits for a human to accept it. Lane L owns everything downstream;
      // this line is the whole of the epic path's part in it.
      ...(entry.gate === "after" ? { gateAfter: true } : {}),
    };
  });

  if (errors.length > 0) throw new EpicBridgeError(errors);
  return {
    epic: { id: normalizeId(epic.number ?? epic.id), title: epic.title ?? null },
    branch: spec.branch ?? null,
    tasks,
  };
};

/** Tasks with no dependencies — the widest the run can ever be at tick one. */
export const rootWidth = (dag) =>
  (dag?.tasks ?? []).filter((task) => (task.dependsOn ?? []).length === 0).length;

/**
 * The epic's `max_parallel` caps `.afk-setup/config.yaml`'s `maxParallel`; it never
 * raises it (docs/epic-schema.md:53).
 *
 * With a DAG, the CONFIG value is also raised toward the root width. That value is
 * a project-wide default, and a default below the number of tasks that are ready
 * at tick one just makes a root task queue behind a slot it never needed: one run
 * idled a root for 34 minutes, another took 1,292s against a ~712s critical path.
 * The raise is bounded by this machine's cores — the same ceiling `over_subscribed`
 * warns about below — and never lowers a config the operator set high. An epic's
 * own `max_parallel` is a deliberate per-epic lever and is still the last word.
 * @returns {number|null} null when there is no config to cap
 */
export const effectiveMaxParallel = (config, spec, dag) => {
  if (!config) return null;
  const configured = Number(config.maxParallel) || 1;
  const capped = Number(spec?.max_parallel);
  if (Number.isInteger(capped) && capped > 0) return Math.min(configured, capped);
  const cores = cpus().length || configured;
  return Math.max(configured, Math.min(rootWidth(dag), cores));
};

// ---------------------------------------------------------------------------
// Seam 2: the restart shape guard (docs/epic-schema.md failure mode 4)
// ---------------------------------------------------------------------------

// Shape is ids, edges and gates. Deliberately NOT titles or bodies: a retitled
// issue must not halt a six-hour run, and the spec text is not graph shape.
// Reads a live DAG and the `dagShape` persisted in .afk/state.json identically.
const shapeOf = (dag) =>
  (dag?.tasks ?? [])
    .map((task) => ({
      id: normalizeId(task.id),
      dependsOn: [...(task.dependsOn ?? [])].map(normalizeId).sort(byIssueNumber),
      humanGated: Boolean(task.humanGated),
      // Key-only-when-true, deliberately: the hash of every graph without a
      // `gate: after` is byte-identical to what it was before this field
      // existed, so the upgrade itself refuses no in-flight run. Present so
      // that *removing* a gate mid-run is refused like any other shape change.
      ...(task.gateAfter ? { gateAfter: true } : {}),
    }))
    .sort((a, b) => byIssueNumber(a.id, b.id));

/**
 * A stable fingerprint of the graph's shape, recorded in `.afk/state.json` at
 * run start and recomputed from the re-fetched epic on every restart.
 * @returns {string} sha256 hex
 */
export const graphShapeHash = (dag) =>
  createHash("sha256").update(JSON.stringify(shapeOf(dag))).digest("hex");

/**
 * Say what changed, in the terms a human debugs in. "task 207 is no longer in
 * the epic" beats "graph shape changed".
 * @returns {string[]} one line per structural change; empty when unchanged
 */
export const describeShapeChange = (before, after) => {
  const left = new Map(shapeOf(before).map((task) => [task.id, task]));
  const right = new Map(shapeOf(after).map((task) => [task.id, task]));
  const lines = [];
  const list = (ids) => (ids.length > 0 ? ids.join(", ") : "nothing");
  for (const id of [...left.keys()].sort(byIssueNumber)) {
    if (!right.has(id)) {
      lines.push(
        `task ${id} is no longer in the epic — it was closed, unlinked, or removed from the \`afk:\` block mid-run`,
      );
    }
  }
  for (const id of [...right.keys()].sort(byIssueNumber)) {
    if (!left.has(id)) {
      lines.push(`task ${id} was added to the epic after this run started`);
      continue;
    }
    const was = left.get(id);
    const now = right.get(id);
    if (was.dependsOn.join(",") !== now.dependsOn.join(",")) {
      lines.push(
        `task ${id} now depends on ${list(now.dependsOn)} (was ${list(was.dependsOn)})`,
      );
    }
    if (was.humanGated !== now.humanGated) {
      lines.push(
        now.humanGated
          ? `task ${id} is now human-gated (\`gate: before\`), and was not`
          : `task ${id} is no longer human-gated, and was`,
      );
    }
  }
  return lines;
};

// ---------------------------------------------------------------------------
// GitHub and git
// ---------------------------------------------------------------------------

const GRAPHQL = (owner, name, number) =>
  `{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){number title state body subIssues(first:50){totalCount nodes{number title state body}}}}}`;

/**
 * Fetch the epic and its sub-issues in one `gh` call. Read-only by construction:
 * a GraphQL query, never a mutation.
 */
export const fetchEpic = ({ repo, number, exec = run }) => {
  const [owner, name] = String(repo).split("/");
  if (!owner || !name) throw new Error(`--repo must be <owner>/<name>, got "${repo}"`);
  const result = exec(
    `gh api graphql -f query=${shellQuote(GRAPHQL(owner, name, number))}`,
  );
  if (result.status !== 0) {
    throw new Error(
      `gh could not read ${repo}#${number}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh returned something that is not JSON for ${repo}#${number}`);
  }
  const issue = payload?.data?.repository?.issue;
  if (!issue) throw new Error(`no issue ${repo}#${number}`);
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body ?? "",
    children: issue.subIssues?.nodes ?? [],
  };
};

/**
 * Whether the feature branch already exists, and whether its history has
 * diverged from the base. A branch that is a descendant of the base is a
 * resumable run; one that is not is somebody else's work under the same name.
 */
export const branchStatusOf = ({ root, branch, baseBranch = "main", exec = run }) => {
  const ref = `refs/heads/${branch}`;
  const head = exec(`git rev-parse --verify --quiet ${shellQuote(ref)}`, { cwd: root });
  if (head.status !== 0 || !head.stdout.trim()) return { exists: false };
  const sha = head.stdout.trim().slice(0, 7);
  const merged = exec(
    `git merge-base --is-ancestor ${shellQuote(baseBranch)} ${shellQuote(branch)}`,
    { cwd: root },
  );
  return { exists: true, divergent: merged.status !== 0, sha };
};

// ---------------------------------------------------------------------------
// Validation, both tiers of the deterministic layer
// ---------------------------------------------------------------------------

const quotePaths = (paths) => paths.map((path) => `\`${path}\``).join(", ");

// A ticket's acceptance criteria, as text, or null when it states none.
//
// Both headings real tickets use: `## Acceptance criteria` from the
// ticket-writing skill, and the `**Done when**` line the same skill ends its
// phases with. Null rather than '' when neither is there, because "named in the
// criteria" and "we cannot see any criteria" carry different weight — only the
// first is worth refusing a whole epic over.
const CRITERIA_HEADING = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)(?:acceptance criteria|done when)\b/im;
export const criteriaSection = (body) => {
  const text = String(body ?? "");
  const start = text.match(CRITERIA_HEADING);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = rest.match(/^[ \t]*#{1,6}[ \t]/m);
  const section = next ? rest.slice(0, next.index) : rest;
  // A heading with nothing under it states no criteria as surely as a missing
  // one — the #29 guard keys on `=== null`, so a whitespace-only section has to
  // resolve to null or it slips straight through. The `**Done when**` form only
  // matches its opening `**`, so strip the dangling closing marker before asking
  // whether anything real is left.
  return section.replace(/^\*+/, "").trim() ? section : null;
};

/**
 * The protected paths a piece of ticket text names, and no builder may edit.
 *
 * Epic #3's #18 required a new test script "added to the `test` script in
 * `package.json`". The builder did exactly that; the runner reverted it as a
 * manifest edit; the old chain ran green and the task was marked `passed` over a
 * file that had never executed. `revertedProtected` recorded the fact and
 * nothing read it — so the criterion was unsatisfiable, silently, at the one
 * moment fixing it was still free.
 *
 * A path is only unsatisfiable when `protectedEdits` grants the builder NO keys
 * on it. `package.json` now carries `[scripts]`, so the ticket that started this
 * validates clean; a lockfile, `AGENTS.md` or anything under `.afk-setup/` still
 * cannot be done by a lane at all.
 */
export const protectedPathsNamed = (text, protectedEdits = DEFAULT_PROTECTED_EDITS) => {
  const named = new Set();
  for (const token of String(text ?? "").match(/[\w.][\w./-]*/g) ?? []) {
    const path = token.replace(/[.,;:)]+$/, "");
    if (!isProtectedPath(path)) continue;
    // A file the project lets builders edit is ordinary work, whatever the
    // revert list says. Same test as `allowedProtectedEdit`: an entry with no
    // keys grants nothing.
    const keys = protectedEdits?.[path];
    if (Array.isArray(keys) && keys.length) continue;
    named.add(path);
  }
  return [...named].sort();
};

/**
 * The criteria bullets that hand a builder a choice of what to do.
 *
 * #169's criterion said duplication must be "accepted with a stated reason **or**
 * avoided by design". The lane took the second branch, shipped a comment-only
 * diff plus a test pinning the bug as correct, and passed every gate honestly.
 * An `or` at the top level of a bullet is an escape hatch and a well-behaved
 * agent will use it.
 *
 * Narrow on purpose. Only top-level bullets — an `or` in an indented sub-bullet
 * is elaborating a parent that already said what to do — and inline code is
 * stripped first, so a bullet about `a or b` as a token is not a finding. The
 * result can only ever be a warning: "returns 404 or 410" is a legitimate
 * criterion and no epic should be stranded over one.
 */
export const escapeHatchBullets = (criteria) =>
  String(criteria ?? "")
    .split("\n")
    .filter((line) => /^(?:[-*+]|\d+[.)])[ \t]+\S/.test(line))
    .filter((line) => /(?:^|[^\w`])or(?:$|[^\w`])/i.test(line.replace(/`[^`]*`/g, " ")))
    .map((line) => line.trim());

// ---------------------------------------------------------------------------
// The gate that measured a file no lane touched
// ---------------------------------------------------------------------------
//
// Epic 56 on gitproj-demo ran four lanes. Every lane gate and every integration
// gate — eight of them — was `node src/greet.js`, the project's `defaultChecks`.
// No ticket in the epic touched `src/greet.js`. The board went green, over a
// false README and a test asserting the wrong invariant, because the gate had no
// relationship to the change. `defaultChecks` is a project-wide constant written
// once and nothing has ever read it against what an epic actually modifies.

// A token is a path when it says so itself: it carries a `/`, or it ends in an
// extension source files actually use. Nothing else — `npm`, `test`, `--fix` and
// `1.0.0` are words, and treating a word as a filename would put a false "your
// gate is broken" on every project that runs `npm test`.
const SOURCE_EXTENSION =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|json|md|ya?ml|toml|rs|py|go|rb|sh|css|scss|html|sql)$/i;

const normalizePath = (token) => token.replace(/^\.\//, "").replace(/\/+$/, "");

// A git ref, not a file: `feat/merge-search-into-palette`, `origin/feat/…`,
// `salvage/664-c39db3bd`, `afk/task-12`. Branch names reach ticket prose
// constantly, and every one used to become a claimed path.
const BRANCH_SHAPED = /^(?:origin|upstream|refs|feat|feature|fix|hotfix|chore|salvage|afk)\//;

// `401/403`, `Close/Reopen`, `Preview/Production`: a slash meaning "or" between
// numbers or between capitalised words.
const WORD_SEGMENTS = /^(?:\d+|[A-Z][a-z]+)(?:\/(?:\d+|[A-Z][a-z]+))+$/;

// The same "or" between lowercase words, which cannot be told from `src/lib` by
// shape: `null/empty`, `local/staging/prod`, `read/write`. A token counts as one
// only when EVERY segment is on this list, so `src/lib` and `tests/unit` pass.
const ALTERNATIVE_WORDS = new Set([
  "null", "empty", "undefined", "none", "true", "false", "yes", "no", "on", "off",
  "and", "or", "local", "dev", "development", "staging", "stage", "prod",
  "production", "preview", "read", "write", "get", "set", "open", "closed",
  "enabled", "disabled", "success", "failure", "light", "dark",
]);
const isAlternatives = (path) => path.split("/").every((segment) => ALTERNATIVE_WORDS.has(segment));

// A self-closing HTML tag's name: `<br/>` written without its `<`, in backticks.
const SELF_CLOSING_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "col", "area", "base", "embed", "source", "track", "param"]);

// Lowercase only, so `projectId/board` is not a path and `src-tauri`,
// `tests/unit` and `src/features/settings` are.
const LOWERCASE_PATH = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;

/**
 * The paths a check command names, as far as they can be known from its text.
 *
 * A shell command's real read set is undecidable from here — `npm test` names
 * nothing at all — so this returns [] rather than guessing, and every caller
 * treats [] as "no evidence" rather than "covers nothing".
 *
 * Prose goes through here too (`epicModifiedPaths`), and prose uses `/` for
 * "or" as often as for a directory. Every path this keeps can clash with
 * another epic's in `epicScopeClashes`, where `p` overlaps any `p/…`, so a
 * token without a source extension is kept only when its shape says directory:
 *
 *  - `./x`, always;
 *  - a single segment written `x/` and followed by a glob or a closing
 *    backtick (`src-tauri/**`, `locales/*.json`, `` `scripts/` ``), and not
 *    preceded by `<` — so `<br/>` gives no `br` and `/p/$projectId` no `p`;
 *  - two or more lowercase segments (`src/lib`, `tests/unit`) that are not all
 *    "or" words (`null/empty`, `local/staging/prod`).
 *
 * Branch-shaped refs, all-number or all-capitalised segments and a bare `.ts`
 * never count. What still slips through is a mixed-case directory named
 * without a slash; that fails toward silence, which the callers read as "no
 * evidence" (#145).
 * @returns {string[]} sorted, deduplicated
 */
export const checkPaths = (command) => {
  const text = String(command ?? "");
  const found = new Set();
  for (const match of text.matchAll(/[\w.][\w./-]*/g)) {
    const token = match[0].replace(/[.,;:)]+$/, "");
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + token.length] ?? "";
    const path = normalizePath(token);
    // `${path}/`, so a bare `origin/` or `feat/` is a branch prefix too, not a
    // directory. After `@` it is a scoped package (`@tauri-apps/*`, `pnpm
    // --filter @app/web`); after `\` it is the inside of a regex (`\bcargo\b`).
    if (!path || BRANCH_SHAPED.test(`${path}/`) || WORD_SEGMENTS.test(path)) continue;
    if (before === "@" || before === "\\") continue;
    const base = path.split("/").at(-1);
    if (SOURCE_EXTENSION.test(base)) {
      // `.ts` on its own is an extension someone mentioned, not a file.
      if (!base.startsWith(".") || base.slice(1).includes(".")) found.add(path);
      continue;
    }
    if (token.startsWith("./")) {
      found.add(path);
      continue;
    }
    if (!path.includes("/")) {
      // Not after `/` either: then it is the tail of something longer, like
      // `/p/$projectId` or the regex `/^src\/lib/`.
      if (token.endsWith("/") && before !== "<" && before !== "/" && !SELF_CLOSING_TAGS.has(path)
        && (after === "*" || after === "`")) found.add(path);
      continue;
    }
    if (LOWERCASE_PATH.test(path) && !isAlternatives(path)) found.add(path);
  }
  return [...found].sort();
};

// `a` and `b` name the same work when they are the same path or one contains the
// other — `test/` gates `test/smoke.test.mjs`.
const pathsOverlap = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// A claim that covers the whole repository. `**` is the runner's own repo-wide
// advisory scope (scripts/auto.mjs `allowedPaths` defaults to it), and it is the
// OPPOSITE of `[]`: empty means "no evidence", `**` means "everything". Reading
// a glob as "claims nothing" is exactly how one lane silently swallows another's
// files, so it gets its own branch below rather than falling through the
// path-by-path comparison, where `**` matches no literal path at all.
const REPO_WIDE = new Set(["**", ".", "./", "/", "*"]);

/**
 * Files this epic and a concurrently-running epic on the same clone both claim.
 *
 * `afk epic --worktree` lets two epics run at once against one clone and nothing
 * reconciles their scopes. The runner enforces scope per FILE and never per
 * region inside it, so two epics that both name `locales/en.json` — #388 owning
 * `agents.*` and #389 owning `compose.*`, disjoint on paper — put two lanes on
 * two branches editing one file, and the first thing that notices is the merge.
 *
 * Empty on either side is silent: prose is a heuristic and an epic whose tickets
 * simply do not name their files must not be nagged, the same rule
 * `unrelatedChecks` follows. A repo-wide claim is not empty and clashes with
 * everything.
 *
 * @param {string[]} mine this epic's claimed paths
 * @param {{id: string, branch?: string, root?: string, paths: string[]}[]} others
 * @returns {{id, branch, root, paths: string[], repoWide: boolean}[]}
 */
export const epicScopeClashes = (mine, others) => {
  const ours = (mine ?? []).filter(Boolean);
  if (ours.length === 0) return [];
  const oursWide = ours.some((path) => REPO_WIDE.has(path));
  const clashes = [];
  for (const other of others ?? []) {
    const theirs = (other?.paths ?? []).filter(Boolean);
    if (theirs.length === 0) continue;
    const repoWide = oursWide || theirs.some((path) => REPO_WIDE.has(path));
    // Under a repo-wide claim every path is shared, so the evidence worth
    // printing is what the other epic said it owns, not an intersection.
    const shared = repoWide
      ? [...theirs].sort()
      : ours.filter((path) => theirs.some((owned) => pathsOverlap(path, owned))).sort();
    if (shared.length === 0) continue;
    clashes.push({
      id: normalizeId(other.id),
      branch: other.branch ?? null,
      root: other.root ?? null,
      paths: shared,
      repoWide,
    });
  }
  return clashes;
};

/**
 * The paths this epic says it will modify, in the only form available at
 * validate time: prose.
 *
 * `allowed_paths` is derived at ADMISSION against the live tree
 * (docs/epic-schema.md:109) and does not exist yet here, so the signal is the
 * union of path tokens named in the epic body and in every child issue body —
 * the same token scan `protectedPathsNamed` already trusts for a hard error.
 * The epic's own `afk:` block is cut out first: a task's `checks:` command lives
 * there, and counting the file it gates as a file the epic modifies would
 * silence exactly the case this exists for.
 *
 * Prose over-names as often as it under-names. For `unrelatedChecks` an extra
 * path only makes the check quieter; for `epicScopeClashes` it is a false
 * clash, which is why `checkPaths` drops tokens that do not say they are paths.
 * @returns {string[]} sorted, deduplicated; empty means "no evidence"
 */
export const epicModifiedPaths = (epic) => {
  const body = String(epic?.body ?? "");
  const prose = findEpicBlocks(body).reduce(
    (text, block) => text.split(block.content).join("\n"),
    body,
  );
  const paths = new Set(checkPaths(prose));
  for (const child of epic?.children ?? []) {
    for (const path of checkPaths(child?.body ?? "")) paths.add(path);
  }
  return [...paths].sort();
};

/**
 * The resolved check commands that name paths and reach none of the epic's work.
 *
 * Judged per task over its WHOLE `checks` list — a task's own `checks:` override
 * `defaultChecks`, and a lane with a second gate that does reach the change is
 * not blind. Silent whenever there is nothing to go on: a command naming no
 * path, an epic naming no paths. A warning without evidence is worse than the
 * bug. Grouped by command, not by lane: eight identical gates are one fact.
 * @returns {{command: string, paths: string[], taskIds: string[]}[]}
 */
export const unrelatedChecks = (dag, modifiedPaths) => {
  const modified = modifiedPaths ?? [];
  if (modified.length === 0) return [];
  const covers = (path) => modified.some((owned) => pathsOverlap(path, owned));
  const byCommand = new Map();
  for (const task of dag?.tasks ?? []) {
    const named = (task?.checks ?? [])
      .map((command) => ({ command, paths: checkPaths(command) }))
      .filter((gate) => gate.paths.length > 0);
    if (named.length === 0) continue;
    if (named.some((gate) => gate.paths.some(covers))) continue;
    for (const gate of named) {
      const entry = byCommand.get(gate.command) ?? { ...gate, taskIds: [] };
      entry.taskIds.push(normalizeId(task.id));
      byCommand.set(gate.command, entry);
    }
  }
  return [...byCommand.values()];
};

/**
 * The whole of `afk validate`, as a pure function of a fetched epic.
 *
 * Runs `validateEpicSpec` (Lane B's offline tier) and then the two checks it
 * deliberately could not make — every task key is a real OPEN sub-issue of this
 * epic, and `branch` does not already exist with divergent history.
 *
 * @param {{number, title, body, children}} epic
 * @param {object|null} config .afk-setup/config.yaml, or null when absent
 * @param {(branch: string) => {exists: boolean, divergent?: boolean, sha?: string}} branchStatus
 * @returns {object} a report; `ok` is the exit decision
 */
export const validateEpic = ({ epic, config, branchStatus, liveEpics = [] }) => {
  const errors = [];
  const warnings = [];
  const report = {
    ok: false,
    epic: { id: normalizeId(epic.number), title: epic.title ?? null },
    branch: null,
    spec: null,
    dag: null,
    graph: "",
    metrics: null,
    graphShapeHash: null,
    forecast: null,
    effectiveMaxParallel: null,
    errors,
    warnings,
  };
  if (!config) {
    warnings.push({
      code: "no_config",
      taskId: null,
      message:
        "no .afk-setup/config.yaml in this project — validating the epic only. `afk epic` needs one to know how this stack is verified.",
    });
  } else if (!config.roles || Object.keys(config.roles).length === 0) {
    // The run-time half of a check whose setup-time half is prose. `roles:` is
    // written once, by hand, at setup — and setup can skip that step silently:
    // the step fires on the repo already having `.afk-setup/` or `.afk/`, which
    // a repo being set up for the first time does not, by definition. Nothing
    // downstream then complains, because a lane with no skill grounding runs
    // perfectly well and merely invents plausible skill names that fail as "no
    // such skill".
    //
    // A WARNING, never a refusal. Four repos in this estate run today with a
    // config and no `roles:` key — NoteBoard1, quillnote, riverbend,
    // trip-journal-demo — and refusing would break four working repos to
    // enforce a preference.
    warnings.push({
      code: "no_roles",
      taskId: null,
      message:
        ".afk-setup/config.yaml has no `roles:` block — every lane runs with no skill grounding, "
        + "and a model that is not told which skills exist invents names that fail silently. "
        + "Run `afk stack detect` for a proposal.",
    });
  }

  // `preflight:` is a closed block (#180): an unknown key is a typo that would
  // otherwise run no probe. Checked here, offline — validate runs no probe.
  for (const message of preflightConfigErrors(config))
    errors.push({ code: "preflight_config", taskId: null, message });

  let spec;
  try {
    spec = parseEpicBlock(epic.body ?? "");
  } catch (error) {
    if (!(error instanceof EpicSpecError)) throw error;
    errors.push({ code: "parse", taskId: null, message: error.message });
    return report;
  }
  report.spec = spec;
  report.branch = spec.branch ?? null;

  const schema = validateEpicSpec(spec);
  errors.push(...schema.errors);
  warnings.push(...schema.warnings);

  // Everything below reads the graph, which only holds together once the schema
  // does. Bailing here keeps a dangling reference from surfacing as a crash.
  if (errors.length > 0) return report;

  // The two checks scripts/epic-spec.mjs is explicit about leaving to this layer.
  const children = new Map(
    (epic.children ?? []).map((child) => [normalizeId(child.number), child]),
  );
  for (const id of Object.keys(spec.tasks ?? {}).sort(byIssueNumber)) {
    const child = children.get(id);
    if (!child) {
      errors.push({
        code: "no_child_issue",
        taskId: id,
        message: `task ${id}: #${id} is not a sub-issue of epic #${epic.number} (its sub-issues are ${[...children.keys()].sort(byIssueNumber).join(", ") || "none"})`,
      });
    } else if (String(child.state).toUpperCase() !== "OPEN") {
      errors.push({
        code: "child_closed",
        taskId: id,
        message: `task ${id}: #${id} is ${String(child.state).toLowerCase()}, not open — a closed issue is not runnable work`,
      });
    }
    // Two severities for one scan, and the split is the whole usability of it.
    // A protected path in the ACCEPTANCE CRITERIA is work no lane can do, so it
    // is a refusal while the fix is still a ticket edit. The same path in the
    // surrounding prose — "follow the conventions in AGENTS.md" — is an ordinary
    // thing for a ticket to say, and hard-failing an epic over a pointer is how
    // a validator becomes something people work around.
    const criteria = child ? criteriaSection(child.body) : null;
    const edits = config?.protectedEdits;
    const required = criteria ? protectedPathsNamed(criteria, edits) : [];
    const remedy = "Rewrite the ticket, or allow the edit in `protectedEdits` in .afk-setup/config.yaml.";
    if (required.length) {
      errors.push({
        code: "unsatisfiable_criterion",
        taskId: id,
        message: `task ${id}: #${id}'s acceptance criteria name ${quotePaths(required)}, which the runner reverts under every lane — a builder cannot satisfy that, and the revert is recorded rather than raised. ${remedy}`,
      });
    }
    // A child with NO criteria section is the other half of the same problem.
    // #169 passed every gate over a comment-only diff because its ticket named
    // nothing to check: with no criteria the closeout verifier is diff-only and
    // says so itself, reviewing the change against itself. Refusing here costs a
    // ticket edit; the alternative costs a full billed run.
    if (child && criteria === null) {
      errors.push({
        code: "no_acceptance_criteria",
        taskId: id,
        message: `task ${id}: #${id} states no acceptance criteria — the closeout verifier has nothing to check the diff against and reviews it against itself. Give #${id} an \`## Acceptance criteria\` section, or a \`**Done when**\` line.`,
      });
    }
    // The other half of #169, and the half that costs a whole billed run: a
    // criterion the lane can satisfy by choosing the cheap branch. A warning,
    // never an error — "returns 404 or 410" is a legitimate bullet, and the
    // check exists to put the pattern in front of the human who is standing
    // here now, not to arbitrate it.
    const hatches = criteria ? escapeHatchBullets(criteria) : [];
    if (hatches.length) {
      warnings.push({
        code: "criterion_escape_hatch",
        taskId: id,
        message: `#${id} has ${hatches.length === 1 ? "a criterion that offers" : `${hatches.length} criteria that offer`} a choice: ${hatches.map((bullet) => `"${bullet}"`).join("; ")}. #169 read "accepted with a stated reason or avoided by design"; the lane took the second branch, shipped a comment-only diff plus a test pinning the bug as correct, and passed every gate honestly. Fine if both branches are really acceptable — otherwise say which one, or name something mechanical the diff must show.`,
      });
    }
    const mentioned = (child ? protectedPathsNamed(child.body, edits) : []).filter((path) => !required.includes(path));
    if (mentioned.length) {
      warnings.push({
        code: "protected_path_named",
        taskId: id,
        message: `#${id} mentions ${quotePaths(mentioned)}, which a builder may not edit. Harmless if the ticket only points at it; if the work needs that edit, no lane can do it. ${remedy}`,
      });
    }
    // A person asked for inside a lane, a whole suite named as a lane gate
    // (scripts/criteria-lints.mjs). Same error/warning split as above.
    if (child) {
      const lints = childLints({ id, body: child.body, task: spec.tasks[id], config });
      errors.push(...lints.errors);
      warnings.push(...lints.warnings);
    }
  }
  for (const id of [...children.keys()].sort(byIssueNumber)) {
    if (!Object.hasOwn(spec.tasks ?? {}, id)) {
      warnings.push({
        code: "child_not_in_block",
        taskId: id,
        message: `#${id} is a sub-issue of this epic but is not in the \`afk:\` block — it will not be run`,
      });
    }
  }
  // User stories no child carries, and one-way doors crossed without a gate.
  const lints = epicLints({ epic, spec, config });
  errors.push(...lints.errors);
  warnings.push(...lints.warnings);

  if (report.branch) {
    const status = branchStatus(report.branch);
    if (status.exists && status.divergent) {
      errors.push({
        code: "branch_divergent",
        taskId: null,
        message: `branch \`${report.branch}\` already exists at ${status.sha} with divergent history — it is not a descendant of the base branch. Rename the epic's branch or delete that one.`,
      });
    } else if (status.exists) {
      warnings.push({
        code: "branch_exists",
        taskId: null,
        message: `branch \`${report.branch}\` already exists at ${status.sha} and is a descendant of the base — this run will resume on it`,
      });
    }
  }

  try {
    report.metrics = graphMetrics(spec);
    report.graph = formatGraphMetrics(report.metrics);
  } catch (error) {
    if (!(error instanceof EpicSpecError)) throw error;
    errors.push({ code: "graph", taskId: null, message: error.message });
    return report;
  }

  // The stop forecast (scripts/forecast.mjs): pure, offline, from the spec and
  // the config. `launchStatus` is read off the loaded config here, so the config
  // loader stays as it is.
  report.forecast = buildForecast({ spec, config });
  const launch = report.forecast.launchStatus;
  if (!launch.declared) {
    warnings.push({
      code: "no_launch_status",
      taskId: null,
      message: `launch status: not declared, treated as launched. Set \`launchStatus:\` to ${LAUNCH_STATUSES.join(" or ")} in .afk-setup/config.yaml.`,
    });
  } else if (!LAUNCH_STATUSES.includes(launch.value)) {
    errors.push({
      code: "launch_status",
      taskId: null,
      message: `.afk-setup/config.yaml's \`launchStatus\` must be ${LAUNCH_STATUSES.join(" or ")}, got ${JSON.stringify(launch.value)}`,
    });
  }

  try {
    report.dag = epicToDag(spec, epic.children ?? [], config, epic);
    report.graphShapeHash = graphShapeHash(report.dag);
  } catch (error) {
    if (!(error instanceof EpicBridgeError)) throw error;
    // The membership errors above already named these; keep the bridge's own.
    for (const entry of error.errors) {
      if (!errors.some((seen) => seen.code === entry.code && seen.taskId === entry.taskId)) {
        errors.push(entry);
      }
    }
  }

  // Needs the DAG, because `checks` is only resolved against `defaultChecks`
  // there. A warning, never an error: the path scan is a heuristic over prose,
  // and an epic whose tickets simply do not name their files should not be
  // refused over it.
  const modified = epicModifiedPaths(epic);
  for (const gate of unrelatedChecks(report.dag, modified)) {
    const shown = modified.slice(0, 6);
    const more = modified.length - shown.length;
    warnings.push({
      code: "checks_unrelated",
      taskId: null,
      message: `\`${gate.command}\` gates ${gate.taskIds.length === 1 ? "task" : "tasks"} ${gate.taskIds.join(", ")} and exercises ${quotePaths(gate.paths)}, which this epic never names as work — its tickets name ${quotePaths(shown)}${more > 0 ? ` and ${more} more` : ""}. That gate is green before the run starts, so passing it says nothing about the change. Give the tasks their own \`checks:\` in the epic's \`afk:\` block, or point \`defaultChecks\` in .afk-setup/config.yaml at what this epic touches.`,
    });
  }

  // Warn, at the one moment a human is present. Not a refusal: the path scan is
  // prose, two epics may legitimately share a file, and there is no override to
  // offer. Not a hold either — see the note above `epicScopeClashes` and
  // docs/failure-modes.md R17. `report.modifiedPaths` is published for the same
  // reason the other epic's paths were: the next epic to start reads it back out
  // of `.afk/state.json`.
  report.modifiedPaths = modified;
  for (const clash of epicScopeClashes(modified, liveEpics)) {
    const where = clash.branch ? ` on \`${clash.branch}\`` : "";
    warnings.push({
      code: "epic_scope_clash",
      taskId: null,
      message: `epic #${clash.id} is running right now against this clone${where} and ${
        clash.repoWide
          ? `claims the whole repository (${quotePaths(clash.paths)})`
          : `its tickets also name ${quotePaths(clash.paths)}`
      }, which this epic's tickets name too. Scope is enforced per file and never per key or per region inside one, so a lane here and a lane there will edit that file on two branches and the merge is the first thing that notices. Run these epics one after the other, or narrow one of them off ${quotePaths(clash.paths.slice(0, 3))}. If that run is already over, archive its \`.afk/state.json\`${clash.root ? ` under ${clash.root}` : ""}.`,
    });
  }

  // The machine-derived half of the parallelism story, and it needs the DAG, so
  // it sits below the bridge. `MAX_PARALLEL_CEILING` in scripts/epic-spec.mjs is
  // a portable typo guard and deliberately knows nothing about this host; this is
  // the place that does. Warnings, never errors: over-subscribing is slow, not
  // wrong, and the operator may know something `cpus().length` does not.
  const effective = effectiveMaxParallel(config, spec, report.dag);
  const cores = cpus().length;
  const configured = config ? Number(config.maxParallel) || 1 : null;
  if (effective && effective > configured) {
    warnings.push({
      code: "parallelism_raised",
      taskId: null,
      message: `maxParallel raised from ${configured} to ${effective} for this run: ${rootWidth(report.dag)} tasks have no dependencies, so ${configured} would idle a ready lane for nothing. Capped at this machine's ${cores} cores. Set \`max_parallel\` in the epic's \`afk:\` block to hold it down.`,
    });
  }
  if (effective && cores && effective > cores) {
    warnings.push({
      code: "over_subscribed",
      taskId: null,
      message: `effective maxParallel ${effective} exceeds this machine's ${cores} cores — every lane is a full agent, so they will contend rather than run in parallel`,
    });
  }

  report.effectiveMaxParallel = effective;
  report.ok = errors.length === 0;
  return report;
};

/**
 * The human rendering of a validation report. `--json` prints the report itself.
 */
export const renderValidation = (report, { unattended = false } = {}) => {
  const lines = [
    `Epic #${report.epic.id}${report.epic.title ? ` — ${report.epic.title}` : ""}`,
  ];
  if (report.branch) lines.push(`Branch: ${report.branch}`);
  if (report.effectiveMaxParallel !== null) {
    lines.push(`Max parallel: ${report.effectiveMaxParallel}`);
  }
  if (report.graph) {
    lines.push("", `Graph (${report.metrics.total} tasks):`, report.graph);
    const deepest = Math.max(...report.metrics.rows.map((row) => row.depth));
    lines.push(`Depth: ${deepest}`);
  }
  if (report.forecast) {
    lines.push("", ...renderForecast(report.forecast, { epicId: report.epic.id, unattended }));
  }
  if (report.warnings.length > 0) {
    lines.push("", `Warnings (${report.warnings.length}):`);
    for (const warning of report.warnings) {
      lines.push(`  - ${warning.taskId ? `[${warning.taskId}] ` : ""}${warning.message}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push("", `Errors (${report.errors.length}):`);
    for (const error of report.errors) {
      lines.push(`  ✗ ${error.taskId ? `[${error.taskId}] ` : ""}${error.message}`);
    }
    lines.push("", "VALIDATE: refused. Nothing was created.");
  } else {
    lines.push("", "VALIDATE: ok. Nothing was created.");
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const usage = `Usage:
  node scripts/epic.mjs validate <issue> [--repo=<owner/name>] [--json] [--plan-review] [--unattended]
  node scripts/epic.mjs epic <issue> [--repo=<owner/name>] [--base=<branch>]
                                     [--runtime=direct|herdr] [--instructions=<text>]
                                     [--task=<id>] [--accept=<id>[,<id>] [--force | --delegated]]
                                     [--delegate=<id>[,<id>] --delegate-condition="<text>"
                                      [--delegate-evidence=walkthrough]] [--waive-user-facing="<reason>"]
                                     [--unattended]

  --unattended   refuse unless the plan review passes and every stop in the
                 stop forecast has an answer in the afk: block's \`stops:\`.

  --task=<id>    release that one \`gate: before\` gate and run only it. The
                 epic is re-fetched and re-validated first; see cliEpic.
  --accept=<id>  accept a \`gate: after\` task, so the epic may close on it.
                 Refused unless the newest closeout review ran at the branch head.
  --force        with --accept: accept without that review.
  --delegated    with --accept: accept on the delegate's behalf, only for a gate
                 delegated at launch and only when every merge guardrail passes.
  --delegate=<id> let the delegate accept that \`gate: after\` task under
                 --delegate-condition. Recorded at launch; a restart may add one,
                 never change one.`;

/**
 * The delegation flags (#188), parsed. Pure, so the CLI and its test read the
 * same thing. Shape checks only: whether each id is a \`gate: after\` task is
 * \`mergeDelegations\`' question, asked once the DAG is known.
 *
 * @param {(name: string) => string|null} flag
 * @param {string[]} args
 */
export const parseDelegateFlags = (flag, args) => {
  const ids = (flag("delegate") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const condition = flag("delegate-condition");
  const evidence = flag("delegate-evidence");
  const waiver = flag("waive-user-facing");
  if (!ids.length && (condition !== null || evidence !== null)) {
    return { error: "--delegate-condition and --delegate-evidence need --delegate=<id>" };
  }
  if (args.includes("--delegate")) return { error: "--delegate needs a task id: --delegate=<id>[,<id>]" };
  return {
    delegations: ids.map((id) => ({ id: normalizeId(id), condition: condition ?? "", evidence: evidence ?? null })),
    waiver,
    acceptDelegated: args.includes("--delegated"),
  };
};

const readConfig = (root) => {
  if (!existsSync(configPath(root))) return null;
  return loadConfig(root);
};

// `--epic-body=<path>` substitutes a local file for the epic's body while still
// fetching the real epic and its real sub-issues. It exists so `coduo-tickets`
// (and this build's acceptance evidence) can check a block against live issue
// numbers *before* writing it back to the epic. It never writes anything.
export const loadReport = ({ root, repo, number, baseBranch, bodyPath }) => {
  const fetched = fetchEpic({ repo, number });
  const epic = bodyPath
    ? { ...fetched, body: readFileSync(resolve(root, bodyPath), "utf8") }
    : fetched;
  const config = readConfig(root);
  return {
    epic,
    config,
    report: validateEpic({
      epic,
      config,
      branchStatus: (branch) => branchStatusOf({ root, branch, baseBranch }),
      // Every OTHER epic running against this clone right now. Read here rather
      // than inside `validateEpic` so that function stays a pure function of a
      // fetched epic; this is the only caller that has a checkout to look at.
      liveEpics: liveEpics({ root, exclude: number }),
    }),
  };
};

// The semantic tier (docs/epic-schema.md, "Validation"). One read-only agent
// session, and the last thing that can refuse a run for free.
//
// It runs only when the deterministic tier passed — a report whose graph did not
// even resolve gives a reviewer nothing to be semantic about, and paying tokens
// to be told again about a cycle is the definition of an expensive "no".
//
// `runDir` is where the prompt and the transcript land. `afk epic` owns `.afk/`
// so it puts them there; `afk validate --plan-review` must leave the repository
// untouched, so it uses a directory outside it.
//
// `started` is the one thing the reviewer's verdict needs that the DAG does not
// carry: an `unsatisfied_criterion` blocks while the repair is still free, and
// the repair — putting the criterion back on the task — stops being available
// once that task has run. The DAG holds shape only, so the lifecycles come from
// `.afk/state.json`, the same split the rest of the runner uses. A fresh epic has
// no state file and every task is pending, which is exactly right.
const startedTasks = (root) => {
  try {
    const state = JSON.parse(readFileSync(resolve(root, ".afk", "state.json"), "utf8"));
    return new Set(
      Object.entries(state?.tasks ?? {})
        .filter(([, task]) => (task?.lifecycle ?? "pending") !== "pending")
        .map(([id]) => normalizeId(id)),
    );
  } catch {
    return new Set();
  }
};

// `repo` names the carry-forward store (scripts/plan-review.mjs), which lives
// outside the repository. A kept `needs_human` finding joins the stop forecast
// here, after the review and before anything reads the forecast: the
// `--unattended` check, the launch row and the hand-over to the Runner.
export const planReview = async ({ root, config, epic, report, instructions, runDir, quiet, repo }) => {
  const { planReviewStorePath, renderPlanReview, runPlanReview } = await import("./plan-review.mjs");
  const outcome = await runPlanReview({
    root,
    config: config ?? {},
    epic: { ...report.epic, body: epic.body ?? "" },
    dag: report.dag,
    metrics: report.metrics,
    customInstructions: instructions ?? null,
    started: startedTasks(root),
    runDir,
    storePath: planReviewStorePath({ repo, epicId: report.epic.id }),
  });
  if (!quiet) console.log(renderPlanReview(outcome));
  const before = report.forecast.stops.length;
  report.forecast = withReviewStops(report.forecast, { spec: report.spec, findings: outcome.findings });
  const raised = report.forecast.stops.slice(before);
  if (raised.length && !quiet) {
    console.log(
      [
        "Stop forecast, with the stops the plan review raised:",
        ...raised.map((stop) => renderStop(stop, report.forecast.parked.total)),
        renderParked(report.forecast),
      ].join("\n"),
    );
  }
  return outcome;
};

const cliValidate = async ({ root, repo, number, baseBranch, json, bodyPath, review, unattended = false }) => {
  const { epic, config, report } = loadReport({ root, repo, number, baseBranch, bodyPath });
  if (!json) console.log(renderValidation(report, { unattended }));
  // `--plan-review` is opt-in and nothing else turns it on, because plain
  // `afk validate` is the offline, token-free, auth-free acceptance path: it
  // must stay usable with no LLM at all, and must keep creating nothing inside
  // the repository. With the flag it starts one read-only agent and writes its
  // transcript to a throwaway directory outside the working tree.
  // `--unattended` needs the plan review's verdict, so it turns the review on.
  // The carry-forward store it reads and writes is outside the repository too.
  const outcome =
    (review || unattended) && report.ok
      ? await planReview({
          root,
          config,
          epic,
          report,
          quiet: json,
          runDir: mkdtempSync(join(tmpdir(), `afk-plan-review-${number}-`)),
          repo,
        })
      : null;
  if (outcome) report.planReview = outcome;
  const verdict = unattended
    ? unattendedVerdict({ report, review: outcome, infisical: infisicalBlocker({ config, dag: report.dag, cwd: root }) })
    : null;
  if (verdict) report.unattended = verdict;
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (verdict) console.log(verdict.line);
  if (verdict && !verdict.ok) return 1;
  return report.ok && (!outcome || outcome.ok) ? 0 : 1;
};

/**
 * `afk epic <id>` — and, with `--task=<id>`, the release of one human gate.
 *
 * **Releasing a gate re-validates the epic. Deliberately, and by taking exactly
 * the same path as a plain restart.** The reasoning, since it is the one design
 * call here:
 *
 *   1. There is no choice about re-*fetching*. docs/epic-schema.md, "No local
 *      copy of the spec": the DAG lives in memory for the life of a process and
 *      is never written to disk. A release is a new process, so the only place
 *      it can get a DAG to hand `runAuto` is GitHub. That is precisely why
 *      releasing a gate needed the `afk validate --json` → temp file → `afk run
 *      --dag=` workaround this flag removes.
 *   2. Given the fetch, validating it is free — scripts/epic-spec.mjs is pure
 *      and offline — and it buys the failure-mode-4 guard: `runAuto` compares
 *      `graphShapeHash` against `.afk/state.json` and refuses when the graph
 *      moved. So a child issue closed while the human was deciding stops the
 *      release instead of resuming into a stale shape. The workaround this
 *      replaces had that property too, by accident; this has it by construction.
 *   3. Everything else below — plan review, branch, draft PR — runs unchanged,
 *      because a release IS a restart with one task released, and a second path
 *      with weaker guarantees is how the two drift apart. The cost is one short
 *      read-only plan-review session per release, which is a human-paced action.
 *      Recorded so it is a known price and not a surprise: a plan review that
 *      refuses will refuse the release too.
 *
 * The gate itself is released inside the scheduler, not here: `explicitTaskId`
 * is the only thing that makes `runnableTasks` ignore `humanGated`
 * (scripts/scheduler.mjs), and it also narrows the run to that one task.
 */
const cliEpic = async ({
  root,
  repo,
  number,
  baseBranch,
  runtime,
  instructions,
  bodyPath,
  explicitTaskId = null,
  accept = [],
  acceptForce = false,
  acceptDelegated = false,
  delegations = [],
  userFacingWaiver = null,
  useWorktree = false,
  // `{ attempt, … }` on a process an auto-restart started (#146), else null.
  restart = null,
  unattended = false,
}) => {
  const { epic, config, report } = loadReport({ root, repo, number, baseBranch, bodyPath });
  console.log(renderValidation(report, { unattended }));
  if (!report.ok) {
    console.error("EPIC: validation failed; no branch, worktree or state was created.");
    return 1;
  }
  if (!config) {
    console.error(
      `EPIC: no .afk-setup/config.yaml at ${configPath(root)} — it says how this stack is verified and the runner will not guess.`,
    );
    return 1;
  }

  // A `--task=<id>` naming a task this epic does not have is a typo, and the
  // cheapest possible place to say so is here — before the plan review spends a
  // session and before anything is created. `runAuto` refuses it too, but only
  // after all of that has already happened.
  const explicit = explicitTaskId ? normalizeId(explicitTaskId) : null;
  // A delegation of a task that is not \`gate: after\`, or with no condition, is
  // refused here, before anything is created. \`runAuto\` asks again against
  // the delegations already in state, which only it can read.
  {
    const checked = mergeDelegations({
      dag: report.dag,
      supplied: delegations,
      waiver: userFacingWaiver,
      inLane: process.env.RUNNER_TASK_ID ?? null,
    });
    if (!checked.ok) {
      console.error(`EPIC: ${checked.reason}. Nothing was created.`);
      return 1;
    }
  }
  if (explicit && !report.dag.tasks.some((task) => task.id === explicit)) {
    console.error(
      `EPIC: --task=${explicit} is not a task in epic #${report.epic.id} (${report.dag.tasks.map((task) => task.id).join(", ")}). Nothing was created.`,
    );
    return 1;
  }

  // ---------------------------------------------------------------------
  // Preflight. Everything here is free, offline and deterministic, and none of
  // it can be influenced by the plan review or the branch below — so it runs
  // FIRST. `runAuto` repeats both of these checks, but it is the last thing
  // this command reaches: three failed starts in one live epic meant three paid
  // plan-review sessions billed for a run that never scheduled a task, and a
  // dirty tree refused a run only after the feature branch had been created.
  // ---------------------------------------------------------------------

  // The FIRST thing in the preflight, because it is the cheapest refusal this
  // command has: Codex on the herdr runtime cannot work at all, and every line
  // below spends something — a paid plan-review session, a branch, a draft PR.
  // `runAuto` repeats it for the operator who ran `afk auto` directly.
  {
    const { herdrRefusal } = await import("./auto.mjs");
    const refusal = herdrRefusal({ runtime, config });
    if (refusal) {
      console.error(`EPIC: ${refusal} Nothing was created.`);
      return 1;
    }
  }

  // `autoRestart` is read now, so a typo refuses before anything is spent
  // rather than at the first fatal hours in (#146).
  const { exitAfterFatal, restartAfterFatal, restartBudget } = await import("./restart.mjs");
  try {
    restartBudget(config);
  } catch (error) {
    console.error(`EPIC: ${error.message} Nothing was created.`);
    return 1;
  }

  // With `--worktree` the run does not touch this checkout, so its state is the
  // operator's business and not this command's — that separation is the whole
  // point of the flag. What must be clean is the tree the integrator commits
  // into, which is the epic's own worktree: absent on a first run, and worth
  // checking on a restart into one left mid-edit.
  const runRoot = useWorktree ? epicWorktree(root, report.epic.id) : root;
  if (!useWorktree || existsSync(runRoot)) {
    const dirty = parseStatusPaths(run("git status --porcelain", { cwd: runRoot }).stdout);
    if (dirty.length) {
      for (const line of dirtyTreeLines(dirty, "EPIC", "Nothing was created."))
        console.error(line);
      return 1;
    }
  }

  // A warning, never a refusal: a fixed build directory is legitimate for a
  // project that never runs two lanes, and this runner cannot tell. Every
  // worktree gets a private parent, so a one-level escape is already per-lane;
  // what is reported here is the remainder that still reaches shared ground.
  for (const found of sharedBuildPaths(root)) {
    console.error(
      `EPIC: warning — ${found.file} sets ${found.key} = "${found.value}", which resolves to ${found.resolved},`
      + ' outside every worktree\'s private parent. Each lane and epic worktree would build into that one directory,'
      + ' sharing cargo\'s build lock. Make it relative to the checkout by one level (e.g. "../target") or per-lane.',
    );
  }

  // The dashboard port, checked here rather than inside `runAuto`. The default
  // is derived from this checkout's path, so two checkouts of one project cannot
  // collide; a port held by another project is skipped rather than fatal. This
  // only proves a port is available — `runAuto` does the binding, deterministic
  // from the same root — but it makes the collision free instead of costing a
  // plan review, and it names the remedy on STDOUT rather than in a background
  // log nobody has opened yet.
  {
    const { probeDashboardPort, resolveDashboardPort } = await import("./dashboard-process.mjs");
    const { port, explicit } = resolveDashboardPort({ root: runRoot });
    try {
      const found = await probeDashboardPort({
        root: runRoot,
        port,
        attempts: explicit ? 1 : undefined,
      });
      console.log(
        `EPIC: dashboard port ${found.port}${found.existing ? " (already serving this checkout)" : ""}.`,
      );
    } catch (error) {
      console.error(`EPIC: ${error.message} Nothing was created.`);
      return 1;
    }
  }

  // The semantic tier, and the last line before this command starts creating
  // things. Everything below it — the branch, the draft PR, `.afk/state.json`,
  // every worktree — is downstream, so a contradiction here costs one short
  // read-only session and leaves the repository exactly as it was. It re-runs on
  // restart for the same reason the DAG is re-fetched on restart: there is no
  // local copy of the spec, so there is nothing to trust a cached verdict about.
  {
    const outcome = await planReview({
      root,
      config,
      epic,
      report,
      instructions,
      runDir: resolve(root, ".afk", "plan-review", String(report.epic.id)),
      repo,
    });
    if (!outcome.ok) {
      console.error(
        `EPIC: plan review refused — ${outcome.message.replace(/\.$/, "")}. No branch, worktree or pull request was created.`,
      );
      return 1;
    }
    // `--unattended`: every stop needs a recorded answer before anything is
    // created. Without the flag the forecast is printed and never refuses.
    if (unattended) {
      const verdict = unattendedVerdict({
        report, review: outcome, nothing: "No branch, worktree or pull request was created.",
        infisical: infisicalBlocker({ config, dag: report.dag, cwd: root }),
      });
      (verdict.ok ? console.log : console.error)(verdict.line);
      if (!verdict.ok) return 1;
    }
  }

  // Create the feature branch. `afk validate` already refused a divergent one,
  // so this either creates it or checks out a descendant of the base.
  const branch = report.branch;
  const status = branchStatusOf({ root, branch, baseBranch });
  if (!status.exists) {
    const created = run(
      `git branch ${shellQuote(branch)} ${shellQuote(baseBranch)}`,
      { cwd: root },
    );
    if (created.status !== 0) {
      console.error(`EPIC: cannot create branch ${branch}: ${created.stderr.trim()}`);
      return 1;
    }
    console.log(`EPIC: created ${branch} from ${baseBranch}.`);
  }
  // Where the branch actually gets checked out. `--worktree` puts it in a
  // worktree of its own so this checkout keeps whatever you had open; without
  // the flag the run takes the checkout over, as it always has.
  if (useWorktree) {
    try {
      const made = createEpicWorktree({
        root, branch, epicId: report.epic.id, setup: config.worktreeSetup,
      });
      console.log(
        `EPIC: ${made.reused ? "reusing" : "created"} the epic worktree at ${made.worktree}`
        + ` on ${branch}; ${root} is untouched.`,
      );
    } catch (error) {
      console.error(`EPIC: ${error.message}`);
      return 1;
    }
  } else {
    const checkout = run(`git checkout ${shellQuote(branch)}`, { cwd: root });
    if (checkout.status !== 0) {
      console.error(`EPIC: cannot check out ${branch}: ${checkout.stderr.trim()}`);
      return 1;
    }
  }

  // The epic's draft PR, opened here and nowhere else — feature-branch creation
  // is the only moment this runner is allowed to create something on GitHub, and
  // `afk validate` above returns long before this line. Create-or-update: on a
  // restart the PR already exists, and GitHub is asked for its number rather than
  // `.afk/state.json` remembering one. The body is rendered from state and the
  // DAG, one direction only; nothing ever reads it back. A failure here is a
  // warning, never a halt — see the header of scripts/pr.mjs.
  //
  // Gated by `pr:` config — only `each` pushes at start. `once` defers to
  // epic close; `off` never pushes.
  const { prMode, PR_EACH, ensureDraftPr, persistPrDelivery, readRunState, renderPrOutcome } = await import("./pr.mjs");
  let pr;
  try {
    pr = prMode(config ?? {});
  } catch (error) {
    console.error(`EPIC: ${error.message}`);
    return 1;
  }
  if (pr === PR_EACH) {
    const prOutcome = ensureDraftPr({
      root: runRoot,
      repo,
      branch,
      baseBranch,
      epic: report.epic,
      dag: report.dag,
      state: readRunState(runRoot),
    });
    const prLog = renderPrOutcome(prOutcome);
    if (prLog) console.log(prLog);
    persistPrDelivery(runRoot, prOutcome);
  }

  // The DAG is handed over in memory. No spec file is written, ever.
  const { runAuto } = await import("./auto.mjs");
  try {
    return await runAuto({
      config: { ...config, maxParallel: report.effectiveMaxParallel },
      dag: report.dag,
      root: runRoot,
      baseBranch: branch,
      runtime,
      epic: { id: report.epic.id, title: report.epic.title },
      graphShapeHash: report.graphShapeHash,
      // The stop forecast, with the epic's `stops:` answers, for the launch row.
      forecast: report.forecast,
      customInstructions: instructions,
      explicitTaskId: explicit,
      // Persisted into `.afk/state.json` so the NEXT epic started against this
      // clone can see what this one claims. Nothing else reads it back.
      claimedPaths: report.modifiedPaths ?? [],
      accept,
      acceptForce,
      acceptDelegated,
      delegations,
      userFacingWaiver,
      // The epic's own base, not `main`. Without it the closeout review diffs the
      // feature branch against `main` by default rather than against the base the
      // epic actually stated, and every commit already on that base reads as new.
      epicBase: baseBranch,
      autoRestarted: Boolean(restart),
    });
  } catch (error) {
    // Only a scheduler fatal is restarted (#146). Every refusal — preflight,
    // disk floor, dirty tree, auth — returns 1 above and never reaches here,
    // and a throw before the scheduler started carries no `fatal`.
    // After ANY scheduler fatal, restart or not, this process exits within a
    // bounded grace rather than lingering as #136's did — by `process.exit()`,
    // against the rule at the bottom of this file. `exitAfterFatal` says why
    // that is safe here: the log is appended synchronously, and a successor
    // writes to its own file, not to this process's pipe.
    // The original fatal stays the error this process reports, whatever the
    // restart does, and the bounded exit is armed even if it throws.
    if (error?.fatal) {
      try {
        restartAfterFatal({ root: runRoot, config, fatal: error.fatal, attempt: restart?.attempt ?? 0 });
      } catch (restartError) {
        console.error(`EPIC: the auto-restart failed: ${restartError.message}`);
      } finally {
        exitAfterFatal();
      }
    }
    throw error;
  }
};

// Deliberately an async function called without `await`, not a top-level await.
//
// scripts/auto.mjs imports `describeShapeChange` and `graphShapeHash` from this
// file, so `epic.mjs → (dynamic) auto.mjs → epic.mjs` is an import cycle. A
// top-level `await` here leaves this module's evaluation *pending* for as long
// as the CLI is running, and ES module evaluation of auto.mjs then waits on it
// forever: `afk epic <id>` printed its validation, created the branch, and died
// with ERR_UNSETTLED_TOP_LEVEL_AWAIT (exit 13) without runAuto ever executing a
// line. Returning from module evaluation immediately breaks the deadlock: by the
// time the dynamic import runs, this module is fully evaluated and the cycle is
// already satisfied.
//
// Found by Lane K while proving the draft-PR hook runs before the handover; the
// hook was the first thing to observe anything downstream of it.
const main = async () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [mode] = positional;
  // The issue number is the one positional that looks like an issue number, so a
  // space-form flag value (`--repo owner/name`) cannot be mistaken for it.
  const rawNumber = positional.slice(1).find((arg) => /^#?\d+$/.test(arg));
  // Both `--repo=o/n` and `--repo o/n`. The rest of the runner only accepts the
  // first, but a human (and the coduo-afk skill) types the second at least as
  // often, and silently falling back to the wrong repository is a nasty way to
  // learn the difference.
  const flag = (name) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    if (hit !== undefined) return hit.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at !== -1 && args[at + 1] && !args[at + 1].startsWith("--")) return args[at + 1];
    return null;
  };
  const root = process.cwd();
  const number = normalizeId(String(rawNumber ?? "").replace(/^#/, ""));
  if (!["validate", "epic"].includes(mode) || !/^\d+$/.test(number ?? "")) {
    console.error(usage);
    process.exit(1);
  }
  const repo = flag("repo") ?? currentRepo(root);
  if (!repo) {
    console.error(
      "EPIC: cannot tell which repository this is. Pass --repo=<owner/name>.",
    );
    process.exit(1);
  }
  const baseBranch = flag("base") || "main";
  // A restarted run (#146) takes its restart variables out of the environment
  // first, so nothing it spawns inherits them, and starts only once the
  // process it replaces is gone. `AFK_RESTART_WAIT_MS` is a test seam for the
  // 60-second wait.
  const restartModule = mode === "epic" ? await import("./restart.mjs") : null;
  const restart = restartModule?.takeRestartEnv() ?? null;
  if (restart) {
    const refusal = await restartModule.awaitPredecessor({
      pid: restart.predecessor,
      waitMs: Number(process.env.AFK_RESTART_WAIT_MS) || undefined,
    });
    if (refusal) {
      console.error(`EPIC: ${refusal}.`);
      restartModule.recordStop(restart.root, `restart ${restart.attempt} did not start: ${refusal}`, { notifyFatal: true });
      process.exitCode = 1;
      return;
    }
  }
  const delegate = mode === "epic" ? parseDelegateFlags(flag, args) : {};
  if (delegate.error) {
    console.error(`EPIC: ${delegate.error}.`);
    process.exitCode = 1;
    return;
  }
  let fatal = false;
  try {
    process.exitCode =
      mode === "validate"
        ? await cliValidate({
            root,
            repo,
            number,
            baseBranch,
            bodyPath: flag("epic-body"),
            json: args.includes("--json"),
            review: args.includes("--plan-review"),
            unattended: args.includes("--unattended"),
          })
        : await cliEpic({
            root,
            repo,
            number,
            baseBranch,
            runtime: flag("runtime"),
            instructions: flag("instructions"),
            bodyPath: flag("epic-body"),
            explicitTaskId: flag("task"),
            accept: (flag("accept") ?? "")
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
            acceptForce: args.includes("--force"),
            acceptDelegated: delegate.acceptDelegated,
            delegations: delegate.delegations,
            userFacingWaiver: delegate.waiver,
            useWorktree: args.includes("--worktree"),
            restart,
            unattended: args.includes("--unattended"),
          });
  } catch (error) {
    fatal = Boolean(error?.fatal);
    console.error(`${mode === "validate" ? "VALIDATE" : "EPIC"}: ${error.message}`);
    process.exitCode = 1;
  }
  // A restarted run that stopped without reaching its scheduler — any refusal,
  // here or in `runAuto` — still carries its predecessor's fatal. Say so where
  // `afk status` and a human will see it, or status goes on reading
  // "restarted after fatal (1 of 2)" over a run that is not running.
  if (restart && process.exitCode && !fatal) {
    let refused = true;
    try {
      refused = Boolean(JSON.parse(readFileSync(resolve(restart.root, ".afk", "state.json"), "utf8")).fatal);
    } catch {}
    if (refused)
      restartModule.recordStop(
        restart.root,
        `restart ${restart.attempt} refused to start; its output is in ${resolve(restart.root, ".afk", `restart-${restart.attempt}.log`)}`,
        { notifyFatal: true },
      );
  }
};

if (isMainModule(import.meta.url)) {
  // `process.exitCode`, never `process.exit()`, for the reason scripts/auto.mjs
  // gives: this process has written a run's worth of lines to a pipe.
  main().catch((error) => {
    console.error(`EPIC: ${error.message}`);
    process.exitCode = 1;
  });
}
