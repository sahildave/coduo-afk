import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format, parseStream, timeline } from "./agent-stats.mjs";
import { serveMachineView } from "./machine-views.mjs";
import {
  COMPLETE_LIFECYCLES,
  mergeDashboardState,
  parseWorktrees,
  phaseCounts,
  pidAlive,
} from "./dashboard-data.mjs";
import {
  DASHBOARD_HOST,
  EXIT_PORT_IN_USE,
  dashboardUrl,
  derivedDashboardPort,
  discoverDashboards,
} from "./dashboard-process.mjs";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The runner is installed once and invoked from many projects. Project state
// always belongs to the caller's current working directory, never this script's
// installation directory.
const root = process.cwd();
// Same derivation the runner uses, so a standalone `afk dashboard` lands on
// the port the run would have picked rather than the retired fixed 4041.
const PORT = Number(process.env.PORT || derivedDashboardPort(root));
const read = (path, base = root) => {
  try {
    return readFileSync(resolve(base, path), "utf8");
  } catch {
    return null;
  }
};
const json = (path) => {
  try {
    return JSON.parse(read(path));
  } catch {
    return null;
  }
};
const worktrees = () => {
  try {
    return parseWorktrees(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
      root,
    );
  } catch {
    return [];
  }
};

// The run's graph shape lives in `.afk/state.json` (there is no manifest file
// any more), so a project with no run yet has nothing to render.
// The run's own name for itself. The checkout's directory, because that is what
// the operator calls it and `.afk-setup/config.yaml` has no project key — an
// invented one would be schema nobody else reads.
const projectName = () => basename(root);

const merged = () => {
  const state = json(".afk/state.json");
  if (!state?.dag) return null;
  return mergeDashboardState(
    {
      project: projectName(),
      ...state.dag,
      tasks: state.dag.tasks.map((task) => ({ ...task })),
    },
    state,
    worktrees(),
    undefined,
    liveStats(state),
  );
};

// What the agent on a lane is doing right now, for the lanes that have one.
// Bounded: only tasks with a live worker or the integrator are read, and each
// read is the same 256 KB tail every other stream read here uses — a 5s poll
// must never grow with the size of a run's logs.
const liveStats = (state) => {
  const out = {};
  const add = (entry, kind) => {
    if (!entry?.taskId) return;
    const path = resolve(root, streamPath(entry.taskId, kind, entry.attempt));
    const raw = tail(path)?.text;
    if (!raw) return;
    const stats = parseStream(raw);
    // How long THIS attempt has been going. The runner records no start time
    // per attempt, but the attempt's own stream file was created when its agent
    // was spawned, which is the same instant to the second.
    let startedMs = null;
    try {
      const stat = statSync(path);
      startedMs = stat.birthtimeMs || stat.ctimeMs;
    } catch { /* a stream we cannot stat still reports its counters */ }
    out[entry.taskId] = {
      kind,
      attempt: entry.attempt ?? null,
      elapsedMs: startedMs ? Date.now() - startedMs : null,
      turns: stats.turns,
      toolCalls: stats.toolCalls,
      contextTokens: stats.contextTokens,
      outputTokens: stats.outputTokens,
      model: stats.model,
      action: stats.activeAction || stats.lastActivity || "",
      rateLimited: Boolean(stats.rateLimit),
    };
  };
  for (const worker of Object.values(state.activeWorkers ?? {})) add(worker, "builder");
  add(state.activeIntegrator, "integration");
  return out;
};

const PANE_TAIL_LINES = 30;

/** The last lines of a pane, for the running log where a full one will not fit. */
const paneTail = async (paneId, lines = PANE_TAIL_LINES) => {
  const text = paneId ? await readPane(paneId) : null;
  return text ? text.split("\n").slice(-lines).join("\n") : null;
};

