// scripts/start.mjs — one terminal, one epic.
//
// `afk start <issue>` is the one-terminal-per-epic workflow as a command: it
// starts the epic's orchestrator so that it OUTLIVES this terminal, waits until
// the run has told it what it actually got, prints the run's identity, and then
// drops the human into an interactive `claude` session in the same checkout so
// there is always an agent to ask about the run.
//
// Three decisions worth stating, each from a run that went wrong:
//
//  1. **The orchestrator is spawned detached, not inherited.** `afk epic <n>`
//     IS the orchestrator — epic.mjs calls `runAuto` in-process, there is no
//     second hop — so a multi-hour run started from inside a Claude session is
//     a child of that session and dies with it (epic-5 §7). `detached: true`
//     puts it in its own process group (POSIX `setsid`), so the terminal's
//     SIGHUP on close does not reach it, and `unref()` lets THIS process exit
//     without waiting. Assumption: POSIX. No `nohup`, no `screen`, no daemon.
//
//  2. **The dashboard port is read back, never chosen here.** Four of six
//     agents in one night lost time to a fixed default port colliding across
//     concurrent checkouts. Whatever resolves the port — the `PORT` env var,
//     derivation from the checkout, auto-selection on collision — lives in
//     scripts/dashboard-process.mjs and is recorded by scripts/auto.mjs at
//     `.afk/state.json` → `dashboard.port`. This file reads that field and
//     reports it. It never probes, guesses, or runs `lsof` (epic-4 §1: `lsof`
//     raced the check and collided anyway).
//
//  3. **A refusal is printed on STDOUT, here, before anything is spawned.**
//     AGENTS.md failure modes #7 and #8: a refusal that only reaches a
//     background log reads as a hang, not a rejection.
//
// The session is NOT handed a prompt. The run is already going by the time the
// session opens, so a prompt that invoked the `coduo-afk` skill's start verb
// would try to start it twice; and the skill lives outside this repo, so
// depending on its verbs would make this command break when the skill moves.
// The identity block names the commands instead.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardUrl } from "./dashboard-process.mjs";
import { ensureDir, isMainModule, resolveBackend } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const epicScript = resolve(here, "epic.mjs");

export const USAGE =
  "START: usage — afk start <issue> [flags forwarded to `afk epic`]";

/**
 * Which CLI this entry point checks for and opens.
 *
 * `afk start` and `afk-codex start` are the same file; the executable the
 * operator ran is the whole difference, and it reaches here in `AFK_BACKEND`
 * (afk.mjs sets it on every subcommand it spawns). Before this, both refused on
 * a missing `claude` and both opened a `claude` session — so an operator with
 * only Codex installed could not start a Codex run at all, and one with both
 * got a Claude session watching a Codex epic.
 *
 * The interactive session is the CLI's bare invocation for both backends:
 * `claude` and `codex` each open a TUI in the current directory with no
 * arguments. This is NOT `codex exec` — that is the non-interactive lane
 * invocation and belongs in lib.mjs, not here.
 */
export const SESSION_CLI = { claude: "claude", codex: "codex" };

export const sessionCli = (backend = resolveBackend()) => SESSION_CLI[resolveBackend(backend)];

/**
 * The issue number, and everything else forwarded verbatim to `afk epic`.
 * Forwarding rather than re-declaring each flag means `afk start` does not
 * drift when `afk epic` grows one.
 */
