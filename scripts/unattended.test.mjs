// scripts/unattended.test.mjs — what keeps an unattended lane working until the
// work is done, rather than until its first text-only turn.
//
// Opus 5.5 ends some turns with a progress note and no tool call. Under `-p`
// that ends the session; in a herdr pane it leaves the agent idle. Either way
// the runner used to hand a half-done lane to the verifier as finished.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentCommand, openChecklistItems, TIME_BUDGET_FILE, TIME_BUDGET_HOOK, withTimeBudget } from "./lib.mjs";
import { runFixer } from "./fixer.mjs";
import { runBuilder } from "./worker.mjs";
import { createTaskWorktree } from "./worktree.mjs";
import { ROLES, roleAgent, roleFor, rolePrompt } from "./roles.mjs";
import { laneAgentStartArgs } from "./runtime-herdr.mjs";
import { defaultPromptPath } from "./prompts.mjs";

const STANDING = "A standing instruction from the runner";

test("the standing instruction rides the system prompt of every unattended working role", () => {
  const unattended = Object.values(ROLES).filter((role) => role.unattended).map((role) => role.name);
  assert.deepEqual(unattended.sort(), ["fixer", "implementer", "integrator", "verifier"]);
  for (const name of unattended) {
    const agent = roleAgent(roleFor(name), {}, "claude");
    assert.ok(agent.appendSystemPrompt?.startsWith(STANDING), `${name} carries no standing instruction`);
  }
  // Single-answer roles: one JSON verdict, nothing to keep going on.
  for (const name of ["plan-reviewer", "supervisor", "reflector"]) {
    assert.doesNotMatch(roleAgent(roleFor(name), {}, "claude").appendSystemPrompt, new RegExp(STANDING), name);
  }
});

test("every Claude role carries the host rules on simulators", () => {
  for (const name of Object.keys(ROLES)) {
    const append = roleAgent(roleFor(name), {}, "claude").appendSystemPrompt ?? "";
    assert.match(append, /Leave no simulators behind/, name);
    assert.match(append, /agent-device close --shutdown/, name);
  }
});

test("the standing instruction names the legitimate stop, not the user", () => {
  const text = readFileSync(defaultPromptPath("_unattended"), "utf8");
  assert.match(text, /report\.mjs --status failed --reason/);
  assert.doesNotMatch(text, /\bthe user\b/i);
});

// Codex gets no --append-system-prompt and no hooks, so what the prompt file
// promises has to depend on the backend: the budget line only where the hook
// exists, the short no-offer line only where the standing instruction does not.
const TASK = { id: "7", title: "t", allowedPaths: ["**"], checks: ["true"] };
const promptFor = (role, backend) =>
  rolePrompt(roleFor(role), {}, role === "implementer" ? { task: TASK, taskText: "SPEC", backend } : { epic: { id: 1 }, branch: "b", schema: "{}", backend });

test("the implementer prompt carries the short no-offer line only for Codex", () => {
  assert.doesNotMatch(promptFor("implementer", "claude"), /Nobody reads your output until you exit/);
  assert.match(promptFor("implementer", "codex"), /Nobody reads your output until you exit/);
});

test("the elapsed-time line is promised only where the hook delivers it", () => {
  for (const role of ["implementer", "fixer"]) {
    assert.match(promptFor(role, "claude"), /elapsed <N>s \/ <budget>s/, role);
    assert.doesNotMatch(promptFor(role, "codex"), /elapsed/, role);
  }
});

