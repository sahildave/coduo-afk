// scripts/merge-guards.mjs — the merge guardrails (epic #186, #188).
//
// One evaluation of every guardrail an unattended merge or a delegated
// acceptance must clear. Two callers: the Runner at the `awaiting_acceptance`
// park and `afk epic <n> --accept=<id> --delegated` (scripts/auto.mjs), and the
// merge verb (#187). Neither may skip a guardrail; there is no flag for it.
//
// Each guardrail returns `{ name, status: "pass" | "fail" | "wait", evidence }`.
// `wait` is "not decided yet" (a CI check still running) and is never a pass.
//
// Fail direction: CLOSED, every one. A missing or unreadable input — no fixer
// report, a report that is not JSON, no closeout review, no one-way-door globs,
// a `gh` or `git` call that failed — is a `fail` naming the input, never a
// pass and never a throw. The cost of a wrong pass is a merge or a sign-off
// nobody gave; the cost of a wrong fail is a gate that waits for the owner.
//
// `gh` and `git` arrive as injectable runners, the `exec` pattern of
// `findEpicPr` in scripts/pr.mjs: `(command, options) => { status, stdout, stderr }`.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { doorHit } from "./criteria-lints.mjs";
import { checkPaths } from "./epic.mjs";
import { fixerReportPath, needsHuman, readCloseoutGate } from "./fixer.mjs";
import { globToRegExp, isStatusFlushPath, normalizeId, onlyStatusFlushSince, reviewIsCurrentAt, run, shellQuote } from "./lib.mjs";
import { findEpicPr } from "./pr.mjs";
import { readVerifierReport } from "./verifier.mjs";
import { describeWaiver, findingId, ownerCleared, readFates } from "./fate.mjs";

export const MAX_MUST_FIX = 4;
// The screenshot bar (docs/product/chief-of-staff/discussion.md): a baseline
// that moved by more than 1% of its pixels is a change a human looks at.
export const MAX_PIXEL_SHARE = 0.01;

const pass = (name, evidence) => ({ name, status: "pass", evidence });
const fail = (name, evidence) => ({ name, status: "fail", evidence });
const wait = (name, evidence) => ({ name, status: "wait", evidence });
const short = (sha) => (sha ? String(sha).slice(0, 12) : "(none)");

/** Where walkthrough evidence lives; outside the repo and outside `.afk/`. */
export const acceptanceRoot = (env = process.env) =>
  env.AFK_ACCEPTANCE_ROOT || join(homedir(), ".afk-claude", "acceptance");
export const walkthroughDir = ({ root = acceptanceRoot(), repo, epicId, taskId }) =>
  join(root, String(repo).replace("/", "-"), String(epicId), String(taskId));

/** Every guardrail passed. A `wait` is not a pass. */
export const guardsPassed = (guards) => guards.length > 0 && guards.every((guard) => guard.status === "pass");
export const guardsNotPassed = (guards) => guards.filter((guard) => guard.status !== "pass");
export const renderGuard = (guard) => `${guard.status === "pass" ? "✓" : guard.status === "wait" ? "…" : "✗"} ${guard.name}: ${guard.status} — ${guard.evidence}`;

/**
 * The project's one-way-door globs, read off the `oneWayDoors` key the sibling
 * epic's lint declared (scripts/criteria-lints.mjs). Null when undeclared or
 * malformed: the caller fails, because "no doors" cannot be told from "nobody
 * said".
 */
export const doorGlobs = (config) => {
  const doors = config?.oneWayDoors;
  if (!doors || typeof doors !== "object" || Array.isArray(doors)) return null;
  const lists = Object.values(doors);
  if (!lists.length || !lists.every((list) => Array.isArray(list) && list.every((glob) => typeof glob === "string" && glob.trim()))) return null;
  return lists.flat();
};
const matchesAny = (globs, path) => globs.some((glob) => globToRegExp(glob).test(path));

// ---------------------------------------------------------------------------
// PNG: decode 8-bit RGB/RGBA, non-interlaced, with node:zlib only.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (buffer) => Buffer.isBuffer(buffer) && buffer.length > PNG_SIGNATURE.length
  && buffer.subarray(0, 8).equals(PNG_SIGNATURE);

