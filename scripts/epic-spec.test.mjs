// scripts/epic-spec.test.mjs — regression tests for the epic `afk:` block.
// Run: node --test scripts/epic-spec.test.mjs
// The block is a dependency graph, so every test here guards a silent
// mis-schedule: a task id that stops matching, a dependency that points at
// nothing, a cycle that deadlocks the ready queue, or a construct the parser
// guessed at instead of refusing. Each test names the failure it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EpicSpecError,
  MAX_PARALLEL_CEILING,
  findEpicBlocks,
  formatGraphMetrics,
  graphMetrics,
  parseEpicBlock,
  parseYamlSubset,
  toYamlSubset,
  validateEpicSpec,
} from "./epic-spec.mjs";

// The shape docs/epic-schema.md runs its failure modes against:
// 204 → 205/206/207 → 208/209/210 → 211.
const CANONICAL = `
Some prose above the block.

\`\`\`yaml
afk:
  version: 1
  branch: feat/203-stripe-subscriptions
  max_parallel: 3                            # optional; caps .afk-setup/config.yaml

  tasks:
    204:
      depends_on: []
      gate: before                           # human provisions, then releases

    205:
      depends_on: [204]

    206:
      depends_on: [204]

    207:
      depends_on: [204]

    208:
      depends_on: [205, 206]
      checks: [npm run lint:check, npm test] # narrower gate, optional

    209:
      depends_on: [206, 207]

    210:
      depends_on: [207]

    211:
      depends_on: [208, 209, 210]
      gate: after
\`\`\`

Prose below.
`;

const wrap = (yaml) => `intro\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;

const errorFor = (yaml) => {
  try {
    parseEpicBlock(wrap(yaml));
  } catch (error) {
    return error;
  }
  return null;
};

const codes = (result) => result.errors.map((error) => error.code);
const messages = (result) => result.errors.map((error) => error.message);

// --- extraction ------------------------------------------------------------

test("a valid block round-trips into a plain object", () => {
  const spec = parseEpicBlock(CANONICAL);
  assert.equal(spec.version, 1);
  assert.equal(spec.branch, "feat/203-stripe-subscriptions");
  assert.equal(spec.max_parallel, 3);
  assert.deepEqual(Object.keys(spec.tasks), [
    "204",
    "205",
    "206",
    "207",
    "208",
    "209",
    "210",
    "211",
  ]);
  assert.deepEqual(spec.tasks["204"], { depends_on: [], gate: "before" });
  assert.deepEqual(spec.tasks["208"].checks, [
    "npm run lint:check",
    "npm test",
  ]);
  assert.deepEqual(spec.tasks["211"], {
    depends_on: ["208", "209", "210"],
    gate: "after",
  });
  assert.equal(validateEpicSpec(spec).ok, true);
});

test("no afk: block is a clear error, not an empty spec", () => {
  // An epic missing its write-back step (coduo-tickets' easy-to-forget final
  // step) must refuse, not run zero tasks and report success.
  assert.equal(findEpicBlocks("# Epic\n\nno block here\n").length, 0);
  assert.throws(() => parseEpicBlock("# Epic\n\nno block here\n"), (error) => {
    assert.ok(error instanceof EpicSpecError);
    assert.match(error.message, /no `afk:` block/);
    return true;
  });
});

test("two afk: blocks are refused and both fences are named", () => {
  const body = `${wrap("afk:\n  version: 1")}\n${wrap("afk:\n  version: 1")}`;
  assert.equal(findEpicBlocks(body).length, 2);
  assert.throws(() => parseEpicBlock(body), /2 `afk:` blocks.*lines 3, 10/s);
});

test("a fenced block in another language is not mistaken for the spec", () => {
  const body = "```json\n{ \"afk\": 1 }\n```\n\n```yaml\nafk:\n  version: 1\n```\n";
  assert.equal(findEpicBlocks(body).length, 1);
  assert.equal(parseEpicBlock(body).version, 1);
});

test("the block must hold only the afk: key", () => {
  assert.match(
    errorFor("afk:\n  version: 1\nother: 2").message,
    /exactly one top-level key/,
  );
});

// --- parser subset: what is accepted ---------------------------------------

