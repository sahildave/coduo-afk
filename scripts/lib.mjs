import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAnswers } from "./tier-router.mjs";
import { spawn, spawnSync } from "node:child_process";
import { loadavg } from "node:os";
// The config is YAML; `epic-spec.mjs` imports nothing, so this cannot cycle.
import { parseYamlSubset } from "./epic-spec.mjs";

export const root = process.cwd();

// Where the runner itself is installed, as opposed to the project it is run
// against. `root` is the project; this is the checkout holding `prompts/`,
// `plugin-roles.yaml` and `scripts/`. Kept here because three modules need it
// and three copies of the same `fileURLToPath` dance is how they drift.
export const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The version of THIS RUNNER — the orchestrator, its report shapes, its config
// semantics and its CLI. Deliberately NOT `SPEC_VERSION` in epic-spec.mjs, which
// versions the `afk:` block inside an epic issue body and is a different thing on
// a different clock. v2 changed how the runner reads `maxParallel` and what it
// writes into its reports; it changed nothing about the block an epic author
// types, so every version-1 epic still validates. Bumping the two together would
// refuse every existing epic in every repo for no reason. See CHANGELOG.md.
export const RUNNER_VERSION = "2.0.0";

/**
 * Is this module the file `node` was actually invoked with?
 *
 * Every CLI in this repo used to gate its argument parsing on
 * ``import.meta.url === `file://${process.argv[1]}` ``. That looks equivalent
 * and is not: it compares two *spellings of a path*, and a script reached
 * through a symlink is spelled two ways. macOS `/tmp` → `/private/tmp` is the
 * everyday case — `node /tmp/checkout/scripts/epic.mjs epic 255` loads the
 * module, fails the string comparison, never runs the CLI block, and exits 0
 * having printed nothing. That reads as a command that did nothing rather than
 * one that never started, which is a debugging cycle every time.
 *
 * `realpathSync` on both sides compares the file, not the route taken to it.
 *
 * Returns false rather than throwing in the two cases where there is no
 * comparison to make: no `argv[1]` at all (`node -e`, `node --eval`), and a path
 * that cannot be resolved. Neither can be the entry point, and a helper that
 * throws while deciding whether to start a CLI is worse than the bug it fixes.
 *
 * @param {string} metaUrl the caller's `import.meta.url`
 */
/**
 * `owner/name` for the checkout at `root`, or null when `gh` cannot say.
 *
 * One definition, because three files needed it and two had already grown their
 * own copy (docs/findings.md 5.4 is the same lesson about AUTH_ERROR_RE).
 */
export const currentRepo = (root) => {
  const result = run("gh repo view --json nameWithOwner -q .nameWithOwner", { cwd: root });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
};

export const isMainModule = (metaUrl) => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
};

/**
 * Notification severity. The sender controls three things on macOS — the sound,
 * whether it pierces Do Not Disturb, and whether it replaces an earlier
 * notification — and this is where all three are decided.
 *
 * It does NOT control banner-versus-alert persistence. "Stays on screen until
 * dismissed" is a per-app choice in System Settings → Notifications → (the
 * sending app) → Alerts, not a flag any sender can pass; `terminal-notifier
 * -help` has no timeout or style option. `afk notify` says so, because it is
 * the difference between a blocked lane you notice and one you scroll past.
 *
 * `ignoreDnD` is the loudest thing that IS in the sender's gift, so the two
 * events a human has to act on — a lane blocked on a question, and a lane or
 * login that died — take it, and nothing else does.
 */
export const NOTIFY_LEVELS = {
  // There is deliberately no `info`. It existed for "a lane started", which is
  // news no human has to act on, and macOS gives a sender no way to deliver a
  // notification quietly — `-group` replaces the Notification Centre entry but
  // still shows a banner and still plays a sound. So the only way to stop a
  // six-lane epic interrupting twelve times was to not send it.
  //
  // A lane passed, an epic closed.
  success: { sound: "Glass", ignoreDnD: false },
  // Something needs a human but nothing is broken: a gate, a stall.
  warn: { sound: "Basso", ignoreDnD: true },
  // Blocked on a question, a dead agent, an expired login. The run is stopped.
  error: { sound: "Sosumi", ignoreDnD: true },
};

/**
 * Which events are still allowed to interrupt.
 *
 * Severity was never the problem. Every event below `success` is already
 * "something stopped", so levelling them differently only changed the sound —
 * a six-lane run still produced a banner per lane per phase. The knob that
 * actually turns the volume down is WHICH events send at all, so that is what
 * this is: an allow-list of event names, not of levels.
 *
 * Default: a lane blocked on a question, the run stopping at a human gate, and
 * the orchestrator itself dying on a fatal error (`orchestrator_fatal`, #144 —
 * four epics sat dead for up to 2h13m because nothing said so). All three mean
 * the run cannot continue until this human does something. Everything
 * else — a lane that failed, an agent that died, an expired login, a stall, an
 * epic that finished — is still logged, still in `afk status`, and no longer
 * interrupts.
 *
 * That trade is real and worth saying out loud: with the default set, an
 * unattended run whose login expires at 2am dies silently. `AFK_NOTIFY_ONLY`
 * takes a comma-separated list, so a run you actually need to hear about can
 * widen it for that run only:
 *
 *     AFK_NOTIFY_ONLY=lane_blocked,gate_reached,orchestrator_fatal,auth_expired,runner_stalled afk auto
 *
 * Only DECLARED events are filtered. `notify()` called without a `kind` still
 * delivers — it is the renderer, and `afk notify` has to be able to fire
 * one of every severity regardless of policy.
 */
export const NOTIFY_ONLY = new Set(
  (process.env.AFK_NOTIFY_ONLY ?? "lane_blocked,gate_reached,orchestrator_fatal")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

/**
 * Deliver one notification, now. No policy, no coalescing — those live in
 * `notify()` above this. This is only the renderer.
 *
 * @returns {'terminal-notifier'|'osascript'|'failed'}
 */
const deliver = ({ title, subtitle, message, level, sound, execute, activate, group }) => {
  const text = String(message ?? "");
  const profile = NOTIFY_LEVELS[level] ?? NOTIFY_LEVELS.warn;
  const tone = sound ?? profile.sound;
  try {
    const args = ["-title", String(title), "-message", text, "-sound", tone];
    if (subtitle) args.push("-subtitle", String(subtitle));
    if (execute) args.push("-execute", String(execute));
    // Raising the app and running the command are independent branches inside
    // terminal-notifier's click handler (`userActivatedNotification:` calls
    // `activateAppWithBundleID:` then falls through to `executeShellCommand:`),
    // so both flags on one notification do both things, in that order.
    if (activate) args.push("-activate", String(activate));
    if (group) args.push("-group", String(group));
    if (profile.ignoreDnD) args.push("-ignoreDnD");
    const result = spawnSync("terminal-notifier", args, { stdio: "ignore" });
    if (!result.error && result.status === 0) return "terminal-notifier";
  } catch {
    // Fall through to osascript; an absent binary is the expected case.
  }
  try {
    // osascript takes one AppleScript string, so every field is embedded in it
    // and every quote in a field would end the string early.
    const quote = (value) => JSON.stringify(String(value ?? ""));
    const script = `display notification ${quote(text)} with title ${quote(title)}`
      + (subtitle ? ` subtitle ${quote(subtitle)}` : "")
      + ` sound name ${quote(tone)}`;
    const result = spawnSync("osascript", ["-e", script], { stdio: "ignore" });
    return !result.error && result.status === 0 ? "osascript" : "failed";
  } catch {
    return "failed";
  }
};

/**
 * How long a declared event waits for company before it is delivered.
 *
 * The policy allow-list decides WHICH events send; it cannot help with the
 * shape that actually produced the complaint — five lanes reaching a phase
 * boundary together, each correctly sending its own banner, and the supervisor
 * sending a second one about the same lane a moment later. Nothing there is a
 * repeat, so nothing dedupes it, and no notifier package changes it: they all
 * deliver the five calls the runner made.
 *
 * So the runner stops making five calls. Declared events buffer for this long
 * and leave as ONE notification. 5s is chosen to be longer than the scheduler's
 * fan-out (lanes are dispatched in a loop, microseconds apart) and short enough
 * that a lone blocked lane is not noticeably late.
 *
 * `AFK_NOTIFY_COALESCE_MS=0` restores one-banner-per-call. Read per call rather
 * than at import so a test can change it.
 */
const coalesceMs = () => Number(process.env.AFK_NOTIFY_COALESCE_MS ?? 5_000);

/**
 * How long the SAME group stays quiet after it has been delivered.
 *
 * This is the de-dupe that survives the coalescing window: a lane blocks and
 * says so, and 40s later the supervisor finishes judging that same lane and
 * wants to say it too. Both are correct, both are about ticket #207, and the
 * second one interrupts a human who is already looking. Sharing a group (the
 * ticket) makes them one event, and this window drops the follow-up.
 *
 * An escalation is never dropped — a group last heard as `warn` that comes back
 * as `error` is new information. `AFK_NOTIFY_REPEAT_MS=0` disables the window.
 */
const repeatMs = () => Number(process.env.AFK_NOTIFY_REPEAT_MS ?? 600_000);

const LEVEL_RANK = { success: 0, warn: 1, error: 2 };

/** Pending declared events, keyed by the thing that makes two of them "the same". */
const pending = new Map();
/** group → { at, level } for the repeat window. */
const delivered = new Map();
let flushTimer = null;
let exitHookInstalled = false;

/** The one thing a burst becomes: worst level, every subject named once. */
const mergePending = (entries) => {
  const worst = entries.reduce(
    (acc, entry) => (LEVEL_RANK[entry.level] > LEVEL_RANK[acc] ? entry.level : acc),
    "success",
  );
  const titles = new Set(entries.map((entry) => entry.title));
  const executes = new Set(entries.map((entry) => entry.execute ?? ""));
  return {
    ...entries[0],
    title: titles.size === 1 ? entries[0].title : "AFK runner",
    subtitle: `${entries.length} lanes need you`,
    // The subtitle of each ("#207 blocked") is the line a human scans for; the
    // detail of five events does not fit in one banner and the log has it.
    message: entries.map((entry) => entry.subtitle ?? entry.message).join(" · "),
    level: worst,
    // A click can only land in one place, so it is attached only when every
    // event in the burst wanted the same one. Otherwise the banner raises the
    // terminal (`activate`) and the operator picks the lane themselves.
    execute: executes.size === 1 ? (entries[0].execute ?? null) : null,
    group: "afk-coalesced",
  };
};

/**
 * Deliver whatever is buffered, now. Exported because the process can end
 * inside the coalescing window — a run whose last act is "gate reached" would
 * otherwise exit with the notification still in the buffer.
 *
 * @returns {string|null} the path that delivered, or null if nothing was pending
 */
export const flushNotifications = () => {
  clearTimeout(flushTimer);
  flushTimer = null;
  const entries = [...pending.entries()];
  pending.clear();
  if (entries.length === 0) return null;
  const now = Date.now();
  // Every subject that went out is marked, not just the merged banner's group,
  // so the repeat window still covers each ticket that was folded into it.
  for (const [key, entry] of entries) delivered.set(key, { at: now, level: entry.level });
  const payload = entries.length === 1
    ? entries[0][1]
    : mergePending(entries.map(([, entry]) => entry));
  return deliver(payload);
};

/** Test seam: forget what was delivered, so a repeat window cannot leak between tests. */
export const resetNotifyState = () => {
  clearTimeout(flushTimer);
  flushTimer = null;
  pending.clear();
  delivered.clear();
};

/**
 * One notification, clickable when there is somewhere to click to.
 *
 * `osascript display notification` works and is inert: clicking it goes
 * nowhere, which is the wrong outcome for the one event that most needs a human
 * — a blocked lane. `terminal-notifier` supports `-execute`, so the click can
 * land the operator in the pane that is asking them a question.
 *
 * Four rules, all of them about not making things worse than the inert
 * notification they replace:
 *
 *  1. **`terminal-notifier` is optional.** It is a brew binary, not something a
 *     runner may assume. Absent, this falls back to `osascript`, which ships
 *     with macOS. The runner stays dependency-free. The fallback loses the
 *     click, the DnD override and the grouping; it keeps the sound.
 *  2. **`-execute` is attached only when a caller supplies one.** A
 *     `--runtime=direct` run has no workspace to focus, and a click that runs a
 *     failing command is worse than a click that does nothing.
 *  3. **`group` replaces rather than stacks.** A lane that reports twice should
 *     leave one notification, not two. Passing the task id as the group is what
 *     stops a long run burying the Notification Centre.
 *  4. **It never throws and never blocks the caller's outcome.** A notification
 *     that fails must not fail the run that was trying to report.
 *
 * Not verified here, and worth checking once on a new machine: macOS grants
 * notification permission per app, so if `terminal-notifier` was never granted
 * it, delivery fails silently. `afk notify` fires one.
 *
 * @param {object} args
 * @param {string} args.title the app-level line ("AFK runner — <repo>")
 * @param {string|null} args.subtitle the event ("#207 blocked")
 * @param {string} args.message the detail
 * @param {'success'|'warn'|'error'} args.level severity; picks the sound
 * @param {string|null} args.execute shell command to run when clicked
 * @param {string|null} args.activate bundle id of the app to raise when clicked;
 *   defaults to the app the runner was launched from
 * @param {string|null} args.group notifications sharing one replace each other
 * @param {string|null} args.kind the event name, checked against `NOTIFY_ONLY`;
 *   omitted means "unfiltered", which is what `afk notify` relies on
 * @returns {'terminal-notifier'|'osascript'|'failed'|'suppressed'|'coalesced'|'deduped'}
 *   which path delivered it, or why it did not go out on its own: `suppressed`
 *   is the NOTIFY_ONLY allow-list, `coalesced` is buffered and will leave with
 *   whatever else the next few seconds bring, `deduped` is a group that was
 *   already reported inside the repeat window
 */
export const notify = ({
  title,
  subtitle = null,
  message,
  level = "warn",
  sound = null,
  execute = null,
  // Every notification this runner sends means "come and look", so every one of
  // them raises the window on click — not just the lane notifications that also
  // have a pane to focus. `__CFBundleIdentifier` is the app macOS launched the
  // runner from (Terminal, iTerm, Ghostty), so this follows the operator's
  // terminal without being told which one it is. Absent under cron and launchd,
  // where there is no window worth raising and the notification stays inert.
  activate = process.env.__CFBundleIdentifier ?? null,
  group = null,
  kind = null,
}) => {
  if (kind && !NOTIFY_ONLY.has(kind)) return "suppressed";
  const payload = { title, subtitle, message, level, sound, execute, activate, group };
  const window = coalesceMs();
  // An UNDECLARED notification is `afk notify` and nothing else: it
  // exists to put a banner on screen right now and report which path did it, so
  // it never waits and is never merged with a lane's.
  if (!kind || !(window > 0)) return deliver(payload);

  // What makes two events "the same thing": the group when there is one (the
  // ticket, for a lane), the event otherwise.
  const key = group ?? `${kind}:${subtitle ?? message}`;
  const last = delivered.get(key);
  const quiet = repeatMs();
  if (last && quiet > 0 && Date.now() - last.at < quiet
      && LEVEL_RANK[level] <= LEVEL_RANK[last.level]) {
    return "deduped";
  }
  // Latest wins within the window. Two reports about one ticket are one banner
  // saying the newer thing, not two banners.
  pending.set(key, payload);
  if (!flushTimer) {
    flushTimer = setTimeout(flushNotifications, window);
    // Never hold the process open for a banner...
    flushTimer.unref?.();
    // ...but never drop one either. An `exit` listener runs synchronously, and
    // `deliver` is spawnSync, so this is the one place a buffered notification
    // can still be sent after the runner has decided to stop.
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on("exit", () => { try { flushNotifications(); } catch {} });
    }
  }
  return "coalesced";
};

