// scripts/selftest.mjs — regression tests for the runner's own logic.
// Run: afk selftest
// These cover the parts where a silent bug corrupts a whole unattended run:
// scope matching (wrongly reverts in-scope work) and status parsing (mangles
// paths, so files are never staged). Each test names the failure it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeConfig } from "./test-helpers.mjs";
import { finishBlockers, pruneLanes } from "./finish.mjs";
import {
  pathAllowed,
  parseStatusPaths,
  isBookkeeping,
  isProtectedPath,
  isStatusFlushPath,
  isRunnerOwned,
  agentConfig,
  buildAgentCommand,
  resolveBackend,
  agentProcessName,
  mergerProcessName,
  ready,
  globToRegExp,
  ownScope,
  ownsOverlap,
  discardAttempt,
  isRustPath,
  isRustCheck,
  shouldSkipRustChecks,
  checkFailed,
  normalizeId,
  mergeProgress,
  renderProgress,
  lifecycleOf,
  looksLikeAuthDeath,
  notify,
  flushNotifications,
  resetNotifyState,
  NOTIFY_LEVELS,
  NOTIFY_ONLY,
  PROTECTED_PREFIXES,
  configPath,
  loadConfig,
} from "./lib.mjs";
import {
  parseStream,
  finalText,
  format,
  timeline,
  CONTEXT_LIMIT,
} from "./agent-stats.mjs";
import {
  CODEX_ROLE_TIERS,
  CWD,
  ROLES,
  codexSandbox,
  preflightSettings,
  roleAgent,
  roleFor,
  settingsArg,
} from "./roles.mjs";
import {
  canStartIntegration,
  deferralAnnouncements,
  enqueueIntegration,
  INFRA_FAILURE_MS,
  looksLikeInfra,
  neverReachedApi,
  nextBuilderTasks,
  planBuilderBatch,
  preflightBlockers,
  repoWideScope,
  reconcileStaleState,
  reconcileWithDag,
  schedulerDone,
  shouldRetryBuilder,
  lifecycleOf as schedulerLifecycleOf,
} from "./scheduler.mjs";
import {
  bootstrapWorktree,
  createRoleCwd,
  createTaskWorktree,
  pruneRoleCwds,
  removeRoleCwd,
  resetTaskWorktree,
  roleCwd,
  taskBranch,
  taskWorktree,
} from "./worktree.mjs";
import { restoreMain } from "./integrate.mjs";
import { postMergeChecks, runIntegration } from "./integrate.mjs";
import { authCommands, herdrRefusal, normalizeDag, preflightLine } from "./auto.mjs";
import { runBuilder } from "./worker.mjs";

// Keep test lanes out of the real ~/.afk-claude — a selftest run must not leave
// worktrees in the user's home directory. Set before any worktree is created.
process.env.AFK_WORKTREE_ROOT ??= mkdtempSync(
  join(tmpdir(), "afk-selftest-worktrees-"),
);
// Same reason, different directory: a reflection written during a self-test
// would otherwise land in the runner's OWN docs/ under a project name that does
// not exist, and get committed by whoever ran the tests before looking.
process.env.AFK_REFLECTIONS_ROOT ??= mkdtempSync(
  join(tmpdir(), "afk-selftest-reflections-"),
);
import {
  checkSummary,
  depthsOf,
  mergeDashboardState,
  parseWorktrees,
  stageOf,
} from "./dashboard-data.mjs";

test("** crosses directory separators", () => {
  // Regression: sequential `**`→`.*` then `*`→`[^/]*` yields `.[^/]*`, which
  // stops `**` crossing `/`. Nested files then get reverted as out-of-scope.
  assert.ok(globToRegExp("app/theme/**").test("app/theme/x/y.ts"));
  assert.ok(pathAllowed("app/theme/tokens.ts", ["app/theme/**"]));
  assert.ok(pathAllowed("app/theme/colors/dark.ts", ["app/theme/**"]));
  assert.ok(pathAllowed("app/theme/a/b/c/d.ts", ["app/theme/**"]));
});

test("** matches a directory-form path", () => {
  // Bare `git status --porcelain` collapses a wholly-untracked tree to `src/`.
  // auto.mjs passes -uall so it never should, and aborts if one appears anyway —
  // a collapsed `app/features/` matches a narrower `app/features/auth/**` not at
  // all, which silently drops a task's whole feature from its own commit. This
  // stays asserted because the directory form must not *widen* scope either.
  assert.ok(pathAllowed("src/", ["src/**"]));
  assert.ok(pathAllowed("app/theme/", ["app/theme/**"]));
  assert.ok(
    !pathAllowed("app/features/", ["app/features/auth/**"]),
    "the collapsed form does not match a deeper pattern — hence -uall and the abort",
  );
});

test("single * does not cross directory separators", () => {
  assert.ok(pathAllowed("app/screens/Root.tsx", ["app/screens/*"]));
  assert.ok(!pathAllowed("app/screens/nested/Root.tsx", ["app/screens/*"]));
  assert.ok(pathAllowed("tsconfig.build.json", ["tsconfig.*.json"]));
});

test("regex metacharacters in patterns are literal, not wildcards", () => {
  assert.ok(pathAllowed("app/(tabs)/index.tsx", ["app/(tabs)/**"]));
  assert.ok(pathAllowed("a+b/c.ts", ["a+b/**"]));
  assert.ok(
    !pathAllowed("packageXjson", ["package.json"]),
    "`.` must not match any char",
  );
  assert.doesNotThrow(() =>
    pathAllowed("x", ["[unclosed", "a|b", "^$", "a{2}"]),
  );
});

test("an empty allow-list allows nothing", () => {
  assert.ok(!pathAllowed("anything.ts", []));
});

test("a scope claim resolves to the directory it cannot reach outside of", () => {
  assert.equal(ownScope("Sources/Feature/View.swift"), "Sources/Feature/View.swift");
  assert.equal(ownScope("Sources/Feature/"), "Sources/Feature", "a trailing slash is punctuation");
  assert.equal(ownScope("src-tauri/**"), "src-tauri");
  assert.equal(ownScope("app/screens/*"), "app/screens");
  // Repo-wide, and the whole `["**"]` opt-out hangs off this one answer.
  assert.equal(ownScope("**"), "");
  // Globbed at the first segment: nothing narrower than the repo can be proven,
  // so it answers repo-wide and the scheduler leaves it unconstrained.
  assert.equal(ownScope("tsconfig.*.json"), "");
});

test("scope overlap is directory-prefix aware, per segment not per character", () => {
  assert.ok(ownsOverlap("Sources/Feature/", "Sources/Feature/View.swift"));
  assert.ok(ownsOverlap("Sources/Feature/View.swift", "Sources/Feature"));
  assert.ok(ownsOverlap("src-tauri/**", "src-tauri/src/main.rs"));
  assert.ok(!ownsOverlap("Sources/A/", "Sources/B/"));
  assert.ok(
    !ownsOverlap("Sources/Feature", "Sources/FeatureFlags"),
    "a raw startsWith would call these a collision; they share no file",
  );
  // Fails closed here on purpose: repo-wide DOES touch every file. Only the
  // scheduler reads repo-wide as "unconstrained", and it drops those claims
  // before they reach this function rather than asking it to guess.
  assert.ok(ownsOverlap("**", "Sources/A/x.swift"));
});

test("porcelain parse keeps the first path intact", () => {
  // Regression: trimming the whole blob before splitting eats the leading space
  // of ` M path`, so the first file becomes `gent-auto.log` and is dropped.
  const porcelain =
    " M agent-auto.log\n M docs/progress.md\n?? src/\n?? runs/204/\n";
  assert.deepEqual(parseStatusPaths(porcelain), [
    "agent-auto.log",
    "docs/progress.md",
    "src/",
    "runs/204/",
  ]);
});

test("porcelain parse handles staged, renamed and quoted paths", () => {
  assert.deepEqual(parseStatusPaths("A  src/new.ts\n"), ["src/new.ts"]);
  assert.deepEqual(parseStatusPaths("R  src/old.ts -> src/new.ts\n"), [
    "src/new.ts",
  ]);
  assert.deepEqual(parseStatusPaths('?? "has space.ts"\n'), ["has space.ts"]);
  assert.deepEqual(parseStatusPaths("MM src/both.ts\n"), ["src/both.ts"]);
  assert.deepEqual(parseStatusPaths(""), []);
});

test("the runner cannot be edited by the agents it supervises", () => {
  assert.ok(isRunnerOwned(".agent-locks/orchestrator.lock"));
  assert.ok(isRunnerOwned(".afk/state.json"));
  assert.ok(
    !isRunnerOwned("scripts/build.mjs"),
    "project scripts are ordinary task code; runner code is external",
  );
  assert.ok(!isRunnerOwned("app/scripts/build.ts"));
});

test("bookkeeping files are exempt from scope enforcement", () => {
  assert.ok(isBookkeeping("runs/204/report.md"));
  assert.ok(isBookkeeping("docs/progress.md"));
  assert.ok(
    isBookkeeping("docs/progress/673.md"),
    "and the per-epic progress file that replaced it (#122)",
  );
  assert.ok(isBookkeeping(".afk-setup/config.yaml"));
  assert.ok(isBookkeeping("agent-auto.log"));
  assert.ok(!isBookkeeping("src/greet.mjs"));
  assert.ok(
    isBookkeeping("dist/main.js", { bookkeepingPrefixes: ["dist/"] }),
    "the project config can add prefixes",
  );
  assert.ok(!isBookkeeping("dist/main.js"));
});

test("the three path classifiers all follow the per-epic progress file", () => {
  // `docs/progress.md` was a literal string in three separate lists, and a per
  // epic path is a different string: it falls out of all three silently (#122).
  // What each one costs when missed — the reason this test names them together:
  //   isBookkeeping  — the flush reads as an agent's out-of-scope edit.
  //   isProtectedPath — a lane may quietly rewrite the runner's status file.
  //   isStatusFlushPath — every closeout caveats verdicts nothing invalidated.
  assert.ok(isProtectedPath("docs/progress.md"));
  assert.ok(isProtectedPath("docs/progress/673.md"));
  assert.ok(isStatusFlushPath("docs/progress.md"));
  assert.ok(isStatusFlushPath("docs/progress/673.md"));
  assert.ok(!isProtectedPath("docs/architecture.md"), "and neither swallows the rest of docs/");
  assert.ok(!isStatusFlushPath("docs/architecture.md"));
});

test("agent config falls back to defaults and merges config overrides", () => {
  const bare = agentConfig({});
  assert.equal(bare.command, "claude");
  assert.equal(bare.model, "claude-opus-5-5");
  assert.equal(bare.reasoningEffort, "medium");
  assert.equal(bare.bypassPermissions, true);
  assert.ok(bare.timeoutMs > 0);
  const custom = agentConfig({
    agent: {
      model: "claude-sonnet-5",
      reasoningEffort: "low",
      bypassPermissions: false,
      permissionMode: "plan",
    },
  });
  assert.equal(custom.command, "claude");
  assert.equal(custom.model, "claude-sonnet-5");
  assert.equal(custom.reasoningEffort, "low");
  assert.equal(custom.permissionMode, "plan");
  assert.equal(custom.bypassPermissions, false);
  assert.throws(
    () => agentConfig({ agent: { command: "codex" } }),
    /supports only/,
  );
  assert.throws(
    () => agentConfig({ agent: { command: "other" } }),
    /supports only/,
  );
});

test("the default invocation runs Claude Code with medium effort", () => {
  const full = buildAgentCommand(agentConfig({}), {
    nodeBin: "/runtime/bin",
    promptPath: "runs/204/prompt.md",
    streamPath: "runs/204/stream.jsonl",
  });
  assert.match(full, /'claude' -p --output-format stream-json --verbose/);
  assert.match(full, /--dangerously-skip-permissions/);
  assert.match(full, /--effort 'medium'/);
  assert.match(full, /--model 'claude-opus-5-5'/);
  assert.match(full, /< 'runs\/204\/prompt\.md' > 'runs\/204\/stream\.jsonl' 2>&1/);

  const gated = buildAgentCommand(
    agentConfig({ agent: { bypassPermissions: false } }),
    {
      nodeBin: "/runtime/bin",
      promptPath: "prompt.md",
      streamPath: "stream.jsonl",
    },
  );
  assert.match(gated, /--permission-mode 'acceptEdits'/);
  assert.doesNotMatch(gated, /dangerously-skip-permissions/);
});

