// scripts/wave-loader.test.mjs — the refusal table IS the test table.
//
// `docs/wave-mode.md` §1 lists fourteen conditions that refuse a task
// directory, and `scripts/fixtures/wave/` holds one directory per condition:
// `accepted/`, plus a copy of it broken in exactly one way and named for the
// code that break must produce. A code with no fixture is a code nobody has
// ever seen fire.
//
// Nothing here reaches a model, git or the network — the loader is pure, which
// is the property that makes this table cheap enough to be complete.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { normalizeDag } from "./auto.mjs";
import { normalizeId } from "./lib.mjs";
import { auditFindings } from "./plan-review.mjs";
import { waveFrontier } from "./wave-driver.mjs";
import { loadWaveDag, ownsOverlap, readWaveDirectory } from "./wave-loader.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const afk = join(repoRoot, "afk.mjs");
const waveFixture = (name) =>
  fileURLToPath(new URL(`./fixtures/wave/${name}`, import.meta.url));

// The project the fixtures are written against: `task-02` and `task-03` carry
// no `checks:` of their own, so the directory only loads when a `defaultChecks`
// falls through to them.
const DEFAULT_CHECKS = ["swift test"];

const load = (name, options = {}) =>
  readWaveDirectory(waveFixture(name), { defaultChecks: DEFAULT_CHECKS, ...options });

const codesOf = (result) => [...new Set(result.refusals.map((refusal) => refusal.code))].sort();

// --------------------------------------------------------------------------
// The accepted directory
// --------------------------------------------------------------------------

test("the accepted fixture loads, and every task is shaped as §2 says", () => {
  const result = load("accepted", { waveId: "wave-03" });
  assert.equal(result.ok, true, JSON.stringify(result.refusals, null, 2));
  const { dag } = result;
  assert.deepEqual(dag.epic, {
    id: "wave-03",
    title: "Repo picker",
    body: "# Repo picker\n\nA scaffold nobody cares about.\n",
  });
  assert.equal(dag.branch, "wave-03");
  const byId = Object.fromEntries(dag.tasks.map((task) => [task.id, task]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "task-01-model",
    "task-02-picker",
    "task-03-docs",
  ]);
  // `checks` on the task wins; absent falls through to the project's.
  assert.deepEqual(byId["task-01-model"].checks, ["swift build"]);
  assert.deepEqual(byId["task-02-picker"].checks, DEFAULT_CHECKS);
  // `owns` becomes `allowedPaths`, verbatim.
  assert.deepEqual(byId["task-02-picker"].allowedPaths, [
    "Sources/Model/Repository.swift",
    "Sources/View/Picker.swift",
  ]);
  assert.deepEqual(byId["task-02-picker"].dependsOn, ["task-01-model"]);
  // `gate:` maps to the two flags the runner already reads, key-only-when-true.
  assert.equal(byId["task-02-picker"].gateAfter, true);
  assert.equal("humanGated" in byId["task-02-picker"], false);
  assert.equal(byId["task-03-docs"].humanGated, true);
  assert.equal("gateAfter" in byId["task-01-model"], false);
  // The title is the first `# ` heading; the body is the file from it down,
  // verbatim — the heading line included, the frontmatter not.
  assert.equal(byId["task-01-model"].title, "The repository model");
  assert.ok(byId["task-01-model"].body.startsWith("# The repository model\n"));
  assert.doesNotMatch(byId["task-01-model"].body, /ready-for-agent/);
});

