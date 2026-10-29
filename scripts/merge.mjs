// `afk merge <epic>` — merge one epic's PR when every guardrail passes (#189).
//
// The verb evaluates every guardrail in scripts/merge-guards.mjs (#188), plus
// two of its own (`epic-closed`, `pr-head`), prints each as
// `PASS|FAIL|WAIT <name>: <evidence>`, and merges only when all pass:
// `gh pr ready` for a draft, then `gh pr merge <n> --<method>
// --match-head-commit <sha>`. After the merge it runs the project's health
// probe and, when the probe is green, lands the PR the `coduo-land-pr` way:
// closes the issues, deletes the remote branch, prunes the lanes and removes
// a clean epic worktree.
//
// Fail direction: CLOSED. Any `fail` or `wait` is a refusal, posted once on the
// PR. There is no flag that skips a guardrail: no --force, no --admin, no
// --skip-*. One PR per call, one merge per machine at a time (`merge.lock` in
// the Runner's home), and nothing here ever reverts: a red probe prints the
// revert for a human.
//
// Exit codes: 0 merged (or a dry run with every guardrail passing), 1 refused,
// 2 merged with a red health probe.
//
// Two merge paths (#212). With no `merge.author` in .afk-setup/config.yaml the
// merge goes through `gh pr merge`, and is authored by whoever runs the verb.
// With one, the verb merges itself, for repos that deploy only one author's
// commits: `git merge --no-ff` of the guarded head sha into the fetched base,
// in a throwaway detached worktree, authored and committed as `merge.author`
// with one `Co-Authored-By:` trailer per `merge.coAuthors` entry, then a plain
// (never forced) push of the base. The guardrails and the head-sha check are
// the same on both paths; the local path re-reads the PR head and the remote
// branch head just before merging and refuses if either moved off the sha the
// guardrails ran on, and it merges that sha, never the branch name.
//
// `gh` and `git` arrive as injectable runners, the `exec` pattern of
// `findEpicPr` in scripts/pr.mjs: `(command, options) => { status, stdout, stderr }`.
import { randomUUID } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMainModule, lifecycleOf, loadConfig, normalizeId, parseArgv, run, shellQuote } from "./lib.mjs";
import { evaluateGuard, evaluateMergeGuards, guardsPassed } from "./merge-guards.mjs";
import { findEpicPr, prMarker } from "./pr.mjs";
import { outstandingGates } from "./scheduler.mjs";
import { takeOver } from "./gate-lock.mjs";
import { pidAlive } from "./dashboard-data.mjs";
import { pruneLanes, removeEpicWorktree } from "./finish.mjs";
import { mainCheckout } from "./runtime-herdr.mjs";
import { ownedEpicParent } from "./worktree.mjs";
import { buildMergeRow, measurePath } from "./measure.mjs";

export const POLL_MS = 5 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_WAIT_HOURS = 8;
const PROBE_TAIL_LINES = 20;
const TASK_DONE = new Set(["passed", "no-op"]);

/** The verb's refusal comments carry this, so it can find its own last one. */
export const verdictMarker = (epic) => `<!-- afk:merge-verdict ${epic} -->`;

const short = (sha) => (sha ? String(sha).slice(0, 12) : "(none)");
const LABEL = { pass: "PASS", fail: "FAIL", wait: "WAIT" };
export const renderGuardLine = (guard) => `${LABEL[guard.status] ?? "FAIL"} ${guard.name}: ${guard.evidence}`;

// ---------------------------------------------------------------------------
// The merge lock: one merge at a time on this machine
// ---------------------------------------------------------------------------

/** `~/.afk-claude/merge.lock`, beside the gate lock. */
export const mergeLockPath = () => resolve(
  process.env.AFK_MERGE_LOCK_DIR ? resolve(process.env.AFK_MERGE_LOCK_DIR) : join(homedir(), ".afk-claude"),
  "merge.lock",
);

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

/**
 * Take the lock, or name its live holder. A dead holder is taken over through
 * the gate lock's breaker (`takeOver`), so two takers never both win. Created
 * with `link(2)` from a complete temp file, as the gate lock is.
 *
 * @returns {{release: Function} | {held: object}}
 */
