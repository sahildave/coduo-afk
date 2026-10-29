// scripts/reflect.mjs — the run's reflection, written where the operator keeps them.
//
// docs/epic-schema.md, "Rejected: librarian", named one artifact it deliberately
// did not build: "the *codebase explanation* ... which is genuine judgment and
// would need an agent." This is the run-shaped half of that. It is not a render
// of anything — the closeout, the verifier report and the fix pass are all
// already rendered in code — it is a reading of what happened, which is the one
// output on this path that a template cannot produce.
//
// ## Where it runs, and why the evidence is copied rather than pointed at
//
// Reflections live in the RUNNER's repository, one folder per project, which is
// where the operator already keeps them:
//
//   <runner>/docs/<project>/reflection/epic-<id>.md
//
// The agent does not run there and never touches that folder. It runs in a
// scratch workspace under `.afk/reflect/<epic>/workspace/`, the runner COPIES
// the run's artifacts into it first, and the runner moves the finished document
// out afterwards.
//
// That indirection is not tidiness, it is the fix for a measured failure. The
// first live run of this role (epic #23) produced nothing, and said why in its
// own final message: "All five evidence files are outside the session's allowed
// directory, and every read path is refused... reads are confined to
// <cwd>". The cwd-as-cap lever from docs/findings.md 3.2 caps READS as well as
// writes whenever `bypassPermissions` is off — which the verifier never notices,
// because its cwd is a checkout of the very branch it reviews and everything it
// needs is already inside. This role's evidence is somewhere else entirely.
//
// The options were: turn on bypass (throws away the cap), widen the sandbox
// (`allowWrite` does not govern reads, so it would not have helped), or bring
// the evidence to the agent. The third keeps the cap exactly as strong and
// makes it stronger by accident: the agent now cannot reach the project OR the
// runner's repository, only a directory of copies.
//
// It does NOT commit. The file lands in a different repository from the one the
// run touched, and committing there on a project's behalf would put a runner's
// history in someone else's hands. The runner names the path; the operator
// commits it.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  atomicWrite, buildAgentCommand, currentRepo, ensureDir, headSha, normalizeId, runAsync,
  runnerRoot,
} from "./lib.mjs";
import { roleAgent, roleFor, rolePrompt, settingsArg } from "./roles.mjs";
import { modelCheck } from "./model-check.mjs";

/**
 * The project's name as the reflections folder spells it, or NULL.
 *
 * From the GitHub repo, never the directory. Two reasons, and the second is the
 * one that cost something:
 *
 *   1. with `--worktree` the run's root is `~/.afk-claude/epics/<slug>-<id>/<repo>`
 *      and its basename is not a project name at all.
 *   2. it used to fall back to `basename(root)`, which is a project name only
 *      when the checkout happens to be named after its repo. Under a test it is
 *      a temp directory, so every test that closed an epic created a folder in
 *      the runner's own `docs/`: forty-one of them, all empty, all named
 *      `afk-epic-close-<random>` and `afk-gate-lifecycle-<random>`.
 *
 * Null rather than a guess. An epic comes from a GitHub issue, so a checkout
 * with no GitHub remote cannot have run one, and a reflection about it would be
 * a document nobody asked for filed under a name nobody chose. `runReflector`
 * skips, and says so.
 */
export const projectName = (root) => {
  const repo = currentRepo(root);
  const name = repo ? String(repo).split("/").pop() : null;
  return name || null;
};

/**
 * Where reflections are kept: ONE folder, with a folder per project inside it.
 *
 *   <runner>/docs/reflection/<project>/epic-<id>.md
 *
 * Not `docs/<project>/reflection/`, which is what this shipped as first. That
 * layout put a top-level directory in the runner's `docs/` for every project
 * that ever ran — and, because a project's name falls back to a directory
 * basename, for every TEST that ever ran too: forty-one empty
 * `docs/afk-epic-close-<random>/reflection/` folders accumulated before anyone
 * looked. One container means the blast radius of a wrong project name is a
 * junk folder inside `docs/reflection/`, not a junk folder beside `README.md`.
 *
 * `AFK_REFLECTIONS_ROOT` overrides the root — for an operator who keeps them
 * elsewhere, and, load-bearing, for the tests.
 */
export const reflectionsRoot = () => (process.env.AFK_REFLECTIONS_ROOT
  ? resolve(process.env.AFK_REFLECTIONS_ROOT)
  : resolve(runnerRoot, "docs", "reflection"));

export const reflectionDir = (root, project = null) =>
  resolve(reflectionsRoot(), project ?? projectName(root));

export const reflectionPath = (root, epicId, project = null) =>
  resolve(reflectionDir(root, project), `epic-${epicId ?? "unknown"}.md`);

