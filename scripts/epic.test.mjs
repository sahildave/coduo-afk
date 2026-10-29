// scripts/epic.test.mjs — the parser → DAG bridge and the restart shape guard.
//
// Two seams, both pure, both TDD'd:
//   1. epicToDag(spec, issues, config) — the only place the `afk:` block becomes
//      something runAuto understands. Wave 1 shipped a parser with zero
//      importers; this is what proves the two halves compose.
//   2. graphShapeHash(dag) + describeShapeChange(before, after) — failure mode 4
//      in docs/epic-schema.md. A child issue closed mid-run must stop the runner.
//
// No network. The `owner/atlas-workspace#255` fixture below carries the real
// issue numbers (#256–#261) and a hand-written `afk:` block; the epic itself has
// no block and is never edited.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./test-helpers.mjs";
import { parseEpicBlock } from "./epic-spec.mjs";
import { LEDGER_RELATIVE, addEntry } from "./ledger.mjs";
import {
  EpicBridgeError,
  epicToDag,
  graphShapeHash,
  describeShapeChange,
  effectiveMaxParallel,
  rootWidth,
  criteriaSection,
  protectedPathsNamed,
  checkPaths,
  epicModifiedPaths,
  unrelatedChecks,
  validateEpic,
  epicScopeClashes,
} from "./epic.mjs";
import { freePort } from "./free-port.mjs";

// One port for this file's spawned children, taken from the OS at load.
// The call sites are synchronous `spawnSync` helpers, so the await is hoisted.
const SPAWNED_CHILD_PORT = String(await freePort());

const config = { defaultChecks: ["npm test"], maxParallel: 5 };

const blockOf = (yaml) => parseEpicBlock(["```yaml", yaml, "```"].join("\n"));

// node:test's assert.throws returns undefined, and every assertion below is
// about *which* task id the refusal names.
const thrownBy = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail("expected a refusal, got none");
};

const SPEC = blockOf(`afk:
  version: 1
  branch: feat/203-stripe
  max_parallel: 3
  tasks:
    204:
      depends_on: []
      gate: before
    205:
      depends_on: [204]
    208:
      depends_on: [205]
      checks: [npm run lint:check]`);

const ISSUES = [
  { number: 204, title: "Provision Stripe", state: "OPEN", body: "# 204 body" },
  { number: 205, title: "Checkout session", state: "OPEN", body: "# 205 body" },
  { number: 208, title: "Webhooks", state: "OPEN", body: "# 208 body" },
];

const EPIC = { number: 203, title: "Stripe subscriptions" };

// ---------------------------------------------------------------------------
// Seam 1 — epicToDag
// ---------------------------------------------------------------------------

test("epicToDag turns the tasks mapping into the array runAuto takes", () => {
  const dag = epicToDag(SPEC, ISSUES, config, EPIC);
  assert.deepEqual(
    dag.tasks.map((task) => task.id),
    ["204", "205", "208"],
    "keys become string ids, ordered by issue number",
  );
  assert.equal(dag.branch, "feat/203-stripe");
  assert.deepEqual(dag.epic, { id: "203", title: "Stripe subscriptions" });
});

test("epicToDag maps depends_on to dependsOn, as strings", () => {
  const dag = epicToDag(SPEC, ISSUES, config, EPIC);
  const byId = Object.fromEntries(dag.tasks.map((task) => [task.id, task]));
  assert.deepEqual(byId["204"].dependsOn, []);
  assert.deepEqual(byId["205"].dependsOn, ["204"]);
  assert.deepEqual(byId["208"].dependsOn, ["205"]);
});

test("epicToDag maps gate: before onto humanGated and leaves the rest ungated", () => {
  const byId = Object.fromEntries(
    epicToDag(SPEC, ISSUES, config, EPIC).tasks.map((task) => [task.id, task]),
  );
  assert.equal(byId["204"].humanGated, true);
  assert.equal(
    Object.hasOwn(byId["205"], "humanGated"),
    false,
    "an ungated task carries no humanGated key at all",
  );
});

test("epicToDag takes title and body from the child issues, never from the block", () => {
  const byId = Object.fromEntries(
    epicToDag(SPEC, ISSUES, config, EPIC).tasks.map((task) => [task.id, task]),
  );
  assert.equal(byId["205"].title, "Checkout session");
  assert.equal(byId["205"].body, "# 205 body");
});

test("epicToDag resolves checks from the block when present and defaultChecks otherwise", () => {
  const byId = Object.fromEntries(
    epicToDag(SPEC, ISSUES, config, EPIC).tasks.map((task) => [task.id, task]),
  );
  assert.deepEqual(byId["205"].checks, ["npm test"], "absent means defaultChecks");
  assert.deepEqual(
    byId["208"].checks,
    ["npm run lint:check"],
    "the block narrows the gate when it says so",
  );
});

test("epicToDag defaults allowedPaths to repo-wide advisory scope", () => {
  for (const task of epicToDag(SPEC, ISSUES, config, EPIC).tasks) {
    assert.deepEqual(task.allowedPaths, ["**"]);
  }
});

test("epicToDag carries gate: after through as gateAfter, and never as humanGated", () => {
  // The two gates are opposites in when they stop the run: `before` holds the
  // task back until a human releases it, `after` runs the task unattended and
  // holds the EPIC back until a human accepts it. Conflating them would run a
  // gate: after task's work behind a gate that nothing releases.
  const spec = blockOf(`afk:
  version: 1
  branch: feat/203-stripe
  tasks:
    204:
      depends_on: []
    211:
      depends_on: [204]
      gate: after`);
  const issues = [
    { number: 204, title: "Root", state: "OPEN", body: "b" },
    { number: 211, title: "Accept", state: "OPEN", body: "b" },
  ];
  const dag = epicToDag(spec, issues, config, EPIC);
  const gated = dag.tasks.find((task) => task.id === "211");
  assert.equal(gated.gateAfter, true);
  assert.equal(gated.humanGated, undefined);
  assert.equal(dag.tasks.find((task) => task.id === "204").gateAfter, undefined);
});

test("graphShapeHash is unchanged by the gateAfter field until a task actually has one", () => {
  // The field is written key-only-when-true so that adding it refuses no run
  // that was already in flight. Removing a gate mid-run must still be refused.
  const plain = { tasks: [{ id: "204", dependsOn: [] }] };
  assert.equal(
    graphShapeHash(plain),
    graphShapeHash({ tasks: [{ id: "204", dependsOn: [], gateAfter: false }] }),
    "a false gateAfter is not a shape change",
  );
  assert.notEqual(
    graphShapeHash(plain),
    graphShapeHash({ tasks: [{ id: "204", dependsOn: [], gateAfter: true }] }),
    "losing a gate: after mid-run must be refused like any other shape change",
  );
});

test("epicToDag refuses a task with no child issue, naming the id", () => {
  const error = thrownBy(() => epicToDag(SPEC, ISSUES.slice(0, 2), config, EPIC));
  assert.ok(error instanceof EpicBridgeError);
  assert.match(error.message, /208/);
  assert.equal(error.errors[0].code, "no_child_issue");
});

test("epicToDag refuses a task nothing can gate, naming the id", () => {
  // A task whose resolved checks list is empty merges having run nothing. A
  // missing `defaultChecks` key and an explicit empty one leave the lane
  // equally ungated, so both refuse — matching normalizeDag in auto.mjs.
  const error = thrownBy(() => epicToDag(SPEC, ISSUES, { maxParallel: 2 }, EPIC));
  assert.ok(error instanceof EpicBridgeError);
  assert.match(error.message, /204|205/);
  assert.equal(error.errors[0].code, "ungateable");
  assert.equal(
    thrownBy(() => epicToDag(SPEC, ISSUES, { defaultChecks: [] }, EPIC)).errors[0].code,
    "ungateable",
    "an explicit empty defaultChecks leaves the lane just as ungated",
  );
});

