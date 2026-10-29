/**
 * The markdown task loader — `docs/wave-mode.md` §1 and §2.
 *
 * A directory of markdown task files in, the DAG JSON `normalizeDag` already
 * accepts out, or a list of refusals. **Pure**: `loadWaveDag` takes the files as
 * text and touches no filesystem, no git and no network, so the refusal table in
 * §1 can be a fixture table one directory per code. `readWaveDirectory` is the
 * only thing here that reads a disk, and it does nothing but read.
 *
 * Refusals, never warnings, and a malformed file refuses the WHOLE directory:
 * a warning at 3am is a warning nobody reads, and a directory that half-loads
 * schedules a graph the author never wrote.
 *
 * ## Codes beyond the fourteen in the spec
 *
 * §1's table names fourteen conditions. Two more are reachable and unnamed
 * there, so they are named here rather than squeezed into a code that means
 * something else:
 *
 *   `bad_shape`    — the frontmatter is not the strict YAML subset, or a key's
 *                    value is off-shape: `status` that is not `ready-for-agent`,
 *                    `gate` that is not `before`/`after`, a list key holding a
 *                    scalar. Reporting these as `missing_key` would send the
 *                    author looking for an absent key that is right there.
 *   `missing_goal` — no `GOAL.md`. §2 makes it the epic body the plan reviewer
 *                    checks the wave against; without it review compares tasks
 *                    to tasks, which is the failure that section exists to stop.
 *
 * Fail direction (AGENTS.md, "Fail direction"): every guard here fails
 * **closed**. This runs before a branch exists, which is the cheap moment to
 * stop bad work, and the cost of a wrong refusal is one edit to a markdown file.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { EpicSpecError, parseYamlSubset } from "./epic-spec.mjs";
import { ownsOverlap as scopesOverlap } from "./lib.mjs";

/** Frontmatter keys that must be present on every task file. */
export const REQUIRED_KEYS = ["id", "blocked_by", "owns", "status"];
/** Frontmatter keys that may be present. */
export const OPTIONAL_KEYS = ["checks", "gate"];
/** The closed set: anything else is `unknown_key`. */
export const FRONTMATTER_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

/** The only `status` a task file may carry. §1: the executor is the runner's `implementer` role. */
export const TASK_STATUS = "ready-for-agent";
export const GATES = ["before", "after"];

/** A `# ` heading, and the offset the body starts at. */
const HEADING = /^#[ \t]+(\S.*?)[ \t]*$/m;
/** §1's `no_criteria`, which the closeout verifier depends on existing. */
const CRITERIA = /^##[ \t]+Acceptance criteria[ \t]*$/im;
/** An opening `---` fence, then everything up to the closing one. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export class WaveLoadError extends Error {
  constructor(refusals) {
    super(refusals.map((refusal) => refusal.message).join("\n"));
    this.name = "WaveLoadError";
    this.refusals = refusals;
  }
}

/**
 * Split a task file into its frontmatter text and the markdown below it.
 * @returns {{front: string, rest: string}|null} null when there is no fence
 */
export const splitFrontmatter = (text) => {
  const match = FRONTMATTER.exec(String(text ?? "").replace(/^﻿/, ""));
  if (!match) return null;
  return { front: match[1], rest: String(text).slice(match[0].length) };
};

// Two spellings of one file are one claim, and collision has to see that or a
// pair that races is admitted: `Sources/Feature/` and `Sources/Feature`,
// `./docs/x.md` and `docs/x.md`, `a/../b` and `b`. Normalised by hand rather
// than through `node:path` because this stays pure — there is no root to
// resolve against, and `path.normalize` is platform-dependent about separators.
// `..` is resolved rather than refused here; a path that escapes the root is
// already a separate refusal.
const ownKey = (path) => {
  const out = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out.at(-1) !== "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
};

