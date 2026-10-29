// scripts/epic-spec.mjs — the `afk:` block on a GitHub epic: extract, parse,
// validate, and measure. See docs/epic-schema.md ("Spec lives on the epic").
//
// Self-contained on purpose: this runner ships with no package.json, so there is
// no YAML library to reach for. What is here is a *strict subset* parser, not a
// small YAML. Every construct outside the subset is refused by line number
// rather than guessed at, because this block is a dependency graph — a parser
// that quietly misreads `depends_on` schedules work in the wrong order and the
// run looks healthy the whole time.
//
// Deliberately NOT here: checking that a task key is a real open issue whose
// parent is the epic, and checking whether `branch` already exists with
// divergent history. Both need `gh` and `git`; docs/epic-schema.md lists them
// under the same deterministic tier, but they belong to the layer that owns
// those processes. Everything in this file is pure and offline.

import { validateStops } from "./forecast.mjs";

export class EpicSpecError extends Error {
  constructor(message, line = null) {
    super(line == null ? message : `line ${line}: ${message}`);
    this.name = "EpicSpecError";
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------
//
// Accepted: block mappings nested by space indentation; block sequences
// (`- 204`) either indented under their key or at the key's own indent; inline
// flow sequences (`[204, 205]`, `[]`); scalars — integers, floats, `true`/
// `false`, single- and double-quoted strings, bare strings; `#` comments (whole
// line, or trailing after a space); blank lines.
//
// Refused, each naming its line: tabs in indentation, anchors/aliases (`&`/`*`),
// tags (`!`), block scalars (`|`/`>`), flow mappings (`{}`), nested flow
// collections, document markers (`---`/`...`), duplicate keys, mappings inside
// block sequences, a key with no value (implicit null), inconsistent
// indentation, unterminated quotes or flow lists, and unknown escapes.

const NULLISH = new Set(["null", "Null", "NULL", "~"]);
const TRUE = new Set(["true", "True", "TRUE"]);
const FALSE = new Set(["false", "False", "FALSE"]);
const INT = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/;

const scanLines = (text, lineOffset) => {
  const out = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1 + lineOffset;
    const body = raw.trim();
    if (body === "" || body.startsWith("#")) return;
    if (/^[ ]*\t/.test(raw)) {
      throw new EpicSpecError(
        "tab in the indentation — YAML forbids it and this parser will not guess a tab width; use spaces",
        lineNo,
      );
    }
    if (body === "---" || body === "..." || body.startsWith("--- ")) {
      throw new EpicSpecError(
        "document marker (`---`/`...`) — the block must be a single plain document",
        lineNo,
      );
    }
    const indent = raw.length - raw.trimStart().length;
    out.push({ indent, text: raw.slice(indent).trimEnd(), lineNo });
  });
  return out;
};

// Reads a quoted scalar starting at `from`. Returns [value, indexAfterQuote].
const readQuoted = (text, from, lineNo) => {
  const quote = text[from];
  let out = "";
  let i = from + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'" ) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      const escape = { "\\": "\\", '"': '"', n: "\n", t: "\t", r: "\r" }[next];
      if (escape === undefined) {
        throw new EpicSpecError(
          `unsupported escape \`\\${next ?? ""}\` in a double-quoted string`,
          lineNo,
        );
      }
      out += escape;
      i += 2;
      continue;
    }
    if (ch === '"') return [out, i + 1];
    out += ch;
    i += 1;
  }
  throw new EpicSpecError("unterminated quoted string", lineNo);
};

// Only valid on text already known to hold no quotes. YAML needs the space
// before `#`, otherwise `feat/203#2` would lose its tail.
const stripTrailingComment = (text) => {
  if (text.trimStart().startsWith("#")) return "";
  const at = text.indexOf(" #");
  return at === -1 ? text : text.slice(0, at);
};

