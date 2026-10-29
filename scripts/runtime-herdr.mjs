// Herdr runtime: run builders (and the merger) as interactive claude sessions
// inside herdr panes instead of headless subprocesses. AFK still owns
// scheduling, worktrees, verification, and integration; herdr is execution +
// visibility.
//
// Completion is layered (docs/herdr-plan.md): herdr agent state is only the
// wake-up signal; the authoritative signal is the report file the agent
// writes via scripts/report.mjs; the verifier remains the truth. Herdr waits
// are always bounded — the CLI itself can wait forever.
//
// The session transcript claude writes under ~/.claude/projects/<cwd-slug>/
// is polled as a side channel: per-lane token spend, a second freshness
// signal, and fast detection of auth death (an expired OAuth session shows
// up there long before any timeout would fire).
import { execFile } from 'node:child_process';
import { accessSync, appendFileSync, constants, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, buildHerdrAgentStartArgs, checklistContinuation, continuationFloorMs, looksLikeAuthDeath, MAX_CHECKLIST_CONTINUATIONS, notify as baseNotify, readOpenChecklistItems, resolveBackend, run } from './lib.mjs';
import { preflightSettings } from './roles.mjs';
import { permissionBrokerArgs } from './permission-broker.mjs';

const exec = promisify(execFile);
const runnerDir = dirname(dirname(fileURLToPath(import.meta.url)));

const POLL_MS = 5_000;
const TRANSCRIPT_EVERY_TICKS = 6; // ~30s
export const HERDR_STOP_TIMEOUT_MS = 5_000;
// An idle agent that never reported: give it time to type the report command,
// then fall through to verification — the branch is the truth anyway.
const IDLE_UNREPORTED_MS = 90_000;
// blocked is a human gate, not a failure; extend the deadline once, loudly.
const BLOCKED_EXTRA_MS = 45 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const herdr = async (...args) => {
  try {
    const { stdout } = await exec('herdr', args.map(String));
    try { return JSON.parse(stdout); } catch { return stdout; }
  } catch (err) {
    // execFile buries herdr's JSON error on stderr; surface it.
    const detail = (err.stderr || err.stdout || '').trim().slice(0, 300);
    throw new Error(`herdr ${args[0]} ${args[1] ?? ''}: ${detail || err.message}`);
  }
};

// terminal-notifier does not run a click's `-execute` in the runner's shell: it
// hands it to /bin/sh with launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// `herdr` lives in ~/.local/bin, which is not on it, so a bare `herdr` in the
// command resolved to nothing and every click since this shipped did nothing,
// silently — a failing click is indistinguishable from an inert one. Resolve
// the same binary `exec('herdr', ...)` above would find, once.
const herdrBin = (() => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'herdr');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  // Deliberately null, not a bare 'herdr'. Falling back to the bare name would
  // rebuild the exact command this exists to replace, and ship a click that
  // dies in silence — which the rest of this file already calls worse than a
  // click that does nothing.
  return null;
})();

// The workspace id is interpolated into a shell string, never into a
// filesystem path, so the bar is "cannot end the command", not "is a real id".
const isShellToken = (value) => /^[A-Za-z0-9._-]+$/.test(String(value ?? ''));

/**
 * The extra half of a LANE click: focus the workspace that raised it.
 *
 * Raising the terminal is not here — `notify()` in lib.mjs does that for every
 * notification the runner sends, because every one of them means "come and
 * look". This is the part only a lane can offer: which workspace to land in
 * once the window is up. A click with only the raise leaves you in herdr but
 * on whatever workspace you left it on.
 *
 * Null when there is nothing safe to attach: a `--runtime=direct` lane has no
 * workspace, and an unresolvable herdr has no command worth shipping.
 */
export const laneClick = (workspaceId) =>
  (herdrBin && isShellToken(workspaceId)
    ? `${herdrBin} workspace focus ${workspaceId}`
    : null);

/**
 * A lane notification, clickable straight into the pane that raised it.
 *
 * `workspaceId` is optional and the click is attached only when it is present:
 * a `--runtime=direct` lane has no workspace, and `herdr workspace focus
 * undefined` on click is worse than an inert notification.
 *
 * `taskId` is the TICKET number, not the lane key. A task is worked by two
 * lanes in sequence — the builder (`15`) and the integrator (`merge-15`) — and
 * keying the group on the lane meant one ticket could leave two live
 * notifications. Grouping on the ticket keeps the invariant the group exists
 * for: one ticket, one notification, saying the latest thing.
 */
export const notify = (message, {
  workspaceId = null,
  subtitle = null,
  taskId = null,
  root = process.cwd(),
  // The event name, not a severity. `NOTIFY_ONLY` in lib.mjs decides which of
  // these still interrupts; by default only `lane_blocked` does.
  kind = null,
} = {}) =>
  baseNotify({
    kind,
    title: `AFK runner — ${root.split('/').filter(Boolean).pop() ?? 'repo'}`,
    subtitle,
    message,
    // Not a parameter. Every lane notification means the lane has stopped and
    // wants a human, so there is no severity to choose — and a `level` knob
    // here is how the routine traffic got in the first time.
    level: 'error',
    group: taskId ? `afk-lane-${taskId}` : null,
    execute: laneClick(workspaceId),
  });

// --- naming: the epic is what the operator recognises in the sidebar --------
// Optional `epic: { id, title }` on the DAG, which the orchestrator records in
// `.afk/state.json`. Every visible name derives from it, so a glance at the
// agent panel answers "which epic, which ticket". Read per call (cheap, and
// state is rewritten constantly during a run); absent epic falls back to the
// pre-epic naming.
const epicOf = (root) => {
  try {
    const { dag } = JSON.parse(
      readFileSync(resolve(root, '.afk', 'state.json'), 'utf8'));
    return dag?.epic?.id ? dag.epic : null;
  } catch { return null; }
};
// The sidebar is narrow, so every wasted character costs a real word of the
// ticket name. An epic issue is conventionally titled "Epic: <thing>", and
// inside a panel where every row IS an epic that prefix says nothing — drop it.
const cleanTitle = (title) =>
  String(title ?? '').replace(/^\s*epic\s*[:\u2014-]\s*/i, '').trim();