/**
 * §1: collision is directory-prefix aware. `Sources/Feature/` and
 * `Sources/Feature/View.swift` collide; `Sources/A/` and `Sources/B/` do not.
 *
 * The comparison is per SEGMENT, not per character, and it is `lib.mjs`'s
 * `ownsOverlap`: the scheduler's `owns` filter asks the same question of the
 * same claims, and two answers to one question is how a directory loads clean
 * and races anyway. Normalisation stays here — `ownKey` is about the two
 * spellings of one path a markdown author types, which the scheduler never
 * sees, and `lib`'s half is about the region a pattern covers.
 *
 * The two halves disagree in exactly one place, and this is where that is
 * decided: a claim that normalises to the empty key (`.`, `a/..`, `""` — the
 * whole repo) makes `lib.ownsOverlap` fail CLOSED and answer "overlaps
 * everything". Held at the loader's own direction instead, which is that such
 * a claim collides with nothing.
 *
 * That claim is now `owns_root`, so no ACCEPTED directory can reach here with
 * an empty key — but the divergence is still load-bearing, because a REFUSED
 * one can. The loader collects every problem in one pass rather than stopping
 * at the first, so the collision loop below still runs over a directory whose
 * `owns_root` already fired. Deferring to `lib`'s fail-closed answer there
 * would report one break as two codes, and send an author who typed `.` off
 * hunting a collision with a sibling that is not the mistake they made. One
 * break, one code, which is what makes the fixture table readable.
 */
export const ownsOverlap = (left, right) => {
  const a = ownKey(left);
  const b = ownKey(right);
  if (a === "" || b === "") return a === b;
  return scopesOverlap(a, b);
};

// Absolute, or climbing out of the repo root with `..`. Walked segment by
// segment rather than resolved against a real path, because the loader is pure
// and has no root to resolve against — and because `a/../../b` escapes even
// though it never starts with `..`.
const ownsEscapes = (path) => {
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return true;
  let depth = 0;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth < 0) return true;
  }
  return false;
};

// Claims the repository itself: an entry that normalises away to nothing (`.`,
// `./`, `""`, `a/..`). §1's other `owns` codes all read the entry as typed;
// this one reads what it MEANS, which is every file in the repo. Such a task
// races every sibling — and `owns_collision` cannot say so, because a claim on
// everything overlaps each sibling individually and the author would get one
// refusal per pair naming paths they never wrote.
//
// `owns_glob`'s neighbour, deliberately: `**` is the same claim spelled with a
// glob, and that one `owns_glob` already refuses.
const claimsRepoRoot = (path) => ownKey(path) === "";

// Every id each task transitively depends on. A fixpoint rather than a DFS on
// purpose: it terminates on a cyclic graph, so `owns_collision` is still
// reported for a directory that also has a `cycle` and the author fixes both in
// one pass instead of two.
const transitiveDeps = (tasks) => {
  const reach = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const seen of reach.values()) {
      for (const dep of [...seen]) {
        for (const next of reach.get(dep) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          changed = true;
        }
      }
    }
  }
  return reach;
};

// DFS over dependency edges, reporting the real cycle path — "a cycle exists"
// is not actionable on an eight-task graph. Same shape as `findCycles` in
// epic-spec.mjs, over `dependsOn` instead of `depends_on`.
const findCycles = (tasks) => {
  const edges = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const state = new Map();
  const stack = [];
  const seen = new Set();
  const cycles = [];
  const visit = (id) => {
    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue; // dangling; reported separately
      if (state.get(next) === "open") {
        const path = stack.slice(stack.indexOf(next)).concat(next);
        // Sorted so every rotation of one cycle collapses to one key: a 3-cycle
        // is reached from all three of its nodes and would otherwise read as
        // three separate problems to fix.
        const key = [...path.slice(0, -1)].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(path);
        }
        continue;
      }
      if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of edges.keys()) if (!state.has(id)) visit(id);
  return cycles;
};

/**
 * Parse one task file. Collects every problem in it rather than throwing on the
 * first: an author who fixes one key per run of the loader fixes six keys in six
 * runs, and the whole point of a load-time refusal is that it is cheap.
 */
