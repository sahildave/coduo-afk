// scripts/sweep.test.mjs — the closeout sweep over an epic's run artefacts (#110).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { artefactDirsFor, renderSweepLine, sweepRunArtefacts } from "./sweep.mjs";

const gitIn = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

const put = (root, relative, content = "x\n") => {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), content);
};

// A run branch as the closeout finds it: this epic's lane artefacts alongside a
// sibling epic's (`afk epic --worktree` allows two live in one repo).
const seedRepo = (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  put(root, "src/app.js", "app\n");
  put(root, ".afk-runs/204/verification.json", "{}\n");
  put(root, ".afk-runs/204/integration-verification.json", "{}\n");
  put(root, ".afk-runs/205/verification.json", "{}\n");
  put(root, ".agents/evidence/204/01-home.png", "png\n");
  put(root, ".agents/evidence/204/REPORT.md", "report\n");
  put(root, ".afk-runs/999/verification.json", "{}\n");
  put(root, ".agents/evidence/999/01.png", "png\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "run");
  return root;
};

const tracked = (root) => gitIn(root, "ls-files").trim().split("\n").filter(Boolean).sort();
const headSubject = (root) => gitIn(root, "log", "-1", "--format=%s").trim();

test("the sweep removes this epic's artefacts, both prefixes, and leaves a sibling epic's alone", (t) => {
  const root = seedRepo(t);
  const sweep = sweepRunArtefacts({ root, epicId: "203", ids: ["204", 205] });

  assert.equal(sweep.problem, null);
  assert.deepEqual(sweep.removed.sort(), [
    ".afk-runs/204/integration-verification.json",
    ".afk-runs/204/verification.json",
    ".afk-runs/205/verification.json",
    ".agents/evidence/204/01-home.png",
    ".agents/evidence/204/REPORT.md",
  ]);
  assert.deepEqual(tracked(root), [
    ".afk-runs/999/verification.json",
    ".agents/evidence/999/01.png",
    "src/app.js",
  ]);
  // Gone from the working tree too, not only the index.
  assert.equal(existsSync(join(root, ".afk-runs/204")), false);
  assert.equal(existsSync(join(root, ".agents/evidence/204")), false);
  assert.equal(existsSync(join(root, ".afk-runs/999/verification.json")), true);
  assert.equal(headSubject(root), "afk: sweep run artefacts for epic 203");
  assert.equal(sweep.commit, gitIn(root, "rev-parse", "HEAD").trim());
  assert.equal(gitIn(root, "status", "--porcelain").trim(), "", "the sweep leaves a clean tree");
  assert.match(renderSweepLine(sweep), /swept 5 run artefact file\(s\) in [0-9a-f]{7}\./);
});

test("a second sweep commits nothing: a close re-entered after a crash costs no second commit", (t) => {
  const root = seedRepo(t);
  sweepRunArtefacts({ root, epicId: "203", ids: ["204"] });
  const head = gitIn(root, "rev-parse", "HEAD").trim();

  const again = sweepRunArtefacts({ root, epicId: "203", ids: ["204"] });
  assert.deepEqual(again, { removed: [], commit: null, problem: null });
  assert.equal(gitIn(root, "rev-parse", "HEAD").trim(), head);
  assert.equal(renderSweepLine(again), "no run artefacts to sweep.");
});

test("an epic whose lanes never wrote artefacts sweeps nothing and commits nothing", (t) => {
  const root = seedRepo(t);
  const head = gitIn(root, "rev-parse", "HEAD").trim();
  const sweep = sweepRunArtefacts({ root, epicId: "203", ids: ["777"] });
  assert.deepEqual(sweep, { removed: [], commit: null, problem: null });
  assert.equal(gitIn(root, "rev-parse", "HEAD").trim(), head);
  assert.deepEqual(sweepRunArtefacts({ root, epicId: "203", ids: [] }), { removed: [], commit: null, problem: null });
});

test("the sweep commit is pathspec-limited: work someone else staged is neither swept up nor lost", (t) => {
  const root = seedRepo(t);
  put(root, "src/other.js", "staged by a human\n");
  gitIn(root, "add", "src/other.js");

  const sweep = sweepRunArtefacts({ root, epicId: "203", ids: ["204"] });
  assert.equal(sweep.problem, null);
  const inCommit = gitIn(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(inCommit, [
    ".afk-runs/204/integration-verification.json",
    ".afk-runs/204/verification.json",
    ".agents/evidence/204/01-home.png",
    ".agents/evidence/204/REPORT.md",
  ]);
  assert.equal(gitIn(root, "status", "--porcelain").trim(), "A  src/other.js");
});

test("a commit that fails after `git rm` puts the artefacts back, staged deletions included", (t) => {
  // Reviewer-demonstrated: with the object store read-only, `git rm` succeeds
  // and `git commit` fails, leaving `D .afk-runs/204/...` staged for the next
  // un-pathspec'd `flushStatuses` commit to absorb under the wrong subject.
  const root = seedRepo(t);
  const head = gitIn(root, "rev-parse", "HEAD").trim();
  const objects = join(root, ".git", "objects");
  chmodSync(objects, 0o555);
  const sweep = sweepRunArtefacts({ root, epicId: "203", ids: ["204"] });
  // Before the assertions: `seedRepo`'s cleanup hook runs first and cannot
  // remove a read-only object store.
  chmodSync(objects, 0o755);

  assert.match(sweep.problem, /git commit failed/);
  assert.equal(sweep.commit, null);
  assert.deepEqual(sweep.removed, []);
  assert.equal(gitIn(root, "rev-parse", "HEAD").trim(), head);
  assert.equal(gitIn(root, "status", "--porcelain").trim(), "", "nothing staged, nothing missing");
  assert.equal(existsSync(join(root, ".afk-runs/204/verification.json")), true);
  assert.equal(existsSync(join(root, ".agents/evidence/204/01-home.png")), true);
});

test("a sweep that cannot run reports the problem and leaves the artefacts on the branch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "afk-sweep-norepo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sweep = sweepRunArtefacts({ root, epicId: "203", ids: ["204"] });
  assert.equal(sweep.commit, null);
  assert.match(sweep.problem, /git ls-files failed/);
  assert.match(renderSweepLine(sweep), /could not be swept/);
  assert.equal(renderSweepLine(null), "run artefacts were kept (sweepRunArtefacts: false).");
});

test("artefact dirs are keyed by id under both prefixes", () => {
  assert.deepEqual(artefactDirsFor(["204"]), [".afk-runs/204/", ".agents/evidence/204/"]);
});