/**
 * @returns {{width: number, height: number, rgba: Buffer}}
 * @throws on anything it does not support, by name
 */
export const decodePng = (buffer) => {
  if (!isPng(buffer)) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("no IHDR chunk");
  if (header.depth !== 8 || ![2, 6].includes(header.colour) || header.interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${header.depth}, colour type ${header.colour}, interlace ${header.interlace})`);
  }
  const channels = header.colour === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < header.height * (stride + 1)) throw new Error("truncated image data");
  const out = Buffer.alloc(header.width * header.height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown filter ${filter}`);
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < header.width; x += 1) {
      const at = (y * header.width + x) * 4;
      out[at] = line[x * channels];
      out[at + 1] = line[x * channels + 1];
      out[at + 2] = line[x * channels + 2];
      out[at + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    previous = line;
  }
  return { width: header.width, height: header.height, rgba: out };
};

/**
 * The share of pixels whose RGBA differs, 0..1. Different dimensions, or a
 * side that will not decode, is `Infinity` — above any bar — with the reason.
 */
export const pngDifference = (before, after) => {
  let a;
  let b;
  try {
    a = decodePng(before);
    b = decodePng(after);
  } catch (error) {
    return { share: Infinity, reason: error.message };
  }
  if (a.width !== b.width || a.height !== b.height) {
    return { share: Infinity, reason: `dimensions changed ${a.width}x${a.height} → ${b.width}x${b.height}` };
  }
  let changed = 0;
  for (let at = 0; at < a.rgba.length; at += 4) {
    if (a.rgba.readUInt32BE(at) !== b.rgba.readUInt32BE(at)) changed += 1;
  }
  const pixels = a.width * a.height;
  return { share: pixels ? changed / pixels : Infinity, changed, pixels, reason: `${changed} of ${pixels} pixels differ` };
};

// ---------------------------------------------------------------------------
// Delegation, recorded at launch
// ---------------------------------------------------------------------------

export const DELEGATE_EVIDENCE = ["walkthrough"];

/**
 * Merge the delegations a launch supplies into the ones state holds. Pure.
 * Additive, like `--instructions`: a new id is added, the same id with the
 * same condition and evidence is a no-op, and the same id with anything
 * different is refused — a restart cannot rewrite what the owner delegated.
 *
 * @param {{id: string, condition: string, evidence?: string|null}[]} supplied
 * @returns {{ok: true, delegations: object, waiver: object|null, added: string[]} | {ok: false, reason: string}}
 */
export const mergeDelegations = ({ dag, supplied = [], existing = {}, waiver = null, existingWaiver = null, inLane = null, at = new Date().toISOString() }) => {
  if ((supplied.length || waiver) && inLane) {
    return { ok: false, reason: `refusing --delegate inside task ${inLane}'s agent environment. A gate is delegated by a human at launch, not by a lane` };
  }
  const delegations = { ...(existing ?? {}) };
  const added = [];
  for (const entry of supplied) {
    const id = normalizeId(entry.id);
    const task = (dag?.tasks ?? []).find((candidate) => candidate.id === id);
    if (!task || !task.gateAfter) {
      return { ok: false, reason: `#${id} is not a \`gate: after\` task in this epic's block; only an acceptance gate can be delegated` };
    }
    const condition = String(entry.condition ?? "").trim();
    if (!condition) return { ok: false, reason: `--delegate=${id} needs --delegate-condition="<text>": the delegate accepts only under a condition the owner wrote` };
    const evidence = entry.evidence ?? null;
    if (evidence !== null && !DELEGATE_EVIDENCE.includes(evidence)) {
      return { ok: false, reason: `--delegate-evidence must be ${DELEGATE_EVIDENCE.join(" or ")}, got "${evidence}"` };
    }
    const held = delegations[id];
    if (held) {
      if (held.condition !== condition || (held.evidence ?? null) !== evidence) {
        return {
          ok: false,
          reason: `#${id} was delegated at launch under "${held.condition}"${held.evidence ? ` with ${held.evidence} evidence` : ""}; a restart cannot change or drop a delegation (supplied "${condition}"${evidence ? ` with ${evidence} evidence` : ""}). Omit --delegate for #${id} to keep it, or reset the run`,
        };
      }
      continue;
    }
    delegations[id] = { condition, evidence, at };
    added.push(id);
  }
  let kept = existingWaiver ?? null;
  if (waiver !== null && waiver !== undefined) {
    const reason = String(waiver).trim();
    if (!reason) return { ok: false, reason: "--waive-user-facing needs a reason" };
    if (kept && kept.reason !== reason) {
      return { ok: false, reason: `the user-facing waiver was recorded at launch as "${kept.reason}"; a restart cannot change it` };
    }
    kept ??= { reason, at };
  }
  return { ok: true, delegations, waiver: kept, added };
};

