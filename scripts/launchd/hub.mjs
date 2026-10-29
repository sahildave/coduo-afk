// scripts/launchd/hub.mjs — the user LaunchAgent that keeps `afk hub` on 4099 (#229).
//
// Beside the check-in's agent (cos-checkin.mjs), with the same shape. The
// differences: the hub is a server, so it starts at load and launchd restarts
// it when it exits (RunAtLoad, KeepAlive), throttled to once every 30 s so a
// port held by something else is retried, not hammered. It is installed once
// per machine (`afk hub install`), not per run: the hub runs between runs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LABEL = "com.afk-claude.hub";
export const THROTTLE_S = 30;

export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderPlist = ({ node, afk, port, env, logPath }) => {
  const vars = Object.entries(env).filter(([, value]) => value != null)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(afk)}</string>
      <string>hub</string>
      <string>--port=${xml(port)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_S}</integer>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
  </dict>
</plist>
`;
};

const domain = () => `gui/${userInfo().uid}`;
const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });

/** Write and load the agent, replacing any earlier one. Throws on failure. */
export const install = ({ node, afk, port, env, logPath, home = homedir() }) => {
  const path = plistPath(home);
  if (existsSync(path)) launchctl("bootout", `${domain()}/${LABEL}`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, renderPlist({ node, afk, port, env, logPath }));
  const result = launchctl("bootstrap", domain(), path);
  if (result.error || result.status !== 0) {
    rmSync(path, { force: true });
    throw new Error(`launchctl bootstrap failed: ${(result.error?.message ?? `${result.stderr}${result.stdout}`).trim() || `exit ${result.status}`}`);
  }
  return path;
};

/** Unload and delete the agent. Never throws. */
export const uninstall = ({ home = homedir() } = {}) => {
  const path = plistPath(home);
  const result = launchctl("bootout", `${domain()}/${LABEL}`);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return { existed, unloaded: !result.error && result.status === 0 };
};