const activity = async () => {
  const state = json(".afk/state.json") ?? {};
  const parts = [
    `── orchestrator ──\n${read(".afk/agent-auto.log")?.split("\n").slice(-25).join("\n") || "(no runs yet)"}`,
  ];
  // A herdr lane writes no stream, so what it is doing lives only in its pane.
  const body = async (raw, taskId, kind) => {
    if (raw) return timeline(raw) || "(waiting for output)";
    const pane = herdrPane(taskId, kind);
    const text = await paneTail(pane);
    return text
      ? `(herdr pane ${pane} — no stream on this runtime; last ${PANE_TAIL_LINES} lines)\n${text}`
      : "(waiting for output)";
  };
  for (const worker of Object.values(state.activeWorkers ?? {})) {
    const path = streamPath(worker.taskId, "builder", worker.attempt);
    const raw = read(path) ?? "";
    parts.push(
      `\n── builder ${worker.taskId} [pid ${worker.pid ?? "starting"}] ──\n${format(worker.taskId, parseStream(raw))}\n${await body(raw, worker.taskId, "builder")}`,
    );
  }
  const integrator = state.activeIntegrator;
  if (integrator) {
    const path = streamPath(integrator.taskId, "integration", integrator.attempt);
    const raw = read(path) ?? "";
    parts.push(
      `\n── integrator ${integrator.taskId} [pid ${integrator.pid ?? "starting"}] ──\n${format(`merge-${integrator.taskId}`, parseStream(raw))}\n${await body(raw, integrator.taskId, "integration")}`,
    );
  }
  if (state.integrationQueue?.length)
    parts.push(
      `\n── integration queue ──\n${state.integrationQueue.join(" → ")}`,
    );
  return parts.join("\n");
};

// Where one attempt's stream lives. One builder, so the three readers below
// cannot drift apart on the layout of `.afk/runs`.
const streamPath = (taskId, kind, attempt) =>
  `.afk/runs/${taskId}/${kind}-${attempt}/stream.jsonl`;

// ── herdr lanes: the pane IS the log ─────────────────────────────────────
// A `direct` lane streams JSONL into its attempt directory; a herdr lane draws
// into a terminal and writes NOTHING there until it ends (runtime-herdr.mjs,
// "scrollback: the only output channel this runtime has"). So on a herdr run
// every ticket answered `no stream log yet` for its entire life, and the panel
// the operator opens to watch a lane work was empty by construction.
//
// `.afk/herdr.json` already records which pane hosts which lane — a builder its
// own workspace pane, the merger the parent pane the integrator reuses — so the
// live channel is one `herdr pane read` away.
const execFileAsync = promisify(execFile);
const HERDR_LINES = 400;

const herdrPane = (taskId, kind) => {
  const registry = json(".afk/herdr.json");
  if (!registry) return null;
  return (
    (kind === "builder"
      ? registry.tasks?.[taskId]?.paneId
      : registry.parentPaneId) ?? null
  );
};

// Several tabs on one panel poll every 3s; a pane read is a subprocess, so it
// is cached for one poll interval rather than run per request. Bounded and
// never fatal: a missing `herdr`, a closed pane or a slow one all resolve to
// null, and the caller falls back to the file on disk.
const PANE_TTL_MS = 2_500;
const paneCache = new Map();
const readPane = async (paneId) => {
  const hit = paneCache.get(paneId);
  if (hit && Date.now() - hit.at < PANE_TTL_MS) return hit.text;
  let text = null;
  try {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", paneId, "--source", "recent", "--lines", String(HERDR_LINES), "--format", "text"],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    );
    text = stdout.trim() || null;
  } catch {
    text = null;
  }
  paneCache.set(paneId, { at: Date.now(), text });
  return text;
};

/**
 * The attempt directory an agent is writing RIGHT NOW for this task, or null.
 *
 * A pane shows one agent: whichever is in it now. Reading it for an attempt
 * that has already ended would caption someone else's scrollback with this
 * attempt's number, so the pane is consulted only for the attempt the runner
 * records as active — and only while the orchestrator lives, because a dead
 * run's panes are reused by the next one.
 */
const liveAttempt = (state, taskId) => {
  if (!pidAlive(state.orchestratorPid)) return null;
  const worker = Object.values(state.activeWorkers ?? {}).find(
    (entry) => entry.taskId === taskId,
  );
  if (worker) return { name: `builder-${worker.attempt}`, kind: "builder" };
  if (state.activeIntegrator?.taskId === taskId)
    return {
      name: `integration-${state.activeIntegrator.attempt}`,
      kind: "integration",
    };
  return null;
};

