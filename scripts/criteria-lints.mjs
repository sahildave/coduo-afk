// scripts/criteria-lints.mjs — the ticket lints `afk validate` runs over every
// child and once over the epic. Pure and offline: text in, findings out, in the
// shape the validate report already uses (`code`, `taskId`, `message`).
//
// Four rules that lived only in prose and kept breaking runs (docs/validate-lints.md):
//
//   human_in_criteria        a lane told to wait for a person
//   whole_suite_in_criteria  a lane told to run the integrator's whole suite
//   story_not_cited          an epic user story no child carries
//   one_way_door_ungated     a lane touching a path that cannot be taken back
//
// The severity split is `protectedPathsNamed`'s: a line inside the ticket's
// acceptance criteria binds the lane, so it is an error; the same line anywhere
// else in the body may be context, so it is a warning.
import { checkPaths, criteriaSection } from "./epic.mjs";
import { parseStopAnswer } from "./forecast.mjs";
import { globToRegExp, ownScope } from "./lib.mjs";

// Trimmed, without the list marker or checkbox, so a message quotes the words.
const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, ""))
    .filter(Boolean);

// The body with one section cut out. `split/join` rather than an index, the
// same way `epicModifiedPaths` cuts the `afk:` block out of the epic body.
const without = (body, section) =>
  section ? String(body ?? "").split(section).join("\n") : String(body ?? "");

/**
 * A `##`-style section's text by heading, up to the next heading of any level,
 * or null when the body has no such heading.
 */
