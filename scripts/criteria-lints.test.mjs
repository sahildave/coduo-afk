// scripts/criteria-lints.test.mjs — the four ticket lints, driven through
// `validateEpic` the way `afk validate` runs them. See docs/validate-lints.md.
import test from "node:test";
import assert from "node:assert/strict";
import { citedStories, doorHit, humanLines, namedPaths, wholeSuiteLines } from "./criteria-lints.mjs";
import { parseYamlSubset } from "./epic-spec.mjs";
import { validateEpic } from "./epic.mjs";

const noBranch = () => ({ exists: false });
const config = { defaultChecks: ["node afk.mjs selftest"], maxParallel: 2 };

const NEW_CODES = new Set([
  "human_in_criteria", "whole_suite_in_criteria", "story_not_cited", "story_not_in_epic",
  "stories_uncited", "one_way_doors", "one_way_door_ungated", "one_way_door_waived",
  "one_way_door_delegated", "waiver_unused", "waivers",
]);

// harbour #492's acceptance-criteria line, verbatim from the ticket text.
const HARBOUR_492 =
  "Its 30 baselines (aria + screenshot) re-record only where the fixture move changes nothing visible; any pixel change is a stop-and-ask to the owner, not a re-record.";

const ticket = ({ criteria = ["The thing works."], prose = [], stories = null, allowed = null, prohibited = null } = {}) =>
  [
    "## What to build",
    "",
    ...prose,
    "",
    ...(stories === null ? [] : ["## User stories", "", stories, ""]),
    "## Acceptance criteria",
    "",
    ...criteria.map((line) => `- [ ] ${line}`),
    "",
    ...(allowed === null ? [] : ["## Allowed paths", "", ...allowed.map((path) => `- \`${path}\``), ""]),
    ...(prohibited === null ? [] : ["## Prohibited", "", ...prohibited.map((line) => `- ${line}`), ""]),
  ].join("\n");

/**
 * An epic of `children` (id → { body, gate }) with an optional user-stories
 * list and extra top-level block lines (`stops:`, `waivers:`).
 */
const epicOf = ({ children, stories = null, extra = [] }) => ({
  number: 900,
  title: "Lint fixture",
  body: [
    "## Problem",
    "",
    "Fixture.",
    "",
    ...(stories === null ? [] : ["## User Stories", "", ...stories.map((story, index) => `${index + 1}. ${story}`), ""]),
    "```yaml",
    "afk:",
    "  version: 1",
    "  branch: feat/900-lints",
    "  tasks:",
    ...Object.entries(children).flatMap(([id, child]) => [
      `    ${id}:`,
      "      depends_on: []",
      ...(child.gate ? [`      gate: ${child.gate}`] : []),
    ]),
    ...extra,
    "```",
  ].join("\n"),
  children: Object.entries(children).map(([id, child]) => ({
    number: Number(id), title: `Task ${id}`, state: "OPEN", body: child.body,
  })),
});

const validate = (epic, cfg = config) => validateEpic({ epic, config: cfg, branchStatus: noBranch });
const lintErrors = (report) => report.errors.filter((entry) => NEW_CODES.has(entry.code));
const lintWarnings = (report) => report.warnings.filter((entry) => NEW_CODES.has(entry.code));

// ---------------------------------------------------------------------------
// 1 and 2: line lints
// ---------------------------------------------------------------------------

const MUST_HIT = [
  ["human_in_criteria", HARBOUR_492, config],
  ["human_in_criteria", "Merge only with the owner's sign-off.", config],
  ["human_in_criteria", "Ask the owner which price to use.", config],
  ["whole_suite_in_criteria", "`npm run check:all` passes.", config],
  ["whole_suite_in_criteria", "the e2e suite passes", config],
  [
    "whole_suite_in_criteria",
    "`npm run test:e2e` is green.",
    { defaultChecks: ["npm run lint"], baselineChecks: ["npm run lint", "npm run test:e2e"], maxParallel: 2 },
  ],
];