/** Delegations and the waiver as log lines, for the launch and `afk status`. */
export const renderDelegations = (delegations = {}, waiver = null) => [
  ...Object.entries(delegations ?? {}).map(([id, entry]) =>
    `#${id} delegated at ${entry.at}: "${entry.condition}"${entry.evidence ? ` (needs ${entry.evidence} evidence)` : ""}`),
  ...(waiver ? [`user-facing waiver recorded at ${waiver.at}: "${waiver.reason}"`] : []),
];

// ---------------------------------------------------------------------------
// The guardrails
// ---------------------------------------------------------------------------

/**
 * Evaluate every guardrail. Never throws: a guardrail that throws is a `fail`
 * carrying the error.
 *
 * @param {object} ctx
 * @param {string} ctx.root          the epic's checkout, on its branch
 * @param {string} ctx.epicId
 * @param {string|null} ctx.taskId   the gate being accepted, when there is one
 * @param {object} ctx.state         parsed .afk/state.json
 * @param {object} ctx.config        the loaded project config
 * @param {string} [ctx.base]        the epic's base branch, fetched from `origin`
 * @param {string|null} [ctx.repo]   owner/name; asked of `gh` when absent
 * @param {object|null} [ctx.delegation] `state.delegations[taskId]`
 * @returns {{name: string, status: "pass"|"fail"|"wait", evidence: string}[]}
 */
export const evaluateMergeGuards = (ctx) => {
  const c = withInputs(ctx);
  const guards = [
    ["review-at-head", reviewAtHead],
    ["must-fix-cleared", mustFixCleared],
    ["must-fix-count", mustFixCount],
    ["must-fix-one-way", mustFixOneWay],
    ["ci-green", ciGreen],
    ["trial-merge", trialMerge],
    ["one-way-door-paths", oneWayDoorPaths],
    ["launch-status", launchStatus],
  ];
  if (c.delegation?.evidence === "walkthrough") guards.push(["walkthrough", walkthrough]);
  return guards.map(([name, guard]) => runGuard(name, guard, c));
};

/** One guardrail by name, with the same never-throw wrapper. */
export const evaluateGuard = (name, ctx) => {
  const guard = GUARDS[name];
  if (!guard) throw new Error(`unknown guardrail ${name}`);
  return runGuard(name, guard, withInputs(ctx));
};

const runGuard = (name, guard, c) => {
  try {
    return guard(c);
  } catch (error) {
    return fail(name, `could not evaluate: ${error.message}`);
  }
};