const readTaskFile = ({ name, text, status }, fail) => {
  const stem = name.replace(/\.md$/, "");
  const at = (code, key, message) => fail({ code, file: name, key, message });

  const split = splitFrontmatter(text);
  if (!split) {
    at("bad_shape", null, `${name}: no \`---\` frontmatter fence — a task file opens with one, holding ${FRONTMATTER_KEYS.map((key) => `\`${key}\``).join(", ")}`);
    return null;
  }

  let front;
  try {
    front = parseYamlSubset(split.front);
  } catch (error) {
    const detail = error instanceof EpicSpecError ? error.message : String(error?.message ?? error);
    at("bad_shape", null, `${name}: the frontmatter is not the YAML subset this runner reads — ${detail}`);
    return null;
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) {
    at("bad_shape", null, `${name}: the frontmatter must be a mapping of keys`);
    return null;
  }

  for (const key of Object.keys(front)) {
    if (FRONTMATTER_KEYS.includes(key)) continue;
    at("unknown_key", key, `${name}: unknown frontmatter key \`${key}\` — the set is closed: ${FRONTMATTER_KEYS.join(", ")}`);
  }
  for (const key of REQUIRED_KEYS) {
    if (key in front) continue;
    at("missing_key", key, `${name}: required frontmatter key \`${key}\` is absent`);
  }

  // --- id -----------------------------------------------------------------
  const id = typeof front.id === "string" ? front.id : null;
  if ("id" in front && id === null) {
    at("bad_shape", "id", `${name}: \`id\` must be a string, and is ${JSON.stringify(front.id)}`);
  }
  if (id !== null && id !== stem) {
    at("id_mismatch", "id", `${name}: \`id\` is \`${id}\` but the filename stem is \`${stem}\` — they name one task and must agree`);
  }

  // --- blocked_by ---------------------------------------------------------
  let dependsOn = [];
  if ("blocked_by" in front) {
    if (Array.isArray(front.blocked_by) && front.blocked_by.every((edge) => typeof edge === "string")) {
      dependsOn = front.blocked_by;
    } else {
      at("bad_shape", "blocked_by", `${name}: \`blocked_by\` must be a list of task ids (\`[]\` when the task has none), and is ${JSON.stringify(front.blocked_by)}`);
    }
  }

  // --- owns ---------------------------------------------------------------
  let owns = [];
  if (!("owns" in front)) {
    // Absent is BOTH `missing_key` (reported above) and `owns_empty`: §1 defines
    // `owns_empty` as "`owns` is absent or empty", and an author reading a bare
    // `missing_key` learns nothing about why this key in particular is fatal.
    at("owns_empty", "owns", `${name}: \`owns\` is absent — a task with no owned paths claims nothing, and collision checking has nothing to check`);
  } else if (!Array.isArray(front.owns) || !front.owns.every((path) => typeof path === "string")) {
    at("bad_shape", "owns", `${name}: \`owns\` must be a list of repo-relative paths, and is ${JSON.stringify(front.owns)}`);
  } else if (front.owns.length === 0) {
    at("owns_empty", "owns", `${name}: \`owns\` is empty — a task must name at least one path it may create or edit`);
  } else {
    owns = front.owns;
    for (const path of owns) {
      if (/[*?[]/.test(path)) {
        at("owns_glob", "owns", `${name}: \`owns\` entry \`${path}\` contains a glob character (\`*\`, \`?\` or \`[\`) — name the files, or the directory prefix, so collision is decidable`);
      }
      // Escape is asked first, and `owns_root` is its `else`. `/` is the one
      // entry both descriptions fit — absolute, and normalising to nothing —
      // and `owns_escape` is the older and the more specific reading of it, so
      // it keeps that input rather than the two codes both firing on one break.
      // Neither subsumes the other: leaving the repo root and claiming it are
      // different mistakes with different fixes.
      if (ownsEscapes(path)) {
        at("owns_escape", "owns", `${name}: \`owns\` entry \`${path}\` is absolute or escapes the repo root`);
      } else if (claimsRepoRoot(path)) {
        at("owns_root", "owns", `${name}: \`owns\` entry \`${JSON.stringify(path)}\` claims the whole repository — it normalises to no path at all, so this task would race every sibling. Name the files, or the directory prefix, it may edit`);
      }
    }
  }

  // --- status -------------------------------------------------------------
  if ("status" in front && front.status !== TASK_STATUS) {
    at("bad_shape", "status", `${name}: \`status\` is ${JSON.stringify(front.status)}; the only status the loader runs is \`${TASK_STATUS}\``);
  }

  // --- checks -------------------------------------------------------------
  let checks = null;
  if ("checks" in front) {
    if (Array.isArray(front.checks) && front.checks.every((check) => typeof check === "string")) {
      checks = front.checks;
    } else {
      at("bad_shape", "checks", `${name}: \`checks\` must be a list of shell commands, and is ${JSON.stringify(front.checks)}`);
    }
  }

  // --- gate ---------------------------------------------------------------
  let gate = null;
  if ("gate" in front) {
    if (GATES.includes(front.gate)) {
      gate = front.gate;
    } else {
      at("bad_shape", "gate", `${name}: \`gate\` is ${JSON.stringify(front.gate)}; it is \`before\` or \`after\``);
    }
  }

  // --- title, body --------------------------------------------------------
  const heading = HEADING.exec(split.rest);
  if (!heading) {
    at("no_title", null, `${name}: no \`# \` heading — the title is the first one, and the body is the file from it down`);
  }
  const body = heading ? split.rest.slice(heading.index) : "";
  // Tested against the whole file below the frontmatter, not against `body`: a
  // file with no `# ` heading has an empty body, and checking `body` would
  // report `no_criteria` on top of `no_title` for one missing `#`, sending the
  // author to add a section that is already there.
  if (!CRITERIA.test(split.rest)) {
    // Load-bearing, not pedantic: a task with no criteria section makes the
    // closeout verifier diff-only, and it then reviews the code against itself.
    at("no_criteria", null, `${name}: no \`## Acceptance criteria\` section — without one the closeout verifier reviews the diff against itself`);
  }

  return {
    id: id ?? stem,
    title: heading ? heading[1] : "",
    body,
    dependsOn,
    owns,
    checks,
    gate,
    file: name,
    // Which of the two directories the file was read from. STATUS, NOT
    // MEMBERSHIP: it never reaches the DAG, so a task's edges resolve across
    // the split and the graph is byte-identical whichever side each file sits
    // on. It exists for two things only — the `duplicate_id` message, which is
    // unreadable when both spellings are the same basename, and the human
    // rendering of `afk wave validate`.
    status: status === "done" ? "done" : "todo",
  };
};