test("comments and blank lines are ignored, including trailing ones", () => {
  const parsed = parseYamlSubset(
    "# leading\n\nafk:\n  version: 1   # trailing\n\n  branch: feat/x\n",
  );
  assert.deepEqual(parsed, { afk: { version: 1, branch: "feat/x" } });
});

test("scalars: numbers, booleans, bare and quoted strings", () => {
  const parsed = parseYamlSubset(
    [
      "n: 42",
      "f: 1.5",
      "t: true",
      "f2: false",
      "bare: feat/203-stripe",
      'dq: "a: b # c"',
      "sq: 'it''s fine'",
      "hash: feat/203#2",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    n: 42,
    f: 1.5,
    t: true,
    f2: false,
    bare: "feat/203-stripe",
    dq: "a: b # c",
    sq: "it's fine",
    // `#` only opens a comment after a space — otherwise a branch name loses
    // its tail and the run targets the wrong ref.
    hash: "feat/203#2",
  });
});

test("block lists parse indented and at the key's own indent", () => {
  const indented = parseYamlSubset("a:\n  - 204\n  - 205\n");
  const flush = parseYamlSubset("a:\n- 204\n- 205\nb: 1\n");
  assert.deepEqual(indented, { a: [204, 205] });
  assert.deepEqual(flush, { a: [204, 205], b: 1 });
});

test("flow lists handle empty, spaced and quoted items", () => {
  assert.deepEqual(parseYamlSubset("a: []\nb: [204, 205]\nc: [npm test]"), {
    a: [],
    b: [204, 205],
    c: ["npm test"],
  });
  assert.deepEqual(parseYamlSubset('a: ["x, y", z]  # note'), {
    a: ["x, y", "z"],
  });
});

// --- parser subset: what is refused ----------------------------------------

test("the parser refuses a tab in the indentation, naming the line", () => {
  // Indentation is the whole structure here. A tab means guessing a width, and
  // a wrong guess reparents a task under the wrong key.
  const error = errorFor("afk:\n  version: 1\n\ttasks: 1");
  assert.match(error.message, /line 6: tab in the indentation/);
  assert.equal(error.line, 6);
});

test("the parser refuses anchors and aliases", () => {
  assert.match(errorFor("afk: &base\n  version: 1").message, /anchor or alias/);
  assert.match(
    errorFor("afk:\n  version: 1\n  branch: *base").message,
    /anchor or alias/,
  );
});

test("the parser refuses multi-document input", () => {
  assert.match(
    errorFor("afk:\n  version: 1\n---\nafk:\n  version: 2").message,
    /document marker/,
  );
  assert.match(errorFor("afk:\n  version: 1\n...").message, /document marker/);
});

test("the parser refuses flow maps, block scalars, tags and nested flow", () => {
  assert.match(errorFor("afk: { version: 1 }").message, /flow mapping/);
  assert.match(errorFor("afk:\n  branch: |\n    x").message, /multi-line scalar/);
  assert.match(errorFor("afk:\n  version: !!int 1").message, /tag/);
  assert.match(
    errorFor("afk:\n  tasks: [[204]]").message,
    /nested flow collection/,
  );
});

test("the parser refuses a duplicate key rather than letting one win", () => {
  // Two `204:` entries would silently collapse to one task with one dep list.
  assert.match(
    errorFor("afk:\n  version: 1\n  version: 2").message,
    /duplicate key `version`/,
  );
});

test("the parser refuses a key with no value", () => {
  // `depends_on:` with nothing after it is null in YAML, which reads as "no
  // dependencies" — the exact silent mis-schedule this file exists to stop.
  assert.match(errorFor("afk:\n  version: 1\n  tasks:").message, /has no value/);
  assert.match(errorFor("afk:\n  branch: null").message, /`null`/);
});

test("the parser refuses a mapping inside a block list", () => {
  assert.match(
    errorFor("afk:\n  tasks:\n    - 204: []").message,
    /mapping inside a block list/,
  );
});

test("the parser refuses unterminated quotes and flow lists", () => {
  assert.match(errorFor('afk:\n  branch: "x').message, /unterminated quoted/);
  assert.match(
    errorFor("afk:\n  tasks: [204").message,
    /unterminated flow list/,
  );
});

