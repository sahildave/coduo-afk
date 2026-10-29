// `afk preflight`: the run's preflight, on demand (#180).
//
// The same probes `runAuto` runs before it spawns a lane — the agent login,
// `requiredEnv`, the project's `preflight.probes`, the herdr server under the
// herdr runtime, the ports the checkout's gates bind, and the disk floor — so
// an Orchestrator can run it before a launch and before a relaunch. Exits 1 on
// any blocker. It reports and stops: nothing is fixed, nothing is killed.
//
// Unlike `afk validate`, this is not offline: it runs project commands and one
// trivial agent prompt, and writes the auth probe's files under .afk/preflight/.
//
// `--baseline` adds the Runner's baseline gate, run ahead of the launch: every
// `baselineChecks` command on the base branch, in a throwaway worktree. Before
// harbour#583 the base was checked by hand with `test:e2e` alone, green, while
// `test:db` was red on `main` too; the gate ran all of them and the epic
// launched five times. A hand-picked subset proves less than it seems.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_BASELINE_TIMEOUT_MS,
  runBaselineChecks,
  diskVerdict,
  freeDiskBytes,
  hostProbes,
  preflightLine,
  readPackageJson,
  runAuthProbe,
  withRuntime,
} from "./auto.mjs";
import { configPath, currentRepo, isMainModule, loadConfig, parseArgv, root as cwdRoot, run } from "./lib.mjs";
import { preflightBlockers, preflightWarnings } from "./scheduler.mjs";
import { permissionsProbe, renderPermissions } from "./cos/permissions.mjs";
import { quietHostLoad, waitForQuietHost, withGateLock } from "./gate-lock.mjs";
import { infisicalBlocker } from "./infisical.mjs";
import { createRoleCwd, removeRoleCwd } from "./worktree.mjs";

/**
 * Every preflight line for `root`, and whether any of them blocks. Seams are
 * the ones `runAuto` takes, so a test can drive this without a login.
 */
export const runPreflight = ({
  root,
  config,
  runtime = null,
  env = process.env,
  checkAuth = () => runAuthProbe({ root, afkDir: resolve(root, ".afk"), config }),
  herdrStatus = null,
  portHolders = undefined,
  freeDisk = freeDiskBytes,
  tasks = [],
  probes = {},
}) => {
  const probeWarnings = [];
  const blockers = preflightBlockers({
    config: withRuntime(config, runtime),
    env,
    root,
    checkAuth,
    tasks,
    ...hostProbes({ root, herdrStatus, ...(portHolders ? { portHolders } : {}) }),
    ...probes,
    warnings: probeWarnings,
  }).map((blocker) => preflightLine(blocker));
  const warnings = [...probeWarnings, ...preflightWarnings({ tasks, packageJson: readPackageJson(root) })];
  const disk = diskVerdict({ root, config, freeDisk });
  if (disk.level === "refuse") blockers.push(disk.line);
  else if (disk.line) warnings.push(disk.line);
  return { ok: blockers.length === 0, blockers, warnings };
};

export const renderPreflight = ({ ok, blockers, warnings }) => [
  ...blockers.map((line) => `PREFLIGHT: ${line}`),
  ...warnings.map((line) => `PREFLIGHT: warning: ${line}`),
  ok ? "PREFLIGHT: ok — every probe passed." : `PREFLIGHT: ${blockers.length} blocker(s); a run would spawn nothing. Fix the above, then rerun.`,
].join("\n");

// The commands the baseline gate runs: the same read as `runAuto`'s gate
// (auto.mjs, `config.baselineChecks ?? config.defaultChecks ?? []`) and the
// closeout fix gate's (fixer.mjs). Neither exports it, so it is repeated here
// verbatim, and a test pins the fallback.
export const baselineCommands = (config) => config?.baselineChecks ?? config?.defaultChecks ?? [];

const TAIL_LINES = 20;
const tailOf = (output) => String(output ?? "").split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-TAIL_LINES);

/**
 * Run every baseline command on `base` in a throwaway detached worktree, the
 * way the Runner's baseline gate runs them: the same command list, the same
 * `runBaselineChecks` (bounded by `baselineTimeoutMs`, process-group kill), the
 * same Infisical session probe first, under the machine-wide gate lock and
 * after a quiet host. Two deliberate differences, both toward reporting more:
 * it does not stop at the first red (each command runs on its own, so a red
 * `test:db` cannot hide behind a red `test:e2e`), and it skips nothing (the
 * gate's Rust skip and green-head reuse key on a run's own history).
 *
 * The worktree is the one a read-only role gets (`createRoleCwd`), with the
 * project's `worktreeSetup` applied, so `node_modules` links in as in a lane.
 * It is removed however the run ends; a SIGKILL leaves a `role-cwd-*` that the
 * next run's `pruneRoleCwds` sweeps.
 */
