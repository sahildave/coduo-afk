// scripts/sweep.mjs — remove an epic's own run artefacts once nothing reads them.
//
// After the Futari v2 wave merged, Lumina's `main` carried 318 run-artefact
// files (about 20 MB): `.afk-runs/<id>/*.json` for 44 lanes and
// `.agents/evidence/<id>/` with 135 PNGs. Half the repo by file count, nothing
// reads any of it once the epic is closed. Since #106 the runner commits no
// verification record there at all — a lane's rides its commit as a git note
// (`readLaneVerification`) — so what this sweeps is `ACTION-REQUIRED.md`, the
// evidence directory, and whatever epics from before #106 left tracked.
//
// Two ordering constraints, both load-bearing:
//
//   - This runs AFTER the closeout verifier and the fix gate, never before. The
//     verifier resolves `.afk-runs/**.json` paths the review cites as evidence
//     off the RUN branch's working tree, so a review run after the sweep finds
//     nothing to resolve — which is also why `afk verify` on a closed epic
//     reads a branch with no evidence on it. This only ever commits to the run
//     branch; task branches are never touched, and a task branch still alive
//     on an `incomplete` close (a `failed` or `blocked` lane) keeps its note
//     and its salvage path.
//   - Scoped to THIS epic's ids, never a blanket `rm -r .afk-runs`. A sibling
//     epic can be live in the same repo (`afk epic --worktree`), and its
//     `ACTION-REQUIRED.md` and evidence are its own to sweep at its own close.
//
// `.agents/evidence/` is not written by the runner; it is the coduo-implement
// skill's output. That skill hotlinks evidence by commit sha
// (`raw.githubusercontent.com/<owner>/<repo>/<sha>/.agents/evidence/<id>/…`),
// so a sha-keyed URL keeps resolving after the path leaves the tree and the
// sweep breaks no PR-body image. Branch-keyed URLs already 404 once the merged
// branch is deleted, so there is nothing to preserve there either.
import { run, shellQuote } from "./lib.mjs";

// The prefixes an epic's artefacts live under, keyed by task id.
export const ARTEFACT_PREFIXES = [".afk-runs/", ".agents/evidence/"];

export const artefactDirsFor = (ids) =>
  ids.flatMap((id) => ARTEFACT_PREFIXES.map((prefix) => `${prefix}${id}/`));

/**
 * Remove the tracked artefacts for `ids` from the working tree and the index,
 * and commit the removal on the current branch — one commit, only those paths.
 *
 * Idempotent: a path with nothing tracked under it is skipped
 * (`--ignore-unmatch`), and a sweep with nothing to remove commits nothing. So a
 * close that re-enters after a crash costs no second commit. Untracked files
 * under a swept directory are left alone: they were never on the branch.
 *
 * Never throws: a sweep that cannot run leaves the artefacts where they were,
 * which is the state every epic closed in before this existed. That includes
 * a commit that fails AFTER `git rm` — the removal is put back, because a
 * staged deletion left behind is absorbed by the next un-pathspec'd
 * `flushStatuses` commit under a subject that says nothing about it.
 *
 * @param {{root: string, epicId: string|null, ids: string[]}} args
 * @returns {{removed: string[], commit: string|null, problem: string|null}}
 */
export const sweepRunArtefacts = ({ root, epicId, ids }) => {
  const dirs = artefactDirsFor(ids.map(String));
  if (!dirs.length) return { removed: [], commit: null, problem: null };
  const pathspec = dirs.map(shellQuote).join(" ");
  const listed = run(`git ls-files -z -- ${pathspec}`, { cwd: root });
  if (listed.status !== 0)
    return { removed: [], commit: null, problem: `git ls-files failed: ${(listed.stderr ?? "").trim()}` };
  const removed = listed.stdout.split("\0").filter(Boolean);
  if (!removed.length) return { removed, commit: null, problem: null };
  const rm = run(`git rm -r -f -q --ignore-unmatch -- ${pathspec}`, { cwd: root });
  if (rm.status !== 0)
    return { removed: [], commit: null, problem: `git rm failed: ${(rm.stderr ?? "").trim()}` };
  // Pathspec-limited to the files just removed, so anything else already
  // staged is neither swept up into this commit nor disturbed. The FILES, not
  // the directories: `git commit -- <dir>/` refuses a directory nothing is
  // tracked under, and a lane that wrote `.afk-runs/<id>/` but no evidence is
  // the common case.
  const commit = run(
    `git commit --no-verify -q -m ${shellQuote(`afk: sweep run artefacts for epic ${epicId ?? "unknown"}`)} -- ${removed.map(shellQuote).join(" ")}`,
    { cwd: root },
  );
  if (commit.status !== 0) {
    // Index and working tree both, from HEAD: the artefacts go back to exactly
    // where they were before this ran.
    run(`git checkout -q HEAD -- ${pathspec}`, { cwd: root });
    return { removed: [], commit: null, problem: `git commit failed: ${(commit.stderr ?? "").trim()}` };
  }
  const sha = run("git rev-parse HEAD", { cwd: root }).stdout.trim() || null;
  return { removed, commit: sha, problem: null };
};

export const renderSweepLine = (sweep) => {
  if (!sweep) return "run artefacts were kept (sweepRunArtefacts: false).";
  if (sweep.problem) return `run artefacts could not be swept (${sweep.problem}); they are still on the branch.`;
  if (!sweep.removed.length) return "no run artefacts to sweep.";
  return `swept ${sweep.removed.length} run artefact file(s) in ${sweep.commit?.slice(0, 7) ?? "?"}.`;
};