test("the parser refuses inconsistent indentation", () => {
  // A sibling that dedents to a width no enclosing block uses would otherwise
  // be silently reparented — a task landing under the wrong parent.
  assert.throws(
    () => parseYamlSubset("a:\n  b:\n    c: 1\n   d: 2\n"),
    /line 4: unexpected indentation/,
  );
  assert.match(
    errorFor("afk:\n  version: 1\n    branch: x").message,
    /already has an inline value/,
  );
});

// --- id normalisation ------------------------------------------------------

test("task ids normalise to strings whether YAML gave numbers or quotes", () => {
  // YAML hands back `204` (number) from depends_on and "204" (string) as a
  // mapping key. Unnormalised, `depends_on: [204]` matches no task key, the
  // dependency never resolves, and the task waits forever with no error.
  const spec = parseEpicBlock(
    wrap(
      [
        "afk:",
        "  version: 1",
        "  branch: feat/x",
        "  tasks:",
        "    204:",
        "      depends_on: []",
        '    "205":',
        "      depends_on: [204]",
        "    206:",
        '      depends_on: ["204", 205]',
      ].join("\n"),
    ),
  );
  assert.deepEqual(Object.keys(spec.tasks), ["204", "205", "206"]);
  assert.deepEqual(spec.tasks["205"].depends_on, ["204"]);
  assert.deepEqual(spec.tasks["206"].depends_on, ["204", "205"]);
  for (const id of spec.tasks["206"].depends_on) {
    assert.equal(typeof id, "string");
  }
  assert.equal(validateEpicSpec(spec).ok, true);
});

test("a leading-zero task key stays raw and is rejected as an id", () => {
  // `007:` scalar-parsed would become 7 and quietly retarget another issue.
  const spec = parseEpicBlock(
    wrap("afk:\n  version: 1\n  branch: feat/x\n  tasks:\n    007:\n      depends_on: []"),
  );
  assert.deepEqual(Object.keys(spec.tasks), ["007"]);
  assert.deepEqual(codes(validateEpicSpec(spec)), ["task_id"]);
});

// --- validation ------------------------------------------------------------

const specOf = (body) => parseEpicBlock(wrap(body));
const minimal = (extra = "", tasks = "    204:\n      depends_on: []") =>
  specOf(`afk:\n  version: 1\n  branch: feat/x\n${extra}  tasks:\n${tasks}`);

test("version must be 1 and must be present", () => {
  assert.deepEqual(
    codes(validateEpicSpec({ version: 2, branch: "x", tasks: { 204: {} } })),
    ["version"],
  );
  assert.deepEqual(
    codes(validateEpicSpec({ branch: "x", tasks: { 204: {} } })),
    ["version"],
  );
});

test("branch must be present and a plausible git ref", () => {
  for (const branch of [
    undefined,
    "",
    "has space",
    "feat/..x",
    "-leading",
    "trailing/",
    "a//b",
    "with^caret",
    "feat/x.lock",
    ".hidden/x",
    "ends.",
  ]) {
    const result = validateEpicSpec({
      version: 1,
      branch,
      tasks: { 204: { depends_on: [] } },
    });
    assert.deepEqual(codes(result), ["branch"], `branch ${JSON.stringify(branch)}`);
  }
  assert.equal(
    validateEpicSpec({
      version: 1,
      branch: "feat/203-stripe-subscriptions",
      tasks: { 204: { depends_on: [] } },
    }).ok,
    true,
  );
});

test("max_parallel must be a sane positive integer", () => {
  for (const value of [0, -1, 1.5, "3", MAX_PARALLEL_CEILING + 1]) {
    const result = validateEpicSpec({
      version: 1,
      branch: "feat/x",
      max_parallel: value,
      tasks: { 204: { depends_on: [] } },
    });
    assert.deepEqual(codes(result), ["max_parallel"], `max_parallel ${value}`);
  }
  const ok = validateEpicSpec({
    version: 1,
    branch: "feat/x",
    max_parallel: 3,
    tasks: { 204: { depends_on: [] } },
  });
  assert.equal(ok.ok, true);
  // Non-blocking: over-provisioning is a shape smell, not an error.
  assert.deepEqual(
    ok.warnings.map((warning) => warning.code),
    ["max_parallel"],
  );
});