/**
 * The pure core. Directory contents in; the §2 DAG out, or the refusals.
 *
 * @param {object} input
 * @param {string|null} input.goal `GOAL.md`'s text, or null when it is absent
 * @param {{name: string, text: string}[]} input.files `tasks-todo/*.md`
 * @param {string} [input.waveId] the wave's id and branch. The driver supplies
 *   `wave-NN`; `afk wave validate` has no wave number and validates the whole
 *   directory, so it leaves this at `wave`.
 * @param {string[]} [input.defaultChecks] the project's `defaultChecks`, or `[]`
 *   when there is no `.afk-setup/config.yaml` at all. Whether the list is empty
 *   because the config has no key, because it sets an empty one, or because
 *   there is no config, is not a distinction worth drawing — the lane is
 *   ungateable either way, the same rule `epicToDag` and `normalizeDag` apply.
 *   `afk validate` tolerates a missing config so it stays useful in an unwired
 *   repo; this deliberately does not, because §2's guarantee is that any graph
 *   this PRINTS is one `normalizeDag` accepts, and `normalizeDag` throws on a
 *   task with no checks.
 * @returns {{ok: true, dag: object}|{ok: false, refusals: object[]}}
 */
export const loadWaveDag = ({ goal, files, waveId = "wave", defaultChecks = [] }) => {
  const refusals = [];
  const fail = (refusal) => refusals.push(refusal);

  const goalHeading = goal === null || goal === undefined ? null : HEADING.exec(goal);
  if (goal === null || goal === undefined) {
    fail({
      code: "missing_goal",
      file: "GOAL.md",
      key: null,
      message: "GOAL.md is absent — it is the epic body the plan reviewer checks the wave against, and without it review compares the tasks to each other",
    });
  } else if (!goalHeading) {
    fail({
      code: "no_title",
      file: "GOAL.md",
      key: null,
      message: "GOAL.md: no `# ` heading — the wave's title is the first one",
    });
  }

  const parsed = [];
  for (const file of files ?? []) {
    const task = readTaskFile(file, fail);
    if (task) parsed.push(task);
  }

  // --- cross-file: ids ------------------------------------------------------
  const byId = new Map();
  for (const task of parsed) {
    const first = byId.get(task.id);
    if (first) {
      fail({
        code: "duplicate_id",
        file: task.file,
        key: "id",
        // The directory is named because the two files may be the same basename
        // on either side of the todo/done split, and "x.md and x.md both claim
        // id x" sends an operator hunting a second file that does not exist.
        message: `tasks-${task.status}/${task.file} and tasks-${first.status}/${first.file} both claim id \`${task.id}\``,
      });
      continue;
    }
    byId.set(task.id, task);
  }
  const tasks = [...byId.values()];

  // --- cross-file: edges ----------------------------------------------------
  for (const task of tasks) {
    for (const edge of task.dependsOn) {
      if (byId.has(edge)) continue;
      fail({
        code: "dangling_edge",
        file: task.file,
        key: "blocked_by",
        message: `${task.file}: \`blocked_by\` names \`${edge}\`, which is not a task in this directory`,
      });
    }
  }
  for (const cycle of findCycles(tasks)) {
    const file = byId.get(cycle[0])?.file ?? null;
    fail({
      code: "cycle",
      file,
      key: "blocked_by",
      // The file leads, like every other refusal: a cycle is the one problem
      // that belongs to several files at once, and an operator still has to
      // open one of them first.
      message: `${file}: dependency cycle: ${cycle.join(" → ")}`,
    });
  }

  // --- cross-file: owns -----------------------------------------------------
  // Two tasks may share a path when one transitively depends on the other: that
  // is a sequencing decision the author made, not a mistake.
  const reach = transitiveDeps(tasks);
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = tasks[i];
      const right = tasks[j];
      if (reach.get(left.id)?.has(right.id) || reach.get(right.id)?.has(left.id)) continue;
      for (const a of left.owns) {
        for (const b of right.owns) {
          if (!ownsOverlap(a, b)) continue;
          fail({
            code: "owns_collision",
            file: left.file,
            key: "owns",
            message: `${left.file} owns \`${a}\` and ${right.file} owns \`${b}\`, which overlap, and neither task depends on the other — they would run in the same wave and race for the same file`,
          });
        }
      }
    }
  }

  // --- gateability ----------------------------------------------------------
  const fallback = Array.isArray(defaultChecks) ? defaultChecks : [];
  for (const task of tasks) {
    const resolved = task.checks ?? fallback;
    if (resolved.length > 0) continue;
    fail({
      code: "ungateable",
      file: task.file,
      key: "checks",
      message: `${task.file}: no \`checks\` on the task and .afk-setup/config.yaml's \`defaultChecks\` supplies none — nothing would verify this lane`,
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };

  // Alongside the DAG, never inside its enumerable shape: the graph must not
  // change when a file moves, but the wave driver still needs the filesystem's
  // done bit when it cuts a resumed frontier. Non-enumerable keeps JSON output,
  // plan review and the existing graph-equality contract unchanged.
  const done = tasks.filter((task) => task.status === "done").map((task) => task.id);
  const dag = {
    // `body` is the half of §2's guarantee the title alone does not keep:
    // GOAL.md is what the plan reviewer checks a wave AGAINST, and
    // `auditFindings` drops any `unsatisfied_criterion` whose quote does not
    // appear verbatim in the epic body — so a DAG carrying only the title
    // makes every criterion finding undroppable-in-reverse: none can ever be
    // kept, and the one class of finding that predicts a green run producing
    // the wrong artifact is silently disabled. Sliced from the heading down,
    // verbatim, exactly like a task's own `body`.
    epic: { id: waveId, title: goalHeading[1], body: goal.slice(goalHeading.index) },
    branch: waveId,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      body: task.body,
      dependsOn: task.dependsOn,
      // Resolved here rather than left to `normalizeDag`, so `--dag=` and the
      // driver see the same commands this printed.
      checks: [...(task.checks ?? fallback)],
      allowedPaths: task.owns,
      ...(task.gate === "before" ? { humanGated: true } : {}),
      ...(task.gate === "after" ? { gateAfter: true } : {}),
    })),
  };
  Object.defineProperty(dag, "done", { value: done });
  return { ok: true, done, dag };
};