export const takeMergeLock = ({ path = mergeLockPath(), holder = {}, alive = pidAlive }) => {
  const token = randomUUID();
  const record = { pid: process.pid, ...holder, since: new Date().toISOString(), token };
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temporary = `${path}.${process.pid}.${token}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`);
    let created = false;
    try {
      linkSync(temporary, path);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
    if (created) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener("exit", release);
        if (readJson(path)?.token === token) {
          try { unlinkSync(path); } catch { /* already gone */ }
        }
      };
      process.once("exit", release);
      return { release };
    }
    const current = readJson(path);
    if (current && alive(current.pid)) return { held: current };
    takeOver(path, current ?? {});
  }
  return { held: readJson(path) ?? { pid: "unknown" } };
};

const describeHolder = (holder) =>
  `${holder.project ?? "an unknown project"}${holder.epic == null ? "" : ` epic #${holder.epic}`} (pid ${holder.pid}, since ${holder.since ?? "unknown"})`;

// ---------------------------------------------------------------------------
// The verb's own two guardrails
// ---------------------------------------------------------------------------

/** Every task passed (or was a confirmed no-op), and every `gate: after` accepted. */
export const epicClosedGuard = (state) => {
  const name = "epic-closed";
  const dag = state?.dag ?? null;
  const tasks = dag?.tasks ?? [];
  if (!tasks.length) return { name, status: "fail", evidence: "the run state lists no tasks" };
  const notDone = tasks.filter((task) => !TASK_DONE.has(lifecycleOf(task, state)));
  const outstanding = outstandingGates(dag, state);
  const acceptances = state?.epicClose?.acceptances ?? {};
  const gates = tasks.filter((task) => task.gateAfter).map((task) =>
    outstanding.includes(task.id) ? `#${task.id} not accepted` : `#${task.id} accepted by ${acceptances[task.id]?.by}`);
  const evidence = `${tasks.length - notDone.length} of ${tasks.length} task(s) done; ${gates.length ? `gates: ${gates.join(", ")}` : "no `gate: after` tasks"}`;
  if (notDone.length) {
    return { name, status: "fail", evidence: `${evidence}; not done: ${notDone.map((task) => `#${task.id} (${lifecycleOf(task, state)})`).join(", ")}` };
  }
  if (outstanding.length) return { name, status: "fail", evidence };
  return { name, status: "pass", evidence };
};

/** The PR's head is the local and the remote branch head, and the PR is this epic's. */
export const prHeadGuard = ({ pr, epic, branch, root, git }) => {
  const name = "pr-head";
  if (pr.state !== "OPEN") return { name, status: "fail", evidence: `PR #${pr.number} is ${pr.state}, not open` };
  if (!String(pr.body ?? "").includes(prMarker(epic))) {
    return { name, status: "fail", evidence: `PR #${pr.number} does not carry epic ${epic}'s marker ${prMarker(epic)}` };
  }
  const local = git(`git rev-parse --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, { cwd: root });
  const localSha = local.status === 0 ? String(local.stdout).trim() : null;
  const remote = git(`git ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`, { cwd: root });
  const remoteSha = remote.status === 0 ? String(remote.stdout).trim().split(/\s+/)[0] || null : null;
  const evidence = `PR ${short(pr.headRefOid)}, local ${short(localSha)}, remote ${short(remoteSha)}`;
  if (!localSha || !remoteSha) return { name, status: "fail", evidence: `${evidence}: ${!localSha ? `no local branch ${branch}` : `origin has no branch ${branch}`}` };
  return pr.headRefOid === localSha && localSha === remoteSha
    ? { name, status: "pass", evidence: `${evidence}; carries the epic marker` }
    : { name, status: "fail", evidence: `${evidence}: the heads differ` };
};

// ---------------------------------------------------------------------------
// Merge method: what the repository's last five merged PRs used
// ---------------------------------------------------------------------------

const METHOD_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:5,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number mergeCommit{messageHeadline parents{totalCount}}}}}}";

/**
 * Two parents is a merge commit; one parent with GitHub's "Title (#n)" headline
 * is a squash; one parent otherwise is a rebase. The method most of the five
 * used wins; a tie, or no answer, is a merge commit.
 */
export const pickMergeMethod = ({ gh, repo, root }) => {
  const [owner, name] = String(repo).split("/");
  const result = gh(`gh api graphql -F owner=${shellQuote(owner)} -F name=${shellQuote(name)} -f query=${shellQuote(METHOD_QUERY)}`, { cwd: root });
  let nodes = null;
  try {
    nodes = JSON.parse(String(result.stdout || "null"))?.data?.repository?.pullRequests?.nodes ?? null;
  } catch { /* falls through */ }
  if (result.status !== 0 || !Array.isArray(nodes)) {
    return { method: "merge", evidence: `merge commit (could not read the last merged PRs: ${String(result.stderr || "no output").trim().split("\n")[0]})` };
  }
  const kinds = nodes.map((node) => {
    const parents = node?.mergeCommit?.parents?.totalCount ?? 0;
    if (parents >= 2) return "merge";
    if (parents === 1) return new RegExp(`\\(#${node.number}\\)$`).test(String(node.mergeCommit.messageHeadline ?? "")) ? "squash" : "rebase";
    return null;
  });
  const counts = new Map();
  for (const kind of kinds.filter(Boolean)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const listed = nodes.map((node, index) => `#${node.number} ${kinds[index] ?? "unknown"}`).join(", ") || "none";
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) {
    return { method: "merge", evidence: `merge commit (no single method among the last ${nodes.length} merged PRs: ${listed})` };
  }
  return { method: ranked[0][0], evidence: `${ranked[0][0]}: ${ranked[0][1]} of the last ${nodes.length} merged PRs (${listed})` };
};

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/** `{ name, email }` when this repo merges as a configured author, else null. */
export const mergeAuthor = (config) => {
  const author = config?.merge?.author;
  return author?.name && author?.email ? { name: author.name, email: author.email } : null;
};

/** The local merge commit's message: GitHub's headline, then the trailers. */
export const localMergeMessage = ({ pr, branch, coAuthors = [] }) => `${[
  `Merge pull request #${pr.number} from ${branch}`,
  "",
  ...(pr.title ? [pr.title, ""] : []),
  ...coAuthors.map((entry) => `Co-Authored-By: ${String(entry).trim()}`),
].join("\n").trimEnd()}\n`;

const usage = "usage: afk merge <epic> [--root=<run root>] [--repo=<owner/name>] [--dry-run] [--wait[=<hours>]]";

/**
 * @returns {Promise<number>} the exit code
 */
export const mergeVerb = async ({
  epic,
  repo,
  root = process.cwd(),
  dryRun = false,
  wait = null,
  exec = run,
  git = run,
  env = process.env,
  log = console.log,
  config: configOverride,
  lockPath = mergeLockPath(),
  alive = pidAlive,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  acceptanceRoot,
}) => {
  // A lane does not merge the epic it is part of — the same rule `--accept`
  // follows in scripts/auto.mjs. Checked before anything is called.
  if (env.RUNNER_TASK_ID) {
    log(`MERGE: refusing inside task ${env.RUNNER_TASK_ID}'s agent environment. An epic's PR is merged from outside the run, not by one of its lanes.`);
    return 1;
  }
  if (!/^\d+$/.test(String(epic ?? "")) || (wait !== null && !(Number(wait) > 0))) {
    log(`MERGE: ${usage}`);
    return 1;
  }
  epic = String(epic);
  root = resolve(root);
  // The run state is the evidence every guardrail reads, and `afk finish`
  // removes it — so the verb runs before finish, against the epic's run root.
  const state = readJson(join(root, ".afk", "state.json"));
  const stateEpic = normalizeId(state?.dag?.epic?.id ?? state?.dag?.epic ?? state?.epic?.id ?? null);
  if (!state?.dag || stateEpic !== epic) {
    log(`MERGE: ${root} holds no run state for epic ${epic}${state?.dag ? ` (its run is epic ${stateEpic})` : ""}. Pass --root=<the epic's run root>: the checkout, or ~/.afk-claude/epics/<slug>-${epic}/<repo> for a --worktree run.`);
    return 1;
  }
  const branch = state.branch ?? state.dag.branch ?? null;
  if (!branch) {
    log(`MERGE: the run state for epic ${epic} names no branch.`);
    return 1;
  }
  let config = configOverride;
  if (config === undefined) {
    try {
      config = loadConfig(root);
    } catch (error) {
      // Fail closed: the guardrails that read config fail on an empty one.
      log(`MERGE: .afk-setup/config.yaml did not load (${error.message}); the guardrails that read it will fail.`);
      config = {};
    }
  }

  const ghOk = (command, what) => {
    const result = exec(command, { cwd: root });
    if (result.status !== 0) throw new Error(`gh could not ${what}: ${String(result.stderr || result.stdout || "").trim()}`);
    return result.stdout;
  };

  let slug;
  try {
    slug = repo || String(ghOk("gh repo view --json nameWithOwner -q .nameWithOwner", "name the current repo")).trim();
  } catch (error) {
    log(`MERGE: ${error.message}`);
    return 1;
  }
  const project = slug.split("/")[1] ?? slug;

  // One evaluation: the PR, every guardrail, the method. Reads only.
  const evaluate = () => {
    const found = findEpicPr({ repo: slug, branch, exec, cwd: root });
    if (!found) return { refusal: `no PR exists for ${branch} in ${slug}. Nothing to merge.` };
    const pr = JSON.parse(ghOk(
      `gh pr view ${found.number} --repo ${shellQuote(slug)} --json number,url,state,isDraft,headRefOid,baseRefName,body,title`,
      `read PR #${found.number}`,
    ));
    const ctx = { root, epicId: epic, taskId: null, state, config, base: pr.baseRefName || "main", repo: slug, gh: exec, git, acceptanceRoot };
    const guards = evaluateMergeGuards(ctx);
    // A delegated gate that needed walkthrough evidence is re-checked here, at
    // the head being merged, one line per gate.
    for (const [id, delegation] of Object.entries(state.delegations ?? {})) {
      if (delegation?.evidence !== "walkthrough") continue;
      const result = evaluateGuard("walkthrough", { ...ctx, taskId: id, delegation });
      guards.push({ ...result, evidence: `#${id}: ${result.evidence}` });
    }
    guards.push(epicClosedGuard(state));
    guards.push(prHeadGuard({ pr, epic, branch, root, git }));
    return { pr, guards };
  };

  const print = (pr, guards) => {
    log(`MERGE: PR #${pr.number} ${pr.url} (head ${short(pr.headRefOid)}, base ${pr.baseRefName}, ${pr.isDraft ? "draft" : "ready"})`);
    for (const guard of guards) log(renderGuardLine(guard));
  };

  if (dryRun) {
    try {
      const outcome = evaluate();
      if (outcome.refusal) {
        log(`MERGE: ${outcome.refusal}`);
        return 1;
      }
      const { pr, guards } = outcome;
      print(pr, guards);
      const author = mergeAuthor(config);
      if (author) {
        log(`  path: local merge as ${author.name} <${author.email}> (merge.author)${(config.merge.coAuthors ?? []).map((entry) => `; Co-Authored-By: ${entry}`).join("")}`);
        log(`  would run: ${pr.isDraft ? `gh pr ready ${pr.number} && ` : ""}git merge --no-ff ${pr.headRefOid} into origin/${pr.baseRefName} && git push origin <merge>:refs/heads/${pr.baseRefName}`);
      } else {
        const { method, evidence } = pickMergeMethod({ gh: exec, repo: slug, root });
        log("  path: gh pr merge (no merge.author configured; authored by whoever runs gh)");
        log(`  method: ${evidence}`);
        log(`  would run: ${pr.isDraft ? `gh pr ready ${pr.number} && ` : ""}gh pr merge ${pr.number} --${method} --match-head-commit ${pr.headRefOid}`);
      }
      log("MERGE: dry run, nothing merged.");
      return guardsPassed(guards) ? 0 : 1;
    } catch (error) {
      log(`MERGE: ${error.message}`);
      return 1;
    }
  }

  const deadline = wait === null ? null : now() + Number(wait) * 3600 * 1000;
  for (;;) {
    const lock = takeMergeLock({ path: lockPath, holder: { project, epic, root }, alive });
    if (lock.held) {
      const line = `WAIT merge-lock: another merge holds ${lockPath}: ${describeHolder(lock.held)}`;
      log(line);
      if (deadline !== null && now() + POLL_MS <= deadline) {
        log(`MERGE: waiting ${POLL_MS / 60000} minutes, until ${new Date(deadline).toISOString()} at the latest.`);
        await sleep(POLL_MS);
        continue;
      }
      log("MERGE: refused: one merge at a time on this machine. Nothing was called.");
      return 1;
    }
    try {
      const outcome = evaluate();
      if (outcome.refusal) {
        log(`MERGE: ${outcome.refusal}`);
        return 1;
      }
      const { pr, guards } = outcome;
      print(pr, guards);
      if (guardsPassed(guards)) return await mergeAndLand({ pr, guards });
      const failing = guards.filter((guard) => guard.status === "fail");
      const waiting = guards.filter((guard) => guard.status === "wait");
      if (!failing.length && deadline !== null && now() + POLL_MS <= deadline) {
        log(`MERGE: waiting on ${waiting.map((guard) => guard.name).join(", ")}; polling again in ${POLL_MS / 60000} minutes, until ${new Date(deadline).toISOString()} at the latest.`);
        lock.release();
        await sleep(POLL_MS);
        continue;
      }
      const verdict = failing.length
        ? `failed: ${failing.map((guard) => guard.name).join(", ")}${waiting.length ? `; waiting on ${waiting.map((guard) => guard.name).join(", ")}` : ""}`
        : `waiting on ${waiting.map((guard) => guard.name).join(", ")}`;
      postVerdict({ pr, verdict, guards });
      log(`MERGE: refused — ${verdict}. Nothing merged.`);
      return 1;
    } catch (error) {
      log(`MERGE: ${error.message}`);
      return 1;
    } finally {
      lock.release();
    }
  }

  // --- helpers that close over the run --------------------------------------

  function postComment(number, body) {
    const dir = mkdtempSync(join(tmpdir(), "afk-merge-"));
    const path = join(dir, "comment.md");
    writeFileSync(path, body);
    try {
      return exec(`gh pr comment ${number} --repo ${shellQuote(slug)} --body-file ${shellQuote(path)}`, { cwd: root });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // One comment per distinct refusal: the same verdict and lines as the verb's
  // own last comment on the PR is not posted again.
  function postVerdict({ pr, verdict, guards }) {
    const body = [
      verdictMarker(epic),
      `**afk merge refused** — ${verdict}.`,
      "",
      "```",
      ...guards.map(renderGuardLine),
      "```",
      "",
    ].join("\n");
    const read = exec(`gh pr view ${pr.number} --repo ${shellQuote(slug)} --json comments`, { cwd: root });
    let last = null;
    try {
      const comments = JSON.parse(String(read.stdout || "{}")).comments ?? [];
      last = comments.filter((comment) => String(comment.body ?? "").startsWith(verdictMarker(epic))).at(-1)?.body ?? null;
    } catch { /* unreadable: post */ }
    if (last !== null && last.trim() === body.trim()) {
      log(`MERGE: PR #${pr.number}'s last afk merge comment already says this; not posting it again.`);
      return;
    }
    const posted = postComment(pr.number, body);
    if (posted.status !== 0) log(`MERGE: could not comment on PR #${pr.number}: ${String(posted.stderr ?? "").trim()}`);
  }

  // The configured-author path (#212). Throws, before anything is pushed, on a
  // head that moved since the guardrails ran, a conflict or a rejected push.
  function localMerge({ pr, author }) {
    const sha = pr.headRefOid;
    const base = pr.baseRefName || "main";
    const gitOk = (command, what, options = {}) => {
      const result = git(command, { cwd: root, ...options });
      if (result.status !== 0) throw new Error(`git could not ${what}: ${String(result.stderr || result.stdout || "").trim().split("\n")[0]}`);
      return String(result.stdout ?? "").trim();
    };
    // The same head-sha check `--match-head-commit` makes, made at merge time.
    const current = JSON.parse(ghOk(`gh pr view ${pr.number} --repo ${shellQuote(slug)} --json headRefOid`, `re-read PR #${pr.number}'s head`)).headRefOid;
    const remote = gitOk(`git ls-remote origin ${shellQuote(`refs/heads/${branch}`)}`, `read origin/${branch}`).split(/\s+/)[0] || null;
    if (current !== sha || remote !== sha) {
      throw new Error(`refused: the head moved after the guardrails ran on ${short(sha)} (PR now ${short(current)}, origin/${branch} now ${short(remote)}). Nothing merged; run afk merge again.`);
    }
    gitOk(`git fetch -q origin ${shellQuote(`refs/heads/${base}`)}`, `fetch origin/${base}`);
    const baseSha = gitOk("git rev-parse FETCH_HEAD", `read the fetched origin/${base}`);
    const dir = mkdtempSync(join(tmpdir(), "afk-merge-wt-"));
    const tree = join(dir, "tree");
    const messagePath = join(dir, "message.txt");
    writeFileSync(messagePath, localMergeMessage({ pr, branch, coAuthors: config.merge.coAuthors ?? [] }));
    const identity = {
      ...process.env,
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    };
    gitOk(`git worktree add -q --detach ${shellQuote(tree)} ${baseSha}`, "make a merge worktree");
    try {
      const merged = git(`git merge -q --no-ff --no-edit -F ${shellQuote(messagePath)} ${sha}`, { cwd: tree, env: identity });
      if (merged.status !== 0) {
        git("git merge --abort", { cwd: tree });
        throw new Error(`git could not merge ${short(sha)} into origin/${base}: ${String(merged.stderr || merged.stdout || "").trim().split("\n")[0]}`);
      }
      const mergeSha = gitOk("git rev-parse HEAD", "read the merge commit", { cwd: tree });
      // Never forced: a base that moved since the fetch rejects the push.
      gitOk(`git push -q origin ${mergeSha}:${shellQuote(`refs/heads/${base}`)}`, `push ${base}`);
      return { mergeSha, mergedAt: new Date(now()).toISOString() };
    } finally {
      git(`git worktree remove --force ${shellQuote(tree)}`, { cwd: root });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The gh path: GitHub merges, authored by whoever runs gh.
  function ghMerge({ pr }) {
    const { method, evidence } = pickMergeMethod({ gh: exec, repo: slug, root });
    log(`  method: ${evidence}`);
    if (pr.isDraft) ghOk(`gh pr ready ${pr.number} --repo ${shellQuote(slug)}`, `mark PR #${pr.number} ready`);
    ghOk(
      `gh pr merge ${pr.number} --repo ${shellQuote(slug)} --${method} --match-head-commit ${pr.headRefOid}`,
      `merge PR #${pr.number}`,
    );
    let mergeSha = null;
    let mergedAt = null;
    try {
      const merged = JSON.parse(ghOk(`gh pr view ${pr.number} --repo ${shellQuote(slug)} --json mergeCommit,mergedAt`, `read PR #${pr.number} after the merge`));
      mergeSha = merged.mergeCommit?.oid ?? null;
      mergedAt = merged.mergedAt ?? null;
    } catch (error) {
      log(`MERGE: ${error.message}`);
    }
    return { method, methodEvidence: evidence, mergeSha, mergedAt };
  }

  async function mergeAndLand({ pr, guards }) {
    const author = mergeAuthor(config);
    let method;
    let methodEvidence;
    let mergeSha;
    let mergedAt;
    if (author) {
      method = "merge";
      methodEvidence = `local merge commit as ${author.name} <${author.email}>, from merge.author`;
      log(`  path: ${methodEvidence}`);
      if (pr.isDraft) ghOk(`gh pr ready ${pr.number} --repo ${shellQuote(slug)}`, `mark PR #${pr.number} ready`);
      ({ mergeSha, mergedAt } = localMerge({ pr, author }));
    } else {
      ({ method, methodEvidence, mergeSha, mergedAt } = ghMerge({ pr }));
    }
    log(`MERGE: merged PR #${pr.number} as ${short(mergeSha)} (${method}).`);

    const probe = runProbe();
    const delegatedGates = Object.entries(state.delegations ?? {}).map(([id, entry]) => ({ id, condition: entry.condition }));
    writeMeasureRow({ pr, mergeSha, mergedAt, delegatedGates, guards, probe });

    const revert = method === "merge" ? `git revert -m 1 ${mergeSha ?? "<merge sha>"}` : `git revert ${mergeSha ?? "<merge sha>"}`;
    if (probe.declared && probe.exit !== 0) {
      const body = [
        "**merged; health probe red**",
        "",
        `Merge ${short(mergeSha)} (${method}). \`${config.merge.healthProbe}\` ${probe.exit === null ? `timed out after ${probeTimeoutMs / 1000}s` : `exited ${probe.exit}`}. Last output:`,
        "",
        "```",
        ...probe.tail,
        "```",
        "",
        `Nothing was landed: no issue closed, no branch deleted. To revert, a human runs \`${revert}\`.`,
        "",
      ].join("\n");
      const posted = postComment(pr.number, body);
      if (posted.status !== 0) log(`MERGE: could not comment on PR #${pr.number}: ${String(posted.stderr ?? "").trim()}`);
      log(`MERGE: health probe red (${probe.exit === null ? "timed out" : `exit ${probe.exit}`}). Not landing. To revert, run by hand:`);
      log(`  ${revert}`);
      return 2;
    }

    // The merge stands whatever happens from here: a landing step that throws
    // is reported, never turned into a refusal.
    let landed;
    try {
      landed = land({ pr, mergeSha });
    } catch (error) {
      landed = { closed: [], leftOpen: [], problems: [`the landing stopped: ${error.message}`] };
      log(`MERGE: the landing stopped: ${error.message}`);
    }
    const usedWaiver = guards.some((guard) => guard.name === "launch-status" && /waived at launch/.test(guard.evidence));
    const waiver = usedWaiver ? state.userFacingWaiver ?? null : null;
    const final = [
      `**afk merge: merged** as ${mergeSha ?? "(sha unknown)"} with \`--${method}\` (${methodEvidence}).`,
      "",
      "```",
      ...guards.map(renderGuardLine),
      "```",
      "",
      delegatedGates.length
        ? `Delegated gates: ${delegatedGates.map((gate) => `#${gate.id} under "${gate.condition}"`).join("; ")}.`
        : "Delegated gates: none.",
      waiver ? `User-facing waiver: "${waiver.reason}".` : "User-facing waiver: none.",
      `Health probe: ${probe.declared ? `\`${config.merge.healthProbe}\` exited 0 in ${probe.ms} ms` : "no probe declared"}.`,
      `Issues closed: ${landed.closed.length ? landed.closed.map((id) => `#${id}`).join(", ") : "none"}${landed.leftOpen.length ? `; left open: ${landed.leftOpen.map((id) => `#${id}`).join(", ")}` : ""}.`,
      ...landed.problems.map((problem) => `- ${problem}`),
      "",
    ].join("\n");
    const posted = postComment(pr.number, final);
    if (posted.status !== 0) log(`MERGE: could not post the final comment on PR #${pr.number}: ${String(posted.stderr ?? "").trim()}`);
    try {
      removeWorktreeIfClean();
    } catch (error) {
      log(`MERGE: retained the epic worktree: ${error.message}`);
    }
    return 0;
  }

  function runProbe() {
    const command = config?.merge?.healthProbe;
    if (!command) {
      // `launch-status` has already refused a launched project with no probe.
      log("MERGE: no probe declared; pre-launch, so going on.");
      return { declared: false, exit: null, ms: null, tail: [] };
    }
    const started = now();
    const result = run(command, { cwd: root, timeout: probeTimeoutMs, killSignal: "SIGKILL" });
    const ms = now() - started;
    const exit = result.error?.code === "ETIMEDOUT" || result.signal ? null : result.status;
    const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd().split("\n").slice(-PROBE_TAIL_LINES);
    log(`MERGE: health probe \`${command}\` → ${exit === null ? "timed out" : `exit ${exit}`} in ${ms} ms.`);
    return { declared: true, exit, ms, tail };
  }

  // Fail direction: open. A measurement is never worth failing a merge that happened.
  function writeMeasureRow({ pr, mergeSha, mergedAt, delegatedGates, guards, probe }) {
    try {
      const row = buildMergeRow({ project, epic, pr: pr.number, mergeSha, mergedAt, delegatedGates, guards, probe, state });
      const path = measurePath(project);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(row)}\n`);
    } catch (error) {
      log(`MERGE: could not write the merge measure row (${error.message}); the merge stands.`);
    }
  }

  // The `coduo-land-pr` steps, for this epic only. Touches no other checkout.
  function land({ pr, mergeSha }) {
    const shipped = `Shipped in #${pr.number} (${short(mergeSha).slice(0, 7)}).`;
    const closed = [];
    const leftOpen = [];
    const problems = [];
    const close = (id) => {
      const result = exec(`gh issue close ${id} --repo ${shellQuote(slug)} --comment ${shellQuote(shipped)}`, { cwd: root });
      if (result.status === 0) closed.push(id);
      else problems.push(`could not close #${id}: ${String(result.stderr ?? "").trim()}`);
    };
    close(epic);
    for (const task of state.dag.tasks ?? []) {
      const lifecycle = lifecycleOf(task, state);
      if (lifecycle === "passed") {
        close(task.id);
        continue;
      }
      leftOpen.push(task.id);
      const note = `Not closed by the merge of #${pr.number}: this task ended ${lifecycle}, not passed.`;
      const result = exec(`gh issue comment ${task.id} --repo ${shellQuote(slug)} --body ${shellQuote(note)}`, { cwd: root });
      if (result.status !== 0) problems.push(`could not comment on #${task.id}: ${String(result.stderr ?? "").trim()}`);
    }
    const deleted = git(`git push origin --delete ${shellQuote(branch)}`, { cwd: root });
    if (deleted.status === 0) log(`MERGE: deleted origin/${branch}.`);
    else problems.push(`could not delete origin/${branch}: ${String(deleted.stderr ?? "").trim().split("\n")[0]}`);
    const { removed, kept, claims } = pruneLanes(root, Object.keys(state.tasks ?? {}), { setup: config?.worktreeSetup ?? null });
    log(`MERGE: pruned ${removed.length} lane(s)${removed.length ? `: ${removed.join(", ")}` : ""}.`);
    if (claims.length) log(`MERGE: removed ${claims.length} orphan repo claim(s): ${claims.join(", ")}.`);
    for (const line of kept) log(`MERGE: retained ${line}`);
    log(`MERGE: closed ${closed.map((id) => `#${id}`).join(", ") || "nothing"}${leftOpen.length ? `; left open ${leftOpen.map((id) => `#${id}`).join(", ")}` : ""}.`);
    for (const problem of problems) log(`MERGE: ${problem}`);
    return { closed, leftOpen, problems };
  }

  // Last: it deletes the run root. Only the epic's own `--worktree` checkout,
  // only when `git status --porcelain` is empty, and never with force.
  function removeWorktreeIfClean() {
    const main = mainCheckout(root);
    if (!ownedEpicParent({ root, main, epicId: epic })) return;
    const status = git("git status --porcelain", { cwd: root });
    if (status.status !== 0 || String(status.stdout).trim()) {
      log(`MERGE: retained epic worktree ${root}: ${status.status !== 0 ? "cannot read its status" : "it has uncommitted changes"}.`);
      return;
    }
    const outcome = removeEpicWorktree({ root, epicId: epic, setup: config?.worktreeSetup ?? null, main, force: false });
    if (outcome.removed) log(`MERGE: removed epic worktree ${outcome.removed}. Your shell may have been in it: cd ${main}`);
    else log(`MERGE: retained epic worktree ${outcome.kept ?? outcome.refused}`);
  }
};

if (isMainModule(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2), ["repo", "root", "dry-run", "wait"], { command: "merge" });
  } catch (error) {
    console.log(`MERGE: ${error.message}`);
    process.exit(1);
  }
  const { flags, positional } = parsed;
  mergeVerb({
    epic: positional[0],
    repo: typeof flags.repo === "string" ? flags.repo : undefined,
    root: typeof flags.root === "string" ? resolve(flags.root.replace(/^~(?=\/|$)/, homedir())) : process.cwd(),
    dryRun: flags["dry-run"] === true,
    wait: flags.wait === undefined ? null : flags.wait === true ? DEFAULT_WAIT_HOURS : flags.wait,
  }).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.log(`MERGE: ${error.message}`);
    process.exitCode = 1;
  });
}