test("tasks must be a non-empty mapping of issue numbers", () => {
  assert.deepEqual(
    codes(validateEpicSpec({ version: 1, branch: "feat/x" })),
    ["tasks"],
  );
  assert.deepEqual(
    codes(validateEpicSpec({ version: 1, branch: "feat/x", tasks: {} })),
    ["tasks"],
  );
  assert.deepEqual(
    codes(
      validateEpicSpec({
        version: 1,
        branch: "feat/x",
        tasks: { "not-an-issue": { depends_on: [] } },
      }),
    ),
    ["task_id"],
  );
});

test("an unknown top-level key is an error, not a silently ignored key", () => {
  const spec = minimal("  allowed_paths: [app/**]\n");
  const result = validateEpicSpec(spec);
  assert.deepEqual(codes(result), ["unknown_key"]);
  assert.match(messages(result)[0], /unknown top-level key `allowed_paths`/);
});

test("an unknown per-task key is an error and names the task", () => {
  const spec = minimal(
    "",
    "    204:\n      depends_on: []\n      humanGated: true",
  );
  const result = validateEpicSpec(spec);
  assert.deepEqual(codes(result), ["unknown_key"]);
  assert.equal(result.errors[0].taskId, "204");
  assert.match(messages(result)[0], /task `204` has unknown key `humanGated`/);
});

test("a dangling depends_on names both the referrer and the missing id", () => {
  const spec = minimal("", "    204:\n      depends_on: [999]");
  const result = validateEpicSpec(spec);
  assert.deepEqual(codes(result), ["dangling_dependency"]);
  assert.equal(result.errors[0].taskId, "204");
  assert.match(messages(result)[0], /task `204` depends on `999`/);
});

test("a cycle is reported with its actual path", () => {
  const spec = minimal(
    "",
    "    205:\n      depends_on: [208]\n    208:\n      depends_on: [205]",
  );
  const result = validateEpicSpec(spec);
  assert.deepEqual(codes(result), ["cycle"]);
  assert.match(messages(result)[0], /dependency cycle: 205 → 208 → 205/);
  // A self-edge is a cycle too, and reads as one.
  const self = minimal("", "    204:\n      depends_on: [204]");
  assert.match(messages(validateEpicSpec(self))[0], /cycle: 204 → 204/);
});

test("gate must be before or after", () => {
  const spec = minimal("", "    204:\n      depends_on: []\n      gate: maybe");
  assert.deepEqual(codes(validateEpicSpec(spec)), ["gate"]);
  for (const gate of ["before", "after"]) {
    const good = minimal(
      "",
      `    204:\n      depends_on: []\n      gate: ${gate}`,
    );
    assert.equal(validateEpicSpec(good).ok, true);
  }
});

test("checks must be a non-empty list of strings", () => {
  for (const checks of ["[]", "npm test", "[npm test, 3]"]) {
    const spec = minimal(
      "",
      `    204:\n      depends_on: []\n      checks: ${checks}`,
    );
    assert.deepEqual(codes(validateEpicSpec(spec)), ["checks"], checks);
  }
  const good = minimal(
    "",
    "    204:\n      depends_on: []\n      checks: [npm run lint:check, npm test]",
  );
  assert.equal(validateEpicSpec(good).ok, true);
});

test("every error carries its task id where one applies", () => {
  const spec = minimal(
    "",
    "    204:\n      depends_on: [999]\n      gate: nope\n    205:\n      depends_on: []",
  );
  const result = validateEpicSpec(spec);
  assert.equal(result.ok, false);
  for (const error of result.errors) assert.equal(error.taskId, "204");
});

// --- graph math ------------------------------------------------------------