export const sectionNamed = (body, name) => {
  const text = String(body ?? "");
  const start = text.match(new RegExp(`^[ \\t]*#{1,6}[ \\t]*${name}[ \\t]*$`, "im"));
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = rest.match(/^[ \t]*#{1,6}[ \t]/m);
  return next ? rest.slice(0, next.index) : rest;
};

// ---------------------------------------------------------------------------
// 1. human_in_criteria
// ---------------------------------------------------------------------------

const PEOPLE = String.raw`(?:the owner|the human|the maintainer)`;
const HUMAN_PHRASES = new RegExp(
  [
    String.raw`\bask (?:the owner|the human|the maintainer)\b`,
    String.raw`\bstop[- ]and[- ]ask\b`,
    String.raw`\bsign[- ]off\b`,
    String.raw`\bhuman approval\b`,
    String.raw`\bowner's approval\b`,
    String.raw`\bmanual approval\b`,
    String.raw`\bapproved by\b`,
    String.raw`\b(?:confirm with|check with|wait for) ${PEOPLE}\b`,
    String.raw`\bthe owner (?:decides|approves)\b`,
  ].join("|"),
  "i",
);

/** The lines of `text` that hand a decision or an approval to a person. */
export const humanLines = (text) => lines(text).filter((line) => HUMAN_PHRASES.test(line));

// ---------------------------------------------------------------------------
// 2. whole_suite_in_criteria
// ---------------------------------------------------------------------------

const SUITE_PHRASES = [
  "check:all",
  "test:all",
  "the e2e suite passes",
  "the unit suite passes",
  "the test suite passes",
  "the browser suite passes",
  "the whole suite",
  "the full suite",
  "the entire suite",
  "all tests pass",
];

// A line naming one test file is about that file, whatever else it says.
const NARROWED = /(?:^|[\s`'"(])[\w./-]*(?:\.spec\.|\.test\.)[\w./-]*|(?:^|[\s`'"(./])e2e\/[\w./-]+/i;

// The commands only the integrator's baseline runs: in `baselineChecks`, not in
// `defaultChecks`. A command in both is a lane gate already and naming it is fine.
const baselineOnly = (config) => {
  const lane = new Set(Array.isArray(config?.defaultChecks) ? config.defaultChecks : []);
  return (Array.isArray(config?.baselineChecks) ? config.baselineChecks : [])
    .filter((command) => typeof command === "string" && command.trim() && !lane.has(command));
};

/** The lines of `text` that make a lane run a whole suite. */
export const wholeSuiteLines = (text, config = null) => {
  const commands = baselineOnly(config);
  return lines(text).filter((line) => {
    if (NARROWED.test(line)) return false;
    const lower = line.toLowerCase();
    return SUITE_PHRASES.some((phrase) => lower.includes(phrase))
      || commands.some((command) => line.includes(command));
  });
};

const LINE_LINTS = [
  {
    code: "human_in_criteria",
    lines: (text) => humanLines(text),
    // A gated task's approval is what its gate is for.
    applies: (task) => !task?.gate,
    what: "hand a decision to a person inside a lane, where nobody is",
    fix: "Make the task `gate: before` or `gate: after` in the `afk:` block, or state what the lane does instead (for example, \"any pixel change fails the lane and is reported\").",
  },
  {
    code: "whole_suite_in_criteria",
    lines: (text, config) => wholeSuiteLines(text, config),
    applies: () => true,
    what: "make the lane run a whole suite",
    fix: "The integrator runs the whole suite at every merge; name the spec files this change adds or re-records instead.",
  },
];

/**
 * The line lints for one child. Errors for lines in its acceptance criteria,
 * one warning per lint for the same lines anywhere else in the body — a ticket
 * that describes a pattern would otherwise bury the report.
 * @param {{id: string, body: string, task: object, config: object|null}} input
 * @returns {{errors: object[], warnings: object[]}}
 */
export const childLints = ({ id, body, task, config = null }) => {
  const errors = [];
  const warnings = [];
  const criteria = criteriaSection(body);
  const prose = without(body, criteria);
  for (const lint of LINE_LINTS) {
    if (!lint.applies(task)) continue;
    for (const line of criteria === null ? [] : lint.lines(criteria, config)) {
      errors.push({ code: lint.code, taskId: id, message: `task ${id}: #${id}'s acceptance criteria ${lint.what}: "${line}". ${lint.fix}` });
    }
    const found = lint.lines(prose, config);
    if (found.length) {
      warnings.push({ code: lint.code, taskId: id, message: `#${id} has ${found.length === 1 ? "a line that would" : `${found.length} lines that would`} ${lint.what}, outside its acceptance criteria: ${found.map((line) => `"${line}"`).join("; ")}. Harmless if it is only context. ${lint.fix}` });
    }
  }
  return { errors, warnings };
};

// ---------------------------------------------------------------------------
// 3. story_not_cited
// ---------------------------------------------------------------------------

/** The epic's numbered user stories, as a Map of number to text. */
export const epicStories = (body) => {
  const section = sectionNamed(body, "user stories");
  if (section === null) return null;
  const stories = new Map();
  for (const line of section.split("\n")) {
    const item = line.match(/^ {0,3}(\d+)[.)][ \t]+(\S.*)$/);
    if (item && !stories.has(Number(item[1]))) stories.set(Number(item[1]), item[2].trim());
  }
  return stories;
};

/**
 * The story numbers a child's `## User stories` section cites, or null when it
 * has no such section. `1–4, 7`, hyphen or en dash. An issue reference (`#190`,
 * `epic 190`, `issue 190`, `task 204`, `PR 198`) is not a story number.
 */
export const citedStories = (body) => {
  const section = sectionNamed(body, "user stories");
  if (section === null) return null;
  const cited = new Set();
  // A reference and its whole list or range: "epics 190 and 191", "PRs 198, 199",
  // "task 204–206", "issue: 12". `[ \t]`, not `\s`: a reference never eats the next line.
  const text = section.replace(
    /#\d+|\b(?:epics?|issues?|tasks?|prs?)[ \t]*[#:]?[ \t]*\d+(?:[ \t]*(?:[-–,]|\band\b)[ \t]*#?\d+)*/gi,
    " ",
  );
  for (const [, from, to] of text.matchAll(/(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    const low = Number(from);
    const high = to === undefined ? low : Number(to);
    for (let n = Math.min(low, high); n <= Math.max(low, high); n += 1) cited.add(n);
  }
  return cited;
};

const storyFindings = ({ epic, ids, children }) => {
  const errors = [];
  const warnings = [];
  const stories = epicStories(epic.body);
  if (!stories || stories.size === 0) return { errors, warnings };
  const citing = ids
    .map((id) => ({ id, cited: citedStories(children.get(id)?.body) }))
    .filter((child) => child.cited !== null);
  if (citing.length === 0) {
    warnings.push({
      code: "stories_uncited",
      taskId: null,
      message: `the epic has ${stories.size} user stories and no child has a \`## User stories\` section citing them, so whether every story is carried is left to the plan reviewer. Cite them per child, for example "1–4, 7".`,
    });
    return { errors, warnings };
  }
  const covered = new Set(citing.flatMap((child) => [...child.cited]));
  for (const [number, text] of stories) {
    if (covered.has(number)) continue;
    errors.push({
      code: "story_not_cited",
      taskId: null,
      message: `user story ${number} is cited by no child: "${text.slice(0, 80)}". Add it to the \`## User stories\` section of the child that carries it, or cut it from the epic.`,
    });
  }
  for (const child of citing) {
    const unknown = [...child.cited].filter((number) => !stories.has(number)).sort((a, b) => a - b);
    if (unknown.length) {
      errors.push({
        code: "story_not_in_epic",
        taskId: child.id,
        message: `task ${child.id}: #${child.id} cites user ${unknown.length === 1 ? "story" : "stories"} ${unknown.join(", ")}, which the epic does not have (it numbers 1 to ${Math.max(...stories.keys())}). Fix the citation.`,
      });
    }
  }
  return { errors, warnings };
};

// ---------------------------------------------------------------------------
// 4. One-way doors
// ---------------------------------------------------------------------------

const isStringList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim() !== "");

/**
 * The paths a task names: its `## Allowed paths` section, or, when it has none,
 * its whole body minus the `## Prohibited` section. A path a ticket forbids is
 * not one it will touch.
 */
export const namedPaths = (body) => {
  const allowed = sectionNamed(body, "allowed paths");
  return checkPaths(allowed ?? without(body, sectionNamed(body, "prohibited")));
};

/**
 * Does `path` hit the door glob `glob`? When the glob matches it, or when one
 * side's literal prefix contains the other's: `supabase/migrations/**` named in
 * a ticket reaches the scanner as `supabase/migrations`, which is the door's
 * own directory.
 */
export const doorHit = (glob, path) => {
  if (globToRegExp(glob).test(path)) return true;
  const door = ownScope(glob);
  const named = ownScope(path);
  // The path covers the door: `src` or `src/billing` against `src/billing/**`.
  if (door === named || door.startsWith(`${named}/`)) return true;
  const wildcard = glob.search(/[*?[]/);
  // The path sits inside a wildcard-free door: `supabase/migrations/001.sql`
  // against `supabase/migrations`.
  if (wildcard === -1) return named.startsWith(`${door}/`);
  // The path sits inside a globbed door's literal prefix: `.github/workflows/deploy`
  // against `.github/workflows/deploy*.yml`. Character-wise on purpose, so
  // `scripts/purge-` is inside `scripts/purge-*` and `scripts/build.mjs` is not.
  return wildcard > 0 && named.startsWith(glob.slice(0, wildcard));
};

const doorFindings = ({ spec, ids, children, config }) => {
  const errors = [];
  const warnings = [];
  const waivers = spec.waivers && typeof spec.waivers === "object" ? spec.waivers : {};
  const doors = config?.oneWayDoors;
  let valid = {};
  // Fails closed: a malformed `oneWayDoors` is an error, not "no doors", since
  // reading it as empty would let every path behind a door through ungated.
  if (doors !== undefined && doors !== null) {
    const ok = typeof doors === "object" && !Array.isArray(doors)
      && Object.values(doors).every(isStringList);
    if (!ok) {
      errors.push({
        code: "one_way_doors",
        taskId: null,
        message: `.afk-setup/config.yaml's \`oneWayDoors\` must map each door's name to a list of path globs, got ${JSON.stringify(doors)}`,
      });
    } else {
      valid = doors;
    }
  }
  const hits = new Set();
  for (const id of ids) {
    const task = spec.tasks?.[id] ?? {};
    const paths = namedPaths(children.get(id)?.body);
    const found = [];
    for (const [name, globs] of Object.entries(valid)) {
      for (const glob of globs) {
        for (const path of paths) {
          if (doorHit(glob, path)) found.push({ name, glob, path });
        }
      }
    }
    if (found.length === 0) continue;
    hits.add(id);
    const shown = found.map((hit) => `${hit.name} (\`${hit.glob}\` by \`${hit.path}\`)`).join(", ");
    const answer = parseStopAnswer(spec.stops?.[id]);
    if (answer?.kind === "delegate") {
      errors.push({
        code: "one_way_door_delegated",
        taskId: id,
        message: `task ${id}: #${id} opens the one-way door ${shown}, and its \`stops:\` answer delegates it. A one-way door is never delegated; answer \`park\` or \`last\`.`,
      });
      continue;
    }
    if (task.gate === "before") continue;
    const waiver = typeof waivers[id] === "string" ? waivers[id].trim() : "";
    if (waiver) {
      warnings.push({
        code: "one_way_door_waived",
        taskId: id,
        message: `#${id} opens the one-way door ${shown} without \`gate: before\`, waived: "${waiver}"`,
      });
      continue;
    }
    errors.push({
      code: "one_way_door_ungated",
      taskId: id,
      message: `task ${id}: #${id} opens the one-way door ${shown} and is not \`gate: before\` — the lane would cross it unattended. Make it \`gate: before\`, or waive it under \`waivers:\` in the \`afk:\` block with the reason.`,
    });
  }
  for (const id of Object.keys(waivers)) {
    if (hits.has(id) || !Object.hasOwn(spec.tasks ?? {}, id)) continue;
    warnings.push({
      code: "waiver_unused",
      taskId: id,
      message: `waivers: task \`${id}\` names no path behind a one-way door${Object.keys(valid).length ? "" : " (the config declares no `oneWayDoors`)"}, so its waiver waives nothing. Remove it.`,
    });
  }
  return { errors, warnings };
};

/**
 * The epic-wide lints: user-story coverage and one-way doors.
 * @param {{epic: object, spec: object, config: object|null}} input `spec` has
 *   already passed `validateEpicSpec`
 * @returns {{errors: object[], warnings: object[]}}
 */
export const epicLints = ({ epic, spec, config = null }) => {
  const ids = Object.keys(spec?.tasks ?? {});
  const children = new Map((epic?.children ?? []).map((child) => [String(child.number), child]));
  const stories = storyFindings({ epic, ids, children });
  const doors = doorFindings({ spec, ids, children, config });
  return {
    errors: [...stories.errors, ...doors.errors],
    warnings: [...stories.warnings, ...doors.warnings],
  };
};
