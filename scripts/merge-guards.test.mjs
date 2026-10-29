// The merge guardrails and delegated acceptance (#188).
//
// No test here calls GitHub: `gh` is `fakeGh`, which throws on any command the
// test did not script. `git` is real, against throwaway repositories with a
// local bare `origin`, so `trial-merge` merges for real but never anywhere that
// matters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  decodePng,
  evaluateGuard,
  evaluateMergeGuards,
  guardsPassed,
  mergeDelegations,
  pngDifference,
  walkthroughDir,
} from "./merge-guards.mjs";
import { closeoutGatePath, fixerReportPath } from "./fixer.mjs";
import { verifierReportPath } from "./verifier.mjs";
import { loadConfig } from "./lib.mjs";
import { parseDelegateFlags } from "./epic.mjs";
import { runAuto } from "./auto.mjs";
import { freePort } from "./free-port.mjs";
import { readConfig, writeConfig } from "./test-helpers.mjs";

// Run on its own (`node --test scripts/merge-guards.test.mjs`), the runs below
// would put lanes and role checkouts under the real ~/code/worktrees (#235 S6).
// `afk selftest` sets both roots; this does the same when they are unset.
process.env.AFK_WORKTREE_ROOT ??= mkdtempSync(join(tmpdir(), "afk-guards-worktrees-"));
process.env.AFK_EPIC_ROOT ??= join(process.env.AFK_WORKTREE_ROOT, "epics");