for (const [code, line, cfg] of MUST_HIT) {
  test(`${code}: a criterion "${line.slice(0, 40)}" is refused with the task id and the quoted line`, () => {
    const report = validate(epicOf({ children: { 901: { body: ticket({ criteria: [line] }) } } }), cfg);
    assert.equal(report.ok, false);
    const hit = report.errors.filter((entry) => entry.code === code);
    assert.equal(hit.length, 1, JSON.stringify(report.errors, null, 2));
    assert.equal(hit[0].taskId, "901");
    assert.ok(hit[0].message.includes(`"${line}"`), hit[0].message);
  });

  test(`${code}: the same line outside the acceptance criteria is a warning, not an error`, () => {
    const report = validate(epicOf({ children: { 901: { body: ticket({ prose: [line] }) } } }), cfg);
    assert.deepEqual(lintErrors(report), []);
    const hit = report.warnings.filter((entry) => entry.code === code);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].taskId, "901");
    assert.ok(hit[0].message.includes(`"${line}"`), hit[0].message);
  });
}

const MUST_NOT_HIT = [
  "the approval modal closes on Escape",
  "the dialog asks the user to confirm deletion",
  "Signed-off-by: Sam Owner <owner@example.test>",
  "`pnpm exec playwright test e2e/module-switches.spec.ts` passes",
  "`node afk.mjs selftest` passes",
];

for (const line of MUST_NOT_HIT) {
  test(`no lint finding for "${line.slice(0, 40)}", in the criteria or out`, () => {
    const cfg = { ...config, baselineChecks: ["node afk.mjs selftest"] };
    const report = validate(epicOf({ children: { 901: { body: ticket({ criteria: [line], prose: [line] }) } } }), cfg);
    assert.deepEqual(lintErrors(report), []);
    assert.deepEqual(lintWarnings(report), []);
  });
}

test("#492's line inside a `gate: before` task is not a finding: the gate is the approval", () => {
  const report = validate(epicOf({ children: { 901: { gate: "before", body: ticket({ criteria: [HARBOUR_492] }) } } }));
  assert.deepEqual(lintErrors(report), []);
  assert.deepEqual(lintWarnings(report), []);
});

test("the phrase lists match only what they say", () => {
  assert.deepEqual(humanLines("wait for the owner\nwait for the build\nconfirm with the maintainer\ncheck with the API\nThe owner approves the copy"), [
    "wait for the owner", "confirm with the maintainer", "The owner approves the copy",
  ]);
  assert.deepEqual(wholeSuiteLines("all tests pass\nthe full suite\n`npm run test:all` in e2e/smoke.spec.ts\nnpm test"), [
    "all tests pass", "the full suite",
  ]);
});

// ---------------------------------------------------------------------------
// 3: user stories
// ---------------------------------------------------------------------------

const FIVE_STORIES = [
  "As an operator, I see every task's state on one board so I never open the log to find a stuck lane.",
  "As an operator, I can stop a run.",
  "As an operator, I can resume a run.",
  "As a reviewer, I read one report per epic that names every finding, its severity and who owns the fix next.",
  "As a reviewer, I see the diff.",
];

test("stories: an uncited story is refused and named; a story the epic lacks is refused", () => {
  const report = validate(epicOf({
    stories: FIVE_STORIES,
    children: {
      901: { body: ticket({ stories: "1–3" }) },
      902: { body: ticket({ stories: "5" }) },
    },
  }));
  assert.equal(report.ok, false);
  const missing = report.errors.filter((entry) => entry.code === "story_not_cited");
  assert.equal(missing.length, 1, JSON.stringify(report.errors, null, 2));
  assert.match(missing[0].message, /user story 4 /);
  assert.ok(missing[0].message.includes(`"${FIVE_STORIES[3].slice(0, 80)}"`), missing[0].message);
  assert.ok(!missing[0].message.includes(FIVE_STORIES[3]), "quotes the first 80 characters only");

  const extra = validate(epicOf({
    stories: FIVE_STORIES,
    children: {
      901: { body: ticket({ stories: "1-4" }) },
      902: { body: ticket({ stories: "5, 6" }) },
    },
  }));
  assert.deepEqual(lintErrors(extra).map((entry) => [entry.code, entry.taskId]), [["story_not_in_epic", "902"]]);
  assert.match(lintErrors(extra)[0].message, /stor(?:y|ies) 6\b/);
});

test("stories: with no child citing, the only lint finding is the stories_uncited warning", () => {
  const report = validate(epicOf({
    stories: FIVE_STORIES,
    children: { 901: { body: ticket() }, 902: { body: ticket() } },
  }));
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.deepEqual(lintWarnings(report).map((entry) => entry.code), ["stories_uncited"]);
});

test("stories: an epic with no user-stories section is silent", () => {
  const report = validate(epicOf({ children: { 901: { body: ticket({ stories: "9" }) } } }));
  assert.deepEqual(lintErrors(report), []);
  assert.deepEqual(lintWarnings(report), []);
});