// Truncate on a word boundary. Left to herdr the cut lands mid-word at whatever
// the pane width happens to be; doing it here means the operator always sees
// whole words and a predictable ellipsis.
const LABEL_BUDGET = 38;
const clip = (text) => {
  if (text.length <= LABEL_BUDGET) return text;
  const cut = text.slice(0, LABEL_BUDGET);
  const space = cut.lastIndexOf(' ');
  return `${(space > LABEL_BUDGET / 2 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
};

export const parentLabel = (root) => {
  const epic = epicOf(root);
  if (!epic) return basename(root);
  const title = cleanTitle(epic.title) || basename(root);
  return clip(`#${epic.id} · ${title}`);
};
export const laneLabel = (root, task) => {
  const epic = epicOf(root);
  // The epic prefix stays: the agents panel is flat, so a bare `#4` there does
  // not say which run it belongs to.
  return clip(`${epic ? `${epic.id}/` : ''}#${task.id} · ${cleanTitle(task.title)}`);
};

// --- lane registry (.afk/herdr.json): which workspace/pane hosts which task -
const registryPath = (root) => resolve(root, '.afk', 'herdr.json');
const loadRegistry = (root) => {
  try { return JSON.parse(readFileSync(registryPath(root), 'utf8')); }
  catch { return { parentWorkspaceId: null, parentPaneId: null, tasks: {} }; }
};
const saveRegistry = (root, registry) =>
  atomicWrite(registryPath(root), `${JSON.stringify(registry, null, 2)}\n`);

// Parallel lanes adopt concurrently; serialize read-modify-write on the
// registry file so one lane's save cannot clobber another's.
let registryTurn = Promise.resolve();
const withRegistry = (root, fn) => {
  const turn = registryTurn.then(() => fn(loadRegistry(root)));
  registryTurn = turn.catch(() => {});
  return turn;
};

const paneAlive = async (paneId) => {
  try { await herdr('pane', 'rename', paneId, '--clear'); return true; }
  catch { return false; }
};

/**
 * The repo's MAIN checkout, which is `root` unless `root` is a linked worktree.
 *
 * herdr refuses `worktree open` whenever the source it resolves is a linked
 * worktree — `{"code":"linked_worktree_source","message":"New and open worktree
 * actions start from the repo parent workspace."}`. Measured: the refusal is
 * about the SOURCE, not the lane. The identical lane path opens fine from a
 * main-checkout source and is refused from a linked-worktree one, whichever
 * worktree the lane itself was created in. That single rule cost six lanes on
 * brightpath #9 (docs/reflection/brightpath/epic-9.md), and it is why an epic
 * could not run from its own worktree.
 *
 * `--git-common-dir` is absolute from a linked worktree and `.git` from the
 * main checkout, so resolve it against `root` before taking the parent. A bare
 * or unreadable repo falls back to `root`: herdr will refuse as before, which
 * is no worse than today and better than guessing a path that does not exist.
 */
export const mainCheckout = (root) => {
  const result = run('git rev-parse --git-common-dir', { cwd: root });
  if (result.status !== 0) return root;
  const common = resolve(root, result.stdout.trim());
  return basename(common) === '.git' ? dirname(common) : root;
};

const createParent = async (root, registry) => {
  const res = await herdr('workspace', 'create', '--cwd', root,
    '--label', parentLabel(root), '--no-focus');
  registry.parentWorkspaceId = res.result.workspace.workspace_id;
  registry.parentPaneId = res.result.root_pane.pane_id;
  saveRegistry(root, registry);
};

const adoptExistingParent = async (root, registry) => {
  let workspaces;
  try {
    const res = await herdr('workspace', 'list');
    workspaces = (res.result?.workspaces ?? [])
      .filter((candidate) => candidate.label === parentLabel(root));
  } catch {
    // Listing is a compatibility probe. If it is unavailable, the create path
    // below preserves the pre-list behaviour and lets Herdr report its error.
    return false;
  }
  // FAIL CLOSED: a matching label is not identity. Herdr's workspace list is
  // session-wide, so inspect each candidate's panes and adopt only one rooted
  // in this checkout. Refusing an ambiguous or unreadable candidate costs a
  // sibling workspace; adopting another repository sends the merger to the
  // wrong tree.
  const expected = resolve(root);
  for (const workspace of workspaces) {
    if (!workspace?.workspace_id) continue;
    let listed;
    try {
      listed = await herdr('pane', 'list', '--workspace', workspace.workspace_id);
    } catch { continue; }
    const panes = listed.result?.panes ?? [];
    const rooted = panes.filter((pane) => resolve(pane.cwd ?? '') === expected);
    const pane = rooted.find(({ tab_id }) => tab_id === workspace.active_tab_id)
      ?? rooted[0];
    if (!pane?.pane_id) continue;
    registry.parentWorkspaceId = workspace.workspace_id;
    registry.parentPaneId = pane.pane_id;
    saveRegistry(root, registry);
    return true;
  }
  return false;
};

const ensureParentWorkspace = async (root, registry) => {
  // Registries written before parentPaneId existed cannot host the merger;
  // rebuild the parent workspace once.
  if (registry.parentWorkspaceId && !registry.parentPaneId) {
    try { await herdr('workspace', 'close', registry.parentWorkspaceId); } catch {}
    registry.parentWorkspaceId = null;
  }
  if (!registry.parentWorkspaceId) {
    // The registry is disposable launch state. Herdr survives a driver
    // restart, so adopt the exact-label workspace before creating a sibling.
    if (!await adoptExistingParent(root, registry)) await createParent(root, registry);
  }
  // A workspace opened before the epic was named (or under the previous epic)
  // keeps its old label otherwise — relabel is idempotent and cheap.
  else try {
    await herdr('workspace', 'rename', registry.parentWorkspaceId, parentLabel(root));
  } catch {}
  return registry.parentWorkspaceId;
};

// Adopt an AFK-created worktree as a herdr workspace grouped under the repo
// workspace. Retries reuse the lane's existing pane (scrollback is evidence).
const adoptLane = ({ root, task, worktree }) => withRegistry(root, async (registry) => {
  const existing = registry.tasks[task.id];
  if (existing && await paneAlive(existing.paneId)) {
    await herdr('pane', 'rename', existing.paneId, laneLabel(root, task));
    // The sidebar row shows the workspace label, not the pane title: a retry
    // must relabel both or it keeps the name it was opened under.
    if (existing.workspaceId) try {
      await herdr('workspace', 'rename', existing.workspaceId, laneLabel(root, task));
    } catch {}
    return existing;
  }
  // `--cwd` names the SOURCE herdr resolves the repo from, not the group the
  // lane lands in — sidebar grouping comes from the repo herdr resolves, and
  // every lane of this repo resolves to the same one. It must be the main
  // checkout: an epic running from its own worktree would otherwise hand herdr
  // a linked worktree and be refused. (`--workspace` and `--cwd` are mutually
  // exclusive in herdr 0.8, so this replaces the id rather than joining it.)
  const open = async () => herdr('worktree', 'open', '--path', worktree,
    '--cwd', mainCheckout(root),
    '--label', laneLabel(root, task), '--no-focus');
  // The parent workspace hosts the integrator, not the lanes. Ensure it exists
  // and carries this epic's label while we are here, but never fail a lane over
  // it — `parentPane` builds it on demand if this did not.
  try { await ensureParentWorkspace(root, registry); } catch {}
  const res = await open();
  const lane = {
    workspaceId: res.result?.workspace?.workspace_id
      ?? res.result?.worktree?.workspace_id,
    paneId: res.result?.root_pane?.pane_id ?? res.result?.workspace?.root_pane?.pane_id,
    // What a parent rebuild needs to re-open this lane somewhere safe. The ids
    // alone do not say which worktree the pane belongs to.
    worktree,
    label: laneLabel(root, task),
  };
  if (!lane.paneId) throw new Error(`herdr worktree open returned no pane id: ${JSON.stringify(res)}`);
  registry.tasks[task.id] = lane;
  saveRegistry(root, registry);
  return lane;
});