test("epicToDag reports every bridge problem at once, not just the first", () => {
  const spec = blockOf(`afk:
  version: 1
  branch: feat/x
  tasks:
    204:
      depends_on: []
      gate: after
    205:
      depends_on: [204]
      gate: after`);
  const error = thrownBy(() =>
    epicToDag(spec, [{ number: 204, title: "t", state: "OPEN", body: "" }], { maxParallel: 2 }, EPIC),
  );
  assert.ok(error instanceof EpicBridgeError);
  assert.deepEqual(
    error.errors.map((entry) => `${entry.code}:${entry.taskId}`).sort(),
    ["no_child_issue:205", "ungateable:204", "ungateable:205"],
  );
});

test("the epic's max_parallel caps the project config's maxParallel, and never raises it", () => {
  // docs/epic-schema.md:53. Applied nowhere before this.
  assert.equal(effectiveMaxParallel({ maxParallel: 5 }, { max_parallel: 3 }), 3);
  assert.equal(effectiveMaxParallel({ maxParallel: 2 }, { max_parallel: 8 }), 2);
  assert.equal(effectiveMaxParallel({ maxParallel: 5 }, {}), 5);
});

test("a config default below the DAG's root width is raised to it, under the core cap", () => {
  // Four independent roots against maxParallel 2 left a lane idling 34 minutes
  // waiting for a slot it never needed. The config value is a project-wide
  // default, not a per-epic decision; the epic's own max_parallel still is.
  const cores = cpus().length;
  const roots = (n) => ({ tasks: Array.from({ length: n }, (_, i) => ({ id: `${101 + i}`, dependsOn: [] })) });
  assert.equal(rootWidth(roots(4)), 4);
  assert.equal(rootWidth({ tasks: [{ id: "1", dependsOn: [] }, { id: "2", dependsOn: ["1"] }] }), 1);
  assert.equal(rootWidth(null), 0);

  assert.equal(effectiveMaxParallel({ maxParallel: 2 }, { max_parallel: null }, roots(4)), 4);
  // Never lowers: a config above the root width is left alone.
  assert.equal(effectiveMaxParallel({ maxParallel: 5 }, {}, roots(2)), 5);
  // Never above this machine's cores.
  assert.equal(effectiveMaxParallel({ maxParallel: 1 }, {}, roots(cores + 8)), cores);
  // An explicit epic max_parallel is a deliberate lever and still wins.
  assert.equal(effectiveMaxParallel({ maxParallel: 5 }, { max_parallel: 2 }, roots(4)), 2);
  // No DAG — unchanged from the two-argument behaviour.
  assert.equal(effectiveMaxParallel({ maxParallel: 2 }, {}), 2);
});

// ---------------------------------------------------------------------------
// Seam 2 — graphShapeHash and the refuse-on-change comparison
// ---------------------------------------------------------------------------

const shapeDag = (tasks) => ({ tasks });

test("graphShapeHash ignores task order and dependency order", () => {
  const a = shapeDag([
    { id: "204", dependsOn: [] },
    { id: "208", dependsOn: ["204", "205"] },
    { id: "205", dependsOn: ["204"] },
  ]);
  const b = shapeDag([
    { id: "208", dependsOn: ["205", "204"] },
    { id: "205", dependsOn: ["204"] },
    { id: "204", dependsOn: [] },
  ]);
  assert.equal(graphShapeHash(a), graphShapeHash(b));
});

test("graphShapeHash ignores titles, bodies, checks and allowedPaths", () => {
  // A retitled issue must not halt a six-hour run.
  const before = shapeDag([
    { id: "204", title: "Old title", body: "old", dependsOn: [], checks: ["a"], allowedPaths: ["src/**"] },
  ]);
  const after = shapeDag([
    { id: "204", title: "New title", body: "rewritten", dependsOn: [], checks: ["b", "c"], allowedPaths: ["**"] },
  ]);
  assert.equal(graphShapeHash(before), graphShapeHash(after));
});

test("graphShapeHash changes when a task, an edge or a gate changes", () => {
  const base = shapeDag([
    { id: "204", dependsOn: [] },
    { id: "205", dependsOn: ["204"] },
  ]);
  const hash = graphShapeHash(base);
  assert.notEqual(hash, graphShapeHash(shapeDag([{ id: "204", dependsOn: [] }])), "removal");
  assert.notEqual(
    hash,
    graphShapeHash(
      shapeDag([
        { id: "204", dependsOn: [] },
        { id: "205", dependsOn: ["204"] },
        { id: "206", dependsOn: ["204"] },
      ]),
    ),
    "addition",
  );
  assert.notEqual(
    hash,
    graphShapeHash(shapeDag([{ id: "204", dependsOn: [] }, { id: "205", dependsOn: [] }])),
    "edge removed",
  );
  assert.notEqual(
    hash,
    graphShapeHash(
      shapeDag([
        { id: "204", dependsOn: [], humanGated: true },
        { id: "205", dependsOn: ["204"] },
      ]),
    ),
    "gate flipped",
  );
});

test("graphShapeHash reads a state.dag shape and a live DAG identically", () => {
  // .afk/state.json stores dagShape(dag), which carries `title` too. The restart
  // comparison hashes one against the other, so they must agree.
  const live = shapeDag([
    { id: "204", title: "t", body: "long body", dependsOn: [], checks: ["npm test"], allowedPaths: ["**"] },
  ]);
  const persisted = shapeDag([{ id: "204", title: "t", dependsOn: [] }]);
  assert.equal(graphShapeHash(live), graphShapeHash(persisted));
});

test("describeShapeChange says what changed, not that something changed", () => {
  const before = shapeDag([
    { id: "204", dependsOn: [] },
    { id: "205", dependsOn: ["204"] },
    { id: "207", dependsOn: ["204"] },
  ]);
  const after = shapeDag([
    { id: "204", dependsOn: [], humanGated: true },
    { id: "205", dependsOn: [] },
    { id: "209", dependsOn: ["205"] },
  ]);
  const changes = describeShapeChange(before, after);
  assert.ok(
    changes.some((line) => /task 207 is no longer in the epic/.test(line)),
    `expected a removal line, got:\n${changes.join("\n")}`,
  );
  assert.ok(changes.some((line) => /task 209 was added/.test(line)));
  assert.ok(changes.some((line) => /task 205 now depends on nothing \(was 204\)/.test(line)));
  assert.ok(changes.some((line) => /task 204 is now human-gated/.test(line)));
});

test("describeShapeChange is empty for an unchanged shape", () => {
  const dag = shapeDag([{ id: "204", dependsOn: [] }, { id: "205", dependsOn: ["204"] }]);
  assert.deepEqual(describeShapeChange(dag, dag), []);
});

// ---------------------------------------------------------------------------
// The full validate path, against the real owner/atlas-workspace#255 shape
// ---------------------------------------------------------------------------

// Real epic, real open sub-issues. #255 carries no `afk:` block and is not
// edited by this build; the block below is hand-written here so the full path
// can be exercised against real issue numbers offline.
const withCriteria = (body) => `${body}\n\n## Acceptance criteria\n\n- The binding fires\n`;

const ATLAS_EPIC = {
  number: 255,
  title: "Spec: a fixed, scoped Keymap — keyboard-first Atlas",
  body: [
    "## Solution",
    "",
    "```yaml",
    "afk:",
    "  version: 1",
    "  branch: feat/255-keymap",
    "  max_parallel: 3",
    "  tasks:",
    "    261:",
    "      depends_on: []",
    "      gate: before",
    "    256:",
    "      depends_on: [261]",
    "    257:",
    "      depends_on: [261]",
    "    258:",
    "      depends_on: [261]",
    "    259:",
    "      depends_on: [261, 258]",
    "    260:",
    "      depends_on: [261, 257]",
    "```",
  ].join("\n"),
  // Every child states criteria, because a child that states none is now a
  // validation error in its own right — see `no_acceptance_criteria`.
  children: [
    { number: 261, title: "Keymap: one fixed, scoped table", state: "OPEN", body: withCriteria("261") },
    { number: 256, title: "Shortcut Sheet", state: "OPEN", body: withCriteria("256") },
    { number: 257, title: "Bindings for navigation", state: "OPEN", body: withCriteria("257") },
    { number: 258, title: "Bindings on the open issue", state: "OPEN", body: withCriteria("258") },
    { number: 259, title: "Bindings for the composer", state: "OPEN", body: withCriteria("259") },
    { number: 260, title: "Tooltips", state: "OPEN", body: withCriteria("260") },
  ],
};