test("stories: a citation reads numbers and ranges, and an issue reference is not a story", () => {
  assert.deepEqual([...citedStories("## User stories\n\nCarries 16–22 from epic #190.\n")], [16, 17, 18, 19, 20, 21, 22]);
  assert.deepEqual([...citedStories("## User stories\n\n1–4, 7\n")], [1, 2, 3, 4, 7]);
  assert.deepEqual([...citedStories("## User stories\n\nStories 2-3; story 5 of epic 190, after task 204 and PR 198.\n")], [2, 3, 5]);
  assert.equal(citedStories("## What to build\n\n1-4\n"), null);
});

test("stories: plural keywords, lists, ranges and punctuation after a reference are not stories, and a reference stays on its line", () => {
  const cite = (line) => [...citedStories(`## User stories\n\n${line}\n`)];
  assert.deepEqual(cite("Carries 1–4 from epics 190 and 191."), [1, 2, 3, 4]);
  assert.deepEqual(cite("Carries 2 (see PRs 198, 199)."), [2]);
  assert.deepEqual(cite("Carries 3; after task 204–206"), [3]);
  assert.deepEqual(cite("Story 2, after task 204, 205"), [2]);
  assert.deepEqual(cite("Carries 4 of Epic #190 issue: 12"), [4]);
  assert.deepEqual(cite("Carries 5, blocked by task\n6"), [5, 6]);
});

// ---------------------------------------------------------------------------
// 4: one-way doors
// ---------------------------------------------------------------------------

const DOORS_CONFIG = {
  ...config,
  ...parseYamlSubset([
    "oneWayDoors:",
    "  migrations: [supabase/migrations/**]",
    "  billing: [src/billing/**, src/app/api/billing/**]",
    "  auth: [src/auth/**]",
    "  deploy: [vercel.json, .github/workflows/deploy*.yml]",
    "  deletion: [scripts/purge-*]",
  ].join("\n")),
};

const MIGRATION = ticket({ allowed: ["supabase/migrations/**", "src/db/schema.ts"] });

test("doors: a task whose allowed paths name a door is refused, naming the door, the glob and the path", () => {
  const report = validate(epicOf({ children: { 901: { body: MIGRATION } } }), DOORS_CONFIG);
  assert.equal(report.ok, false);
  const hit = lintErrors(report);
  assert.deepEqual(hit.map((entry) => [entry.code, entry.taskId]), [["one_way_door_ungated", "901"]]);
  assert.match(hit[0].message, /migrations \(`supabase\/migrations\/\*\*` by `supabase\/migrations`\)/);
});

test("doors: the same task passes as `gate: before`", () => {
  const report = validate(epicOf({ children: { 901: { gate: "before", body: MIGRATION } } }), DOORS_CONFIG);
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.deepEqual(lintWarnings(report), []);
});

test("doors: `gate: after` is not enough", () => {
  const report = validate(epicOf({ children: { 901: { gate: "after", body: MIGRATION } } }), DOORS_CONFIG);
  assert.deepEqual(lintErrors(report).map((entry) => entry.code), ["one_way_door_ungated"]);
});

test("doors: a 10-character waiver passes and is printed as a warning", () => {
  const report = validate(epicOf({
    children: { 901: { body: MIGRATION } },
    extra: ["  waivers:", "    901: additive.."],
  }), DOORS_CONFIG);
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  const waived = lintWarnings(report);
  assert.deepEqual(waived.map((entry) => [entry.code, entry.taskId]), [["one_way_door_waived", "901"]]);
  assert.match(waived[0].message, /waived: "additive\.\."/);
});

test("doors: a waiver under 10 characters, or for a task not in the block, is refused", () => {
  const short = validate(epicOf({ children: { 901: { body: MIGRATION } }, extra: ["  waivers:", "    901: additive"] }), DOORS_CONFIG);
  assert.deepEqual(short.errors.map((entry) => [entry.code, entry.taskId]), [["waivers", "901"]]);
  const stranger = validate(epicOf({
    children: { 901: { gate: "before", body: MIGRATION } },
    extra: ["  waivers:", "    999: the task that is not here"],
  }), DOORS_CONFIG);
  assert.equal(stranger.ok, false);
  assert.deepEqual(stranger.errors.map((entry) => [entry.code, entry.taskId]), [["waivers", "999"]]);
  assert.match(stranger.errors[0].message, /not a task in this block/);
});

