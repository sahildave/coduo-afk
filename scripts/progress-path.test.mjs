// scripts/progress-path.test.mjs — one progress file per epic (#122).
//
// `docs/progress.md` was one file every epic appended to, and appends from two
// branches are a textual conflict by construction: five conflicts across three
// repositories in one morning, every one resolved by keeping both marker
// sections. The markers made the runner stop overwriting its neighbours; they
// could never make git merge two appends.
//
// The merge test at the bottom is the one that matters. It fails against the
// shared-file behaviour with `CONFLICT (add/add): docs/progress.md` and passes
// against a path per epic.
//
// A separate file rather than more of selftest.mjs, for the reason
// scripts/epic-close.test.mjs is one: `afk selftest` picks up every
// `scripts/*.test.mjs`, and a lane that adds a file cannot conflict with a lane
// that adds another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PROGRESS_DIR, PROGRESS_FILE, progressPath, writeProgress } from "./lib.mjs";
import { archiveWaveEvidence } from "./wave.mjs";

const epicDag = (id) => ({
  epic: { id, title: `epic ${id}` },
  tasks: [{ id: `${id}01`, title: "a task", dependsOn: [] }],
});

const temporary = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("an epic's table is written to docs/progress/<id>.md", (t) => {
  const root = temporary(t, "afk-progress-path-");
  const staged = writeProgress(root, epicDag("673"), { tasks: { 67301: { lifecycle: "passed" } } });

  assert.equal(staged, "docs/progress/673.md", "the staged path is the per-epic one");
  const written = readFileSync(join(root, "docs", "progress", "673.md"), "utf8");
  assert.match(written, /epic 673/);
  assert.match(written, /<!-- afk:progress:673 -->/, "the marker scheme survives inside the file");
  assert.equal(existsSync(join(root, "docs", "progress.md")), false, "and nothing is written to the shared file");
});

test("a re-flush replaces the epic's own section rather than appending a second", (t) => {
  const root = temporary(t, "afk-progress-reflush-");
  writeProgress(root, epicDag("673"), { tasks: { 67301: { lifecycle: "running" } } });
  writeProgress(root, epicDag("673"), { tasks: { 67301: { lifecycle: "passed" } } });

  const written = readFileSync(join(root, "docs", "progress", "673.md"), "utf8");
  assert.equal(written.match(/<!-- afk:progress:673 -->/g).length, 1);
  assert.match(written, /\| 67301 \| a task \| passed \| - \|/);
  assert.doesNotMatch(written, /running/);
});

test("a DAG with no epic id at all still writes the shared docs/progress.md", (t) => {
  // `afk auto --dag=<file>` over a hand-written DAG, and only that: a wave run
  // is NOT epic-less (`wave-loader.mjs` stamps `epic: { id: waveId }`), which
  // the case below this one pins. With no id there is nothing to key a file on,
  // and inventing one would file two unrelated runs under one name.
  const root = temporary(t, "afk-progress-dagless-");
  assert.equal(progressPath({ tasks: [] }), "docs/progress.md");
  assert.equal(writeProgress(root, { tasks: [{ id: "204", title: "t", dependsOn: [] }] }, {}), "docs/progress.md");
  assert.ok(existsSync(join(root, "docs", "progress.md")));
});

test("an id that is not a plain filename keeps the shared file", () => {
  // Defence, not a case any epic hits: an id is a GitHub issue number. A `/` or
  // a `..` interpolated into the path would write outside docs/.
  assert.equal(progressPath({ epic: { id: "../../etc/passwd" } }), "docs/progress.md");
  assert.equal(progressPath({ epic: { id: ".." } }), "docs/progress.md");
  assert.equal(progressPath({ epic: { id: "." } }), "docs/progress.md", "and not `docs/progress/..md`");
  assert.equal(progressPath({ epic: { id: "feat/203" } }), "docs/progress.md");
  assert.equal(progressPath({ epic: { id: 673 } }), "docs/progress/673.md", "a numeric id is fine");
  assert.equal(
    progressPath({ epic: { id: "wave-01" } }),
    "docs/progress/wave-01.md",
    "and so is a wave id — `wave-loader.mjs` stamps one, so a wave is not epic-less",
  );
});

test("an existing shared docs/progress.md is left exactly as it was", (t) => {
  // Every consuming project has one, with an epic's marker sections in it. The
  // change moves where NEW tables go; it does not migrate, rewrite or delete.
  const root = temporary(t, "afk-progress-legacy-");
  const legacy = join(root, "docs", "progress.md");
  const body = "# Progress\n\n<!-- afk:progress:203 -->\n\n## Stripe\n<!-- /afk:progress:203 -->\n\n## A human's note\n";
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(legacy, body);

  writeProgress(root, epicDag("673"), {});

  assert.equal(readFileSync(legacy, "utf8"), body, "byte for byte");
});