const parseFlowList = (raw, lineNo) => {
  const segments = [];
  let current = "";
  let i = 1;
  let closed = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const [, next] = readQuoted(raw, i, lineNo);
      current += raw.slice(i, next);
      i = next;
      continue;
    }
    if (ch === "[" || ch === "{") {
      throw new EpicSpecError(
        "nested flow collection — outside this parser's subset",
        lineNo,
      );
    }
    if (ch === "]") {
      closed = true;
      i += 1;
      break;
    }
    if (ch === ",") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (!closed) {
    throw new EpicSpecError(
      "unterminated flow list — `[` with no `]` on the same line",
      lineNo,
    );
  }
  if (stripTrailingComment(raw.slice(i)).trim() !== "") {
    throw new EpicSpecError("trailing content after a flow list", lineNo);
  }
  if (current.trim() !== "" || segments.length > 0) segments.push(current);
  return segments.map((segment) => parseScalar(segment, lineNo));
};

const parseScalar = (text, lineNo) => {
  const trimmed = text.trim();
  if (trimmed === "") throw new EpicSpecError("empty value", lineNo);
  const head = trimmed[0];
  if (head === "&" || head === "*") {
    throw new EpicSpecError(
      "anchor or alias (`&`/`*`) — outside this parser's subset",
      lineNo,
    );
  }
  if (head === "!") {
    throw new EpicSpecError("tag (`!`) — outside this parser's subset", lineNo);
  }
  if (head === "|" || head === ">") {
    throw new EpicSpecError(
      "multi-line scalar (`|`/`>`) — outside this parser's subset",
      lineNo,
    );
  }
  if (head === "{") {
    throw new EpicSpecError(
      "flow mapping (`{...}`) — outside this parser's subset; use an indented block",
      lineNo,
    );
  }
  if (head === "[") return parseFlowList(trimmed, lineNo);
  if (head === '"' || head === "'") {
    const [value, next] = readQuoted(trimmed, 0, lineNo);
    if (stripTrailingComment(trimmed.slice(next)).trim() !== "") {
      throw new EpicSpecError("trailing content after a quoted scalar", lineNo);
    }
    return value;
  }
  const bare = stripTrailingComment(trimmed).trimEnd();
  if (NULLISH.has(bare)) {
    throw new EpicSpecError(
      "`null` — outside this parser's subset; write an explicit value (`[]` for an empty list)",
      lineNo,
    );
  }
  if (TRUE.has(bare)) return true;
  if (FALSE.has(bare)) return false;
  if (INT.test(bare) || FLOAT.test(bare)) return Number(bare);
  return bare;
};

const isListItem = (line) => line.text === "-" || line.text.startsWith("- ");

// Keys keep their raw source text: `007:` must stay "007" and fail id
// validation loudly, not become the number 7 and quietly retarget a task.
const splitKey = (line) => {
  const text = line.text;
  let key;
  let after;
  if (text[0] === '"' || text[0] === "'") {
    const [value, next] = readQuoted(text, 0, line.lineNo);
    key = value;
    after = text.slice(next);
  } else {
    const colon = text.indexOf(":");
    if (colon === -1) {
      throw new EpicSpecError("expected `key: value`", line.lineNo);
    }
    key = text.slice(0, colon).trimEnd();
    after = text.slice(colon);
  }
  if (!after.startsWith(":")) {
    throw new EpicSpecError("expected `:` after the key", line.lineNo);
  }
  let rest = after.slice(1);
  if (rest !== "" && !rest.startsWith(" ")) {
    throw new EpicSpecError("expected a space after `:`", line.lineNo);
  }
  rest = rest.trim();
  if (rest.startsWith("#")) rest = "";
  if (key === "") throw new EpicSpecError("empty key", line.lineNo);
  return { key, rest };
};