/**
 * Does this text say the agent's login died?
 *
 * One policy, one home. Three call sites recognise auth death and each used to
 * carry its own copy of this regex with a "if either changes, change both"
 * comment: the herdr runtime scanning a live transcript, the plan reviewer
 * scanning a finished `-p` run, and the supervisor's deterministic prior. The
 * copies were justified as "not coupling three layers", but the thing they were
 * avoiding coupling *is* the shared fact — what a dead session looks like — and
 * three copies of a fact is how two of them go stale.
 *
 * Deliberately not exported as a bare regex: a caller could then attach flags
 * or read `lastIndex` and make one site's scan depend on another's.
 *
 * @param {string} text transcript, stdout or stderr
 */
export const looksLikeAuthDeath = (text) =>
  /OAuth session expired|Failed to authenticate|authentication_error/.test(
    String(text ?? ""),
  );

/**
 * The three sources of truth, none overlapping (docs/epic-schema.md):
 *
 *   the epic + its children   WHAT to build, and in what order   (spec)
 *   .afk-setup/config.yaml    HOW this stack is verified         (stack)
 *   .afk/state.json           WHAT is happening right now        (runtime)
 *
 * `.afk-setup/` is human-edited and committed; `.afk/` is machine state and
 * gitignored. Nothing crosses that line, which is why `.afk/` needs no
 * negation rule in a project's `.gitignore`.
 *
 * The config is YAML rather than JSON because the shipped file carries every
 * optional key commented out, and JSON has no comments. It is parsed by
 * `parseYamlSubset` — the same hand-written parser the epic block uses, so the
 * runner stays dependency-free.
 *
 * The runner only ever READS it — there is deliberately no `saveConfig`,
 * because a runner that rewrites its own config is how a failed run used to
 * leave the tree dirty.
 *
 * The spec reaches the runner as an in-memory DAG, never as a file the runner
 * loads:
 *
 *   { epic, branch, tasks: [
 *       { id, title, dependsOn, checks, allowedPaths, humanGated, body } ] }
 *
 * `id` is the GitHub issue number, always as a STRING (see normalizeId).
 * `body` is the task's specification text — what used to be read out of
 * `planning/tasks/<id>.md`. Task records carry NO `status`: `.afk/state.json`
 * is the sole owner of lifecycle, so the spec and the run cannot disagree.
 *
 * `epic` is `{ id, title }`, not a bare string. `scripts/runtime-herdr.mjs`
 * keys every visible herdr name off `epic.id` and degrades to the pre-epic
 * naming when it is absent — so a bare string does not throw, it just quietly
 * gives every lane the wrong name. `title` is a display label only.
 *
 * `checks` and `allowedPaths` are OPTIONAL ON INPUT and RESOLVED AT THE
 * BOUNDARY: `normalizeDag` in `scripts/auto.mjs` fills `checks` from
 * `config.defaultChecks` and `allowedPaths` from `['**']` (repo-wide advisory
 * scope; v1 derives nothing — docs/epic-schema.md failure mode 2). Producers
 * of a DAG may omit them; every consumer past that boundary may assume both
 * are present and non-empty arrays. Nothing else in the runner is allowed to
 * re-guess a default, because the two call sites that did guessed differently
 * and one of them merged with no gate at all.
 */
export const configPath = (projectRoot = root) =>
  resolve(projectRoot, ".afk-setup/config.yaml");
export const loadConfig = (projectRoot = root) => {
  const text = readFileSync(configPath(projectRoot), "utf8");
  // A file that is nothing but comments is a project taking every default —
  // which is what the shipped config looks like before anyone edits it.
  // `parseYamlSubset` calls a document with no content an error; here it is not.
  const blank = text.split("\n").every((line) => {
    const body = line.trim();
    return body === "" || body.startsWith("#");
  });
  const config = blank ? {} : parseYamlSubset(text) ?? {};
  validateMergeConfig(config);
  return config;
};

/**
 * The `merge:` block (#188): what the merge guardrails in
 * scripts/merge-guards.mjs read. Every key is optional; an unknown key is an
 * error, like every other block, because a misspelt `userFacng:` read as "not
 * declared" would change what a delegate may merge.
 *
 *   userFacing           globs of paths a user sees
 *   screenshotBaselines  globs of the PNG baselines that cover them
 *   ci                   `required` (default) or `none`
 *   healthProbe          a shell command; exit 0 means healthy
 *   author               `{ name, email }`: `afk merge` merges locally as this
 *                        author instead of through `gh pr merge` (#212)
 *   coAuthors            `Name <email>` strings, one `Co-Authored-By:` trailer
 *                        each on that merge commit; needs `author`
 *
 * @throws {Error} naming the key and what was wrong with it
 */
export const MERGE_CONFIG_KEYS = ["userFacing", "screenshotBaselines", "ci", "healthProbe", "author", "coAuthors"];
const CO_AUTHOR = /^[^<>\n]+ <[^\s<>@]+@[^\s<>@]+>$/;
export const validateMergeConfig = (config) => {
  if (!Object.hasOwn(config ?? {}, "merge")) return;
  const merge = config.merge;
  const where = ".afk-setup/config.yaml";
  if (merge === null || typeof merge !== "object" || Array.isArray(merge)) {
    throw new Error(`${where}: \`merge:\` must be a mapping of ${MERGE_CONFIG_KEYS.join(", ")}.`);
  }
  const unknown = Object.keys(merge).filter((key) => !MERGE_CONFIG_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`${where}: unknown key(s) under \`merge:\`: ${unknown.join(", ")} (allowed: ${MERGE_CONFIG_KEYS.join(", ")}).`);
  }
  for (const key of ["userFacing", "screenshotBaselines"]) {
    const value = merge[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((glob) => typeof glob === "string" && glob.trim() !== "")) {
      throw new Error(`${where}: \`merge.${key}\` must be a list of path globs, got ${JSON.stringify(value)}.`);
    }
  }
  if (merge.ci !== undefined && !["required", "none"].includes(merge.ci)) {
    throw new Error(`${where}: \`merge.ci\` must be \`required\` or \`none\`, got ${JSON.stringify(merge.ci)}.`);
  }
  if (merge.healthProbe !== undefined && (typeof merge.healthProbe !== "string" || merge.healthProbe.trim() === "")) {
    throw new Error(`${where}: \`merge.healthProbe\` must be a shell command, got ${JSON.stringify(merge.healthProbe)}.`);
  }
  if (merge.author !== undefined) {
    const author = merge.author;
    const ok = author && typeof author === "object" && !Array.isArray(author)
      && Object.keys(author).every((key) => key === "name" || key === "email")
      && typeof author.name === "string" && author.name.trim() !== "" && !/[<>\n]/.test(author.name)
      && typeof author.email === "string" && /^[^\s<>@]+@[^\s<>@]+$/.test(author.email);
    if (!ok) throw new Error(`${where}: \`merge.author\` must be a mapping of \`name\` and \`email\`, got ${JSON.stringify(author)}.`);
  }
  if (merge.coAuthors !== undefined) {
    if (!Array.isArray(merge.coAuthors) || !merge.coAuthors.every((entry) => typeof entry === "string" && CO_AUTHOR.test(entry.trim()))) {
      throw new Error(`${where}: \`merge.coAuthors\` must be a list of \`Name <email>\` strings, got ${JSON.stringify(merge.coAuthors)}.`);
    }
    if (merge.author === undefined) throw new Error(`${where}: \`merge.coAuthors\` needs \`merge.author\`: without it \`afk merge\` goes through \`gh pr merge\`, which writes no trailers.`);
  }
};