// Per-task logs. Stream files grow to megabytes while a builder runs, so every
// read is a bounded tail — never a whole-file read on a 5s poll.
const TAIL_BYTES = 256 * 1024;
const ATTEMPT_RE = /^(builder|integration)-\d+$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;
const runsDir = () => resolve(root, ".afk/runs");

const tail = (path, maxBytes = TAIL_BYTES) => {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString("utf8");
    // A mid-file start almost always lands inside a line; drop that fragment so
    // JSONL stays parseable.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return { text, truncated: start > 0, size };
  } finally {
    closeSync(fd);
  }
};

// ── the agents a run spawns that are not a lane ──────────────────────────
// A run is more than its builders: the verifier, the supervisor, the fixer, the
// reflector and the plan reviewer each come and go with their own stream, and
// until now none of them was reachable from the page. (The epic-close agent is
// not one of them — `.afk/epic-close/<id>/` holds rendered prose, no stream.)
//
// The scan is STRUCTURAL, not a list of roles. Every one of them writes
// `.afk/<dir>/<id>/stream.jsonl`, and those directory names are string literals
// spread across supervisor.mjs, verifier.mjs, fixer.mjs, reflect.mjs, wave.mjs
// and epic.mjs — there is no registry to read (`ROLES` in roles.mjs names agent
// definitions, not paths). A second hand-typed list here would be one more copy
// to drift, and a role added later would be invisible to the page. So: anything
// at that exact depth with a stream in it is an agent, and a role added later
// appears with no edit here.
//
// `runs/` and `archive/` are excluded by name because they are the only `.afk`
// directories that go DEEPER — a lane's stream is at `runs/<id>/<attempt>/` and
// is reachable from its ticket, an archived run is a previous epic entirely.
const NOT_AGENT_DIRS = new Set(["runs", "archive"]);
const ROLE_RE = /^[A-Za-z0-9_-]+$/;
// `stream.jsonl` for most roles; the plan reviewer numbers its attempts as
// `stream-1.jsonl`. Matching only the plain name made every plan review
// invisible, which is the failure this pattern exists to stop.
const STREAM_RE = /^stream(-\d+)?\.jsonl$/;

/** The newest stream file in a role's run directory, or null if it has none. */
const streamIn = (dir) => {
  let names;
  try {
    names = readdirSync(dir).filter((name) => STREAM_RE.test(name)).sort();
  } catch {
    return null;
  }
  // Sorted by name, so `stream-2` wins over `stream-1`; a plain `stream.jsonl`
  // is the only file when it exists.
  const name = names.at(-1);
  if (!name) return null;
  try {
    return { path: resolve(dir, name), name, stat: statSync(resolve(dir, name)) };
  } catch {
    return null;
  }
};
/**
 * A role run's readable leftovers, newest first.
 *
 * Not every role agent leaves a stream. A supervisor call that is decided
 * deterministically never spawns one and writes `decision.json` alone; the
 * epic-close agent writes prose and no stream at all. Scanning for streams only
 * made exactly those runs — the rulings an operator most wants to read — the
 * ones with no chip on the page.
 *
 * `prompt.md` is excluded: it is this run's input, it is the largest file in
 * most of these directories, and it is already in the ticket.
 */