// The inputs, read lazily and once, so a guardrail that never needs `gh` never
// calls it and a test scripts only what the guardrail under test reads.
const withInputs = (ctx) => {
  const git = ctx.git ?? run;
  const gh = ctx.gh ?? run;
  const root = ctx.root;
  const epicId = normalizeId(ctx.epicId ?? ctx.state?.epic?.id ?? null);
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) {
      try {
        memo.set(key, { value: compute() });
      } catch (error) {
        memo.set(key, { error });
      }
    }
    const hit = memo.get(key);
    if (hit.error) throw hit.error;
    return hit.value;
  };
  const gitOk = (command, options = {}) => {
    const result = git(command, { cwd: root, ...options });
    if (result.status !== 0) throw new Error(`\`${command}\` failed: ${String(result.stderr || result.stdout || "").trim().split("\n")[0]}`);
    return result.stdout;
  };
  const c = {
    ...ctx,
    root,
    epicId,
    git,
    gh,
    gitOk,
    base: ctx.base ?? "main",
    close: ctx.state?.epicClose ?? null,
    head: () => once("head", () => String(gitOk("git rev-parse HEAD")).trim()),
    // Fetched once; every guardrail that diffs against the base reads this ref.
    baseRef: () => once("base", () => {
      gitOk(`git fetch --quiet origin ${shellQuote(c.base)}`);
      const ref = `origin/${c.base}`;
      return { ref, sha: String(gitOk(`git rev-parse ${shellQuote(ref)}`)).trim() };
    }),
    diffPaths: () => once("diff", () => String(gitOk(`git diff --no-renames --name-only ${shellQuote(`${c.baseRef().ref}...${c.head()}`)}`))
      .split("\n").map((line) => line.trim()).filter(Boolean)),
    current: (recorded) => onlyStatusFlushSince(root, recorded ?? null, c.head(), isStatusFlushPath, git),
    fixer: () => once("fixer", () => readJson(fixerReportPath(root, epicId), "fixer report")),
    review: () => once("review", () => {
      const report = readVerifierReport(root, epicId);
      if (!report) throw new Error(`no readable closeout review report for epic ${epicId}`);
      return report;
    }),
    gate: () => readCloseoutGate(root, epicId),
    // The fates ledger (#228), read once. An unreadable line throws, so every
    // guard that reads it fails closed naming the line.
    fates: () => once("fates", () => {
      const ledger = readFates(root, epicId);
      if (ledger.problems.length) throw new Error(ledger.problems.join("; "));
      return ledger.fates;
    }),
    repo: () => once("repo", () => {
      if (ctx.repo) return ctx.repo;
      const result = gh("gh repo view --json nameWithOwner -q .nameWithOwner", { cwd: root });
      const name = result.status === 0 ? String(result.stdout).trim() : "";
      if (!name) throw new Error(`gh could not name the repository: ${String(result.stderr ?? "").trim()}`);
      return name;
    }),
  };
  return c;
};

const readJson = (path, what) => {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the ${what} at ${path} is not valid JSON`);
  }
};

const mustFixLines = (review) => (Array.isArray(review?.mustFix) ? review.mustFix.map(String) : []);
const mustFixItems = (fixer) => (fixer?.items ?? []).filter((item) => item?.source === "must-fix");
// A finding the owner accepted or dropped with `afk fate` (#228), matched by
// any of the texts it was raised under.
const ownerWaiver = (fates, ...titles) => titles.flat().filter(Boolean).map((title) => fates.get(findingId(title))).find(ownerCleared) ?? null;
const ownerFated = (fates, ...titles) => Boolean(ownerWaiver(fates, ...titles));
// Every waiver, named in the guard's output so `afk merge` shows the owner each
// finding a fate lifted, who decided and where they said it (#235 S3).
const waivedText = (waivers) => (waivers.length ? `; waived ${waivers.map(describeWaiver).join("; waived ")}` : "");

// 1. The review read the head, or the head moved only by status commits.
const reviewAtHead = (c) => {
  const name = "review-at-head";
  const verifier = c.close?.verifier ?? null;
  if (!verifier) return fail(name, "no closeout review in the run state");
  if (verifier.skipped) return fail(name, `the last closeout review did not run (${verifier.skipped})`);
  const head = c.head();
  const evidence = `review ${short(verifier.head)} at ${verifier.ranAt ?? "time unknown"}, head ${short(head)}`;
  return reviewIsCurrentAt(c.root, verifier, head, c.git)
    ? pass(name, evidence)
    : fail(name, `${evidence}: the head has more than the runner's status commits on top of the review`);
};