const noBranch = () => ({ exists: false });

test("validateEpic raises a config default below the root width, and says so", () => {
  // The raise has to reach report.effectiveMaxParallel, because that is the only
  // value handed to runAuto (`config: { ...config, maxParallel: ... }`), and
  // maxParallel is read once at process start — it cannot be corrected mid-run.
  const flat = {
    ...ATLAS_EPIC,
    body: ATLAS_EPIC.body
      .replace("  max_parallel: 3\n", "")
      .replace(/depends_on: \[[^\]]*\]/g, "depends_on: []"),
  };
  const report = validateEpic({
    epic: flat,
    config: { defaultChecks: ["true"], maxParallel: 2 },
    branchStatus: noBranch,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  const expected = Math.min(6, cpus().length);
  assert.equal(report.effectiveMaxParallel, Math.max(2, expected));
  const raised = report.warnings.find((warning) => warning.code === "parallelism_raised");
  assert.ok(raised, "a silently raised lever is a surprise; it must be logged");
  assert.match(raised.message, /raised from 2/);
});

test("validateEpic accepts a well-formed epic and reports depth and blast radius", () => {
  const report = validateEpic({ epic: ATLAS_EPIC, config, branchStatus: noBranch });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.equal(report.branch, "feat/255-keymap");
  assert.equal(report.effectiveMaxParallel, 3);
  assert.match(report.graph, /^256: depth 1, blast radius 0 of 6$/m);
  assert.match(report.graph, /^261: depth 0, blast radius 5 of 6$/m);
  assert.equal(report.dag.tasks.length, 6);
  assert.equal(report.dag.tasks.find((task) => task.id === "261").humanGated, true);
  assert.ok(report.graphShapeHash);
});

test("validateEpic refuses a task key that is not an open sub-issue of this epic", () => {
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.map((child) =>
      child.number === 258 ? { ...child, state: "CLOSED" } : child,
    ),
  };
  const report = validateEpic({ epic, config, branchStatus: noBranch });
  assert.equal(report.ok, false);
  const closed = report.errors.find((error) => error.code === "child_closed");
  assert.equal(closed.taskId, "258");
  assert.match(closed.message, /258/);
});

test("validateEpic refuses a task key that belongs to no sub-issue at all", () => {
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.filter((child) => child.number !== 257),
  };
  const report = validateEpic({ epic, config, branchStatus: noBranch });
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.code === "no_child_issue" && error.taskId === "257"),
  );
});

// --- a ticket the runner would revert its way out of ------------------------
// Epic #3's #18 required a new `scripts/test-judgement.ts` "added to the `test`
// script in package.json". The builder did exactly that, the runner reverted the
// wiring as a manifest edit, the OLD chain ran green and the task was marked
// `passed` over a file that had never executed. `revertedProtected` recorded it
// and nothing read it. The narrowed revert fixes the package.json case; every
// other protected path is still an acceptance criterion no lane can satisfy, and
// validate is where that costs nothing to find.

test("a criterion naming a path builders may edit is not unsatisfiable", () => {
  // `package.json`'s `scripts` block is the motivating case and is now ALLOWED,
  // so the ticket that started all this validates clean.
  assert.deepEqual(
    protectedPathsNamed("Add scripts/test-judgement.ts and append it to the `test` script in `package.json`."),
    [],
  );
  // Until a project narrows the allowance away, at which point it is back.
  assert.deepEqual(
    protectedPathsNamed("append it to the `test` script in `package.json`", {}),
    ["package.json"],
  );
});

test("a criterion naming a path the runner reverts whole is unsatisfiable", () => {
  assert.deepEqual(
    protectedPathsNamed("Pin the dep in `bun.lockb` and note the rule in AGENTS.md."),
    ["AGENTS.md", "bun.lockb"],
  );
  // Prefixes count: `.afk-setup/` and `.claude/` are whole directories.
  assert.deepEqual(
    protectedPathsNamed("Set `protectedEdits` in .afk-setup/config.yaml"),
    [".afk-setup/config.yaml"],
  );
  // Ordinary work names ordinary files and is left alone.
  assert.deepEqual(protectedPathsNamed("Update app/session/results.tsx and its test."), []);
  assert.deepEqual(protectedPathsNamed(""), []);
});

test("the acceptance criteria are found under the headings tickets actually use", () => {
  assert.match(criteriaSection("## Acceptance criteria\n\n- one\n\n## Notes\n\n- two\n"), /- one/);
  assert.doesNotMatch(criteriaSection("## Acceptance criteria\n\n- one\n\n## Notes\n\n- two\n"), /- two/);
  assert.match(criteriaSection("**Done when** the suite runs it.\n"), /suite runs it/);
  // No section is not an empty section: the caller has to tell "named in the
  // criteria" from "we cannot see any criteria", because only the first blocks.
  assert.equal(criteriaSection("Just a paragraph about AGENTS.md.\n"), null);
});

test("a present-but-empty criteria heading is no criteria, not an empty string", () => {
  // Regression: the #29 guard fires on `criteria === null`, but a heading with
  // nothing under it returned "" (truthy), so a blank `## Acceptance criteria`
  // sailed straight through the guard meant to catch an unauditable ticket.
  assert.equal(criteriaSection("## Acceptance criteria\n\n"), null);
  assert.equal(criteriaSection("**Done when**\n\n## Notes\n\n- real\n"), null);
});

test("validateEpic refuses a task whose acceptance criteria require a protected path", () => {
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.map((child) =>
      child.number === 257
        ? { ...child, body: "## Acceptance criteria\n\n- The rule is documented in AGENTS.md\n" }
        : child,
    ),
  };
  const report = validateEpic({ epic, config, branchStatus: noBranch });
  assert.equal(report.ok, false);
  const refusal = report.errors.find((error) => error.code === "unsatisfiable_criterion");
  assert.equal(refusal.taskId, "257");
  assert.match(refusal.message, /AGENTS\.md/);
  // Both remedies, because either can be the right one: rewrite the ticket, or
  // let builders make that edit.
  assert.match(refusal.message, /protectedEdits/);
});

test("a protected path named outside the criteria warns instead of refusing the epic", () => {
  // "follow the conventions in AGENTS.md" is an ordinary thing for a ticket to
  // say, and hard-failing the whole epic over a pointer would make `afk validate`
  // something people work around. It still gets said out loud — the mention is
  // reported, the run is not stopped.
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.map((child) =>
      child.number === 257
        ? { ...child, body: "Follow the conventions in AGENTS.md.\n\n## Acceptance criteria\n\n- The sheet opens\n" }
        : child,
    ),
  };
  const report = validateEpic({ epic, config, branchStatus: noBranch });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  const warning = report.warnings.find((entry) => entry.code === "protected_path_named");
  assert.equal(warning.taskId, "257");
  assert.match(warning.message, /AGENTS\.md/);
});

// --- a ticket with nothing to check against --------------------------------
// #169 shipped a comment-only diff and passed every gate honestly, because its
// child stated no criteria: with none, the closeout verifier says so itself and
// reviews the diff against itself. Validation is the last moment that costs a
// ticket edit rather than a billed run.