const parentPane = (root, say) => withRegistry(root, async (registry) => {
  if (registry.parentPaneId && await paneAlive(registry.parentPaneId))
    return registry.parentPaneId;
  registry.parentWorkspaceId = null;
  registry.parentPaneId = null;
  await ensureParentWorkspace(root, registry);
  say(`HERDR: parent workspace ${registry.parentWorkspaceId} (re)created for the integrator.`);
  return registry.parentPaneId;
});

// A lane rescue is a courtesy, not a gate: a lane that will not answer must not
// be able to hold integration hostage, so the whole rescue runs under one
// budget and the rebuild continues when it expires. Rebuild-and-re-adopt, never
// wait-forever — a stalled integration is the worse error.
const LANE_RESCUE_MS = 10_000;

/**
 * Re-open every live lane against the parent workspace we have just built, so
 * that closing the old one cannot take a working builder with it.
 *
 * Epic #27's lane 37: `parent workspace <id> rebuilt for the integrator` was
 * followed one line later by `lane 37 agent process died`. Lane workspaces are
 * grouped under the parent, so the rebuild reaped a builder that had already
 * written its files and spent 12k output tokens. Two of those tripped the
 * circuit breaker on a ticket that then passed in three minutes, untouched.
 *
 * Never throws: a failed rescue is a lane we were going to lose anyway.
 *
 * WHAT THE TESTS PROVE, AND WHAT THEY DO NOT. The two cases in
 * scripts/herdr-handshake.test.mjs prove the ordering — the replacement parent
 * is built and the live lanes re-opened onto it BEFORE the old workspace is
 * closed — and the non-blocking degradation: a lane that never answers expires
 * against `rescueMs` and the rebuild continues. Both assert against a recorded
 * `herdr` command sequence from a fake binary on PATH. They do NOT prove that a
 * real herdr session's lane panes survive an integrator rebuild: nothing on this
 * branch drives a live herdr. That needs a live run under `--runtime=herdr` with
 * a lane mid-flight, and it remains a human check after this branch merges.
 */
const readoptLanes = async (root, registry, rescueMs) => {
  const lanes = Object.entries(registry.tasks ?? {})
    // A registry written before lanes recorded their worktree cannot be
    // re-adopted — there is nothing to re-open. Old runs lose what they lost.
    .filter(([, lane]) => lane?.paneId && lane?.worktree);
  if (!lanes.length) return;
  const rescue = (async () => {
    for (const [id, lane] of lanes) {
      try {
        if (!await paneAlive(lane.paneId)) continue;
        const res = await herdr('worktree', 'open', '--path', lane.worktree,
          '--cwd', mainCheckout(root),
          '--label', lane.label ?? basename(lane.worktree), '--no-focus');
        const workspaceId = res.result?.workspace?.workspace_id
          ?? res.result?.worktree?.workspace_id;
        const paneId = res.result?.root_pane?.pane_id
          ?? res.result?.workspace?.root_pane?.pane_id;
        // Only adopt ids herdr actually handed back: half a lane in the
        // registry is worse than the one we already had.
        if (workspaceId && paneId) registry.tasks[id] = { ...lane, workspaceId, paneId };
      } catch {}
    }
  })();
  await Promise.race([rescue.catch(() => {}), sleep(rescueMs)]);
};

// Give up the parent workspace entirely and build a new one. `parentPane`
// keeps a pane that merely *exists*; this is for a pane that exists and cannot
// host an agent, where the only way forward is a pane we have never used.
//
// Order matters and is the whole fix: build the replacement, move the live
// lanes onto it, and only then close the workspace they used to hang from.
export const recreateParent = (root, say, { rescueMs = LANE_RESCUE_MS } = {}) =>
  withRegistry(root, async (registry) => {
    const doomed = registry.parentWorkspaceId;
    registry.parentWorkspaceId = null;
    registry.parentPaneId = null;
    await createParent(root, registry);
    await readoptLanes(root, registry, rescueMs);
    if (doomed) try { await herdr('workspace', 'close', doomed); } catch {}
    saveRegistry(root, registry);
    say(`HERDR: parent workspace ${registry.parentWorkspaceId} rebuilt for the integrator.`);
    return { paneId: registry.parentPaneId, workspaceId: registry.parentWorkspaceId };
  });

export const closeHerdrLane = (root, taskId) => withRegistry(root, async (registry) => {
  const lane = registry.tasks[taskId];
  if (!lane) return;
  try { await herdr('workspace', 'close', lane.workspaceId); } catch {}
  delete registry.tasks[taskId];
  saveRegistry(root, registry);
});

// Return a pane's agent to the shell prompt. Interrupt twice: once to stop
// work, once to exit. True when both keystrokes were delivered; a pane herdr
// cannot reach is reported, not thrown.
const interruptPane = async (paneId) => {
  try {
    await herdr('agent', 'send-keys', paneId, 'ctrl+c');
    await sleep(500);
    await herdr('agent', 'send-keys', paneId, 'ctrl+c');
    await sleep(1000);
    return true;
  } catch { return false; }
};

const agentState = async (target) => {
  try {
    const result = await herdr('agent', 'get', target);
    return result?.result?.agent ? 'live' : 'gone';
  } catch (err) {
    return /agent_(?:not_found|not_running)|pane_not_found|no agent|not available/i.test(err.message)
      ? 'gone'
      : 'unknown';
  }
};

/**
 * Stop the recorded agent and prove that Herdr released it.
 *
 * A pane that accepted Ctrl-C is not necessarily free yet. Resetting its
 * worktree or starting a replacement while the old process is still alive is
 * how two agents end up writing one lane. Unknown liveness fails closed and
 * leaves the pane in place for diagnosis.
 */
