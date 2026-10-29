// scripts/launchd/cos-checkin.mjs — the user LaunchAgent that runs
// `afk cos checkin` on the run's cadence (#227).
//
// launchd, never a Desktop scheduled task: a scheduled task is a Claude
// session, and the check-in must run with no model and survive every session.
// `install` writes the plist and bootstraps it; `uninstall` boots it out and
// deletes the plist. Both shell out to `launchctl` on PATH, which tests fake.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LABEL = "com.afk-claude.cos-checkin";
export const CHECKIN_MINUTES = { day: 25, night: 45 };

export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The plist. The environment carries PATH (launchd's is bare) and the store root. */
export const renderPlist = ({ mode, node, afk, env, logPath }) => {
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
      <string>cos</string>
      <string>checkin</string>
    </array>
    <key>StartInterval</key>
    <integer>${CHECKIN_MINUTES[mode] * 60}</integer>
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

/** Write and load the agent, replacing any leftover one. Throws on failure. */
export const install = ({ mode, node, afk, env, logPath, home = homedir() }) => {
  const path = plistPath(home);
  // A leftover agent from a run that died is replaced, not doubled.
  if (existsSync(path)) launchctl("bootout", `${domain()}/${LABEL}`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, renderPlist({ mode, node, afk, env, logPath }));
  const result = launchctl("bootstrap", domain(), path);
  if (result.error || result.status !== 0) {
    rmSync(path, { force: true });
    throw new Error(`launchctl bootstrap failed: ${(result.error?.message ?? `${result.stderr}${result.stdout}`).trim() || `exit ${result.status}`}`);
  }
  return path;
};

/** Unload and delete the agent. Returns what it did, never throws. */
export const uninstall = ({ home = homedir() } = {}) => {
  const path = plistPath(home);
  const result = launchctl("bootout", `${domain()}/${LABEL}`);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  const unloaded = !result.error && result.status === 0;
  return { existed, unloaded, detail: unloaded ? "" : (result.error?.message ?? `${result.stderr ?? ""}`).trim() };
};