test("doors: a waiver on a task with no door is a warning", () => {
  const report = validate(epicOf({
    children: { 901: { body: ticket({ allowed: ["src/db/schema.ts"] }) } },
    extra: ["  waivers:", "    901: only touches a schema file"],
  }), DOORS_CONFIG);
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.deepEqual(lintWarnings(report).map((entry) => [entry.code, entry.taskId]), [["waiver_unused", "901"]]);
});

test("doors: a path the prohibited section names is not a hit when the allowed paths do not name it", () => {
  const body = ticket({ allowed: ["src/db/schema.ts"], prohibited: ["Do not touch `supabase/migrations/`."] });
  assert.deepEqual(namedPaths(body), ["src/db/schema.ts"]);
  const report = validate(epicOf({ children: { 901: { body } } }), DOORS_CONFIG);
  assert.deepEqual(lintErrors(report), []);
  // With no allowed-paths section, the body minus the prohibited section is scanned.
  const loose = ticket({ prose: ["Edit `src/db/schema.ts`."], prohibited: ["Do not touch `supabase/migrations/`."] });
  assert.deepEqual(namedPaths(loose), ["src/db/schema.ts"]);
  assert.deepEqual(lintErrors(validate(epicOf({ children: { 901: { body: loose } } }), DOORS_CONFIG)), []);
});

test("doors: a door task answered `delegate: …` in `stops:` is refused, even gated", () => {
  const report = validate(epicOf({
    children: { 901: { gate: "before", body: MIGRATION } },
    extra: ["  stops:", "    901: \"delegate: the migration only adds columns\""],
  }), DOORS_CONFIG);
  assert.equal(report.ok, false);
  assert.deepEqual(lintErrors(report).map((entry) => [entry.code, entry.taskId]), [["one_way_door_delegated", "901"]]);
});

test("doors: a malformed `oneWayDoors` value is refused", () => {
  for (const oneWayDoors of [["supabase/migrations/**"], { migrations: "supabase/migrations/**" }, { migrations: [] }, "migrations"]) {
    const report = validate(epicOf({ children: { 901: { body: MIGRATION } } }), { ...config, oneWayDoors });
    assert.deepEqual(lintErrors(report).map((entry) => entry.code), ["one_way_doors"], JSON.stringify(oneWayDoors));
  }
});

test("doors: a glob match, a covering directory, or a path inside a globbed prefix hits; a sibling does not", () => {
  assert.equal(doorHit("src/billing/**", "src/billing/invoice.ts"), true);
  assert.equal(doorHit("src/billing/**", "src/billing"), true);
  assert.equal(doorHit("src/billing/**", "src"), true);
  assert.equal(doorHit(".github/workflows/deploy*.yml", ".github/workflows/deploy-prod.yml"), true);
  assert.equal(doorHit(".github/workflows/deploy*.yml", ".github/workflows/deploy"), true);
  assert.equal(doorHit(".github/workflows/deploy*.yml", ".github/workflows/ci.yml"), false);
  assert.equal(doorHit("scripts/purge-*", "scripts/purge-users.mjs"), true);
  assert.equal(doorHit("scripts/purge-*", "scripts/build.mjs"), false);
  assert.equal(doorHit("vercel.json", "vercel.json"), true);
  // A wildcard-free door is a directory too: a file inside it hits.
  assert.equal(doorHit("supabase/migrations", "supabase/migrations/001.sql"), true);
  assert.equal(doorHit("supabase/migrations", "supabase/migrations-old/001.sql"), false);
  assert.equal(doorHit("src/auth/**", "src/authz/rules.ts"), false);
});

// ---------------------------------------------------------------------------
// Unchanged
// ---------------------------------------------------------------------------

test("an epic with none of these patterns and no `oneWayDoors` validates as before", () => {
  // Snapshot taken from `validateEpic` at the base commit, before these lints.
  const epic = epicOf({
    stories: FIVE_STORIES,
    children: {
      901: { body: ticket({ prose: ["Edit `src/a.ts`."] }) },
      902: { gate: "before", body: ticket({ criteria: ["The board renders."] }) },
    },
  });
  const report = validate(epic);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.warnings.filter((entry) => entry.code !== "stories_uncited").map((entry) => entry.code),
    ["no_roles", "no_launch_status", "checks_unrelated"],
  );
  assert.deepEqual(lintWarnings(report).map((entry) => entry.code), ["stories_uncited"]);
});