test("a herdr lane passes the standing instruction as a file, byte for byte", () => {
  const agent = roleAgent(roleFor("implementer"), {}, "claude");
  const dir = mkdtempSync(join(tmpdir(), "afk-unattended-"));
  try {
    const argv = laneAgentStartArgs({ name: "afk-1-1", pane: "p", agent, launchDir: dir });
    const i = argv.indexOf("--append-system-prompt-file");
    assert.ok(i !== -1, `no --append-system-prompt-file in ${argv.join(" ")}`);
    assert.equal(readFileSync(argv[i + 1], "utf8"), agent.appendSystemPrompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The direct runtime builds a shell string, and the paragraph is full of
// quotes, backticks and a `$`-free but apostrophe-heavy register. Run the
// command through a real shell against a fake `claude` that prints its argv.
test("the direct runtime's command hands the paragraph to claude byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-unattended-"));
  try {
    const fake = join(dir, "claude");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const promptPath = join(dir, "prompt.md");
    const streamPath = join(dir, "stream.jsonl");
    writeFileSync(promptPath, "hi\n");
    const agent = { ...roleAgent(roleFor("fixer"), {}, "claude"), command: fake };
    const command = buildAgentCommand(agent, { nodeBin: "", promptPath, streamPath, taskId: "t", processName: "p" });
    const ran = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const argv = JSON.parse(readFileSync(streamPath, "utf8"));
    assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], agent.appendSystemPrompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open checklist items are the unticked task lines, nothing else", () => {
  const text = "# Plan\n- [x] Resolve\n- [ ] Test the parser \n* [ ] Report\n1. [ ] Numbered\n- [X] Done too\n- found: a note\n[ ] not a list item\n";
  assert.deepEqual(openChecklistItems(text), ["Test the parser", "Report", "Numbered"]);
  assert.deepEqual(openChecklistItems(""), []);
  assert.deepEqual(openChecklistItems(undefined), []);
});

// The direct runtime: `-p` exits 0 on a text-only turn. A fake `claude` stops
// the first time with an item open, and ticks it when resumed.
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

// `resume`: what the resumed session does — "tick" finishes the work, "fail"
// exits 1, "hang" never returns. `firstSleepMs` spends budget in the first run.
const directLane = ({ sessionId = "sess-1", resume = "tick", firstSleepMs = 0 } = {}) => {
  const repo = mkdtempSync(join(tmpdir(), "afk-continue-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD").stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: "401", baseSha });
  const bin = mkdtempSync(join(tmpdir(), "afk-continue-bin-"));
  const resumed = join(bin, "resumed.json");
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const saved = ${JSON.stringify(join(bin, "checklist-path"))};
  if (argv.includes('--resume')) {
    fs.writeFileSync(${JSON.stringify(resumed)}, JSON.stringify({ argv, input }));
    if (${JSON.stringify(resume)} === 'fail') process.exit(1);
    if (${JSON.stringify(resume)} === 'hang') return setTimeout(() => {}, 1e9);
    fs.writeFileSync(fs.readFileSync(saved, 'utf8'), '- [x] Implement\\n- [x] Test\\n');
    fs.writeFileSync('tested.txt', 'yes\\n');
  } else {
    const checklist = input.match(/\\\`(\\/tmp\\/[^\\\`]*checklist\\.md)\\\`/)[1];
    fs.writeFileSync(saved, checklist);
    fs.writeFileSync(checklist, '- [x] Implement\\n- [ ] Test\\n');
    fs.writeFileSync('feature.txt', 'built\\n');
  }
  const reply = argv.includes('--resume') ? 'Done.' : 'REPORT: Changed feature.txt; the tests are next.';
  setTimeout(() => {
    line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', ${sessionId ? `session_id: ${JSON.stringify(sessionId)}` : ""} });
    line({ type: 'result', subtype: 'success', result: reply });
  }, argv.includes('--resume') ? 0 : ${firstSleepMs});
});
`);
  chmodSync(join(bin, "claude"), 0o755);
  return { repo, lane, baseSha, bin, resumed };
};

const buildDirect = async ({ repo, lane, baseSha, bin }, timeoutMs = 20_000) => {
  const lines = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const built = await runBuilder({
      root: repo,
      config: {
        maxParallel: 1,
        defaultChecks: [],
        agent: { command: "claude", model: "claude-opus-5-5", bypassPermissions: true, timeoutMs, runtime: "direct" },
      },
      task: { id: "401", title: "Build and test", dependsOn: [], allowedPaths: ["**"], checks: [], body: "# 401\n" },
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha,
      attempt: 1,
      say: (line) => lines.push(line),
    });
    return { built, lines };
  } finally {
    process.env.PATH = previousPath;
  }
};