const stopAgent = async (name, pane) => {
  const before = await agentState(name);
  if (before === 'gone') return true;
  if (before !== 'live' || !await interruptPane(pane)) return false;
  const deadline = Date.now() + HERDR_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await agentState(name);
    if (state === 'gone') return true;
    if (state === 'unknown') return false;
    // A Claude agent still running a command spends the first Ctrl-C on that
    // command and the second only arms "press again to exit", so one pair
    // does not stop it (#295). Send another pair while it is still live.
    await interruptPane(pane);
  }
  return false;
};

/**
 * Close what this epic opened in herdr: the parent workspace hosting the
 * integrator, and — with `lanes` — any lane workspace `closeHerdrLane` never
 * reached.
 *
 * Issue #111. `closeHerdrLane` runs at integration, and the only thing that
 * returned the integrator's pane to the shell prompt was the NEXT integrator to
 * reuse it (`interruptPane` above). The epic's last integrator has no
 * successor, so its claude TUI sat at its prompt forever — one orphan (with
 * its permission broker, ~420 MB) per closed epic, and the parent workspace
 * stayed in the sidebar with it. Interrupt it the same way, then close the
 * workspace.
 *
 * Lane workspaces are closed only when asked. A failed or blocked lane keeps
 * its pane beside its retained worktree (auto.mjs, task cleanup) so a human can
 * read what happened; `afk finish` is where that worktree is pruned, so it is
 * also where the pane goes. The epic close leaves them.
 *
 * Never throws: a reap that fails leaves exactly what every epic before it
 * left, and the counts say so. Returns `{ panes, workspaces }` — what was
 * actually interrupted and closed, not what was attempted — so `afk finish`
 * can print it and an orphan is visible rather than discovered in `ps`. Null
 * when there was no registry: nothing herdr-side belongs to this run.
 */
export const closeHerdrEpic = (root, { lanes = false } = {}) => withRegistry(root, async (registry) => {
  if (!registry.parentWorkspaceId && !registry.parentPaneId && !Object.keys(registry.tasks ?? {}).length)
    return null;
  const reaped = { panes: 0, workspaces: 0 };
  const close = async (workspaceId) => {
    if (!workspaceId) return;
    try { await herdr('workspace', 'close', workspaceId); reaped.workspaces += 1; } catch {}
  };
  if (registry.parentPaneId && await interruptPane(registry.parentPaneId)) reaped.panes += 1;
  await close(registry.parentWorkspaceId);
  registry.parentWorkspaceId = null;
  registry.parentPaneId = null;
  if (lanes) {
    for (const lane of Object.values(registry.tasks ?? {})) await close(lane?.workspaceId);
    registry.tasks = {};
  }
  // Ids of panes that no longer exist must not survive for a restart to adopt:
  // the next integrator would be handed a closed pane. Lanes left open keep
  // their entries, so a retry after `afk reset` still finds its scrollback.
  if (Object.keys(registry.tasks ?? {}).length) saveRegistry(root, registry);
  else rmSync(registryPath(root), { force: true });
  return reaped;
});

// --- scrollback: the only output channel this runtime has -------------------
// A herdr agent draws into a terminal; nothing writes `stream.jsonl`. So
// `agent-output.log` was EMPTY for every lane of every herdr run, and when four
// lanes crashed mid-work (epic-6 §3) `verification.json` could say `agentDied`
// and a token count and nothing whatsoever about WHY. The retry then replaced
// the pane and the reason was gone for good — two lanes died one second apart
// and a third at 31s having spent zero tokens, and none of that is now
// diagnosable. The recovery was right; the diagnosis has to survive it.
const SCROLLBACK_LINES = 2000;

/** `herdr pane read` answers in plain text; `herdr()` only parses JSON. */
export const paneText = (response) =>
  (typeof response === 'string' ? response : response?.result?.text ?? '') || '';

/**
 * This pane's recent scrollback, or null.
 *
 * Never throws and never fails a lane: a missing diagnosis is bad, and losing
 * an otherwise-complete lane to a failed diagnostic read is worse.
 */
export const readPaneOutput = async (paneId) => {
  if (!paneId) return null;
  try {
    return paneText(await herdr('pane', 'read', paneId,
      '--source', 'recent', '--lines', SCROLLBACK_LINES, '--format', 'text')) || null;
  } catch { return null; }
};

// --- permission preflight ---------------------------------------------------
// The role owns the profile (scripts/roles.mjs); this only renders it to the
// highest-precedence scope claude has — `.claude/settings.local.json` in the
// agent's own directory. bypassPermissions stays, capped by the layers that
// enforce in every mode: kernel-level sandbox writes limited to the worktree,
// deny rules on credential paths, and the skill denies the role carries.
// Written per worktree, removed before the produced-files scan so it never
// counts as task output. The integrator runs at the project root, where
// `.claude/` is the project's — it gets no file here, and carries its profile
// on the invocation instead (`roleAgent`/`settings`).
const settingsPath = (worktree) => resolve(worktree, '.claude', 'settings.local.json');
const writePreflight = (worktree, role) => atomicWrite(
  settingsPath(worktree),
  `${JSON.stringify(preflightSettings(role, worktree), null, 2)}\n`,
);

/**
 * Undo `writePreflight`, and nothing else.
 *
 * This used to be `rmSync(<worktree>/.claude, { recursive: true })`, which is
 * correct only when the runner created that directory. A project that TRACKS
 * `.claude/settings.json` — this repo does — had it deleted out of every lane,
 * and `git add -A` duly committed the deletion. It survived review because the
 * merges restored it, so the net branch diff looked clean; the first live epic's
 * closeout verifier caught it in the individual commits.
 *
 * So: remove the one file, then remove the directory only if it is now empty.
 */
const clearPreflight = (worktree) => {
  rmSync(settingsPath(worktree), { force: true });
  const dir = resolve(worktree, '.claude');
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {}
};

const reportPath = (cwd) => resolve(cwd, '.afk-report.json');

// --- the phase walk, kept ---------------------------------------------------
// `.afk-report.json` is OVERWRITTEN at every phase, so the walk a lane actually
// took — Resolve at 22:07, Implement at 22:19, Test at 22:41 — existed only in
// the pane title, for as long as the pane lived. The poll below reads that file
// every 5s anyway, so appending each new phase costs one line and gives the
// dashboard (and a post-mortem) the timings the pane used to keep to itself.
// Sampled, not hooked: two phases inside one poll interval collapse to the
// later one, which is why `step`/`total` are recorded — a gap in the numbers
// says a phase went by too fast to see rather than never happening.
//
// One file per attempt, beside that attempt's prompt: a retry gets its own walk
// rather than appending to the one it is replacing.
export const phaseLogPath = (runDir) => resolve(runDir, 'phases.jsonl');