test("a child with no acceptance criteria is a validation error", () => {
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.map((child) =>
      child.number === 257 ? { ...child, body: "Bind j and k in the issue list.\n" } : child,
    ),
  };
  const report = validateEpic({ epic, config, branchStatus: noBranch });
  assert.equal(report.ok, false);
  const refusal = report.errors.find((error) => error.code === "no_acceptance_criteria");
  assert.ok(refusal, JSON.stringify(report.errors, null, 2));
  assert.equal(refusal.taskId, "257");
  assert.match(refusal.message, /257/);
  // Both headings, so the fix is the message rather than a trip to the parser.
  assert.match(refusal.message, /Acceptance criteria/i);
  assert.match(refusal.message, /Done when/i);
});

test("a child stating criteria under either heading is accepted", () => {
  const bodies = {
    256: "Open the sheet.\n\n**Done when** the sheet opens on `?` and closes on Escape.\n",
    257: "Bind j and k.\n\n## Acceptance criteria\n\n- `j` and `k` move the selection\n",
  };
  const epic = {
    ...ATLAS_EPIC,
    children: ATLAS_EPIC.children.map((child) =>
      bodies[child.number] ? { ...child, body: bodies[child.number] } : child,
    ),
  };
  // A third child states nothing, so the assertion below is about a rule that
  // discriminates rather than a rule that never fires.
  const withBare = {
    ...epic,
    children: epic.children.map((child) =>
      child.number === 258 ? { ...child, body: "Bind the open issue.\n" } : child,
    ),
  };
  const report = validateEpic({ epic: withBare, config, branchStatus: noBranch });
  const missing = report.errors.filter((error) => error.code === "no_acceptance_criteria");
  assert.deepEqual(missing.map((error) => error.taskId), ["258"], JSON.stringify(report.errors, null, 2));
});

// --- the `or` that let #169 pass -------------------------------------------
// #169's criterion said duplication must be "accepted with a stated reason or
// avoided by design". The lane took the second branch, shipped a comment-only
// diff, and passed every gate honestly. A top-level `or` in a criteria bullet is
// an escape hatch; it is put in front of a human, never used to refuse an epic.

const ESCAPE_HATCH =
  "## Acceptance criteria\n\n- Duplication is accepted with a stated reason or avoided by design\n";

const withChildBody = (number, body) => ({
  ...ATLAS_EPIC,
  children: ATLAS_EPIC.children.map((child) => (child.number === number ? { ...child, body } : child)),
});

test("a top-level or in a criteria bullet is a warning", () => {
  const report = validateEpic({ epic: withChildBody(257, ESCAPE_HATCH), config, branchStatus: noBranch });
  const warning = report.warnings.find((entry) => entry.code === "criterion_escape_hatch");
  assert.ok(warning, JSON.stringify(report.warnings, null, 2));
  assert.equal(warning.taskId, "257");
});

test("an escape-hatch warning never blocks an epic", () => {
  const flagged = validateEpic({ epic: withChildBody(257, ESCAPE_HATCH), config, branchStatus: noBranch });
  const plain = validateEpic({ epic: ATLAS_EPIC, config, branchStatus: noBranch });
  assert.deepEqual(
    flagged.errors.filter((error) => error.code === "criterion_escape_hatch"),
    [],
  );
  assert.equal(flagged.ok, plain.ok, JSON.stringify(flagged.errors, null, 2));
  assert.equal(flagged.ok, true);
  // The bullet did fire the warning, so the two assertions above are about a
  // rule that ran and stayed out of the way rather than one that never ran.
  assert.ok(flagged.warnings.some((entry) => entry.code === "criterion_escape_hatch"));
});

test("the escape-hatch message names #169", () => {
  const report = validateEpic({ epic: withChildBody(257, ESCAPE_HATCH), config, branchStatus: noBranch });
  const warning = report.warnings.find((entry) => entry.code === "criterion_escape_hatch");
  assert.ok(warning, JSON.stringify(report.warnings, null, 2));
  assert.match(warning.message, /#169/);
});

test("an or inside inline code does not warn", () => {
  const body = "## Acceptance criteria\n\n- The parser accepts `a or b` as one token\n";
  const report = validateEpic({ epic: withChildBody(257, body), config, branchStatus: noBranch });
  assert.deepEqual(
    report.warnings.filter((entry) => entry.code === "criterion_escape_hatch"),
    [],
  );
  // Control: the same bullet with the `or` outside the backticks does warn, so
  // this is a rule that discriminates rather than one that never fires.
  const bare = validateEpic({
    epic: withChildBody(257, "## Acceptance criteria\n\n- The parser accepts a or b as one token\n"),
    config,
    branchStatus: noBranch,
  });
  assert.ok(
    bare.warnings.some((entry) => entry.code === "criterion_escape_hatch"),
    JSON.stringify(bare.warnings, null, 2),
  );
});

test("validateEpic refuses a branch that already exists with divergent history", () => {
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config,
    branchStatus: () => ({ exists: true, divergent: true, sha: "abc1234" }),
  });
  assert.equal(report.ok, false);
  const error = report.errors.find((entry) => entry.code === "branch_divergent");
  assert.match(error.message, /feat\/255-keymap/);
});

test("validateEpic accepts a branch that already exists as a fast-forward of the base", () => {
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config,
    branchStatus: () => ({ exists: true, divergent: false, sha: "abc1234" }),
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(report.warnings.some((warning) => /already exists/.test(warning.message)));
});

test("validateEpic reports a missing afk: block as an error rather than throwing", () => {
  const report = validateEpic({
    epic: { number: 255, title: "t", body: "no block here", children: [] },
    config,
    branchStatus: noBranch,
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, "parse");
  assert.match(report.errors[0].message, /no `afk:` block/);
});

test("validateEpic without a project config still does graph math, and warns", () => {
  const report = validateEpic({ epic: ATLAS_EPIC, config: null, branchStatus: noBranch });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(report.warnings.some((warning) => warning.code === "no_config"));
  assert.match(report.graph, /261: depth 0/);
  assert.equal(report.effectiveMaxParallel, null);
});

test("a config with no `roles:` block warns, and does NOT refuse", () => {
  // The run-time half of a check whose setup-time half is prose. The step that
  // writes `roles:` fires on the repo already having `.afk-setup/` or `.afk/` —
  // which a repo being set up for the first time does not, by definition — so
  // the skip is silent and nothing downstream complains: a lane with no skill
  // grounding runs fine and merely invents names that fail as "no such skill".
  //
  // A WARNING. Four repos in this estate run today in exactly this state
  // (NoteBoard1, quillnote, riverbend, trip-journal-demo), so refusing would
  // break four working repos to enforce a preference.
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config: { ...config, roles: undefined },
    branchStatus: noBranch,
  });
  assert.equal(report.ok, true, "a missing roles: block must never refuse a run");
  const warning = report.warnings.find((w) => w.code === "no_roles");
  assert.ok(warning, "the skip has to be said, or nothing ever says it");
  assert.match(warning.message, /afk stack detect/, "it must name the fix");
  assert.ok(!report.warnings.some((w) => w.code === "no_config"),
    "the config exists; this is a different gap");
});

test("an empty `roles:` block warns too — a key with nothing under it grounds nothing", () => {
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config: { ...config, roles: {} },
    branchStatus: noBranch,
  });
  assert.ok(report.warnings.some((w) => w.code === "no_roles"));
});

test("a config WITH roles does not warn about them", () => {
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config: { ...config, roles: { implementer: { always: ["coduo-implement"] } } },
    branchStatus: noBranch,
  });
  assert.ok(!report.warnings.some((w) => w.code === "no_roles"));
});

// ---------------------------------------------------------------------------
// Runtime seams: the --dry-run fix, refuse-on-change, and custom instructions
// ---------------------------------------------------------------------------