test("a named run labels the worker process and exports its task id", () => {
  const paths = {
    nodeBin: "/runtime/bin",
    promptPath: "runs/262/prompt.md",
    streamPath: "runs/262/stream.jsonl",
    taskId: "262",
  };

  const named = buildAgentCommand(agentConfig({}), paths);
  assert.match(named, /export RUNNER_TASK_ID='262';/);
  assert.match(named, /exec bash -c 'exec -a "\$0" "\$@"' 'agent-262' 'claude' -p/);

  // Task ids are data from the DAG: they must not break out of the label.
  const nasty = buildAgentCommand(agentConfig({}), {
    ...paths,
    taskId: "9'; rm -rf /",
  });
  assert.match(nasty, /"\$@"' 'agent-9'\\''; rm -rf \//);
  assert.equal(agentProcessName("262"), "agent-262");
});

// Every caller runs the command under `sh -c` (lib.mjs `run`/`runAsync`), and
// /bin/sh is dash on most Linux machines: `exec -a` there is "-a: not found",
// exit 127, and no agent ever starts. Run it the way the runner does.
test("a named run starts its agent under plain sh, not only under bash", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-named-launch-"));
  try {
    writeFileSync(join(dir, "claude"), '#!/bin/sh\ncat > /dev/null\necho "ran $RUNNER_TASK_ID"\n', { mode: 0o755 });
    writeFileSync(join(dir, "prompt.md"), "hi\n");
    const command = buildAgentCommand({ command: "claude", model: "m" }, {
      nodeBin: "/runtime/bin",
      promptPath: join(dir, "prompt.md"),
      streamPath: join(dir, "stream.jsonl"),
      taskId: "262",
    });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}${readFileSync(join(dir, "stream.jsonl"), "utf8")}`);
    assert.equal(readFileSync(join(dir, "stream.jsonl"), "utf8"), "ran 262\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// npm installs `claude` beside `node`. Prepending the runner's node directory
// made every agent launch run THAT copy instead of the one the caller's PATH
// names — a test's fake, or a newer native install that preflight had checked.
test("the agent is the caller's `claude`, not one that sits beside the runner's node", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-agent-path-"));
  try {
    for (const [sub, said] of [["caller", "caller"], ["nodebin", "beside node"]]) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, "claude"), `#!/bin/sh\ncat > /dev/null\necho '${said}'\n`, { mode: 0o755 });
    }
    writeFileSync(join(dir, "prompt.md"), "hi\n");
    for (const taskId of [undefined, "262"]) {
      const command = buildAgentCommand({ command: "claude", model: "m" }, {
        nodeBin: join(dir, "nodebin"),
        promptPath: join(dir, "prompt.md"),
        streamPath: join(dir, "stream.jsonl"),
        taskId,
      });
      const env = { ...process.env, PATH: `${join(dir, "caller")}:${process.env.PATH}` };
      const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(dir, "stream.jsonl"), "utf8"), "caller\n", `taskId ${taskId}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unnamed run (no taskId) keeps the plain launch form", () => {
  const command = buildAgentCommand(agentConfig({}), {
    nodeBin: "/runtime/bin",
    promptPath: "prompt.md",
    streamPath: "stream.jsonl",
  });
  assert.doesNotMatch(command, /exec -a|RUNNER_TASK_ID/);
  assert.match(
    command,
    /export PATH="\$PATH:\/runtime\/bin"; 'claude' -p/,
  );
});

// --- the two backends -------------------------------------------------------
// One implementation, two executables: `afk` resolves Claude, `afk-codex`
// resolves Codex. The executable is authoritative and reaches the shared
// scripts in the environment, so everything below pins the seam between them —
// each provider's flags, models and efforts must stay on their own side of it.

const AGENT_PATHS = {
  nodeBin: "/runtime/bin",
  promptPath: "runs/41/prompt.md",
  streamPath: "runs/41/stream.jsonl",
};

// The Claude arguments a Codex command must never carry, and vice versa. Named
// as data because the assertion is symmetric and a leak in either direction is
// the same bug: a command line built for the provider that is not running it.
const CLAUDE_ONLY = [
  / -p /,
  /--output-format stream-json/,
  /--verbose/,
  /--effort /,
  /--permission-mode/,
  /--settings /,
  /--dangerously-skip-permissions/,
];
const CODEX_ONLY = [/--sandbox/, /--ask-for-approval/, /--add-dir/, /--cd /, /model_reasoning_effort/];

test("an unknown backend fails before an agent command is built", () => {
  assert.throws(() => resolveBackend("gemini"), /Unknown agent backend "gemini"/);
  assert.throws(() => agentConfig({}, "gemini"), /Unknown agent backend/);
  // And a hand-assembled agent record naming one refuses at the builder, which
  // is the last gate before a provider's CLI is spawned.
  assert.throws(
    () => buildAgentCommand({ ...agentConfig({}), backend: "gemini" }, AGENT_PATHS),
    /Unknown agent backend/,
  );
  // Absent means Claude — the auth probe and a few callers assemble a record by
  // hand, and they must keep working.
  assert.equal(resolveBackend(undefined), "claude");
  assert.match(buildAgentCommand({ command: "claude", model: "claude-opus-5" }, AGENT_PATHS), /'claude' -p/);
});

test("the Codex invocation is `codex exec --json`, and carries no Claude argument", () => {
  const command = buildAgentCommand(agentConfig({}, "codex"), { ...AGENT_PATHS, taskId: "41" });
  assert.match(command, /'codex' --ask-for-approval 'never' exec --json/);
  assert.match(command, /--model 'gpt-5\.6-sol'/);
  assert.match(command, /-c 'model_reasoning_effort=medium'/);
  assert.match(command, /--sandbox 'workspace-write'/);
  // The working directory is always named. With no `cwd` in paths it is the
  // shell's own, which every caller already sets to the lane worktree.
  assert.match(command, /--cd "\$PWD"/);
  assert.match(
    buildAgentCommand(agentConfig({}, "codex"), { ...AGENT_PATHS, cwd: "/tmp/wt/41" }),
    /--cd '\/tmp\/wt\/41'/,
  );
  // Prompt on stdin, JSONL to the path the runner reads back.
  assert.match(command, /< 'runs\/41\/prompt\.md' > 'runs\/41\/stream\.jsonl' 2>&1/);
  for (const flag of CLAUDE_ONLY)
    assert.doesNotMatch(command, flag, `a Codex command carries ${flag}`);
});

test("the Claude invocation is unchanged, and carries no Codex argument", () => {
  const command = buildAgentCommand(agentConfig({}), { ...AGENT_PATHS, taskId: "41" });
  assert.match(command, /'claude' -p --output-format stream-json --verbose/);
  for (const flag of CODEX_ONLY)
    assert.doesNotMatch(command, flag, `a Claude command carries ${flag}`);
});

test("every role resolves to exactly one Codex tier", () => {
  // Sol/medium reviews and merges; Luna/max writes. Table-driven and exhaustive
  // on purpose: a role added without a tier chosen for it would otherwise run
  // on whatever the defaults happened to be, which is a model choice made by
  // accident and paid for on every lane.
  const expected = {
    "plan-reviewer": ["gpt-5.6-sol", "medium"],
    integrator: ["gpt-5.6-sol", "medium"],
    fixer: ["gpt-5.6-sol", "medium"],
    verifier: ["gpt-5.6-sol", "medium"],
    supervisor: ["gpt-5.6-sol", "medium"],
    implementer: ["gpt-5.6-luna", "max"],
    reflector: ["gpt-5.6-luna", "max"],
  };
  assert.deepEqual(
    Object.keys(ROLES).sort(),
    Object.keys(expected).sort(),
    "a role exists with no Codex tier asserted for it",
  );
  assert.deepEqual(Object.keys(CODEX_ROLE_TIERS).sort(), Object.keys(expected).sort());
  for (const [name, [model, reasoningEffort]] of Object.entries(expected)) {
    const agent = roleAgent(roleFor(name), {}, "codex");
    assert.equal(agent.model, model, `${name} model`);
    assert.equal(agent.reasoningEffort, reasoningEffort, `${name} effort`);
    assert.equal(agent.command, "codex", `${name} command`);
    // Every one of them reaches a real command line with those values on it.
    const command = buildAgentCommand(agent, AGENT_PATHS);
    assert.match(command, new RegExp(`--model '${model.replace(/\./g, "\\.")}'`));
    assert.match(command, new RegExp(`model_reasoning_effort=${reasoningEffort}'`));
    for (const flag of CLAUDE_ONLY)
      assert.doesNotMatch(command, flag, `${name}'s Codex command carries ${flag}`);
  }
  // The filesystem boundary is the Claude profile's intent, re-rendered: a role
  // that may write its own worktree is a writer, a reviewer is read-only.
  // Exhaustive over the roles, for the reason the tier table above is: asserting
  // four of the seven let docs/permissions.md ship a `fixer` row saying
  // read-only while the code returned workspace-write, and the table is what
  // 42.8 and 43.4 rest on. A role added without a mode named here fails.
  const sandboxes = {
    implementer: "workspace-write",
    reflector: "workspace-write",
    integrator: "workspace-write",
    fixer: "workspace-write",
    "plan-reviewer": "read-only",
    verifier: "read-only",
    supervisor: "read-only",
  };
  assert.deepEqual(
    Object.keys(ROLES).sort(),
    Object.keys(sandboxes).sort(),
    "a role exists with no Codex sandbox mode asserted for it",
  );
  for (const [name, mode] of Object.entries(sandboxes))
    assert.equal(codexSandbox(roleFor(name)), mode, `${name} sandbox`);
  // The mode the table names is the mode that reaches the command line.
  for (const [name, mode] of Object.entries(sandboxes))
    assert.match(
      buildAgentCommand(roleAgent(roleFor(name), {}, "codex"), AGENT_PATHS),
      new RegExp(`--sandbox '${mode}'`),
      `${name} command line`,
    );
});

test("a Claude model never reaches a Codex command, and a Claude config still loads", () => {
  // The real .afk-setup/config.yaml of every project on this runner: a Claude
  // model globally and Claude models per role. `afk-codex` must LOAD it — the
  // file is shared by both executables — and must ignore every one of those
  // values rather than passing `claude-fable-5` to the Codex CLI.
  const config = {
    agent: { model: "claude-opus-5", reasoningEffort: "low", timeoutMs: 123_000 },
    roles: { "plan-reviewer": { model: "claude-fable-5", reasoningEffort: "high" } },
  };
  const codex = roleAgent(roleFor("plan-reviewer"), config, "codex");
  assert.equal(codex.model, "gpt-5.6-sol");
  assert.equal(codex.reasoningEffort, "medium");
  // A backend-neutral key still comes from the config. Asserted on a role that
  // pins no timeout of its own — plan-reviewer pins 5 minutes deliberately.
  assert.equal(roleAgent(roleFor("implementer"), config, "codex").timeoutMs, 123_000);
  assert.doesNotMatch(buildAgentCommand(codex, AGENT_PATHS), /claude/);
  // And the Claude path is untouched by any of this.
  const claude = roleAgent(roleFor("plan-reviewer"), config, "claude");
  assert.equal(claude.model, "claude-fable-5");
  assert.equal(claude.reasoningEffort, "high");
  // A project that genuinely wants to move a role between tiers says so in the
  // Codex-specific key, which is the only one read here.
  assert.equal(
    roleAgent(roleFor("verifier"), { roles: { verifier: { codex: { model: "gpt-5.6-luna" } } } }, "codex").model,
    "gpt-5.6-luna",
  );
});

test("malformed Codex configuration fails before an agent command is built", () => {
  // Fails CLOSED at load, like `maxBuilderRetries`: a Codex run whose model or
  // effort was silently dropped is a whole epic on the wrong tier, discovered
  // by its bill.
  assert.throws(
    () => agentConfig({ agent: { codex: { model: "claude-opus-5" } } }, "codex"),
    /must be a Codex model name/,
  );
  assert.throws(
    () => agentConfig({ agent: { codex: { reasoningEffort: "turbo" } } }, "codex"),
    /reasoningEffort must be one of/,
  );
  assert.throws(
    () => agentConfig({ agent: { codex: "gpt-5.6-luna" } }, "codex"),
    /agent\.codex must be a mapping/,
  );
  assert.throws(
    () => roleAgent(roleFor("fixer"), { roles: { fixer: { codex: { model: "claude-opus-5" } } } }, "codex"),
    /roles\.fixer\.codex\.model must be a Codex model name/,
  );
  // And a record that reached the builder with a bad value still refuses there:
  // several roles assemble their agent by spreading over `roleAgent`'s result.
  assert.throws(
    () => buildAgentCommand({ ...agentConfig({}, "codex"), model: "claude-opus-5" }, AGENT_PATHS),
    /must be a Codex model name/,
  );
  assert.throws(
    () => buildAgentCommand({ ...agentConfig({}, "codex"), reasoningEffort: null }, AGENT_PATHS),
    /reasoningEffort must be one of/,
  );
});

test("every role is a record, and the two that exist inherit the project agent", () => {
  // The point of roles-as-data: `plan-reviewer`, `verifier` and `supervisor`
  // must be addable as an entry here, not as a branch in worker/integrate.
  const required = ["prompt", "model", "permissions", "phases", "pane", "timeoutMs"];
  for (const [name, role] of Object.entries(ROLES)) {
    for (const field of required)
      assert.ok(field in role, `role ${name} is missing ${field}`);
    assert.equal(typeof role.prompt, "function");
    assert.ok(Array.isArray(role.phases) && role.phases.length > 0);
    assert.ok(["lane", "parent"].includes(role.pane));
  }
  // The two roles that predate the epic spec layer are still here and still
  // records. This is deliberately not an exhaustive key list: roles added since
  // (Lane H's `verifier`, and `plan-reviewer`/`supervisor` when they land) are
  // entries alongside them, which is exactly the property under test.
  for (const name of ["implementer", "integrator"]) assert.ok(name in ROLES, name);
  assert.throws(() => roleFor("no-such-role"), /Unknown role/);

  // `null` model/timeoutMs mean "whatever .afk-setup/config.yaml says".
  // `integrator` keeps inheriting the project's `agent.model`; `implementer`
  // and `reflector` pin their own tier below the senior default, so they do
  // NOT inherit it. Both are still beaten by a per-role `roles:` override —
  // tested separately below.
  const config = { agent: { model: "claude-sonnet-5", timeoutMs: 123_000 } };
  const integrator = roleFor("integrator");
  assert.equal(integrator.model, null);
  assert.equal(integrator.timeoutMs, null);
  assert.equal(roleAgent(integrator, config).model, "claude-sonnet-5");
  assert.equal(roleAgent(integrator, config).timeoutMs, 123_000);
  // The pinned build/report roles keep their tier over the project default,
  // but a per-role override still wins.
  assert.equal(roleFor("implementer").model, "claude-opus-5-5");
  assert.equal(roleAgent(roleFor("implementer"), config).model, "claude-opus-5-5");
  assert.equal(roleFor("reflector").model, "claude-sonnet-5");
  // The reflector pins high effort from its record; roleAgent must read it.
  assert.equal(roleFor("reflector").reasoningEffort, "high");
  assert.equal(roleAgent(roleFor("reflector"), config).reasoningEffort, "high");
  assert.equal(
    roleAgent(roleFor("implementer"), { roles: { implementer: { model: "claude-opus-5" } } }).model,
    "claude-opus-5",
  );
  // A per-role effort override still beats the record's pin.
  assert.equal(
    roleAgent(roleFor("reflector"), { roles: { reflector: { reasoningEffort: "medium" } } }).reasoningEffort,
    "medium",
  );
});

test("a lane role's permissions cap writes to its own worktree, in the preflight", () => {
  // Not a flag on buildAgentCommand — that builder is shared by every role.
  // The cap is data on the role, rendered into the worktree's settings file.
  const role = roleFor("implementer");
  assert.deepEqual(role.permissions.sandbox.allowWrite, [
    CWD,
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ]);
  const settings = preflightSettings(role, "/tmp/wt/204");
  assert.equal(settings.sandbox.enabled, true);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [
    "/tmp/wt/204",
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ]);
  assert.ok(settings.permissions.deny.includes("Read(~/.ssh/**)"));
  // A read-only role sets `sandbox: null` and gets no sandbox block at all.
  assert.equal(preflightSettings(roleFor("integrator"), "/repo").sandbox, undefined);
});

const HOME_EDIT_DENY = [
  "Edit(~/.claude/**)", "Edit(~/.ssh/**)", "Edit(~/.aws/**)", "Edit(~/.gnupg/**)", "Edit(~/.config/gh/**)",
];
// The guard hook a rendered `--settings` payload carries, or undefined.
const guardHook = (settings) => settings.hooks?.PreToolUse
  ?.find((entry) => entry.matcher === "Write|Edit|MultiEdit|NotebookEdit")?.hooks?.[0]?.command;

test("a lane builder's file tools are guarded off the run's checkout, and home config is Edit-denied", () => {
  // Bypass mode removes the layer that refused an out-of-directory `Write`, and
  // the sandbox never covered `Write` (docs/permissions.md gotcha 6). Two lanes
  // wrote their project's main checkout through it (docs/failure-modes.md F3.15).
  // The root is not the runner's cwd: `afk epic --worktree` runs elsewhere.
  const root = "/Users/someone/code/proj";
  const role = roleFor("implementer");
  for (const settings of [
    // `--runtime=direct` writes no preflight, so the invocation carries it.
    JSON.parse(settingsArg(role, null, undefined, root)),
    // What `runBuilder` hands the agent, with the run's own root.
    JSON.parse(roleAgent(role, {}, "claude", root).settings),
  ]) {
    for (const rule of HOME_EDIT_DENY) assert.ok(settings.permissions.deny.includes(rule), `implementer denies ${rule}`);
    const command = guardHook(settings);
    assert.ok(command, "the implementer carries the project-root guard hook");
    assert.ok(command.includes(`'${root}'`), `the guard names the run's checkout: ${command}`);
  }
  // The integrator merges in the project root: no guard.
  assert.equal(guardHook(JSON.parse(settingsArg(roleFor("integrator"), null, undefined, root))), undefined);
});

