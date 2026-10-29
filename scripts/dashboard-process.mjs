import { createHash } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import { get } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const dashboardScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "dashboard-server.mjs",
);

// Two spellings of one checkout must compare equal. `resolve` alone does not
// do that on macOS, where a temp path arrives as both `/var/...` and
// `/private/var/...`; the same trap `isMainModule` in scripts/lib.mjs exists
// for. A mismatch here reads as "another project holds this port" and sends the
// scan off looking for a port that was never taken.
const samePath = (a, b) => {
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
};

// The host the dashboard binds and this probe dials, and so the only host a
// printed link may name. `localhost` resolves to ::1 first, and a process that
// listens on `::` at the same port (Node's default with no host, e.g. a Next
// dev server) shares the port with a 127.0.0.1 bind on macOS: a `localhost`
// link opened that process instead of the dashboard.
export const DASHBOARD_HOST = "127.0.0.1";
export const dashboardUrl = (port) => `http://${DASHBOARD_HOST}:${port}`;

// `agent: false`: a fresh connection per probe. The default agent keeps sockets
// alive, so a probe that once reached a `::` squatter at this port kept reusing
// that socket after the dashboard bound 127.0.0.1, and the start timed out.
const health = (port) =>
  new Promise((resolveHealth) => {
    const request = get(
      { hostname: DASHBOARD_HOST, port, path: "/health", timeout: 250, agent: false },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolveHealth(
              response.statusCode === 200 ? JSON.parse(body) : null,
            );
          } catch {
            resolveHealth(null);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolveHealth(null);
    });
    request.on("error", () => resolveHealth(null));
  });

// How long a freshly spawned dashboard has to answer /health.
const HEALTH_TIMEOUT_MS = 3000;

// The exit code of a dashboard whose port someone else bound first. It is the
// one start failure that sends the scan to the next port; every other one is
// reported as itself.
export const EXIT_PORT_IN_USE = 98;

const waitForHealth = async (port, child, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await health(port);
    if (result) return result;
    if (child.exitCode !== null) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
};

// The port the dashboard binds, and why it is not a constant.
//
// One machine routinely holds several checkouts of the same project — six ran
// concurrently the night this was written — and a fixed 4041 makes a collision
// the DEFAULT rather than an edge case. Four of six runs died on it, each
// diagnosed cold. So the default is derived from the checkout's absolute path:
// two checkouts of one repo cannot pick the same port, and one checkout picks
// the same port on every run, which keeps a bookmarked dashboard URL valid.
const PORT_RANGE_START = 4100;
const PORT_RANGE_SPAN = 400;

// One fixed URL for "show me every run on this machine", deliberately just
// BELOW the derived range: no checkout can ever hash onto it, so claiming it
// cannot take a port some run needs. The hub (`afk hub`, kept up by launchd via
// `afk hub install`) owns it; each dashboard serves only its own derived port.
export const HUB_PORT = 4099;

// How far to scan upward from the derived port before giving up. Only applies
// when the port was derived; an explicit `PORT=` is honoured exactly.
const SCAN_ATTEMPTS = 20;

/**
 * Every dashboard listening in the derived range, probed concurrently.
 *
 * Discovery needs no registry and no broadcast: the range is fixed, the probe
 * is the same `/health` the port scan already trusts, and a file of "running
 * dashboards" would go stale the first time one was killed with -9. The probe
 * IS the truth.
 *
 * The one thing it cannot see is a dashboard started with an explicit `PORT=`
 * outside 4100-4499. That is the documented escape hatch for a machine whose
 * range is congested, and a run that took it is reachable only by its own URL.
 *
 * `probe` is injected so this is testable without binding 400 sockets.
 */
export const discoverDashboards = async ({
  probe = health,
  start = PORT_RANGE_START,
  span = PORT_RANGE_SPAN,
  chunk = 64,
} = {}) => {
  const found = [];
  for (let base = start; base < start + span; base += chunk) {
    const ports = [];
    for (let port = base; port < Math.min(base + chunk, start + span); port += 1) {
      ports.push(port);
    }
    const answers = await Promise.all(
      ports.map(async (port) => [port, await probe(port)]),
    );
    for (const [port, answer] of answers) {
      if (answer?.ok) found.push({ ...answer, port });
    }
  }
  // By project, then port: the order a person reads them in, and stable across
  // polls so tabs do not reshuffle under the cursor.
  return found.sort(
    (a, b) =>
      String(a.project ?? "").localeCompare(String(b.project ?? "")) || a.port - b.port,
  );
};

export const derivedDashboardPort = (root) =>
  PORT_RANGE_START +
  (createHash("sha256").update(resolve(root)).digest().readUInt16BE(0) %
    PORT_RANGE_SPAN);

export const resolveDashboardPort = ({ root, port = null, env = process.env }) => {
  if (env.PORT) return { port: Number(env.PORT), explicit: true };
  if (port) return { port, explicit: true };
  return { port: derivedDashboardPort(root), explicit: false };
};