// §2: "GOAL.md becomes the epic body handed to the plan reviewer — the thing a
// wave is checked against." A title alone does not keep that guarantee, and the
// consequence is not cosmetic: `auditFindings` DROPS every
// `unsatisfied_criterion` whose quoted criterion does not appear verbatim in
// the epic body, so an empty body means no criterion finding can ever survive
// the audit — the one class that predicts a green run producing the wrong
// artifact is silently disabled while the review still reports itself clean.
test("GOAL.md's body reaches the DAG, so the reviewer's criterion audit has something to check", () => {
  const { dag } = load("accepted", { waveId: "wave-03" });
  const goal = readFileSync(join(waveFixture("accepted"), "GOAL.md"), "utf8");
  assert.equal(typeof dag.epic.body, "string");
  assert.ok(dag.epic.body.length > 0, "the epic body is empty — GOAL.md was dropped");
  // From the first heading down, verbatim, exactly like a task's own `body`.
  assert.ok(dag.epic.body.startsWith("# Repo picker\n"));
  assert.equal(dag.epic.body, goal.slice(goal.indexOf("# Repo picker")));
  // The check the audit actually performs, run here against the real quote.
  const criterion = "A scaffold nobody cares about.";
  assert.ok(
    auditFindings({
      findings: [{ kind: "unsatisfied_criterion", tasks: [], criterion, message: "m" }],
      dag,
      epicBody: dag.epic.body,
    }).kept.length === 1,
    "a criterion quoted verbatim from GOAL.md must survive the audit",
  );
});

// The reason the loader is worth having at all: its output feeds
// `afk auto --dag=` with nothing in between.
test("the loader's output is something normalizeDag accepts unchanged", () => {
  const { dag } = load("accepted", { waveId: "wave-03" });
  assert.deepEqual(
    normalizeDag(dag, { defaultChecks: ["never used"] }),
    dag,
    "normalizeDag must be a no-op on a loaded wave DAG — if it is not, `--dag=` sees a graph this never printed",
  );
});

// Verified rather than assumed (`docs/wave-mode.md` §2 asserts it): slug ids
// need no runner change because `normalizeId` is `String(id)`.
test("slug ids survive normalizeId, so the runner needs no change for them", () => {
  for (const id of ["wave-03", "task-07-repo-picker"]) {
    assert.equal(normalizeId(id), id);
  }
  const { dag } = load("accepted", { waveId: "wave-03" });
  for (const task of dag.tasks) assert.equal(normalizeId(task.id), task.id);
});

// --------------------------------------------------------------------------
// The refusal table
// --------------------------------------------------------------------------

// One row per code in §1's table, plus the two codes this loader adds for
// conditions that table does not name (`bad_shape`, `missing_goal` — see the
// header of wave-loader.mjs). `expect` is the FULL set of codes the fixture
// must produce: a break that also trips a second guard is a fixture that is
// broken in two ways, and the point of the table is one break per row.
const TABLE = [
  ["unknown_key", ["unknown_key"]],
  ["missing_key", ["missing_key"]],
  ["id_mismatch", ["id_mismatch"]],
  // The one row that cannot be a single break. `id_mismatch` pins `id` to the
  // filename stem and a directory cannot hold two files with one stem, so on
  // the filesystem path a duplicate id ALWAYS arrives with a mismatch attached.
  // The guard is still load-bearing: `loadWaveDag` takes its files as an
  // argument, and a caller that is not a directory can hand it two of anything.
  ["duplicate_id", ["duplicate_id", "id_mismatch"]],
  ["dangling_edge", ["dangling_edge"]],
  ["cycle", ["cycle"]],
  ["owns_empty", ["owns_empty"]],
  ["owns_glob", ["owns_glob"]],
  ["owns_escape", ["owns_escape"]],
  ["owns_root", ["owns_root"]],
  ["owns_collision", ["owns_collision"]],
  ["ungateable", ["ungateable"]],
  ["no_title", ["no_title"]],
  ["no_criteria", ["no_criteria"]],
  ["bad_shape", ["bad_shape"]],
  ["missing_goal", ["missing_goal"]],
];