test("no sandbox-bearing payload denies the project root or ~/.infisical", () => {
  // Claude Code merges `Edit(...)` denies into the sandbox's `denyWrite` and
  // `Read(...)` denies into `denyRead`. A project-root Edit deny refused
  // sandboxed git the shared `<root>/.git` (`index.lock: Operation not
  // permitted`); a `~/.infisical` Read deny broke offline `infisical run`.
  const root = "/Users/someone/code/proj";
  const lane = taskWorktree(root, "204");
  for (const name of Object.keys(ROLES)) {
    const role = roleFor(name);
    for (const settings of [preflightSettings(role, lane), JSON.parse(settingsArg(role, null, undefined, root))]) {
      for (const rule of settings.permissions?.deny ?? []) {
        assert.ok(!rule.includes(root), `${name} denies the project root: ${rule}`);
        assert.ok(!/^Edit\(\/\//.test(rule), `${name} has an absolute Edit deny: ${rule}`);
        assert.ok(!rule.includes(".infisical"), `${name} read-denies Infisical: ${rule}`);
      }
    }
  }
});

test("the project-root guard denies the checkout and every other lane, and allows its own lane and scratch", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-guard-")));
  const proj = join(base, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  // A sibling whose name starts with the root's: a prefix test without a `/`
  // boundary would take it for the checkout.
  mkdirSync(join(base, "proj-lanes", "204"), { recursive: true });
  const link = join(base, "into-proj");
  symlinkSync(join(proj, "src"), link);
  const saved = process.env.AFK_WORKTREE_ROOT;
  // Lanes INSIDE the project: the case the old Edit deny had to be dropped for.
  process.env.AFK_WORKTREE_ROOT = join(proj, ".lanes");
  try {
    const lane = taskWorktree(proj, "204");
    mkdirSync(join(lane, "src"), { recursive: true });
    // A sibling lane whose id has this lane's id as a prefix, and a symlink
    // from inside this lane into it.
    const sibling = taskWorktree(proj, "2045");
    mkdirSync(join(sibling, "src"), { recursive: true });
    const intoSibling = join(lane, "sibling-src");
    symlinkSync(join(sibling, "src"), intoSibling);
    const command = guardHook(JSON.parse(settingsArg(roleFor("implementer"), null, undefined, proj, lane)));
    // `cwd` is where the agent is now: it moves with every `cd`, and the hook
    // process starts there too.
    const decide = (tool_name, tool_input, cwd = lane) => {
      const run = spawnSync("sh", ["-c", command], {
        cwd,
        input: JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name, tool_input }),
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim() ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : "allow";
    };
    assert.equal(decide("Write", { file_path: join(proj, "src", "session.rs") }), "deny");
    assert.equal(decide("Edit", { file_path: join(proj, "new-dir", "deeper", "x.md") }), "deny", "a path that does not exist yet");
    assert.equal(decide("NotebookEdit", { notebook_path: join(proj, "n.ipynb") }), "deny");
    assert.equal(decide("Write", { file_path: join(link, "evil.rs") }), "deny", "a symlink into the checkout");
    assert.equal(decide("MultiEdit", { file_path: join(lane, "src", "session.rs") }), "allow", `the lane ${lane}`);
    assert.equal(decide("Write", { file_path: "relative.txt" }), "allow", "a relative path resolves against the lane");
    assert.equal(decide("Write", { file_path: "/tmp/afk-implementer-501/204-1-abcd/checklist.md" }), "allow");
    assert.equal(decide("Write", { file_path: join(base, "proj-lanes", "204", "x.rs") }), "allow", "a sibling with the root as a name prefix");
    // Another lane under the lanes dir is not this lane's to write (live check:
    // the implementer's Write reached `probe-implementer-sibling`).
    assert.equal(decide("Write", { file_path: join(sibling, "src", "x.rs") }), "deny", "a sibling lane");
    assert.equal(decide("Write", { file_path: join(sibling, "new", "x.rs") }), "deny", "a new file in a sibling lane");
    assert.equal(decide("Write", { file_path: join(intoSibling, "x.rs") }), "deny", "a symlink from this lane into a sibling");
    assert.equal(decide("Write", { file_path: join(roleCwd(proj, "verifier-1"), "x.md") }), "deny", "a role's cwd under the lanes dir");
    // The own lane is fixed at render time, so a `cd` does not move it.
    assert.equal(decide("Edit", { file_path: join(lane, "src", "a.rs") }, join(lane, "src")), "allow", "own lane from a subdirectory");
    assert.equal(decide("Edit", { file_path: "../README.md" }, join(lane, "src")), "allow", "a relative path from a subdirectory");
    assert.equal(decide("Edit", { file_path: join(lane, "src", "a.rs") }, "/tmp"), "allow", "own lane after cd /tmp");
    assert.equal(decide("Write", { file_path: "/tmp/scratch.md" }, "/tmp"), "allow", "/tmp");
    assert.equal(decide("Edit", { file_path: join(sibling, "src", "a.rs") }, sibling), "deny", "a sibling lane after cd into it");
    assert.equal(decide("Write", { file_path: "x.rs" }, sibling), "deny", "a relative path after cd into a sibling");
  } finally {
    if (saved === undefined) delete process.env.AFK_WORKTREE_ROOT;
    else process.env.AFK_WORKTREE_ROOT = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("the integrator carries credential, sub-agent and home Edit denies on its invocation", () => {
  // It runs at the project root, where `.claude/` is the project's, so it gets
  // no preflight file: `settingsArg` is the only path its profile has.
  const root = "/Users/someone/code/proj";
  const deny = JSON.parse(settingsArg(roleFor("integrator"), null, undefined, root)).permissions.deny;
  for (const rule of [
    "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.gnupg/**)", "Read(~/.config/gh/**)",
    "Read(~/.npmrc)", "Task", ...HOME_EDIT_DENY,
  ]) {
    assert.ok(deny.includes(rule), `integrator denies ${rule}`);
  }
});

test("every credential deny reads ~/.npmrc too", () => {
  // fixer and reflector are left out: they never receive `preflightSettings`.
  for (const name of ["implementer", "integrator", "verifier"]) {
    const deny = preflightSettings(roleFor(name), "/tmp/wt/204").permissions.deny;
    assert.ok(deny.includes("Read(~/.npmrc)"), `${name} denies ~/.npmrc`);
  }
});

test("the herdr skill is denied to every lane agent, both delivery paths", () => {
  // The skill can start sibling agents in other panes, which would break
  // "one ticket, one agent, one sealed worktree" — and nothing filesystem
  // scoped would notice (docs/notifications-and-agent-scope.md section 2).
  // Both forms are needed: bare, and with arguments.
  //
  // The `supervisor` is the documented exception and is asserted separately
  // below: docs/notifications-and-agent-scope.md's roles table gives it `yes`,
  // because reading panes is how it answers "what is 207 doing". It has no lane
  // to escape from, and the escape the deny closes for lane roles — starting a
  // sibling agent — is closed for it by `Bash(herdr agent:*)` instead.
  for (const role of Object.values(ROLES)) {
    if (role.name === "supervisor") continue;
    assert.deepEqual(role.permissions.denySkills, ["herdr"]);
    const deny = preflightSettings(role, "/tmp/wt/204").permissions.deny;
    assert.ok(deny.includes("Skill(herdr)"));
    assert.ok(deny.includes("Skill(herdr *)"));
    // A role may run where `.claude/` belongs to the project rather than to a
    // worktree the runner made, so the deny must also travel with the
    // invocation. What each role carries there differs — the read-only roles
    // add their whole sandbox — so assert the invariant, not the exact payload.
    const carried = JSON.parse(settingsArg(role)).permissions.deny;
    assert.ok(carried.includes("Skill(herdr)"), `${role.name} carries the bare deny`);
    assert.ok(carried.includes("Skill(herdr *)"), `${role.name} carries the arg deny`);
    const command = buildAgentCommand(roleAgent(role, {}), {
      nodeBin: "/runtime/bin",
      promptPath: "prompt.md",
      streamPath: "stream.jsonl",
    });
    assert.ok(command.includes("--settings "), `${role.name} passes --settings`);
    assert.ok(command.includes("Skill(herdr *)"), `${role.name} denies the skill on the command line`);
  }
});

test("the supervisor keeps the herdr skill, and cannot use it to schedule", () => {
  // The one `yes` in docs/notifications-and-agent-scope.md's roles table. This
  // is asserted rather than left implicit so a later sweep that denies the skill
  // everywhere for symmetry fails here instead of silently blinding the one role
  // whose job is to look at panes.
  const role = roleFor("supervisor");
  assert.deepEqual(role.permissions.denySkills, []);
  const carried = JSON.parse(settingsArg(role)).permissions.deny;
  assert.ok(!carried.some((rule) => /^Skill\(herdr/.test(rule)));
  // Reading a pane, yes. Starting an agent in one, closing a workspace, or
  // running the `afk` commands it proposes — no; the runner does those.
  for (const rule of [
    "Bash(herdr agent:*)",
    "Bash(herdr workspace close:*)",
    "Bash(afk:*)",
    "Bash(node afk.mjs:*)",
  ]) {
    assert.ok(carried.includes(rule), `supervisor denies ${rule}`);
  }
});

test("a merger gets its own identifiable fresh process name", () => {
  const command = buildAgentCommand(agentConfig({}), {
    nodeBin: "/runtime/bin",
    promptPath: "prompt.md",
    streamPath: "stream.jsonl",
    taskId: "211",
    processName: mergerProcessName("211"),
  });
  assert.match(command, /"\$@"' 'agent-merge-211' /);
});

test("a task id is a string whatever JSON or YAML hands over", () => {
  // Issue numbers arrive as `204` in a list and `"204"` as an object key, and
  // `.afk/state.json` keys, the integration queue and activeWorkers are all
  // object keys. One `204 !== "204"` strands a task: the scheduler finds no
  // state entry, seeds a second one, and the lane never reaches integration.
  assert.equal(normalizeId(204), "204");
  assert.equal(normalizeId("204"), "204");
  assert.equal(normalizeId(null), null);
  assert.equal(normalizeId(undefined), null);
  assert.equal(taskBranch(normalizeId(204)), "afk/task-204");
  assert.equal(agentProcessName(normalizeId(204)), "agent-204");
});

test("a task is ready only when pending with all dependencies passed", () => {
  const tasks = [
    { id: "204", status: "passed", dependsOn: [] },
    { id: "205", status: "failed", dependsOn: [] },
    { id: "206", status: "pending", dependsOn: ["204"] },
    { id: "207", status: "pending", dependsOn: ["204", "205"] },
    { id: "208", status: "pending", dependsOn: ["999"] },
    { id: "209", status: "running", dependsOn: ["204"] },
  ];
  const isReady = (id) =>
    ready(
      tasks.find((t) => t.id === id),
      tasks,
    );
  assert.ok(isReady("206"));
  assert.ok(!isReady("207"), "a failed dependency blocks");
  assert.ok(!isReady("208"), "an unknown dependency blocks");
  assert.ok(!isReady("209"), "already running");
  assert.ok(!isReady("204"), "already passed");
  assert.ok(
    !ready({ status: "failed", dependsOn: [] }, tasks),
    "a failed task is never re-picked — this is why the retry must reset it to pending",
  );
});

test("parseStream: context is the latest level, output is cumulative", () => {
  const stream = [
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "sed -n 1,80p src/App.tsx",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "sed -n 1,80p src/App.tsx",
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "message_1", type: "agent_message", text: "done" },
    }),
    JSON.stringify({
      type: "turn.completed",
      model: "gpt-5.6-terra",
      usage: { input_tokens: 2, cached_input_tokens: 100, output_tokens: 10 },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 2000, output_tokens: 5 },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 1.25,
    }),
  ].join("\n");
  const s = parseStream(stream);
  assert.equal(s.contextTokens, 2001, "latest request, not a sum");
  assert.equal(s.outputTokens, 15, "summed across turns");
  assert.equal(s.turns, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.costUsd, 1.25);
  assert.equal(s.lastActivity, "done");
  assert.equal(s.activeAction, "");
  assert.equal(finalText(stream), "done");
});

test("parseStream: reads a Claude Code stream-json run", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } },
        ],
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 3,
          output_tokens: 10,
        },
      },
    }),
    // A tool still awaiting its result is what the dashboard shows as active.
    JSON.stringify({ type: "assistant", message: { content: [], usage: {} } }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 2000, output_tokens: 5 },
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1.25 }),
  ].join("\n");
  const s = parseStream(stream);
  assert.equal(s.model, "claude-opus-5");
  assert.equal(s.turns, 3);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.tools.Bash, 1);
  assert.equal(s.contextTokens, 2001, "latest request, not a sum");
  assert.equal(s.outputTokens, 15, "summed across turns");
  assert.equal(s.costUsd, 1.25);
  assert.equal(s.activeAction, "", "the tool result cleared the active tool");
  assert.equal(finalText(stream), "done");
  assert.match(timeline(stream), /✓ Bash: npm test/);
});

test("parseStream: records per-turn usage events", () => {
  const stream = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  assert.equal(parseStream(stream).outputTokens, 10);
});

test("parseStream: an unanswered command stays the active action", () => {
  // This is what the dashboard shows while a long check is still running.
  const stream = JSON.stringify({
    type: "item.started",
    item: { id: "item_9", type: "command_execution", command: "npm run build" },
  });
  assert.equal(parseStream(stream).activeAction, "command: npm run build");
});

test("format: live work reports pending usage and the active command", () => {
  const line = format(
    "014",
    stats({ activeAction: "command: sed -n 1,260p src/platform/desktop.ts" }),
  );
  assert.ok(line.includes("usage pending"), line);
  assert.ok(
    line.includes("active command: sed -n 1,260p src/platform/desktop.ts"),
    line,
  );
});

test("parseStream: surfaces a 429 and the reset time", () => {
  // auto.mjs waits on this instead of blind-polling every 5 minutes.
  const stream = [
    JSON.stringify({
      type: "turn.failed",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1785088800,
        rateLimitType: "five_hour",
      },
      error: { status: 429, message: "You've hit your session limit" },
    }),
  ].join("\n");
  const s = parseStream(stream);
  assert.equal(s.apiErrorStatus, 429);
  assert.equal(s.rateLimit.status, "rejected");
  assert.equal(s.rateLimit.resetsAt, 1785088800);
});

test("parseStream: a limit message without a 429 field still counts as rejected", () => {
  const s = parseStream(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "You have exceeded your usage limit" },
    }),
  );
  assert.equal(s.apiErrorStatus, 429);
  assert.equal(s.rateLimit.status, "rejected");
});

const stats = (over = {}) => ({
  turns: 1,
  toolCalls: 0,
  tools: {},
  contextTokens: 0,
  outputTokens: 0,
  costUsd: null,
  rateLimit: null,
  result: null,
  ...over,
});

test("format: the context percentage uses the configured default window", () => {
  assert.equal(
    CONTEXT_LIMIT,
    process.env.AGENT_CONTEXT_LIMIT
      ? Number(process.env.AGENT_CONTEXT_LIMIT)
      : 1_000_000,
  );
  const line = format("204", stats({ contextTokens: CONTEXT_LIMIT / 2 }));
  assert.ok(line.includes("(50%)"), line);
});

test("format: a rate_limit_event without utilization does not render NaN", () => {
  // Observed live: `five_hour NaN% used` in the dashboard, because
  // rate_limit_info carried status + resetsAt but no utilization.
  const line = format("025", {
    turns: 1,
    toolCalls: 0,
    tools: {},
    contextTokens: 1000,
    outputTokens: 10,
    costUsd: null,
    rateLimit: { status: "rejected", rateLimitType: "five_hour" },
    result: null,
  });
  assert.ok(!line.includes("NaN"), line);
  assert.ok(line.includes("five_hour"));
  assert.ok(line.includes("rejected"));
});

test("parseStream: tolerates non-JSON lines mixed into the stream", () => {
  // A limit rejection can print plain text alongside the JSON events.
  const s = parseStream(
    "not json\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.5,
      }) +
      "\ntrailing junk",
  );
  assert.equal(s.costUsd, 0.5);
  assert.equal(s.result, "success");
});

test("timeline: tool calls flip from … to ✓ in place, never printed twice", () => {
  const stream = [
    JSON.stringify({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "rg auth" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "rg auth",
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.started",
      item: { id: "item_2", type: "command_execution", command: "npm test" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "message_2",
        type: "agent_message",
        text: "Implementing the auth flow.",
      },
    }),
  ].join("\n");
  const rows = timeline(stream).split("\n");
  assert.deepEqual(rows, [
    "✓ command: rg auth",
    "… command: npm test",
    "· Implementing the auth flow.",
  ]);
});

test("a failed attempt the agent committed is reset, not just checked out", () => {
  // The expensive half of the self-commit fix. `git checkout -- .` leaves the
  // agent's commit on the branch, so the retry starts from the code that just
  // failed — and on a limit rejection the plan would carry a broken commit
  // forward for every later task.
  const withCommits = discardAttempt("abc123", ["deadbeef", "cafef00d"]);
  assert.equal(withCommits, "git reset --hard abc123");

  // The common case must stay cheap: no commit, no history rewrite.
  assert.equal(discardAttempt("abc123", []), "git checkout -- .");
  assert.equal(discardAttempt("abc123"), "git checkout -- .");
});

// --- Rust gate skipping -----------------------------------------------------

test("a frontend-only change set skips exactly the three Rust checks", () => {
  const CHECKS = [
    "npm run typecheck",
    "npm run lint",
    "npm run ast:lint",
    "npm run format:check",
    "npm run rust:fmt:check",
    "npm run rust:clippy",
    "npm run test:run",
    "npm run rust:test",
    "npm run build:web",
  ];
  const changed = [
    "src/features/board/Board.tsx",
    "locales/en.json",
    "runs/281/report.md",
  ];
  assert.ok(shouldSkipRustChecks(changed));
  const skipped = CHECKS.filter((c) => isRustCheck(c));
  assert.deepEqual(
    skipped,
    ["npm run rust:fmt:check", "npm run rust:clippy", "npm run rust:test"],
    "never skip a non-Rust check — typecheck, lint and the web tests must always run",
  );
});

test("a change set touching Rust runs the Rust checks", () => {
  assert.ok(!shouldSkipRustChecks(["src/App.tsx", "src-tauri/src/lib.rs"]));
  assert.ok(!shouldSkipRustChecks(["Cargo.toml"]));
  assert.ok(!shouldSkipRustChecks(["src-tauri/Cargo.lock"]));
  assert.ok(
    !shouldSkipRustChecks(["crates/core/Cargo.toml"]),
    "a Cargo manifest anywhere is Rust-relevant",
  );
  assert.ok(
    isRustPath("src-tauri/tauri.conf.json"),
    "anything under src-tauri/ counts, not just .rs",
  );
  assert.ok(!isRustPath("src/rust-notes.md"));
});

test("an unknown or empty change set runs the checks — fail safe toward running", () => {
  // A skip must follow from positive evidence that no Rust moved. Anything else
  // — no diff, a git failure, a bad value — pays for the gates.
  assert.ok(!shouldSkipRustChecks([]));
  assert.ok(!shouldSkipRustChecks(null));
  assert.ok(!shouldSkipRustChecks(undefined));
  assert.ok(!shouldSkipRustChecks("src/App.tsx"));
});

test("a skipped check is recorded honestly and is not read as a failure", () => {
  // `code: 0` would claim clippy passed when it never ran; `code: null` alone
  // would make every `code !== 0` reader call it a failure. Hence checkFailed().
  const skippedEntry = {
    command: "npm run rust:clippy",
    skipped: true,
    code: null,
    reason: "run changed no Rust",
  };
  assert.equal(
    skippedEntry.code,
    null,
    "never 0 — nobody may read a skip as a pass",
  );
  assert.ok(!checkFailed(skippedEntry));
  assert.ok(!checkFailed({ command: "npm run lint", code: 0 }));
  assert.ok(checkFailed({ command: "npm run lint", code: 1 }));
});

// --- continuous parallel scheduler ----------------------------------------

// A DAG task carries id, title, dependsOn and scope — and deliberately NO
// status: `.afk/state.json` owns lifecycle on its own.
const task = (id, dependsOn = [], extra = {}) => ({
  id,
  title: id,
  dependsOn,
  ...extra,
});
const dagOf = (tasks) => ({ epic: null, branch: null, tasks });
const runtime = (tasks, overrides = {}) => ({
  tasks: Object.fromEntries(
    tasks.map((entry) => [
      entry.id,
      { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 },
    ]),
  ),
  activeWorkers: {},
  integrationQueue: [],
  activeIntegrator: null,
  ...overrides,
});

test("independent tasks fill maxParallel and receive unique branch/worktree identities", () => {
  const tasks = [task("204"), task("205"), task("206")];
  const state = runtime(tasks);
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 2 }, state).map((entry) => entry.id),
    ["204", "205"],
  );
  assert.notEqual(taskBranch("204"), taskBranch("205"));
  assert.notEqual(taskWorktree("/repo", "204"), taskWorktree("/repo", "205"));
  assert.equal(taskBranch("204"), "afk/task-204");
});