export const parseStartArgs = (argv) => {
  // A bare `--repo owner/name` puts a non-flag token in the argument list that
  // is a VALUE, not the issue. epic.mjs guards the same case the same way.
  const isFlagValue = (index) =>
    index > 0 && argv[index - 1].startsWith("--") && !argv[index - 1].includes("=");
  const at = argv.findIndex(
    (arg, index) => !arg.startsWith("--") && !isFlagValue(index) && /^#?\d+$/.test(arg),
  );
  if (at === -1)
    return {
      error: `${USAGE}\n  Give the epic's GitHub issue number, e.g. \`afk start 255\`.`,
    };
  return {
    issue: argv[at].replace(/^#/, ""),
    forward: argv.filter((_, index) => index !== at),
  };
};

/** The pid in `.afk/orchestrator.lock`, if a live process still holds it. */
export const liveLockPid = (root) => {
  const lockPath = resolve(root, ".afk", "orchestrator.lock");
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};

/**
 * What the run says about itself. Only fields the orchestrator has actually
 * written are returned; `.afk/state.json` survives between runs, so a
 * `dashboard` block older than this launch is a PREVIOUS run's port and is
 * dropped rather than printed as this one's.
 */
export const readRunIdentity = (root, since = 0) => {
  try {
    const state = JSON.parse(
      readFileSync(resolve(root, ".afk", "state.json"), "utf8"),
    );
    const dashboard = state.dashboard ?? null;
    const fresh =
      dashboard?.port &&
      (!dashboard.startedAt || Date.parse(dashboard.startedAt) >= since);
    // A run whose dashboard failed to start carries on without one and says
    // so here; for `afk start` that is as much "started" as a dashboard is.
    const skipped = state.dashboardSkipped ?? null;
    const skippedFresh = skipped?.at && Date.parse(skipped.at) >= since;
    return {
      branch: state.branch ?? null,
      epic: state.epic?.title ?? null,
      dashboard: fresh ? dashboard : null,
      dashboardSkipped: skippedFresh ? skipped : null,
    };
  } catch {
    return { branch: null, epic: null, dashboard: null, dashboardSkipped: null };
  }
};

/**
 * Start `afk epic <issue>` as a process this one does not own. Returns the pid
 * and a liveness probe; the caller polls, it never waits on the child.
 */
export const spawnOrchestrator = ({
  root,
  issue,
  forward = [],
  logPath,
  script = epicScript,
}) => {
  ensureDir(dirname(logPath));
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [script, "epic", issue, ...forward], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  return {
    pid: child.pid,
    alive: () => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        process.kill(child.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
};

const nap = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Poll until the run reports its dashboard (or that it is carrying on without
 * one), dies, or runs out of patience.
 * Validation, branch creation and the draft PR all happen before the dashboard
 * starts, so this is minutes-scale, not seconds-scale.
 */
export const awaitRun = async ({
  root,
  alive,
  since,
  timeoutMs = 120_000,
  tick = 250,
  sleep = nap,
  now = () => Date.now(),
}) => {
  const deadline = now() + timeoutMs;
  for (;;) {
    const identity = readRunIdentity(root, since);
    if (identity.dashboard || identity.dashboardSkipped) return { status: "ready", ...identity };
    // Liveness is checked AFTER the read, so an orchestrator that reported and
    // then exited is reported as ready rather than as a death.
    if (!alive()) return { status: "died", ...identity };
    if (now() >= deadline) return { status: "pending", ...identity };
    await sleep(tick);
  }
};

export const logTail = (logPath, lines = 15) => {
  try {
    return readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
};

/** The block the human reads. Named commands, not a claim of success. */
export const renderIdentity = ({ issue, root, pid, logPath, run, cli = sessionCli() }) => {
  const url = run.dashboard ? dashboardUrl(run.dashboard.port) : null;
  return [
    "",
    `START: epic #${issue}${run.epic ? ` — ${run.epic}` : ""}`,
    `  branch     ${run.branch ?? "not created yet — see the log"}`,
    `  checkout   ${root}`,
    `  dashboard  ${url ?? (run.dashboardSkipped ? "did not start — the run carries on without it; see the log" : "not up yet — see the log")}`,
    `  orchestrator  pid ${pid}, detached — it survives this session; log at ${logPath}`,
    run.status === "pending"
      ? "  STILL STARTING: the run has not reported a dashboard yet. It is not dead — watch the log."
      : null,
    "",
    "Check on it:",
    "  afk status",
    url ? `  open ${url}` : null,
    `  tail -f ${logPath}`,
    "",
    "When it ends, verify rather than infer — a green run is not a pushed branch:",
    run.branch ? `  gh pr list --head ${run.branch}` : "  gh pr list --head <branch>",
    run.branch
      ? `  git ls-remote --heads origin ${run.branch}`
      : "  git ls-remote --heads origin <branch>",
    "",
    `Opening a ${cli} session in this checkout. The run is ALREADY going — ask it`,
    `about the run (\`afk status\`); do not start epic #${issue} again.`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
};

export const startCommand = async ({
  root = process.cwd(),
  argv = [],
  out = console.log,
  onPath = (command) =>
    spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0,
  spawnEpic = spawnOrchestrator,
  cli = sessionCli(),
  openSession = (cwd, command = cli) =>
    spawnSync(command, [], { cwd, stdio: "inherit", env: process.env }).status ?? 1,
  wait = awaitRun,
} = {}) => {
  const parsed = parseStartArgs(argv);
  if (parsed.error) {
    out(parsed.error);
    return 1;
  }
  // Both refusals come before the spawn on purpose: starting a multi-hour run
  // and THEN discovering there is no session to watch it from is the worse
  // half of both failures.
  if (!onPath(cli)) {
    out(
      `START: refusing — \`${cli}\` is not on PATH, so there would be no session to drive the run from.\n` +
        `  Install the ${cli === "codex" ? "Codex" : "Claude Code"} CLI and log in, then re-run. To start the run without a session: afk epic ` +
        parsed.issue,
    );
    return 1;
  }
  const held = liveLockPid(root);
  if (held !== null) {
    out(
      `START: refusing — an orchestrator (pid ${held}) is already running in ${root}.\n` +
        "  One run per checkout. Inspect it with `afk status`, or end it and run `afk finish`.\n" +
        "  A second concurrent epic needs its own checkout.",
    );
    return 1;
  }

  const logPath = resolve(root, ".afk", `start-${parsed.issue}.log`);
  const since = Date.now();
  const child = spawnEpic({ root, issue: parsed.issue, forward: parsed.forward, logPath });
  out(
    `START: orchestrator for epic #${parsed.issue} detached as pid ${child.pid}; waiting for it to report.`,
  );

  const run = await wait({ root, alive: child.alive, since });
  if (run.status === "died") {
    out(
      `START: refusing to open a session — the orchestrator for epic #${parsed.issue} exited before it reported a dashboard.\n` +
        `  It refused or failed; the reason is the last lines of ${logPath}:\n` +
        logTail(logPath).replace(/^/gm, "  | ") +
        "\n  Fix what it names and re-run `afk start " +
        parsed.issue +
        "`.",
    );
    return 1;
  }

  out(renderIdentity({ issue: parsed.issue, root, pid: child.pid, logPath, run, cli }));
  return openSession(root, cli);
};

if (isMainModule(import.meta.url)) {
  // No top-level `await`: it would leave this module's evaluation pending for
  // the life of the CLI, which is the deadlock epic.mjs documents at its own
  // entry point. `process.exitCode`, never `process.exit()` — this process has
  // written the identity block to a pipe.
  startCommand({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
