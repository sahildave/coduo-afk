// scripts/worker.test.mjs — the builder's lane boundary, read off its own transcript.
//
// docs/findings.md 3.15 measured a builder writing the main checkout and a
// SIBLING lane with the `Write` tool: bypass removes the permission layer, and
// the sandbox underneath it never governed `Write` at all. It governs `Bash` —
// the same probe's shell redirect to the same two paths was refused.
//
// So the two routes have two different answers, and `foreignWrites` covers the
// one that is open. It reads the builder's own stream rather than diffing
// worktrees, which matters for a reason that is easy to miss: lanes run in
// parallel, so a before/after diff of a sibling lane attributes that lane's own
// builder to this one. A detector with routine false positives is a detector
// nobody reads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./test-helpers.mjs";
import { createTaskWorktree, readLaneVerification } from "./worktree.mjs";
import { foreignWrites, landedWrites, laneGrant, renderPriorAttempts, runBuilder } from "./worker.mjs";
import { roleAgent, roleFor } from "./roles.mjs";
import { builderRoute } from "./builder-routing.mjs";
import { laneAgentStartArgs } from "./runtime-herdr.mjs";
import { collectBrokerDenials } from "./wave.mjs";

const WORKTREE = "/wt/lane-204";
const grant = laneGrant(WORKTREE, ["<cwd>", "/tmp", "/private/tmp", "/var/tmp"]);
const probe = (raw, deny = []) => foreignWrites(raw, WORKTREE, grant, deny);

const stream = (...calls) => calls.map((input, i) => JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: `t${i}`, name: input.name, input: input.input }] },
})).join("\n");

test("a write inside the lane is not foreign", () => {
  const raw = stream(
    { name: "Write", input: { file_path: `${WORKTREE}/src/app.ts`, content: "x" } },
    { name: "Edit", input: { file_path: `${WORKTREE}/README.md` } },
  );
  assert.deepEqual(probe(raw), []);
});

test("a write into the main checkout or a sibling lane is foreign", () => {
  // Both of these are the measured escape, verbatim from the 3.15 transcript
  // shape: the Write succeeded, no error came back, and `permission_denials`
  // was empty — there is nothing else in the run that would say it happened.
  const raw = stream(
    { name: "Write", input: { file_path: "/repo/afk-claude/.afk-probe.txt", content: "probe" } },
    { name: "Write", input: { file_path: "/wt/lane-207/src/other.ts", content: "probe" } },
  );
  const found = probe(raw);
  assert.deepEqual(found.map((w) => w.path),
    ["/repo/afk-claude/.afk-probe.txt", "/wt/lane-207/src/other.ts"]);
  assert.deepEqual([...new Set(found.map((w) => w.tool))], ["Write"]);
});

test("a lane whose name merely prefixes another is not inside it", () => {
  // `/wt/lane-204` and `/wt/lane-2044` differ only after the point a naive
  // `startsWith` stops looking, and lane ids are issue numbers, so this pair is
  // ordinary rather than contrived.
  const raw = stream({ name: "Write", input: { file_path: "/wt/lane-2044/src/app.ts" } });
  assert.deepEqual(probe(raw).map((w) => w.path), ["/wt/lane-2044/src/app.ts"]);
  // And the worktree root itself is inside its own grant.
  assert.deepEqual(probe(stream({ name: "Write", input: { file_path: WORKTREE } })), []);
});

test("every editing tool is covered, and the read tools are not", () => {
  // `Write` is what the live probe reached for, but nothing stops a builder
  // using `Edit`, `MultiEdit` or `NotebookEdit`, and they carry the path under
  // two different key names.
  const raw = stream(
    { name: "Write", input: { file_path: "/elsewhere/a.txt" } },
    { name: "Edit", input: { file_path: "/elsewhere/b.txt" } },
    { name: "MultiEdit", input: { file_path: "/elsewhere/c.txt" } },
    { name: "NotebookEdit", input: { notebook_path: "/elsewhere/d.ipynb" } },
    // Reading outside the lane is allowed and always has been: the credential
    // paths are denied separately (CREDENTIAL_DENY in roles.mjs). Flagging a
    // read here would make the detector fire on ordinary work.
    { name: "Read", input: { file_path: "/elsewhere/e.txt" } },
    { name: "Grep", input: { path: "/elsewhere" } },
  );
  assert.deepEqual(probe(raw).map((w) => w.path),
    ["/elsewhere/a.txt", "/elsewhere/b.txt", "/elsewhere/c.txt", "/elsewhere/d.ipynb"]);
});

test("the role's own allowWrite is the grant, so /tmp scratch is not an escape", () => {
  // Derived from `ROLES.implementer.permissions.sandbox.allowWrite`, not a
  // second hardcoded list — a role that widens its grant must not start
  // tripping this, or the two would drift and the detector would be wrong in
  // whichever direction nobody checked.
  const raw = stream(
    { name: "Write", input: { file_path: "/tmp/scratch.txt" } },
    { name: "Write", input: { file_path: "/private/tmp/scratch.txt" } },
    { name: "Write", input: { file_path: "/var/tmp/scratch.txt" } },
    // $TMPDIR is per-session and outside every entry above, but Claude Code
    // grants it by default alongside the cwd (docs/findings.md 3.2), so a
    // builder using it is doing something ordinary.
    { name: "Write", input: { file_path: join(tmpdir(), "scratch.txt") } },
  );
  assert.deepEqual(probe(raw), []);
});