test("task worktrees live outside the project", () => {
  // Regression: worktrees under `.afk/worktrees/` are full copies of the repo,
  // so `eslint .` walked into a lane, found a bundled vendor file, and failed an
  // integration whose merge was perfect. Being gitignored does not help — these
  // tools do not read .gitignore.
  const lane = taskWorktree("/Users/x/code/my-app", "204");
  assert.equal(
    lane.startsWith("/Users/x/code/my-app"),
    false,
    "a lane inside the project is walked by the project's own checks",
  );
  // `<id>/<repo>`: the lane sits in a private parent of its own, so a build
  // path written `../something` cannot be shared with a sibling lane.
  assert.match(lane, /Users-x-code-my-app\/204\/my-app$/);
  // Two checkouts of the same repo must never share a lane.
  assert.notEqual(lane, taskWorktree("/Users/x/other/my-app", "204"));
});

test("a read-only role runs outside the project, in a checkout it may write", () => {
  // docs/findings.md 3.2: `sandbox.allowWrite` only widens, so it cannot take
  // back Claude Code's default grant of the agent's own working directory. The
  // verifier ran at the project root and wrote the branch it was gating with a
  // shell redirect. The cap is therefore WHERE it runs, not what it is denied.
  const repo = mkdtempSync(join(tmpdir(), "afk-role-cwd-"));
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(git(repo, "init", "-b", "main").status, 0);
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");

  assert.equal(
    roleCwd(repo, "verify-3").startsWith(repo),
    false,
    "a cwd inside the project is a cwd the role may write the project from",
  );

  const checkout = createRoleCwd({ root: repo, key: "verify-3", ref: "main" });
  assert.equal(checkout, roleCwd(repo, "verify-3"));
  assert.equal(existsSync(join(checkout, "base.txt")), true, "the branch is actually checked out");
  // Detached: the review copy must not hold a ref anything else could move.
  assert.equal(git(checkout, "branch", "--show-current").stdout.trim(), "");
  // A lane listing must not grow a review copy — it is not a task, and the
  // dashboard would show a running closeout as a leftover worktree.
  const listed = parseWorktrees(git(repo, "worktree", "list", "--porcelain").stdout, repo);
  assert.equal(listed.some((entry) => entry.path === checkout), false);

  // The supervisor's variant: no ref, just somewhere to be.
  const scratch = createRoleCwd({ root: repo, key: "supervise-lane_failed-4" });
  assert.equal(existsSync(scratch), true);
  assert.equal(scratch.startsWith(repo), false);

  removeRoleCwd({ root: repo, key: "verify-3" });
  assert.equal(existsSync(checkout), false, "the review copy outlives no agent");

  // A run killed mid-review leaves its cwd behind, and these are keyed per
  // event, so nothing would ever reuse and clean it. A task worktree is kept on
  // restart because it may hold unverified work; this one never does.
  assert.deepEqual(pruneRoleCwds(repo), ["role-cwd-supervise-lane_failed-4"]);
  assert.equal(existsSync(scratch), false);
  assert.deepEqual(pruneRoleCwds(repo), [], "and pruning twice is not an error");
});

test("worktree helper creates isolated branches at the requested base", () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-worktrees-"));
  const git = (cwd, ...args) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(git(repo, "init", "-b", "main").status, 0);
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const first = createTaskWorktree({ root: repo, id: "204", baseSha: base });
  const second = createTaskWorktree({ root: repo, id: "205", baseSha: base });
  assert.notEqual(first.worktree, second.worktree);
  assert.equal(
    git(first.worktree, "branch", "--show-current").stdout.trim(),
    "afk/task-204",
  );
  assert.equal(
    git(second.worktree, "branch", "--show-current").stdout.trim(),
    "afk/task-205",
  );
  assert.equal(git(first.worktree, "rev-parse", "HEAD").stdout.trim(), base);
  assert.equal(git(second.worktree, "rev-parse", "HEAD").stdout.trim(), base);
});

test("one finishing worker immediately frees a slot without waiting for the wave", () => {
  const tasks = [task("204"), task("205"), task("206")];
  const dag = dagOf(tasks);
  const config = { maxParallel: 2 };
  const state = runtime(tasks, { activeWorkers: { 204: {}, 205: {} } });
  state.tasks["204"].lifecycle = "ready_to_integrate";
  delete state.activeWorkers["204"];
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    ["206"],
  );
  assert.ok(state.activeWorkers["205"], "the slow worker is still active");
});

test("dependencies unlock only after integration marks the dependency passed", () => {
  const tasks = [task("204"), task("208", ["204"])];
  const dag = dagOf(tasks);
  const config = { maxParallel: 2 };
  const state = runtime(tasks);
  state.tasks["204"].lifecycle = "ready_to_integrate";
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    [],
  );
  state.tasks["204"].lifecycle = "integrating";
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    [],
  );
  state.tasks["204"].lifecycle = "passed";
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    ["208"],
  );
});

test("integration queue is serial and never starts a second integrator", () => {
  const state = runtime([task("204"), task("205")]);
  enqueueIntegration(state, "204");
  enqueueIntegration(state, "205");
  assert.ok(canStartIntegration(state));
  state.activeIntegrator = { taskId: "204" };
  assert.ok(!canStartIntegration(state));
});

test("human-gated work does not stop unrelated automatic work", () => {
  const tasks = [task("204", [], { humanGated: true }), task("205")];
  const dag = dagOf(tasks);
  const config = { maxParallel: 2 };
  assert.deepEqual(
    nextBuilderTasks(dag, config, runtime(tasks)).map((entry) => entry.id),
    ["205"],
  );
  assert.deepEqual(
    nextBuilderTasks(dag, config, runtime(tasks), Date.now(), "204").map(
      (entry) => entry.id,
    ),
    ["204"],
  );
});

test("one rate-limited task does not pause an unrelated runnable task", () => {
  const tasks = [task("204"), task("205")];
  const state = runtime(tasks);
  state.tasks["204"].retryAt = Date.now() + 60_000;
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 2 }, state).map((entry) => entry.id),
    ["205"],
  );
});

test("stale workers and integrator are reconciled without losing the integration branch", () => {
  const state = runtime([task("204"), task("205")], {
    activeWorkers: { 204: { pid: 11, branch: "afk/task-204" } },
    activeIntegrator: {
      taskId: "205",
      pid: 12,
      branch: "afk/task-205",
      integrationBase: "abc",
    },
  });
  state.tasks["204"].lifecycle = "running";
  state.tasks["205"].lifecycle = "integrating";
  const recovered = reconcileStaleState(state, () => true);
  assert.deepEqual(recovered.stalePids, [11, 12]);
  assert.equal(recovered.state.tasks["204"].lifecycle, "pending");
  assert.equal(recovered.state.tasks["205"].lifecycle, "ready_to_integrate");
  assert.deepEqual(recovered.state.integrationQueue, ["205"]);
  assert.equal(recovered.state.tasks["205"].integrationBase, "abc");
});

test("maxParallel=1 preserves the sequential happy path", () => {
  const tasks = [task("204"), task("205")];
  const dag = dagOf(tasks);
  const config = { maxParallel: 1 };
  const state = runtime(tasks);
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    ["204"],
  );
  state.activeWorkers["204"] = {};
  assert.deepEqual(nextBuilderTasks(dag, config, state), []);
});

// --- owns as a scheduling constraint (docs/wave-mode.md §6) ----------------

test("repo-wide scope stays repo-wide, so an existing epic still fills every lane", () => {
  // THE regression test for this feature. `epicToDag` hardcodes
  // `allowedPaths: ["**"]` for every task on the GitHub path (epic.mjs:127),
  // and `**` overlaps everything — so an owns filter WITHOUT the opt-out
  // serializes every epic that has ever run to a single lane, silently. Delete
  // the `repoWideScope` branch from `nextBuilderTasks` and this asserts
  // `["1"]`, not five.
  const tasks = ["1", "2", "3", "4", "5"].map((id) =>
    task(id, [], { allowedPaths: ["**"] }),
  );
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 5 }, runtime(tasks)).map(
      (entry) => entry.id,
    ),
    ["1", "2", "3", "4", "5"],
    "a repo-wide task takes no scope constraint — five wide, as it has always been",
  );
  // The same rule seen from a running lane: `1` holding `["**"]` must not be
  // read as owning the repo and blocking its siblings.
  const withLane = runtime(tasks, { activeWorkers: { 1: {} } });
  withLane.tasks["1"].lifecycle = "running";
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 5 }, withLane).map((entry) => entry.id),
    ["2", "3", "4", "5"],
  );
  assert.equal(repoWideScope(task("6", [], { allowedPaths: ["**"] })), true);
  // Absent and empty are repo-wide too — `normalizeDag` defaults `allowedPaths`
  // to `['**']`, and a raw `--dag=` may omit it entirely.
  assert.equal(repoWideScope(task("7")), true);
  assert.equal(repoWideScope(task("8", [], { allowedPaths: [] })), true);
  assert.equal(repoWideScope(task("9", [], { allowedPaths: ["src/a.ts"] })), false);
});

test("two tasks claiming one directory do not start in the same batch", () => {
  const tasks = [
    task("204", [], { allowedPaths: ["Sources/Feature/"] }),
    task("205", [], { allowedPaths: ["Sources/Feature/View.swift"] }),
    task("206", [], { allowedPaths: ["Sources/Other/"] }),
  ];
  const state = runtime(tasks);
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 3 }, state).map((entry) => entry.id),
    ["204", "206"],
    "205 overlaps an earlier pick in the same batch; 206 is disjoint and rides along",
  );
  // Deferred, not failed, not marked, not retried: the filter is pure and
  // writes nothing, so the next tick reconsiders 205 from an untouched state.
  assert.equal(state.tasks["205"].lifecycle, "pending");
  assert.equal(state.tasks["205"].retryAt, undefined);
  assert.equal(state.tasks["205"].builderAttempt, 0);
});

test("a task overlapping a running lane is deferred, then starts when the lane frees", () => {
  const tasks = [
    task("204", [], { allowedPaths: ["src-tauri/**"] }),
    task("205", [], { allowedPaths: ["src-tauri/src/main.rs"] }),
    task("206", [], { allowedPaths: ["app/theme/**"] }),
  ];
  const dag = dagOf(tasks);
  const config = { maxParallel: 3 };
  const state = runtime(tasks, { activeWorkers: { 204: {} } });
  state.tasks["204"].lifecycle = "running";
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    ["206"],
    "205 would race 204 for src-tauri/src/main.rs; 206 shares nothing with it",
  );
  // The lane finishes. Nothing else had to happen for 205 to become startable —
  // no reset, no retry clock, no state edit by the filter.
  delete state.activeWorkers["204"];
  state.tasks["204"].lifecycle = "ready_to_integrate";
  assert.deepEqual(
    nextBuilderTasks(dag, config, state).map((entry) => entry.id),
    ["205", "206"],
  );
});

test("sibling directories are not a conflict", () => {
  // `Sources/A/` and `Sources/B/` do not overlap, and neither do
  // `Sources/Feature` and `Sources/FeatureFlags` — a per-character prefix test
  // would serialize both pairs for no reason.
  const tasks = [
    task("204", [], { allowedPaths: ["Sources/A/"] }),
    task("205", [], { allowedPaths: ["Sources/B/"] }),
    task("206", [], { allowedPaths: ["Sources/FeatureFlags/x.swift"] }),
    task("207", [], { allowedPaths: ["Sources/Feature/"] }),
  ];
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 4 }, runtime(tasks)).map(
      (entry) => entry.id,
    ),
    ["204", "205", "206", "207"],
  );
});

test("the scope filter never hands out more lanes than there are free slots", () => {
  const tasks = [
    task("204", [], { allowedPaths: ["a/"] }),
    task("205", [], { allowedPaths: ["a/x.ts"] }),
    task("206", [], { allowedPaths: ["b/"] }),
    task("207", [], { allowedPaths: ["c/"] }),
  ];
  // Skipping 205 must not let the batch reach past the cap to backfill.
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 2 }, runtime(tasks)).map(
      (entry) => entry.id,
    ),
    ["204", "206"],
  );
});

test("the scope filter can never defer every task and stall the run", () => {
  // The deadlock this feature could have introduced: a filter that defers
  // everything with no lane running leaves the scheduler drained, and
  // `schedulerDone` would close the epic with work still pending. With no
  // active lane there is nothing claimed, so the first runnable task always
  // wins its scope however much its siblings overlap it.
  const tasks = ["204", "205", "206"].map((id) =>
    task(id, [], { allowedPaths: ["Sources/Feature/"] }),
  );
  const state = runtime(tasks);
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 3 }, state).map((entry) => entry.id),
    ["204"],
  );
  // And the run is not done, so the deferred pair is still reachable.
  assert.equal(schedulerDone(dagOf(tasks), state), false);
});

test("a deferred task is reported with the path and the lane it lost to", () => {
  // Without this the operator watching a run sees an idle lane and no reason.
  // `nextBuilderTasks` stays pure and silent; the batch carries the fact, and
  // `auto.mjs` is the only thing that prints.
  const tasks = [
    task("204", [], { allowedPaths: ["Sources/Feature/"] }),
    task("205", [], { allowedPaths: ["Sources/Feature/View.swift"] }),
    task("206", [], { allowedPaths: ["Sources/Other/"] }),
  ];
  const state = runtime(tasks, { activeWorkers: { 204: {} } });
  state.tasks["204"].lifecycle = "running";
  const batch = planBuilderBatch(dagOf(tasks), { maxParallel: 3 }, state);
  assert.deepEqual(batch.picked.map((entry) => entry.id), ["206"]);
  assert.deepEqual(batch.deferred, [
    {
      id: "205",
      path: "Sources/Feature/View.swift",
      conflictsWith: "204",
      heldPath: "Sources/Feature/",
    },
  ]);
  // The batch's own picks claim scope too, and a task deferred by an earlier
  // pick must name that pick, not the running lane.
  const fresh = runtime(tasks);
  assert.deepEqual(
    planBuilderBatch(dagOf(tasks), { maxParallel: 3 }, fresh).deferred.map(
      (entry) => [entry.id, entry.conflictsWith],
    ),
    [["205", "204"]],
  );
  // An explicitly named task bypasses the filter, so it is never deferred and
  // never announced.
  assert.deepEqual(
    planBuilderBatch(dagOf(tasks), { maxParallel: 3 }, state, Date.now(), "205").deferred,
    [],
  );
});

test("a deferral is announced once, not once per scheduler tick", () => {
  // The tick loop runs constantly. A line per tick is a log nobody reads, which
  // is the same as not logging it at all.
  const deferral = {
    id: "205",
    path: "Sources/Feature/View.swift",
    conflictsWith: "204",
    heldPath: "Sources/Feature/",
  };
  const first = deferralAnnouncements([deferral], new Map());
  assert.equal(first.lines.length, 1);
  assert.match(first.lines[0], /205/);
  assert.match(first.lines[0], /Sources\/Feature\/View\.swift/);
  assert.match(first.lines[0], /204/, "the line names the lane it lost to");

  // Ten more ticks with nothing changed: silence.
  let memo = first.announced;
  for (let tick = 0; tick < 10; tick += 1) {
    const again = deferralAnnouncements([deferral], memo);
    assert.deepEqual(again.lines, [], "the same deferral speaks once");
    memo = again.announced;
  }

  // Losing to a DIFFERENT lane is a different fact, and says so.
  const moved = deferralAnnouncements(
    [{ ...deferral, conflictsWith: "206", heldPath: "Sources/Feature/Other.swift" }],
    memo,
  );
  assert.equal(moved.lines.length, 1);
  assert.match(moved.lines[0], /206/);

  // The deferral clears — 205 started, or the lane freed. The memo forgets it,
  // so if it is deferred again later that is news and is announced again.
  const cleared = deferralAnnouncements([], moved.announced);
  assert.deepEqual(cleared.lines, []);
  assert.equal(cleared.announced.size, 0);
  assert.equal(deferralAnnouncements([deferral], cleared.announced).lines.length, 1);

  // Two lanes deferred at once are two lines, and each is debounced on its own.
  const pair = [deferral, { ...deferral, id: "207" }];
  const both = deferralAnnouncements(pair, new Map());
  assert.equal(both.lines.length, 2);
  assert.deepEqual(deferralAnnouncements(pair, both.announced).lines, []);
});

test("the builder retry budget stops at the configured number of retries", () => {
  // `agent.maxBuilderRetries` is retries AFTER the first attempt, and
  // `builderAttempt` counts attempts already made. The boundary is the whole
  // point: an off-by-one here either burns a lane's budget silently or retries
  // a doomed ticket forever, and it lived inside `runAuto`'s closure where
  // nothing could reach it.
  assert.equal(shouldRetryBuilder(1, 1), true, "budget 1: the first failure retries");
  assert.equal(shouldRetryBuilder(2, 1), false, "budget 1: and the second gives up");
  assert.equal(shouldRetryBuilder(1, 2), true);
  assert.equal(shouldRetryBuilder(2, 2), true, "budget 2 buys two retries");
  assert.equal(shouldRetryBuilder(3, 2), false);
  assert.equal(shouldRetryBuilder(1, 0), false, "budget 0 never retries");
  // The default the runner ships, so a change to it fails here loudly.
  assert.equal(agentConfig({}).maxBuilderRetries, 1);
});