/**
 * Append `report` to the attempt's phase log if it is a new phase or status.
 * @returns the key recorded, so the caller can carry it to the next tick.
 */
export const recordPhase = (runDir, report, last) => {
  if (!report?.status) return last;
  const key = `${report.status}/${report.phase ?? ''}`;
  if (key === last) return last;
  try {
    appendFileSync(phaseLogPath(runDir), `${JSON.stringify({
      at: report.updatedAt ?? new Date().toISOString(),
      status: report.status,
      phase: report.phase ?? null,
      step: report.step ?? null,
      total: report.total ?? null,
      reason: report.reason ?? null,
    })}\n`);
  } catch {
    // A phase we could not write is a lost timestamp, never a failed lane.
    return last;
  }
  return key;
};
const readReport = (cwd) => {
  try { return JSON.parse(readFileSync(reportPath(cwd), 'utf8')); }
  catch { return null; }
};

// --- session transcript side channel ---------------------------------------
// `marker` is the lane's own prompt path, which appears verbatim in the first
// message this agent sends. Newest-file-wins is NOT enough: the MERGER runs with
// cwd = the repo root, and `~/.claude/projects/<root-slug>/` is exactly where a
// human's own Claude Code session in that repo writes its transcript. On the
// first live epic run the merger bound to the operator's session, reported its
// 101M cache-read tokens as the lane's, and then read the word "auth" out of the
// human's conversation and declared the login dead — killing an integration whose
// merge had not been attempted. Bind by content, never by recency.
export const transcriptFile = (cwd, since, marker) => {
  const dir = resolve(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  try {
    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ path: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
      .filter((f) => f.mtime >= since)
      .sort((a, b) => b.mtime - a.mtime);
    for (const candidate of candidates) {
      try {
        if (readFileSync(candidate.path, 'utf8').includes(marker)) return candidate.path;
      } catch {}
    }
    // No file carries this lane's prompt yet: the agent has not spoken. Reporting
    // nothing is right — the alternative is reporting someone else's session.
    return null;
  } catch { return null; }
};

// Auth death in a lane's transcript is only a line Claude Code itself wrote for a
// failed API call: `isApiErrorMessage: true` (with `error: "authentication_failed"`
// on the real ones). The phrases also show up whenever the lane reads or quotes
// code that names them — a tool_result from grepping this runner, an assistant
// message citing it — and matching those killed live lanes of epic #183 (#178,
// #179) as an expired login while `claude auth status` said loggedIn.
export const transcriptShowsAuthDeath = (slice) =>
  String(slice ?? '').split('\n').some((line) => {
    if (!line) return false;
    try { return JSON.parse(line)?.isApiErrorMessage === true && looksLikeAuthDeath(line); }
    catch { return false; }
  });

export const makeTranscriptWatcher = (cwd, since, marker) => {
  let file = null;
  let offset = 0;
  let usageSeen = false;
  const tokens = { input: 0, output: 0, cacheRead: 0 };
  return {
    tokens,
    hasUsage: () => usageSeen,
    // Returns true when the new transcript slice contains an auth failure.
    scan() {
      file ??= transcriptFile(cwd, since, marker);
      if (!file) return false;
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { return false; }
      // Complete lines only: a line still being written is read whole next scan,
      // or a split auth-error line would parse as two fragments and be missed.
      const end = text.lastIndexOf('\n') + 1;
      const fresh = text.slice(offset, Math.max(offset, end));
      offset = Math.max(offset, end);
      if (!fresh) return false;
      for (const line of fresh.split('\n')) {
        if (!line) continue;
        try {
          const usage = JSON.parse(line)?.message?.usage;
          if (usage) {
            usageSeen = true;
            tokens.input += usage.input_tokens ?? 0;
            tokens.output += usage.output_tokens ?? 0;
            tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
          }
        } catch {}
      }
      return transcriptShowsAuthDeath(fresh);
    },
  };
};

const agentLabel = (key, attempt) =>
  `afk-${String(key).toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${attempt}`.slice(0, 32);

// The phase walk a lane follows comes from the role (`role.phases`). The agent
// mirrors it twice: as the checklist its prompt file directs (the implementer's
// is a scratch file, the other roles' a visible plan in the pane), and via
// report.mjs (deterministic state for AFK and the herdr sidebar). The scheduler
// never parses the checklist — report.mjs is the only signal.
const pointerPrompt = (promptPath, phases) =>
  `Read the file ${promptPath} and execute its instructions in the current directory.\n\n`
  + `Work through these phases in order: ${phases.join(' → ')}. `
  + `Track them as the prompt file directs, and keep that updated as you complete each phase.\n`
  + `At the START of each phase, run: node ${runnerDir}/scripts/report.mjs --status working --phase <name> --step <n> --total ${phases.length}\n`
  + `When completely finished, run: node ${runnerDir}/scripts/report.mjs --status done `
  + `(or --status failed --reason "why" if you cannot complete the task). Then stop.`;

// The full `herdr agent start` argv for a lane, returned not run, so a test can
// assert its shape without spawning herdr. `broker` is the permission-broker
// fragment (scripts/permission-broker.mjs `permissionBrokerArgs`) appended after
// the role's own `--settings`: it is ADDITIVE — the deny-rule settings stand,
// and the broker only adds where classifier escalations go (incident #53). Kept
// here in the lane-spawn region rather than inlined so the wiring has one name.
//
// herdr TYPES `claude <argv>` into the pane's shell, and a long typed line is
// cut: at ~4,800 characters the pane kept ~3,150, stopping inside the quoted
// standing instruction, so zsh sat in its continuation prompt and `claude`
// never started (#161). So every payload is written to a file in `launchDir`
// (the attempt's run dir) and the pane only ever sees its path: `--settings`
// and `--mcp-config` take a file as readily as a string, and the standing
// instruction has `--append-system-prompt-file`. Those writes are the one side
// effect; the argv is still returned rather than run.
// Keep the public seam used by the Herdr tests and callers, while the provider
// split itself lives beside buildAgentCommand in lib.mjs.
export const laneAgentStartArgs = (input) => buildHerdrAgentStartArgs(input);

const ANSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
// Three different facts (#292, defect 3). Exhaustion is a message that NAMES a
// quota or usage limit, and only that sends the lane to Claude. A bare 429 or
// "too many requests" is a transient throttle and keeps the ordinary
// rate-limit wait. An auth failure is a dead login, also sent to Claude.
const QUOTA_TEXT = /you(?:'|’)ve hit your usage limit|usage limit reached|quota exceeded|insufficient_quota/i;
const AUTH_TEXT = /401 unauthorized|missing bearer|not logged in|no credentials|authentication required/i;
const THROTTLE_TEXT = /too many requests|\b429\b/i;
// Pane text has no event structure, so a failure must START a line (after an
// optional "Error:"). Prose that quotes an old error mid-sentence never does.
const atLineStart = (re) => new RegExp(`(?:^|\\n)\\s*(?:error:\\s*)?(?:${re.source})`, 'im');
const classify = (text, anchored) => {
  const hit = (re) => (anchored ? atLineStart(re) : re).test(text);
  if (hit(QUOTA_TEXT)) return 'quota';
  if (hit(AUTH_TEXT)) return 'auth';
  if (hit(THROTTLE_TEXT)) return 'rate-limit';
  return null;
};

/**
 * Classify a Codex failure as 'quota', 'auth', 'rate-limit' or null, from
 * either a `codex exec --json` stream or an interactive pane's text.
 *
 * In a stream only the provider's own failure events (`turn.failed`, `error`)
 * count; an `agent_message` quoting historical error text is the agent's
 * prose, not a failure. Non-JSON lines (pane text, CLI stderr) count only
 * when the failure starts the line.
 */
export const codexTerminalFailure = (text) => {
  const plain = [];
  const events = [];
  for (const line of String(text ?? '').replace(ANSI_RE, '').split('\n')) {
    let event = null;
    try { event = JSON.parse(line); } catch {}
    if (event && typeof event === 'object') {
      if (event.type === 'turn.failed' || event.type === 'error')
        events.push(`${event.error?.message ?? ''} ${event.message ?? ''}`);
    } else plain.push(line);
  }
  const fromEvents = events.map((message) => classify(message, false));
  for (const kind of ['quota', 'auth', 'rate-limit']) if (fromEvents.includes(kind)) return kind;
  return classify(plain.join('\n'), true);
};

// A retry can inherit its own previous attempt's still-registered agent name.
// herdr does not free `afk-<task>` when that attempt's pane process dies (and
// the 32-char cap on agentLabel drops the attempt suffix, so attempt 2 asks for
// the exact name attempt 1 orphaned), so `agent start` fails `agent_name_taken`.
// The error names the workspace still holding the name in its candidate list
// (`… pane_id=w130:p1 workspace_id=w130 …`) — the same fact the human reads off
// it before running `herdr workspace close w130`. Parse it so the runtime can
// reap that workspace and re-claim the name, exactly as the human workaround
// does. Null when the message is not a name collision or carries no workspace.
export const orphanFromNameTaken = (message) => {
  const text = String(message ?? '');
  if (!/agent_name_taken/.test(text)) return null;
  const workspaceId = /workspace_id=([A-Za-z0-9._-]+)/.exec(text)?.[1] ?? null;
  const paneId = /pane_id=([A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?)/.exec(text)?.[1] ?? null;
  return workspaceId ? { workspaceId, paneId } : null;
};

// The orphan a start may reap to free its name, or null. A collision naming our
// OWN workspace is never reapable — closing it would kill the very lane we are
// starting — so this guard is the catastrophic one and lives in its own testable
// seam. Liveness is checked at the call site (it needs a herdr probe): a live
// holder is real work, not an orphan, and is left to fail rather than killed.
export const reapTarget = (message, ourWorkspace) => {
  const orphan = orphanFromNameTaken(message);
  if (!orphan || orphan.workspaceId === ourWorkspace) return null;
  return orphan;
};

// Core lifecycle shared by builder and merger lanes. Returns the shape
// worker.mjs/integrate.mjs get from runAsync, extended with tokens and
// failure-cause flags: { status, timedOut, tokens, authFailure?, agentDied? }.
const runHerdrAgent = async ({ role, key, taskId, cwd, paneId, workspaceId, agent, promptPath, say, onPid, attempt, recoverPane = null, checklistPath = null, idleUnreportedMs = IDLE_UNREPORTED_MS }) => {
  // Both are reassigned if the pane turns out to be unusable and we move.
  let pane = paneId;
  let workspace = workspaceId;
  rmSync(reportPath(cwd), { force: true });
  const name = agentLabel(key, attempt);
  const startedAt = Date.now();
  const backend = resolveBackend(agent.backend ?? 'claude');
  const watcher = backend === 'claude' ? makeTranscriptWatcher(cwd, startedAt, promptPath) : null;
  let paneBaseline = null;
  // `paneId` is the pane this lane ENDED on, which `recoverPane` may have
  // moved. The caller reads its scrollback, so it has to be told where to look
  // rather than reusing the id it passed in.
  const finish = (result) => {
    watcher?.scan();
    rmSync(reportPath(cwd), { force: true });
    return {
      ...(watcher?.hasUsage() ? { tokens: watcher.tokens } : {}),
      paneId: pane,
      paneBaseline,
      ...result,
    };
  };
  // FAIL DIRECTION: closed for Codex lanes, whose stop check #293 added. A
  // Claude lane that finished (status 0) stays finished whatever the stop
  // proves, as on main; its failures still fail closed.
  const finishStopped = async (result) => {
    const stopped = await stopAgent(name, pane);
    const keepDone = backend !== 'codex' && result.status === 0;
    return finish(stopped || keepDone ? result : {
      ...result,
      status: 1,
      agentStillRunning: true,
    });
  };

  // A reused pane may still host a previous agent; return it to the shell
  // prompt first.
  await interruptPane(pane);
  paneBaseline = await readPaneOutput(pane);

  // A freshly opened workspace's shell needs a moment before it counts as an
  // interactive prompt; agent start rejects instantly until then. Retry with
  // backoff instead of failing the lane on a race we caused ourselves.
  // The lane's rendered prompt file carries the ticket body and the ledger
  // notes, which is the context the broker rules from; the task id names the
  // lane. Both are already in scope here, so the wiring needs nothing from the
  // callers in worker.mjs/integrate.mjs.
  const broker = backend === 'claude'
    ? permissionBrokerArgs({ promptPath, taskId, runnerDir })
    : [];
  let recovered = false;
  let reaped = false;
  let unsafePriorAgent = false;
  const startAgent = async () => {
    for (let wait = 2_000; ; wait *= 2) {
      try {
        return await herdr(...laneAgentStartArgs({ name, pane, agent, broker, launchDir: dirname(promptPath), cwd }));
      } catch (err) {
        // agent_pane_busy is not the boot race the backoff above is for: the
        // pane is held by an agent that outlived the orchestrator that started
        // it (herdr does not tie pane lifetime to the parent process), so it
        // never frees itself and waiting only fails slower. Give the pane up
        // and start in one we have never used. This costs the lane's
        // scrollback, which retries otherwise keep as evidence — hence only
        // this fault, and only once.
        if (recoverPane && !recovered && /agent_pane_busy/.test(err.message)) {
          const occupied = await agentState(pane);
          if (occupied !== 'gone') {
            // Fail closed: refusing to launch does not prove the previous
            // writer stopped. Keep worker reset/teardown blocked as well.
            unsafePriorAgent = true;
            throw new Error(
              occupied === 'live'
                ? `lane ${key} prior agent is still running in pane ${pane}`
                : `lane ${key} cannot verify whether pane ${pane} is free`,
            );
          }
          recovered = true;
          say(`HERDR: lane ${key} pane ${pane} is held by a stale agent; moving to a fresh pane.`);
          ({ paneId: pane, workspaceId: workspace } = await recoverPane());
          paneBaseline = await readPaneOutput(pane);
          wait = 1_000; // the doubling below restores the full 2s ladder
          continue;
        }
        // agent_name_taken: a stale orphan from a previous attempt still holds
        // this lane's name (issue #100). Free it the way the human does — close
        // the workspace the error names — then re-claim, once. Guard against
        // reaping our own workspace, and never close a pane that is still alive:
        // a live holder is real work, not an orphan, and losing it is the worse
        // error, so leave the start to fail rather than kill it.
        const orphan = reaped ? null : reapTarget(err.message, workspace);
        if (orphan) {
          reaped = true;
          if (!orphan.paneId || !await paneAlive(orphan.paneId)) {
            say(`HERDR: lane ${key} name ${name} held by stale workspace ${orphan.workspaceId}; reaping it.`);
            try { await herdr('workspace', 'close', orphan.workspaceId); } catch {}
            wait = 1_000; // the doubling below restores the full 2s ladder
            continue;
          }
        }
        if (wait > 16_000) throw err;
        say(`HERDR: lane ${key} agent start not ready (${err.message.split('\n')[0]}); retrying in ${wait / 1000}s.`);
        await sleep(wait);
      }
    }
  };
  let agentStarted = false;
  try {
    const started = await startAgent();
    agentStarted = true;
    const pid = started.result?.agent?.pid;
    if (pid) onPid(pid);
    say(`HERDR: lane ${key} agent ${name} in workspace ${workspace} pane ${pane}.`);
    // No notification here, deliberately. A lane starting needs nothing from a
    // human, and a ticket starts twice (builder, then integrator) — grouping
    // could dedupe the Notification Centre entry but not the banner or the
    // sound, so an epic still interrupted once per lane per role for news the
    // dashboard and the pane titles already carry. The runner notifies when it
    // wants you, and otherwise stays quiet.
    // `agent start` returns when the PROCESS exists, not when claude is ready to
    // read a prompt. Sending it immediately drops the keystrokes into a CLI that
    // is still booting: the agent then sits at its prompt having been told
    // nothing, writes no report, and 90 seconds later the lane is "idle without
    // a report" with an exit code of 0 and no transcript. Epic #7's lane 8 died
    // exactly that way and took both its dependants with it
    // (docs/findings.md 3.13).
    const prompt = pointerPrompt(promptPath, role.phases);
    try { await herdr('agent', 'wait', name, '--until', 'idle', '--timeout', 60_000); } catch {}
    await herdr('agent', 'prompt', name, prompt);

    // Confirm it landed. An agent that accepted a prompt leaves idle; one that
    // is still idle with no report never heard us, and one more send costs a
    // second against a lane that would otherwise burn its whole deadline doing
    // nothing. Guarded on the report file so a lane that genuinely finished in
    // under 20s is never prompted twice.
    try {
      await herdr('agent', 'wait', name, '--until', 'working', '--timeout', 20_000);
    } catch {
      const stillIdle = await herdr('agent', 'get', name).catch(() => null);
      if (stillIdle?.result?.agent?.status === 'idle' && !readReport(cwd)) {
        say(`HERDR: lane ${key} never picked up its prompt; sending it once more.`);
        await herdr('agent', 'prompt', name, prompt);
      }
    }
  } catch (err) {
    const stopped = !unsafePriorAgent && (!agentStarted || await stopAgent(name, pane));
    say(`HERDR: lane ${key} failed to start: ${err.message.split('\n')[0]}`);
    notify(`Task ${key} could not start: ${err.message.split('\n')[0]}`, {
      workspaceId: workspace,
      taskId,
      subtitle: `#${key} failed to start`,
      kind: 'lane_start_failed',
    });
    return finish(stopped ? { status: 1, timedOut: false } : {
      status: 1, timedOut: false, agentStillRunning: true,
    });
  }

  // The attempt's own directory, which is where its prompt was rendered. Taken
  // from the prompt rather than rebuilt from ids so it cannot drift from what
  // worker.mjs and integrate.mjs already chose.
  const runDir = dirname(promptPath);
  let lastPhase = null;
  let deadline = startedAt + agent.timeoutMs;
  let blockedExtended = false;
  let idleSince = null;
  let continuations = 0;
  let deadTicks = 0;
  let tick = 0;
  let lastLoggedOutput = 0;
  while (Date.now() < deadline) {
    tick += 1;
    let state = 'unknown';
    try {
      const waited = await herdr('agent', 'wait', name,
        '--until', 'idle', '--until', 'done', '--until', 'blocked',
        '--timeout', POLL_MS);
      state = waited.result?.agent?.status ?? 'idle';
      deadTicks = 0;
    } catch (err) {
      // The alias is cleared when the process exits: a vanished agent means
      // the claude process died. Fail fast instead of waiting out the clock.
      if (/agent_not_running|agent_not_found|no such agent/i.test(err.message)) {
        deadTicks += 1;
        if (deadTicks >= 3) {
          const last = readReport(cwd);
          if (last?.status === 'done') return finish({ status: 0, timedOut: false, report: last });
          say(`HERDR: lane ${key} agent process died.`);
          notify(`Task ${key} agent process died.`, { workspaceId: workspace, taskId, subtitle: `#${key} died`, kind: 'lane_died' });
          return finish({ status: 1, timedOut: false, agentDied: true });
        }
      }
    }

    if (watcher && tick % TRANSCRIPT_EVERY_TICKS === 0) {
      const authDead = watcher.scan();
      if (watcher.tokens.output > lastLoggedOutput) {
        lastLoggedOutput = watcher.tokens.output;
        say(`HERDR: lane ${key} tokens in=${watcher.tokens.input} out=${watcher.tokens.output} cacheRead=${watcher.tokens.cacheRead}.`);
      }
      if (authDead) {
        say(`HERDR: lane ${key} hit an auth failure — the claude login has expired. Run: claude auth login`);
        notify('The claude login expired mid-run. Re-login to continue.', { workspaceId: workspace, taskId, subtitle: 'login expired', kind: 'auth_expired' });
        return finishStopped({ status: 1, timedOut: false, authFailure: true });
      }
    }

    if (backend === 'codex') {
      const currentPane = await readPaneOutput(pane);
      const attemptPane = currentPane === null || paneBaseline === null
        ? null
        : paneBaseline && currentPane.startsWith(paneBaseline)
          ? currentPane.slice(paneBaseline.length)
          : paneBaseline ? null : currentPane;
      const failure = codexTerminalFailure(attemptPane);
      if (failure === 'quota') {
        say(`HERDR: lane ${key} hit a Codex quota rejection.`);
        return finishStopped({ status: 1, timedOut: false, rateLimited: true, quotaRejected: true });
      }
      if (failure === 'rate-limit') {
        say(`HERDR: lane ${key} hit a transient Codex rate limit.`);
        return finishStopped({ status: 1, timedOut: false, rateLimited: true });
      }
      if (failure === 'auth') {
        say(`HERDR: lane ${key} hit a Codex authentication failure. Run: codex login`);
        return finishStopped({ status: 1, timedOut: false, authFailure: true });
      }
    }

    const report = readReport(cwd);
    lastPhase = recordPhase(runDir, report, lastPhase);
    if (report?.status === 'done') return finishStopped({ status: 0, timedOut: false, report });
    if (report?.status === 'failed') {
      say(`HERDR: lane ${key} reported failed: ${report.reason ?? 'no reason'}`);
      return finishStopped({ status: 1, timedOut: false, report });
    }

    if (state === 'blocked' && !blockedExtended) {
      blockedExtended = true;
      deadline += BLOCKED_EXTRA_MS;
      say(`HERDR: lane ${key} is blocked — agent needs input. Open herdr (workspace ${workspace}).`);
      notify(`Task ${key} is blocked and needs your input.`, { workspaceId: workspace, taskId, subtitle: `#${key} blocked`, kind: 'lane_blocked' });
    }
    if (state === 'idle' || state === 'done') {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > idleUnreportedMs) {
        // Idle is a report, not proof of done (lib.mjs `openChecklistItems`).
        // Open items and budget left: send the agent back and restart the clock.
        const worthIt = continuations < MAX_CHECKLIST_CONTINUATIONS
          && deadline - Date.now() >= continuationFloorMs(agent.timeoutMs);
        const open = worthIt ? readOpenChecklistItems(checklistPath, role.phases.at(-1)) : [];
        if (open.length) {
          continuations += 1;
          say(`HERDR: lane ${key} idle with ${open.length} open checklist item(s); continuing (${continuations}/${MAX_CHECKLIST_CONTINUATIONS}).`);
          try {
            await herdr('agent', 'prompt', name, checklistContinuation(open));
            idleSince = null;
            continue;
          } catch {}
        }
        say(`HERDR: lane ${key} idle without a report — handing to the verifier.`);
        return finishStopped({ status: 0, timedOut: false });
      }
    } else {
      idleSince = null;
    }
  }
  // Before a continuation this lane was idle, and idle is handed on as status 0.
  // A continuation that runs out the clock must not turn that into a timeout.
  if (continuations) {
    say(`HERDR: lane ${key} hit the deadline during a checklist continuation — handing to the verifier as it stood.`);
    return finishStopped({ status: 0, timedOut: false });
  }
  say(`HERDR: lane ${key} hit the ${blockedExtended ? 'extended ' : ''}deadline.`);
  return finishStopped({ status: 1, timedOut: true });
};

/**
 * Run one role in herdr. `role.pane` decides where: a `lane` role gets the
 * task's own worktree workspace and a runner-owned permission preflight; a
 * `parent` role runs in the repo workspace's root pane, where `.claude/` is
 * the project's and the profile rides on the invocation instead.
 *
 * Returns the shape worker.mjs/integrate.mjs get from runAsync, extended with
 * tokens and failure-cause flags.
 */
export const runHerdrRole = async ({ role, root, task, worktree, agent, promptPath, attempt, say = console.log, onPid = () => {}, checklistPath = null, idleUnreportedMs = IDLE_UNREPORTED_MS }) => {
  const captureAttemptPane = (result, output) => {
    if (output === null || result?.paneBaseline === null) return null;
    if (!result?.paneBaseline) return output;
    return output.startsWith(result.paneBaseline)
      ? output.slice(result.paneBaseline.length)
      : output;
  };
  const key = role.laneKey(task.id);
  if (role.pane === 'lane') {
    const lane = await adoptLane({ root, task, worktree });
    const backend = resolveBackend(agent.backend ?? 'claude');
    if (backend === 'claude') writePreflight(worktree, role);
    const result = await runHerdrAgent({
      role, key, taskId: task.id, cwd: worktree, paneId: lane.paneId, workspaceId: lane.workspaceId,
      agent, promptPath, say, onPid, attempt, checklistPath, idleUnreportedMs,
      // Drop the registry entry first, or `adoptLane` reuses the pane we are
      // running away from.
      recoverPane: async () => {
        await closeHerdrLane(root, task.id);
        return adoptLane({ root, task, worktree });
      },
    });
    if (backend === 'claude') clearPreflight(worktree);
    // Read here, not later: `auto.mjs` closes this lane's workspace on retry and
    // on cleanup, and `adoptLane` hands the pane to the next attempt. Once
    // either happens the reason this lane stopped is unrecoverable.
    return {
      ...result,
      paneOutput: captureAttemptPane(result, await readPaneOutput(result.paneId)),
    };
  }
  // The parent pane runs beside its lanes, and serialized integration means
  // one agent at a time there by design.
  const paneId = await parentPane(root, say);
  // The parent workspace keeps the stable epic label for restart adoption;
  // give the reused merger pane the task-bearing agent name instead.
  try { await herdr('pane', 'rename', paneId, agentLabel(key, attempt)); } catch {}
  const registry = loadRegistry(root);
  const result = await runHerdrAgent({
    role, key, taskId: task.id, cwd: root, paneId, workspaceId: registry.parentWorkspaceId,
    agent, promptPath, say, onPid, attempt,
    // The integrator has no second worktree to fall back to, so a busy parent
    // pane used to be fatal to the whole epic rather than to one merge.
    recoverPane: () => recreateParent(root, say),
  });
  // The parent pane is reused by every merge, so a failed integration's output
  // is overwritten by the next one rather than destroyed with the pane. Same
  // capture, same reason.
  return {
    ...result,
    paneOutput: captureAttemptPane(result, await readPaneOutput(result.paneId)),
  };
};