test("a relative path is resolved against the lane, not against the runner's cwd", () => {
  // The agent's cwd IS the worktree, so `src/app.ts` is in-lane. Resolving it
  // against the runner's own process cwd would call ordinary work an escape,
  // which is the false positive that would get this detector switched off.
  assert.deepEqual(probe(stream({ name: "Write", input: { file_path: "src/app.ts" } })), []);
  // `..` climbing out is the interesting relative case and must still be seen.
  assert.deepEqual(
    probe(stream({ name: "Write", input: { file_path: "../lane-207/src/app.ts" } })).map((w) => w.path),
    ["/wt/lane-207/src/app.ts"],
  );
});

test("a malformed stream yields no findings rather than throwing", () => {
  // This runs on every builder, including one that died mid-sentence. A
  // detector that throws on a truncated transcript would turn a failed lane
  // into a crashed runner.
  for (const raw of ["", "not json", '{"type":"assistant"}', '{"type":"assistant","message":{}}'])
    assert.deepEqual(probe(raw), []);
  // A tool_use with no path at all is not a write anywhere.
  assert.deepEqual(probe(stream({ name: "Write", input: {} })), []);
});

test("the same path written twice is reported once", () => {
  // An agent that retries a refused write would otherwise produce a list whose
  // length reads as severity.
  const raw = stream(
    { name: "Write", input: { file_path: "/elsewhere/a.txt" } },
    { name: "Edit", input: { file_path: "/elsewhere/a.txt" } },
  );
  assert.deepEqual(probe(raw).map((w) => w.path), ["/elsewhere/a.txt"]);
});

test("laneGrant substitutes the worktree for CWD and keeps the literal entries", () => {
  assert.deepEqual(laneGrant("/wt/lane-1", ["<cwd>", "/tmp"]), ["/wt/lane-1", "/tmp", tmpdir()]);
  // A role with NO sandbox still gets the lane. Returning an empty grant would
  // read downstream as "nothing is foreign", which fails open on exactly the
  // least-capped role — the one where detection is all that is left.
  assert.deepEqual(laneGrant("/wt/lane-1", null), ["/wt/lane-1", tmpdir()]);
});

test("a refused write is an attempt, not grounds for halting an epic", () => {
  // Under bypass a Write outside the lane simply succeeds — that IS 3.15. So a
  // call that came back an error was stopped by something else, and treating it
  // as an escape would halt a whole epic because a cap did its job. That is the
  // false positive that gets a detector switched off.
  const raw = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/elsewhere/blocked.txt" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/elsewhere/landed.txt" } },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "<tool_use_error>operation not permitted</tool_use_error>" },
      { type: "tool_result", tool_use_id: "t2", content: "File created successfully at: /elsewhere/landed.txt" },
    ] } }),
  ].join("\n");
  const all = probe(raw);
  assert.deepEqual(all.map((w) => [w.path, w.refused]), [
    ["/elsewhere/blocked.txt", true],
    ["/elsewhere/landed.txt", false],
  ]);
  assert.deepEqual(landedWrites(all).map((w) => w.path), ["/elsewhere/landed.txt"]);
  // `is_error` alone is enough; not every runtime spells the reason out.
  const flagged = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/elsewhere/x.txt" } }] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "nope" }] } }),
  ].join("\n");
  assert.deepEqual(landedWrites(probe(flagged)), []);
});

test("a write with no result at all still counts as landed", () => {
  // A transcript truncated by a killed agent has the tool_use and no
  // tool_result. Defaulting to "refused" there would let an escape downgrade
  // itself to an attempt by dying — the exact "nothing happened, call it a
  // pass" shape docs/findings.md keeps warning about.
  const all = probe(stream({ name: "Write", input: { file_path: "/elsewhere/a.txt" } }));
  assert.deepEqual(all.map((w) => w.refused), [false]);
  assert.equal(landedWrites(all).length, 1);
});

test("one write that landed outranks any number that were refused", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/elsewhere/a.txt" } }] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "denied" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/elsewhere/a.txt" } }] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t2", content: "File created successfully" }] } }),
  ].join("\n");
  assert.deepEqual(landedWrites(probe(raw)).map((w) => w.path), ["/elsewhere/a.txt"]);
});

test("the lane is passed explicitly, not read off the grant's first element", () => {
  // It used to be `grant[0]`, which was only the worktree because
  // `ROLES.implementer` happens to list CWD first. Reordering that array would
  // silently have made /tmp the lane: relative paths would resolve there and
  // every out-of-lane write under /tmp would stop being reported.
  const reordered = laneGrant(WORKTREE, ["/tmp", "<cwd>"]);
  assert.equal(reordered[0], "/tmp");
  // Relative paths still resolve against the lane...
  assert.deepEqual(foreignWrites(stream({ name: "Write", input: { file_path: "src/app.ts" } }), WORKTREE, reordered), []);
  // ...and the lane is still the lane.
  assert.deepEqual(
    foreignWrites(stream({ name: "Write", input: { file_path: "/wt/lane-207/x.ts" } }), WORKTREE, reordered).map((w) => w.path),
    ["/wt/lane-207/x.ts"],
  );
});