// 2. No must-fix left open after the fixer, and its gate green at the head.
const mustFixCleared = (c) => {
  const name = "must-fix-cleared";
  let fixer;
  try {
    fixer = c.fixer();
  } catch (error) {
    return fail(name, error.message);
  }
  if (!["ok", "nothing_to_do"].includes(fixer?.status)) {
    return fail(name, `the fix pass did not complete (status ${JSON.stringify(fixer?.status ?? null)})`);
  }
  const verifier = c.close?.verifier ?? null;
  if (!verifier) return fail(name, "no closeout review in the run state, so the fixer's report answers nothing");
  // The re-review `afk close --redo` runs after the one fix pass (#235 S7): no
  // fixer answers it, so its own must-fix lines are judged against the fates.
  // Only a review close.mjs marked as that; any other mismatch is stale.
  if (verifier.afterFixPass === true && (fixer.reviewHead ?? null) !== (verifier.head ?? null)) {
    let review;
    let fates;
    try {
      review = c.review();
      fates = c.fates();
    } catch (error) {
      return fail(name, error.message);
    }
    if ((review.head ?? null) !== (verifier.head ?? null)) return fail(name, `the review report on disk is of ${short(review.head)}, not the stored review of ${short(verifier.head)}`);
    const lines = mustFixLines(review);
    const waivers = lines.map((line) => ownerWaiver(fates, line)).filter(Boolean);
    const open = lines.filter((line) => !ownerWaiver(fates, line));
    const counts = `re-review of ${short(verifier.head)} after the one fix pass: ${lines.length} must-fix, ${waivers.length} accepted or dropped by the owner${waivedText(waivers)}`;
    if (open.length) {
      return fail(name, `${counts}: still open — ${open.map((line) => `${line} [${findingId(line)}]`).join("; ")}. No second fix pass runs; record its fate: \`afk fate ${c.epicId} <finding> --accepted|--fixed|--dropped --reason="<why, with the link to your comment>" --by=owner\``);
    }
    return pass(name, counts);
  }
  if ((fixer.reviewHead ?? null) !== (verifier.head ?? null)) {
    return fail(name, `the fixer answered the review of ${short(fixer.reviewHead)}, not the stored review of ${short(verifier.head)}`);
  }
  let fates;
  try {
    fates = c.fates();
  } catch (error) {
    return fail(name, error.message);
  }
  const items = mustFixItems(fixer);
  const ids = new Set(items.map((item) => String(item.id)));
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const open = needsHuman(fixer).filter((entry) => ids.has(String(entry.id)));
  const waiverOf = (entry) => ownerWaiver(fates, entry.title, byId.get(String(entry.id))?.title, byId.get(String(entry.id))?.aliases ?? []);
  const decided = open.filter(waiverOf);
  const waived = waivedText(decided.map(waiverOf));
  const left = open.filter((entry) => !decided.includes(entry));
  const fixed = (fixer.fixed ?? []).filter((entry) => ids.has(String(entry.id)));
  const gate = c.gate();
  const gateText = gate ? `gate ${gate.status} at ${short(gate.head)}` : "no fix gate recorded";
  const fated = decided.length ? ` (${decided.length} accepted or dropped by the owner)` : "";
  const counts = `found ${items.length}, fixed ${fixed.length}, left ${left.length}${fated}; ${gateText}${waived}`;
  if (left.length) {
    const named = left.map((entry) => `${entry.title} [${findingId(entry.title)}]`).join("; ");
    return fail(name, `${counts}: still open — ${named}. Fix it, or record its fate: \`afk fate ${c.epicId} <finding> --accepted|--fixed|--dropped --reason="<why, with the link to your comment>" --by=owner\``);
  }
  if (!gate) return fail(name, counts);
  if (!["passed", "no_commit"].includes(gate.status)) return fail(name, `${counts}: the fix gate is not green`);
  if (!c.current(gate.head)) return fail(name, `${counts}: the gate ran at ${short(gate.head)}, and the head ${short(c.head())} has moved past it`);
  return pass(name, counts);
};