/**
 * The per-lane run directories, as evidence entries.
 *
 * `.afk/runs/<lane>/{builder,integration}-<n>/verification.json` is the file
 * that carries `tokens` and `producedFiles`, and that pair is the only way to
 * tell an infra death — zero tokens, no files, the agent never reached the API
 * — from a lane that genuinely failed its ticket. Leaving it out is why the
 * reflector's own first reflection could not name the blocking command, and why
 * epic #23's regenerated one stopped mid-diagnosis of four timeout deaths with
 * "that file is not in this workspace".
 *
 * ONLY those named reports. `stream.jsonl` sits in the same directory and is
 * deliberately excluded: one lane's transcript is larger than the reflector's
 * whole context, a previous reflection has already run out of room, and the
 * verification report is the summary of the transcript anyway. `report.md` and
 * `changed-files.txt` are not written under `runs/` by this runner, so there is
 * nothing to include.
 */
const RUN_REPORTS = ["verification.json", "integration-verification.json"];
// Twenty lanes with a builder and an integration report each is forty files.
// The reflector has one context; twenty-four is roughly a dozen full lanes and
// is the point past which the reading gets thinner, not richer. When the cap
// bites it is SAID (see the `TRUNCATED` prefix below) — a reflection that
// silently sees ten of twenty lanes draws confident, wrong conclusions.
const MAX_RUN_REPORTS = 24;

const listDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * Did this report record something a reflection would want to read? Cheap: the
 * file is already on disk and is a few KB of JSON. An unreadable one counts as
 * notable — evidence nobody can parse is itself the story.
 */
const reportIsNotable = (source) => {
  try {
    const report = JSON.parse(readFileSync(source, "utf8"));
    return report.passed === false || report.blocked === true || report.timedOut === true
      || report.agentDied === true || report.rateLimited === true || report.authFailure === true
      // Zero tokens on a builder report: the agent never reached the API, so it
      // is infra, not the ticket. Only builder reports carry `tokens` at all —
      // an integration report has `passed` and is judged on that.
      || (report.passed === undefined && !report.tokens)
      || (report.checks ?? []).some((check) => check.code !== 0);
  } catch {
    return true;
  }
};

const runEvidence = (afk) => {
  const runs = resolve(afk, "runs");
  const lanes = listDirs(runs);
  const found = [];
  for (const lane of lanes) {
    const laneDir = resolve(runs, lane);
    // The lane directory itself as well as its attempt subdirectories: the
    // integration report is copied up to the lane root.
    for (const dir of [laneDir, ...listDirs(laneDir).map((a) => resolve(laneDir, a))]) {
      for (const report of RUN_REPORTS) {
        const source = resolve(dir, report);
        if (existsSync(source)) found.push({ lane, source, name: `runs/${relative(runs, source)}` });
      }
    }
  }
  // Lane directories sort lexicographically, so a plain prefix drops the
  // highest-numbered lanes — the END of the run, where the failures are, and
  // the same lanes every time. Order by what the reflection is actually about
  // instead: a lane with a failing report outranks one that passed, and only
  // the passing tail is at risk of being dropped.
  let kept = found;
  if (found.length > MAX_RUN_REPORTS) {
    const notable = new Set(found.filter((e) => reportIsNotable(e.source)).map((e) => e.lane));
    kept = [
      ...found.filter((e) => notable.has(e.lane)),
      ...found.filter((e) => !notable.has(e.lane)),
    ].slice(0, MAX_RUN_REPORTS);
  }
  const lanesKept = new Set(kept.map((entry) => entry.lane)).size;
  const note = kept.length < found.length
    ? `TRUNCATED — ${kept.length} of ${found.length} lane reports staged, covering ${lanesKept} of ${lanes.length} lanes, failing lanes first; the rest of the run is NOT in evidence. `
    : "";
  return kept.map(({ name, source }, index) => ({
    name,
    source,
    why: `${index === 0 ? note : ""}lane ${name.split("/")[1]} — tokens, producedFiles and check results (zero tokens and no files means the agent never reached the API, so it is infra, not the ticket)`,
  }));
};

/**
 * The artifacts the reflection is written from, as (source, local name, why).
 *
 * Absent files are dropped rather than listed: a prompt naming a file the agent
 * cannot open teaches it that the list is unreliable, and the next missing one
 * gets invented around instead of reported.
 */
export const reflectionEvidence = (root, epicId) => {
  const afk = resolve(root, ".afk");
  const candidates = [
    ["state.json", resolve(afk, "state.json"), "run state — every task's lifecycle, attempts and timings"],
    ["run.log", resolve(afk, "agent-auto.log"), "the orchestrator's log, start to finish"],
    ["closeout.md", resolve(afk, "epic-close", String(epicId), "closeout.md"), "the rendered closeout"],
    ["review.json", resolve(afk, "verifier", String(epicId), "report.json"), "the closeout review, structured"],
    ["review.md", resolve(afk, "verifier", String(epicId), "review.md"), "the closeout review, as prose"],
    ["fixes.json", resolve(afk, "fixer", String(epicId), "report.json"), "what the fix pass changed and left"],
    ["ledger.yaml", resolve(afk, "epic-ledger.yaml"), "cross-lane notes recorded during the run"],
  ];
  return [
    ...candidates
      .filter(([, source]) => existsSync(source))
      .map(([name, source, why]) => ({ name, source, why })),
    ...runEvidence(afk),
  ];
};