/** The `.md` files in one side of the split, or `[]` when that side does not exist. */
const readSide = (path, status) =>
  existsSync(path)
    ? readdirSync(path)
        .filter((name) => name.endsWith(".md"))
        .map((name) => ({ name, text: readFileSync(join(path, name), "utf8"), status }))
    : [];

/**
 * The filesystem edge. Reads, and does nothing else — no git, no writes.
 *
 * BOTH SIDES OF THE SPLIT. `tasks-done/` is where the driver files a task's
 * file once the wave that passed it merged (§1), and the two directories are
 * one graph: a `blocked_by` edge naming a task whose file has moved must keep
 * resolving, or the first merged wave would make the directory unloadable with
 * a `dangling_edge` for every dependent — and a run that had merged two waves
 * could then never be resumed, which is the failure the wave log exists to
 * prevent. The split is STATUS, not membership.
 *
 * Merged and sorted as ONE list rather than todo-then-done, so the DAG's task
 * order — which is what `waveFrontier`'s cap slices, and what makes a replayed
 * wave pick the same tasks as the one it replaces — does not shift as files
 * move between the directories.
 *
 * Either side may be absent. `tasks-done/` does not exist until the first wave
 * merges, and `tasks-todo/` stops existing once the last file leaves it, since
 * git does not track an empty directory. Only the absence of both is a
 * directory that is not a wave directory.
 *
 * @throws {Error} when the directory itself is not a wave directory
 */