test("the main checkout and other lanes are foreign even when the grant covers them", () => {
  // $TMPDIR is in the grant and a project may put its worktrees under it — this
  // runner kept them in `.afk/` until recently. A grant prefix that swallows a
  // sibling lane must lose to the explicit exclusions.
  const wide = laneGrant(WORKTREE, ["<cwd>", "/wt"]);
  assert.deepEqual(foreignWrites(stream({ name: "Write", input: { file_path: "/wt/lane-207/x.ts" } }), WORKTREE, wide), []);
  assert.deepEqual(
    foreignWrites(stream({ name: "Write", input: { file_path: "/wt/lane-207/x.ts" } }), WORKTREE, wide, ["/wt/lane-207"])
      .map((w) => w.path),
    ["/wt/lane-207/x.ts"],
  );
  // And an exclusion that ENCLOSES this lane must lose to the lane, or a
  // worktree nested under the project root would report all its own work.
  assert.deepEqual(foreignWrites(stream({ name: "Write", input: { file_path: "src/app.ts" } }), WORKTREE, wide, ["/wt"]), []);
});

// ---------------------------------------------------------------------------
// The Codex backend, through the real runBuilder
// ---------------------------------------------------------------------------
//
// Everything above reads a Claude transcript. Codex reports an edit as a
// `file_change` item instead of a `tool_use` block, so the guard was dark on
// that backend until it learned the second shape — a builder that wrote the
// main checkout would have been reported as a clean lane.
//
// The end-to-end tests below spawn a fake `codex` on PATH and drive the real
// `runBuilder`. The fake is not a stub that always succeeds: it writes only
// where `--cd` points it and records its own argv, so the invocation this
// runner builds is asserted as a command line that actually ran rather than as
// a string.

const codexStream = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

const fileChange = (paths, status = "completed") => ({
  type: "item.completed",
  item: { id: "fc1", type: "file_change", status, changes: paths.map((path) => ({ path, kind: "add" })) },
});

test("a Codex file_change outside the lane is foreign, and inside it is not", () => {
  assert.deepEqual(probe(codexStream(fileChange([`${WORKTREE}/src/app.ts`, "src/other.ts"]))), []);
  const found = probe(codexStream(fileChange(["/repo/afk-claude/.afk-probe.txt", "/wt/lane-207/src/other.ts"])));
  assert.deepEqual(found.map((w) => w.path),
    ["/repo/afk-claude/.afk-probe.txt", "/wt/lane-207/src/other.ts"]);
  assert.deepEqual([...new Set(found.map((w) => w.tool))], ["file_change"]);
  assert.deepEqual(landedWrites(found).length, 2);
});

test("a Codex file_change that failed is an attempt, and one that landed outranks it", () => {
  // Same rule as the Claude side: a call the sandbox refused is evidence the
  // cap worked, and halting an epic over it is the false positive that gets a
  // detector switched off. Codex carries the verdict on the item itself, so
  // there is no result event to correlate.
  const refused = probe(codexStream(fileChange(["/elsewhere/a.txt"], "failed")));
  assert.deepEqual(refused.map((w) => w.refused), [true]);
  assert.deepEqual(landedWrites(refused), []);
  assert.deepEqual(
    landedWrites(probe(codexStream(
      fileChange(["/elsewhere/a.txt"], "failed"),
      fileChange(["/elsewhere/a.txt"]),
    ))).map((w) => w.path),
    ["/elsewhere/a.txt"],
  );
  // And a malformed item is no finding rather than a throw, like every other
  // shape this parser meets.
  for (const raw of [
    codexStream({ type: "item.completed", item: { type: "file_change" } }),
    codexStream({ type: "item.completed", item: { type: "file_change", changes: [{}, "", null] } }),
  ]) assert.deepEqual(probe(raw), []);
});