// A run log can be enormous and the agent has one context. The tail is the part
// that matters — a run's ending explains its ending — and the truncation is
// stated in the file so the agent knows it is reading a tail, not a whole.
const LOG_TAIL_LINES = 4000;

/**
 * Copy the evidence into the agent's workspace, because it cannot read out of
 * it. Returns what actually landed, which is what the prompt then names.
 */
export const stageEvidence = (evidence, workspace) => {
  ensureDir(workspace);
  const staged = [];
  for (const entry of evidence) {
    const target = resolve(workspace, entry.name);
    try {
      const text = readFileSync(entry.source, "utf8");
      const lines = text.split("\n");
      // JSON evidence is exempt: there is no line tail of a JSON document that
      // is still a JSON document, and the prose prefix would hand the agent a
      // `verification.json` it is told to parse and cannot. It stays small on
      // its own — every report is written with `JSON.stringify(x, null, 2)`, so
      // a check's captured output is one escaped string on one line however
      // much it printed, and the line count is structural.
      const body = !entry.name.endsWith(".json") && lines.length > LOG_TAIL_LINES
        ? `_[truncated — the last ${LOG_TAIL_LINES} of ${lines.length} lines of ${entry.source}]_\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`
        : text;
      atomicWrite(target, body);
      staged.push(entry);
    } catch {
      // A file that vanished between listing and copying is simply not evidence.
    }
  }
  return staged;
};

export const renderEvidence = (evidence) =>
  evidence.length
    ? evidence.map((entry) => `- \`${entry.name}\` — ${entry.why}`).join("\n")
    : "- (none — this run left no readable artifacts, which is itself the story)";

export const reflectionWorkspace = (root, epicId) =>
  resolve(root, ".afk", "reflect", String(epicId ?? "epic"), "workspace");

/**
 * Whether the reflection landed. Deliberately thin: the artifact is a document
 * for a human, so there is no schema to score and no structured block to parse.
 * The only mechanical question is whether the file exists and has content.
 *
 * Read from the WORKSPACE, which is where the agent could write. Placing it in
 * the reflections folder is the runner's move, and only happens if this passes.
 */
export const reflectionOutcome = ({ root, epicId, status = 0, timedOut = false }) => {
  const path = resolve(reflectionWorkspace(root, epicId), `epic-${epicId ?? "unknown"}.md`);
  let bytes = 0;
  let untrackedProposals = 0;
  try {
    const text = readFileSync(path, "utf8");
    bytes = text.trim().length;
    // The prompt requires every runner-change proposal to open with a tracker
    // disposition bullet; the untracked ones are the audit's finding — a week
    // of proposals that existed only as prose. Counting them here is the only
    // mechanical link between the document and the tracker.
    untrackedProposals = (text.match(/^\s*-\s+untracked\b/gim) ?? []).length;
  } catch {
    bytes = 0;
  }
  if (bytes > 0) return { ok: true, path, bytes, untrackedProposals };
  if (timedOut) return { ok: false, path, bytes, problem: "the reflector timed out before writing" };
  if (status !== 0) return { ok: false, path, bytes, problem: `the reflector exited ${status}` };
  return { ok: false, path, bytes, problem: "the reflector wrote no file" };
};

export const renderReflectionOutcome = (outcome) =>
  outcome?.ok
    ? `REFLECT: wrote ${outcome.path}.${
        outcome.untrackedProposals
          ? ` ${outcome.untrackedProposals} runner-change proposal${outcome.untrackedProposals === 1 ? "" : "s"} untracked — file them or they do not exist.`
          : ""
      }`
    : `REFLECT: no reflection written — ${outcome?.problem ?? "unknown"}.`;

/**
 * `acceptEdits`, not `default` and not bypass.
 *
 * The verifier and supervisor run on `default` because they write nothing, so a
 * prompt is a hang that never comes. This role's whole output is one file, and
 * `acceptEdits` accepts edits inside the working directory and refuses them
 * outside it — which is exactly the boundary this role's cwd was chosen to
 * draw. Bypass would remove the layer docs/findings.md 3.2 measured as the one
 * actually doing the refusing, for a role whose only reason to exist is to
 * write in one directory.
 */