export const readWaveDirectory = (dir, options = {}) => {
  const todo = join(dir, "tasks-todo");
  const done = join(dir, "tasks-done");
  if (!existsSync(todo) && !existsSync(done)) {
    throw new Error(`neither ${todo} nor ${done} exists — a wave directory holds GOAL.md and tasks-todo/*.md, with finished tasks filed under tasks-done/ (docs/wave-mode.md §1)`);
  }
  const goalPath = join(dir, "GOAL.md");
  return loadWaveDag({
    goal: existsSync(goalPath) ? readFileSync(goalPath, "utf8") : null,
    files: [...readSide(todo, "todo"), ...readSide(done, "done")].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    ...options,
  });
};

/** Refusals as an operator reads them: the code, then the sentence. */
export const renderRefusals = (refusals) =>
  [
    `WAVE: refused — ${refusals.length} problem${refusals.length === 1 ? "" : "s"}. The directory loads or it does not; nothing here is a warning.`,
    ...refusals.map((refusal) => `  ${refusal.code.padEnd(15)} ${refusal.message}`),
  ].join("\n");

/**
 * The accepted graph, for a human.
 *
 * `done` is the ids already filed under `tasks-done/`. Marked rather than
 * hidden: they are still in the graph and still satisfy their dependents' edges
 * — a `validate` that printed seven tasks with five of them long since merged,
 * and said nothing about it, would tell an operator the same untruth the file
 * tree told before it started moving anything.
 */
export const renderWaveDag = (dag, done = []) => {
  const filed = new Set(done);
  return [
    `WAVE: ${dag.tasks.length} task${dag.tasks.length === 1 ? "" : "s"} accepted — ${dag.epic.title}${filed.size ? ` (${filed.size} already in tasks-done/)` : ""}`,
    ...dag.tasks.map((task) => {
      const gate = task.humanGated ? " [gate: before]" : task.gateAfter ? " [gate: after]" : "";
      const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(", ")}` : "";
      const filedAway = filed.has(task.id) ? " [done]" : "";
      return `  ${task.id}${filedAway}${gate}${deps}\n      owns ${task.allowedPaths.join(", ")}\n      checks ${task.checks.join(" && ")}`;
    }),
  ].join("\n");
};