// One conflict keeps the original wording — that is the `PORT=<n>` case, where
// the caller named the port and wants to know who has it. A whole exhausted
// window is a different report, and both name the remedy in the message itself:
// a diagnosis only a background log can see is not a diagnosis.
const conflictMessage = (root, conflicts) =>
  conflicts.length === 1
    ? `Dashboard port ${conflicts[0].port} is already serving a different project: ${conflicts[0].root}. Free it, or pick a port with PORT=<n>.`
    : rangeMessage(root, conflicts[0].port, conflicts[conflicts.length - 1].port);

const rangeMessage = (root, from, to) =>
  `Dashboard could not bind a port for ${resolve(root)}: ${from}-${to} are all taken by other projects or refused to bind. Free one, or run with PORT=<n>. See docs/runbook.md section 5.`;

/**
 * Find the port this checkout should use, starting at `port` and scanning
 * upward. A port already serving THIS root is returned for reuse; a port
 * serving another project is skipped. The probe is the runner's own `/health`
 * endpoint and never `lsof` — `lsof` reports a free port and loses the race to
 * whoever binds it next, which is exactly how epic 4 collided three times.
 *
 * Throws with the remedy in the message when the whole window is taken.
 */
export const probeDashboardPort = async ({
  root,
  port,
  attempts = SCAN_ATTEMPTS,
  probe = health,
}) => {
  const conflicts = [];
  for (let candidate = port; candidate < port + attempts; candidate += 1) {
    const existing = await probe(candidate);
    if (!existing) return { port: candidate, existing: null };
    if (samePath(existing.root, root))
      return { port: candidate, existing };
    conflicts.push({ port: candidate, root: existing.root });
  }
  throw new Error(conflictMessage(root, conflicts));
};

export const startDashboard = async ({
  root,
  logPath,
  port = null,
  previousPid = null,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
}) => {
  // An error whose message already names the log carries it as `logPath`, so
  // the caller adds the path only when the message lacks it.
  const logged = (message) => Object.assign(new Error(message), { logPath });
  const { port: first, explicit } = resolveDashboardPort({ root, port });
  const attempts = explicit ? 1 : SCAN_ATTEMPTS;
  const conflicts = [];
  let next = first;

  while (next < first + attempts) {
    let found;
    try {
      found = await probeDashboardPort({
        root,
        port: next,
        attempts: first + attempts - next,
      });
    } catch (error) {
      // The scan window is exhausted by live dashboards; fold in any port we
      // failed to bind so the message names every port that was tried.
      if (!conflicts.length) throw error;
      throw new Error(rangeMessage(root, first, first + attempts - 1));
    }
    const bindPort = found.port;

    if (found.existing) {
      const recovered = Number(found.existing.pid) === Number(previousPid);
      return {
        pid: found.existing.pid,
        port: bindPort,
        url: dashboardUrl(bindPort),
        reused: true,
        recovered,
        stop: () => {
          if (recovered)
            try {
              process.kill(found.existing.pid, "SIGTERM");
            } catch {}
        },
      };
    }

    const log = openSync(logPath, "a");
    const child = spawn(process.execPath, [dashboardScript], {
      cwd: root,
      env: { ...process.env, PORT: String(bindPort) },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const started = await waitForHealth(bindPort, child, healthTimeoutMs);
    if (started && samePath(started.root, root))
      return {
        pid: child.pid,
        port: bindPort,
        url: dashboardUrl(bindPort),
        reused: false,
        recovered: false,
        stop: () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        },
      };

    // Read before the kill below, which would make every child look exited.
    const exitCode = child.exitCode;
    try {
      child.kill("SIGTERM");
    } catch {}
    if (!started) {
      // Alive and silent is not a port conflict: the dashboard bound the port and
      // never answered. Walking on would only start the same slow server again.
      if (exitCode === null)
        throw logged(
          `Dashboard on ${dashboardUrl(bindPort)} started but did not answer /health in ${healthTimeoutMs / 1000}s; see ${logPath}`,
        );
      // Died for any reason but a taken port: say so, rather than blame a port.
      if (exitCode !== EXIT_PORT_IN_USE)
        throw logged(
          `Dashboard exited with code ${exitCode} before answering /health on ${dashboardUrl(bindPort)}; see ${logPath}`,
        );
    }
    // A health probe can lose the same race `lsof` loses: the port answered
    // nothing a moment ago and someone bound it in the gap. That is a reason to
    // move up, not to die — unless the caller named the port itself.
    if (explicit)
      throw logged(
        `Dashboard failed to start on ${dashboardUrl(bindPort)}; see ${logPath}`,
      );
    conflicts.push({ port: bindPort });
    next = bindPort + 1;
  }
  throw new Error(rangeMessage(root, first, first + attempts - 1));
};

export { health as dashboardHealth };