// The fake `codex`. It honours `--cd` (writing anywhere else would be the very
// escape these tests are about), records the argv it was invoked with so the
// command line can be asserted as something that ran, and emits the Codex
// event stream — `item.completed`/`file_change`, then `turn.completed`.
//
// `AFK_FAKE_WRITE` is a path list, so the same fake serves the happy path and
// the escape: the lane's own file, or a file in the main checkout.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
// Codex takes its workspace from --cd and nothing else; Claude takes it from
// the shell it was spawned in. So the fake refuses a Codex invocation that
// names no directory, and that refusal is what gives --cd teeth.
const codex = argv.includes('--sandbox');
const dir = codex ? flag('--cd') : process.cwd();
fs.writeFileSync(process.env.AFK_FAKE_ARGV, JSON.stringify(argv));
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!dir) { process.stderr.write('a Codex invocation named no --cd\\n'); process.exit(2); }
  const targets = (process.env.AFK_FAKE_WRITE || 'source.txt').split(',');
  const written = targets.map((target) => {
    const full = path.resolve(dir, target);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'built\\n');
    return full;
  });
  if (process.env.AFK_FAKE_TOUCH_PROTECTED) {
    // What the herdr lane teardown used to do: remove the whole .claude/
    // directory, taking the project's own tracked settings.json with it.
    fs.rmSync(path.resolve(dir, '.claude'), { recursive: true, force: true });
  }
  if (process.env.AFK_FAKE_BROKER_PATH) {
    // What the permission broker does while the agent runs: append its rulings
    // to broker.jsonl in the attempt's run directory.
    fs.appendFileSync(process.env.AFK_FAKE_BROKER_PATH, process.env.AFK_FAKE_BROKER_LINES);
  }
  if (process.env.AFK_FAKE_COMMIT) {
    cp.spawnSync('git', ['add', '-A'], { cwd: dir });
    cp.spawnSync('git', ['commit', '--no-verify', '-m', 'the builder committed its own work'], { cwd: dir });
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'item.completed', item: { id: 'fc1', type: 'file_change', status: 'completed',
    changes: written.map((p) => ({ path: p, kind: 'add' })) } });
  if (process.env.AFK_FAKE_RATE_LIMIT === 'quota')
    emit({ type: 'turn.failed', error: { status: 429, message: "You've hit your usage limit. Try again at Oct 2." } });
  else if (process.env.AFK_FAKE_RATE_LIMIT === '429')
    emit({ type: 'turn.failed', error: { status: 429, message: 'Too Many Requests, retry in 2s' } });
  else if (process.env.AFK_FAKE_RATE_LIMIT)
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rate_limit_type: 'session' } });
  emit({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

// A repo, a lane worktree for task 204, and a fake `codex` first on PATH.
// `AFK_WORKTREE_ROOT` is pinned to a temp directory: lanes live outside the
// project (worktree.mjs `worktreeRoot`), so a suite that does not pin it leaves
// orphans under the operator's real ~/.afk-claude.
const codexLane = () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-codex-builder-"));
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Test worker rules\n");
  // A TRACKED .claude/settings.json: the project owns this directory and a lane
  // must not be able to commit a change to it, least of all a deletion.
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), '{"project":"settings"}\n');
  writeConfig(repo, { defaultChecks: [] });
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();

  const bin = mkdtempSync(join(tmpdir(), "afk-codex-bin-"));
  writeFileSync(join(bin, "codex"), FAKE_CODEX);
  chmodSync(join(bin, "codex"), 0o755);
  const argvPath = join(bin, "argv.json");

  const saved = {
    PATH: process.env.PATH,
    AFK_BACKEND: process.env.AFK_BACKEND,
    AFK_WORKTREE_ROOT: process.env.AFK_WORKTREE_ROOT,
    AFK_FAKE_ARGV: process.env.AFK_FAKE_ARGV,
    AFK_FAKE_WRITE: process.env.AFK_FAKE_WRITE,
    AFK_FAKE_TOUCH_PROTECTED: process.env.AFK_FAKE_TOUCH_PROTECTED,
    AFK_FAKE_COMMIT: process.env.AFK_FAKE_COMMIT,
    AFK_FAKE_RATE_LIMIT: process.env.AFK_FAKE_RATE_LIMIT,
    AFK_FAKE_BROKER_PATH: process.env.AFK_FAKE_BROKER_PATH,
    AFK_FAKE_BROKER_LINES: process.env.AFK_FAKE_BROKER_LINES,
  };
  const worktreeRoot = mkdtempSync(join(tmpdir(), "afk-codex-wt-"));
  process.env.PATH = `${bin}:${saved.PATH}`;
  // Which executable the operator ran. `afk-codex` sets it; here the test does.
  process.env.AFK_BACKEND = "codex";
  process.env.AFK_WORKTREE_ROOT = worktreeRoot;
  process.env.AFK_FAKE_ARGV = argvPath;
  for (const knob of ["AFK_FAKE_WRITE", "AFK_FAKE_TOUCH_PROTECTED", "AFK_FAKE_COMMIT", "AFK_FAKE_RATE_LIMIT", "AFK_FAKE_BROKER_PATH", "AFK_FAKE_BROKER_LINES"])
    delete process.env[knob];

  const lane = createTaskWorktree({ root: repo, id: "204", baseSha: base });
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [repo, bin, worktreeRoot]) rmSync(dir, { recursive: true, force: true });
  };
  return { repo, git, base, lane, restore, argv: () => JSON.parse(readFileSync(argvPath, "utf8")) };
};

const CODEX_TASK = {
  id: "204",
  title: "Test",
  dependsOn: [],
  allowedPaths: ["source.txt"],
  checks: ["test -f source.txt"],
  body: "# 204 — Test\n\nCreate source.txt.\n",
};
const CODEX_CONFIG = {
  maxParallel: 1,
  defaultChecks: ["test -f source.txt"],
  // A real project's Claude-shaped agent block. Under Codex every Claude key in
  // it is dropped and the tiers in CODEX_ROLE_TIERS decide the model — asserted
  // on the command line below, not just in the resolver.
  agent: { command: "claude", model: "claude-opus-5", reasoningEffort: "low", timeoutMs: 20_000, runtime: "direct" },
};

test("a fake Codex builder completes the real happy path and commits the task branch", async () => {
  const { repo, git, base, lane, restore, argv } = codexLane();
  try {
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.outcome, "ready_to_integrate", JSON.stringify(built.verification?.checks));
    assert.deepEqual(built.verification.producedFiles, ["source.txt"]);
    assert.deepEqual(built.verification.checks.map((c) => c.code), [0]);
    assert.equal(git(lane.worktree, "status", "--porcelain").stdout, "");
    assert.equal(git(lane.worktree, "log", "-1", "--format=%s").stdout.trim(), "task 204: Test");

    // The invocation, as it actually ran. `--cd` is the whole reason the file
    // landed in the lane at all: the fake writes relative to it and refuses
    // without it, so a call site that stopped passing the lane fails here.
    const args = argv();
    assert.equal(args[args.indexOf("--cd") + 1], lane.worktree);
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(args[args.indexOf("-c") + 1], "model_reasoning_effort=max");
    // The integrator's extra writable path is the integrator's alone.
    assert.equal(args.includes("--add-dir"), false, `a builder was granted ${args.join(" ")}`);
    // No Claude flag reached it, including the ones a config asked for.
    for (const flag of ["--settings", "--permission-mode", "--effort", "--dangerously-skip-permissions"])
      assert.equal(args.includes(flag), false, `a Codex builder carried ${flag}`);

    // Who built this, on what, at what effort — on both copies of the record,
    // including the note the restart path reads back off the task branch.
    const evidence = { backend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max" };
    assert.deepEqual(built.verification.agent, evidence);
    assert.equal("tokens" in built.verification, false, "Codex telemetry is unavailable, not zero");
    assert.deepEqual(readLaneVerification(repo, "204", lane.branch).agent, evidence);
  } finally {
    restore();
  }
});