test("an explicitly named task is not deferred by the scope filter", () => {
  // `--task=` already bypasses `humanGated`: the operator is present and named
  // one task. Silently starting nothing would read as the runner being broken.
  const tasks = [
    task("204", [], { allowedPaths: ["Sources/Feature/"] }),
    task("205", [], { allowedPaths: ["Sources/Feature/View.swift"] }),
  ];
  const state = runtime(tasks, { activeWorkers: { 204: {} } });
  state.tasks["204"].lifecycle = "running";
  assert.deepEqual(
    nextBuilderTasks(dagOf(tasks), { maxParallel: 2 }, state, Date.now(), "205").map(
      (entry) => entry.id,
    ),
    ["205"],
  );
});

test("dashboard counts every non-main Git worktree as running", () => {
  const worktrees = parseWorktrees(`worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo/.afk/worktrees/204
HEAD bbb
branch refs/heads/afk/task-204

worktree /tmp/manual-review
HEAD ccc
branch refs/heads/codex/manual-review
`, "/repo");
  assert.equal(worktrees.length, 2);
  assert.deepEqual(
    worktrees.map((entry) => entry.branch),
    ["afk/task-204", "codex/manual-review"],
  );
  assert.equal(worktrees[0].taskId, "204");
  assert.equal(worktrees[1].taskId, null);
});

test("dashboard marks ready-to-integrate work as in review", () => {
  const dag = dagOf([task("204"), task("205")]);
  const state = runtime(dag.tasks);
  state.tasks["204"].lifecycle = "ready_to_integrate";
  state.tasks["205"].lifecycle = "running";
  const merged = mergeDashboardState(
    dag,
    state,
    [
      {
        path: "/repo/.afk/worktrees/204",
        name: "204",
        branch: "afk/task-204",
        taskId: "204",
      },
      {
        path: "/tmp/other",
        name: "other",
        branch: "codex/other",
        taskId: null,
      },
    ],
    () => true,
  );
  assert.equal(
    merged.runtime.worktrees.length,
    2,
    "every worktree is still reported, live or not",
  );
  assert.equal(merged.tasks[0].review, true);
  assert.equal(merged.tasks[0].checkout, "204");
  assert.equal(merged.tasks[1].review, false);
  assert.match(
    readFileSync(
      fileURLToPath(new URL("./dashboard.html", import.meta.url)),
      "utf8",
    ),
    /In review/,
  );
});

test("dashboard columns a ticket by its longest dependency chain", () => {
  const tasks = [
    { id: "57", dependsOn: [] },
    { id: "58", dependsOn: [] },
    { id: "59", dependsOn: ["58"] },
    { id: "61", dependsOn: ["57", "59"] },
  ];
  assert.deepEqual([...depthsOf(tasks).entries()], [
    ["57", 0],
    ["58", 0],
    ["59", 1],
    ["61", 2],
  ]);
  // A dependency on a task outside this epic's block is not a column.
  assert.equal(depthsOf([{ id: "70", dependsOn: ["999"] }]).get("70"), 0);
  // `epic-spec.mjs` refuses a cyclic epic, so this is only about the malformed
  // state file: the guarantee is that it TERMINATES with finite columns, not
  // that the drawing means anything. A 5s poll that recursed would hang the page.
  const cyclic = depthsOf([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ]);
  assert.ok([...cyclic.values()].every(Number.isFinite));
});

test("a lane with no verification record reports no checks, not zero checks", () => {
  assert.equal(checkSummary(undefined), null);
  assert.equal(checkSummary({ checks: [] }), null);
  assert.deepEqual(
    checkSummary({
      checks: [
        { command: "npm test", code: 0 },
        { command: "npm run lint", code: 1 },
      ],
    }),
    { total: 2, passed: 1, failing: ["npm run lint"] },
  );
});