test("depth and blast radius are correct on the canonical shape", () => {
  const metrics = graphMetrics(parseEpicBlock(CANONICAL));
  assert.equal(metrics.total, 8);
  const byId = Object.fromEntries(metrics.rows.map((row) => [row.id, row]));
  assert.deepEqual(
    metrics.rows.map((row) => row.depth),
    [0, 1, 1, 1, 2, 2, 2, 3],
  );
  // Failure mode 1: the root strands everything below it.
  assert.equal(byId["204"].blastRadius, 7);
  assert.equal(byId["205"].blastRadius, 2);
  assert.equal(byId["206"].blastRadius, 3);
  assert.equal(byId["207"].blastRadius, 3);
  assert.equal(byId["208"].blastRadius, 1);
  assert.equal(byId["211"].blastRadius, 0);
  assert.deepEqual(byId["206"].dependents, ["208", "209", "211"]);
  assert.deepEqual(byId["211"].dependsOn, ["208", "209", "210"]);
});

test("the formatter renders the line docs/epic-schema.md quotes", () => {
  const metrics = graphMetrics(parseEpicBlock(CANONICAL));
  const lines = formatGraphMetrics(metrics).split("\n");
  assert.equal(lines[0], "204: depth 0, blast radius 7 of 8");
  assert.equal(lines.at(-1), "211: depth 3, blast radius 0 of 8");
  assert.equal(lines.length, 8);
});

test("a depth-3 graph warns, because depth amplifies one failure", () => {
  const result = validateEpicSpec(parseEpicBlock(CANONICAL));
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["depth"],
  );
});

test("graph math refuses a graph that does not hold together", () => {
  assert.throws(
    () => graphMetrics({ tasks: { 204: { depends_on: ["999"] } } }),
    /depends on `999`/,
  );
  assert.throws(
    () =>
      graphMetrics({
        tasks: { 205: { depends_on: ["208"] }, 208: { depends_on: ["205"] } },
      }),
    /dependency cycle: 205 → 208 → 205/,
  );
});

// ---------------------------------------------------------------------------
// toYamlSubset — the inverse of the parser
// ---------------------------------------------------------------------------

test("toYamlSubset round-trips every shape the project config uses", () => {
  const shapes = [
    { maxParallel: 2, defaultChecks: ["true"], baselineChecks: [] },
    { agent: { command: "claude", timeoutMs: 30_000, runtime: "direct" } },
    { worktreeSetup: { link: [], copy: [], run: [] } },
    { roles: { implementer: { always: ["implement"], offer: ["shadcn"] } } },
  ];
  for (const shape of shapes) {
    assert.deepEqual(parseYamlSubset(toYamlSubset(shape)), shape);
  }
});

test("toYamlSubset quotes only the strings that would parse back as something else", () => {
  const tricky = { values: ["a: b", "#hash", "", "true", "42", " pad ", "- dash"] };
  assert.deepEqual(parseYamlSubset(toYamlSubset(tricky)), tricky);
  // A word with no special meaning stays bare, or the config becomes unreadable.
  assert.match(toYamlSubset({ runtime: "herdr" }), /^runtime: herdr$/m);
});

test("toYamlSubset renders an empty collection inline, which the parser accepts", () => {
  assert.equal(toYamlSubset({ link: [] }), "link: []\n");
  assert.deepEqual(parseYamlSubset("link: []\n"), { link: [] });
});

test("a string with newlines round-trips, because merged notes contain them", () => {
  // `afk stack detect` joins one `notes` per plugin with a blank line between.
  // Emitted raw, the second line reparses as a key and the whole proposed
  // `roles:` block fails to load — it looked fine on screen.
  const merged = { notes: "First plugin's note.\n\nSecond plugin's note." };
  assert.deepEqual(parseYamlSubset(toYamlSubset(merged)), merged);
});

test("toYamlSubset refuses what the parser cannot read, naming the path", () => {
  // Loudly, at the point of writing. The alternative is text that looks like
  // YAML and throws at load, far from the code that produced it.
  assert.throws(() => toYamlSubset({ a: null }), /cannot render a:.*no null/);
  assert.throws(() => toYamlSubset({ a: {} }), /cannot render a:.*no empty mapping/);
  assert.throws(
    () => toYamlSubset({ list: [{ b: 1 }] }),
    /cannot render list\.0:.*no collection inside a list/,
  );
});

test("an empty list is still legal, unlike an empty mapping", () => {
  // `worktreeSetup: { link: [], copy: [], run: [] }` is the shipped config.
  const config = { worktreeSetup: { link: [], copy: [], run: [] } };
  assert.deepEqual(parseYamlSubset(toYamlSubset(config)), config);
});