/**
 * Task ids are strings, everywhere, from the DAG boundary inward.
 *
 * The id is a GitHub issue number, so JSON and YAML hand it over as the number
 * `204` in a `tasks:` list but as the string `"204"` when it is an object key —
 * and `.afk/state.json` keys, `state.integrationQueue` entries and
 * `activeWorkers` keys are all object keys. One `204 !== "204"` is enough to
 * strand a task: the scheduler finds no state entry, seeds a second one, and
 * the lane never reaches integration. Normalise once, on the way in.
 */
export const normalizeId = (id) => (id === null || id === undefined ? null : String(id));

export const atomicWrite = (path, content) => {
  ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
};
// Non-login shell on purpose: macOS `path_helper` (sourced by /etc/profile for
// login shells) rewrites PATH and can put a system Node ahead of the nvm Node
// this process runs on, which breaks toolchains pinned to the project's Node.
//
// A spawn that fails outright (EAGAIN under process pressure, ENOMEM, a
// missing cwd) returns `stdout: null` with `error` set, and every caller that
// reads `.stdout.trim()` then threw a TypeError that killed the scheduler
// (#136, epic #841: `ledgerDirty`). Fail direction: soft. The result reads as a
// failed command — empty output, non-zero status, the spawn error in `stderr`
// so a caller that logs stderr logs the cause — never as a crash.
export const run = (command, options = {}) => {
  const result = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8", ...options });
  if (result.error && result.stdout == null) {
    result.stdout = "";
    result.stderr = `${result.error.code ?? "spawn failed"}: ${result.error.message} (${command})`;
    result.status ??= 1;
  }
  return result;
};
// How QUIET the pipes must go before a finished command's result is handed back
// regardless. A quiet period, not a deadline: every chunk pushes it out again.
// Fail direction: a clipped tail is worse than nothing only in a bug report,
// while a call that never returns is the six-hour stall itself — so the total
// wait is capped by DRAIN_CEILING_MS below and then we resolve. This window only
// ever ELAPSES when something still holds the write end of the pipe; an ordinary
// command's `close` arrives in the same breath as its `exit` and clears it, so
// nothing pays for it on the normal path.
const DRAIN_MS = 2_000;
// The hard cap the quiet period is measured against, so a grandchild writing
// without pause cannot hold the call open forever — which is the stall DRAIN_MS
// exists to bound, reintroduced by the re-arming.
const DRAIN_CEILING_MS = 10_000;
// How long a timed-out command gets to honour SIGTERM before the group is
// SIGKILLed. Exported so the guard's own test can wait past it rather than
// hard-coding a second copy of the number.
export const KILL_ESCALATION_MS = 5_000;
export const runAsync = (command, options = {}) => {
  const {
    cwd = root,
    env = process.env,
    timeout = 0,
    onSpawn,
    ...rest
  } = options;
  return new Promise((resolve) => {
    // When and under what load the command started, carried on the result for
    // the gate events scripts/measure.mjs records (#181). Additive: no reader
    // of a result depends on these.
    const startedAt = Date.now();
    const load1 = loadavg()[0];
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can kill what the command FORKED
      // rather than only the `sh` that forked it. Every real check is a fork —
      // a pipeline, a background job, `npm test` — and so is the agent CLI,
      // which starts per-lane MCP servers. Signalling the `sh` pid alone left
      // all of them running.
      detached: true,
      ...rest,
    });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    // Set by the `exit` handler below, and null until then: while the drain
    // window is open, every chunk that arrives pushes it back out.
    let rearmDrain = null;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      rearmDrain?.();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      rearmDrain?.();
    });
    let timedOut = false;
    let exited = false;
    // The group may already be gone — the `sh` exited between the timer firing
    // and here, or the SIGKILL escalation lands after the SIGTERM worked. Fail
    // direction: swallow the ESRCH. A stray signal error is a nuisance; an
    // unhandled rejection out of a reaper takes the whole runner down.
    //
    // Swallowing is NOT a licence to signal late. Once the child has exited and
    // Node has reaped it, the kernel is free to hand that pid to somebody else,
    // and `process.kill(-pid)` would then land on a stranger's process group —
    // it is not the harmless no-op `child.kill()` is after a reap. Every caller
    // of this must know the child is still running; see the escalation below.
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
      // Belt and braces for a caller that overrode `detached` through `...rest`:
      // the group id would not exist and the line above would be a no-op.
      try {
        child.kill(signal);
      } catch {}
    };
    // Is anything still IN the child's process group? The only honest question
    // once the leader has been reaped, and it is also what makes the escalation
    // below safe: a pid cannot be reissued while a process group of that id
    // still exists, so an answer of "yes" is an answer of "and it is ours".
    // ESRCH means the group is empty and the pid is free — never signal it.
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    };
    let escalation = null;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            // PID REUSE is why this asks before it signals. On the ordinary
            // path SIGTERM works, `exit` fires and Node reaps the child — and
            // this used to fire five seconds later at a pid the kernel had
            // already reissued, hitting whatever group holds it now. Every lane
            // this runner spawns is `detached`, so that is most likely a healthy
            // sibling lane's.
            //
            // Gating on `exited` alone closed that window and opened another:
            // the fork case this escalation was WRITTEN for is a leader `sh`
            // that dies at SIGTERM while the grandchildren it forked trap the
            // signal and carry on — so `exit` always fired first and the SIGKILL
            // never once landed on the processes still burning the machine.
            // `groupAlive` keeps both: an empty group is a freed pid and is left
            // alone, a live one cannot have been reissued and is still ours.
            //
            // FAIL DIRECTION: signal only what the kernel confirms is there.
            // SIGKILLing a group that is no longer ours, silently, from a
            // reaper, is worse than a survivor that `lsof` and teardown.mjs can
            // still find — so anything short of a positive answer does nothing.
            escalation = setTimeout(() => {
              if (!exited || groupAlive()) killGroup("SIGKILL");
            }, KILL_ESCALATION_MS);
            // Unref'd, and deliberately NOT cleared by `exit` or by `finish`:
            // the case it exists for is precisely the one where the child has
            // exited and the promise has settled while the group lives on.
            escalation.unref();
          }, timeout)
        : null;
    let drain = null;
    let settled = false;
    const finish = (status, signal, extraStderr = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drain) clearTimeout(drain);
      // Stop reading. A grandchild we could not kill still holds the write end,
      // and a live pipe keeps the runner's event loop alive long after the
      // result was handed back — the orchestrator would refuse to exit at the
      // end of a run over a `sleep` nobody owns any more.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        status, signal, stdout, stderr: `${stderr}${extraStderr}`, timedOut, pid: child.pid,
        startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, load1,
      });
    };
    child.on("error", (error) => finish(null, null, error.message));
    // `exit`, not `close`. `close` waits for the stdio pipes to shut as well,
    // and a grandchild that inherited them holds them open forever: the timer
    // fired, the `sh` died, and the caller went on awaiting — the timeout could
    // not unblock a lane for exactly the checks it exists for.
    child.on("exit", (status, signal) => {
      // Set BEFORE the drain window, because Node reaps the child here and the
      // pid stops being ours from this moment, not from `finish`.
      exited = true;
      // A BARE TIMER HERE LOST THE WHOLE OUTPUT, not a tail of it. It competes
      // with libuv's poll phase, and timers run FIRST in each turn of the loop:
      // a synchronous block longer than DRAIN_MS between this event and the next
      // poll — routine, since concurrent lanes run `spawnSync` git constantly —
      // means the timer expires before a single byte has been read, and `finish`
      // destroys pipes holding everything the command wrote. A reviewer's probe
      // lost all 23,893 bytes a grandchild produced, and `renderPriorAttempts`
      // then reports "It produced no output" — corrupting exactly the evidence
      // #70 exists to improve. The old `close`-based resolve could not do this.
      //
      // So: hop through `setImmediate`, which runs in the check phase, straight
      // AFTER poll — anything the kernel already had for us has been read and
      // delivered by the time `finish` tears the streams down. And re-arm on
      // every chunk, so output arriving in bursts is collected rather than cut
      // at the first window, bounded by DRAIN_CEILING_MS.
      const ceiling = Date.now() + DRAIN_CEILING_MS;
      const finishAfterPoll = () => {
        if (settled) return;
        setImmediate(() => finish(status, signal));
      };
      rearmDrain = () => {
        if (settled) return;
        if (drain) clearTimeout(drain);
        const left = Math.min(DRAIN_MS, ceiling - Date.now());
        if (left <= 0) return finishAfterPoll();
        drain = setTimeout(finishAfterPoll, left);
      };
      rearmDrain();
    });
    child.on("close", (status, signal) => finish(status, signal));
  });
};
export const ensureDir = (path) => mkdirSync(path, { recursive: true });
export const write = (path, content) => {
  ensureDir(dirname(path));
  writeFileSync(path, content);
};
// Stdout, not stderr: a supervising agent reads stdout, and a refusal it never
// sees is a command that declined with no reason. Exit 1 is unchanged.
export const die = (message) => {
  console.log(message);
  process.exit(1);
};

// --- argv --------------------------------------------------------------------

/**
 * Parse a subcommand's argv tail against the flags that subcommand accepts, and
 * refuse anything else by name.
 *
 * The runner used to forward argv to a subcommand script verbatim, so a typo
 * reached a script that never looked for it and was silently ignored:
 * `--worktreee`, `--bas=main` and `--jsonn` all ran happily, the operator's
 * intent dropped, the only evidence the result being wrong. This is the same
 * class of silence as a wrong base branch, and the fix is the same shape — fail
 * loud, naming both the flag typed and the flags that exist.
 *
 * Value binding stays with each script, deliberately. `--repo owner/name` and
 * `--repo=owner/name` are both live in this runner, and the space form is
 * ambiguous with a positional (`afk epic --worktree 27`); every script already
 * resolves that ambiguity its own way, and re-deciding it here would change
 * behaviour this parser exists only to guard. So a space-form value stays in
 * `positional` and `flags` records the flag as `true`.
 *
 * @param {string[]} argv          the argv tail, command word already removed
 * @param {Iterable<string>} accepted  flag names WITHOUT the leading `--`
 * @param {{command?: string}} [options]  the subcommand's name, for the message
 * @returns {{flags: Record<string, string|true>, positional: string[]}}
 */