test("a direct builder that exits with checklist items open is resumed on them", async () => {
  const fx = directLane();
  const { built, lines } = await buildDirect(fx);
  assert.ok(existsSync(fx.resumed), `never resumed: ${JSON.stringify(lines)}`);
  const { argv, input } = JSON.parse(readFileSync(fx.resumed, "utf8"));
  assert.equal(argv[argv.indexOf("--resume") + 1], "sess-1");
  assert.match(input, /^Your checklist still has open items: Test\. Continue with them\./);
  // The lane's clock rides its settings: a PostToolUse hook reading the
  // budget file the runner wrote into this attempt's run directory at spawn.
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  const hook = settings.hooks.PostToolUse[0].hooks[0].command;
  assert.match(hook, /time-budget-hook\.sh' '.*\/\.afk\/runs\/401\/builder-1\/time-budget'$/);
  assert.ok(settings.permissions.deny.includes("Skill(herdr)"), "the hook replaced the permission profile");
  // The project-root guard names the RUN's checkout, which here is not the
  // runner's cwd (as under `afk epic --worktree`).
  assert.notEqual(realpathSync(fx.repo), realpathSync(process.cwd()));
  const guard = settings.hooks.PreToolUse.find((entry) => entry.matcher === "Write|Edit|MultiEdit|NotebookEdit");
  assert.ok(guard?.hooks[0].command.includes(`'${fx.repo}'`), `guard names ${fx.repo}: ${guard?.hooks[0].command}`);
  // And names the lane it runs in: the one directory under the lanes dir its
  // file tools may write. Every other lane is a sibling and refused.
  assert.ok(guard.hooks[0].command.endsWith(` '${fx.lane.worktree}'`), `guard names the lane: ${guard.hooks[0].command}`);
  // The continuation's work is the lane's work, and its ticks are what was kept.
  assert.equal(built.outcome, "ready_to_integrate");
  assert.match(git(fx.repo, "show", "--name-only", "--format=", built.commitSha).stdout, /tested\.txt/);
  assert.match(readFileSync(built.verification.checklistPath, "utf8"), /- \[x\] Test/);
  rmSync(fx.repo, { recursive: true, force: true });
});

// A continuation must never leave the lane worse off than not sending it.
for (const resume of ["fail", "hang"]) {
  test(`a resumed session that ${resume === "fail" ? "exits non-zero" : "times out"} does not fail a lane that had finished`, async () => {
    const fx = directLane({ resume });
    // 12s, not 6s: the resume floor is a quarter of the budget, and at 6s a
    // first session slowed past 4.5s by host load (load average 25 on 15
    // cores, 2026-10-06) left too little to resume and failed "never resumed".
    const { built } = await buildDirect(fx, 12_000);
    assert.ok(existsSync(fx.resumed), "never resumed");
    assert.equal(built.outcome, "ready_to_integrate");
    assert.equal(built.verification.agentExitCode, 0);
    assert.equal(built.verification.timedOut, false);
    rmSync(fx.repo, { recursive: true, force: true });
  });
}

test("a direct builder with too little budget left is not resumed", async () => {
  // Floor is min(5 min, a quarter of 20s) = 5s; the first run spends 15.5s,
  // leaving 4.5s before the lane's kill for node startup under load.
  const fx = directLane({ firstSleepMs: 15_500 });
  const { built } = await buildDirect(fx, 20_000);
  assert.equal(existsSync(fx.resumed), false);
  assert.equal(built.outcome, "ready_to_integrate");
  rmSync(fx.repo, { recursive: true, force: true });
});

// The first session's closing text is the builder's report; a continuation's
// "Done." must not be the only thing agent-output.log keeps.
test("a continued builder's log keeps the first session's report", async () => {
  const fx = directLane();
  await buildDirect(fx);
  const log = readFileSync(join(fx.repo, ".afk", "runs", "401", "builder-1", "agent-output.log"), "utf8");
  assert.match(log, /REPORT: Changed feature\.txt/);
  assert.match(log, /Done\./);
  rmSync(fx.repo, { recursive: true, force: true });
});

test("the hook is silent when the clock file is missing", () => {
  const none = spawnSync("sh", [TIME_BUDGET_HOOK, join(tmpdir(), "afk-no-such-clock")], { encoding: "utf8" });
  assert.equal(none.status, 0);
  assert.equal(none.stderr, "");
});

test("a direct builder with no session to resume keeps the old behaviour", async () => {
  const fx = directLane({ sessionId: null });
  const { built } = await buildDirect(fx);
  assert.equal(existsSync(fx.resumed), false);
  assert.equal(built.outcome, "ready_to_integrate");
  rmSync(fx.repo, { recursive: true, force: true });
});

// --- the time budget --------------------------------------------------------
// Builder and fixer lanes are killed at `agent.timeoutMs` with the work thrown
// away. The agent is shown its clock after every tool call so it can leave
// time for the checks and the report.

test("withTimeBudget writes the clock and adds the hook without losing the profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-budget-"));
  try {
    const agent = { backend: "claude", timeoutMs: 1_800_000, settings: JSON.stringify({ permissions: { deny: ["Write"] } }) };
    const out = withTimeBudget(agent, dir, 1_700_000_000_500);
    assert.equal(readFileSync(join(dir, TIME_BUDGET_FILE), "utf8"), "1700000000 1800\n");
    const settings = JSON.parse(out.settings);
    assert.deepEqual(settings.permissions.deny, ["Write"]);
    assert.deepEqual(settings.hooks.PostToolUse, [{
      matcher: "",
      hooks: [{ type: "command", command: `sh '${TIME_BUDGET_HOOK}' '${join(dir, TIME_BUDGET_FILE)}'` }],
    }]);
    // No settings at all still gets the hook.
    assert.ok(JSON.parse(withTimeBudget({ backend: "claude", timeoutMs: 1000 }, dir).settings).hooks);
    // Codex has no hooks: the agent is untouched.
    const codex = { backend: "codex", timeoutMs: 1000 };
    assert.equal(withTimeBudget(codex, dir), codex);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook prints elapsed against budget as PostToolUse additionalContext", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-budget-"));
  try {
    const file = join(dir, TIME_BUDGET_FILE);
    writeFileSync(file, `${Math.floor(Date.now() / 1000) - 42} 900\n`);
    const ran = spawnSync("sh", [TIME_BUDGET_HOOK, file], { input: '{"tool_name":"Bash"}', encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const out = JSON.parse(ran.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /^elapsed 4[23]s \/ 900s$/);
    // No clock, no output, no failure: a missing file must never block a tool.
    const none = spawnSync("sh", [TIME_BUDGET_HOOK, join(dir, "absent")], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fixer runs with the time budget hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "afk-budget-fixer-"));
  try {
    let seen = null;
    const review = { status: "ok", summary: "s", head: "abc", mustFix: ["Write the renderer."], findings: [], criteria: [] };
    await runFixer({
      root, config: {}, dag: { epic: { id: 9 }, tasks: [] }, verifierReport: review,
      runAgent: async ({ agent }) => { seen = agent; return { status: 0, timedOut: false }; },
    });
    assert.ok(seen, "the fixer never ran its agent");
    assert.match(JSON.parse(seen.settings).hooks.PostToolUse[0].hooks[0].command, /time-budget-hook\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