export const runBaselinePreflight = async ({
  root,
  config,
  base = "main",
  env = process.env,
  say = () => {},
  runChecks = runBaselineChecks,
  lock = withGateLock,
  quietHost = waitForQuietHost,
  infisicalProbe = null,
  makeCwd = createRoleCwd,
  removeCwd = removeRoleCwd,
}) => {
  const commands = baselineCommands(config);
  const report = { ok: true, base, sha: null, commands, results: [], blocker: null };
  if (!commands.length) return report;
  // Fail CLOSED, as the gate does: an `infisical run` check without a session
  // can sit on an interactive login prompt.
  const infisical = infisicalBlocker({ config, env, cwd: root, ...(infisicalProbe ? { probe: infisicalProbe } : {}) });
  if (infisical) return { ...report, ok: false, blocker: `${infisical} The baseline was not run.` };
  const key = `preflight-baseline-${process.pid}`;
  return lock({ root, config, kind: "preflight baseline", say }, async () => {
    await quietHost({ threshold: quietHostLoad(config, env), kind: "preflight baseline", say });
    let makeError = null;
    try {
      // Removed in `finally` even when this answers null: a worktreeSetup step
      // that threw leaves the `git worktree add` behind (verifier's reachReportAt).
      const cwd = makeCwd({ root, key, ref: base, setup: config?.worktreeSetup ?? null, onError: (message) => { makeError = message; } });
      if (!cwd) {
        const why = makeError ? `\n${tailOf(makeError).map((line) => `    ${line}`).join("\n")}` : "";
        return { ...report, ok: false, blocker: `could not create a worktree of \`${base}\` to run the baseline in.${why}` };
      }
      const sha = run("git rev-parse --short=12 HEAD", { cwd });
      report.sha = sha.status === 0 ? sha.stdout.trim() : null;
      for (const command of commands) {
        const outcome = await runChecks({
          commands: [command],
          cwd,
          timeoutMs: config?.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS,
          say,
          label: "preflight baseline",
        });
        const result = outcome.result ?? {};
        report.results.push({
          command,
          ok: outcome.ok,
          code: outcome.ok ? 0 : (result.status ?? null),
          timedOut: Boolean(result.timedOut),
          tail: outcome.ok ? [] : tailOf(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
        });
      }
      report.ok = report.results.every((entry) => entry.ok);
      return report;
    } finally {
      removeCwd({ root, key });
    }
  });
};

export const renderBaselinePreflight = ({ ok, base, sha, commands, results, blocker }) => {
  if (blocker) return `PREFLIGHT: baseline: ${blocker}`;
  if (!commands.length) return "PREFLIGHT: baseline: no baselineChecks (or defaultChecks) configured; nothing to run.";
  const at = `\`${base}\`${sha ? ` @ ${sha}` : ""}`;
  const lines = results.flatMap((entry) => (entry.ok
    ? [`PREFLIGHT: baseline pass: \`${entry.command}\``]
    : [
      `PREFLIGHT: baseline FAIL (${entry.timedOut ? "timed out" : `exit ${entry.code}`}): \`${entry.command}\``,
      ...entry.tail.map((line) => `    ${line}`),
    ]));
  const failed = results.filter((entry) => !entry.ok).length;
  lines.push(ok
    ? `PREFLIGHT: baseline ok — all ${results.length} baselineChecks command(s) passed on a clean worktree of ${at}.`
    // What was proven, and no more: the Runner's gate runs in the epic's own
    // checkout, whose gitignored files (.env, generated code, caches) a fresh
    // worktree lacks unless worktreeSetup brings them in. A red here can be
    // that gap, so it does not claim the gate would halt.
    : `PREFLIGHT: baseline red — ${failed} of ${results.length} baselineChecks command(s) failed on a clean worktree of ${at} (gitignored files not listed in worktreeSetup.copy are absent).`);
  return lines.join("\n");
};

if (isMainModule(import.meta.url)) {
  let flags;
  try {
    flags = parseArgv(process.argv.slice(2), ["runtime", "epic", "repo", "cos", "baseline", "base"], { command: "preflight" }).flags;
  } catch (error) {
    console.log(`PREFLIGHT: ${error.message}`);
    process.exit(1);
  }
  if (flags.base && !flags.baseline) {
    console.log("PREFLIGHT: --base= picks the branch `--baseline` runs on; add --baseline.");
    process.exit(1);
  }
  // `--cos`: the verbs a chief-of-staff run plans must have standing allow
  // lines (#227). Checked first, and alone outside a configured checkout: the
  // chief of staff runs from no particular repo.
  const permissions = flags.cos ? permissionsProbe() : null;
  if (permissions) console.log(renderPermissions(permissions));
  if (permissions && !existsSync(configPath(cwdRoot))) process.exit(permissions.ok ? 0 : 1);
  if (!existsSync(configPath(cwdRoot))) {
    console.log(`PREFLIGHT: no .afk-setup/config.yaml at ${configPath(cwdRoot)} — nothing to probe against.`);
    process.exit(1);
  }
  // `--epic=<n>` reads the child tickets, which the UI checks key on (#210).
  let tasks = [];
  if (flags.epic) {
    const { fetchEpic } = await import("./epic.mjs");
    try {
      const repo = flags.repo ?? currentRepo(cwdRoot);
      const epic = fetchEpic({ repo, number: flags.epic });
      tasks = epic.children.map((child) => ({ id: String(child.number), body: child.body ?? "" }));
    } catch (error) {
      console.log(`PREFLIGHT: ${error.message}`);
      process.exit(1);
    }
  }
  const report = runPreflight({ root: cwdRoot, config: loadConfig(cwdRoot), runtime: flags.runtime ?? null, tasks });
  // STDOUT for everything, blockers included: an Orchestrator reads stdout.
  console.log(renderPreflight(report));
  // `--baseline`: run whatever the probes above said, so one call reports
  // every fault there is.
  let baseline = null;
  if (flags.baseline) {
    const config = loadConfig(cwdRoot);
    const base = typeof flags.base === "string" && flags.base ? flags.base : "main";
    console.log(`PREFLIGHT: baseline: running ${baselineCommands(config).length} baselineChecks command(s) on \`${base}\` in a throwaway worktree.`);
    baseline = await runBaselinePreflight({ root: cwdRoot, config, base, say: (line) => console.log(line) });
    console.log(renderBaselinePreflight(baseline));
  }
  process.exitCode = report.ok && (permissions?.ok ?? true) && (baseline?.ok ?? true) ? 0 : 1;
}