test("dashboard carries each ticket's progress and the epic's own", () => {
  const dag = dagOf([task("204"), task("205", ["204"]), task("206", ["204"])]);
  dag.epic = { id: "203", title: "The epic" };
  const state = runtime(dag.tasks);
  Object.assign(state.tasks["204"], {
    lifecycle: "passed",
    builderAttempt: 2,
    integrationAttempt: 1,
    commitSha: "abc1234",
    taskVerification: {
      durationMs: 61_000,
      checks: [{ command: "npm test", code: 0 }],
    },
  });
  state.tasks["205"].lifecycle = "running";
  state.activeWorkers = { 205: { taskId: "205", pid: 99, attempt: 1 } };
  const merged = mergeDashboardState(
    dag,
    { ...state, orchestratorPid: 42 },
    [],
    () => true,
    { 205: { kind: "builder", attempt: 1, toolCalls: 12 } },
  );
  const [done, live, waiting] = merged.tasks;
  assert.equal(done.depth, 0);
  assert.equal(done.stage, stageOf("passed"));
  assert.equal(done.builderAttempt, 2);
  assert.deepEqual(done.checkSummary, { total: 1, passed: 1, failing: [] });
  assert.equal(done.durationMs, 61_000);
  assert.equal(done.commitSha, "abc1234");
  assert.equal(live.depth, 1);
  assert.equal(live.live.toolCalls, 12, "a lane with an agent on it reports what it is doing");
  assert.equal(waiting.live, null, "an idle lane invents no activity");
  assert.equal(waiting.stage, 0);
  // `passed` is finished tasks and nothing else: a busy lane is not a finished
  // one, and CONTEXT.md reserves "done" for a runtime hint.
  assert.deepEqual(merged.progress, { total: 3, passed: 1 });
  const html = readFileSync(
    fileURLToPath(new URL("./dashboard.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /function renderDag/, "the DAG is drawn, not just served");
  // The epic is named once, in the header — never again as a node in its own
  // graph.
  assert.doesNotMatch(html, /dag-epic/);
  assert.match(html, /function pips/, "each ticket shows how far along it is");
  // The header names the run. `AFK Runner` on every page of every project is
  // the string this replaced, and nothing should put it back.
  assert.doesNotMatch(html, />AFK Runner</);
  assert.match(html, /state\.project/, "the project names itself");
  assert.match(html, /run-epic-n/, "the epic's number and title lead the page");
});

test("a stale lane's frozen stream is not reported as live activity", () => {
  // The dead-run-looks-live bug, one field further in: the badge said stale
  // while the meta line printed the last tool call of a process that is gone.
  const dag = dagOf([task("204")]);
  const state = runtime(dag.tasks, {
    orchestratorPid: 6720,
    activeWorkers: { 204: { taskId: "204", pid: 6721, attempt: 1 } },
  });
  state.tasks["204"].lifecycle = "running";
  const merged = mergeDashboardState(dag, state, [], () => false, {
    204: { kind: "builder", attempt: 1, toolCalls: 37 },
  });
  assert.equal(merged.tasks[0].status, "stale");
  assert.equal(merged.tasks[0].live, null);
});

test("a no-op task is finished work, and a gate is not the starting line", () => {
  // `renderCloseout` marks `no-op` ✅ beside passed (scripts/auto.mjs), so an
  // epic whose supervisor rules one task a no-op must still read as complete.
  const dag = dagOf([task("204"), task("205"), task("206")]);
  const state = runtime(dag.tasks);
  state.tasks["204"].lifecycle = "passed";
  state.tasks["205"].lifecycle = "no-op";
  state.tasks["206"].lifecycle = "awaiting_acceptance";
  const merged = mergeDashboardState(dag, state, [], () => true);
  assert.deepEqual(merged.progress, { total: 3, passed: 2 });
  assert.equal(merged.tasks[1].stage, 4);
  // A task waiting on a person is past review, not queued behind the scheduler.
  assert.equal(merged.tasks[2].stage, 2);
  const html = readFileSync(
    fileURLToPath(new URL("./dashboard.html", import.meta.url)),
    "utf8",
  );
  // The gate has a phase of its own and leads the list; the stage mapping
  // above is the part with teeth, this is the part that cannot be unit-run.
  assert.match(html, /Waiting for you/);
});

const worktreeOf = (id) => ({
  path: `/repo/.afk/worktrees/${id}`,
  name: id,
  branch: `afk/task-${id}`,
  taskId: id,
});

test("dashboard reports a live run as running", () => {
  const dag = dagOf([task("204"), task("205")]);
  const state = runtime(dag.tasks, {
    orchestratorPid: 4242,
    activeWorkers: { 204: { taskId: "204", pid: 4243, attempt: 1 } },
  });
  state.tasks["204"].lifecycle = "running";
  const merged = mergeDashboardState(
    dag,
    state,
    [worktreeOf("204")],
    (pid) => [4242, 4243].includes(Number(pid)),
  );
  assert.equal(merged.tasks[0].status, "running");
  assert.equal(merged.runtime.orchestrator.alive, true);
  assert.equal(merged.runtime.running, 1);
  assert.equal(merged.runtime.liveWorkers, 1);
  assert.deepEqual(merged.runtime.staleTasks, []);
});

test("dashboard reports a dead orchestrator's running tasks as stale", () => {
  // Regression: after the orchestrator died the dashboard kept claiming "8
  // worktree(s) running" alongside "0 builder(s)" — a dead run that looked live.
  const dag = dagOf([task("204"), task("205"), task("206")]);
  const state = runtime(dag.tasks, { orchestratorPid: 6720 });
  state.tasks["204"].lifecycle = "running";
  state.tasks["205"].lifecycle = "passed";
  const merged = mergeDashboardState(
    dag,
    state,
    [worktreeOf("204"), worktreeOf("205")],
    () => false,
  );
  assert.equal(merged.tasks[0].status, "stale");
  assert.equal(merged.tasks[0].staleFrom, "running");
  assert.equal(merged.tasks[1].status, "passed", "a dead run never invents a pass");
  assert.equal(merged.runtime.orchestrator.alive, false);
  assert.equal(merged.runtime.running, 0, "no live process, nothing running");
  assert.equal(merged.runtime.liveWorkers, 0);
  assert.deepEqual(merged.runtime.staleTasks, ["204"]);
  assert.deepEqual(
    merged.runtime.worktrees.map((entry) => entry.state),
    ["stale", "leftover"],
  );
  const html = readFileSync(
    fileURLToPath(new URL("./dashboard.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /b-stale/);
  assert.match(html, /Leftover worktrees/);
});

test("dashboard trusts a starting worker the live orchestrator has not stamped yet", () => {
  const dag = dagOf([task("204")]);
  const state = runtime(dag.tasks, {
    orchestratorPid: 4242,
    activeWorkers: { 204: { taskId: "204", attempt: 1 } },
  });
  state.tasks["204"].lifecycle = "running";
  const merged = mergeDashboardState(
    dag,
    state,
    [worktreeOf("204")],
    (pid) => Number(pid) === 4242,
  );
  assert.equal(merged.tasks[0].status, "running");
  assert.equal(merged.runtime.liveWorkers, 1);
});

// A real orchestrator start costs 6-10s: node startup, git plumbing, the
// dashboard spawn, and `waitForHealth`'s poll. The three tests below spawned it
// with a 10s cap, so they failed roughly one run in three on an idle machine and
// worse under load — and the failure was `status: null` on a killed process,
// which reads as a hang in the runner rather than a tight clock in the test.
// This was flaky before any of the six-epic fixes landed; three separate agents
// each blamed the others' in-flight edits for it. A test whose verdict depends
// on machine load is the same false signal as a check that never runs.
const ORCHESTRATOR_SPAWN_TIMEOUT_MS = 60_000;

test("auto starts and stops its dashboard without a package.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-dashboard-auto-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\ndag.json\n");
  writeConfig(
    repo,
    ({
      project: "dashboard-test",
      maxParallel: 1,
      defaultChecks: [],
    }),
  );
  writeFileSync(join(repo, "docs", "progress.md"), "# Progress\n");
  git("add", ".");
  git("commit", "-m", "base");
  // The DAG is an input, not project state: it never enters the repo.
  writeFileSync(join(repo, "dag.json"), JSON.stringify({ tasks: [] }));
  const port = 44000 + (process.pid % 1000);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./auto.mjs", import.meta.url)), "--dag=dag.json"],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: ORCHESTRATOR_SPAWN_TIMEOUT_MS,
      env: { ...process.env, PORT: String(port) },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(`dashboard started at http://127.0.0.1:${port}`),
  );
  assert.match(
    readFileSync(join(repo, ".afk", "dashboard.log"), "utf8"),
    new RegExp(`Dashboard: http://127.0.0.1:${port}`),
  );
  const state = JSON.parse(
    readFileSync(join(repo, ".afk", "state.json"), "utf8"),
  );
  assert.equal(state.dashboard, null);
  assert.equal(existsSync(join(repo, "package.json")), false);
});

test("--base lets the orchestrator run from a non-main branch", () => {
  // Regression: five `afk.mjs run` calls against a feature-branch checkout
  // exited instantly with the refusal visible only in a background log. The
  // guard now names the fix, and --base=<branch> makes the checked-out branch
  // the integration target instead of refusing.
  const repo = mkdtempSync(join(tmpdir(), "afk-base-branch-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\ndag.json\n");
  writeConfig(
    repo,
    ({
      project: "base-branch-test",
      maxParallel: 1,
      defaultChecks: [],
    }),
  );
  writeFileSync(join(repo, "docs", "progress.md"), "# Progress\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature/lane");
  writeFileSync(join(repo, "dag.json"), JSON.stringify({ tasks: [] }));
  const autoPath = fileURLToPath(new URL("./auto.mjs", import.meta.url));
  const port = 45000 + (process.pid % 1000);
  const env = { ...process.env, PORT: String(port) };
  const refused = spawnSync(process.execPath, [autoPath, "--dag=dag.json"], {
    cwd: repo,
    encoding: "utf8",
    timeout: ORCHESTRATOR_SPAWN_TIMEOUT_MS,
    env,
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must run from the main checkout/);
  assert.match(refused.stderr, /--base=feature\/lane/);
  const accepted = spawnSync(
    process.execPath,
    [autoPath, "--dag=dag.json", "--base=feature/lane"],
    { cwd: repo, encoding: "utf8", timeout: ORCHESTRATOR_SPAWN_TIMEOUT_MS, env },
  );
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.match(accepted.stdout, /base feature\/lane/);
});

test("rollback restores main exactly and retains the task branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-rollback-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("branch", "afk/task-204");
  writeFileSync(join(repo, "file.txt"), "bad integration\n");
  git("add", "file.txt");
  git("commit", "-m", "bad merge result");
  restoreMain(repo, base);
  assert.equal(git("rev-parse", "HEAD").stdout.trim(), base);
  assert.equal(git("status", "--porcelain").stdout, "");
  assert.equal(
    git("show-ref", "--verify", "--quiet", "refs/heads/afk/task-204").status,
    0,
    "rollback must retain the successfully produced task branch",
  );
});

test("rollback keeps untracked files it did not create", () => {
  // Regression: `git clean -fdq -e .afk` destroyed every untracked file in the
  // repo on a failed integration. Two real task specs were deleted twice, with
  // nothing in the log to say so.
  const repo = mkdtempSync(join(tmpdir(), "afk-rollback-untracked-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();

  mkdirSync(join(repo, "planning", "tasks"), { recursive: true });
  writeFileSync(join(repo, "planning", "tasks", "draft.md"), "a real spec\n");
  const preserved = ["planning/tasks/draft.md"];

  writeFileSync(join(repo, "file.txt"), "bad integration\n");
  git("add", "file.txt");
  git("commit", "-m", "bad merge result");
  writeFileSync(join(repo, "merger-scratch.txt"), "written by the merger\n");

  const removed = restoreMain(repo, base, preserved);
  assert.deepEqual(removed, ["merger-scratch.txt"]);
  assert.equal(
    existsSync(join(repo, "planning", "tasks", "draft.md")),
    true,
    "rollback must never delete untracked files that pre-dated the integration",
  );
  assert.equal(existsSync(join(repo, "merger-scratch.txt")), false);
  assert.equal(git("rev-parse", "HEAD").stdout.trim(), base);
});

test("rollback with no snapshot removes only Git's own merge leftovers", () => {
  // A caller that cannot say what pre-existed must not guess. Recovery paths
  // pass no snapshot, so they take the conservative option.
  const repo = mkdtempSync(join(tmpdir(), "afk-rollback-blind-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(repo, "notes.md"), "scratch\n");
  writeFileSync(join(repo, "file.txt.orig"), "conflict leftover\n");

  const removed = restoreMain(repo, base);
  assert.deepEqual(removed, ["file.txt.orig"]);
  assert.equal(existsSync(join(repo, "notes.md")), true);
});

test("worktreeSetup makes a fresh lane buildable", () => {
  // `git worktree add` copies tracked files only. A project whose build needs
  // installed dependencies or a gitignored credential file gets a lane that
  // cannot compile, and the error never names the missing file.
  const repo = mkdtempSync(join(tmpdir(), "afk-bootstrap-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-b", "main").status, 0);
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\nnode_modules/\n.secret.json\n");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "//\n");
  writeFileSync(join(repo, ".secret.json"), '{"token":"x"}\n');

  const setup = {
    link: ["node_modules"],
    copy: [".secret.json"],
    run: ["printf generated > generated.txt"],
  };
  const lane = createTaskWorktree({ root: repo, id: "204", baseSha: base, setup });
  assert.deepEqual(lane.setup.linked, ["node_modules"]);
  assert.deepEqual(lane.setup.copied, [".secret.json"]);
  assert.equal(
    existsSync(join(lane.worktree, "node_modules", "left-pad", "index.js")),
    true,
    "a linked dependency tree must resolve through the symlink",
  );
  assert.equal(existsSync(join(lane.worktree, ".secret.json")), true);
  assert.equal(existsSync(join(lane.worktree, "generated.txt")), true);

  // Idempotent: reuse and reset both re-apply without throwing on what is there.
  const reused = createTaskWorktree({ root: repo, id: "204", baseSha: base, setup });
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.setup.linked, []);
  resetTaskWorktree({ worktree: lane.worktree, baseSha: base, root: repo, setup });
  assert.equal(existsSync(join(lane.worktree, ".secret.json")), true);
  assert.equal(existsSync(join(lane.worktree, "node_modules")), true);
});

test("worktreeSetup names the missing file instead of failing the build later", () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-bootstrap-missing-"));
  assert.throws(
    () => bootstrapWorktree({ root: repo, worktree: repo, setup: { copy: [".infisical.json"] } }),
    /\.infisical\.json does not exist/,
  );
});

test("the DAG's task list is folded into runtime state on restart", () => {
  // Regression: `.afk/state.json` is the scheduler's source of truth, so a task
  // the state file had never heard of read as pending and got a full builder
  // launched at already-merged work — twice, on a real run. Seeding is what
  // stops that; with no status on a DAG task there is nothing left to adopt,
  // so a missing entry now genuinely means "never run".
  const dag = dagOf([task("204"), task("205"), task("206"), task("207")]);
  const state = {
    activeWorkers: {},
    tasks: {
      204: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 },
      206: { lifecycle: "pending", builderAttempt: 0, integrationAttempt: 0 },
      299: { lifecycle: "passed", builderAttempt: 1, integrationAttempt: 1 },
    },
  };
  const result = reconcileWithDag(state, dag);
  assert.deepEqual(result.seeded, ["205", "207"]);
  assert.equal(
    result.state.tasks["205"].lifecycle,
    "pending",
    "a seeded task has never run",
  );
  assert.equal(
    result.state.tasks["204"].lifecycle,
    "passed",
    "a task state calls passed must not be rebuilt",
  );
  assert.deepEqual(
    result.orphaned,
    ["299"],
    "an id no longer in the DAG is reported, not silently dropped",
  );
});

test("reconciling never overwrites a lifecycle state already holds", () => {
  // State is the sole owner of lifecycle, so reconciliation may only add.
  // In-flight work is the case that used to be at risk: a second opinion that
  // outranked `running` would have relaunched a live lane.
  const dag = dagOf([task("204")]);
  const state = {
    activeWorkers: { 204: { pid: 123 } },
    tasks: { 204: { lifecycle: "running", builderAttempt: 1 } },
  };
  const result = reconcileWithDag(state, dag);
  assert.equal(result.state.tasks["204"].lifecycle, "running");
  assert.deepEqual(result.seeded, []);
  assert.deepEqual(result.orphaned, []);
});

test("progress.md renders lifecycle from state, never from the DAG", () => {
  // docs/progress.md is the human-readable projection of a run. The DAG carries
  // no status, so a task with no state entry must render as pending rather than
  // as `undefined`.
  const dag = {
    epic: { id: "203", title: "Stripe subscriptions" },
    branch: "feat/203",
    tasks: [task("204"), task("205", ["204"], { humanGated: true })],
  };
  const rendered = renderProgress(dag, {
    tasks: { 204: { lifecycle: "passed" } },
  });
  assert.match(rendered, /# Progress — Stripe subscriptions/);
  assert.match(rendered, /\| 204 \| 204 \| passed \| - \|/);
  assert.match(rendered, /\| 205 \| 205 🔒 \| pending \| 204 \|/);
  assert.match(rendered, /human-gated/);
});

test("a second epic's progress is added to docs/progress.md, not written over it", () => {
  // `renderProgress` renders ONE epic, and the status flush used to
  // `atomicWrite` that over the whole file. Every epic therefore deleted every
  // earlier epic's table: epic #93 dropped ~146 lines of its predecessors and
  // its reflection predicted the recurrence in writing. The file is the
  // project's, not the run's.
  const epicA = {
    epic: { id: "203", title: "Stripe subscriptions" },
    tasks: [task("204")],
  };
  const epicB = {
    epic: { id: "391", title: "One canonical thing per concept" },
    tasks: [task("169")],
  };
  const first = mergeProgress("", epicA, { tasks: { 204: { lifecycle: "passed" } } });
  assert.match(first, /Stripe subscriptions/);
  assert.match(first, /<!-- afk:progress:203 -->/);

  const second = mergeProgress(first, epicB, { tasks: { 169: { lifecycle: "running" } } });
  assert.match(second, /Stripe subscriptions/, "the earlier epic's section survives");
  assert.match(second, /\| 204 \| 204 \| passed \| - \|/, "and so does its table");
  assert.match(second, /One canonical thing per concept/);
  assert.match(second, /\| 169 \| 169 \| running \| - \|/);

  // The same epic flushing again replaces its own section in place rather than
  // appending a second copy — a run flushes on every task verdict.
  const again = mergeProgress(second, epicB, { tasks: { 169: { lifecycle: "passed" } } });
  assert.equal(again.match(/<!-- afk:progress:391 -->/g).length, 1);
  assert.match(again, /\| 169 \| 169 \| passed \| - \|/);
  assert.doesNotMatch(again, /\| 169 \| 169 \| running \| - \|/);
  assert.match(again, /Stripe subscriptions/, "and still not at the earlier epic's expense");
  assert.match(again, /\| 204 \| 204 \| passed \| - \|/);
});

test("progress written by an epic-less run keeps the whole-file behaviour", () => {
  // The `--dag=` seam carries no epic id, so there is no marker to key a
  // section on. Overwriting is the honest fallback: inventing an id would put
  // two different runs' tables under one heading.
  const dag = { tasks: [task("204")] };
  const merged = mergeProgress("# Progress\n\nsomething older\n", dag, {});
  assert.doesNotMatch(merged, /something older/);
  assert.match(merged, /\| 204 \| 204 \| pending \| - \|/);
});

test("a section ends where it ends, and anything below it survives a re-flush", () => {
  // The first cut of this searched forward for the NEXT epic's marker and, when
  // there wasn't one, took the rest of the file as the section. So the last
  // section on the page swallowed everything after it — which is the very bug
  // this function exists to fix, reintroduced at the tail. A section needs an
  // end, not a guess about where the next one starts.
  const dag = { epic: { id: "203", title: "Stripe subscriptions" }, tasks: [task("204")] };
  const withNotes = `${mergeProgress("", dag, {})}\n## Notes from a human\n\nDo not delete me.\n`;
  const again = mergeProgress(withNotes, dag, { tasks: { 204: { lifecycle: "passed" } } });
  assert.match(again, /Do not delete me\./, "content below the last section is not the runner's to remove");
  assert.match(again, /\| 204 \| 204 \| passed \| - \|/, "and the section still updates in place");
  assert.equal(again.match(/<!-- afk:progress:203 -->/g).length, 1);

  // The same, with the human's note wedged BETWEEN two epics' sections.
  const two = mergeProgress(withNotes, { epic: { id: "391" }, tasks: [task("169")] }, {});
  const reflushed = mergeProgress(two, dag, {});
  assert.match(reflushed, /Do not delete me\./);
  assert.match(reflushed, /\| 169 \| 169 \| pending \| - \|/, "and the other epic's table is intact");
});

test("the first flush under a marker does not eat the file that was already there", () => {
  // Real projects have an unmarked docs/progress.md written by every epic
  // before this existed. The first marked flush must sit below it.
  const existing = "# Progress — an epic from before markers\n\n| ID | Task |\n| --- | --- |\n| 1 | old |\n";
  const merged = mergeProgress(existing, { epic: { id: "500" }, tasks: [task("501")] }, {});
  assert.match(merged, /an epic from before markers/);
  assert.match(merged, /\| 1 \| old \|/);
  assert.match(merged, /<!-- afk:progress:500 -->/);
});

test("preflight catches a dead login or a missing secret before any builder spawns", () => {
  // Regression: an expired `claude` login made every builder exit non-zero in
  // under two seconds; the breaker read that as bad tickets and halted after
  // marking good work failed. Preflight now fails closed, to STDOUT, before the
  // first builder is spawned.
  const config = { requiredEnv: ["INFISICAL_TOKEN"] };
  const env = { INFISICAL_TOKEN: "present" };
  assert.deepEqual(
    preflightBlockers({ config, env, checkAuth: () => true }),
    [],
    "an authenticated login with every required secret clears preflight",
  );
  assert.deepEqual(
    preflightBlockers({ config, env, checkAuth: () => false }),
    ["not authenticated"],
  );
  assert.deepEqual(
    preflightBlockers({ config, env: {}, checkAuth: () => true }),
    ["missing env INFISICAL_TOKEN"],
  );
  assert.deepEqual(
    preflightBlockers({ config: {}, env: {}, checkAuth: () => true }),
    [],
    "a config with no requiredEnv has no secrets to check",
  );
});

test("preflight names the login of the backend it probed, and no other", () => {
  // The failure this exists for: `afk-codex` refusing on a dead login and
  // telling the operator to run `claude auth login` — a CLI the run never
  // touched. The probe itself is the shared one; only the remedy differs.
  assert.equal(preflightLine("not authenticated", "claude"), "not authenticated — run `claude auth login`");
  assert.equal(preflightLine("not authenticated", "codex"), "not authenticated — run `codex login`");
  // `codex auth login` is not a command. The verb shapes differ and are held
  // apart on the record, not assembled from the CLI name.
  assert.deepEqual(authCommands("codex").loginArgs, ["login"]);
  assert.deepEqual(authCommands("claude").loginArgs, ["auth", "login"]);
  assert.deepEqual(authCommands("codex").logout, ["logout"]);
  assert.deepEqual(authCommands("claude").logout, ["auth", "logout"]);
  // A missing secret is not an auth failure and gets no login attached.
  assert.equal(preflightLine("missing env INFISICAL_TOKEN", "codex"), "missing env INFISICAL_TOKEN");
  assert.throws(() => authCommands("gemini"), /Unknown agent backend/);
});

test("Codex refuses the herdr runtime; the other three combinations are untouched", () => {
  // The herdr runtime types into a pane and reads the lane's report out of that
  // pane's scrollback. `codex exec --json` is a non-interactive pipe with
  // neither, so every lane would produce no report — minutes later, silently.
  // Refused instead, before the plan review (scripts/epic.mjs) and again before
  // the first lane (`runAuto`).
  const refusal = herdrRefusal({ backend: "codex", runtime: "herdr" });
  assert.match(refusal, /supports only the direct runtime/);
  assert.match(refusal, /--runtime=herdr/, "the refusal names what to remove");
  // Config-borne, not just flag-borne: `agent.runtime: herdr` in a committed
  // .afk-setup/config.yaml is the same run and must refuse the same way.
  assert.match(
    herdrRefusal({ backend: "codex", runtime: null, config: { agent: { runtime: "herdr" } } }),
    /supports only the direct runtime/,
  );
  // A flag beats the config, in both directions.
  assert.equal(herdrRefusal({ backend: "codex", runtime: "direct", config: { agent: { runtime: "herdr" } } }), null);
  assert.match(
    herdrRefusal({ backend: "codex", runtime: "herdr", config: { agent: { runtime: "direct" } } }),
    /direct runtime/,
  );
  // Narrow on both axes. Claude keeps herdr; Codex keeps direct and the default.
  assert.equal(herdrRefusal({ backend: "claude", runtime: "herdr" }), null);
  assert.equal(herdrRefusal({ backend: "claude", runtime: "direct" }), null);
  assert.equal(herdrRefusal({ backend: "codex", runtime: "direct" }), null);
  assert.equal(herdrRefusal({ backend: "codex", runtime: null }), null, "the default runtime is direct");
});

test("a wave of near-instant uniform failures reads as infra, not bad tickets", () => {
  // Two unrelated tasks, both dead in well under two seconds: the environment,
  // not the tickets. The breaker reports this instead of blaming the tickets.
  assert.ok(
    looksLikeInfra([
      { taskId: "204", durationMs: 900 },
      { taskId: "205", durationMs: 1200 },
    ]),
  );
  // One task failing twice is a retry of the same ticket, not a wave.
  assert.ok(
    !looksLikeInfra([
      { taskId: "204", durationMs: 900 },
      { taskId: "204", durationMs: 800 },
    ]),
  );
  // A failure that took real work first is a ticket, not infra.
  assert.ok(
    !looksLikeInfra([
      { taskId: "204", durationMs: 900 },
      { taskId: "205", durationMs: INFRA_FAILURE_MS + 500 },
    ]),
  );
  // A single failure is not yet a pattern.
  assert.ok(!looksLikeInfra([{ taskId: "204", durationMs: 100 }]));
  // Slow, but nothing was spent: the same fault, and the breaker has to halt
  // under the infra label rather than "N tasks failed in a row".
  assert.ok(
    looksLikeInfra([
      { taskId: "204", durationMs: 114_456, neverReachedApi: true },
      { taskId: "205", durationMs: 114_711, neverReachedApi: true },
    ]),
  );
  // One of each is still not uniform, so it stays a ticket problem.
  assert.ok(
    !looksLikeInfra([
      { taskId: "204", durationMs: 114_456, neverReachedApi: true },
      { taskId: "205", durationMs: 300_000 },
    ]),
  );
});

test("a lane that spent nothing never reached the API, however long it took", () => {
  // The slow half of the same problem. `looksLikeInfra` needs a cluster of
  // sub-second failures; these two lanes took 114 seconds each and were a
  // quarter-second apart, which is a fixed runtime deadline. Both were recorded
  // `blocked` — the ticket taking the blame for the harness — and both passed on
  // a clean retry.
  assert.ok(neverReachedApi({ tokens: { input: 0, output: 0, cacheRead: 0 }, durationMs: 114_456 }));
  // Real work happened, so a blocked lane means what it says.
  assert.ok(!neverReachedApi({ tokens: { input: 1200, output: 0, cacheRead: 0 }, durationMs: 114_456 }));
  // Absent is NOT zero: only the herdr runtime reports tokens, and reading a
  // direct lane's silence as infra would relabel every honest refusal.
  assert.ok(!neverReachedApi({ durationMs: 90 }));
  assert.ok(!neverReachedApi(undefined));
  // And an empty bag is absent, not zero — a runtime that reported no counters
  // is silent, not proof that nothing was spent.
  assert.ok(!neverReachedApi({ tokens: {}, durationMs: 114_711 }));
  // Epic 50 on gitproj-demo, lanes 45/46: zero tokens but a file landed on disk.
  // That is a metering gap, not an infra death — the file is proof the API was
  // reached, whatever the counters say.
  assert.ok(
    !neverReachedApi({
      tokens: { input: 0, output: 0, cacheRead: 0 },
      producedFiles: ["src/cli.js"],
    }),
  );
  // Zero tokens AND no produced files is still the genuine infra death.
  assert.ok(
    neverReachedApi({
      tokens: { input: 0, output: 0, cacheRead: 0 },
      producedFiles: [],
    }),
  );
  // producedFiles absent falls through to the token logic unchanged.
  assert.ok(
    neverReachedApi({ tokens: { input: 0, output: 0, cacheRead: 0 } }),
  );
});

test("builder and merger complete the real happy path with fresh fake Claude processes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-happy-"));
  const git = (cwd, ...args) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(git(repo, "init", "-b", "main").status, 0);
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  mkdirSync(join(repo, "planning", "tasks"), { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Test worker rules\n");
  // A TRACKED .claude/settings.json, because that is the shape that broke: the
  // project owns this directory and a lane must not be able to commit a change
  // to it — least of all a deletion.
  writeFileSync(join(repo, ".claude", "settings.json"), '{"project":"settings"}\n');
  writeConfig(repo, { defaultChecks: [] });
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: "204", baseSha: base });

  const bin = mkdtempSync(join(tmpdir(), "afk-fake-bin-"));
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const branch = input.match(/Task branch: ([^\\n]+)/)?.[1];
  if (branch) {
    const merged = cp.spawnSync('git', ['merge', '--no-ff', '--no-edit', branch], { encoding: 'utf8' });
    if (merged.status !== 0) { process.stderr.write(merged.stderr); process.exit(merged.status || 1); }
  } else {
    fs.writeFileSync('source.txt', 'built\\n');
    // What the herdr lane teardown used to do: remove the whole .claude/
    // directory, taking the project's tracked settings.json with it.
    fs.rmSync('.claude', { recursive: true, force: true });
    fs.mkdirSync('runs/204', { recursive: true });
    fs.writeFileSync('runs/204/report.md', '# Report\\n\\nBuilt source.txt.\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, result: 'done' }) + '\\n');
});
`,
  );
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    // A DAG task: issue-number id, specification text in `body`, no status.
    const taskSpec = {
      id: "204",
      title: "Test",
      dependsOn: [],
      allowedPaths: ["source.txt"],
      checks: ["test -f source.txt"],
      body: "# 204 — Test\n\nCreate source.txt.\n",
    };
    const config = {
      maxParallel: 1,
      defaultChecks: ["test -f source.txt"],
      agent: {
        command: "claude",
        model: "claude-opus-5",
        reasoningEffort: "medium",
        bypassPermissions: true,
        timeoutMs: 10_000,
        // Pinned, not defaulted. This test drives runBuilder against a fake
        // `claude` on PATH; under the herdr runtime it instead opens a REAL
        // herdr workspace named after its temp dir, and never closes it. That
        // is how 166 `afk-happy-*` spaces and 1.7GB of /tmp accumulated in the
        // operator's sidebar before anyone noticed.
        runtime: "direct",
      },
    };
    const built = await runBuilder({
      root: repo,
      config,
      task: taskSpec,
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha: base,
      attempt: 1,
      ledgerNotes: "- [constraint] from 205: resolve Price by lookup_key",
      // Supplied rather than read off disk — `auto.mjs` owns the read, because
      // only the scheduler knows which attempt is starting. What is under test
      // here is the last link of that chain: a value handed to `runBuilder`
      // reaching the file the agent is actually given, which is exactly what
      // the ledger assertion below covers for its own channel.
      priorAttempts: "Attempt 1 failed.\n  First failing check: test -f source.txt",
    });
    assert.equal(built.outcome, "ready_to_integrate");
    assert.match(
      readFileSync(join(repo, ".afk", "runs", "204", "builder-1", "prompt.md"), "utf8"),
      /Earlier attempts at this same task failed[\s\S]*First failing check: test -f source\.txt/,
    );
    // The ledger's read path, end to end: a finding tagged for this task has to
    // reach the file the agent is actually handed, not just the renderer.
    assert.match(
      readFileSync(join(repo, ".afk", "runs", "204", "builder-1", "prompt.md"), "utf8"),
      /Cross-lane findings[\s\S]*resolve Price by lookup_key/,
    );
    assert.equal(git(lane.worktree, "status", "--porcelain").stdout, "");
    assert.equal(
      git(lane.worktree, "log", "-1", "--format=%s").stdout.trim(),
      "task 204: Test",
    );

    // The project's own .claude/ survives the lane, and the deletion is neither
    // committed nor counted as task output. Every lane of the first live epic
    // committed exactly this deletion; the merges hid it in the net diff.
    assert.equal(
      existsSync(join(lane.worktree, ".claude", "settings.json")),
      true,
      "the project's .claude/settings.json was restored",
    );
    assert.ok(
      built.verification.revertedProtected.includes(".claude/settings.json"),
      `reverted: ${JSON.stringify(built.verification.revertedProtected)}`,
    );
    assert.ok(
      !built.verification.producedFiles.some((file) => file.startsWith(".claude/")),
      "a protected revert is not task output",
    );
    assert.equal(
      git(lane.worktree, "show", "--name-only", "--format=", "HEAD").stdout
        .split("\n")
        .filter(Boolean)
        .some((file) => file.startsWith(".claude/")),
      false,
      "no .claude/ path reached the lane's commit",
    );

    // Regression: an unrelated untracked file failed an integration whose merge
    // was correct and whose checks would have passed — and the rollback that
    // followed deleted the file. Both must now be non-events.
    const bystander = join(repo, "planning", "tasks", "scratch.md");
    writeFileSync(bystander, "unrelated draft\n");

    const integrated = await runIntegration({
      root: repo,
      config,
      task: taskSpec,
      branch: lane.branch,
      baseSha: base,
      attempt: 1,
      taskVerification: built.verification,
    });
    assert.equal(
      integrated.outcome,
      "passed",
      `unrelated untracked dirt must not fail an integration (${integrated.failureReason})`,
    );
    assert.equal(existsSync(bystander), true);
    assert.equal(
      git(repo, "merge-base", "--is-ancestor", built.commitSha, "main").status,
      0,
    );
    assert.equal(
      git(repo, "rev-list", "--parents", "-n", "1", integrated.head)
        .stdout.trim()
        .split(/\s+/).length,
      3,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("a builder that writes outside its lane is stopped, not committed", async () => {
  // docs/findings.md 3.15, end to end through the real runBuilder. Measured
  // live: under bypass the `Write` tool reaches the main checkout and a SIBLING
  // lane, with no error and no recorded denial — so the runner has to see the
  // crossing itself or it is invisible until it surfaces as a merge conflict.
  const repo = mkdtempSync(join(tmpdir(), "afk-escape-"));
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, { defaultChecks: [] });
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: "301", baseSha: base });
  // A real second lane, because that is the target the live probe reached and
  // the one that would surface as an inexplicable conflict rather than as
  // anything resembling a permissions event.
  const sibling = createTaskWorktree({ root: repo, id: "302", baseSha: base });
  const strayInSibling = join(sibling.worktree, "stray.txt");

  const bin = mkdtempSync(join(tmpdir(), "afk-fake-bin-"));
  const fake = join(bin, "claude");
  // The fake does its real work in-lane AND writes the sibling, reporting the
  // sibling write as a `Write` tool_use exactly as a live transcript carries
  // it. Both halves matter: a lane that only misbehaved would be caught by any
  // check, and this must be caught even though the ticket's own work is fine.
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const stray = ${JSON.stringify(strayInSibling)};
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('source.txt', 'built\\n');
  fs.writeFileSync(stray, 'escaped\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'source.txt', content: 'built' } },
    { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: stray, content: 'escaped' } },
  ] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, result: 'done' }) + '\\n');
});
`,
  );
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const built = await runBuilder({
      root: repo,
      config: {
        maxParallel: 1,
        defaultChecks: [],
        agent: {
          command: "claude", model: "claude-opus-5", bypassPermissions: true,
          timeoutMs: 10_000, runtime: "direct",
        },
      },
      task: {
        id: "301", title: "Escape", dependsOn: [], allowedPaths: ["source.txt"],
        // The checks PASS. An escape must fail the lane on its own, or it is
        // only caught when the ticket was going to fail anyway.
        checks: ["test -f source.txt"],
        body: "# 301\n",
      },
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha: base,
      attempt: 1,
    });
    assert.equal(built.outcome, "failed", JSON.stringify(built.verification, null, 2));
    // Reported canonically — `git worktree list` speaks `/private/var` while
    // the runner's own lane path is the `/var` symlink, and the detector
    // resolves both so the comparison cannot silently miss.
    assert.deepEqual(
      built.verification.wroteOutsideLane.map((entry) => entry.path),
      [realpathSync(strayInSibling)],
    );
    // The in-lane write is ordinary work and must not be reported as an escape.
    assert.ok(built.verification.producedFiles.includes("source.txt"));
    // Nothing was committed: the lane's own work stays uncommitted for a human
    // to look at, and the branch tip has not moved.
    assert.equal(git(lane.worktree, "rev-parse", "HEAD").stdout.trim(), base);
    // And the runner does NOT tidy up the foreign file. Removing it would erase
    // the evidence of the one thing this exists to surface.
    assert.equal(readFileSync(strayInSibling, "utf8"), "escaped\n");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("an escaped builder fails even when it is also rate-limited", async () => {
  // Found in review, and it is the dangerous ordering: `rate_limited` routes
  // through auto.mjs's RETRY, which calls `resetTaskWorktree`. That would wipe
  // this lane while the file the builder wrote into another lane stayed exactly
  // where it is — the evidence destroyed and the escape kept. So the escape
  // has to be decided before the rate limit, not after.
  const repo = mkdtempSync(join(tmpdir(), "afk-escape-429-"));
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "runner@example.test");
  git(repo, "config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const lane = createTaskWorktree({ root: repo, id: "401", baseSha: base });
  const sibling = createTaskWorktree({ root: repo, id: "402", baseSha: base });
  const stray = join(sibling.worktree, "stray.txt");

  const bin = mkdtempSync(join(tmpdir(), "afk-fake-bin-"));
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const stray = ${JSON.stringify(stray)};
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(stray, 'escaped\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: stray, content: 'escaped' } },
  ] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'error', error: { status: 429 }, message: 'rate limit' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', total_cost_usd: 0 }) + '\\n');
});
`,
  );
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const built = await runBuilder({
      root: repo,
      config: {
        maxParallel: 1,
        defaultChecks: [],
        agent: {
          command: "claude", model: "claude-opus-5", bypassPermissions: true,
          timeoutMs: 10_000, runtime: "direct",
        },
      },
      task: { id: "401", title: "Escape", dependsOn: [], allowedPaths: [], checks: [], body: "# 401\n" },
      worktree: lane.worktree,
      branch: lane.branch,
      baseSha: base,
      attempt: 1,
    });
    assert.equal(built.verification.rateLimited, true, "the fixture must really look rate-limited");
    assert.equal(
      built.outcome,
      "failed",
      "an escape must outrank the rate limit, or the retry path resets the lane",
    );
    assert.deepEqual(
      built.verification.wroteOutsideLane.map((entry) => entry.path),
      [realpathSync(stray)],
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// --- the DAG boundary resolves the spec's optional fields --------------------
// docs/epic-schema.md: "`checks` — optional narrowing. Absent means
// `defaultChecks`." Nothing implemented that, and the two consumers disagreed
// about what absent meant: worker.mjs threw on `task.checks.join()`, while
// integrate.mjs's `task.checks ?? []` merged having run zero post-merge checks
// and said nothing. These pin the resolution to one place.

test("a task that narrows nothing inherits defaultChecks at the DAG boundary", () => {
  const config = { defaultChecks: ["npm run lint", "npm test"] };
  const dag = normalizeDag({ tasks: [{ id: 204, dependsOn: [] }] }, config);
  assert.deepEqual(dag.tasks[0].checks, ["npm run lint", "npm test"]);
  // Resolved, not aliased: mutating the task must not edit the stack config.
  assert.notEqual(dag.tasks[0].checks, config.defaultChecks);
});

test("a task that narrows its checks keeps them, not defaultChecks", () => {
  const dag = normalizeDag(
    { tasks: [{ id: 208, dependsOn: [], checks: ["npm test"] }] },
    { defaultChecks: ["npm run lint", "npm run typecheck", "npm test"] },
  );
  assert.deepEqual(dag.tasks[0].checks, ["npm test"]);
});

test("a task with no allowedPaths gets repo-wide scope, not zero scope", () => {
  // `[]` would be the tempting default and is the wrong one: pathAllowed is
  // false for every file against an empty pattern list, so every changed file
  // would report out-of-scope — noise that looks like safety. v1 ships advisory
  // repo-wide scope (docs/epic-schema.md failure mode 2).
  const dag = normalizeDag({ tasks: [{ id: 204, dependsOn: [] }] }, { defaultChecks: ["npm test"] });
  assert.deepEqual(dag.tasks[0].allowedPaths, ["**"]);
  for (const file of ["src/app.ts", "deep/nested/dir/file.rs", "README.md"])
    assert.equal(pathAllowed(file, dag.tasks[0].allowedPaths), true, file);
});

test("a task whose resolved checks are empty is refused by id, not admitted", () => {
  // The alternative is a lane that builds, integrates and merges having run no
  // gate at all. Refuse at the boundary, naming the task, as loadConfig refuses
  // a missing .afk-setup/config.yaml.
  assert.throws(
    () => normalizeDag({ tasks: [{ id: 204, dependsOn: [] }] }, { defaultChecks: [] }),
    /Task 204 has no checks/,
  );
  // Same refusal when the stack config omits defaultChecks entirely.
  assert.throws(() => normalizeDag({ tasks: [{ id: 209, dependsOn: [] }] }, {}), /Task 209/);
  // And when the task itself authors an empty narrowing.
  assert.throws(
    () => normalizeDag({ tasks: [{ id: 211, checks: [] }] }, { defaultChecks: ["npm test"] }),
    /Task 211/,
  );
});

test("the post-merge gate can never run an empty check list", () => {
  // The shape that would have shipped: no `checks` on the task and
  // `baselineChecks: []` in .afk-setup/config.yaml — exactly the example in
  // docs/epic-schema.md — merged with zero post-merge commands.
  const config = { defaultChecks: ["npm test"], baselineChecks: [] };
  const dag = normalizeDag({ tasks: [{ id: 204, dependsOn: [] }] }, config);
  assert.deepEqual(postMergeChecks(dag.tasks[0], config), ["npm test"]);
  // Baseline is unioned in, never substituted for, and never duplicated.
  const wide = { defaultChecks: ["npm test"], baselineChecks: ["npm test", "npm run build"] };
  assert.deepEqual(
    postMergeChecks(normalizeDag({ tasks: [{ id: 205 }] }, wide).tasks[0], wide),
    ["npm test", "npm run build"],
  );
  // Every task a normalized DAG admits gates the merge.
  for (const task of normalizeDag(
    { tasks: [{ id: 204 }, { id: 205, checks: ["npm run lint"] }] },
    config,
  ).tasks)
    assert.ok(postMergeChecks(task, config).length > 0, task.id);
  // No boundary, no merge: integration refuses rather than silently gating on
  // nothing, so the unresolved task cannot reach a blessed merge.
  assert.throws(() => postMergeChecks({ id: "204" }, config), TypeError);
});

test("lifecycleOf answers for a task record and a bare id alike", () => {
  // One seam for "no state entry means pending" — the rule used to be retyped
  // in six files, so adding a lifecycle cost six edits and the copies could
  // drift while each still looked right alone.
  const state = { tasks: { 204: { lifecycle: "passed" } } };
  assert.equal(lifecycleOf({ id: "204" }, state), "passed");
  assert.equal(lifecycleOf("204", state), "passed");
  assert.equal(lifecycleOf({ id: "999" }, state), "pending");
  assert.equal(lifecycleOf("999", state), "pending");
  assert.equal(lifecycleOf("204", {}), "pending");
  assert.equal(lifecycleOf("204", undefined), "pending");
  // The scheduler's re-export is the same function, not a second copy.
  assert.equal(schedulerLifecycleOf, lifecycleOf);
});

test("auth death has one definition, and no file carries a second copy", () => {
  // Four files used to spell this regex out, each with a comment explaining
  // that the duplication was deliberate and that the copies must be changed
  // together. That is the shape docs/findings.md 6.2 names: when isolated
  // authors reach for the same literal, the shared code is missing, not the
  // duplication justified. The grep is the test — a fifth copy is the failure.
  assert.equal(looksLikeAuthDeath("OAuth session expired"), true);
  assert.equal(looksLikeAuthDeath("... {\"type\":\"authentication_error\"}"), true);
  assert.equal(looksLikeAuthDeath("Failed to authenticate with the API"), true);
  assert.equal(looksLikeAuthDeath("all good"), false);
  // Never throws on the shapes callers actually pass when a stream is empty.
  assert.equal(looksLikeAuthDeath(null), false);
  assert.equal(looksLikeAuthDeath(undefined), false);

  const dir = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const copies = readdirSync(dir)
    .filter((name) => name.endsWith(".mjs") && !name.includes(".test."))
    .filter((name) => name !== "lib.mjs" && name !== "selftest.mjs")
    .filter((name) => /OAuth session expired/.test(readFileSync(resolve(dir, name), "utf8")));
  assert.deepEqual(copies, [], `import looksLikeAuthDeath from lib.mjs instead: ${copies.join(", ")}`);
});

test("notify prefers terminal-notifier, attaches -execute only when given one", () => {
  // A fake on PATH rather than a spawn seam: what matters is the argv the real
  // binary receives, and an injected function would let that drift.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-bin-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    assert.equal(
      notify({
        title: "AFK runner — repo",
        subtitle: "#207 blocked",
        message: "needs input",
        level: "error",
        group: "afk-lane-207",
        execute: "herdr workspace focus w23",
      }),
      "terminal-notifier",
    );
    const first = readFileSync(log, "utf8");
    assert.match(first, /-execute\nherdr workspace focus w23/);
    assert.match(first, /-subtitle\n#207 blocked/);
    // A blocked lane is the event a human must act on, so it takes the two
    // things the sender actually controls: the alarming sound and the Do Not
    // Disturb override.
    assert.match(first, new RegExp(`-sound\\n${NOTIFY_LEVELS.error.sound}`));
    assert.match(first, /-ignoreDnD/);
    // Grouped by lane, so a lane that starts then blocks leaves ONE banner.
    assert.match(first, /-group\nafk-lane-207/);

    // Good news does not pierce Do Not Disturb, and does not sound like a
    // problem. Only the two events that stop the run are allowed to be loud.
    writeFileSync(log, "");
    notify({ title: "AFK runner", message: "epic finished", level: "success" });
    const done = readFileSync(log, "utf8");
    assert.doesNotMatch(done, /-ignoreDnD/);
    assert.match(done, new RegExp(`-sound\\n${NOTIFY_LEVELS.success.sound}`));
    assert.notEqual(NOTIFY_LEVELS.success.sound, NOTIFY_LEVELS.error.sound,
      "an epic finishing and a lane dying must not sound the same");
    // No quiet level exists, because macOS gives a sender no way to be quiet.
    // Anything the runner sends WILL interrupt, so nothing routine may be sent.
    assert.equal(NOTIFY_LEVELS.info, undefined,
      "reintroducing an `info` level reintroduces the notification storm");

    // No workspace, no click. A click that runs a failing command is worse than
    // a click that does nothing.
    writeFileSync(log, "");
    notify({ title: "AFK runner", message: "no lane in hand" });
    assert.doesNotMatch(readFileSync(log, "utf8"), /-execute/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /-group/);
  } finally {
    process.env.PATH = previous;
  }
});

test("only the events a human must act on are allowed to interrupt", async () => {
  // The volume complaint was never about severity. Every event below `success`
  // already meant "something stopped", so the only knob that reduces banners is
  // which events send at all. Default: a blocked lane, a human gate, and a
  // dead orchestrator (#144).
  assert.deepEqual([...NOTIFY_ONLY].sort(), ["gate_reached", "lane_blocked", "orchestrator_fatal"]);

  const bin = mkdtempSync(join(tmpdir(), "afk-notify-policy-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  writeFileSync(log, ""); // absent and empty both mean "never ran"; pick one.
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    // Suppression is a return value, not a thrown error and not a silent no-op:
    // the caller reporting a dead lane must still get an answer it can log.
    for (const kind of ["lane_died", "auth_expired", "runner_stalled", "epic_ended", "lane_failed"]) {
      assert.equal(notify({ title: "AFK runner", message: kind, level: "error", kind }), "suppressed");
    }
    assert.equal(readFileSync(log, "utf8"), "", "a suppressed event must not reach the binary");

    // A declared event does not go out on its own any more: it waits for the
    // coalescing window so a five-lane burst leaves one banner. `flush` is what
    // the timer (and the exit hook) would have done.
    for (const kind of ["lane_blocked", "gate_reached"]) {
      resetNotifyState();
      assert.equal(notify({ title: "AFK runner", message: kind, level: "error", kind }), "coalesced");
      assert.equal(flushNotifications(), "terminal-notifier");
    }
    // An UNDECLARED notification still delivers. notify() is the renderer, and
    // `afk notify` has to fire one of every severity whatever the policy
    // says — a test that the policy can silence proves nothing.
    assert.equal(notify({ title: "AFK runner", message: "unfiltered" }), "terminal-notifier");
  } finally {
    process.env.PATH = previous;
  }
});

test("a burst of blocked lanes leaves ONE notification, not one per lane", () => {
  // The complaint this exists for: five lanes reaching a phase boundary
  // together, each correctly sending its own banner. Nothing there is a repeat,
  // so no allow-list and no notifier package reduces it — the only fix is the
  // runner making fewer calls.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-burst-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nprintf -- '--\\n' >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  writeFileSync(log, "");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  resetNotifyState();
  try {
    for (const task of [207, 208, 209]) {
      assert.equal(
        notify({
          title: "AFK runner — repo",
          subtitle: `#${task} blocked`,
          message: "needs input",
          level: "error",
          kind: "lane_blocked",
          group: `afk-lane-${task}`,
          execute: `herdr workspace focus w${task}`,
        }),
        "coalesced",
      );
    }
    assert.equal(readFileSync(log, "utf8"), "", "nothing leaves during the window");

    assert.equal(flushNotifications(), "terminal-notifier");
    const sent = readFileSync(log, "utf8");
    assert.equal(sent.match(/^--$/gm).length, 1, "three blocked lanes, one banner");
    // Every lane is still named — a merged banner that hid which tickets are
    // waiting would trade a storm for a mystery.
    for (const task of [207, 208, 209]) assert.match(sent, new RegExp(`#${task} blocked`));
    // Three lanes want three different panes, so the click cannot pick one.
    // `-activate` still raises the terminal; that is the honest offer.
    assert.doesNotMatch(sent, /-execute/);

    // A LONE event is delivered as itself, click and all: coalescing must not
    // cost the one case that has somewhere to click to.
    writeFileSync(log, "");
    resetNotifyState();
    notify({
      title: "AFK runner — repo",
      subtitle: "#207 blocked",
      message: "needs input",
      level: "error",
      kind: "lane_blocked",
      group: "afk-lane-207",
      execute: "herdr workspace focus w23",
    });
    flushNotifications();
    assert.match(readFileSync(log, "utf8"), /-execute\nherdr workspace focus w23/);
  } finally {
    process.env.PATH = previous;
    resetNotifyState();
  }
});