const ARTIFACT_RE = /\.(json|md)$/;
const artifactsIn = (dir) => {
  let names;
  try {
    names = readdirSync(dir).filter(
      (name) => ARTIFACT_RE.test(name) && name !== "prompt.md",
    );
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return { name, path: resolve(dir, name), stat: statSync(resolve(dir, name)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
};

// A stream is only live while its agent is writing it. The runner records no
// pid for these, so recency is the honest signal — and it is stated as such in
// the UI rather than dressed up as liveness.
const LIVE_WINDOW_MS = 90_000;

const roleRuns = () => {
  const base = resolve(root, ".afk");
  const out = [];
  let roles;
  try {
    roles = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const role of roles) {
    if (!role.isDirectory() || NOT_AGENT_DIRS.has(role.name)) continue;
    let runs;
    try {
      runs = readdirSync(resolve(base, role.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const dir = resolve(base, role.name, run.name);
      const stream = streamIn(dir);
      const artifacts = stream ? [] : artifactsIn(dir);
      if (!stream && !artifacts.length) continue;
      const newest = stream ?? artifacts[0];
      out.push({
        key: `${role.name}/${run.name}`,
        role: role.name,
        id: run.name,
        bytes: newest.stat.size,
        updatedAt: new Date(newest.stat.mtimeMs).toISOString(),
        // Recent writes only; whether the agent ANSWERED is `finished`, read
        // from the stream itself by the log endpoint.
        recent: Date.now() - newest.stat.mtimeMs < LIVE_WINDOW_MS,
      });
    }
  }
  // Newest first: what an operator wants is whatever just happened.
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

// `<role>/<id>`, both segments whitelisted against traversal, then the resolved
// path confirmed to be inside `.afk` — the same belt and braces the lane logs
// use. A directory that holds no stream 404s rather than 400s: the id was
// well-formed, there is just nothing there.
const roleLog = (key) => {
  const [role, id, ...rest] = String(key).split("/");
  const wellFormed =
    rest.length === 0
    && ROLE_RE.test(role ?? "")
    && !NOT_AGENT_DIRS.has(role)
    && TASK_ID_RE.test(id ?? "");
  if (!wellFormed) return { status: 400, body: { error: "invalid agent id" } };
  const base = resolve(root, ".afk");
  const dir = resolve(base, role, id);
  if (!dir.startsWith(base + sep)) return { status: 400, body: { error: "invalid agent id" } };
  const found = streamIn(dir);
  const stream = found && tail(found.path);
  if (!stream) {
    const artifacts = artifactsIn(dir);
    if (!artifacts.length)
      return { status: 404, body: { error: `nothing recorded for ${key}` } };
    // 8 KB each so one long review cannot bury the decision beside it.
    const body = artifacts
      .map(
        (artifact) =>
          `── ${artifact.name} ──\n${tail(artifact.path, 8 * 1024)?.text?.trim() ?? ""}`,
      )
      .join("\n\n");
    return {
      status: 200,
      body: {
        id: key,
        attempts: [],
        attempt: "",
        truncated: false,
        bytes: artifacts.reduce((sum, artifact) => sum + artifact.stat.size, 0),
        finished: true,
        summary: `${key} — no stream; ${artifacts.length} artifact(s): ${artifacts.map((a) => a.name).join(", ")}`,
        timeline: body,
        output: "",
      },
    };
  }
  const stats = parseStream(stream.text);
  return {
    status: 200,
    body: {
      id: key,
      // A role run has no attempts to switch between: one directory, one
      // stream. The panel renders an empty switcher rather than a fake one.
      attempts: [],
      attempt: "",
      truncated: Boolean(stream.truncated),
      bytes: stream.size,
      finished: Boolean(stats.result),
      summary: format(key, stats),
      timeline: timeline(stream.text, 200) || "(waiting for output)",
      output: "",
    },
  };
};

// The id comes from the client. Whitelist its shape, then confirm the resolved
// directory is still inside .afk/runs — belt and braces against traversal.
const runDir = (id) => {
  if (!TASK_ID_RE.test(id)) return null;
  const base = runsDir();
  const dir = resolve(base, id);
  return dir.startsWith(base + sep) ? dir : null;
};

/**
 * The phase walk this attempt reported, oldest first.
 *
 * `runtime-herdr.mjs` appends one line per transition (`recordPhase`). A lane
 * that never reported — any `direct` lane, or a herdr lane that died before its
 * first phase — has no file and gets an empty walk, which the panel omits
 * rather than drawing as a stalled first phase.
 */
const phaseWalk = (dir, attempt) => {
  const raw = tail(resolve(dir, attempt, "phases.jsonl"), 64 * 1024);
  if (!raw?.text) return [];
  return raw.text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.at);
};

const taskLog = async (id, wanted) => {
  const dir = runDir(id);
  if (!dir) return { status: 400, body: { error: "invalid task id" } };
  let attempts;
  try {
    attempts = readdirSync(dir)
      .filter((name) => ATTEMPT_RE.test(name))
      .sort();
  } catch {
    return { status: 404, body: { error: `no runs recorded for ${id}` } };
  }
  if (!attempts.length)
    return { status: 404, body: { error: `no attempts recorded for ${id}` } };
  // The highest attempt number is not always the live one — a retry can be
  // abandoned and an earlier builder left running. Default to whichever stream
  // was written most recently; a herdr attempt has no stream to compare, so its
  // own directory's mtime stands in.
  const mtime = (name) => {
    try {
      return statSync(resolve(dir, name, "stream.jsonl")).mtimeMs;
    } catch {
      try {
        return statSync(resolve(dir, name)).mtimeMs;
      } catch {
        return 0;
      }
    }
  };
  const newest = attempts.reduce((a, b) => (mtime(b) >= mtime(a) ? b : a));
  const attempt = attempts.includes(wanted) ? wanted : newest;
  const stream = tail(resolve(dir, attempt, "stream.jsonl"));
  const raw = stream?.text ?? "";
  const stats = raw ? parseStream(raw) : null;
  const label = `${attempt.startsWith("integration") ? "merge-" : ""}${id}`;
  // agent-output.log is written when the attempt ends. On a `direct` lane that
  // means it belongs to an earlier run while a stream is live, so it is shown
  // only once this attempt has a result; on a herdr lane it is the ONLY file
  // the attempt leaves behind, and withholding it was most of "there is never a
  // log in these buttons".
  const ended = tail(resolve(dir, attempt, "agent-output.log"), 16 * 1024)
    ?.text?.trim() ?? "";
  if (raw)
    return {
      status: 200,
      body: {
        id,
        attempts,
        attempt,
        truncated: Boolean(stream?.truncated),
        bytes: stream?.size ?? 0,
        summary: format(label, stats),
        phases: phaseWalk(dir, attempt),
        timeline: timeline(raw, 200) || "(waiting for output)",
        output: stats?.result ? ended : "",
      },
    };

  // No stream: a herdr lane. Its pane is the live channel while the attempt is
  // the active one, and its captured scrollback is what is left afterwards.
  const state = json(".afk/state.json") ?? {};
  const live = liveAttempt(state, id);
  const pane = live?.name === attempt ? herdrPane(id, live.kind) : null;
  const scrollback = pane ? await readPane(pane) : null;
  const summary = scrollback
    ? `${label} [running] | herdr pane ${pane} — this runtime writes no stream, so this is the pane's last ${HERDR_LINES} lines`
    : ended
      ? `${label} [ended] | herdr lane — the pane is gone; this is the scrollback captured when the attempt finished`
      : format(label, null);
  return {
    status: 200,
    body: {
      id,
      attempts,
      attempt,
      truncated: false,
      bytes: 0,
      summary,
      phases: phaseWalk(dir, attempt),
      timeline: scrollback || ended || "(waiting for output)",
      output: scrollback && ended ? ended : "",
    },
  };
};

// ── who else is running on this machine ──────────────────────────────────
// `/health` is the contract the port scan already depends on, so the extra
// fields are additive: an older dashboard still answers `{ok, pid, root, port}`
// and the tab strip falls back to its directory name.
//
// `alive` is the ORCHESTRATOR's pid, not this server's. A dashboard outlives
// its run — that is the whole reason the page distinguishes running from stale
// — so a tab that said "alive" because a web server answered would be the same
// lie one level up.
const RUNNING_LIFECYCLES = new Set(["running", "integrating"]);

const runStatus = (state) => {
  if (pidAlive(state.orchestratorPid)) return "running";
  const frozen = Object.values(state.tasks ?? {}).some((task) =>
    RUNNING_LIFECYCLES.has(task?.lifecycle),
  );
  return frozen ? "stale" : "idle";
};

const healthReport = () => {
  const state = json(".afk/state.json") ?? {};
  const tasks = state.dag?.tasks ?? [];
  return {
    ok: true,
    pid: process.pid,
    root,
    port: PORT,
    project: projectName(),
    epic: state.dag?.epic ?? null,
    branch: state.dag?.branch ?? null,
    // The RUN's status, in the same three words the page shows at the top: a
    // dashboard answering says nothing about whether its run is still going,
    // and a frozen state file full of `running` tasks is stale, not idle.
    status: runStatus(state),
    progress: {
      total: tasks.length,
      passed: tasks.filter(
        (task) => COMPLETE_LIFECYCLES.has(state.tasks?.[task.id]?.lifecycle),
      ).length,
    },
    // #244: tasks per phase, for the hub's coloured bar. A sibling of
    // `progress`, not inside it, so nothing that reads `progress` changes.
    // Statuses come from the same merge `/state` uses (stale needs the pids);
    // no worktrees and no live stats, so a probe never shells out to git.
    counts: phaseCounts(
      state.dag
        ? mergeDashboardState({ ...state.dag, tasks: tasks.map((task) => ({ ...task })) }, state, [], pidAlive, {}).tasks
        : [],
    ),
  };
};

// Sweeping 400 ports costs a round of probes, so it is cached briefly: several
// open tabs polling at once must not turn into several sweeps a second.
const PEERS_TTL_MS = 10_000;
let peersCache = { at: 0, value: [] };
const peers = async () => {
  if (Date.now() - peersCache.at < PEERS_TTL_MS) return peersCache.value;
  const found = await discoverDashboards();
  peersCache = {
    at: Date.now(),
    value: found.map((peer) => ({ ...peer, self: peer.port === PORT })),
  };
  return peersCache.value;
};

const handler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const page = new URL(req.url, "http://localhost");
  if (page.pathname === "/" || page.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    const html = read("scripts/dashboard.html", runnerRoot);
    // #243: inside a hub tab (`?embed=1`) the hub's own tabs already switch
    // runs, so the page is marked and its peer strip hidden by CSS. Fails
    // open: if `<body>` ever gains an attribute the strip shows again, which
    // the `?embed=1` test in dashboard-port.test.mjs catches.
    res.end(page.searchParams.get("embed") === "1" ? html.replace("<body>", "<body data-embed>") : html);
    // `/state`, not `/manifest`: planning/manifest.json was dissolved and no
    // file of that name exists any more. `/manifest` still answers so a page
    // left open across the upgrade keeps refreshing instead of going blank.
  } else if (req.url === "/state" || req.url === "/manifest") {
    const data = merged();
    res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
    res.end(data ? JSON.stringify(data) : '{"error":"not found"}');
  } else if (req.url === "/log") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(await activity());
  } else if (req.url === "/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(roleRuns()));
  } else if (req.url.startsWith("/agent-log")) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const { status, body } = roleLog(query.get("id") ?? "");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } else if (req.url.startsWith("/task-log")) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const { status, body } = await taskLog(
      query.get("id") ?? "",
      query.get("attempt") ?? "",
    );
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } else if (serveMachineView(req, res)) {
    // /usage, /lanes and their pages: scripts/machine-views.mjs, shared with the hub.
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(healthReport()));
  } else if (req.url === "/peers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await peers()));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
};

const server = createServer(handler);
server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`Dashboard: port ${PORT} is already in use.`);
  process.exit(EXIT_PORT_IN_USE);
});
// The host the runner's /health probe dials (scripts/dashboard-process.mjs).
// Bound to `::` instead, macOS let this listen succeed beside another process
// on 127.0.0.1:<port>; the probe then reached that process, and a taken port
// read as a dashboard that never answered /health, so the port walk never ran.
// The printed link names the same host. Not `localhost`: it resolves to ::1
// first, and a process on `::` at this port (Node's default with no host) binds
// beside this one on macOS, so a `localhost` link opened that process instead.
server.listen(PORT, DASHBOARD_HOST, () => {
  console.log(`Dashboard: ${dashboardUrl(PORT)}`);
  // Read every lane transcript once, so the first /lanes answers from the disk
  // cache (cold read measured ~7s on 2,268 transcripts, 23s on ~15k). In a
  // worker: on this thread the read is synchronous and /health went unanswered
  // for its whole length, which failed the runner's start. The worker writes
  // the cache file; each /lanes worker (scripts/machine-views.mjs) loads it.
  const lanes = JSON.stringify(new URL("./lanes.mjs", import.meta.url).href);
  const warm = new Worker(
    `import(${lanes}).then((m) => { m.lanesReport(); m.compareLanes(); }).catch(() => {});`,
    { eval: true },
  );
  warm.on("error", () => {});
  warm.unref();
});

// The hub port (4099) belongs to `afk hub`, kept up by launchd (#226, #229).
// A dashboard never listens there: one that did held the port while the hub
// was down, or shared it on `::` so `localhost:4099` opened the old page (#237 H4).