export const reflectorAgent = (role, config) => ({
  ...roleAgent(role, config),
  bypassPermissions: role.permissions.bypassPermissions ?? true,
  permissionMode: "acceptEdits",
  settings: settingsArg(role, config),
});

export const spawnReflector = async ({ agent, promptPath, streamPath, cwd, epicId }) => {
  const role = roleFor("reflector");
  const command = buildAgentCommand(agent, {
    nodeBin: process.execPath.replace(/\/node$/, ""),
    promptPath,
    streamPath,
    taskId: `reflect-${epicId}`,
    processName: role.processName(epicId),
    cwd,
  });
  return runAsync(command, { cwd, timeout: agent.timeoutMs });
};

/**
 * Write the epic's reflection. **Never throws**, same contract as the verifier
 * and the fixer: a caller closing an epic must not die because a document did.
 *
 * `reuse: true` returns the existing file untouched, so a close that happens
 * twice across a restart costs one reflection and cannot overwrite one the
 * operator has since edited — but only while the branch has not moved.
 *
 * That qualifier is the whole of epic #23's third bug. It closed three times:
 * two failures that reflected on an empty branch, then a success that reused
 * the failure's reflection and filed "produced no documentation at all" against
 * a branch carrying both documents. A stamp file next to the reflection records
 * which commit it was written about; a different HEAD means a different run,
 * and a different run deserves its own reading.
 */
export const runReflector = async ({
  root,
  config,
  dag = { tasks: [] },
  branch = null,
  outcome = "unknown",
  reason = null,
  reuse = true,
  runAgent = spawnReflector,
}) => {
  const epicId = normalizeId(dag.epic?.id ?? null) ?? "unknown";
  const project = projectName(root);
  // No repo, no reflection. See `projectName` — this is the guard that stops a
  // run with no GitHub identity from naming a folder after a temp directory.
  if (!project) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      problem: `no GitHub remote in ${root}, so there is no project to file a reflection under`,
    };
  }
  const destination = reflectionPath(root, epicId, project);
  const head = headSha(root);
  // The stamp lives beside the run's own artifacts, never beside the document:
  // `docs/reflection/` is the operator's folder and a sha file in it is litter.
  const stampPath = resolve(root, ".afk", "reflect", String(epicId), "head");
  const stamped = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : null;
  // Same rule as the verifier's `reuse`: the commit then must equal the commit
  // now. Both null (no repository) matches, since nothing can have moved.
  if (
    reuse
    && existsSync(destination)
    && readFileSync(destination, "utf8").trim().length > 0
    && stamped === (head ?? null)
  ) {
    return {
      ok: true,
      path: destination,
      bytes: readFileSync(destination, "utf8").trim().length,
      reused: true,
    };
  }

  const runDir = resolve(root, ".afk", "reflect", String(epicId));
  const workspace = reflectionWorkspace(root, epicId);
  ensureDir(runDir);
  // Fresh every time. A leftover draft from a previous attempt sitting in the
  // workspace would be read back below as this attempt's answer.
  rmSync(workspace, { recursive: true, force: true });
  const staged = stageEvidence(reflectionEvidence(root, epicId), workspace);

  const role = roleFor("reflector");
  const promptPath = resolve(runDir, "prompt.md");
  const streamPath = resolve(runDir, "stream.jsonl");
  atomicWrite(
    promptPath,
    rolePrompt(role, config, {
      epic: { id: epicId, title: dag.epic?.title ?? null },
      project,
      branch: branch ?? dag.branch ?? null,
      outcome,
      reason,
      fileName: basename(destination),
      evidenceBlock: renderEvidence(staged),
    }),
  );

  const agent = reflectorAgent(role, config);
  let result;
  try {
    result = await runAgent({
      agent,
      promptPath,
      streamPath,
      cwd: workspace,
      epicId,
    });
  } catch (error) {
    result = { status: 1, timedOut: false, stderr: error.message };
  }
  // Which model(s) answered; scripts/model-check.mjs. An unreadable stream is
  // "unknown", never a reason to lose the reflection.
  let raw = "";
  try { raw = readFileSync(streamPath, "utf8"); } catch {}
  const written = {
    ...reflectionOutcome({
      root,
      epicId,
      status: result?.status ?? 1,
      timedOut: Boolean(result?.timedOut),
    }),
    modelCheck: modelCheck(raw),
  };
  if (!written.ok) return written;

  // The runner does the placing, not the agent. It could not reach this folder
  // even if it tried, which is the point — and it means a half-written draft
  // never appears in the operator's docs under a name that implies it is done.
  try {
    ensureDir(reflectionDir(root, project));
    atomicWrite(destination, readFileSync(written.path, "utf8"));
    if (head) atomicWrite(stampPath, `${head}\n`);
  } catch (error) {
    return { ...written, ok: false, problem: `could not place the reflection: ${error.message}` };
  }
  return { ...written, path: destination };
};