const parseSequence = (lines, start, indent) => {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      throw new EpicSpecError(
        `unexpected indentation (expected ${indent} spaces)`,
        line.lineNo,
      );
    }
    if (!isListItem(line)) break; // a sibling mapping key ends the sequence
    const item = line.text.slice(2).trim();
    if (item === "" || item.startsWith("#")) {
      throw new EpicSpecError("empty list item", line.lineNo);
    }
    // `key: value` inside a list item is a mapping in a sequence — the one YAML
    // shape this subset does not model, so it must be refused rather than
    // silently kept as the scalar string "key: value". Every exclusion in the
    // character class buys something: `"` and `'` keep a quoted scalar
    // (`- "note: see 204"`) a scalar, `[` keeps a flow sequence from reading as
    // a key, and `\s` keeps the key one token. The trailing `( |$)` is the
    // load-bearing part: a colon only opens a mapping when a space or the end
    // of the item follows it, so `- https://example.com` stays a URL instead of
    // being refused as a mapping called `https`.
    if (/^[^\s"'[]*:( |$)/.test(item)) {
      throw new EpicSpecError(
        "mapping inside a block list — outside this parser's subset",
        line.lineNo,
      );
    }
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      throw new EpicSpecError(
        "indented block under a list item — outside this parser's subset",
        next.lineNo,
      );
    }
    out.push(parseScalar(item, line.lineNo));
    i += 1;
  }
  return [out, i];
};

const parseMapping = (lines, start, indent) => {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      throw new EpicSpecError(
        `unexpected indentation (expected ${indent} spaces)`,
        line.lineNo,
      );
    }
    if (isListItem(line)) {
      throw new EpicSpecError(
        "list item where a `key: value` was expected",
        line.lineNo,
      );
    }
    const { key, rest } = splitKey(line);
    if (Object.hasOwn(map, key)) {
      throw new EpicSpecError(
        `duplicate key \`${key}\` — the later one would silently win`,
        line.lineNo,
      );
    }
    const next = lines[i + 1];
    if (rest === "") {
      if (next && next.indent > indent) {
        const [value, after] = parseBlock(lines, i + 1, next.indent);
        map[key] = value;
        i = after;
        continue;
      }
      if (next && next.indent === indent && isListItem(next)) {
        const [value, after] = parseSequence(lines, i + 1, indent);
        map[key] = value;
        i = after;
        continue;
      }
      throw new EpicSpecError(
        `\`${key}:\` has no value — write it explicitly (\`[]\` for an empty list); an implicit null here strands a task`,
        line.lineNo,
      );
    }
    // Scalar first: `key: |` or `key: &anchor` followed by an indented block
    // should report the construct it refuses, not the indentation it caused.
    map[key] = parseScalar(rest, line.lineNo);
    if (next && next.indent > indent) {
      throw new EpicSpecError(
        `indented block under \`${key}:\`, which already has an inline value`,
        next.lineNo,
      );
    }
    i += 1;
  }
  return [map, i];
};

const parseBlock = (lines, start, indent) =>
  isListItem(lines[start])
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);

/**
 * Parse the strict YAML subset. `lineOffset` shifts reported line numbers so an
 * extracted fenced block can name lines in the original issue body.
 * @returns {object} a plain object/array/scalar tree
 * @throws {EpicSpecError}
 */
export const parseYamlSubset = (text, { lineOffset = 0 } = {}) => {
  const lines = scanLines(text, lineOffset);
  if (lines.length === 0) throw new EpicSpecError("empty YAML document");
  if (lines[0].indent !== 0) {
    throw new EpicSpecError("document must start at column 0", lines[0].lineNo);
  }
  const [value, next] = parseBlock(lines, 0, 0);
  if (next < lines.length) {
    throw new EpicSpecError("unparsed trailing content", lines[next].lineNo);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,})\s*([^\s`]*)\s*$/;

/**
 * Every fenced block in a markdown body whose info string is empty/yaml/yml and
 * whose content declares a top-level `afk:` key.
 * @returns {{content: string, lineOffset: number, fenceLine: number}[]}
 */
export const findEpicBlocks = (issueBody) => {
  const lines = String(issueBody ?? "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const [, ticks, info] = open;
    const close = new RegExp(`^ {0,3}\`{${ticks.length},}\\s*$`);
    const start = i + 1;
    let end = start;
    while (end < lines.length && !close.test(lines[end])) end += 1;
    const content = lines.slice(start, end).join("\n");
    const label = info.toLowerCase();
    if (
      // Matched on `afk:` in any form, not just a bare key: `afk: {…}` should
      // reach the parser and get "flow mapping is outside the subset", not the
      // misleading "there is no afk: block".
      (label === "" || label === "yaml" || label === "yml") &&
      /^afk:(\s|$)/m.test(content)
    ) {
      blocks.push({ content, lineOffset: start, fenceLine: i + 1 });
    }
    i = end + 1;
  }
  return blocks;
};