test("every agent-facing list of protected paths names both progress paths", () => {
  // The code half of this coupling is one constant now. The PROSE half is not:
  // the same path is typed out in the two prompts a lane reads and in PLANNER's
  // scaffolding rules, and nothing but this test connects them to `lib.mjs`. A
  // prompt that names only the old shared file tells a builder the per-epic
  // table is fair game — which `restoreProtected` would then revert under it,
  // silently, exactly as #122's couplings failed.
  for (const file of ["prompts/implementer.md", "prompts/integrator.md", "PLANNER.md"]) {
    const body = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(body.includes(PROGRESS_FILE), `${file} does not name ${PROGRESS_FILE}`);
    assert.ok(body.includes(PROGRESS_DIR), `${file} does not name ${PROGRESS_DIR}`);
  }
});

test("the wave's evidence archive takes the per-epic directory too", (t) => {
  // An all-failed wave never fast-forwards, so its branch is the only copy of
  // its progress tables — and the teardown that runs BECAUSE it failed deletes
  // the branch (#96). Naming only the shared file would erase every epic table
  // a wave produced.
  const dir = temporary(t, "afk-wave-evidence-");
  const worktree = join(dir, "worktree");
  const target = join(dir, "archive");
  mkdirSync(join(worktree, "docs", "progress"), { recursive: true });
  writeFileSync(join(worktree, "docs", "progress.md"), "# Progress\n");
  writeFileSync(join(worktree, "docs", "progress", "673.md"), "epic 673's table\n");

  const { moved } = archiveWaveEvidence({ worktree, target });

  assert.ok(moved.includes(PROGRESS_DIR), `archived: ${moved.join(", ")}`);
  assert.equal(readFileSync(join(target, "docs", "progress", "673.md"), "utf8"), "epic 673's table\n");
  assert.ok(existsSync(join(target, "docs", "progress.md")), "and the shared file, which a wave's own run writes");

  // Archiving twice to the same target — a retried teardown — replaces rather
  // than nests. `cp -R dir dest` with dest present would leave
  // `docs/progress/progress`, which is evidence of nothing.
  archiveWaveEvidence({ worktree, target });
  assert.deepEqual(readdirSync(join(target, "docs", "progress")), ["673.md"]);
});

test("a failed archive leaves the previous one where it was", (t) => {
  // The fix for the nesting above cleared the destination BEFORE copying, which
  // is destructive on exactly the path this function exists for: an all-failed
  // wave whose branch is the only copy of its tables. A `cp` that then fails had
  // deleted the archive and put nothing back. Copy-to-staging-then-swap instead.
  const dir = temporary(t, "afk-wave-evidence-fail-");
  const worktree = join(dir, "worktree");
  const target = join(dir, "archive");
  mkdirSync(join(worktree, "docs", "progress"), { recursive: true });
  writeFileSync(join(worktree, "docs", "progress", "673.md"), "the only copy\n");
  archiveWaveEvidence({ worktree, target });
  assert.equal(readFileSync(join(target, "docs", "progress", "673.md"), "utf8"), "the only copy\n");

  // Now make the copy fail: an unreadable source is the cheapest way, and it is
  // a real failure mode on a worktree being torn down under the archive.
  chmodSync(join(worktree, "docs", "progress"), 0o000);
  const { moved } = archiveWaveEvidence({ worktree, target });
  // Restored here, not in an `after` hook: the temp-dir cleanup is registered
  // first and would run first, and rimraf cannot descend an unreadable dir.
  chmodSync(join(worktree, "docs", "progress"), 0o755);

  assert.ok(!moved.includes(PROGRESS_DIR), `reported as moved when it was not: ${moved.join(", ")}`);
  assert.equal(
    readFileSync(join(target, "docs", "progress", "673.md"), "utf8"),
    "the only copy\n",
    "the previous archive survived the failed copy",
  );
  assert.equal(existsSync(join(target, "docs", "progress.incoming")), false, "and no staging path is left behind");
});

test("two epics that each flushed merge with zero conflicted paths", (t) => {
  // THE BUG. Both branches flush from the same base, exactly as two concurrent
  // epics do, and the merge is asked for the only thing that matters: how many
  // paths git could not reconcile.
  const repo = temporary(t, "afk-progress-merge-");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  assert.equal(git("commit", "-qm", "base").status, 0);

  for (const id of ["673", "674"]) {
    assert.equal(git("checkout", "-q", "-b", `epic/${id}`, "main").status, 0);
    writeProgress(repo, epicDag(id), { tasks: { [`${id}01`]: { lifecycle: "passed" } } });
    git("add", "-A");
    assert.equal(git("commit", "-qm", `afk: update task status (${id}01 passed)`).status, 0);
  }

  assert.equal(git("checkout", "-q", "main").status, 0);
  assert.equal(git("merge", "--no-edit", "-q", "epic/673").status, 0, "the first epic merges either way");
  const second = git("merge", "--no-edit", "epic/674");
  const conflicted = git("diff", "--name-only", "--diff-filter=U").stdout.trim();

  assert.equal(
    conflicted,
    "",
    `the second epic conflicted on:\n${conflicted}\n${second.stdout}${second.stderr}`,
  );
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  assert.deepEqual(
    readdirSync(join(repo, "docs", "progress")).sort(),
    ["673.md", "674.md"],
    "and both tables are on main afterwards",
  );
});