const fixtureRepo = (config) => {
  const repo = mkdtempSync(join(tmpdir(), "afk-epic-"));
  const inRepo = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(inRepo("init", "-b", "main").status, 0);
  inRepo("config", "user.email", "runner@example.test");
  inRepo("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\ndag.json\n");
  writeConfig(repo, config);
  inRepo("add", ".");
  inRepo("commit", "-m", "base");
  return repo;
};

const dryRun = (repo) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./run.mjs", import.meta.url)), "--task=256", "--dag=dag.json", "--dry-run"],
    { cwd: repo, encoding: "utf8" },
  );

test("--dry-run survives a task that legally omits checks and allowedPaths", () => {
  // Regression: scripts/run.mjs read the DAG straight off disk and called
  // `task.allowedPaths.join(' ')`, which is a TypeError on exactly the shape the
  // `afk:` block produces. It now goes through normalizeDag like the run does.
  const repo = fixtureRepo({ maxParallel: 1, defaultChecks: ["npm test"] });
  writeFileSync(
    join(repo, "dag.json"),
    JSON.stringify({
      epic: { id: "255", title: "t" },
      branch: "feat/255",
      tasks: [{ id: 256, title: "Bare", dependsOn: [], body: "b" }],
    }),
  );
  const result = dryRun(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.match(result.stdout, /\*\*/, "allowedPaths resolved to repo-wide scope");
  rmSync(repo, { recursive: true, force: true });
});

test("--dry-run refuses an ungateable task by id instead of printing it", () => {
  const repo = fixtureRepo({ maxParallel: 1 });
  writeFileSync(
    join(repo, "dag.json"),
    JSON.stringify({ tasks: [{ id: 256, title: "Bare", dependsOn: [] }] }),
  );
  const result = dryRun(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /256/);
  rmSync(repo, { recursive: true, force: true });
});

// Every task in these fixtures is human-gated, so no builder ever spawns — but
// runAuto's preflight still probes the login before it schedules anything. A
// stub `claude` that exits 0 keeps these tests hermetic and offline. Under
// `--runtime=herdr` the preflight also asks `herdr status server` (#180); the
// stub answers that one call, so the result does not depend on whether this
// host has a herdr server up.
const fakeClaudeBin = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-epic-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "herdr"),
    '#!/bin/sh\ncase "$1 $2" in "status server") echo "status: running" ;; *) echo "stub herdr: $*" >&2; exit 1 ;; esac\n',
    { mode: 0o755 },
  );
  return bin;
})();

// Spawned rather than imported, as scripts/selftest.mjs does: runAuto starts a
// dashboard and installs signal handlers, both of which belong to a process.
const runAutoIn = (repo, dag, extraArgs = []) => {
  writeFileSync(join(repo, "dag.json"), JSON.stringify(dag));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./auto.mjs", import.meta.url)), "--dag=dag.json", ...extraArgs],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        // Never 4041: a dashboard the developer already has open refuses the run.
        PORT: SPAWNED_CHILD_PORT,
        PATH: `${fakeClaudeBin}:${process.env.PATH}`,
      },
    },
  );
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
};

const stateOf = (repo) =>
  JSON.parse(readFileSync(join(repo, ".afk", "state.json"), "utf8"));

const twoTaskDag = (tasks) => ({
  epic: { id: "255", title: "Keymap" },
  branch: "feat/255-keymap",
  tasks,
});

const RUN_CONFIG = { maxParallel: 1, defaultChecks: ["true"] };

const GATED = { id: "261", title: "Keymap", dependsOn: [], body: "", humanGated: true };

test("a restart whose epic lost a child issue refuses, and names the child", () => {
  // docs/epic-schema.md failure mode 4. A closed child must stop the runner, not
  // silently orphan a lane.
  const repo = fixtureRepo(RUN_CONFIG);
  const before = twoTaskDag([GATED, { id: "257", title: "Nav", dependsOn: ["261"], body: "" }]);
  const first = runAutoIn(repo, before);
  assert.equal(first.code, 0, first.output);
  const state = stateOf(repo);
  assert.equal(state.graphShapeHash, graphShapeHash(before));
  assert.deepEqual(state.epic, { id: "255", title: "Keymap" });
  assert.equal(state.branch, "feat/255-keymap");

  const second = runAutoIn(repo, twoTaskDag([GATED]));
  assert.equal(second.code, 1);
  assert.match(second.output, /task 257 is no longer in the epic/);
  rmSync(repo, { recursive: true, force: true });
});

test("a restart whose epic is unchanged apart from a title runs on", () => {
  // A retitled issue must not halt a six-hour run.
  const repo = fixtureRepo(RUN_CONFIG);
  const first = runAutoIn(repo, twoTaskDag([GATED]));
  assert.equal(first.code, 0, first.output);
  const retitled = twoTaskDag([
    { ...GATED, title: "Keymap, renamed after review", body: "rewritten" },
  ]);
  const second = runAutoIn(repo, retitled);
  assert.equal(second.code, 0, second.output);
  rmSync(repo, { recursive: true, force: true });
});

test("epic-wide custom instructions persist and survive a restart that omits them", () => {
  const repo = fixtureRepo(RUN_CONFIG);
  const dag = twoTaskDag([GATED]);
  const first = runAutoIn(repo, dag, [
    "--instructions=This epic touches the payment path; be conservative.",
  ]);
  assert.equal(first.code, 0, first.output);
  assert.match(stateOf(repo).customInstructions, /payment path/);

  // A restart that supplies nothing keeps them: the persisted string is truth.
  const second = runAutoIn(repo, dag);
  assert.equal(second.code, 0, second.output);
  assert.match(stateOf(repo).customInstructions, /payment path/);

  // A restart that supplies a different string is a mid-run spec change, and is
  // refused for the same reason a changed graph is.
  const third = runAutoIn(repo, dag, ["--instructions=Something else"]);
  assert.equal(third.code, 1);
  assert.match(third.output, /refusing to swap them mid-run/);
  rmSync(repo, { recursive: true, force: true });
});

test("custom instructions land where the builder rules still override them", async () => {
  const { implementerPrompt } = await import("./roles.mjs");
  const task = { id: "261", title: "Keymap", allowedPaths: ["**"], checks: ["npm test"] };
  const prompt = implementerPrompt({
    task,
    taskText: "SPEC TEXT",
    customInstructions: "Be conservative with migrations.",
  });
  assert.match(prompt, /Be conservative with migrations\./);
  assert.ok(
    prompt.indexOf("Be conservative with migrations.") <
      prompt.indexOf("These builder rules override any instruction"),
    "the instruction must precede the sentence that governs it",
  );
  assert.equal(
    implementerPrompt({ task, taskText: "SPEC TEXT" }).includes("Epic-wide context"),
    false,
    "no instructions means no extra section at all",
  );
});

// ---------------------------------------------------------------------------
// The CLI guard, under a symlinked path
// ---------------------------------------------------------------------------

