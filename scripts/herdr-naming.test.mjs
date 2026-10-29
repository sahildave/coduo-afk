// scripts/herdr-naming.test.mjs — the two things the operator's sidebar depends
// on: which transcript belongs to a lane, and what a row is called.
//
// Both were found by the first live epic run (docs/findings.md 3.6, 3.7).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { roleFor } from "./roles.mjs";

// The transcript probe is intentionally hermetic: the runtime reads the
// process home, and this test must not write into a user's real Claude data.
const testHome = mkdtempSync(join(tmpdir(), "afk-herdr-home-"));
const previousHome = process.env.HOME;
process.env.HOME = testHome;
const { laneLabel, parentLabel, runHerdrRole, transcriptFile } =
  await import("./runtime-herdr.mjs");
test.after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

// --- transcript binding -----------------------------------------------------

const transcriptDir = (cwd) =>
  resolve(testHome, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

test("a lane binds to the transcript carrying its own prompt, not the newest one", () => {
  // The merger runs with cwd = the repo root, which is exactly where a HUMAN's
  // Claude Code session in that repo writes its transcript. Newest-file-wins
  // bound the merger to the operator's own session: it reported their tokens as
  // the lane's, then read the word "auth" out of their conversation and declared
  // the login dead, failing an integration whose merge was never attempted.
  const cwd = mkdtempSync(join(tmpdir(), "afk-transcript-"));
  const dir = transcriptDir(cwd);
  mkdirSync(dir, { recursive: true });
  const promptPath = `${cwd}/.afk/runs/4/merger-1/prompt.md`;
  const mine = join(dir, "lane.jsonl");
  const human = join(dir, "human.jsonl");
  try {
    writeFileSync(mine, JSON.stringify({ text: `Read the file ${promptPath}` }) + "\n");
    // Written second, so it is strictly newer than the lane's own transcript.
    writeFileSync(human, JSON.stringify({ text: "we should fix the auth death path" }) + "\n");

    assert.equal(transcriptFile(cwd, 0, promptPath), mine);
    // And a lane whose agent has not spoken yet binds to NOTHING rather than
    // adopting whichever session happens to be active in the same directory.
    assert.equal(transcriptFile(cwd, 0, `${cwd}/.afk/runs/9/builder-1/prompt.md`), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- sidebar labels ---------------------------------------------------------

const repoWithEpic = (epic) => {
  const root = mkdtempSync(join(tmpdir(), "afk-label-"));
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ dag: { epic } }));
  return root;
};

const herdrFixture = ({ existingWorkspace = false, foreignFirst = false } = {}) => {
  const root = repoWithEpic({ id: "3", title: "Throwaway" });
  const bin = mkdtempSync(join(tmpdir(), "afk-herdr-bin-"));
  const log = join(bin, "herdr.log");
  const label = parentLabel(root);
  const report = join(root, ".afk-report.json");
  const started = join(bin, "agent-started");
  const startedPane = join(bin, "agent-pane");
  const stopped = join(bin, "agent-stopped");
  const ctrlCs = join(bin, "ctrl-c-count");
  writeFileSync(
    join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pair = args.slice(0, 2).join(" ");
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const out = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
const started = ${JSON.stringify(started)};
const startedPane = ${JSON.stringify(startedPane)};
const stopped = ${JSON.stringify(stopped)};
const ctrlCs = ${JSON.stringify(ctrlCs)};
if (pair === "workspace list") {
  out({ type: "workspace_list", workspaces: ${existingWorkspace
    ? `${foreignFirst ? `[{ workspace_id: "w-foreign", label: ${JSON.stringify(label)} }, ` : "["}{ workspace_id: "w-existing", label: ${JSON.stringify(label)} }]`
    : "[]"} });
} else if (pair === "workspace create") {
  out({ type: "workspace_created", workspace: { workspace_id: "w-created" }, root_pane: { pane_id: "w-created:p1" } });
} else if (pair === "pane list") {
  const workspace = args[args.indexOf("--workspace") + 1];
  out({ type: "pane_list", panes: [{ pane_id: workspace + ":p1", cwd: workspace === "w-foreign" ? "/another/repository" : ${JSON.stringify(root)} }] });
} else if (pair === "agent prompt") {
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ status: "done" }));
  out({ type: "agent_prompted" });
} else if (pair === "agent start") {
  fs.writeFileSync(started, "1");
  fs.writeFileSync(startedPane, args[args.indexOf("--pane") + 1]);
  out({ type: "agent_started", agent: { pid: 4242 } });
} else if (pair === "agent send-keys") {
  if (fs.existsSync(started) && args[2] === fs.readFileSync(startedPane, "utf8") && args[3] === "ctrl+c") {
    const count = (Number(fs.existsSync(ctrlCs) ? fs.readFileSync(ctrlCs, "utf8") : 0) || 0) + 1;
    fs.writeFileSync(ctrlCs, String(count));
    if (count >= 2) fs.writeFileSync(stopped, "1");
  }
  out({ type: "agent_keypress" });
} else if (pair === "agent wait" || pair === "agent get") {
  if (fs.existsSync(stopped)) {
    process.stderr.write('{"error":{"code":"agent_not_found"}}');
    process.exit(1);
  }
  out({ type: pair === "agent get" ? "agent_info" : "wait_matched", agent: { status: "idle" } });
} else if (pair === "pane read") {
  out({ type: "pane_read", text: "" });
} else {
  out({ type: "ok" });
}
`,
    { mode: 0o755 },
  );
  return { root, bin, log };
};

const herdrCalls = (fx) =>
  readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean);

const runIntegrator = async (fx) => {
  const previousPath = process.env.PATH;
  process.env.PATH = `${fx.bin}:${previousPath}`;
  try {
    return await runHerdrRole({
      role: roleFor("integrator"),
      root: fx.root,
      task: { id: "57", title: "Name merger panes" },
      worktree: fx.root,
      agent: { model: "claude-opus-5", settings: null, timeoutMs: 10_000 },
      promptPath: join(fx.root, "prompt.md"),
      attempt: 1,
      say: () => {},
    });
  } finally {
    process.env.PATH = previousPath;
  }
};

test("a merger pane label carries the task id and attempt", async () => {
  const fx = herdrFixture();
  try {
    const result = await runIntegrator(fx);
    assert.equal(result.status, 0);
    const paneRename = herdrCalls(fx).find((call) => call.startsWith("pane rename "));
    assert.match(paneRename ?? "", /afk-merge-57-1/);
    assert.match(paneRename ?? "", /57/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.bin, { recursive: true, force: true });
  }
});

test("a relaunch adopts an existing same-label parent instead of creating a sibling", async () => {
  const fx = herdrFixture({ existingWorkspace: true });
  try {
    await runIntegrator(fx);
    const calls = herdrCalls(fx);
    assert.ok(calls.includes("workspace list"), `parent lookup was not attempted:\n${calls.join("\n")}`);
    assert.ok(calls.includes("pane list --workspace w-existing"), `existing parent pane was not adopted:\n${calls.join("\n")}`);
    assert.equal(calls.filter((call) => call.startsWith("workspace create ")).length, 0, `a sibling parent was created:\n${calls.join("\n")}`);
    const registry = JSON.parse(readFileSync(join(fx.root, ".afk", "herdr.json"), "utf8"));
    assert.equal(registry.parentWorkspaceId, "w-existing");
    assert.equal(registry.parentPaneId, "w-existing:p1");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.bin, { recursive: true, force: true });
  }
});

test("same labels in two repositories adopt only the parent rooted in this checkout", async () => {
  const fx = herdrFixture({ existingWorkspace: true, foreignFirst: true });
  try {
    await runIntegrator(fx);
    const calls = herdrCalls(fx);
    assert.ok(calls.includes("pane list --workspace w-foreign"));
    assert.ok(calls.includes("pane list --workspace w-existing"));
    assert.equal(calls.some((call) => call.startsWith("workspace create ")), false);
    const registry = JSON.parse(readFileSync(join(fx.root, ".afk", "herdr.json"), "utf8"));
    assert.equal(registry.parentWorkspaceId, "w-existing");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.bin, { recursive: true, force: true });
  }
});

test("the epic row drops the redundant `Epic:` prefix and clips on a word", () => {
  const root = repoWithEpic({ id: "3", title: "Epic: throwaway run to validate afk epic end to end" });
  const label = parentLabel(root);
  assert.ok(!/Epic:/i.test(label), label);
  assert.match(label, /^#3 · throwaway run/);
  assert.ok(label.length <= 39, `${label} (${label.length})`);
  // Clipped between words: what survives must end exactly where a word ends in
  // the untruncated string, never part-way through one.
  const full = "#3 · throwaway run to validate afk epic end to end";
  const kept = label.slice(0, -1);
  assert.ok(full.startsWith(kept), `${kept} is not a prefix of ${full}`);
  assert.equal(full[kept.length], " ");
  rmSync(root, { recursive: true, force: true });
});

test("a lane row keeps the epic prefix, because the agents panel is flat", () => {
  const root = repoWithEpic({ id: "3", title: "Throwaway" });
  const label = laneLabel(root, { id: "4", title: "Define the runner's vocabulary in docs/glossary.md" });
  assert.match(label, /^3\/#4 · Define the runner/);
  assert.ok(label.length <= 39, `${label} (${label.length})`);
  rmSync(root, { recursive: true, force: true });
});

test("a short title is left exactly alone", () => {
  const root = repoWithEpic({ id: "3", title: "Throwaway" });
  assert.equal(parentLabel(root), "#3 · Throwaway");
  assert.equal(laneLabel(root, { id: "4", title: "Glossary" }), "3/#4 · Glossary");
  rmSync(root, { recursive: true, force: true });
});