// 3. Four or fewer must-fix items.
const mustFixCount = (c) => {
  const name = "must-fix-count";
  if (!c.close?.verifier) return fail(name, "no closeout review in the run state");
  let review;
  try {
    review = c.review();
  } catch (error) {
    return fail(name, error.message);
  }
  let fates;
  try {
    fates = c.fates();
  } catch (error) {
    return fail(name, error.message);
  }
  const lines = mustFixLines(review);
  const count = lines.filter((line) => !ownerFated(fates, line)).length;
  const fated = lines.length - count ? `, ${lines.length - count} more accepted or dropped by the owner${waivedText(lines.map((line) => ownerWaiver(fates, line)).filter(Boolean))}` : "";
  return count <= MAX_MUST_FIX
    ? pass(name, `${count} must-fix item(s)${fated}`)
    : fail(name, `${count} must-fix items, above ${MAX_MUST_FIX}, the owner decides`);
};

// 4. No must-fix, fixed or open, touches a one-way door.
const mustFixOneWay = (c) => {
  const name = "must-fix-one-way";
  const globs = doorGlobs(c.config);
  if (!globs) return fail(name, "no one-way doors declared, cannot tell");
  let review;
  let fixer;
  try {
    review = c.review();
    fixer = c.fixer();
  } catch (error) {
    return fail(name, error.message);
  }
  const files = new Set();
  const fixedById = new Map((fixer.fixed ?? []).map((entry) => [String(entry.id), entry]));
  for (const line of mustFixLines(review)) {
    for (const path of checkPaths(line)) files.add(path);
    for (const item of mustFixItems(fixer)) {
      if (item.title !== line && !(item.aliases ?? []).includes(line)) continue;
      for (const path of fixedById.get(String(item.id))?.files ?? []) files.add(path);
    }
  }
  const hits = [...files].filter((path) => globs.some((glob) => doorHit(glob, path)));
  return hits.length
    ? fail(name, `a must-fix item names ${hits.join(", ")}, behind a one-way door`)
    : pass(name, `none of ${files.size} file(s)`);
};

const CHECK_PASS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const CHECK_WAIT = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);

// 5. Every check on the PR concluded success, skipped or neutral.
const ciGreen = (c) => {
  const name = "ci-green";
  const repo = c.repo();
  const branch = c.state?.branch ?? String(c.gitOk("git rev-parse --abbrev-ref HEAD")).trim();
  const pr = findEpicPr({ repo, branch, exec: c.gh, cwd: c.root });
  if (!pr) return fail(name, `no pull request for ${branch}`);
  const result = c.gh(`gh pr checks ${shellQuote(String(pr.number))} --repo ${shellQuote(repo)} --json name,state`, { cwd: c.root });
  let checks;
  try {
    checks = JSON.parse(String(result.stdout ?? "").trim() || "null");
  } catch {
    checks = null;
  }
  // `gh pr checks` exits non-zero while a check is pending or failed, with the
  // JSON still on stdout; with none at all it says so on stderr.
  if (!Array.isArray(checks)) {
    if (/no checks reported/i.test(`${result.stderr ?? ""}${result.stdout ?? ""}`)) checks = [];
    else return fail(name, `gh could not list the checks on PR #${pr.number}: ${String(result.stderr ?? "").trim() || "no output"}`);
  }
  if (!checks.length) {
    if (c.config?.merge?.ci !== "none") return fail(name, `PR #${pr.number} has zero checks (set \`merge.ci: none\` if this project has no CI)`);
    const gate = c.gate();
    const baseline = c.state?.lastGreenBaseline ?? null;
    if (gate?.status === "passed" && c.current(gate.head)) return pass(name, `zero checks, \`merge.ci: none\`; the fix gate passed at ${short(gate.head)}`);
    if (baseline?.headSha && c.current(baseline.headSha)) return pass(name, `zero checks, \`merge.ci: none\`; the baseline passed at ${short(baseline.headSha)}`);
    return fail(name, `zero checks, \`merge.ci: none\`, and no green gate recorded at the head ${short(c.head())}`);
  }
  const listed = checks.map((check) => `${check.name}: ${String(check.state).toLowerCase()}`).join(", ");
  const states = checks.map((check) => String(check.state ?? "").toUpperCase());
  if (states.some((state) => !CHECK_PASS.has(state) && !CHECK_WAIT.has(state))) return fail(name, listed);
  if (states.some((state) => CHECK_WAIT.has(state))) return wait(name, listed);
  return pass(name, listed);
};

