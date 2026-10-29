// scripts/notify-test.mjs — `afk notify` fires one notification per severity
// level and says which path delivered them.
//
// This exists because of the requirements in
// docs/notifications-and-agent-scope.md §1 that no test can cover:
//
//  1. macOS grants notification permission per app, so if `terminal-notifier`
//     was never granted it, delivery fails **silently** — the binary exits 0 and
//     nothing appears. Nothing in the runner can detect that. A human looking at
//     their screen can.
//  2. A click that runs nothing is indistinguishable from a click that was
//     never wired up. `-execute` runs under launchd's PATH, so only a human
//     clicking one of these can confirm the lane actually comes to the front.
//  3. Whether a notification STAYS on screen ("static") or slides away after a
//     few seconds is a per-app setting in System Settings → Notifications, not
//     a flag any sender can pass. `terminal-notifier -help` has no such option.
//     For an unattended run, "Alerts" is the setting worth having: a blocked
//     lane that vanished after five seconds is a lane you find an hour later.
//
// Run it once on a new machine before relying on unattended runs.
import { isMainModule, notify, NOTIFY_LEVELS } from "./lib.mjs";
// The LANE click, not a hand-rolled one: it is the half that fails silently (a
// dead `-execute` and an inert notification look identical), so the tool that
// exists to be clicked must send exactly what a blocked lane sends.
import { laneClick } from "./runtime-herdr.mjs";

if (isMainModule(import.meta.url)) {
  const workspace = process.argv.find((arg) => arg.startsWith("--workspace="))?.split("=")[1];
  const repo = process.cwd().split("/").filter(Boolean).pop();
  const execute = laneClick(workspace);
  const results = [];
  for (const [level, profile] of Object.entries(NOTIFY_LEVELS)) {
    results.push([level, notify({
      title: `AFK runner — ${repo}`,
      subtitle: `${level} · sound ${profile.sound}${profile.ignoreDnD ? " · pierces Do Not Disturb" : ""}`,
      message: execute
        ? `Click me: I should raise this terminal AND focus herdr workspace ${workspace}.`
        : "Click me: I should raise this terminal. Pass --workspace=<id> to also test the lane focus.",
      level,
      execute,
      // Deliberately NOT grouped: the point is to see them side by side.
    })]);
  }
  for (const [level, via] of results) console.log(`notify: ${level.padEnd(7)} delivered via ${via}.`);

  const via = results[0][1];
  if (via === "osascript") {
    console.log(
      "\nnotify: terminal-notifier is not installed or failed, so these notifications are inert —"
      + " clicking one goes nowhere and none of them can pierce Do Not Disturb."
      + " `brew install terminal-notifier` to make lane alerts clickable.",
    );
  } else if (via === "failed") {
    console.log("\nnotify: nothing delivered them. On macOS, check System Settings → Notifications.");
    process.exitCode = 1;
  }
  if (via !== "failed") {
    console.log(
      "\nnotify: if no banner appeared, the sending app was never granted notification permission —"
      + ` check System Settings → Notifications for ${via === "terminal-notifier" ? "terminal-notifier" : "your terminal"}.`
      + "\nnotify: while you are there, set its alert style to **Alerts**, not Banners."
      + " Banners disappear after a few seconds; no sender flag can override that, and a blocked"
      + " lane you did not see is a lane that waits until you check on it.",
    );
  }
}