for (const [fixture, expect] of TABLE) {
  test(`${fixture}: the directory is refused, and the refusal names the file`, () => {
    const result = load(fixture);
    assert.equal(result.ok, false, `${fixture} loaded; it must not`);
    assert.deepEqual(codesOf(result), expect);
    for (const refusal of result.refusals) {
      // Every refusal names the offending file. Without it an operator reading
      // a 3am log has a code and no place to go.
      assert.ok(refusal.file, `${fixture}: a refusal with no file: ${refusal.message}`);
      assert.match(
        refusal.message,
        new RegExp(refusal.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${fixture}: the message must name the file`,
      );
    }
  });
}

// The half of `duplicate_id` the fixture cannot isolate, driven straight at the
// pure core: two files, one id, both stems matching. The guard fires alone.
test("duplicate_id fires on its own when the ids collide without a stem mismatch", () => {
  const body = "\n\n# T\n\n## Acceptance criteria\n\n- It works.\n";
  const file = (name, id, owns) => ({
    name,
    text: `---\nid: ${id}\nblocked_by: []\nowns:\n  - ${owns}\nstatus: ready-for-agent\n---${body}`,
  });
  const result = loadWaveDag({
    goal: "# Two\n",
    defaultChecks: DEFAULT_CHECKS,
    files: [file("task-01-a.md", "task-01-a", "a.md"), file("task-01-a.md", "task-01-a", "b.md")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codesOf(result), ["duplicate_id"]);
});

// `owns_root` has more spellings than one fixture can carry, and the fixture
// table is one break per directory. The rest are driven at the pure core.
//
// The hole this closes: `.` normalises to the empty key, which is the whole
// repository. No refusal caught it, so a task could claim the repo, race every
// sibling, and load without complaint.
const rootClaim = (owns) => {
  const body = "\n\n# T\n\n## Acceptance criteria\n\n- It works.\n";
  return loadWaveDag({
    goal: "# Root\n",
    defaultChecks: DEFAULT_CHECKS,
    files: [
      {
        name: "task-01-a.md",
        text: `---\nid: task-01-a\nblocked_by: []\nowns:\n  - ${JSON.stringify(owns)}\nstatus: ready-for-agent\n---${body}`,
      },
    ],
  });
};

test("owns_root refuses every spelling that normalises to the whole repository", () => {
  for (const owns of [".", "./", "", "a/..", "./.", "docs/.."]) {
    const result = rootClaim(owns);
    assert.equal(result.ok, false, `\`${owns}\` loaded; it claims the whole repo`);
    assert.deepEqual(codesOf(result), ["owns_root"], `for owns entry \`${owns}\``);
  }
});

// A repo-relative path that is not the root still loads: a guard that refuses
// `docs/picker.md` because it once had a `..` in it is worse than the hole.
test("owns_root leaves a path that normalises to a real subdirectory alone", () => {
  for (const owns of ["docs/picker.md", "./docs", "Sources/View/../Model", "a/../b"]) {
    assert.equal(rootClaim(owns).ok, true, `\`${owns}\` was refused; it names a real path`);
  }
});

// The two are different problems and must keep the code that names each
// accurately: escaping the root is not claiming it. A leading `/` is the input
// both descriptions fit — absolute, and normalising to nothing — and
// `owns_escape`, the older and more specific reading, keeps it, so no one break
// ever produces two codes.
test("owns_escape still owns the entries that leave the repo, and keeps a leading `/`", () => {
  for (const owns of [
    "/etc/passwd",
    "../elsewhere/docs/picker.md",
    "~/notes.md",
    "a/../../b",
    "/",
    "//",
  ]) {
    assert.deepEqual(codesOf(rootClaim(owns)), ["owns_escape"], `for owns entry \`${owns}\``);
  }
});

test("every refusal that is about a key names the key", () => {
  for (const fixture of [
    "unknown_key",
    "missing_key",
    "owns_glob",
    "owns_escape",
    "owns_root",
    "ungateable",
  ]) {
    for (const refusal of load(fixture).refusals) {
      assert.ok(refusal.key, `${fixture}: ${refusal.code} carries no key`);
      assert.match(refusal.message, new RegExp(`\`${refusal.key}\``));
    }
  }
});

// A malformed file refuses the WHOLE directory, not just itself. The break in
// `unknown_key/` is in one of three files; nothing loads.
test("one malformed file refuses the whole directory", () => {
  const result = load("unknown_key");
  assert.equal(result.ok, false);
  assert.equal("dag" in result, false, "a refused directory yields no partial graph");
  assert.equal(result.refusals.length, 1, "and the refusal is about the one broken file");
  assert.equal(result.refusals[0].file, "task-01-model.md");
});

// --------------------------------------------------------------------------
// The two rules that are easy to get subtly wrong
// --------------------------------------------------------------------------

test("collision is directory-prefix aware, per segment", () => {
  // §1's own examples.
  assert.equal(ownsOverlap("Sources/Feature/", "Sources/Feature/View.swift"), true);
  assert.equal(ownsOverlap("Sources/A/", "Sources/B/"), false);
  // The trailing slash is punctuation, not meaning.
  assert.equal(ownsOverlap("Sources/Feature", "Sources/Feature/"), true);
  // A shared string prefix that is not a shared directory is NOT a collision:
  // a raw startsWith would refuse a pair that never touches one file.
  assert.equal(ownsOverlap("Sources/Feature", "Sources/FeatureFlags"), false);
  assert.equal(ownsOverlap("docs/picker.md", "docs/picker.md.bak"), false);
  // Two spellings of one file are one claim. Without this, a pair that races
  // for the same bytes loads clean and surfaces as a 3am merge conflict.
  assert.equal(ownsOverlap("./docs/picker.md", "docs/picker.md"), true);
  assert.equal(ownsOverlap("Sources//Model/", "Sources/Model"), true);
  assert.equal(ownsOverlap("Sources/View/../Model/Repo.swift", "Sources/Model/"), true);
  // And a normalisation that is too eager is just as wrong.
  assert.equal(ownsOverlap("./docs/picker.md", "docs/other.md"), false);
});

test("two tasks may share an owned path when one transitively depends on the other", () => {
  // The accepted fixture already relies on it: task-02 owns
  // `Sources/Model/Repository.swift`, inside task-01's `Sources/Model/`, and
  // depends on task-01. Loading it proves the direct case.
  assert.equal(load("accepted").ok, true);

  // The transitive case, which a direct-edge check would refuse: c → b → a,
  // and a and c share a path with no edge between them.
  const goal = "# Chain\n";
  const file = (id, blocked, owns) => ({
    name: `${id}.md`,
    text: `---\nid: ${id}\nblocked_by: ${blocked}\nowns:\n  - ${owns}\nstatus: ready-for-agent\n---\n\n# ${id}\n\n## Acceptance criteria\n\n- It works.\n`,
  });
  const chain = loadWaveDag({
    goal,
    defaultChecks: DEFAULT_CHECKS,
    files: [
      file("task-01-a", "[]", "Sources/Shared.swift"),
      file("task-02-b", "[task-01-a]", "Sources/B.swift"),
      file("task-03-c", "[task-02-b]", "Sources/Shared.swift"),
    ],
  });
  assert.equal(chain.ok, true, JSON.stringify(chain.refusals, null, 2));

  // Break only the transitive edge and the same pair collides.
  const broken = loadWaveDag({
    goal,
    defaultChecks: DEFAULT_CHECKS,
    files: [
      file("task-01-a", "[]", "Sources/Shared.swift"),
      file("task-02-b", "[]", "Sources/B.swift"),
      file("task-03-c", "[task-02-b]", "Sources/Shared.swift"),
    ],
  });
  assert.equal(broken.ok, false);
  assert.deepEqual(codesOf(broken), ["owns_collision"]);
});

test("a project supplying no defaultChecks makes every task without its own ungateable", () => {
  // §2's guarantee is that any graph this PRINTS is one `normalizeDag` accepts,
  // and `normalizeDag` throws on a task with no checks. So an empty fallback
  // refuses here rather than emitting a graph the runner would reject later —
  // `afk validate`'s tolerance of a missing config is deliberately not copied.
  const refused = load("accepted", { defaultChecks: [] });
  assert.equal(refused.ok, false);
  assert.deepEqual(codesOf(refused), ["ungateable"]);
  assert.equal(refused.refusals.length, 2, "the two tasks with no `checks:` of their own");
  // The task that carries its own `checks:` is not implicated.
  assert.equal(
    refused.refusals.some((refusal) => refusal.file === "task-01-model.md"),
    false,
  );
  // And whatever this DOES print survives normalizeDag, for every fixture that
  // loads at all — the property, not one example of it.
  const { dag } = load("accepted", { waveId: "wave-03" });
  for (const task of normalizeDag(dag, {}).tasks) assert.ok(task.checks.length > 0);
});

// --------------------------------------------------------------------------
// Purity, and the CLI
// --------------------------------------------------------------------------

test("the core is pure: the same input twice gives a deep-equal graph, and no fixture is touched", () => {
  const before = spawnSync("git", ["status", "--porcelain", "scripts/fixtures/wave"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout;
  const first = load("accepted", { waveId: "wave-03" });
  const second = load("accepted", { waveId: "wave-03" });
  assert.deepEqual(first, second);
  const after = spawnSync("git", ["status", "--porcelain", "scripts/fixtures/wave"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout;
  assert.equal(after, before, "loading a wave directory must write nothing");
});

const runAfk = (...argv) =>
  spawnSync(process.execPath, [afk, ...argv], { cwd: repoRoot, encoding: "utf8" });

test("`afk wave validate --json` prints the DAG and exits 0", () => {
  const result = runAfk("wave", "validate", waveFixture("accepted"), "--json");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const dag = JSON.parse(result.stdout);
  assert.equal(dag.tasks.length, 3);
  assert.equal(dag.branch, "wave");
  // The runner's own .afk-setup/config.yaml supplies the fallback checks, so
  // the two tasks without their own still resolve to something.
  for (const task of dag.tasks) assert.ok(task.checks.length > 0, `${task.id} has no checks`);
});

test("`afk wave validate` refuses non-zero and names the code and the file", () => {
  const result = runAfk("wave", "validate", waveFixture("owns_collision"));
  assert.equal(result.status, 1, result.stdout);
  // Refusals go to stdout: a supervising agent reads stdout, and a decline it
  // cannot see is a command that failed for no stated reason.
  assert.equal(result.stderr, "", result.stderr);
  assert.match(result.stdout, /owns_collision/);
  assert.match(result.stdout, /task-03-docs\.md/);
});

// The refusal table is the contract `coduo-tasks` authors read, and a refusal
// only exists if the CLI they run actually prints it and exits non-zero.
test("`afk wave validate` refuses a task that claims the whole repository", () => {
  const result = runAfk("wave", "validate", waveFixture("owns_root"));
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stderr, "", result.stderr);
  assert.match(result.stdout, /owns_root/);
  assert.match(result.stdout, /task-03-docs\.md/);
});

// The note about a missing config is friendly on the human stream and a syntax
// error on the parsed one.
test("`--json` stays parseable in a repo with no .afk-setup/config.yaml", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "afk-wave-noconfig-"));
  try {
    const plain = spawnSync(process.execPath, [afk, "wave", "validate", waveFixture("accepted")], {
      cwd: elsewhere,
      encoding: "utf8",
    });
    assert.equal(plain.status, 1, plain.stdout);
    assert.match(plain.stdout, /no \.afk-setup\/config\.yaml/);
    assert.match(plain.stdout, /ungateable/);

    const json = spawnSync(
      process.execPath,
      [afk, "wave", "validate", waveFixture("accepted"), "--json"],
      { cwd: elsewhere, encoding: "utf8" },
    );
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual([...new Set(parsed.refusals.map((r) => r.code))], ["ungateable"]);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The driver has landed (docs/wave-mode.md §4), so `run` no longer refuses by
// name. What it must still never do is print usage and exit as if the verb were
// a typo: its refusals name what is missing. Its own behaviour is covered in
// scripts/wave-driver.test.mjs.
test("`afk wave run` refuses with a reason rather than printing usage", () => {
  const result = runAfk("wave", "run", "tasks/");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /--base=<branch>/);
  assert.doesNotMatch(result.stdout, /^Usage:$/m);
});

test("`afk wave validate` on a directory that is not one says so", () => {
  const result = runAfk("wave", "validate", join(repoRoot, "docs"));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /tasks-todo/);
});

// --------------------------------------------------------------------------
// The todo/done split (§1, "the split is status, not membership")
// --------------------------------------------------------------------------
//
// The interaction that makes this load-bearing rather than cosmetic: the driver
// files a passed task's file under `tasks-done/` when its wave merged, and a
// loader scoped to `tasks-todo/` alone would then read `blocked_by:
// [task-01-model]` on a task whose dependency is no longer in the directory it
// can see. That is `dangling_edge`, which refuses the WHOLE directory — so a
// run that had merged two waves could never be resumed, which is the exact
// failure the wave log exists to prevent.

/** A copy of the `accepted` fixture with `names` moved into `tasks-done/`. */
const splitFixture = (names) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-wave-split-"));
  cpSync(waveFixture("accepted"), dir, { recursive: true });
  mkdirSync(join(dir, "tasks-done"), { recursive: true });
  for (const name of names) {
    renameSync(join(dir, "tasks-todo", name), join(dir, "tasks-done", name));
  }
  return dir;
};

test("a directory split across tasks-todo/ and tasks-done/ loads, and loads to the same graph", () => {
  const whole = load("accepted", { waveId: "wave-03" });
  // task-01-model is task-02-picker's `blocked_by`. Filing it is exactly the
  // move that would strand the dependent behind a dangling edge.
  const dir = splitFixture(["task-01-model.md"]);
  try {
    const split = readWaveDirectory(dir, { defaultChecks: DEFAULT_CHECKS, waveId: "wave-03" });
    assert.equal(split.ok, true, JSON.stringify(split.refusals, null, 2));
    assert.deepEqual(
      split.dag,
      whole.dag,
      "the graph must be byte-identical whichever side of the split each file sits on",
    );
    assert.deepEqual(
      split.dag.tasks.find((task) => task.id === "task-02-picker").dependsOn,
      ["task-01-model"],
      "the edge must still resolve across the split",
    );
    assert.deepEqual(split.done, ["task-01-model"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task order survives the split, so a replayed wave picks the same tasks", () => {
  // `waveFrontier` slices the cap in DAG order and `docs/wave-mode.md` §4 leans
  // on that order being "stable across runs". Todo-then-done concatenation
  // would reorder the graph every time a file moved.
  const dir = splitFixture(["task-01-model.md", "task-03-docs.md"]);
  try {
    const split = readWaveDirectory(dir, { defaultChecks: DEFAULT_CHECKS });
    assert.deepEqual(
      split.dag.tasks.map((task) => task.id),
      load("accepted").dag.tasks.map((task) => task.id),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasks-done wins a resume cut over a stale blocked ledger record", () => {
  const dir = splitFixture(["task-01-model.md"]);
  try {
    const loaded = readWaveDirectory(dir, { defaultChecks: DEFAULT_CHECKS });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.refusals, null, 2));
    assert.deepEqual(
      waveFrontier({
        dag: loaded.dag,
        ledger: { "task-01-model": { outcome: "blocked", attempts: 1 } },
      }),
      ["task-02-picker", "task-03-docs"],
      "a filed task is done even when a prior wave ledger record says blocked",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory whose tasks have all been filed still loads with no tasks-todo/ at all", () => {
  // Git does not track an empty directory, so `tasks-todo/` stops existing once
  // the last file leaves it. A loader that required it would refuse the
  // directory of a run that finished.
  const dir = splitFixture(["task-01-model.md", "task-02-picker.md", "task-03-docs.md"]);
  rmSync(join(dir, "tasks-todo"), { recursive: true, force: true });
  try {
    const result = readWaveDirectory(dir, { defaultChecks: DEFAULT_CHECKS });
    assert.equal(result.ok, true, JSON.stringify(result.refusals, null, 2));
    assert.equal(result.dag.tasks.length, 3);
    assert.equal(result.done.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one file on both sides of the split is duplicate_id, and the message names both directories", () => {
  // The corruption the driver refuses to repair by deleting: `x.md and x.md
  // both claim id x` would send an operator hunting a file that does not exist.
  const dir = splitFixture([]);
  mkdirSync(join(dir, "tasks-done"), { recursive: true });
  cpSync(join(dir, "tasks-todo", "task-01-model.md"), join(dir, "tasks-done", "task-01-model.md"));
  try {
    const result = readWaveDirectory(dir, { defaultChecks: DEFAULT_CHECKS });
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result), ["duplicate_id"]);
    assert.match(result.refusals[0].message, /tasks-done\/task-01-model\.md/);
    assert.match(result.refusals[0].message, /tasks-todo\/task-01-model\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`afk wave validate` marks the filed tasks rather than reporting them as outstanding", () => {
  const dir = splitFixture(["task-01-model.md"]);
  try {
    const result = spawnSync(
      process.execPath,
      [afk, "wave", "validate", dir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 already in tasks-done\//);
    assert.match(result.stdout, /task-01-model \[done\]/);
    assert.doesNotMatch(result.stdout, /task-02-picker \[done\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