// 6. The base merges into the head without a conflict, in a throwaway worktree.
const trialMerge = (c) => {
  const name = "trial-merge";
  const { ref, sha } = c.baseRef();
  const head = c.head();
  const dir = mkdtempSync(join(tmpdir(), "afk-trial-merge-"));
  const evidence = `base ${short(sha)}, head ${short(head)}`;
  let added = false;
  try {
    c.gitOk(`git worktree add --detach ${shellQuote(dir)} ${shellQuote(head)}`);
    added = true;
    const merged = c.git(
      `git -c user.name=afk -c user.email=afk@localhost merge --no-commit --no-ff ${shellQuote(ref)}`,
      { cwd: dir },
    );
    if (merged.status === 0) return pass(name, `${evidence}: merges cleanly`);
    const conflicted = String(c.git("git diff --name-only --diff-filter=U", { cwd: dir }).stdout ?? "")
      .split("\n").map((line) => line.trim()).filter(Boolean);
    return fail(name, conflicted.length
      ? `${evidence}: conflict in ${conflicted.join(", ")}`
      : `${evidence}: the merge failed — ${String(merged.stderr || merged.stdout).trim().split("\n")[0]}`);
  } finally {
    if (added) {
      c.git("git merge --abort", { cwd: dir });
      c.git(`git worktree remove --force ${shellQuote(dir)}`, { cwd: c.root });
    }
    rmSync(dir, { recursive: true, force: true });
    c.git("git worktree prune", { cwd: c.root });
  }
};

// 7. No changed path behind a one-way door.
const oneWayDoorPaths = (c) => {
  const name = "one-way-door-paths";
  const globs = doorGlobs(c.config);
  if (!globs) return fail(name, "no one-way doors declared, cannot tell");
  const paths = c.diffPaths();
  const hits = paths.filter((path) => globs.some((glob) => doorHit(glob, path)));
  return hits.length
    ? fail(name, `behind a one-way door: ${hits.join(", ")}`)
    : pass(name, `none of ${paths.length} changed path(s)`);
};