test("an unproven Herdr stop leaves the lane untouched for recovery", async () => {
  const { repo, git, base, lane, restore } = codexLane();
  try {
    const built = await runBuilder({
      root: repo,
      config: { ...CODEX_CONFIG, agent: { ...CODEX_CONFIG.agent, runtime: "herdr" } },
      task: CODEX_TASK,
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha: base,
      attempt: 1,
      runHerdr: async () => {
        writeFileSync(join(lane.worktree, "source.txt"), "still running\n");
        git(lane.worktree, "add", "source.txt");
        git(lane.worktree, "commit", "-m", "agent commit still in flight");
        return { status: 1, timedOut: true, agentStillRunning: true, paneOutput: "still live" };
      },
    });
    assert.equal(built.outcome, "infra_failed");
    assert.equal(built.verification.agentStillRunning, true);
    assert.deepEqual(built.verification.producedFiles, ["source.txt"]);
    assert.notEqual(git(lane.worktree, "rev-parse", "HEAD").stdout.trim(), base, "builder commit was reset");
    assert.equal(readFileSync(join(lane.worktree, "source.txt"), "utf8"), "still running\n");
  } finally {
    restore();
  }
});

test("a Codex builder that writes outside its lane is stopped, not committed", async () => {
  // The same guard the Claude path has, reached through the Codex event shape.
  // Without the `file_change` branch in `foreignWrites` this lane passes: the
  // file lands in the main checkout and nothing in the run says so.
  const { repo, base, lane, restore, git } = codexLane();
  try {
    process.env.AFK_FAKE_WRITE = `source.txt,${join(repo, ".afk-probe.txt")}`;
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.outcome, "failed");
    assert.deepEqual(
      built.verification.wroteOutsideLane.map((w) => w.path),
      [realpathSync(repo) + "/.afk-probe.txt"],
    );
    assert.equal(built.commitSha, undefined);
    assert.equal(git(lane.worktree, "log", "-1", "--format=%s").stdout.trim(), "base");
    // And the evidence still names the backend, because a failed attempt is
    // exactly when a reader needs to know which provider produced it.
    assert.equal(built.verification.agent.backend, "codex");
  } finally {
    restore();
  }
});

test("the same lane under Claude records claude, and asks for no Codex flag", async () => {
  // The regression control. The Claude path is unchanged by any of the above,
  // and its evidence names its own backend rather than defaulting to the one
  // that happens to be running the suite.
  const { repo, base, lane, restore, argv } = codexLane();
  try {
    process.env.AFK_BACKEND = "claude";
    writeFileSync(join(dirname(process.env.AFK_FAKE_ARGV), "claude"), FAKE_CODEX);
    chmodSync(join(dirname(process.env.AFK_FAKE_ARGV), "claude"), 0o755);
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.outcome, "ready_to_integrate", JSON.stringify(built.verification?.checks));
    assert.deepEqual(built.verification.producedFiles, ["source.txt"]);
    // The implementer role pins claude-opus-5-5 over the config's senior
    // `agent.model`; effort still inherits the config's `low`.
    assert.deepEqual(built.verification.agent,
      { backend: "claude", model: "claude-opus-5-5", reasoningEffort: "low" });
    const args = argv();
    assert.equal(args.includes("--add-dir"), false);
    assert.equal(args.includes("--sandbox"), false);
    assert.ok(args.includes("--dangerously-skip-permissions"), args.join(" "));
  } finally {
    restore();
  }
});

test("an explicit builder backend overrides the process backend and renders Codex prompt sections", async () => {
  const { repo, base, lane, restore, argv } = codexLane();
  try {
    // The mixed scheduler is Claude-primary. The lane still has to reach Codex
    // when the task assignment says so, without changing AFK_BACKEND for the
    // checks or any other role.
    process.env.AFK_BACKEND = "claude";
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
      backend: "codex",
    });
    assert.equal(built.outcome, "ready_to_integrate", JSON.stringify(built.verification?.checks));
    assert.equal(built.verification.agent.backend, "codex");
    assert.match(readFileSync(join(repo, ".afk", "runs", "204", "builder-1", "prompt.md"), "utf8"), /Nobody reads your output until you exit/);
    assert.doesNotMatch(readFileSync(join(repo, ".afk", "runs", "204", "builder-1", "prompt.md"), "utf8"), /After each tool call you are shown/);
    assert.equal(argv()[argv().indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(process.env.AFK_BACKEND, "claude", "the explicit lane did not mutate the primary backend");
  } finally {
    restore();
  }
});

test("a fake mixed run sends the selected builder to Codex and the other builder to Claude", async () => {
  const { repo, base, lane, restore, argv } = codexLane();
  const secondLane = createTaskWorktree({ root: repo, id: "205", baseSha: base });
  try {
    process.env.AFK_BACKEND = "claude";
    writeFileSync(join(dirname(process.env.AFK_FAKE_ARGV), "claude"), FAKE_CODEX);
    chmodSync(join(dirname(process.env.AFK_FAKE_ARGV), "claude"), 0o755);
    const selected = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
      backend: "codex",
    });
    const codexArgs = argv();
    const other = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: { ...CODEX_TASK, id: "205" },
      worktree: secondLane.worktree, branch: secondLane.branch, baseSha: base, attempt: 1,
      backend: "claude",
    });
    const claudeArgs = argv();
    assert.equal(selected.outcome, "ready_to_integrate");
    assert.equal(other.outcome, "ready_to_integrate");
    assert.equal(selected.verification.agent.backend, "codex");
    assert.equal(other.verification.agent.backend, "claude");
    assert.equal(codexArgs.includes("--sandbox"), true);
    assert.equal(claudeArgs.includes("--sandbox"), false);
    assert.equal(process.env.AFK_BACKEND, "claude", "mixed dispatch did not mutate the primary backend");
    for (const role of ["integrator", "plan-reviewer", "verifier", "fixer", "reflector", "supervisor"])
      assert.equal(roleAgent(roleFor(role), CODEX_CONFIG).backend, "claude", `${role} stays on the Claude primary`);
  } finally {
    restore();
  }
});