test("the supervisor's opinion about a lane does not re-notify for that lane", () => {
  // A blocked lane notifies immediately; the supervisor reaches the same
  // conclusion a session later and asks to be heard about the same ticket.
  // Sharing the ticket's group makes those one event.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-dedupe-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nprintf -- '--\\n' >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  writeFileSync(log, "");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  resetNotifyState();
  try {
    notify({ title: "AFK runner", subtitle: "#207 blocked", message: "needs input",
      level: "error", kind: "lane_blocked", group: "afk-lane-207" });
    flushNotifications();
    assert.equal(readFileSync(log, "utf8").match(/^--$/gm).length, 1);

    // The supervisor, later, about the same ticket — dropped, not queued.
    assert.equal(
      notify({ title: "AFK runner", subtitle: "#207 is blocked", message: "the supervisor agrees",
        level: "error", kind: "lane_blocked", group: "afk-lane-207" }),
      "deduped",
    );
    assert.equal(flushNotifications(), null, "a deduped event leaves nothing buffered");
    assert.equal(readFileSync(log, "utf8").match(/^--$/gm).length, 1, "still one banner for #207");

    // A DIFFERENT ticket is different news and still interrupts.
    assert.equal(
      notify({ title: "AFK runner", subtitle: "#208 blocked", message: "needs input",
        level: "error", kind: "lane_blocked", group: "afk-lane-208" }),
      "coalesced",
    );
    flushNotifications();
    assert.equal(readFileSync(log, "utf8").match(/^--$/gm).length, 2);

    // The window can be turned off for a run that wants every report.
    process.env.AFK_NOTIFY_REPEAT_MS = "0";
    assert.equal(
      notify({ title: "AFK runner", subtitle: "#207 blocked again", message: "still stuck",
        level: "error", kind: "lane_blocked", group: "afk-lane-207" }),
      "coalesced",
    );
  } finally {
    delete process.env.AFK_NOTIFY_REPEAT_MS;
    process.env.PATH = previous;
    resetNotifyState();
  }
});