// Ids normalise to strings at the parse boundary. YAML hands back `204` as a
// number from `depends_on` and "204" as a mapping key; that mismatch makes a
// dependency look satisfied-by-nobody and strands the task with no error.
const normalizeSpec = (afk) => {
  const tasks = afk.tasks;
  if (tasks && typeof tasks === "object" && !Array.isArray(tasks)) {
    for (const task of Object.values(tasks)) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      if (Array.isArray(task.depends_on)) {
        task.depends_on = task.depends_on.map((id) =>
          typeof id === "number" ? String(id) : id,
        );
      }
    }
  }
  return afk;
};

/**
 * Extract and parse the epic's `afk:` block.
 * @param {string} issueBody the epic issue body
 * @returns {object} the value of `afk:`, with task ids normalised to strings
 * @throws {EpicSpecError} when there is no such block, more than one, or the
 *   YAML falls outside the accepted subset
 */
export const parseEpicBlock = (issueBody) => {
  const blocks = findEpicBlocks(issueBody);
  if (blocks.length === 0) {
    throw new EpicSpecError(
      "no `afk:` block in the epic body — it needs one fenced yaml block whose top-level key is `afk:`",
    );
  }
  if (blocks.length > 1) {
    const where = blocks.map((block) => block.fenceLine).join(", ");
    throw new EpicSpecError(
      `${blocks.length} \`afk:\` blocks in the epic body (fences at lines ${where}) — exactly one is allowed`,
    );
  }
  const [block] = blocks;
  const document = parseYamlSubset(block.content, {
    lineOffset: block.lineOffset,
  });
  const keys = Object.keys(document);
  if (keys.length !== 1 || keys[0] !== "afk") {
    throw new EpicSpecError(
      `the block must hold exactly one top-level key, \`afk:\` (found: ${keys.join(", ")})`,
    );
  }
  const afk = document.afk;
  if (!afk || typeof afk !== "object" || Array.isArray(afk)) {
    throw new EpicSpecError("`afk:` must be a mapping");
  }
  return normalizeSpec(afk);
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const SPEC_VERSION = 1;
export const TOP_LEVEL_KEYS = ["version", "branch", "max_parallel", "tasks", "stops", "waivers"];
// `waivers:` maps a task id to why it may cross a one-way door without
// `gate: before` (scripts/criteria-lints.mjs). Long enough to be a reason.
export const MIN_WAIVER_REASON = 10;
export const TASK_KEYS = ["depends_on", "gate", "checks"];
export const GATES = ["before", "after"];
// A TYPO GUARD, not a capacity plan. This was flagged as an invented number, and
// the resolution is to say plainly what it is rather than to derive it:
//
// A validator must be machine-independent. Derive this from `os.cpus()` and the
// same epic passes `afk validate` on a workstation and fails on a laptop, which
// makes the spec unportable and the failure unreproducible — for a number that
// is not the real limit anyway. The real capacity limit is applied downstream by
// `effectiveMaxParallel` (scripts/epic.mjs), which takes the MINIMUM of this
// epic's `max_parallel` and the machine's own `.afk-setup/config.yaml` `maxParallel`.
// So a 32 here never means 32 lanes run; it means "a hand-typed number past this
// is a slip, not an intention".
//
// The machine-derived advice does exist, where the machine is actually known:
// `afk validate` warns when the effective parallelism exceeds the host's cores.
export const MAX_PARALLEL_CEILING = 32;
// Failure mode 1: depth amplifies a single failure. Past this, say so.
export const DEEP_GRAPH_DEPTH = 3;

const ISSUE_ID = /^[1-9]\d*$/;

const BRANCH_RULES = [
  [/\s/, "contains whitespace"],
  [/\.\./, "contains `..`"],
  [/^[-/]/, "starts with `-` or `/`"],
  [/\/$/, "ends with `/`"],
  [/\/\//, "contains `//`"],
  [/[~^:?*[\\]/, "contains one of ~ ^ : ? * [ \\"],
  [/@\{/, "contains `@{`"],
  [/\.lock($|\/)/, "has a component ending in `.lock`"],
  [/(^|\/)\./, "has a component starting with `.`"],
  [/\.$/, "ends with `.`"],
  [/[\u0000-\u001f\u007f]/, "contains a control character"],
];

// Where an inline list stops being more readable than a block one. 78 so the
// line still fits an 80-column terminal with a `# ` comment prefix, which is
// how every optional key in the shipped config is written.
const INLINE_LIST_WIDTH = 78;

// Items that MAY render inline: no space, comma, bracket, quote or `#`.
// `needsQuote` still has the final say — see the call site.
const FLOW_SAFE = /^[\w.:@/+-]+$/;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const dependenciesOf = (task) =>
  Array.isArray(task?.depends_on) ? task.depends_on : [];

// DFS over dependency edges; a hit on a node already on the stack yields the
// real cycle path. "a cycle exists" is not actionable on an eight-task graph.
const findCycles = (ids, edges) => {
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
        // Sorted so every rotation of one cycle collapses to one key. The DFS
        // reaches a 3-cycle from all three of its nodes and reports it as
        // a→b→c→a, b→c→a→b, c→a→b→c — three "errors" for one broken edge set,
        // which reads as three separate problems to fix. Drop the repeated
        // head (`slice(0, -1)`) first, or it weights one member twice.
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
  for (const id of ids) if (!state.has(id)) visit(id);
  return cycles;
};

const depthsOf = (ids, edges) => {
  const depths = new Map();
  const walk = (id) => {
    if (depths.has(id)) return depths.get(id);
    depths.set(id, 0); // guard: a cycle would otherwise recurse forever
    let depth = 0;
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) depth = Math.max(depth, walk(next) + 1);
    }
    depths.set(id, depth);
    return depth;
  };
  for (const id of ids) walk(id);
  return depths;
};

/**
 * Deterministic validation of a parsed `afk:` block. Pure and offline — it does
 * not know whether a task id is a real open issue or whether `branch` exists.
 * @param {object} spec the object from `parseEpicBlock`
 * @returns {{ok: boolean, errors: {code: string, taskId: string|null, message: string}[],
 *            warnings: {code: string, taskId: string|null, message: string}[]}}
 */
export const validateEpicSpec = (spec) => {
  const errors = [];
  const warnings = [];
  const fail = (code, message, taskId = null) =>
    errors.push({ code, taskId, message });
  const warn = (code, message, taskId = null) =>
    warnings.push({ code, taskId, message });

  if (!isPlainObject(spec)) {
    fail("shape", "the `afk:` block must be a mapping");
    return { ok: false, errors, warnings };
  }

  for (const key of Object.keys(spec)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      fail(
        "unknown_key",
        `unknown top-level key \`${key}\` (allowed: ${TOP_LEVEL_KEYS.join(", ")})`,
      );
    }
  }

  if (!Object.hasOwn(spec, "version")) {
    fail("version", "missing `version`");
  } else if (spec.version !== SPEC_VERSION) {
    fail(
      "version",
      `\`version\` must be ${SPEC_VERSION}, got ${JSON.stringify(spec.version)}`,
    );
  }

  if (typeof spec.branch !== "string" || spec.branch.trim() === "") {
    fail("branch", "`branch` is required and must be a non-empty string");
  } else {
    const broken = BRANCH_RULES.find(([pattern]) => pattern.test(spec.branch));
    if (broken) {
      fail("branch", `\`branch\` "${spec.branch}" ${broken[1]}`);
    }
  }

  if (Object.hasOwn(spec, "max_parallel")) {
    const value = spec.max_parallel;
    if (!Number.isInteger(value)) {
      fail(
        "max_parallel",
        `\`max_parallel\` must be an integer, got ${JSON.stringify(value)}`,
      );
    } else if (value < 1) {
      fail("max_parallel", `\`max_parallel\` must be >= 1, got ${value}`);
    } else if (value > MAX_PARALLEL_CEILING) {
      fail(
        "max_parallel",
        `\`max_parallel\` ${value} exceeds the ceiling of ${MAX_PARALLEL_CEILING}`,
      );
    }
  }

  if (!isPlainObject(spec.tasks)) {
    fail("tasks", "`tasks` is required and must be a mapping of issue numbers");
    return { ok: errors.length === 0, errors, warnings };
  }
  const ids = Object.keys(spec.tasks);
  if (ids.length === 0) fail("tasks", "`tasks` is empty");

  for (const id of ids) {
    const task = spec.tasks[id];
    if (!ISSUE_ID.test(id)) {
      fail(
        "task_id",
        `task key \`${id}\` is not an issue number (positive integer, no leading zeros)`,
        id,
      );
    }
    if (!isPlainObject(task)) {
      fail("task_shape", `task \`${id}\` must be a mapping`, id);
      continue;
    }
    for (const key of Object.keys(task)) {
      if (!TASK_KEYS.includes(key)) {
        fail(
          "unknown_key",
          `task \`${id}\` has unknown key \`${key}\` (allowed: ${TASK_KEYS.join(", ")})`,
          id,
        );
      }
    }
    // `depends_on` may be omitted; absent means "no dependencies", which shows
    // up immediately as the task running in the first wave. The dangerous
    // default is the other direction, so nothing is inferred here.
    if (Object.hasOwn(task, "depends_on")) {
      if (!Array.isArray(task.depends_on)) {
        fail(
          "depends_on",
          `task \`${id}\`: \`depends_on\` must be a list`,
          id,
        );
      } else {
        for (const dependency of task.depends_on) {
          if (typeof dependency !== "string") {
            fail(
              "depends_on",
              `task \`${id}\`: \`depends_on\` entry ${JSON.stringify(dependency)} is not an issue number`,
              id,
            );
          } else if (!Object.hasOwn(spec.tasks, dependency)) {
            fail(
              "dangling_dependency",
              `task \`${id}\` depends on \`${dependency}\`, which is not a task in this block`,
              id,
            );
          }
        }
      }
    }
    if (Object.hasOwn(task, "gate") && !GATES.includes(task.gate)) {
      fail(
        "gate",
        `task \`${id}\`: \`gate\` must be ${GATES.join(" or ")}, got ${JSON.stringify(task.gate)}`,
        id,
      );
    }
    if (Object.hasOwn(task, "checks")) {
      const checks = task.checks;
      const valid =
        Array.isArray(checks) &&
        checks.length > 0 &&
        checks.every((check) => typeof check === "string" && check.trim() !== "");
      if (!valid) {
        fail(
          "checks",
          `task \`${id}\`: \`checks\` must be a non-empty list of command strings`,
          id,
        );
      }
    }
  }

  const edges = new Map(
    ids.map((id) => [id, dependenciesOf(spec.tasks[id]).filter((d) => typeof d === "string")]),
  );
  for (const cycle of findCycles(ids, edges)) {
    fail("cycle", `dependency cycle: ${cycle.join(" → ")}`, cycle[0]);
  }

  // `stops:` — the recorded answer per human stop (scripts/forecast.mjs). It is
  // a record, not graph shape: it never reaches the DAG or the shape hash.
  const stops = validateStops(spec);
  errors.push(...stops.errors);
  warnings.push(...stops.warnings);

  if (Object.hasOwn(spec, "waivers")) {
    const waivers = spec.waivers;
    if (!isPlainObject(waivers)) {
      fail("waivers", "`waivers` must be a mapping of task id to the reason its one-way door needs no `gate: before`");
    } else {
      for (const [id, reason] of Object.entries(waivers)) {
        if (!ids.includes(id)) {
          fail("waivers", `waivers: \`${id}\` is not a task in this block`, id);
        } else if (typeof reason !== "string" || reason.trim().length < MIN_WAIVER_REASON) {
          fail("waivers", `waivers: task \`${id}\`: the reason ${JSON.stringify(reason)} is shorter than ${MIN_WAIVER_REASON} characters — say why this door needs no gate`, id);
        }
      }
    }
  }

  if (errors.length === 0) {
    if (Number.isInteger(spec.max_parallel) && spec.max_parallel > ids.length) {
      warn(
        "max_parallel",
        `\`max_parallel\` ${spec.max_parallel} exceeds the ${ids.length} tasks in this epic`,
      );
    }
    const depth = Math.max(0, ...depthsOf(ids, edges).values());
    if (depth >= DEEP_GRAPH_DEPTH) {
      warn(
        "depth",
        `dependency depth ${depth} — a root failure strands its whole subtree; prefer wider, shallower slicing`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
};

// ---------------------------------------------------------------------------
// Graph shape: depth and blast radius
// ---------------------------------------------------------------------------

const byIssueNumber = (a, b) => {
  const left = Number(a);
  const right = Number(b);
  if (Number.isInteger(left) && Number.isInteger(right)) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Pure graph math over `depends_on` — no agent, no tokens. Validate first;
 * this throws rather than guess on a graph that does not hold together.
 *
 * depth = longest dependency chain from a root to this task.
 * blastRadius = how many tasks are stranded if this one fails, i.e. the size of
 *   its transitive dependent set, excluding itself (failure mode 1).
 *
 * @param {object} spec the object from `parseEpicBlock`
 * @returns {{total: number, rows: {id: string, depth: number, blastRadius: number,
 *            total: number, dependsOn: string[], dependents: string[]}[]}}
 * @throws {EpicSpecError} on a dangling reference or a cycle
 */
export const graphMetrics = (spec) => {
  if (!isPlainObject(spec) || !isPlainObject(spec.tasks)) {
    throw new EpicSpecError("`tasks` must be a mapping of issue numbers");
  }
  const ids = Object.keys(spec.tasks).sort(byIssueNumber);
  const edges = new Map(ids.map((id) => [id, dependenciesOf(spec.tasks[id])]));
  for (const id of ids) {
    for (const dependency of edges.get(id)) {
      if (!edges.has(dependency)) {
        throw new EpicSpecError(
          `task \`${id}\` depends on \`${dependency}\`, which is not a task in this block`,
        );
      }
    }
  }
  const cycles = findCycles(ids, edges);
  if (cycles.length > 0) {
    throw new EpicSpecError(`dependency cycle: ${cycles[0].join(" → ")}`);
  }

  const depths = depthsOf(ids, edges);
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dependency of edges.get(id)) dependents.get(dependency).push(id);
  }
  const stranded = (id) => {
    const out = new Set();
    const queue = [...dependents.get(id)];
    while (queue.length > 0) {
      const next = queue.pop();
      if (out.has(next)) continue;
      out.add(next);
      queue.push(...dependents.get(next));
    }
    return [...out].sort(byIssueNumber);
  };

  const rows = ids.map((id) => {
    const downstream = stranded(id);
    return {
      id,
      depth: depths.get(id),
      blastRadius: downstream.length,
      total: ids.length,
      dependsOn: [...edges.get(id)].sort(byIssueNumber),
      dependents: downstream,
    };
  });
  return { total: ids.length, rows };
};

/**
 * Render `graphMetrics` output as the line docs/epic-schema.md quotes:
 * `204: depth 0, blast radius 7 of 8`.
 * @param {{rows: {id: string, depth: number, blastRadius: number, total: number}[]}} metrics
 * @returns {string} one line per task, newline-joined, no trailing newline
 */
export const formatGraphMetrics = (metrics) =>
  metrics.rows
    .map(
      (row) =>
        `${row.id}: depth ${row.depth}, blast radius ${row.blastRadius} of ${row.total}`,
    )
    .join("\n");

// ---------------------------------------------------------------------------
// Rendering the subset back out
// ---------------------------------------------------------------------------

// The inverse of `parseYamlSubset` over the shapes it can read, and it REFUSES
// the rest rather than emitting text that parser would reject. Needed because
// `afk stack detect` proposes a `roles:` block for a human to paste or a skill
// to merge, and hand-built YAML strings drift from the parser they must satisfy.
//
// The contract is one-directional and worth stating exactly: everything this
// emits, `parseYamlSubset` reads back identically. It is NOT total over every
// JS value — the subset has no `null`, no empty mapping, and no mapping inside
// a list, so a tree containing one throws here, naming the path. That is the
// whole point: the alternative is a `roles:` block that looks fine on screen
// and fails at load, which is exactly what a multi-plugin `notes` join did
// before this refusal existed.
//
// Bare strings are the common case and stay unquoted. A string is quoted only
// when leaving it bare would change its meaning on the way back in: empty,
// leading/trailing space, a leading indicator character, an inline `#`, a `: `
// that would read as a mapping, or a word the parser resolves to a scalar.
const YAML_RESERVED = new Set(["true", "false", "null", "~", "yes", "no", "on", "off"]);
const needsQuote = (value) =>
  value === ""
  || /[\n\r\t]/.test(value)
  || value !== value.trim()
  || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
  || value.includes(": ")
  || value.includes(" #")
  || YAML_RESERVED.has(value.toLowerCase())
  || /^-?\d+(\.\d+)?$/.test(value);

const renderScalar = (value, path) => {
  // `null` is not in the subset. Emitting the bare word would parse back as an
  // error, and emitting `""` would silently change the value.
  if (value === null || value === undefined) {
    throw new EpicSpecError(
      `cannot render ${path || "value"}: this YAML subset has no null — omit the key instead`,
    );
  }
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  return needsQuote(text) ? JSON.stringify(text) : text;
};

/**
 * Render a tree as the strict YAML subset `parseYamlSubset` accepts.
 * @param {object|Array|string|number|boolean|null} value
 * @returns {string} newline-terminated YAML, or "" for an empty tree
 */
export const toYamlSubset = (value, indent = 0, path = "") => {
  const pad = " ".repeat(indent);
  const at = (key) => (path ? `${path}.${key}` : String(key));
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item, index) => {
        // `parseSequence` rejects a mapping inside a block list, in either
        // spelling, so there is nothing correct to emit here.
        if (isPlainObject(item) || Array.isArray(item)) {
          throw new EpicSpecError(
            `cannot render ${at(index)}: this YAML subset has no collection inside a list`,
          );
        }
        return `${pad}- ${renderScalar(item, at(index))}\n`;
      })
      .join("");
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      throw new EpicSpecError(
        `cannot render ${path || "the document"}: this YAML subset has no empty mapping — omit the key instead`,
      );
    }
    return keys
      .map((key) => {
        const child = value[key];
        if (Array.isArray(child) && child.length === 0) return `${pad}${key}: []\n`;
        // A short list of plain words goes inline. Block style is correct but
        // unreadable for `always: [implement, karpathy-guidelines]`, and this
        // file is edited by hand. Restricted to items that cannot contain a
        // delimiter, so the flow form round-trips without quoting rules.
        // `needsQuote` still governs: without it `["true"]` renders as
        // `[true]` and parses back as a boolean.
        if (Array.isArray(child)
            && child.every((item) => typeof item === "string" && FLOW_SAFE.test(item) && !needsQuote(item))
            && `${pad}${key}: [${child.join(", ")}]`.length <= INLINE_LIST_WIDTH) {
          return `${pad}${key}: [${child.join(", ")}]\n`;
        }
        if (isPlainObject(child) || Array.isArray(child)) {
          // A sequence sits at the parent's own indent; the parser reads a `- `
          // at the key's column as that key's list.
          const childIndent = Array.isArray(child) ? indent : indent + 2;
          return `${pad}${key}:\n${toYamlSubset(child, childIndent, at(key))}`;
        }
        return `${pad}${key}: ${renderScalar(child, at(key))}\n`;
      })
      .join("");
  }
  return `${pad}${renderScalar(value, path)}\n`;
};