// #292 AC1. Routing comes from run state: task 204 is assigned to Codex and 205
// to Claude, on a Claude-primary Herdr run. The Codex lane is launched as an
// interactive Codex Herdr agent in ITS lane worktree, the Claude lane as a
// Claude agent, and every non-builder role resolves to Claude.
test("a fake mixed Herdr run launches the Codex-assigned task as a Codex agent in its lane and the other on Claude", async () => {
  const { repo, base, lane, restore } = codexLane();
  const secondLane = createTaskWorktree({ root: repo, id: "205", baseSha: base });
  try {
    process.env.AFK_BACKEND = "claude";
    const config = { ...CODEX_CONFIG, agent: { ...CODEX_CONFIG.agent, runtime: "herdr" } };
    const state = { builderRouting: { assignments: {
      204: { preferredBackend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", reason: "bounded edit" },
      205: { preferredBackend: "claude", model: "claude-opus-5-5", reasoningEffort: null, reason: "default" },
    } } };
    const launches = [];
    const runHerdr = async ({ role, worktree, agent, promptPath }) => {
      launches.push({
        role: role.name,
        worktree,
        args: laneAgentStartArgs({ name: "afk-x-1", pane: "w1:p1", agent, launchDir: dirname(promptPath), cwd: worktree }),
      });
      writeFileSync(join(worktree, "source.txt"), "built\n");
      return { status: 0, timedOut: false, report: { status: "done" }, paneOutput: "" };
    };
    const built = {};
    for (const [id, worktree, branch] of [["204", lane.worktree, lane.branch], ["205", secondLane.worktree, secondLane.branch]]) {
      const route = builderRoute(state.builderRouting.assignments[id]);
      built[id] = await runBuilder({
        root: repo, config, task: { ...CODEX_TASK, id }, worktree, branch, baseSha: base, attempt: 1,
        backend: route.backend, model: route.model, reasoningEffort: route.reasoningEffort, runHerdr,
      });
    }
    assert.equal(built["204"].outcome, "ready_to_integrate", JSON.stringify(built["204"].verification?.checks));
    assert.equal(built["205"].outcome, "ready_to_integrate", JSON.stringify(built["205"].verification?.checks));
    const [codexLaunch, claudeLaunch] = launches;
    assert.equal(codexLaunch.worktree, lane.worktree);
    assert.equal(codexLaunch.args[codexLaunch.args.indexOf("--kind") + 1], "codex");
    assert.equal(codexLaunch.args[codexLaunch.args.indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(codexLaunch.args[codexLaunch.args.indexOf("--cd") + 1], lane.worktree, "the Codex agent runs in its own lane");
    assert.equal(claudeLaunch.worktree, secondLane.worktree);
    assert.equal(claudeLaunch.args[claudeLaunch.args.indexOf("--kind") + 1], "claude");
    assert.equal(claudeLaunch.args[claudeLaunch.args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.deepEqual(built["204"].verification.agent, { backend: "codex", model: "gpt-5.6-luna", reasoningEffort: "max" });
    assert.equal(built["205"].verification.agent.backend, "claude");
    for (const role of ["plan-reviewer", "integrator", "verifier", "fixer"])
      assert.equal(roleAgent(roleFor(role), config).backend, "claude", `${role} stays on Claude in a mixed run`);
    assert.equal(process.env.AFK_BACKEND, "claude", "routing a lane never changes the run's backend");
  } finally {
    restore();
  }
});

test("a Codex lane's protected files are restored and its own commits removed", async () => {
  // The three guards that are provider-agnostic by design, exercised on the
  // provider that did not exist when they were written. A lane deleted the
  // project's tracked `.claude/settings.json` on every task of the first live
  // epic, and the merges hid it in the net diff; a builder that commits its own
  // work leaves the retry standing on the code that just failed.
  const { repo, git, base, lane, restore } = codexLane();
  try {
    process.env.AFK_FAKE_TOUCH_PROTECTED = "1";
    process.env.AFK_FAKE_COMMIT = "1";
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.outcome, "ready_to_integrate", JSON.stringify(built.verification?.checks));
    assert.equal(existsSync(join(lane.worktree, ".claude", "settings.json")), true,
      "the project's .claude/settings.json was restored");
    assert.ok(built.verification.revertedProtected.includes(".claude/settings.json"),
      JSON.stringify(built.verification.revertedProtected));
    assert.ok(!built.verification.producedFiles.some((f) => f.startsWith(".claude/")),
      "a protected revert is not task output");
    // The builder's own commit is gone, and the runner's is the only one on the
    // branch — with the restored file NOT in it.
    assert.equal(built.verification.builderCommitsRemoved.length, 1);
    assert.deepEqual(
      git(lane.worktree, "log", "--format=%s", `${base}..HEAD`).stdout.trim().split("\n"),
      ["task 204: Test"],
    );
    assert.equal(
      git(lane.worktree, "show", "--name-only", "--format=", "HEAD").stdout
        .split("\n").filter(Boolean).some((f) => f.startsWith(".claude/")),
      false,
    );
  } finally {
    restore();
  }
});

test("a Codex builder that escaped its lane fails even when it is also rate-limited", async () => {
  // Precedence, on the Codex event stream. `rate_limited` routes through the
  // scheduler's retry, which resets the lane — that would wipe the evidence
  // while the file written elsewhere stayed exactly where it is.
  const { repo, base, lane, restore } = codexLane();
  try {
    process.env.AFK_FAKE_WRITE = `source.txt,${join(repo, ".afk-probe.txt")}`;
    process.env.AFK_FAKE_RATE_LIMIT = "1";
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.verification.rateLimited, true, "fixture precondition: the limit was seen");
    assert.equal(built.outcome, "failed", "the escape outranks the limit");
    assert.equal(built.verification.wroteOutsideLane.length, 1);
  } finally {
    restore();
  }
});

test("only a Codex failure naming the quota is a confirmed quota rejection; a bare 429 is a throttle", async () => {
  // #292 defect 3: a transient throttle is a rate limit, not exhaustion.
  for (const [knob, quotaRejected] of [["429", undefined], ["quota", true]]) {
    const { repo, base, lane, restore } = codexLane();
    try {
      process.env.AFK_FAKE_RATE_LIMIT = knob;
      const built = await runBuilder({
        root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
        worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
      });
      assert.equal(built.outcome, "rate_limited", knob);
      assert.equal(built.quotaRejected, quotaRejected, knob);
      assert.equal(built.verification.quotaRejected, quotaRejected, knob);
    } finally {
      restore();
    }
  }
});

const brokerLine = (behavior, subjects) =>
  JSON.stringify({ ts: "2026-09-24T00:00:00Z", task: "204", tool_name: "Bash", subjects, behavior, resolution: behavior === "allow" ? "ruled" : "timeout" });

test("the permission broker's decision log is folded into verification.json", async () => {
  // Under herdr the broker writes one line per ruling to broker.jsonl in the
  // attempt's run directory (#53), WHILE the agent runs. Without this fold no
  // denial is visible after the run: the file sits in .afk/runs/ and nothing
  // reads it.
  const { repo, base, lane, restore } = codexLane();
  try {
    const runDir = join(repo, ".afk", "runs", "204", "builder-1");
    process.env.AFK_FAKE_BROKER_PATH = join(runDir, "broker.jsonl");
    process.env.AFK_FAKE_BROKER_LINES = [
      brokerLine("allow", ["package.json"]),
      brokerLine("deny", ["src/secret.ts"]),
      brokerLine("deny", ["/etc/hosts", "src/secret.ts"]),
      "{ half-written",
    ].join("\n") + "\n";
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    const record = JSON.parse(readFileSync(join(runDir, "verification.json"), "utf8"));
    assert.equal(record.brokerDecisions?.allowed, 1);
    assert.equal(record.brokerDecisions?.denied, 2);
    assert.equal(record.brokerDecisions?.entries.length, 3, "a torn line is skipped, not fatal");
    assert.deepEqual(built.verification.brokerDecisions, record.brokerDecisions);
  } finally {
    restore();
  }
});

test("a stale broker.jsonl from a dead attempt in a reused run dir is not counted", async () => {
  // builder-N is reused: a rate limit steps builderAttempt back, and an
  // infra/auth failure or `afk reset` zeroes it. The broker APPENDS, so a
  // leftover log would put a dead attempt's denials on this attempt's record.
  const { repo, base, lane, restore } = codexLane();
  try {
    const runDir = join(repo, ".afk", "runs", "204", "builder-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "broker.jsonl"), `${brokerLine("deny", ["src/stale.ts"])}\n`);
    process.env.AFK_FAKE_BROKER_PATH = join(runDir, "broker.jsonl");
    process.env.AFK_FAKE_BROKER_LINES = `${brokerLine("allow", ["package.json"])}\n`;
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.verification.brokerDecisions?.denied, 0, "the dead attempt's denial was counted");
    assert.equal(built.verification.brokerDecisions?.allowed, 1);
  } finally {
    restore();
  }
});

test("a reused run dir whose agent run throws leaves no stale verification.json to count", async () => {
  // The agent call is try/finally with no catch, so a throw skips the write of
  // this attempt's record. Without clearing it up front, the dead attempt's
  // verification.json survives in builder-N and the wave digest counts its
  // broker denials as this attempt's.
  const { repo, base, lane, restore } = codexLane();
  let pid = null;
  try {
    const runDir = join(repo, ".afk", "runs", "204", "builder-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "verification.json"), JSON.stringify({
      taskId: "204", attempt: 1,
      brokerDecisions: { allowed: 0, denied: 1, entries: [{ behavior: "deny", subjects: ["src/stale.ts"] }] },
    }));
    await assert.rejects(
      runBuilder({
        root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
        worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
        // runAsync calls onSpawn inside its Promise executor, so this rejects
        // the agent run from inside runBuilder's try/finally.
        onPid: (p) => { pid = p; throw new Error("agent launch blew up"); },
        say: () => {},
      }),
      /agent launch blew up/,
    );
    assert.deepEqual(
      collectBrokerDenials(repo, { "204": { outcome: "failed", attempts: 1 } }),
      {},
      "a dead attempt's denials were counted after the retry threw",
    );
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    restore();
  }
});

test("a lane with no broker log carries no brokerDecisions key", async () => {
  const { repo, base, lane, restore } = codexLane();
  try {
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal("brokerDecisions" in built.verification, false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// A check that never returns, and the evidence a retry is handed
// ---------------------------------------------------------------------------

test("a check that never returns fails the attempt inside the configured timeout", async () => {
  // The quillnote v1 six-hour stall, reproduced small. `runAsync` has always
  // taken a timeout and both check call sites inherited its 0 default, which
  // arms no timer at all — so this lane held its worktree and its scheduler
  // slot until a human woke up. Drop `timeout:` from worker.mjs's check call
  // and this test stops finishing rather than going red.
  const { repo, base, lane, restore } = codexLane();
  try {
    const startedAt = Date.now();
    const built = await runBuilder({
      root: repo,
      config: { ...CODEX_CONFIG, checkTimeoutMs: 2_000 },
      task: { ...CODEX_TASK, checks: ["sleep 99999"] },
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(built.outcome, "failed", JSON.stringify(built.verification?.checks));
    assert.ok(elapsed < 60_000, `the check was reaped after ${elapsed}ms, so nothing bounded it`);

    // Distinguishable in verification.json from a red check, on both copies of
    // the record: `timedOut` says which kind of failure, and 124 (what
    // `timeout(1)` reports) keeps it a failure to every reader that only asks
    // `code !== 0` — supervisor.mjs excludes a null code to skip a skipped check.
    const [check] = built.verification.checks;
    assert.equal(check.command, "sleep 99999");
    assert.equal(check.timedOut, true);
    assert.equal(check.code, 124);
    assert.equal(check.timeoutMs, 2_000);
    assert.equal(
      JSON.parse(readFileSync(join(repo, ".afk", "runs", "204", "builder-1", "verification.json"), "utf8"))
        .checks[0].timedOut,
      true,
    );

    // And in the failure reason the next attempt is shown.
    assert.match(
      renderPriorAttempts([built.verification]),
      /check timed out after 2s: sleep 99999/,
    );
  } finally {
    restore();
  }
});

test("a config with no checkTimeoutMs still runs its checks", async () => {
  // The compatibility half. Every existing project's config predates the key,
  // and a resolver that read the absent value literally would pass 0 straight
  // back into `runAsync` and re-open the hang.
  const { repo, base, lane, restore } = codexLane();
  try {
    assert.equal("checkTimeoutMs" in CODEX_CONFIG, false, "fixture precondition");
    const built = await runBuilder({
      root: repo, config: CODEX_CONFIG, task: CODEX_TASK,
      worktree: lane.worktree, branch: lane.branch, baseSha: base, attempt: 1,
    });
    assert.equal(built.outcome, "ready_to_integrate", JSON.stringify(built.verification?.checks));
    assert.deepEqual(built.verification.checks.map((c) => c.code), [0]);
    // A passing check carries no timeout bookkeeping — only a fired bound does.
    assert.equal("timedOut" in built.verification.checks[0], false);
  } finally {
    restore();
  }
});

// 73KB of real `xcodebuild test` output, captured on 2026-09-05 from a
// throwaway Swift package with one failing XCTAssertEqual. Its provenance is in
// scripts/fixtures/README.md. The point of using it rather than a string
// literal: nobody chose where in it the interesting line sits.
const XCODEBUILD = readFileSync(
  fileURLToPath(new URL("./fixtures/xcodebuild/failing-test.log", import.meta.url)),
  "utf8",
);

const xcodebuildAttempt = () => renderPriorAttempts([{
  attempt: 1,
  producedFiles: ["Sources/ClipDemo/ClipDemo.swift"],
  tokens: { input: 10, output: 10 },
  checks: [{ command: "xcodebuild test -scheme ClipDemo-Package -destination platform=macOS", code: 65, output: XCODEBUILD }],
}]);

test("the retry evidence from a real xcodebuild failure names the failing test", () => {
  // Head-clipping was the wrong end for a build tool. The first 2,000
  // characters of this transcript are the command line, a destination warning
  // and compile progress; the verdict is in the last 1,500.
  assert.equal(XCODEBUILD.slice(0, 2_000).includes("error:"), false,
    "fixture precondition: the head really is noise");

  const text = xcodebuildAttempt();
  assert.match(text, /XCTAssertEqual failed: \("hello"\) is not equal to \("goodbye"\)/);
  assert.match(text, /Test Case '-\[ClipDemoTests\.ClipDemoTests testGreetingIsGoodbye\]' failed/);
  assert.match(text, /\*\* TEST FAILED \*\*/);
});

test("the clipped block stays bounded, so failure mode 5 stays closed", () => {
  // AGENTS.md failure mode 5: a merger died on a ~1.3M-token prompt. The
  // tail-bias moves which 2,000 characters are carried and must not move how
  // many. Asserted against the 73KB fixture and against a 5MB output, because
  // "it looked short enough" is how the budget gets lost.
  const budget = 2_000;
  for (const [label, output] of [
    ["xcodebuild", XCODEBUILD],
    ["5MB of noise", "x".repeat(5_000_000)],
  ]) {
    const text = renderPriorAttempts([{
      attempt: 1, producedFiles: ["a.txt"], tokens: { input: 1, output: 1 },
      checks: [{ command: "npm test", code: 1, output }],
    }]);
    // The block is the clipped output plus the four short framing lines and a
    // four-space indent per line; well under twice the budget either way.
    assert.ok(text.length < budget * 2,
      `${label}: expected a bounded block, got ${text.length} chars`);
    assert.match(text, /more chars/);
  }
});