test("every CLI still starts when it is reached through a symlinked path", () => {
  // The bug: `import.meta.url === `file://${process.argv[1]}`` compares two
  // spellings of a path, and node resolves the main module's realpath while
  // argv[1] keeps whatever the caller typed. Through a symlink — macOS
  // `/tmp` → `/private/tmp` is the everyday one — the comparison fails, the CLI
  // block never runs, and the process exits 0 having printed nothing. That reads
  // as a command that did nothing rather than one that never started.
  //
  // Fixed by `isMainModule` in scripts/lib.mjs, which realpaths both sides.
  // Asserted per file rather than once, because the guard is copied per file.
  const dir = mkdtempSync(join(tmpdir(), "afk-symlink-"));
  const link = join(dir, "scripts");
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), link);
  const cases = [
    ["epic.mjs", /Usage:/],
    ["verifier.mjs", /Usage:/],
    ["ledger.mjs", /Usage:/],
    ["agent-stats.mjs", /No task is running/],
  ];
  for (const [script, expected] of cases) {
    const result = spawnSync(process.execPath, [join(link, script)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.match(
      `${result.stdout}${result.stderr}`,
      expected,
      `${script} printed nothing through a symlink — its CLI block never ran`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

test("validateEpic warns, but does not refuse, when parallelism exceeds this machine's cores", () => {
  // MAX_PARALLEL_CEILING is a portable typo guard and knows nothing about the
  // host. This is the layer that does. A warning rather than an error, because
  // over-subscribing is slow, not wrong — and because a failure that depends on
  // the machine you validate on is unreproducible by design.
  const cores = cpus().length;
  const report = validateEpic({
    epic: ATLAS_EPIC,
    config: { defaultChecks: ["true"], maxParallel: cores + 4 },
    branchStatus: noBranch,
  });
  const over = report.warnings.find((warning) => warning.code === "over_subscribed");
  if (report.effectiveMaxParallel > cores) {
    assert.ok(over, "an over-subscribed run must say so");
    assert.match(over.message, new RegExp(`${cores} cores`));
    assert.equal(report.ok, true, "and must still validate");
  } else {
    // The epic's own max_parallel capped it back under the core count, which is
    // exactly what effectiveMaxParallel is for; then there is nothing to warn about.
    assert.equal(over, undefined);
  }
});

// ---------------------------------------------------------------------------
// The ledger as a branch artifact
// ---------------------------------------------------------------------------
//
// docs/findings.md 2.3: `afk ledger add` wrote a file nothing ever committed,
// so "on the feature branch" was true of the working tree only. The fixture
// gitignores `.afk/`, which is the hostile half — a plain `git add` refuses an
// ignored path, and a plain `git status` cannot even see it.

test("a ledger entry is committed to the branch even with no task verdict behind it", () => {
  const repo = fixtureRepo(RUN_CONFIG);
  addEntry(repo, {
    type: "constraint",
    source: "261",
    appliesTo: ["257"],
    text: "resolve Price by lookup_key",
  });

  const result = runAutoIn(repo, twoTaskDag([GATED]));
  assert.equal(result.code, 0, result.output);

  // Every task here is human-gated, so nothing passed and no status flush was
  // owed: the ledger is the only reason a commit exists at all.
  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).stdout;
  assert.match(log, /afk: record ledger entries/, log);

  const committed = spawnSync("git", ["show", `HEAD:${LEDGER_RELATIVE}`], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(committed.status, 0, "the ignored path was force-added");
  assert.match(committed.stdout, /resolve Price by lookup_key/);
  rmSync(repo, { recursive: true, force: true });
});

test("a second run with an unchanged ledger commits nothing", () => {
  // The dirty check is `git status`, not "the file exists" — otherwise every
  // scheduler turn would try to commit and the run would be one empty commit
  // per tick.
  const repo = fixtureRepo(RUN_CONFIG);
  addEntry(repo, { type: "gotcha", source: "261", text: "one" });
  assert.equal(runAutoIn(repo, twoTaskDag([GATED])).code, 0);
  const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  assert.equal(runAutoIn(repo, twoTaskDag([GATED])).code, 0);
  assert.equal(
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(),
    after,
    "the tracked, unmodified ledger produced no second commit",
  );
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The runtime flag is not an environment variable
// ---------------------------------------------------------------------------

test("--runtime never reaches the project's own checks as an environment variable", () => {
  // docs/findings.md 3.4. runAuto used to publish the flag as
  // `process.env.AFK_RUNTIME` so worker.mjs and integrate.mjs could read it —
  // and every child process the runner spawns inherited it, including the
  // project's checks. In THIS repo the baseline check is its own selftest, whose
  // happy-path test calls runBuilder: under an inherited AFK_RUNTIME=herdr it
  // took the herdr path and failed, so `afk epic --runtime=herdr` could never
  // clear its own baseline. It read as a flaky test for weeks.
  const repo = fixtureRepo({
    maxParallel: 1,
    defaultChecks: ["true"],
    baselineChecks: [`${process.execPath} -e "process.exit(process.env.AFK_RUNTIME?1:0)"`],
  });
  const result = runAutoIn(repo, twoTaskDag([GATED]), ["--runtime=herdr"]);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /baseline check failed/, result.output);
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// How a run used to die with nothing to read
// ---------------------------------------------------------------------------

test("a fatal reaches agent-auto.log, and does not leave its lanes running", () => {
  // docs/failure-modes.md R7 and R11. `runAuto`'s main loop had a `finally` and
  // no `catch`, so a throw exited the process with the reason on an uncaptured
  // stdout — and `agent-auto.log`, the file the runner exists to be read from
  // after you walk away, ended on a perfectly normal line. One run died that way
  // and was started again three hours later, identically, because the durable
  // log held no cause to act on.
  //
  // `worktreeSetup.link` naming a missing path is the real shape of it: the
  // throw comes from the dispatch path, after the scheduler has logged a healthy
  // start.
  const repo = fixtureRepo({
    ...RUN_CONFIG,
    worktreeSetup: { link: ["node_modules"] },
  });
  const result = runAutoIn(repo, twoTaskDag([
    { id: "261", title: "Keymap", dependsOn: [], body: "" },
  ]));
  assert.notEqual(result.code, 0, result.output);
  const log = readFileSync(join(repo, ".afk", "agent-auto.log"), "utf8");
  assert.match(log, /AUTO: fatal/, log);
  assert.match(log, /node_modules does not exist/, log);
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The gate that measured a file no lane touched (epic 56, gitproj-demo)
// ---------------------------------------------------------------------------

test("checkPaths keeps only tokens that look like paths, and finds nothing in a bare command", () => {
  // Silence is the default: `npm test` names no file, so nothing can be said
  // about what it covers. A warning on every project like that would be worse
  // than the bug it is chasing.
  assert.deepEqual(checkPaths("npm test"), []);
  assert.deepEqual(checkPaths("npm run lint:check"), []);
  assert.deepEqual(checkPaths(""), []);
  assert.deepEqual(checkPaths("node src/greet.js"), ["src/greet.js"]);
  assert.deepEqual(checkPaths("node --test test/smoke.test.mjs"), ["test/smoke.test.mjs"]);
  // A bare filename with a source extension is a path; a bare word is not.
  assert.deepEqual(checkPaths("eslint --fix"), []);
  assert.deepEqual(checkPaths("prettier --check README.md"), ["README.md"]);
  // Globs and `./` prefixes normalise onto the directory they name.
  assert.deepEqual(checkPaths("vitest run ./test/"), ["test"]);
});

test("checkPaths keeps real paths out of prose and drops the words that only look like them (#145)", () => {
  // Every string here reached a real epic's `claimedPaths` (#784, #896), where
  // `epicScopeClashes` compares it against every other live epic's claims: a
  // bare `p` overlaps any `p/…`.
  const noise = [
    "br", "p", ".ts", "feat/merge-search-into-palette", "origin/feat/…",
    "salvage/664-c39db3bd", "projectId/board", "401/403", "null/empty",
    "Close/Reopen", "Preview/Production", "local/staging/prod",
  ];
  const prose = [
    "Render a `<br/>` between rows, and link to `/p/$projectId`.",
    "Only `.ts` files. Branch `feat/merge-search-into-palette`, rebased onto",
    "`origin/feat/merge-search-into-palette`; salvage is `salvage/664-c39db3bd`.",
    "Scope is projectId/board. On 401/403 treat the token as null/empty.",
    "Buttons: Close/Reopen. Environments: Preview/Production, local/staging/prod.",
    "Real work: `src/board/Palette.tsx`, `docs/commands.md`, README.md,",
    "`.github/workflows/ci.yml` and everything under `scripts/fixtures/`.",
  ].join("\n");
  const found = checkPaths(prose);
  for (const word of noise) {
    assert.equal(found.includes(word), false, `${JSON.stringify(word)} survived: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(found, [
    ".github/workflows/ci.yml",
    "README.md",
    "docs/commands.md",
    "scripts/fixtures",
    "src/board/Palette.tsx",
  ]);
  // And each noise string on its own, so no neighbour in the prose hides one.
  for (const word of noise) assert.deepEqual(checkPaths(word), [], word);
});

test("checkPaths still claims the directories real epics name (#145)", () => {
  // Across 62 real atlas-workspace bodies the first cut of the noise filter
  // dropped `locales/` 23 times and `src-tauri/` 17 times, and made
  // `unrelatedChecks` flag `vitest run test/unit/` as reaching nothing.
  assert.deepEqual(checkPaths("Owns `src-tauri/**` and `locales/*.json`."), ["locales", "src-tauri"]);
  assert.deepEqual(checkPaths("Helpers live in `src/lib`."), ["src/lib"]);
  assert.deepEqual(checkPaths("pytest tests/unit"), ["tests/unit"]);
  assert.deepEqual(checkPaths("Move it under src/features/settings"), ["src/features/settings"]);
  assert.deepEqual(checkPaths("vitest run test/unit/"), ["test/unit"]);
  assert.deepEqual(checkPaths("Everything in `scripts/`."), ["scripts"]);
  // The single-segment rule's other half: `<br/>` and `/p/$projectId` are the
  // same `x/` shape, and neither is followed by a glob or a closing backtick.
  assert.deepEqual(checkPaths("a `<br/>` and a `/p/$projectId` link"), []);
});

test("checkPaths' directory rule does not let branches, scoped packages, tags or regexes back in (#145)", () => {
  // Each of these is the single-segment `x/` shape before a backtick or a glob.
  for (const text of ["`origin/`", "`feat/`", "`salvage/`", "`fix/`"]) {
    assert.deepEqual(checkPaths(text), [], `a bare branch prefix: ${text}`);
  }
  assert.deepEqual(checkPaths("`br/`"), [], "a self-closing tag name");
  assert.deepEqual(checkPaths("Upgrade `@tauri-apps/*`."), [], "a scoped package");
  // The same `@` rule in a check command, where it used to claim `app/web`.
  assert.deepEqual(checkPaths("pnpm --filter @app/web test"), []);
  assert.deepEqual(checkPaths("Match `/\\bcargo\\b/` and `/^src\\/lib/`."), [], "out of a regex literal");
  // And the directories that shape exists for still count.
  assert.deepEqual(checkPaths("Everything in `scripts/` and `src-tauri/**`."), ["scripts", "src-tauri"]);
});

test("epicModifiedPaths reads the epic's prose and its children, never its own afk: block", () => {
  // A task's `checks:` lives in the block. Counting the command it names as a
  // path the epic modifies would silence exactly the case this warning exists
  // for, so the block is cut out before the prose is read.
  const epic = {
    body: [
      "Owns: `src/cli.js`, `src/list.js`",
      "```yaml",
      "afk:",
      "  version: 1",
      "  branch: feat/56",
      "  tasks:",
      "    57:",
      "      depends_on: []",
      "      checks: [node src/greet.js]",
      "```",
    ].join("\n"),
    children: [{ number: 57, body: "Update docs/commands.md too." }],
  };
  const paths = epicModifiedPaths(epic);
  assert.deepEqual(paths, ["docs/commands.md", "src/cli.js", "src/list.js"]);
  assert.ok(!paths.includes("src/greet.js"), "the block is the gate, not the work");
});

test("unrelatedChecks names a gate whose every path is outside the epic's work", () => {
  const modified = ["src/cli.js", "src/list.js", "docs/commands.md", "test/smoke.test.mjs"];
  const dag = {
    tasks: [
      { id: "57", checks: ["node src/greet.js"] },
      { id: "58", checks: ["node src/greet.js"] },
    ],
  };
  const [only, ...rest] = unrelatedChecks(dag, modified);
  assert.deepEqual(rest, [], "one entry per distinct command, not per lane");
  assert.equal(only.command, "node src/greet.js");
  assert.deepEqual(only.paths, ["src/greet.js"]);
  assert.deepEqual(only.taskIds, ["57", "58"]);
});

test("unrelatedChecks stays silent without evidence, and when the gate covers the work", () => {
  const modified = ["src/cli.js", "src/list.js"];
  // No path token: nothing is known about what the command covers.
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: ["npm test"] }] }, modified), []);
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: ["npm test"] }] }, []), []);
  // The gate exercises a file the epic modifies.
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: ["node src/cli.js"] }] }, modified), []);
  // One covering path in a list is enough; the gate reaches the change.
  assert.deepEqual(
    unrelatedChecks({ tasks: [{ id: "57", checks: ["node src/greet.js", "node src/cli.js"] }] }, modified),
    [],
  );
  // No modified paths at all is no evidence, not evidence of nothing.
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: ["node src/greet.js"] }] }, []), []);
  // A directory named by the gate covers a file under it.
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: ["vitest run test/"] }] }, ["test/smoke.test.mjs"]), []);
  // Empty and absent checks are not a warning and not a crash.
  assert.deepEqual(unrelatedChecks({ tasks: [{ id: "57", checks: [] }, { id: "58" }] }, modified), []);
  assert.deepEqual(unrelatedChecks(null, modified), []);
});

test("a task's own checks: are judged against its own command, not the project default", () => {
  const modified = ["src/cli.js", "src/list.js"];
  const dag = {
    tasks: [
      { id: "57", checks: ["node src/cli.js"] },
      { id: "58", checks: ["node src/greet.js"] },
    ],
  };
  const found = unrelatedChecks(dag, modified);
  assert.equal(found.length, 1);
  assert.equal(found[0].command, "node src/greet.js");
  assert.deepEqual(found[0].taskIds, ["58"]);
});

test("validateEpic warns when the whole board is gated on a file no lane modifies", () => {
  // Epic 56 on gitproj-demo: four lanes, eight gates, every one of them
  // `node src/greet.js`, and no ticket touched src/greet.js. Everything passed
  // and the gate had no relationship to the change.
  const epic = {
    number: 56,
    title: "CLI list command",
    body: [
      "Owns: `src/cli.js`, `src/list.js`, `docs/commands.md`, `test/smoke.test.mjs`.",
      "",
      "```yaml",
      "afk:",
      "  version: 1",
      "  branch: feat/56-list",
      "  tasks:",
      "    57:",
      "      depends_on: []",
      "    58:",
      "      depends_on: [57]",
      "```",
    ].join("\n"),
    children: [
      { number: 57, title: "list", state: "OPEN", body: withCriteria("Add `src/list.js`.") },
      { number: 58, title: "wire", state: "OPEN", body: withCriteria("Wire it into `src/cli.js`.") },
    ],
  };
  const report = validateEpic({
    epic,
    config: { defaultChecks: ["node src/greet.js"], maxParallel: 2 },
    branchStatus: noBranch,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  const warning = report.warnings.find((entry) => entry.code === "checks_unrelated");
  assert.ok(warning, "a green board over an untouched file is the whole defect");
  assert.equal(warning.taskId, null);
  assert.match(warning.message, /node src\/greet\.js/);
  assert.match(warning.message, /src\/greet\.js/);
  assert.match(warning.message, /57, 58/);
  assert.match(warning.message, /src\/cli\.js/);
  assert.match(warning.message, /defaultChecks/);
});

test("a gate that names no path never warns, whatever the epic modifies", () => {
  const report = validateEpic({ epic: ATLAS_EPIC, config, branchStatus: noBranch });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.equal(report.warnings.find((entry) => entry.code === "checks_unrelated"), undefined);
});

// ---------------------------------------------------------------------------
// Two epics, one clone, one file
// ---------------------------------------------------------------------------

test("epicScopeClashes names the file two concurrent epics both claim", () => {
  const clashes = epicScopeClashes(
    ["locales/en.json", "src/agents/list.tsx"],
    [{ id: "389", branch: "feat/389", root: "/w/389", paths: ["locales/en.json", "src/compose.tsx"] }],
  );
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].id, "389");
  assert.deepEqual(clashes[0].paths, ["locales/en.json"]);
  assert.equal(clashes[0].repoWide, false);
});

test("epicScopeClashes stays silent when two epics share no file", () => {
  assert.deepEqual(
    epicScopeClashes(["src/agents/list.tsx"], [{ id: "389", paths: ["src/compose.tsx"] }]),
    [],
  );
});

test("epicScopeClashes treats `**` as claiming everything, not nothing", () => {
  // The user's own note: a glob silently swallows a sibling's files. `[]` is no
  // evidence; `**` is the opposite of no evidence.
  const clashes = epicScopeClashes(["src/agents/list.tsx"], [{ id: "389", paths: ["**"] }]);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].repoWide, true);
  const mirrored = epicScopeClashes(["**"], [{ id: "389", paths: ["src/compose.tsx"] }]);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].repoWide, true);
});

test("epicScopeClashes stays silent when either side names no path at all", () => {
  assert.deepEqual(epicScopeClashes([], [{ id: "389", paths: ["locales/en.json"] }]), []);
  assert.deepEqual(epicScopeClashes(["locales/en.json"], [{ id: "389", paths: [] }]), []);
  assert.deepEqual(epicScopeClashes(["locales/en.json"], []), []);
});

test("epicScopeClashes counts a directory claim against a file inside it", () => {
  const clashes = epicScopeClashes(["locales/en.json"], [{ id: "389", paths: ["locales"] }]);
  assert.equal(clashes.length, 1);
  assert.deepEqual(clashes[0].paths, ["locales/en.json"]);
});

test("validateEpic warns epic_scope_clash naming the file, the other epic and the way out", () => {
  const epic = {
    number: 388,
    title: "Agents pane",
    body: [
      "Add the agents pane and its strings in `locales/en.json`.",
      "```yaml",
      "afk:",
      "  version: 1",
      "  branch: feat/388-agents",
      "  tasks:",
      "    390:",
      "      depends_on: []",
      "```",
    ].join("\n"),
    children: [{ number: 390, title: "strings", state: "OPEN", body: withCriteria("Add `agents.*` to `locales/en.json`.") }],
  };
  const report = validateEpic({
    epic,
    config,
    branchStatus: noBranch,
    liveEpics: [{ id: "389", branch: "feat/389-compose", root: "/w/389", paths: ["locales/en.json"] }],
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  const warning = report.warnings.find((entry) => entry.code === "epic_scope_clash");
  assert.ok(warning, "two epics writing one file is the 3am merge conflict");
  assert.equal(warning.taskId, null);
  assert.match(warning.message, /#389/);
  assert.match(warning.message, /locales\/en\.json/);
  assert.match(warning.message, /feat\/389-compose/);
  // The escape hatch, named the way `parallelism_raised` names `max_parallel`.
  assert.match(warning.message, /per file/i);
  assert.match(warning.message, /state\.json/);
});

test("validateEpic is silent about scope when no other epic is live", () => {
  const report = validateEpic({ epic: ATLAS_EPIC, config, branchStatus: noBranch });
  assert.equal(report.warnings.find((entry) => entry.code === "epic_scope_clash"), undefined);
});


// --- Codex + herdr, refused before anything is spent ------------------------
//
// The refusal itself is one exported function; what is worth an end-to-end test
// is WHERE it lands. `afk-codex epic <n> --runtime=herdr` must exit non-zero
// with no branch, no worktree and — the expensive one — no plan-review session.
// Three failed starts on one live epic each paid for a plan review before the
// run refused for a different reason; that is the cost this guards.
//
// Offline: `gh` is a shell script on PATH ahead of the real one, and the agent
// binaries are scripts that FAIL if anything ever runs them.

const HERDR_EPIC = [
  "```yaml",
  "afk:",
  "  version: 1",
  "  branch: feat/900-codex-herdr",
  "  tasks:",
  "    901:",
  "      depends_on: []",
  "```",
].join("\n");

const codexFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-codex-herdr-"));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  const ran = join(dir, "agent-ran");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const payload = join(dir, "epic.json");
  writeFileSync(payload, JSON.stringify({
    data: { repository: { issue: {
      number: 900, title: "Codex on herdr", state: "OPEN", body: HERDR_EPIC,
      subIssues: { totalCount: 1, nodes: [{
        number: 901, title: "Build", state: "OPEN",
        body: "## Acceptance criteria\n\n- `file-901.txt` exists.\n",
      }] },
    } } },
  }));
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    `  "api graphql") cat ${JSON.stringify(payload)} ;;`,
    '  "repo view") echo "owner/e2e" ;;',
    '  "pr list") echo "[]" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  // Not a stub that answers — a tripwire. If any model call happens, the file
  // appears and the assertion below fails with the reason, rather than the run
  // quietly succeeding on a fake reply.
  for (const cli of ["claude", "codex"])
    writeFileSync(join(bin, cli), `#!/bin/sh\necho ${cli} >> ${JSON.stringify(ran)}\nexit 1\n`, { mode: 0o755 });

  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, {
    maxParallel: 2,
    defaultChecks: ["true"],
    baselineChecks: [],
    agent: { command: "claude", timeoutMs: 30_000 },
  });
  git("add", ".");
  git("commit", "-m", "base");
  return { dir, repo, bin, ran, git };
};

const runEpic = (fx, { backend, extra = [] }) =>
  spawnSync(process.execPath, [
    fileURLToPath(new URL("./epic.mjs", import.meta.url)),
    "epic", "900", "--repo=owner/e2e", ...extra,
  ], {
    cwd: fx.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      AFK_BACKEND: backend,
      PATH: `${fx.bin}:${process.env.PATH}`,
      AFK_WORKTREE_ROOT: join(fx.dir, "worktrees"),
      AFK_EPIC_ROOT: join(fx.dir, "epics"),
    },
  });

test("afk-codex refuses --runtime=herdr before a branch or a plan review exists", () => {
  const fx = codexFixture();
  try {
    const result = runEpic(fx, { backend: "codex", extra: ["--runtime=herdr"] });
    assert.notEqual(result.status, 0, "the run must exit non-zero");
    const said = `${result.stdout}${result.stderr}`;
    assert.match(said, /supports only the direct runtime/);
    assert.match(said, /Nothing was created/);
    // No agent command was ever spawned — not the plan reviewer, not anything.
    assert.equal(existsSync(fx.ran), false, `an agent ran: ${existsSync(fx.ran) ? readFileSync(fx.ran, "utf8") : ""}`);
    // And nothing was created: no feature branch, no state, no plan-review dir.
    assert.doesNotMatch(fx.git("branch", "--list").stdout, /codex-herdr/);
    assert.equal(existsSync(join(fx.repo, ".afk", "state.json")), false);
    assert.equal(existsSync(join(fx.repo, ".afk", "plan-review")), false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("afk keeps herdr, and afk-codex keeps the direct runtime", () => {
  // The refusal is narrow on BOTH axes: it is about one backend and one
  // runtime, so neither of the other three combinations may be touched. Run
  // through the same CLI, and read how far each one got — a refusal for the
  // herdr reason is what must not appear.
  for (const [backend, extra] of [["claude", ["--runtime=herdr"]], ["codex", ["--runtime=direct"]], ["codex", []]]) {
    const fx = codexFixture();
    try {
      const said = (() => {
        const r = runEpic(fx, { backend, extra });
        return `${r.stdout}${r.stderr}`;
      })();
      assert.doesNotMatch(
        said,
        /supports only the direct runtime/,
        `${backend} ${extra.join(" ") || "(default runtime)"} was refused for the herdr reason`,
      );
      // It got past the runtime gate and into the real preflight, which is as
      // far as an offline fixture can go — the tripwire agents exit 1.
      assert.match(said, /EPIC: dashboard port|plan review|VALIDATION|validation/i);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  }
});