export const parseArgv = (argv, accepted, { command = "" } = {}) => {
  const allowed = new Set(accepted);
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    // Only `--name` is a flag here. A bare `-` or `-v` is left to the script:
    // this runner has no short options, and treating one as a flag would refuse
    // arguments that work today.
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!allowed.has(name)) {
      const known = [...allowed].sort().map((flag) => `--${flag}`).join(", ");
      throw new Error(
        `unknown flag --${name}${command ? ` for \`afk ${command}\`` : ""}. ` +
          (known ? `Accepted: ${known}.` : "It accepts no flags."),
      );
    }
    flags[name] = eq === -1 ? true : arg.slice(eq + 1);
  }
  return { flags, positional };
};

// Glob subset: `**` crosses directory separators, `*` and `?` do not.
// Tokenised in ONE pass on purpose. Doing it as sequential replaces —
// `**`→`.*` then `*`→`[^/]*` — rewrites the `*` inside the just-inserted `.*`
// into `.[^/]*`, which both stops `**` crossing `/` and requires a character
// after the slash. `app/theme/**` would then silently exclude every file in a
// subdirectory, plus the collapsed untracked-directory entry (`app/theme/`),
// so in-scope work would be reverted as out-of-scope and never committed.
export const globToRegExp = (pattern) =>
  new RegExp(
    `^${pattern.replace(/\*\*|[*?]|[^*?]+/g, (token) => {
      if (token === "**") return ".*";
      if (token === "*") return "[^/]*";
      if (token === "?") return "[^/]";
      return token.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })}$`,
  );
export const pathAllowed = (file, patterns) =>
  patterns.some((pattern) => globToRegExp(pattern).test(file));

/**
 * The directory an `allowedPaths` entry cannot claim outside of: its longest
 * leading run of glob-free segments. `src-tauri/**` claims `src-tauri`;
 * `app/screens/*` claims `app/screens`; `**` and `tsconfig.*.json` claim the
 * whole repo and answer `""`.
 *
 * `pathAllowed` answers "is this FILE in scope"; this answers "what region does
 * this PATTERN cover", which is the question you have to ask when comparing two
 * scopes with no file in hand. A trailing slash is punctuation, not meaning:
 * `Sources/Feature/` and `Sources/Feature` are one claim.
 */
export const ownScope = (pattern) => {
  const segments = String(pattern).replace(/\/+$/, "").split("/");
  const globbed = segments.findIndex((segment) => /[*?[]/.test(segment));
  return (globbed === -1 ? segments : segments.slice(0, globbed)).join("/");
};

/**
 * Could two scope claims touch the same file? Directory-prefix aware, per
 * SEGMENT and not per character: `Sources/Feature` and `Sources/FeatureFlags`
 * share a string prefix and share no file, and a raw `startsWith` would call
 * that a collision.
 *
 * Fails **closed**: a claim that resolves to the whole repo (`""`) overlaps
 * everything, because the honest answer to "does repo-wide touch `src/a.ts`" is
 * yes. Callers for whom repo-wide means "unconstrained" — the scheduler's
 * `["**"]` opt-out — must drop those claims before they get here, not hope this
 * function guesses.
 */
export const ownsOverlap = (left, right) => {
  const a = ownScope(left);
  const b = ownScope(right);
  if (a === "" || b === "") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

// Parse `git status --porcelain` into paths. Never `.trim()` the whole output
// before splitting: the first line of an unstaged modification starts with a
// space (` M path`), and trimming the blob eats it, so the first path loses its
// first character (`agent-auto.log` → `gent-auto.log`) and then looks
// out-of-scope. Split first, strip the fixed 2-char status field per line.
//
// THE ONLY PORCELAIN PARSER. `dirtyBlockers` grew a second one that dropped the
// `??` lines this keeps but mangled a rename into the literal `old -> new`,
// which then reached `git stash push -- <pathspec>` and matched no file — so a
// human renaming a task file mid-wave stranded the wave. `includeUntracked` is
// the one thing that differed and it is a flag, not a fork.
export const parseStatusPaths = (porcelain, { includeUntracked = true } = {}) =>
  porcelain
    .split("\n")
    .filter((line) => line.length > 3 && (includeUntracked || !line.startsWith("??")))
    .map((line) =>
      line.slice(2).trim().split(" -> ").pop().replace(/^"|"$/g, ""),
    );

/**
 * Why a dirty tree refuses a run, in the words a human needs.
 *
 * Two callers: `cliEpic`'s hoisted preflight, which is the path an operator
 * actually takes, and `runAuto`'s backstop for `afk auto` invoked directly.
 * Shared rather than duplicated because they diverged once already — the
 * backstop kept saying "unrelated work" about a `.afk-setup/` edit long after
 * the preflight learned better, and whichever one a given operator hit decided
 * whether they got the real reason.
 *
 * Returns the lines to print, in order, `prefix`ed with the caller's own tag.
 * `note` is the one thing the two callers do not share: `cliEpic` can promise
 * nothing was created, because it refuses before the branch; `runAuto` cannot.
 */
export const dirtyTreeLines = (dirty, prefix, note = "") => {
  const setup = dirty.filter((path) => path.startsWith(".afk-setup/"));
  return [
    `${prefix}: the working tree must be clean before the run starts.${note ? ` ${note}` : ""}`,
    ...dirty.map((path) => `  ${path}`),
    setup.length
      ? `${prefix}: commit the ${setup.join(", ")} change first — editing it right before a run is the expected workflow, not unrelated work. Lane worktrees are cut from the committed branch, so an uncommitted .afk-setup/ change never reaches the lanes at all.`
      : `${prefix}: commit or stash the work above, then run again.`,
  ];
};

export const ready = (task, tasks) =>
  task.status === "pending" &&
  task.dependsOn.every(
    (id) => tasks.find((x) => x.id === id)?.status === "passed",
  );

/**
 * The one seam for "what lifecycle is this task in".
 *
 * A DAG task carries no status, so `.afk/state.json` is the sole owner and a
 * task state has never heard of has never run. That single rule used to be
 * retyped in six files — scheduler, lib, status, heartbeat, dashboard — so
 * adding a lifecycle or changing the default cost six edits and the copies were
 * free to drift apart while every one of them still looked right on its own.
 *
 * Takes a task record or a bare id, because the callers are split between the
 * two and a seam only one half can reach is not a seam. Re-exported by
 * `scripts/scheduler.mjs`; lives here because lib.mjs is the layer everything
 * already imports, and lib.mjs importing the scheduler would invert that.
 */
export const lifecycleOf = (task, state) =>
  state?.tasks?.[task?.id ?? task]?.lifecycle ?? "pending";

// (#294) The tier router's columns for one task: its tier, the model its
// latest builder attempt actually ran on, and the Jev answers that decided the
// tier with the Score's confidence. Null for a run the router never touched,
// so a table from before routing keeps its four columns.
const routingCells = (id, state) => {
  const routing = state.builderRouting;
  const assignments = routing?.assignments ?? {};
  if (!routing?.skipped && !Object.values(assignments).some((entry) => entry?.tier)) return null;
  const assignment = assignments[id];
  const last = state.tasks?.[id]?.builderRuns?.at(-1);
  const skipped = assignment?.routerSkipped ?? (!assignment ? routing.skipped?.reason : null);
  return [
    assignment?.tier ?? (routing.skipped ? "critical" : "-"),
    last ? `${last.backend ?? "?"}/${last.model ?? "unknown"}` : "-",
    assignment?.jev
      ? describeAnswers(assignment.jev.answers, assignment.jev.deciding)
      : skipped ? `router skipped: ${skipped}` : "-",
  ];
};

// The DAG supplies the shape, `.afk/state.json` the lifecycle — the same split
// the rest of the runner uses.
export const renderProgress = (dag, state = {}) => {
  const routed = (dag.tasks ?? []).some((t) => routingCells(t.id, state));
  return [
    `# Progress${dag.epic ? ` — ${dag.epic.title ?? dag.epic.id ?? dag.epic}` : ""}`,
    "",
    routed ? "| ID | Task | Status | Dependencies | Tier | Model | Jev answers |" : "| ID | Task | Status | Dependencies |",
    routed ? "| --- | --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |",
    ...(dag.tasks ?? []).map(
      (t) =>
        `| ${t.id} | ${t.title}${t.humanGated ? " 🔒" : ""} | ${lifecycleOf(t, state)} | ${t.dependsOn.join(", ") || "-"} |`
        + (routed ? ` ${routingCells(t.id, state).join(" | ")} |` : ""),
    ),
    "",
    (dag.tasks ?? []).some((t) => t.humanGated)
      ? "🔒 = human-gated: skipped by `afk auto`; unrelated runnable tasks continue."
      : "",
  ].join("\n");
};

// A section is DELIMITED, not guessed at. The first cut of this took a section
// to run from its marker to the next epic's marker, which meant the last section
// on the page owned everything after it — so a human's note at the bottom of the
// file was deleted by the next status flush. That is the bug this whole function
// exists to fix, one scope smaller. An explicit end marker is the only version
// where "the runner rewrites its own section and nothing else" is true.
const PROGRESS_OPEN = (id) => `<!-- afk:progress:${id} -->`;
const PROGRESS_CLOSE = (id) => `<!-- /afk:progress:${id} -->`;

/**
 * This epic's progress table, merged into the project's progress file.
 *
 * `renderProgress` renders ONE epic and the status flush used to `atomicWrite`
 * the result over the whole of `docs/progress.md` — so every epic silently
 * deleted every earlier epic's table. Epic #93 lost ~146 lines that way and its
 * reflection predicted the recurrence, correctly: no ticket owns the file, and
 * every run's status commits touch it.
 *
 * Each epic gets a section between its own open and close markers, replaced
 * exactly between them on re-flush and appended when new. Content the runner did
 * not write is never touched, wherever it sits: above the sections, between two
 * of them, or below the last one.
 *
 * A section whose close marker has been removed by hand is left alone and a
 * fresh one is appended, so the file grows a visible duplicate rather than
 * losing text. That is deliberate: the only other option is to guess where the
 * section ended, and guessing is what deleted the human's note in the first cut.
 *
 * A run with no epic id (the `--dag=` seam) has nothing to key a section on and
 * keeps the whole-file behaviour. Inventing an id would file two unrelated runs
 * under one heading, which is worse than overwriting on a surface that has only
 * ever held one run's table.
 */
export const mergeProgress = (existing, dag, state = {}) => {
  const id = dag?.epic?.id ?? dag?.epic ?? null;
  const rendered = renderProgress(dag, state);
  if (id === null || id === undefined || id === "") return rendered;
  const open = PROGRESS_OPEN(id);
  const close = PROGRESS_CLOSE(id);
  const section = `${open}\n\n${rendered.replace(/^# /, "## ")}\n${close}`;
  const before = String(existing ?? "");
  const start = before.indexOf(open);
  const end = start === -1 ? -1 : before.indexOf(close, start);
  // No section of ours yet — including a whole file written before markers
  // existed, which is every consuming project's today. It keeps its content and
  // this epic's table goes below it.
  if (start === -1 || end === -1) {
    const head = before.trimEnd();
    return head ? `${head}\n\n${section}\n` : `${section}\n`;
  }
  return `${before.slice(0, start)}${section}${before.slice(end + close.length)}`;
};

// Where an epic's table lives. One file per epic, because a SHARED file is a
// merge conflict per epic by construction: two branches that both appended a
// section collide textually even though the marker scheme guarantees they have
// nothing to disagree about. Five conflicts across three repos in one morning
// (#122), zero of them real.
//
// The markers above stay. They are what keeps an EXISTING single-file
// `docs/progress.md` — every consuming project's today — safe when a run
// rewrites its own section, and a run with NO epic id still lands there.
// That is `afk auto --dag=<file>` over a hand-written DAG, and nothing else: a
// wave is NOT epic-less, whatever the shape of its id suggests. `wave-loader.mjs`
// stamps `epic: { id: waveId }` and `wave.mjs` re-stamps it per wave, so
// `wave-01` writes `docs/progress/wave-01.md` like any other run.
//
// Both paths are exported because four separate lists have to name them —
// `BOOKKEEPING_FILES`, `PROTECTED_*`, `isStatusFlushPath` and wave.mjs's
// evidence archive — and a literal copied into each is how the old path fell
// out of three of them at once. `PROGRESS_DIR` carries its trailing slash
// because its commonest use is a `startsWith` prefix; `resolve()` drops it for
// the two filesystem callers.
export const PROGRESS_FILE = "docs/progress.md";
export const PROGRESS_DIR = "docs/progress/";

// An id that is not a plain filename keeps the whole-file path rather than
// building one out of it: an id is a GitHub issue number or a wave id, and a
// `/` or a `..` in one would write outside `docs/`. FAIL DIRECTION: open, onto
// the shared file — which is the collision this whole change exists to stop, so
// two runs landing there is a bug report, not a quiet success. Writing outside
// `docs/` is the worse of the two failures, which is why it fails this way.
export const progressPath = (dag) => {
  const id = dag?.epic?.id ?? dag?.epic ?? "";
  // No dot in the class: it is what would let `.` through as `docs/progress/..md`
  // and it buys nothing — an issue number has none.
  return /^[A-Za-z0-9_-]+$/.test(String(id)) ? `${PROGRESS_DIR}${id}.md` : PROGRESS_FILE;
};

// The write behind `flushStatuses`' staged file list: it pushes what this
// returns, so the path a run commits and the path this computes cannot drift.
// Merged rather than overwritten because the destination may already hold a
// section — the per-epic file on a re-flush, or the project's pre-existing
// shared file on the epic-less seam.
export const writeProgress = (root, dag, state = {}) => {
  const relative = progressPath(dag);
  const absolute = resolve(root, relative);
  const before = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
  atomicWrite(absolute, mergeProgress(before, dag, state));
  return relative;
};

// --- agent invocation config ------------------------------------------------
// Overridable per project via the `agent` block in .afk-setup/config.yaml.
const DEFAULT_AGENT = {
  command: "claude",
  model: "claude-opus-5-5",
  reasoningEffort: "medium",
  bypassPermissions: true,
  timeoutMs: 900000,
  permissionMode: "acceptEdits",
  // Retries AFTER the first attempt, so `1` is the two-attempt behaviour every
  // epic has always had. Raising it is what buys grounded retries
  // (docs/wave-mode.md §5): attempt 2 and later carry the prior attempts'
  // failure evidence, which is worth nothing at the default.
  maxBuilderRetries: 1,
};
// The Codex backend's defaults. Deliberately a second record rather than a
// patch over DEFAULT_AGENT: the two providers share no flag, and a merged
// record is how a Claude model or a `--permission-mode` ends up on a Codex
// command line. The per-role model and effort come from `CODEX_ROLE_TIERS` in
// scripts/roles.mjs; these are what a role-less caller (the self-tests) gets.
const CODEX_DEFAULT_AGENT = {
  command: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  timeoutMs: 900000,
  // Codex's OS-level sandbox is the runtime filesystem boundary, the way the
  // `--settings` profile is Claude's. `roleAgent` narrows it per role.
  sandbox: "workspace-write",
  // An AFK run is unattended: the agent must never stop to ask a human.
  approvalPolicy: "never",
  maxBuilderRetries: 1,
};

// Which backend this process is running. Set by the executable — `afk` is
// Claude, `afk-codex` is Codex — and carried to every subcommand the dispatcher
// spawns in the environment, because those scripts are shared by both.
export const BACKEND_ENV = "AFK_BACKEND";
export const DEFAULT_BACKEND = "claude";
export const BACKENDS = ["claude", "codex"];

/**
 * Fail CLOSED on a backend nobody implements. An unrecognised name must stop
 * here, before a command is built: the alternative is silently falling back to
 * Claude and running a whole epic on the provider the operator did not pick.
 */
export const resolveBackend = (name = process.env[BACKEND_ENV]) => {
  const backend = name === undefined || name === null || name === "" ? DEFAULT_BACKEND : String(name);
  if (!BACKENDS.includes(backend))
    throw new Error(`Unknown agent backend "${backend}". Known backends: ${BACKENDS.join(", ")}.`);
  return backend;
};

// A Codex model name, and nothing else. The pattern's real job is to refuse a
// Claude model: `.afk-setup/config.yaml` is shared by both executables, so
// `agent.model: claude-opus-5` is the normal contents of a working config and
// must never be read as a Codex model.
const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/i;
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "max"];

export const codexModel = (value, where) => {
  if (typeof value !== "string" || !CODEX_MODEL_RE.test(value))
    throw new Error(
      `${where} must be a Codex model name (gpt-…); got ${JSON.stringify(value)}. `
      + "A Claude model never reaches a Codex command.",
    );
  return value;
};

export const codexReasoningEffort = (value, where) => {
  if (typeof value !== "string" || !CODEX_EFFORTS.includes(value))
    throw new Error(
      `${where} must be one of ${CODEX_EFFORTS.join(", ")}; got ${JSON.stringify(value)}.`,
    );
  return value;
};

/**
 * The `codex:` sub-block of an `agent:` or `roles.<name>:` entry — the only
 * place a project may pin Codex's own model and effort. Validated here so a
 * typo refuses at config load, not at 3am with a lane already dispatched.
 */
export const codexOverrides = (spec, where) => {
  if (spec === undefined || spec === null) return {};
  if (typeof spec !== "object" || Array.isArray(spec))
    throw new Error(`${where} must be a mapping of Codex settings; got ${JSON.stringify(spec)}.`);
  const out = {};
  if ("model" in spec) out.model = codexModel(spec.model, `${where}.model`);
  if ("reasoningEffort" in spec)
    out.reasoningEffort = codexReasoningEffort(spec.reasoningEffort, `${where}.reasoningEffort`);
  return out;
};

// The keys of an `agent:` block that mean the same thing whoever runs the
// agent. Everything else in that block is Claude's (model, effort,
// permissionMode, bypassPermissions, command) and is dropped under Codex —
// which is what keeps an existing Claude-only config loading for `afk-codex`
// instead of refusing, and keeps its values off the Codex command line.
const BACKEND_NEUTRAL_AGENT_KEYS = ["timeoutMs", "runtime", "maxBuilderRetries"];

const SUPPORTED_COMMANDS = { claude: "claude", codex: "codex" };
export const agentConfig = (config, backend = resolveBackend()) => {
  const resolved = resolveBackend(backend);
  const { codex, ...block } = config.agent || {};
  const agent = resolved === "codex"
    ? {
        ...CODEX_DEFAULT_AGENT,
        ...Object.fromEntries(
          BACKEND_NEUTRAL_AGENT_KEYS.filter((key) => key in block).map((key) => [key, block[key]]),
        ),
        ...codexOverrides(codex, "agent.codex"),
        backend: resolved,
      }
    : { ...DEFAULT_AGENT, ...block, backend: resolved };
  // Under Codex the command is the backend's, never the config's — a project's
  // `agent.command: claude` is a Claude-only config that must still load. This
  // check therefore bites on the Claude path, where the key IS read from the
  // config, and is an invariant on the other.
  if (agent.command !== SUPPORTED_COMMANDS[resolved])
    throw new Error(`This runner supports only agent.command "${SUPPORTED_COMMANDS[resolved]}".`);
  // Fails CLOSED, at load time. A quoted `"2"` or a typo'd `2.5` would compare
  // against an attempt counter by JS coercion and silently give the run a
  // different retry budget than the operator wrote — a wrong number nobody sees
  // until 3am is worse than a refusal before the branch is cut.
  if (!Number.isInteger(agent.maxBuilderRetries) || agent.maxBuilderRetries < 0)
    throw new Error(
      `agent.maxBuilderRetries must be a non-negative integer; got ${JSON.stringify(agent.maxBuilderRetries)}.`,
    );
  return agent;
};

// Keep values supplied by the config as data when the runner builds its
// shell command. In particular, model names and paths must not be able to
// break out of their argument boundaries.
export const shellQuote = (value) =>
  `'${String(value).replaceAll("'", "'\\''")}'`;

// Name a spawned worker after the task it is running, so the OS process list,
// `ps`, and any log scraper can tell which ticket each agent belongs to — the
// two worktree lanes on this machine otherwise show up as identical processes.
export const agentProcessName = (taskId) => `agent-${taskId}`;
export const mergerProcessName = (taskId) => `agent-merge-${taskId}`;

// The shell preamble. `exec -a <name>` sets argv[0] to
// the task label without changing which binary runs; RUNNER_TASK_ID carries the
// same id into the agent's own environment for hooks or tooling that prefer to
// read it there. With no taskId the prefix degrades to just the PATH export, so
// callers that do not name their run (e.g. self-tests) still work unchanged.
//
// `exec -a` is a bash builtin flag, not POSIX, and every caller runs this
// command under `sh -c`. On macOS /bin/sh is bash and accepts it; on Linux
// /bin/sh is usually dash, which reads `-a` as the program to run and exits 127
// before any agent starts. So the naming exec happens inside bash, reached by
// `exec` (same pid, no extra process): bash's $0 is the label, "$@" the agent's
// argv, and the redirections that follow apply to the outer exec and are
// inherited.
//
// The runner's own node directory is APPENDED to PATH, so an agent started from
// a bare environment (launchd, cron) still finds a `node` for its hooks and its
// `#!/usr/bin/env node` shebang. Appended, not prepended: npm installs `claude`
// next to `node`, so a prepended node directory silently replaced whichever
// `claude` the caller's PATH resolves (the one preflight checked, a newer native
// install, a test's fake) with the copy that happens to sit beside node.
const launchPrefix = (nodeBin, taskId, processName) => {
  const path = `export PATH="$PATH:${nodeBin}";`;
  if (taskId === undefined || taskId === null || taskId === "")
    return `${path} `;
  return `${path} export RUNNER_TASK_ID=${shellQuote(taskId)}; exec bash -c 'exec -a "$0" "$@"' ${shellQuote(processName || agentProcessName(taskId))} `;
};

/**
 * The commit an artifact was produced against, or null.
 *
 * Every "reuse the report we already have" path needs this. A cached artifact
 * is only valid for the tree it described, and existence is not that test:
 * epic #23 reused a review of a branch that had since gained both of the
 * commits it was reviewing FOR, and posted "the epic delivered nothing" onto a
 * pull request that had delivered everything.
 */
export const headSha = (root) => {
  const result = run("git rev-parse HEAD", { cwd: root });
  return result.status === 0 ? result.stdout.trim() || null : null;
};

/**
 * The agent invocation, for whichever backend built the `agent` record.
 *
 * `agentConfig` stamps `backend` onto every record it returns, so the
 * dispatcher's choice of executable reaches this builder through the config and
 * not through a flag every caller would have to thread. A record with no
 * `backend` is Claude's — the auth probe and a handful of tests assemble one by
 * hand — and a record naming a backend nobody implements refuses here.
 */
export const buildAgentCommand = (agent, paths) =>
  resolveBackend(agent.backend ?? DEFAULT_BACKEND) === "codex"
    ? codexAgentCommand(agent, paths)
    : claudeAgentCommand(agent, paths);

// Codex's non-interactive JSONL interface. `codex exec` reads the prompt from
// stdin and `--json` emits one JSON object per line, the same shape the stream
// parser already reads. `--ask-for-approval` is a GLOBAL flag and must precede
// the `exec` subcommand. The model and the effort are re-validated here rather
// than trusted from the record: the roles that need extra keys assemble their
// agent by spreading over `roleAgent`'s result, so this is the last point that
// sees the value before it becomes a command line.
const codexAgentCommand = (agent, paths) => {
  const { nodeBin, promptPath, streamPath, taskId, processName, cwd, addDirs = [] } = paths;
  const model = codexModel(agent.model, "the Codex agent's model");
  // Reasoning effort is a Codex config override, not a flag: `-c key=value`
  // parses the value as TOML and falls back to a literal string.
  const effort = shellQuote(
    `model_reasoning_effort=${codexReasoningEffort(agent.reasoningEffort, "the Codex agent's reasoningEffort")}`,
  );
  const sandbox = shellQuote(agent.sandbox || CODEX_DEFAULT_AGENT.sandbox);
  const approval = shellQuote(agent.approvalPolicy || CODEX_DEFAULT_AGENT.approvalPolicy);
  // The working directory is named on the command line, always. Every caller
  // already runs this string with the lane worktree as the shell's cwd, so
  // `"$PWD"` IS that worktree — and a caller that knows the directory as data
  // (herdr, the tests) passes it and gets it quoted literally. `--cd` with no
  // value at all would leave the boundary implicit, which is what makes a lane
  // agent's stray edit land in the wrong checkout.
  const dir = cwd ? shellQuote(cwd) : '"$PWD"';
  // Narrow writable paths beyond the workspace, supplied only by call sites
  // that need them. The verifier gets its scratch report directory. The
  // integrator and fixer get the Git metadata directories they must write when
  // committing from a linked worktree. Keeping these off role and agent records
  // prevents lane builders from inheriting any external writable path.
  const extraDirs = [...new Set(addDirs.filter(Boolean))]
    .map((extra) => ` --add-dir ${shellQuote(extra)}`)
    .join('');
  return (
    `${launchPrefix(nodeBin, taskId, processName)}${shellQuote(agent.command)} --ask-for-approval ${approval} exec --json` +
    ` --model ${shellQuote(model)} -c ${effort} --sandbox ${sandbox}${extraDirs} --skip-git-repo-check --cd ${dir}` +
    ` < ${shellQuote(promptPath)} > ${shellQuote(streamPath)} 2>&1`
  );
};

// Claude Code's non-interactive JSONL interface, assembled in one place so the
// runner and its self-tests cannot drift apart. `-p` with no prompt argument
// reads the task prompt from stdin, and `--output-format stream-json` emits
// one JSON object per line. `--verbose` is required by the CLI for streaming
// JSON under `-p`. Byte-for-byte what it was before the backend split.
const claudeAgentCommand = (agent, paths) => {
  const { nodeBin, promptPath, streamPath, taskId, processName } = paths;
  const access = agent.bypassPermissions
    ? " --dangerously-skip-permissions"
    : ` --permission-mode ${shellQuote(agent.permissionMode || "acceptEdits")}`;
  const effort = agent.reasoningEffort
    ? ` --effort ${shellQuote(agent.reasoningEffort)}`
    : "";
  // `agent.settings` is the role's permission profile as a JSON string (see
  // `roleAgent` in scripts/roles.mjs). It is NOT a per-role flag on this
  // builder — this builder is shared by every role and only forwards whatever
  // profile the role handed it. Absent (self-tests, the auth probe) it adds
  // nothing.
  const settings = agent.settings
    ? ` --settings ${shellQuote(agent.settings)}`
    : "";
  // Only the closeout verifier's one nudge sets it (scripts/verifier.mjs,
  // `endsWaiting`); every other command line is unchanged.
  const resume = agent.resume ? ` --resume ${shellQuote(agent.resume)}` : "";
  // The standing instruction for unattended roles (`roleAgent`). One quoted
  // word however many apostrophes the paragraph carries.
  const append = agent.appendSystemPrompt
    ? ` --append-system-prompt ${shellQuote(agent.appendSystemPrompt)}`
    : "";
  // Every runner agent loads only the MCP servers its own command line names
  // (none, on this runtime), and no Claude-in-Chrome. The operator's servers —
  // a dozen on the measured host, several needing interactive auth — added tool
  // definitions and instructions to every lane's first call, and no role uses
  // them. `--disable-slash-commands` drops every skill: only the auth probe,
  // whose one-word reply needs none, sets it.
  const isolate = ` --strict-mcp-config --no-chrome${agent.disableSlashCommands ? " --disable-slash-commands" : ""}`;
  return (
    `${launchPrefix(nodeBin, taskId, processName)}${shellQuote(agent.command)} -p --output-format stream-json --verbose` +
    `${access}${effort} --model ${shellQuote(agent.model)}${isolate}${settings}${append}${resume}` +
    ` < ${shellQuote(promptPath)} > ${shellQuote(streamPath)} 2>&1`
  );
};

/**
 * Native arguments for an interactive Herdr agent.
 *
 * Herdr owns the `agent start` wrapper, but the words after `--` belong to the
 * provider. Keep that split beside `buildAgentCommand` so direct and
 * interactive launches cannot quietly grow different model, effort or
 * sandbox rules. Claude's long payloads still go to files in the attempt
 * directory. Codex receives only its native flags and the explicit worktree.
 */
export const buildHerdrAgentStartArgs = ({
  name,
  pane,
  agent,
  broker = [],
  launchDir,
  cwd = null,
}) => {
  const file = (base, content) => {
    const path = join(launchDir, base);
    atomicWrite(path, content);
    return path;
  };
  const backend = resolveBackend(agent.backend ?? DEFAULT_BACKEND);
  if (backend === "codex") {
    return [
      "agent", "start", name, "--kind", "codex",
      "--pane", pane, "--timeout", 60_000,
      "--", "--ask-for-approval", agent.approvalPolicy ?? "never",
      "--model", codexModel(agent.model, "the Herdr Codex agent's model"),
      "-c", `model_reasoning_effort=${codexReasoningEffort(agent.reasoningEffort, "the Herdr Codex agent's reasoningEffort")}`,
      // Codex's interactive "Update available" prompt holds the agent at
      // startup; herdr then reports it blocked and the lane never runs.
      "-c", "check_for_update_on_startup=false",
      "--sandbox", agent.sandbox ?? CODEX_DEFAULT_AGENT.sandbox,
      "--cd", cwd ?? ".",
    ];
  }
  const mcp = broker.indexOf("--mcp-config");
  return [
    "agent", "start", name, "--kind", "claude",
    "--pane", pane, "--timeout", 60_000,
    "--", "--dangerously-skip-permissions", "--model", agent.model,
    "--strict-mcp-config", "--no-chrome",
    ...(agent.reasoningEffort ? ["--effort", agent.reasoningEffort] : []),
    ...(agent.settings ? ["--settings", file("claude-settings.json", agent.settings)] : []),
    ...(agent.appendSystemPrompt
      ? ["--append-system-prompt-file", file("append-system-prompt.md", agent.appendSystemPrompt)]
      : []),
    ...broker.map((arg, i) => (mcp !== -1 && i === mcp + 1 ? file("mcp-config.json", arg) : arg)),
  ];
};

// A lane that stops on a text-only turn is not necessarily done: Opus 5.5 ends
// some turns with a progress note. The implementer keeps a checklist (its
// `@@AFK_CHECKLIST_PATH@@`), so an idle lane with unticked items is sent back to
// them. Capped, so a lane that is genuinely stuck still ends and gets reviewed.
export const MAX_CHECKLIST_CONTINUATIONS = 2;

// Unticked Markdown task items (`- [ ] x`, `* [ ] x`, `1. [ ] x`), in order.
// Anything else in the file — prose, headings, ticked items — is not work owed.
export const openChecklistItems = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/.exec(line)?.[1])
    .filter(Boolean);

// The open items at `path` that are worth sending the agent back for, or []
// when there is no checklist to read. A missing or unreadable file keeps the old
// behaviour: the lane is not continued. The role's terminal phase (`Report`) is
// left out: it is ticked by writing the report, which is the text a healthy lane
// ends on, so an open `Report` alone is a finished lane.
export const readOpenChecklistItems = (path, terminalPhase = null) => {
  if (!path) return [];
  let open;
  try { open = openChecklistItems(readFileSync(path, "utf8")); } catch { return []; }
  const terminal = terminalPhase && new RegExp(`^${terminalPhase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return terminal ? open.filter((item) => !terminal.test(item)) : open;
};

// Below this much budget a continuation is not worth sending: the agent would
// need the time to finish the item AND run the checks and report, and one that
// is killed mid-way throws the lane's work away. Five minutes covers a normal
// check run; a quarter of the budget keeps a short lane from never qualifying.
export const continuationFloorMs = (timeoutMs) => Math.min(5 * 60_000, timeoutMs / 4);

export const checklistContinuation = (items) =>
  `Your checklist still has open items: ${items.join("; ")}. Continue with them. If one is blocked, say what is blocking it.`;

// The lane's clock (Opus 5.5 paces itself to a stated budget). Builder and fixer
// lanes are killed at `agent.timeoutMs` with their work thrown away, so the
// agent is shown "elapsed <N>s / <budget>s" after every tool call, by a
// PostToolUse hook reading a start time written here at spawn. Added to the
// role's own `--settings`, which Claude reads on both runtimes. Codex has no
// hooks and is returned untouched.
export const TIME_BUDGET_FILE = "time-budget";
export const TIME_BUDGET_HOOK = resolve(runnerRoot, "scripts", "time-budget-hook.sh");

export const withTimeBudget = (agent, runDir, now = Date.now()) => {
  if ((agent.backend ?? DEFAULT_BACKEND) !== "claude") return agent;
  const file = resolve(runDir, TIME_BUDGET_FILE);
  atomicWrite(file, `${Math.floor(now / 1000)} ${Math.round(agent.timeoutMs / 1000)}\n`);
  const settings = agent.settings ? JSON.parse(agent.settings) : {};
  const hooks = settings.hooks ?? {};
  return {
    ...agent,
    settings: JSON.stringify({
      ...settings,
      hooks: {
        ...hooks,
        PostToolUse: [
          ...(hooks.PostToolUse ?? []),
          { matcher: "", hooks: [{ type: "command", command: `sh ${shellQuote(TIME_BUDGET_HOOK)} ${shellQuote(file)}` }] },
        ],
      },
    }),
  };
};

/**
 * How to undo a failed attempt.
 *
 * `git checkout -- .` only reaches the working tree. An agent can commit its
 * own work, so an attempt that failed or was limit-rejected would leave that
 * commit on the branch, and the retry would then run on top of the very code
 * that just failed. When the agent committed, reset to where HEAD stood before
 * it ran; otherwise keep the cheaper worktree-only discard.
 *
 * `headBefore` must be a resolved sha from before the agent started — passing a
 * ref that has since moved would reset away more than the attempt.
 */
export const discardAttempt = (headBefore, agentCommits = []) =>
  agentCommits.length ? `git reset --hard ${headBefore}` : "git checkout -- .";

// Files the runner itself owns. Agents may not touch them (run.mjs reverts
// them); the orchestrator commits its own bookkeeping files alongside a task.
// Runner implementation lives outside the project. A project's own scripts/
// directory is ordinary task code and must not be mistaken for runner-owned.
export const RUNNER_PREFIXES = [".agent-locks/", ".afk/"];
// `.afk-runs/` is where a lane's `ACTION-REQUIRED.md` rides its branch (the
// verification record itself is a git note since #106); the bare `runs/` is
// kept so branches and history from before the rename are still classified as
// runner-owned, not as an agent's stray edit.
export const BOOKKEEPING_PREFIXES = [".afk-runs/", "runs/", PROGRESS_DIR];
export const BOOKKEEPING_FILES = new Set([
  PROGRESS_FILE,
  ".afk-setup/config.yaml",
  "agent-auto.log",
]);
// Committed, and never an agent's to edit. Two different owners, one rule:
// `.afk-setup/` is the HUMAN's — the config that says how this stack is verified
// and the prompt overrides that instruct the very agents this guards — and
// `docs/progress/` is the RUNNER's, the status tables `flushStatuses` writes. A
// lane has no business in either, and #122 moved the tables out of a single
// file, so a prefix is what keeps them covered. `.afk/` is RUNNER_PREFIXES.
export const PROTECTED_PREFIXES = [".afk-setup/", PROGRESS_DIR];
// The dependency manifests. Exported as their own set because TWO lists have to
// agree about them and used not to: `PROTECTED_FILES` decides what a lane's edit
// gets reverted, and `CHECK_INPUT_FILES` in worker.mjs decides whether that
// revert invalidates the lane's green. A file on the first list and not the
// second produces exactly the lie the first list exists to prevent — the
// manifest is restored and the green still stands, though the checks ran against
// a tree it no longer describes. `bun.lock` was on NEITHER: bun's newer text
// lockfile, unprotected, in two repos (docs-evalapp, voice-studio).
//
// `scripts/lane-forensics.test.mjs` asserts the two sets cannot drift again.
export const MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
export const PROTECTED_FILES = new Set([
  PROGRESS_FILE,
  "agent-auto.log",
  ...MANIFEST_FILES,
]);
// `planning/` stays protected even though the runner no longer keeps task files
// there: it costs nothing, and a consuming project may still hold planning
// documents a builder has no business rewriting.
// `.claude/` is the PROJECT's — its settings, its skills, its permission rules.
// A builder has no business rewriting the configuration that governs builders,
// and the runner's own `.claude/settings.local.json` preflight is cleaned up by
// runtime-herdr rather than committed. This entry is defence in depth: the herdr
// runtime once deleted the whole directory on lane teardown and every lane
// committed the deletion of a tracked `.claude/settings.json` (docs/findings.md
// 3.11). That cause is fixed; this makes the class of bug non-committable.
//
// Lives here rather than in worker.mjs because two callers need the same list:
// the worker reverts these paths after a lane runs, and `afk validate` refuses a
// ticket whose acceptance criteria require editing one before the lane starts.
export const isProtectedPath = (file) =>
  isRunnerOwned(file) ||
  PROTECTED_FILES.has(file) ||
  PROTECTED_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
  file.startsWith("planning/") ||
  file.startsWith(".claude/") ||
  file === "AGENTS.md" ||
  file === "PLANNER.md";

// --- protected-path edits a builder may legitimately make -------------------
// The revert stops a builder rewriting dependency manifests, lockfiles and the
// human-owned config. It was also reverting the one edit a builder MUST make to
// wire its own tests into the gate: `package.json`'s `scripts` block. Four of
// six live epics shipped a green run over a test file that never executed
// because of it — the builder wrote the file, wired it in, the runner silently
// undid the wiring, and the OLD suite chain reported green.
//
// So the rule narrows by JSON key, not by file: an edit that touches ONLY the
// named top-level keys of a protected JSON file survives; one that also moves
// `dependencies`, `devDependencies`, a version or any other key is reverted
// exactly as before. Lockfiles have no entry in this map and stay whole.
//
// Configurable per project, in `.afk-setup/config.yaml`, because the protected
// list above has no other config surface at all:
//
//   protectedEdits:
//     package.json: [scripts]
//
// The default below applies when the config says nothing, so the fix reaches a
// project that never edits its config.
export const DEFAULT_PROTECTED_EDITS = { "package.json": ["scripts"] };

export const isBookkeeping = (f, config = {}) =>
  BOOKKEEPING_FILES.has(f) ||
  [...BOOKKEEPING_PREFIXES, ...(config.bookkeepingPrefixes || [])].some((p) =>
    f.startsWith(p),
  );
export const isRunnerOwned = (f) =>
  RUNNER_PREFIXES.some((p) => f.startsWith(p));

// Covers the paths `flushStatuses` (scripts/auto.mjs) stages after every merge:
// the progress table, the integration verification behind each verdict, and the
// ledger under `.afk/`. Kept here rather than beside `flushStatuses` because
// `markStaleEvidence` in verifier.mjs is the other reader and must not import
// the orchestrator; `flushStatuses` carries a pointer back to this list.
//
// A deliberate SUPERSET on the prefixes, not the exact filenames. All of
// `.afk-runs/**` (and the pre-rename `runs/**`) and `.afk/**`: history from
// before #106 carries `verification.json` and `integration-verification.json`
// under them, a lane still commits `ACTION-REQUIRED.md` there, and a commit
// whose whole diff is runner artifacts is a commit that changed nothing a
// reviewer read either way. Naming the files would leave the caveat firing on
// those.
//
// And deliberately NARROWER than `isBookkeeping`, which also admits
// `.afk-setup/config.yaml` — a config edit changes HOW the gates run, so a
// commit carrying one is not a commit that changed nothing a reviewer read.
export const isStatusFlushPath = (f) =>
  f === PROGRESS_FILE ||
  f.startsWith(PROGRESS_DIR) ||
  f.startsWith(".afk-runs/") ||
  f.startsWith("runs/") ||
  f.startsWith(".afk/");

/**
 * Does `head` still hold what `recorded` held, for anyone who does not read the
 * runner's own bookkeeping? True when they are the same commit, or when every
 * commit between them touches only `isStatusFlushPath` paths. `flushStatuses`
 * commits the progress table after every verdict, so a strict sha comparison
 * says "moved" after every run that decided anything — the same trap
 * `markStaleEvidence` in verifier.mjs already steps around.
 *
 * `--no-renames`, because `--name-only` otherwise names only a rename's
 * destination, and moving `src/a.js` into `.afk/` would read as bookkeeping.
 *
 * Fails closed, toward "moved": no sha on either side, `recorded` not an
 * ancestor of `head`, a `git log` that could not run, or a commit whose paths it
 * did not list (a merge lists none).
 *
 * `exec` is the git runner, injectable like `findEpicPr`'s in scripts/pr.mjs.
 */
export const onlyStatusFlushSince = (root, recorded, head, inert = isStatusFlushPath, exec = run) => {
  if (!recorded || !head) return false;
  if (recorded === head) return true;
  if (exec(`git merge-base --is-ancestor ${shellQuote(recorded)} ${shellQuote(head)}`, { cwd: root }).status !== 0) {
    return false;
  }
  const listed = exec(`git log --no-renames --format=tformat:@commit --name-only ${shellQuote(`${recorded}..${head}`)}`, { cwd: root });
  if (listed.status !== 0) return false;
  const commits = listed.stdout.split("@commit").slice(1)
    .map((chunk) => chunk.split("\n").map((line) => line.trim()).filter(Boolean));
  return commits.length > 0 && commits.every((files) => files.length > 0 && files.every(inert));
};

/**
 * Is the stored closeout review still a review of this branch? Yes when it
 * read the head, or a commit the head differs from only by the runner's own
 * status commits. Without the second half, accepting a gate (which commits
 * the progress table) made every review stale the moment it was signed over.
 *
 * The one test both `--accept` (scripts/auto.mjs) and the `review-at-head`
 * merge guardrail (scripts/merge-guards.mjs) apply. Fails closed: no review, a
 * review that did not run (`skipped`), or no head reads as "not current".
 *
 * @param {object|null} verifier `state.epicClose.verifier`
 */
export const reviewIsCurrentAt = (root, verifier, head, exec = run) => Boolean(verifier && !verifier.skipped
  && onlyStatusFlushSince(root, verifier.head ?? null, head ?? null, isStatusFlushPath, exec));

// --- Rust gate skipping -----------------------------------------------------
// The three Rust checks (`rust:fmt:check`, `rust:clippy`, `rust:test`) are the
// runner's CPU spike — several minutes each — and on a frontend-only ticket they
// prove only that no Rust changed. Skip them when the run's change set contains
// no Rust, and NEVER skip anything else.

// Rust-relevant: anything under src-tauri/, plus a Cargo manifest or lockfile
// wherever it lives (a workspace member can carry its own).
export const isRustPath = (file) =>
  file.startsWith("src-tauri/") || /(^|\/)Cargo\.(toml|lock)$/.test(file);

// Matched on the command text, not on an index into task.checks: projects spell
// the gates as npm scripts, and a task may list them in any order.
export const isRustCheck = (command) =>
  /\brust:(fmt|clippy|test)\b|\bcargo\b/.test(String(command));

// Fail SAFE toward running. A change set that is not an array, is empty, or is
// unknown for any reason means "run the checks" — a skipped gate must only ever
// follow from positive evidence that nothing Rust was touched.
export const shouldSkipRustChecks = (changedFiles) =>
  Array.isArray(changedFiles) &&
  changedFiles.length > 0 &&
  !changedFiles.some(isRustPath);

// The baseline's wider notion of Rust-relevant (#176 W3). A baseline skips the
// Rust checks over the diff from the last green baseline, so it also counts what
// changes a Rust build without being Rust source: cargo's own config, the
// toolchain pin, any file a `rust:*` package script names (a sidecar build
// script), and the text of the `rust:*` scripts themselves. `scriptsBefore` and
// `scriptsAfter` are `package.json`'s `scripts` at each end; null when it could
// not be read, which fails toward running when `package.json` is in the diff.
//
// Deliberately NOT folded into `isRustPath`: lanes keep their own narrower skip,
// and integration runs every check either way, which is the backstop for what
// both lists miss — a file reached only through a script's own imports.
const rustScriptEntries = (scripts) =>
  Object.entries(scripts ?? {}).filter(([name]) => name.startsWith("rust:")).sort(([a], [b]) => a.localeCompare(b));

// Every token a `rust:*` script carries, as a repo-relative path. Over-inclusive
// on purpose — a token that is not a file never matches a changed path.
const rustScriptPaths = (scripts) => new Set(rustScriptEntries(scripts)
  .flatMap(([, text]) => String(text).split(/[\s;&|=()'"`]+/))
  .filter(Boolean)
  .map((token) => token.replace(/^\.\//, "")));

export const baselineRustRelevant = ({ changed, scriptsBefore, scriptsAfter }) => {
  const named = new Set([...rustScriptPaths(scriptsBefore), ...rustScriptPaths(scriptsAfter)]);
  if (changed.some((file) => isRustPath(file)
    || /(^|\/)\.cargo\//.test(file)
    || /(^|\/)rust-toolchain(\.toml)?$/.test(file)
    || named.has(file))) return true;
  if (!changed.includes("package.json")) return false;
  if (!scriptsBefore || !scriptsAfter) return true;
  return JSON.stringify(rustScriptEntries(scriptsBefore)) !== JSON.stringify(rustScriptEntries(scriptsAfter));
};

// A skipped check is recorded with `skipped: true` and `code: null` — never
// `code: 0`, which would claim clippy passed when it never ran. Anything looking
// for failures must go through this, because `null !== 0` is true.
export const checkFailed = (check) => !check.skipped && check.code !== 0;

// A check with no timeout can hang a lane until a human wakes up. quillnote v1
// lost six hours to exactly this: a closeout-authored test ran NSAppleScript
// under `swift test`, macOS raised a TCC consent dialog, and the suite sat
// behind a GUI prompt nobody was there to click. `runAsync` has always
// supported a timeout; neither check call site passed one.
//
// 30 minutes, matching the factory config's `agent.timeoutMs`. Deliberately not
// 10: a cold `xcodebuild` lane pays for a full Swift compile before the first
// test runs, and a bound that kills honest work is a bound an operator turns
// off.
export const DEFAULT_CHECK_TIMEOUT_MS = 30 * 60_000;

// Fail SAFE toward a bound. Anything that is not a positive number — key
// absent, a typo, a string, an explicit 0 — takes the default rather than
// being passed through, because `runAsync` reads 0 as "arm no timer at all",
// which is the hang this exists to stop. A project that genuinely wants a
// longer check sets a bigger number.
export const checkTimeoutMs = (config = {}) => {
  const value = config?.checkTimeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CHECK_TIMEOUT_MS;
};

// What `timeout(1)` reports for a command it killed, borrowed here because the
// runner IS the timeout wrapper. A killed process has no exit status of its own
// (`runAsync` resolves `status: null` on SIGTERM), and recording that null would
// hide the timeout from every reader that asks `code !== 0` and excludes null to
// skip a skipped check — supervisor.mjs does exactly that. So the timeout reads
// as a failure to everything, and `timedOut` says which kind of failure it was.
export const CHECK_TIMEOUT_EXIT_CODE = 124;

// One record shape for both check call sites — the builder's in worker.mjs and
// the post-merge gate's in integrate.mjs. They ran the same three lines
// separately and drifted: only one of them ever grew a timeout.
export const checkResult = (command, result, timeoutMs) => ({
  command,
  code: result.timedOut ? CHECK_TIMEOUT_EXIT_CODE : result.status,
  ...(result.timedOut ? { timedOut: true, timeoutMs } : {}),
  output: `${result.stdout}${result.stderr}`,
  // Timing for scripts/measure.mjs (#181); absent from a result built by hand.
  ...(result.startedAt ? { startedAt: result.startedAt, durationMs: result.durationMs, load1: result.load1 } : {}),
});

// A timed-out check must not read as a red one. `check failed: swift test` sends
// a human, a retry lane and the closeout looking for a broken assertion; the
// bound that fired is the thing they need to see instead.
export const checkFailureReason = (check) =>
  check.timedOut
    ? `check timed out after ${Math.round(check.timeoutMs / 1000)}s: ${check.command}`
    : `check failed: ${check.command}`;

export { existsSync };

// ---------------------------------------------------------------------------
// Collapsible markdown. One helper, because four renderers need the same shape
// and GitHub is unforgiving about it.
// ---------------------------------------------------------------------------

/**
 * A `<details>` block whose SUMMARY carries the finding, not just a label.
 *
 * An epic closeout runs to hundreds of lines — a 48-criterion table, two
 * findings lists, a task table — and the reader who needs one number scrolls
 * past all of it. Collapsing is only safe if the collapsed state still answers
 * the question, so every caller passes counts and a verdict in `summary`: a
 * reader who never expands anything must still be able to say what happened.
 *
 * Two GitHub constraints are handled here rather than at each call site:
 * markdown inside `<details>` only renders when a BLANK LINE follows the
 * `</summary>`, and a nested `<details>` needs the same. Getting either wrong
 * shows the reader raw HTML, which is worse than not collapsing at all.
 *
 * `open` exists for the blocks that must not be hidden — the must-fix list is
 * the whole point of a closeout, and a fix pass that fell over has to be
 * visible without a click.
 */
export const details = ({ summary, body, open = false }) => {
  const content = String(body ?? "").trim();
  if (!content) return "";
  return [`<details${open ? " open" : ""}>`, `<summary>${summary}</summary>`, "", content, "", "</details>"].join("\n");
};

// ---------------------------------------------------------------------------
// The task DAG as a picture. GitHub renders exactly one diagram format in a
// PR body or an issue comment — a ```mermaid fence — and strips inline SVG and
// every HTML artifact, so this is the only visual channel the runner has.
// ---------------------------------------------------------------------------

/**
 * How a lifecycle is drawn. Colours are GitHub's own light-mode status palette,
 * which is legible against both themes; the emoji carries the same information
 * for anyone reading the raw markdown, a colourblind reader, or a client that
 * renders the fence as text.
 */
const GRAPH_STYLE = {
  passed: { mark: "✅", class: "ok" },
  "no-op": { mark: "✅", class: "ok" },
  failed: { mark: "❌", class: "bad" },
  integration_failed: { mark: "❌", class: "bad" },
  blocked: { mark: "⛔", class: "bad" },
  // The literal, not the import: `AWAITING_ACCEPTANCE` is owned by
  // scripts/scheduler.mjs, which imports this file. `ready` above already
  // spells its lifecycles the same way, for the same reason.
  awaiting_acceptance: { mark: "⏳", class: "wait" },
  pending: { mark: "·", class: "idle" },
};

/**
 * Mermaid label text is not markdown and not HTML-escaped for us.
 *
 * Three characters break the parse and one breaks it subtly: a double quote
 * ends the label, a backtick opens Mermaid's own code span, `#` begins an
 * entity code (`#quot;`) so `#666` can swallow the digits after it, and a
 * newline ends the statement. Everything else survives inside quotes.
 */
const graphLabel = (text, limit = 44) => {
  const flat = String(text ?? "").replace(/[\r\n]+/g, " ").replace(/["`#]/g, "").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

/**
 * The epic's tasks and their edges as a Mermaid flowchart.
 *
 * This REPLACES the tasks table rather than sitting above it — a diagram added
 * to a document that already had a table makes the document longer, which is
 * the opposite of the point. The table stays, collapsed, for the reader who
 * wants the dependency ids as text.
 *
 * What the picture says that the table could not: which failure blocked which
 * sibling. Epic #665's table showed 666 failed and 669 blocked as two
 * independent rows; the edge between them is the whole story of that run.
 *
 * Returns "" for an empty DAG, so a caller can push it unguarded.
 *
 * @param {object} dag normalised DAG
 * @param {object} state runtime state
 */
/**
 * The graph, expanded when it earns the space and folded when it does not.
 *
 * Measured on GitHub (owner/gitproj-demo#63, 2026-09-19): a Mermaid fence
 * renders in a `viewscreen.githubusercontent.com` iframe that auto-sizes to its
 * content, and the height scales with fan-out — 198px for epic #671's two
 * tasks, 345px for #203's five, and **662px for #654's seven**, where one task
 * fans out to five. The table it replaced was nine lines. So on a wide epic the
 * picture costs about 450px more than the thing it replaced.
 *
 * That trade is worth it exactly when there is a failure to trace: #665's
 * "666 failed, therefore 669 blocked" is one glance in the graph and two
 * unrelated rows in the table. It is not worth it when every task passed — a
 * 662px picture of seven green boxes is the opposite of the brevity this whole
 * change is for.
 *
 * So: expanded when anything did not pass, folded behind its own summary when
 * everything did. The reader who wants the clean epic's shape is one click away.
 */
export const renderTaskGraphSection = (dag, state = {}) => {
  const graph = renderTaskGraph(dag, state);
  if (!graph) return "";
  const tasks = dag?.tasks ?? [];
  const clean = tasks.every((task) => ["passed", "no-op"].includes(lifecycleOf(task, state)));
  if (!clean) return graph;
  return details({
    summary: `Task graph — ${tasks.length} task${tasks.length === 1 ? "" : "s"}, all passed`,
    body: graph,
  });
};

export const renderTaskGraph = (dag, state = {}) => {
  const tasks = dag?.tasks ?? [];
  if (!tasks.length) return "";
  const id = (value) => `t${String(value).replace(/[^A-Za-z0-9_]/g, "_")}`;
  const known = new Set(tasks.map((task) => String(task.id)));
  const nodes = [];
  const edges = [];
  const classes = [];
  for (const task of tasks) {
    const lifecycle = lifecycleOf(task, state);
    const style = GRAPH_STYLE[lifecycle] ?? GRAPH_STYLE.pending;
    const gate = `${task.humanGated ? " 🔒" : ""}${task.gateAfter ? " 🧾" : ""}`;
    nodes.push(`  ${id(task.id)}["${style.mark} ${graphLabel(task.id, 12)}: ${graphLabel(task.title)}${gate}"]`);
    classes.push(`  class ${id(task.id)} ${style.class}`);
    // An edge to a task outside this DAG would draw a phantom node with no
    // status, which reads as a task that never ran rather than one that is not
    // part of this epic. Cross-epic edges belong in the ticket, not here.
    for (const dep of task.dependsOn ?? [])
      if (known.has(String(dep))) edges.push(`  ${id(dep)} --> ${id(task.id)}`);
  }
  return [
    "```mermaid",
    "flowchart LR",
    ...nodes,
    ...edges,
    "  classDef ok fill:#dafbe1,stroke:#2da44e,color:#1a7f37",
    "  classDef bad fill:#ffebe9,stroke:#cf222e,color:#a40e26",
    "  classDef wait fill:#fff8c5,stroke:#bf8700,color:#7d4e00",
    "  classDef idle fill:#f6f8fa,stroke:#8c959f,color:#57606a",
    ...classes,
    "```",
  ].join("\n");
};