test("a lane notification raises the terminal, focuses the lane, or attaches nothing", async () => {
  // `-execute` is NOT run in the runner's shell. terminal-notifier hands it to
  // /bin/sh under launchd's PATH, where ~/.local/bin does not exist, so a bare
  // `herdr` silently resolved to nothing on every click. The fix is only real
  // if the command carries the absolute path, which is what this asserts.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-click-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "herdr"), 0o755);
  const previousPath = process.env.PATH;
  const previousApp = process.env.__CFBundleIdentifier;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.__CFBundleIdentifier = "com.apple.Terminal";
  // Imported after PATH is set: herdr is resolved once, at module load.
  const lane = await import(`./runtime-herdr.mjs?click=${bin}`);
  try {
    lane.notify("blocked", { workspaceId: "w23", taskId: "207", subtitle: "#207 blocked" });
    const argv = readFileSync(log, "utf8");
    assert.ok(argv.includes(`-execute\n${bin}/herdr workspace focus w23\n`),
      `the click must carry an absolute herdr path; got:\n${argv}`);
    // Focusing a workspace only changes what herdr draws. Raising the app is
    // the half that puts it in front of you, and terminal-notifier runs both —
    // the raise comes from notify() itself, so a lane gets it without asking.
    assert.match(argv, /-activate\ncom\.apple\.Terminal/);
    // Grouped on the TICKET. The builder lane and the `merge-207` integrator
    // lane are the same ticket to the human reading the banner.
    assert.match(argv, /-group\nafk-lane-207/);
    // There is no severity knob. Every lane notification means the lane has
    // stopped and wants a human; a `level` here is how routine traffic got in.
    writeFileSync(log, "");
    lane.notify("blocked", { workspaceId: "w23", taskId: "207", level: "info" });
    assert.match(readFileSync(log, "utf8"), new RegExp(`-sound\\n${NOTIFY_LEVELS.error.sound}`));

    // No workspace, no click.
    writeFileSync(log, "");
    lane.notify("no lane in hand", {});
    assert.doesNotMatch(readFileSync(log, "utf8"), /-execute/);
  } finally {
    process.env.PATH = previousPath;
    if (previousApp === undefined) delete process.env.__CFBundleIdentifier;
    else process.env.__CFBundleIdentifier = previousApp;
  }

  // herdr not on PATH at all — a cron or launchd run. The click must then be
  // ABSENT, not a bare `herdr` that dies in silence when clicked: this module
  // already holds that a failing click is worse than an inert notification, and
  // a bare-name fallback would rebuild the exact bug the absolute path fixes.
  const bare = mkdtempSync(join(tmpdir(), "afk-notify-nopath-"));
  const bareLog = join(bare, "argv.log");
  writeFileSync(
    join(bare, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(bareLog)}\nexit 0\n`,
  );
  chmodSync(join(bare, "terminal-notifier"), 0o755);
  process.env.PATH = bare; // terminal-notifier, but no herdr
  try {
    const stranded = await import(`./runtime-herdr.mjs?nopath=${bare}`);
    assert.equal(stranded.laneClick("w23"), null);
    stranded.notify("blocked", { workspaceId: "w23", taskId: "207" });
    assert.doesNotMatch(readFileSync(bareLog, "utf8"), /-execute/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("every notification raises the terminal, including the ones with no lane", () => {
  // The heartbeat and the supervisor watch from outside a lane, so neither has
  // a pane to focus and neither ever attached a click. But half of "take me
  // there" needs no workspace at all: raising the window the runner was
  // launched from. That belongs to notify(), not to the lane notifier, so a
  // stall alert and a blocked lane both come to the front when clicked.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-raise-"));
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "terminal-notifier"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, "terminal-notifier"), 0o755);
  const previousPath = process.env.PATH;
  const previousApp = process.env.__CFBundleIdentifier;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    // No execute, no workspace — the shape heartbeat.mjs and auto.mjs send.
    process.env.__CFBundleIdentifier = "com.googlecode.iterm2";
    notify({ title: "AFK runner", message: "runner stalled", level: "warn", group: "afk-heartbeat" });
    const raised = readFileSync(log, "utf8");
    assert.match(raised, /-activate\ncom\.googlecode\.iterm2/);
    assert.doesNotMatch(raised, /-execute/);

    // A caller may still name the app; the env is only the default.
    writeFileSync(log, "");
    notify({ title: "AFK runner", message: "m", activate: "com.apple.Terminal" });
    assert.match(readFileSync(log, "utf8"), /-activate\ncom\.apple\.Terminal/);

    // Under cron or launchd there is no launching app and no window worth
    // raising, so the notification is inert rather than pointing at nothing.
    writeFileSync(log, "");
    delete process.env.__CFBundleIdentifier;
    notify({ title: "AFK runner", message: "runner stalled", level: "warn" });
    assert.doesNotMatch(readFileSync(log, "utf8"), /-activate/);
  } finally {
    process.env.PATH = previousPath;
    if (previousApp === undefined) delete process.env.__CFBundleIdentifier;
    else process.env.__CFBundleIdentifier = previousApp;
  }
});

test("notify falls back to osascript when terminal-notifier is absent, and never throws", () => {
  // terminal-notifier is a brew binary the runner may not assume. Both fakes
  // here are non-delivering, so this asserts the fallback ORDER and that a
  // failed notification is a return value, not an exception in the run that was
  // trying to report a problem.
  const bin = mkdtempSync(join(tmpdir(), "afk-notify-none-"));
  const log = join(bin, "argv.log");
  for (const name of ["terminal-notifier", "osascript"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s ' ${JSON.stringify(name)} >> ${JSON.stringify(log)}\nexit 1\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = bin; // nothing else on PATH
  try {
    assert.equal(notify({ title: "t", message: "m", execute: "herdr workspace focus w1" }), "failed");
    assert.equal(readFileSync(log, "utf8"), "terminal-notifier osascript ");
  } finally {
    process.env.PATH = previous;
  }
});

// ---------------------------------------------------------------------------
// .afk-setup/ — the committed half of the project interface
// ---------------------------------------------------------------------------

test("loadConfig reads .afk-setup/config.yaml, not a JSON file", () => {
  const repo = mkdtempSync(join(tmpdir(), "afk-cfg-"));
  writeConfig(repo, { maxParallel: 4, defaultChecks: ["npm test"] });
  assert.equal(loadConfig(repo).maxParallel, 4);
  assert.deepEqual(loadConfig(repo).defaultChecks, ["npm test"]);
  assert.ok(configPath(repo).endsWith(".afk-setup/config.yaml"));
  rmSync(repo, { recursive: true, force: true });
});

test("a config that is nothing but comments means every default, not a parse error", () => {
  // The shipped file looks exactly like this before anyone edits it. The YAML
  // parser calls a document with no content an error; loadConfig must not.
  const repo = mkdtempSync(join(tmpdir(), "afk-cfg-"));
  mkdirSync(join(repo, ".afk-setup"), { recursive: true });
  writeFileSync(join(repo, ".afk-setup", "config.yaml"), "# maxParallel: 3\n\n#  agent:\n");
  assert.deepEqual(loadConfig(repo), {});
  rmSync(repo, { recursive: true, force: true });
});

test("everything committed under .afk-setup/ is protected from the agent that reads it", () => {
  // The config says how a lane is verified and the prompts instruct the lane
  // itself. A builder that can edit either can rewrite its own rules.
  assert.ok(PROTECTED_PREFIXES.some((p) => ".afk-setup/config.yaml".startsWith(p)));
  assert.ok(PROTECTED_PREFIXES.some((p) => ".afk-setup/prompts/implementer.md".startsWith(p)));
  // `.afk/` is machine state and stays runner-owned, a separate rule.
  assert.ok(isRunnerOwned(".afk/state.json"));
  assert.ok(!PROTECTED_PREFIXES.some((p) => ".afk/state.json".startsWith(p)));
});

// ---------------------------------------------------------------------------
// `afk finish` — the checklist that must refuse before it prunes anything.
// ---------------------------------------------------------------------------

test("finish refuses while the orchestrator still owns the run", () => {
  const state = { tasks: { 11: { lifecycle: "passed" } } };
  assert.equal(finishBlockers({ state, lockPid: 42, alive: () => true }).length, 1);
  // A lock left by a killed orchestrator must not wedge the command forever.
  assert.deepEqual(finishBlockers({ state, lockPid: 42, alive: () => false }), []);
});

test("finish refuses while a lane is still moving, but not for a failed one", () => {
  // `failed` and `blocked` have stopped for good. Landing the tasks that did
  // work is the operator's call, so those are reported, never blocking.
  for (const lifecycle of ["pending", "running", "ready_to_integrate", "integrating"])
    assert.equal(finishBlockers({ state: { tasks: { 11: { lifecycle } } } }).length, 1, lifecycle);
  for (const lifecycle of ["passed", "failed", "blocked", "infra_failed"])
    assert.deepEqual(finishBlockers({ state: { tasks: { 11: { lifecycle } } } }), [], lifecycle);
});

test("finish refuses while a `gate: after` is unaccepted", () => {
  // Otherwise the command that closes the epic is also the one that walks past
  // the gate a human was supposed to release.
  const state = {
    tasks: { 11: { lifecycle: "passed" } },
    epicClose: { lifecycle: "awaiting_acceptance", acceptances: {} },
    dag: { tasks: [{ id: "11", gateAfter: true }] },
  };
  const blockers = finishBlockers({ state });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /--accept=11/);
});

test("finish prunes a merged lane and refuses to destroy an unmerged one", () => {
  // The destructive half. `git branch -d` is the whole safety property: an
  // unmerged lane is unlanded work, and it must survive the cleanup and be
  // named. The worktree path comes from `git worktree list`, so a lane outside
  // the usual root is really removed rather than reported removed.
  const dir = mkdtempSync(join(tmpdir(), "afk-finish-"));
  const repo = join(dir, "repo");
  const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  for (const [id, file] of [["11", "x.txt"], ["12", "y.txt"]]) {
    const lane = join(dir, `wt${id}`);
    git(repo, ["worktree", "add", "-q", "-b", `afk/task-${id}`, lane]);
    writeFileSync(join(lane, file), "work\n");
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-qm", "work"]);
  }
  git(repo, ["merge", "-q", "--no-ff", "afk/task-11", "-m", "merge"]);

  const { removed, kept } = pruneLanes(repo);
  assert.ok(removed.includes("afk/task-11 (branch)"));
  assert.equal(removed.filter((line) => line.endsWith("(worktree)")).length, 2);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^afk\/task-12 — .*not fully merged/);
  assert.match(
    git(repo, ["branch", "--list", "afk/task-*", "--format=%(refname:short)"]).stdout.trim(),
    /^afk\/task-12$/,
  );
  assert.ok(!existsSync(join(dir, "wt11")));
  rmSync(dir, { recursive: true, force: true });
});
