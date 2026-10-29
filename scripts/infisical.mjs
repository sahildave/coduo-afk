// The Infisical session probe (#210).
//
// A check that runs `infisical run` with an expired session turns a gate red
// in a way that reads exactly like a test failure, and without a session the
// CLI can open an interactive login prompt that hangs the gate. So when any
// configured check calls `infisical run`, the session is probed before the
// first builder and again before each baseline and integration gate.
//
// Fail direction: CLOSED for the probe. A probe that cannot confirm a session
// (non-zero, killed at its bound, did not start) refuses the run, because the
// alternative is a gate that hangs or spends a lane's one reset on a login.
// Repos whose checks never call `infisical run` are never probed at all.
import { spawnSync } from "node:child_process";

// What Infisical prints when no session exists. A gate whose output carries it
// failed on the login, not the code.
export const INFISICAL_NO_SESSION = /No valid login session found/i;

export const INFISICAL_PROBE_TIMEOUT_MS = 15_000;

// One detector for both probes: preflight (`usesInfisical` in scheduler.mjs)
// and the mid-run gate probe below. Atlas's `npm run infisical -- -- …` gate
// counts; `npm run infisical:sync` does not.
export const USES_INFISICAL_RUN = /\binfisical\s+run\b|\bnpm\s+run\s+infisical(?![\w:-])/;

/** Every check command the run could execute: lane defaults, baseline, per-task. */
export const configuredChecks = (config = {}, dag = null) => [
  ...(config.defaultChecks ?? []),
  ...(config.baselineChecks ?? []),
  ...(config.integrationChecks ?? []),
  ...((dag?.tasks ?? []).flatMap((task) => task.checks ?? [])),
].filter((command) => typeof command === "string");

export const usesInfisicalRun = (config, dag = null) =>
  configuredChecks(config, dag).some((command) => USES_INFISICAL_RUN.test(command));

/**
 * The domain for the login remedy: a `--domain` on a check, else
 * `INFISICAL_API_URL`/`INFISICAL_DOMAIN`, else a placeholder the operator fills.
 */
export const infisicalDomain = (config, dag = null, env = process.env) => {
  for (const command of configuredChecks(config, dag)) {
    const match = command.match(/--domain[=\s]+(['"]?)([^\s'"]+)\1/);
    if (match) return match[2];
  }
  const fromEnv = env?.INFISICAL_API_URL || env?.INFISICAL_DOMAIN;
  return fromEnv ? fromEnv.replace(/\/api\/?$/, "") : "<your-infisical-domain>";
};

export const infisicalLoginLine = (domain) =>
  `Infisical login expired: run \`infisical login --domain=${domain}\`, then rerun.`;

/** Whether a gate's output says the Infisical session is missing. */
export const infisicalSessionMissing = (output) => INFISICAL_NO_SESSION.test(String(output ?? ""));

/**
 * Probe the session non-interactively: `infisical user get token` with stdin
 * closed and a short bound, killed if it waits on a prompt. True on exit 0.
 */
export const probeInfisicalSession = ({ env = process.env, cwd = process.cwd(), timeoutMs = INFISICAL_PROBE_TIMEOUT_MS } = {}) => {
  const result = spawnSync("infisical", ["user", "get", "token"], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL",
  });
  return !result.error && result.status === 0 && !infisicalSessionMissing(`${result.stdout ?? ""}${result.stderr ?? ""}`);
};

/**
 * The preflight blocker line, or null: null when no check runs `infisical run`
 * (the probe is skipped) or when the session answers.
 */
export const infisicalBlocker = ({ config, dag = null, env = process.env, cwd = process.cwd(), probe = probeInfisicalSession } = {}) => {
  if (!usesInfisicalRun(config, dag)) return null;
  return probe({ env, cwd }) ? null : infisicalLoginLine(infisicalDomain(config, dag, env));
};