const EPIC = "186";
const GATE = "999";
const REPO = "acme/app";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A PNG, filter 0, 8-bit RGBA. `pixel(x, y)` returns [r, g, b, a]. */
const encodePng = (width, height, pixel = () => [255, 255, 255, 255]) => {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])));
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < width; x += 1) rows.push(Buffer.from(pixel(x, y)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
/** 20×20 white with the first `n` pixels black. */
const changedPng = (n, size = 20) => encodePng(size, size, (x, y) => (y * size + x < n ? [0, 0, 0, 255] : [255, 255, 255, 255]));

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const commit = (root, files, message) => {
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/**
 * A checkout on branch `feat` with a bare `origin` holding `main`. `baseFiles`
 * land on main, `headFiles` on feat, `mainAfter` on origin's main after feat
 * branched (the trial merge's other side).
 */
const makeRepo = ({ baseFiles = {}, headFiles = { "src/app.js": "export const app = 1;\n" }, mainAfter = null } = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "afk-merge-guards-")));
  const origin = join(dir, "origin.git");
  const root = join(dir, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "runner@example.test");
  git(root, "config", "user.name", "Runner Test");
  git(root, "remote", "add", "origin", origin);
  const base = commit(root, { ".gitignore": ".afk/\n", "README.md": "base\n", "shared.txt": "base\n", ...baseFiles }, "base");
  git(root, "push", "-q", "origin", "main");
  if (mainAfter) {
    commit(root, mainAfter, "main moved");
    git(root, "push", "-q", "origin", "main");
    git(root, "reset", "-q", "--hard", base);
  }
  git(root, "checkout", "-q", "-b", "feat");
  const head = commit(root, headFiles, "feature");
  return { dir, root, base, head };
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

/** The review, the fixer's report and its gate, all at `head`. */
const writeCloseout = (root, head, { mustFix = ["src/app.js returns the wrong value"], fixed = null, left = [], gate = "no_commit" } = {}) => {
  writeJson(verifierReportPath(root, EPIC), {
    version: 1, status: "ok", head, ranAt: "2026-10-05T01:00:00.000Z", mustFix, findings: [], criteria: [],
  });
  const items = mustFix.map((title, index) => ({ id: `F${index + 1}`, source: "must-fix", title }));
  const fixedEntries = fixed ?? items.filter((item) => !left.includes(item.title)).map((item) => ({ id: item.id, title: item.title, detail: "fixed", files: ["src/app.js"] }));
  writeJson(fixerReportPath(root, EPIC), {
    version: 1, status: "ok", head, reviewHead: head, items,
    fixed: fixedEntries,
    deferred: items.filter((item) => left.includes(item.title)).map((item) => ({ id: item.id, title: item.title, reason: "could not reproduce it", kind: "open" })),
  });
  if (gate) writeJson(closeoutGatePath(root, EPIC), { status: gate, head, headBefore: head, fixSha: gate === "passed" ? head : null, checks: ["true"], ranAt: "2026-10-05T01:05:00.000Z" });
};

const stateAt = (head, extra = {}) => ({
  branch: "feat",
  epic: { id: EPIC },
  epicClose: { verifier: { head, ranAt: "2026-10-05T01:00:00.000Z", recommendation: "must-fix" } },
  ...extra,
});

const DOORS = { oneWayDoors: { migrations: ["migrations/**"] } };

/** A `gh` that answers only what the test scripted, and throws on anything else. */
const fakeGh = (script = []) => {
  const calls = [];
  const gh = (command) => {
    calls.push(command);
    const hit = script.find(([pattern]) => pattern.test(command));
    if (!hit) throw new Error(`unscripted gh call: ${command}`);
    const answer = typeof hit[1] === "function" ? hit[1](command) : hit[1];
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  gh.calls = calls;
  return gh;
};
const prList = [/^gh pr list/, { stdout: JSON.stringify([{ number: 42, state: "OPEN", isDraft: true }]) }];
const checks = (rows, extra = {}) => [/^gh pr checks/, { stdout: JSON.stringify(rows), ...extra }];

const ctxFor = (fx, extra = {}) => ({
  root: fx.root,
  epicId: EPIC,
  taskId: GATE,
  state: stateAt(fx.head),
  config: { ...DOORS, launchStatus: "pre-launch" },
  base: "main",
  repo: REPO,
  gh: fakeGh(),
  ...extra,
});
const guard = (name, fx, extra) => evaluateGuard(name, ctxFor(fx, extra));
const cleanup = (fx) => rmSync(fx.dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 1. review-at-head
// ---------------------------------------------------------------------------

test("review-at-head passes over the head or status commits, fails on a real commit or no review", () => {
  const fx = makeRepo();
  try {
    commit(fx.root, { "docs/progress.md": "# progress\n" }, "afk: update task status");
    const ok = guard("review-at-head", fx);
    assert.equal(ok.status, "pass", ok.evidence);
    assert.match(ok.evidence, new RegExp(`review ${fx.head.slice(0, 12)}`));

    commit(fx.root, { "src/app.js": "export const app = 2;\n" }, "a real change");
    const moved = guard("review-at-head", fx);
    assert.equal(moved.status, "fail");
    assert.match(moved.evidence, /more than the runner's status commits/);

    const none = guard("review-at-head", fx, { state: { branch: "feat" } });
    assert.equal(none.status, "fail");
    assert.match(none.evidence, /no closeout review in the run state/);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 2. must-fix-cleared
// ---------------------------------------------------------------------------

test("must-fix-cleared passes when the fixer left nothing and its gate is green at the head", () => {
  const fx = makeRepo();
  try {
    writeCloseout(fx.root, fx.head);
    const ok = guard("must-fix-cleared", fx);
    assert.equal(ok.status, "pass", ok.evidence);
    assert.match(ok.evidence, /found 1, fixed 1, left 0; gate no_commit/);

    writeCloseout(fx.root, fx.head, { mustFix: ["src/app.js is wrong", "README.md is stale"], left: ["README.md is stale"] });
    const open = guard("must-fix-cleared", fx);
    assert.equal(open.status, "fail");
    assert.match(open.evidence, /left 1.*still open — README\.md is stale/);

    writeCloseout(fx.root, fx.head, { gate: "failed" });
    const red = guard("must-fix-cleared", fx);
    assert.equal(red.status, "fail");
    assert.match(red.evidence, /fix gate is not green/);
  } finally {
    cleanup(fx);
  }
});

// The four missing-input cases the ticket names: each fails the guardrail that
// reads it, and none throws.
test("a missing fixer report, an unparseable one, no review, and no door globs each fail without throwing", () => {
  const fx = makeRepo();
  try {
    writeCloseout(fx.root, fx.head);
    rmSync(fixerReportPath(fx.root, EPIC));
    const missing = guard("must-fix-cleared", fx);
    assert.equal(missing.status, "fail");
    assert.match(missing.evidence, /no fixer report at/);
    assert.equal(guard("must-fix-one-way", fx).status, "fail");

    writeFileSync(fixerReportPath(fx.root, EPIC), "{ not json");
    const garbled = guard("must-fix-cleared", fx);
    assert.equal(garbled.status, "fail");
    assert.match(garbled.evidence, /is not valid JSON/);

    writeCloseout(fx.root, fx.head);
    for (const name of ["review-at-head", "must-fix-count"]) {
      const result = guard(name, fx, { state: { branch: "feat" } });
      assert.equal(result.status, "fail", name);
      assert.match(result.evidence, /no closeout review in the run state/, name);
    }

    for (const name of ["must-fix-one-way", "one-way-door-paths"]) {
      const result = guard(name, fx, { config: { launchStatus: "pre-launch" } });
      assert.equal(result.status, "fail", name);
      assert.match(result.evidence, /no one-way doors declared, cannot tell/, name);
    }
    // And the whole evaluation, with every input missing, returns rather than
    // throws. `trial-merge` reads only git, which is present, so it may pass.
    const all = evaluateMergeGuards({ root: fx.root, epicId: EPIC, state: {}, config: {}, gh: fakeGh() });
    assert.equal(all.length, 8);
    const readers = all.filter((result) => result.name !== "trial-merge");
    assert.ok(readers.every((result) => result.status === "fail"), JSON.stringify(all, null, 1));
    assert.match(all.find((result) => result.name === "ci-green").evidence, /unscripted gh call/);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 3. must-fix-count
// ---------------------------------------------------------------------------

test("must-fix-count passes at 4 and fails at 5 with the owner deciding", () => {
  const fx = makeRepo();
  try {
    writeCloseout(fx.root, fx.head, { mustFix: ["a", "b", "c", "d"] });
    assert.equal(guard("must-fix-count", fx).status, "pass");
    writeCloseout(fx.root, fx.head, { mustFix: ["a", "b", "c", "d", "e"] });
    const over = guard("must-fix-count", fx);
    assert.equal(over.status, "fail");
    assert.equal(over.evidence, "5 must-fix items, above 4, the owner decides");
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 4. must-fix-one-way
// ---------------------------------------------------------------------------

test("must-fix-one-way fails on a door named by the line or by the fixer's files", () => {
  const fx = makeRepo();
  try {
    writeCloseout(fx.root, fx.head, { mustFix: ["src/app.js returns the wrong value"] });
    const ok = guard("must-fix-one-way", fx);
    assert.equal(ok.status, "pass", ok.evidence);
    assert.equal(ok.evidence, "none of 2 file(s)".replace("2", "1"));

    writeCloseout(fx.root, fx.head, { mustFix: ["migrations/002_users.sql drops a column"] });
    const named = guard("must-fix-one-way", fx);
    assert.equal(named.status, "fail");
    assert.match(named.evidence, /migrations\/002_users\.sql/);

    writeCloseout(fx.root, fx.head, {
      mustFix: ["the user count is wrong"],
      fixed: [{ id: "F1", title: "the user count is wrong", files: ["src/count.js", "migrations/003_fix.sql"] }],
    });
    const viaFixer = guard("must-fix-one-way", fx);
    assert.equal(viaFixer.status, "fail");
    assert.match(viaFixer.evidence, /migrations\/003_fix\.sql/);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 5. ci-green
// ---------------------------------------------------------------------------

test("ci-green: success passes, a running check waits, a failed one fails, zero checks fail", () => {
  const fx = makeRepo();
  try {
    const green = guard("ci-green", fx, { gh: fakeGh([prList, checks([{ name: "test", state: "SUCCESS" }, { name: "lint", state: "SKIPPED" }])]) });
    assert.equal(green.status, "pass", green.evidence);
    assert.equal(green.evidence, "test: success, lint: skipped");

    const running = guard("ci-green", fx, { gh: fakeGh([prList, checks([{ name: "test", state: "IN_PROGRESS" }], { status: 8 })]) });
    assert.equal(running.status, "wait");
    assert.match(running.evidence, /test: in_progress/);
    assert.equal(guardsPassed([running]), false, "a wait is never a pass");

    const red = guard("ci-green", fx, { gh: fakeGh([prList, checks([{ name: "test", state: "FAILURE" }, { name: "lint", state: "PENDING" }], { status: 1 })]) });
    assert.equal(red.status, "fail");
    assert.match(red.evidence, /test: failure/);

    const zero = guard("ci-green", fx, { gh: fakeGh([prList, [/^gh pr checks/, { status: 1, stdout: "", stderr: "no checks reported on the 'feat' branch" }]]) });
    assert.equal(zero.status, "fail");
    assert.match(zero.evidence, /zero checks/);
  } finally {
    cleanup(fx);
  }
});

test("ci-green: zero checks with `merge.ci: none` passes on a green gate at the head, and fails without one", () => {
  const fx = makeRepo();
  try {
    const none = { ...DOORS, launchStatus: "pre-launch", merge: { ci: "none" } };
    const gh = () => fakeGh([prList, checks([])]);
    const noGate = guard("ci-green", fx, { config: none, gh: gh() });
    assert.equal(noGate.status, "fail");
    assert.match(noGate.evidence, /no green gate recorded at the head/);

    writeCloseout(fx.root, fx.head, { gate: "passed" });
    const viaGate = guard("ci-green", fx, { config: none, gh: gh() });
    assert.equal(viaGate.status, "pass", viaGate.evidence);
    assert.match(viaGate.evidence, /fix gate passed/);

    rmSync(closeoutGatePath(fx.root, EPIC));
    const viaBaseline = guard("ci-green", fx, { config: none, gh: gh(), state: stateAt(fx.head, { lastGreenBaseline: { headSha: fx.head, commands: ["true"] } }) });
    assert.equal(viaBaseline.status, "pass", viaBaseline.evidence);
    assert.match(viaBaseline.evidence, /baseline passed/);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 6. trial-merge
// ---------------------------------------------------------------------------

const worktrees = (root) => git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

test("trial-merge passes a clean merge, fails a conflict by path, and leaves no worktree either way", () => {
  const clean = makeRepo({ mainAfter: { "README.md": "main moved on\n" } });
  const clash = makeRepo({ headFiles: { "shared.txt": "feature side\n" }, mainAfter: { "shared.txt": "main side\n" } });
  try {
    const ok = guard("trial-merge", clean);
    assert.equal(ok.status, "pass", ok.evidence);
    assert.match(ok.evidence, /merges cleanly/);
    assert.equal(worktrees(clean.root), 1, "the trial worktree was left behind");

    const conflict = guard("trial-merge", clash);
    assert.equal(conflict.status, "fail");
    assert.match(conflict.evidence, /conflict in shared\.txt/);
    assert.equal(worktrees(clash.root), 1, "the trial worktree was left behind after a conflict");
    // The checkout itself was never touched.
    assert.equal(readFileSync(join(clash.root, "shared.txt"), "utf8"), "feature side\n");
    assert.equal(git(clash.root, "status", "--porcelain"), "");
  } finally {
    cleanup(clean);
    cleanup(clash);
  }
});

// ---------------------------------------------------------------------------
// 7. one-way-door-paths
// ---------------------------------------------------------------------------

test("one-way-door-paths fails on a changed path behind a door, naming it", () => {
  const safe = makeRepo();
  const door = makeRepo({ headFiles: { "src/app.js": "x\n", "migrations/004_add.sql": "create table t();\n" } });
  try {
    const ok = guard("one-way-door-paths", safe);
    assert.equal(ok.status, "pass", ok.evidence);
    assert.equal(ok.evidence, "none of 1 changed path(s)");
    const hit = guard("one-way-door-paths", door);
    assert.equal(hit.status, "fail");
    assert.equal(hit.evidence, "behind a one-way door: migrations/004_add.sql");
  } finally {
    cleanup(safe);
    cleanup(door);
  }
});

// ---------------------------------------------------------------------------
// 8. launch-status and the user-facing rule
// ---------------------------------------------------------------------------

const launched = (merge = {}) => ({
  ...DOORS,
  launchStatus: "launched",
  merge: { healthProbe: "curl -fsS localhost/health", userFacing: ["ui/**"], screenshotBaselines: ["ui/baselines/**"], ...merge },
});

test("launch-status: pre-launch passes; undeclared, unknown, or launched without a probe or userFacing fails", () => {
  const fx = makeRepo();
  try {
    assert.equal(guard("launch-status", fx).status, "pass");
    const cases = [
      [{ ...DOORS }, /`launchStatus` is not declared/],
      [{ ...DOORS, launchStatus: "beta" }, /neither pre-launch nor launched/],
      [{ ...DOORS, launchStatus: "launched", merge: { userFacing: ["ui/**"] } }, /no `merge.healthProbe`/],
      [{ ...DOORS, launchStatus: "launched", merge: { healthProbe: "true" } }, /no `merge.userFacing` is declared/],
    ];
    for (const [config, cause] of cases) {
      const result = guard("launch-status", fx, { config });
      assert.equal(result.status, "fail", JSON.stringify(config));
      assert.match(result.evidence, cause);
    }
  } finally {
    cleanup(fx);
  }
});

test("the user-facing rule: (a) nothing user-facing, (b) baselines within 1%, (c) a waiver", () => {
  const baseline = { "ui/baselines/home.png": changedPng(0) };
  const untouched = makeRepo({ baseFiles: baseline });
  const onePixel = makeRepo({ baseFiles: baseline, headFiles: { "ui/baselines/home.png": changedPng(1) } });
  const fivePixels = makeRepo({ baseFiles: baseline, headFiles: { "ui/baselines/home.png": changedPng(5) } });
  const resized = makeRepo({ baseFiles: baseline, headFiles: { "ui/baselines/home.png": changedPng(0, 21) } });
  const screen = makeRepo({ headFiles: { "ui/screens/home.tsx": "export default 1;\n" } });
  try {
    const a = guard("launch-status", untouched, { config: launched() });
    assert.equal(a.status, "pass", a.evidence);
    assert.match(a.evidence, /no changed path is user-facing/);

    const b = guard("launch-status", onePixel, { config: launched() });
    assert.equal(b.status, "pass", b.evidence);
    assert.match(b.evidence, /1 of 400 pixels differ/);

    const over = guard("launch-status", fivePixels, { config: launched() });
    assert.equal(over.status, "fail");
    assert.match(over.evidence, /ui\/baselines\/home\.png: 5 of 400 pixels differ, above 1%/);

    const dims = guard("launch-status", resized, { config: launched() });
    assert.equal(dims.status, "fail");
    assert.match(dims.evidence, /dimensions changed 20x20 → 21x21/);

    const notBaseline = guard("launch-status", screen, { config: launched() });
    assert.equal(notBaseline.status, "fail");
    assert.match(notBaseline.evidence, /ui\/screens\/home\.tsx is user-facing and not a screenshot baseline/);

    const waived = guard("launch-status", screen, {
      config: launched(),
      state: stateAt(screen.head, { userFacingWaiver: { reason: "copy change the owner approved in review", at: "2026-10-05T00:00:00Z" } }),
    });
    assert.equal(waived.status, "pass", waived.evidence);
    assert.match(waived.evidence, /copy change the owner approved in review/);
  } finally {
    for (const fx of [untouched, onePixel, fivePixels, resized, screen]) cleanup(fx);
  }
});

test("the user-facing rule measures a baseline larger than spawnSync's 1 MB default buffer", () => {
  // 700×700 of noise deflates to about 2 MB; one pixel moves in the head.
  const noise = (moved) => encodePng(700, 700, (x, y) => {
    if (moved && x === 0 && y === 0) return [1, 2, 3, 255];
    let v = (y * 700 + x + 1) * 2654435761;
    v ^= v >>> 13;
    v = Math.imul(v, 1274126177);
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, 255];
  });
  const before = noise(false);
  assert.ok(before.length > 1024 * 1024, `fixture is ${before.length} bytes`);
  const big = makeRepo({ baseFiles: { "ui/baselines/home.png": before }, headFiles: { "ui/baselines/home.png": noise(true) } });
  try {
    const result = guard("launch-status", big, { config: launched() });
    assert.equal(result.status, "pass", result.evidence);
    assert.match(result.evidence, /1 of 490000 pixels differ/);
  } finally {
    cleanup(big);
  }
});

test("the PNG decoder reads RGB and every filter type, and refuses what it does not support", () => {
  // RGB (colour type 2) with a Paeth-filtered row, written by hand.
  const rgb = encodePng(2, 2, (x) => (x ? [10, 20, 30, 255] : [40, 50, 60, 255]));
  assert.equal(decodePng(rgb).rgba.readUInt32BE(4), (10 << 24 | 20 << 16 | 30 << 8 | 255) >>> 0);
  assert.equal(pngDifference(Buffer.from("not a png"), rgb).share, Infinity);
  const sixteen = Buffer.from(rgb);
  sixteen[24] = 16; // IHDR bit depth
  assert.match(pngDifference(rgb, sixteen).reason, /unsupported PNG \(bit depth 16/);
});

// ---------------------------------------------------------------------------
// 9. walkthrough
// ---------------------------------------------------------------------------

const ISSUE_BODY = "## What to check\n\n- [ ] Open the app\n- [ ]   Tap Save  \n- [x] already done\n\nNotes.";

const writeWalkthrough = (acceptRoot, head, { steps, files = {} } = {}) => {
  const dir = walkthroughDir({ root: acceptRoot, repo: REPO, epicId: EPIC, taskId: GATE });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shots = { "01-open.png": changedPng(1), "02-save.png": changedPng(2), ...files };
  for (const [name, bytes] of Object.entries(shots)) writeFileSync(join(dir, name), bytes);
  writeJson(join(dir, "walkthrough.json"), {
    schema: 1, epic: Number(EPIC), task: Number(GATE), head, recordedAt: "2026-10-05T02:00:00Z", by: "chief of staff",
    steps: steps ?? [
      { item: "Open the app", screenshot: "01-open.png", observed: "the home screen opened" },
      { item: "Tap Save", screenshot: "02-save.png", observed: "the toast said saved" },
    ],
  });
  return dir;
};

test("walkthrough passes a complete record and fails each way the ticket names", () => {
  const fx = makeRepo();
  const acceptRoot = mkdtempSync(join(tmpdir(), "afk-acceptance-"));
  const gh = () => fakeGh([[/^gh issue view '999' /, { stdout: JSON.stringify({ body: ISSUE_BODY }) }]]);
  const run = () => guard("walkthrough", fx, { acceptanceRoot: acceptRoot, gh: gh(), delegation: { evidence: "walkthrough" } });
  try {
    const dir = writeWalkthrough(acceptRoot, fx.head);
    const ok = run();
    assert.equal(ok.status, "pass", ok.evidence);
    assert.equal(ok.evidence, `${dir}: 2 step(s), 2 checklist item(s)`);

    // A status commit does not stale the record.
    commit(fx.root, { "docs/progress.md": "# progress\n" }, "afk: update task status");
    assert.equal(run().status, "pass");

    const cases = [
      [{ steps: [{ item: "Open the app", screenshot: "01-open.png", observed: "opened" }] }, /1 step\(s\) for 2 checklist item\(s\)/],
      [{ steps: [
        { item: "Open the app", screenshot: "01-open.png", observed: "opened" },
        { item: "Tap Cancel", screenshot: "02-save.png", observed: "saved" },
      ] }, /step 2's item "Tap Cancel" is not the checklist's "Tap Save"/],
      [{ steps: [
        { item: "Open the app", screenshot: "01-open.png", observed: "opened" },
        { item: "Tap Save", screenshot: "02-save.jpg", observed: "saved" },
      ], files: { "02-save.jpg": Buffer.from("JFIF not a png") } }, /step 2's 02-save\.jpg is not a PNG/],
      [{ steps: [
        { item: "Open the app", screenshot: "01-open.png", observed: "opened" },
        { item: "Tap Save", screenshot: "03-copy.png", observed: "saved" },
      ], files: { "03-copy.png": changedPng(1) } }, /step 2's 03-copy\.png is the same image as 01-open\.png/],
    ];
    for (const [record, cause] of cases) {
      writeWalkthrough(acceptRoot, fx.head, record);
      const result = run();
      assert.equal(result.status, "fail", String(cause));
      assert.match(result.evidence, cause);
    }

    // The head moved past more than status commits since the record.
    writeWalkthrough(acceptRoot, fx.head);
    commit(fx.root, { "src/app.js": "export const app = 3;\n" }, "a real change");
    const moved = run();
    assert.equal(moved.status, "fail");
    assert.match(moved.evidence, /has moved past it/);

    // A gate issue with no unticked checklist line fails, even with no steps.
    writeWalkthrough(acceptRoot, git(fx.root, "rev-parse", "HEAD"), { steps: [] });
    for (const body of ["No checklist here.", "- [x] open the app"]) {
      const empty = guard("walkthrough", fx, {
        acceptanceRoot: acceptRoot,
        gh: fakeGh([[/^gh issue view '999' /, { stdout: JSON.stringify({ body }) }]]),
        delegation: { evidence: "walkthrough" },
      });
      assert.equal(empty.status, "fail", body);
      assert.match(empty.evidence, /#999 has no `- \[ \]` checklist line/);
    }

    // Evaluated only when the delegation asks for it.
    const names = (delegation) => evaluateMergeGuards({ ...ctxFor(fx), delegation, gh: fakeGh() }).map((result) => result.name);
    assert.equal(names({ condition: "x" }).includes("walkthrough"), false);
    assert.equal(names({ condition: "x", evidence: "walkthrough" }).includes("walkthrough"), true);
  } finally {
    cleanup(fx);
    rmSync(acceptRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------

test("every guardrail passes together on a clean, reviewed, green, pre-launch epic", () => {
  const fx = makeRepo({ mainAfter: { "README.md": "main moved on\n" } });
  try {
    writeCloseout(fx.root, fx.head);
    const results = evaluateMergeGuards(ctxFor(fx, { gh: fakeGh([prList, checks([{ name: "test", state: "SUCCESS" }])]), delegation: { condition: "tests green" } }));
    assert.deepEqual(results.map((result) => result.name), [
      "review-at-head", "must-fix-cleared", "must-fix-count", "must-fix-one-way",
      "ci-green", "trial-merge", "one-way-door-paths", "launch-status",
    ]);
    assert.ok(guardsPassed(results), JSON.stringify(results, null, 1));
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// The `merge:` config block
// ---------------------------------------------------------------------------

test("an unknown key under `merge:` is a validation error; the four known keys load", () => {
  const root = mkdtempSync(join(tmpdir(), "afk-merge-config-"));
  try {
    writeConfig(root, { defaultChecks: ["true"], merge: { userFacing: ["ui/**"], screenshotBaselines: ["ui/baselines/**"], ci: "none", healthProbe: "true" } });
    assert.equal(loadConfig(root).merge.ci, "none");
    writeConfig(root, { defaultChecks: ["true"], merge: { userFacng: ["ui/**"] } });
    assert.throws(() => loadConfig(root), /unknown key\(s\) under `merge:`: userFacng/);
    writeConfig(root, { defaultChecks: ["true"], merge: { ci: "sometimes" } });
    assert.throws(() => loadConfig(root), /`merge.ci` must be `required` or `none`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Delegation at launch
// ---------------------------------------------------------------------------

const gateDag = {
  epic: { id: EPIC, title: "Epic" },
  branch: "feat/186",
  tasks: [
    { id: "204", title: "work", dependsOn: [], checks: ["true"], allowedPaths: ["**"], body: "" },
    { id: GATE, title: "walk it", dependsOn: ["204"], checks: ["true"], allowedPaths: ["**"], gateAfter: true, body: "" },
    { id: "998", title: "sign it", dependsOn: ["204"], checks: ["true"], allowedPaths: ["**"], gateAfter: true, body: "" },
  ],
};

test("a delegation of a task that is not `gate: after`, or with no condition, is refused", () => {
  const notGate = mergeDelegations({ dag: gateDag, supplied: [{ id: "204", condition: "tests green" }] });
  assert.equal(notGate.ok, false);
  assert.match(notGate.reason, /#204 is not a `gate: after` task/);
  const noCondition = mergeDelegations({ dag: gateDag, supplied: [{ id: GATE, condition: "  " }] });
  assert.equal(noCondition.ok, false);
  assert.match(noCondition.reason, /needs --delegate-condition/);
  const inLane = mergeDelegations({ dag: gateDag, supplied: [{ id: GATE, condition: "ok" }], inLane: "204" });
  assert.equal(inLane.ok, false);
  assert.match(inLane.reason, /inside task 204's agent environment/);

  const flag = (args) => (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const parsed = (args) => parseDelegateFlags(flag(args), args);
  assert.deepEqual(parsed(["--delegate=999,998", "--delegate-condition=CI green", "--delegate-evidence=walkthrough"]).delegations, [
    { id: "999", condition: "CI green", evidence: "walkthrough" },
    { id: "998", condition: "CI green", evidence: "walkthrough" },
  ]);
  assert.match(parsed(["--delegate-condition=x"]).error, /need --delegate=<id>/);
  assert.equal(parsed(["--accept=999", "--delegated"]).acceptDelegated, true);
});

// The wired half: runAuto against a real repository, every task pre-seeded so
// no builder or merger runs. Same harness as epic-close.test.mjs.
const fakeClaude = (() => {
  const bin = mkdtempSync(join(tmpdir(), "afk-guards-bin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
})();

const makeRunRepo = (lifecycles = { 204: "passed", [GATE]: "passed", 998: "passed" }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-guards-run-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "runner@example.test");
  git(root, "config", "user.name", "Runner Test");
  writeConfig(root, { maxParallel: 1, defaultChecks: ["true"], baselineChecks: [] });
  write(root, { ".gitignore": ".afk/\n", "docs/progress.md": "# Progress\n" });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  writeJson(join(root, ".afk", "state.json"), {
    version: 1, orchestratorPid: null, startedAt: "2026-10-05T00:00:00.000Z", activeWorkers: {}, integrationQueue: [], activeIntegrator: null,
    epic: { id: EPIC, title: "Epic" },
    tasks: Object.fromEntries(Object.entries(lifecycles).map(([id, lifecycle]) => [id, { lifecycle, builderAttempt: 1, integrationAttempt: 1 }])),
  });
  return root;
};
const readState = (root) => JSON.parse(readFileSync(join(root, ".afk", "state.json"), "utf8"));
const logOf = (root) => readFileSync(join(root, ".afk", "agent-auto.log"), "utf8");

const launch = async (root, rest = {}, dag = gateDag) => {
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${fakeClaude}:${previousPath}`;
  process.env.PORT = String(await freePort());
  try {
    return await runAuto({
      config: readConfig(root),
      dag,
      root,
      interactive: false,
      verify: async ({ root: at }) => ({
        version: 1, status: "ok", summary: "fine", criteria: [], findings: [], mustFix: [], problems: [],
        ranAt: "2026-10-05T01:00:00.000Z", head: git(at, "rev-parse", "HEAD"), artifacts: { report: "/tmp/report.json" },
      }),
      commentOnEpic: () => ({ status: 0 }),
      ...rest,
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};
const allPass = (calls = []) => (ctx) => {
  calls.push(ctx.taskId);
  return ["review-at-head", "ci-green"].map((name) => ({ name, status: "pass", evidence: `${name} fine` }));
};
const oneWaits = (ctx) => [
  { name: "review-at-head", status: "pass", evidence: "fine" },
  { name: "ci-green", status: "wait", evidence: "test: in_progress" },
];

test("a delegation given at launch is saved; a restart may add one and may not change one", async () => {
  const root = makeRunRepo({ 204: "running" });
  // `running` with no worker keeps the run from parking, so only the launch is under test.
  try {
    const delegations = [{ id: GATE, condition: "CI green and no must-fix", evidence: null }];
    await launch(root, { delegations, userFacingWaiver: "copy only" });
    const saved = readState(root);
    assert.equal(saved.delegations[GATE].condition, "CI green and no must-fix");
    assert.equal(saved.delegations[GATE].evidence, null);
    assert.ok(saved.delegations[GATE].at);
    assert.equal(saved.userFacingWaiver.reason, "copy only");

    const changed = await launch(root, { delegations: [{ id: GATE, condition: "anything goes", evidence: null }] });
    assert.equal(changed, 1);
    assert.match(logOf(root), /a restart cannot change or drop a delegation/);
    assert.equal(readState(root).delegations[GATE].condition, "CI green and no must-fix");

    await launch(root, { delegations: [{ id: "998", condition: "the legal copy is unchanged", evidence: null }] });
    const added = readState(root);
    assert.deepEqual(Object.keys(added.delegations).sort(), ["998", GATE]);
    assert.equal(added.delegations[GATE].condition, "CI green and no must-fix", "the first delegation survived the restart");

    const notGate = await launch(root, { delegations: [{ id: "204", condition: "x", evidence: null }] });
    assert.equal(notGate, 1);
    const noCondition = await launch(root, { delegations: [{ id: "998", condition: "", evidence: null }] });
    assert.equal(noCondition, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("at the park, a delegated gate whose guardrails pass is accepted by the delegate and the epic closes", async () => {
  const dag = { ...gateDag, tasks: gateDag.tasks.filter((task) => task.id !== "998") };
  const root = makeRunRepo({ 204: "passed", [GATE]: "passed" });
  try {
    const calls = [];
    const code = await launch(root, { delegations: [{ id: GATE, condition: "CI green", evidence: null }], mergeGuards: allPass(calls) }, dag);
    assert.equal(code, 0);
    assert.deepEqual(calls, [GATE]);
    const state = readState(root);
    const acceptance = state.epicClose.acceptances[GATE];
    assert.equal(acceptance.by, "delegate");
    assert.equal(acceptance.condition, "CI green");
    assert.equal(acceptance.guards.length, 2);
    assert.equal(acceptance.review.head, state.epicClose.verifier.head);
    assert.equal(state.epicClose.lifecycle, "closed");
    assert.equal(state.epicClose.outcome, "completed");
    assert.match(logOf(root), /gate 999 guardrail ✓ ci-green: pass — ci-green fine/);
    assert.match(readFileSync(state.epicClose.closeout.path, "utf8"), /999 accepted .* by the delegate under "CI green"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("at the park, a failing guardrail keeps the gate parked, and an undelegated gate is never evaluated", async () => {
  const root = makeRunRepo();
  try {
    const calls = [];
    const evaluate = (ctx) => (calls.push(ctx.taskId), oneWaits(ctx));
    const code = await launch(root, { delegations: [{ id: GATE, condition: "CI green", evidence: null }], mergeGuards: evaluate });
    assert.equal(code, 0);
    assert.deepEqual(calls, [GATE], "the undelegated gate 998 must never reach the guardrails");
    const state = readState(root);
    assert.equal(state.epicClose.lifecycle, "awaiting_acceptance");
    assert.equal(state.epicClose.acceptances?.[GATE], undefined);
    assert.equal(state.epicClose.acceptances?.["998"], undefined);
    assert.deepEqual(state.epicClose.delegateWaits[GATE].waitingOn, ["ci-green"]);
    assert.match(logOf(root), /gate 999 guardrail … ci-green: wait — test: in_progress/);
    assert.match(logOf(root), /gate 999 stays parked — delegated, waiting on ci-green/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--accept --delegated refuses an undelegated gate and --force, and accepts a delegated one once guardrails pass", async () => {
  const dag = { ...gateDag, tasks: gateDag.tasks.filter((task) => task.id !== "998") };
  const root = makeRunRepo({ 204: "passed", [GATE]: "passed" });
  try {
    // The park: delegated, CI still running.
    await launch(root, { delegations: [{ id: GATE, condition: "CI green", evidence: null }], mergeGuards: oneWaits }, dag);
    assert.equal(readState(root).epicClose.lifecycle, "awaiting_acceptance");

    assert.equal(await launch(root, { accept: [GATE], acceptDelegated: true, acceptForce: true, mergeGuards: allPass() }, dag), 1);
    assert.match(logOf(root), /--delegated with --force is refused/);

    // Still waiting: refused, stays parked.
    assert.equal(await launch(root, { accept: [GATE], acceptDelegated: true, mergeGuards: oneWaits }, dag), 1);
    assert.match(logOf(root), /cannot accept 999 on the delegate's behalf — delegated, waiting on ci-green/);
    assert.equal(readState(root).epicClose.acceptances?.[GATE], undefined);

    // CI went green.
    assert.equal(await launch(root, { accept: [GATE], acceptDelegated: true, mergeGuards: allPass() }, dag), 0);
    const state = readState(root);
    assert.equal(state.epicClose.acceptances[GATE].by, "delegate");
    assert.equal(state.epicClose.lifecycle, "closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--accept --delegated on a gate nobody delegated is refused for a human", async () => {
  const dag = { ...gateDag, tasks: gateDag.tasks.filter((task) => task.id !== "998") };
  const root = makeRunRepo({ 204: "passed", [GATE]: "passed" });
  try {
    const calls = [];
    await launch(root, {}, dag);
    assert.equal(await launch(root, { accept: [GATE], acceptDelegated: true, mergeGuards: allPass(calls) }, dag), 1);
    assert.match(logOf(root), /#999 was not delegated; a human must accept it/);
    assert.deepEqual(calls, []);
    assert.equal(readState(root).epicClose.lifecycle, "awaiting_acceptance");
    assert.equal(existsSync(join(root, ".afk", "state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later must-fix review the delegate did not accept over sends the gate back to awaiting_acceptance", async () => {
  const dag = { ...gateDag, tasks: gateDag.tasks.filter((task) => task.id !== "998") };
  const root = makeRunRepo({ 204: "passed", [GATE]: "passed" });
  try {
    const path = join(root, ".afk", "state.json");
    const seeded = JSON.parse(readFileSync(path, "utf8"));
    seeded.delegations = { [GATE]: { condition: "CI green", evidence: null, at: "2026-10-05T00:00:00Z" } };
    seeded.epicClose = {
      lifecycle: "awaiting_acceptance",
      acceptances: { [GATE]: { at: "2026-10-05T01:10:00Z", by: "delegate", condition: "CI green", guards: [], review: { head: "0".repeat(40), ranAt: "2026-10-05T01:00:00.000Z" } } },
    };
    writeFileSync(path, JSON.stringify(seeded));
    const mustFix = async ({ root: at }) => ({
      version: 1, status: "ok", summary: "no", criteria: [], findings: [], mustFix: ["src/app.js leaks a token"], problems: [],
      ranAt: "2026-10-05T03:00:00.000Z", head: git(at, "rev-parse", "HEAD"), artifacts: { report: "/tmp/report.json" },
    });
    assert.equal(await launch(root, { verify: mustFix, mergeGuards: () => { throw new Error("the reopen path must not evaluate guardrails"); } }, dag), 0);
    const state = readState(root);
    assert.equal(state.epicClose.lifecycle, "awaiting_acceptance");
    assert.equal(state.epicClose.acceptances[GATE], undefined);
    assert.equal(state.epicClose.voidedAcceptances[0].by, "delegate");
    assert.match(logOf(root), /999 .*back to awaiting_acceptance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The fates ledger (#228): a decided finding stays decided
// ---------------------------------------------------------------------------

const afkCli = new URL("../afk.mjs", import.meta.url).pathname;
// A fake `gh` that answers the one `gh api` call an owner fate makes: comment 7,
// written by the owner, which the fate cites.
const OWNER_SAID = "https://github.com/acme/app/pull/545#issuecomment-7";
const ghBin = (() => {
  const dir = mkdtempSync(join(tmpdir(), "afk-fates-gh-"));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
[ "$1 $2" = "api repos/acme/app/issues/comments/7" ] && echo '{"user":{"login":"owner"},"author_association":"OWNER","body":"Accept it."}' && exit 0
echo "unscripted gh $*" >&2; exit 1
`, { mode: 0o755 });
  return dir;
})();
const afkIn = (root, ...args) => spawnSync(process.execPath, [afkCli, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}` },
});
const idOf = (listing, title) => {
  const line = listing.split("\n").find((row) => row.includes(title));
  return line?.match(/CF-[0-9a-f]{8}/)?.[0] ?? null;
};

// #545: nine reviews raised 17 must-fix items, about six of them already
// decided. Replayed here: The owner accepts one finding, the next review raises
// it again beside a new one, and only the new one blocks `afk merge`.
test("a #545-shaped history: a finding fated accepted and raised again does not block; an unfated must-fix still does", () => {
  const fx = makeRepo();
  const ACCEPTED = "src/app.js keeps the legacy export";
  const NEW = "src/app.js drops the error from the parse";
  const COS = "README.md names a flag that does not exist";
  try {
    // Review 1, and the fix pass that left the accepted finding open.
    writeCloseout(fx.root, fx.head, { mustFix: [ACCEPTED, COS], left: [ACCEPTED, COS] });
    writeJson(join(fx.root, ".afk", "state.json"), stateAt(fx.head));
    const listed = afkIn(fx.root, "fate", EPIC);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    const acceptedId = idOf(listed.stdout, ACCEPTED);
    const cosId = idOf(listed.stdout, COS);
    assert.ok(acceptedId && cosId, listed.stdout);
    const fated = afkIn(fx.root, "fate", EPIC, acceptedId, "--accepted", `--reason=the export stays until v3, ${OWNER_SAID}`, "--by=owner");
    assert.equal(fated.status, 0, fated.stdout + fated.stderr);
    assert.match(fated.stdout, new RegExp(`${acceptedId}.*accepted by owner`));
    // A fate the chief of staff records is kept, but it is not the owner's call.
    assert.equal(afkIn(fx.root, "fate", EPIC, cosId, "--dropped", "--reason=cosmetic", "--by=cos").status, 0);

    // Review 2, at a later head: the accepted finding again, and a new one.
    const head2 = commit(fx.root, { "src/app.js": "export const app = 2;\n" }, "later work");
    writeCloseout(fx.root, head2, { mustFix: [ACCEPTED, NEW], left: [ACCEPTED, NEW] });
    const blocked = guard("must-fix-cleared", fx, { state: stateAt(head2) });
    assert.equal(blocked.status, "fail", blocked.evidence);
    assert.match(blocked.evidence, new RegExp(NEW.replace(/[.]/g, "\\.")));
    assert.doesNotMatch(blocked.evidence, /still open — .*keeps the legacy export/);
    assert.match(blocked.evidence, /1 accepted or dropped by the owner/);

    // Review 3: only the accepted finding comes back. Nothing blocks.
    writeCloseout(fx.root, head2, { mustFix: [ACCEPTED], left: [ACCEPTED] });
    const cleared = guard("must-fix-cleared", fx, { state: stateAt(head2) });
    assert.equal(cleared.status, "pass", cleared.evidence);
    // S3 (#235): every waiver is named, with who decided and where they said it.
    assert.match(cleared.evidence, new RegExp(`waived ${acceptedId} accepted by owner owner \\(${OWNER_SAID.replace(/[.?]/g, "\\$&")}\\)`));
    const counted = guard("must-fix-count", fx, { state: stateAt(head2) });
    assert.match(counted.evidence, new RegExp(`waived ${acceptedId}`));

    // A finding the chief of staff dropped still blocks: only the owner's fate counts.
    writeCloseout(fx.root, head2, { mustFix: [COS], left: [COS] });
    const cos = guard("must-fix-cleared", fx, { state: stateAt(head2) });
    assert.equal(cos.status, "fail", cos.evidence);
    assert.match(cos.evidence, /README\.md names a flag/);

    // The count guard skips owner-fated lines too: five raised, one accepted.
    writeCloseout(fx.root, head2, { mustFix: [ACCEPTED, "b", "c", "d", "e"] });
    assert.equal(guard("must-fix-count", fx, { state: stateAt(head2) }).status, "pass");
  } finally {
    cleanup(fx);
  }
});

test("a hand-edited fates ledger fails must-fix-cleared closed, naming the line", () => {
  const fx = makeRepo();
  try {
    writeCloseout(fx.root, fx.head);
    assert.equal(guard("must-fix-cleared", fx).status, "pass");
    write(fx.root, { [`.afk/fates/${EPIC}.jsonl`]: "{ not json\n" });
    const result = guard("must-fix-cleared", fx);
    assert.equal(result.status, "fail");
    assert.match(result.evidence, /fates ledger .* line 1/);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Fix pass (#235 review S3, S7)
// ---------------------------------------------------------------------------

test("S3: an owner fate with no cited comment, appended by hand, does not unblock", () => {
  const fx = makeRepo();
  const TITLE = "src/app.js keeps the legacy export";
  try {
    writeCloseout(fx.root, fx.head, { mustFix: [TITLE], left: [TITLE] });
    const listed = afkIn(fx.root, "fate", EPIC);
    writeJson(join(fx.root, ".afk", "state.json"), stateAt(fx.head));
    const id = idOf(afkIn(fx.root, "fate", EPIC).stdout, TITLE);
    assert.ok(id, listed.stdout);
    write(fx.root, { [`.afk/fates/${EPIC}.jsonl`]: `${JSON.stringify({ ts: "2026-10-13T00:00:00Z", epic: EPIC, finding: id, title: TITLE, fate: "accepted", reason: "trust me", by: "owner", reviewHead: fx.head })}\n` });
    const result = guard("must-fix-cleared", fx);
    assert.equal(result.status, "fail", result.evidence);
    assert.match(result.evidence, /keeps the legacy export/);
  } finally {
    cleanup(fx);
  }
});

test("S7: a re-review after the one fix pass is judged on its own must-fix lines and their fates", () => {
  const fx = makeRepo();
  const ACCEPTED = "src/app.js keeps the legacy export";
  const NEW = "src/app.js drops the error from the parse";
  try {
    writeCloseout(fx.root, fx.head, { mustFix: [ACCEPTED], left: [ACCEPTED] });
    writeJson(join(fx.root, ".afk", "state.json"), stateAt(fx.head));
    const id = idOf(afkIn(fx.root, "fate", EPIC).stdout, ACCEPTED);
    assert.equal(afkIn(fx.root, "fate", EPIC, id, "--accepted", `--reason=stays, ${OWNER_SAID}`, "--by=owner").status, 0);
    // The re-review `afk close --redo` runs after the pass: a new head, a new
    // review, and the fixer's report still answering the first review.
    const head2 = commit(fx.root, { "src/app.js": "export const app = 3;\n" }, "later work");
    const rereview = (mustFix) => {
      writeJson(verifierReportPath(fx.root, EPIC), { version: 1, status: "ok", head: head2, ranAt: "2026-10-05T03:00:00.000Z", mustFix, findings: [], criteria: [] });
      return stateAt(head2, { epicClose: { verifier: { head: head2, ranAt: "2026-10-05T03:00:00.000Z", afterFixPass: true } } });
    };
    const ok = guard("must-fix-cleared", fx, { state: rereview([ACCEPTED]) });
    assert.equal(ok.status, "pass", ok.evidence);
    assert.match(ok.evidence, /re-review .* after the one fix pass/);
    const open = guard("must-fix-cleared", fx, { state: rereview([ACCEPTED, NEW]) });
    assert.equal(open.status, "fail", open.evidence);
    assert.match(open.evidence, /drops the error from the parse/);
    assert.match(open.evidence, /afk fate/);
    // Without the re-review mark, a stale fixer still answers nothing.
    const stale = guard("must-fix-cleared", fx, { state: stateAt(head2) });
    assert.equal(stale.status, "fail");
    assert.match(stale.evidence, /the fixer answered the review of/);
  } finally {
    cleanup(fx);
  }
});