// 8. Pre-launch, or launched under the user-facing rule with a health probe.
const launchStatus = (c) => {
  const name = "launch-status";
  const status = c.config?.launchStatus;
  if (status === undefined || status === null) return fail(name, "`launchStatus` is not declared");
  if (status === "pre-launch") return pass(name, "pre-launch");
  if (status !== "launched") return fail(name, `\`launchStatus: ${status}\` is neither pre-launch nor launched`);
  const merge = c.config?.merge ?? {};
  if (!merge.healthProbe) return fail(name, "launched, and no `merge.healthProbe` is declared");
  if (!Array.isArray(merge.userFacing) || !merge.userFacing.length) return fail(name, "launched, and no `merge.userFacing` is declared");
  const facing = c.diffPaths().filter((path) => matchesAny(merge.userFacing, path));
  // (a) nothing a user sees changed.
  if (!facing.length) return pass(name, "launched; no changed path is user-facing");
  // (b) every user-facing change is a screenshot baseline that moved by 1% or less.
  const baselines = Array.isArray(merge.screenshotBaselines) ? merge.screenshotBaselines : [];
  const problems = [];
  const measured = [];
  for (const path of facing) {
    if (!matchesAny(baselines, path)) {
      problems.push(`${path} is user-facing and not a screenshot baseline`);
      continue;
    }
    // A real screenshot is well over spawnSync's 1 MB default buffer.
    const show = (ref) => c.git(`git show ${shellQuote(`${ref}:${path}`)}`, { cwd: c.root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    const before = show(c.baseRef().ref);
    const after = show(c.head());
    const broken = before.error ?? after.error;
    if (broken) {
      problems.push(`${path}: git show failed (${broken.code ?? broken.message})`);
      continue;
    }
    if (before.status !== 0 || after.status !== 0) {
      problems.push(`${path} is ${before.status !== 0 ? "a new" : "a deleted"} baseline`);
      continue;
    }
    const diff = pngDifference(Buffer.from(before.stdout), Buffer.from(after.stdout));
    if (!(diff.share <= MAX_PIXEL_SHARE)) problems.push(`${path}: ${diff.reason}, above 1%`);
    else measured.push(`${path}: ${diff.reason}`);
  }
  if (!problems.length) return pass(name, `launched; every user-facing change is a baseline within 1% (${measured.join("; ")})`);
  // (c) a human waived it at launch.
  const waiver = c.waiver ?? c.state?.userFacingWaiver ?? null;
  if (waiver?.reason) return pass(name, `launched; user-facing change waived at launch: "${waiver.reason}"`);
  return fail(name, `launched; ${problems.join("; ")}`);
};

// 9. The walkthrough evidence matches the gate's checklist, step for step.
const walkthrough = (c) => {
  const name = "walkthrough";
  if (!c.taskId) return fail(name, "no gate task to read a walkthrough for");
  const dir = walkthroughDir({ root: c.acceptanceRoot ?? acceptanceRoot(), repo: c.repo(), epicId: c.epicId, taskId: c.taskId });
  let record;
  try {
    record = readJson(join(dir, "walkthrough.json"), "walkthrough record");
  } catch (error) {
    return fail(name, error.message);
  }
  const issue = c.gh(`gh issue view ${shellQuote(String(c.taskId))} --repo ${shellQuote(c.repo())} --json body`, { cwd: c.root });
  if (issue.status !== 0) return fail(name, `gh could not read #${c.taskId}: ${String(issue.stderr ?? "").trim()}`);
  const body = JSON.parse(String(issue.stdout || "{}")).body ?? "";
  const checklist = String(body).split("\n")
    .map((line) => /^\s*- \[ \]\s?(.*)$/.exec(line)?.[1]).filter((item) => item !== undefined).map((item) => item.trim());
  if (!checklist.length) return fail(name, `#${c.taskId} has no \`- [ ]\` checklist line to walk through`);
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const counts = `${dir}: ${steps.length} step(s), ${checklist.length} checklist item(s)`;
  const problems = [];
  if (record.schema !== 1) problems.push(`schema is ${JSON.stringify(record.schema)}, not 1`);
  if (String(record.epic) !== String(c.epicId)) problems.push(`epic is ${record.epic}, not ${c.epicId}`);
  if (String(record.task) !== String(c.taskId)) problems.push(`task is ${record.task}, not ${c.taskId}`);
  if (!c.current(record.head)) problems.push(`recorded at ${short(record.head)}, and the head ${short(c.head())} has moved past it`);
  if (steps.length !== checklist.length) problems.push(`${steps.length} step(s) for ${checklist.length} checklist item(s)`);
  const hashes = new Map();
  steps.forEach((step, index) => {
    const label = `step ${index + 1}`;
    if (index < checklist.length && String(step?.item ?? "").trim() !== checklist[index]) {
      problems.push(`${label}'s item "${String(step?.item ?? "").trim()}" is not the checklist's "${checklist[index]}"`);
    }
    if (!String(step?.observed ?? "").trim()) problems.push(`${label} records nothing observed`);
    const file = String(step?.screenshot ?? "");
    const path = join(dir, file);
    if (!file || file.includes("/") || !existsSync(path) || !statSync(path).isFile()) {
      problems.push(`${label}'s screenshot ${file || "(none)"} is not in ${dir}`);
      return;
    }
    const bytes = readFileSync(path);
    if (!isPng(bytes)) {
      problems.push(`${label}'s ${file} is not a PNG`);
      return;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hashes.has(hash)) problems.push(`${label}'s ${file} is the same image as ${hashes.get(hash)}`);
    else hashes.set(hash, file);
  });
  return problems.length ? fail(name, `${counts}: ${problems.join("; ")}`) : pass(name, counts);
};

const GUARDS = {
  "review-at-head": reviewAtHead,
  "must-fix-cleared": mustFixCleared,
  "must-fix-count": mustFixCount,
  "must-fix-one-way": mustFixOneWay,
  "ci-green": ciGreen,
  "trial-merge": trialMerge,
  "one-way-door-paths": oneWayDoorPaths,
  "launch-status": launchStatus,
  walkthrough,
};

