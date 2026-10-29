// scripts/forecast.test.mjs — the stop forecast (#191, epic #190).
//
// The pure module is called directly; `afk validate` and `afk epic` are spawned
// through afk.mjs with `gh` and `claude` replaced by scripts on PATH, so nothing
// here reaches the network or a model. The fake `claude` answers the plan
// review with no findings and records that it ran.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildForecast, declaredGates, unattendedVerdict, withReviewStops } from "./forecast.mjs";
import { parseEpicBlock, validateEpicSpec } from "./epic-spec.mjs";
import { renderValidation, validateEpic } from "./epic.mjs";
import { writeConfig } from "./test-helpers.mjs";

const AFK = fileURLToPath(new URL("../afk.mjs", import.meta.url));

// Eight tasks. #204 is a `gate: before` root with two transitive dependants
// (#205, then #208); #211 is a `gate: after` leaf. Nothing else is gated.
const blockFor = ({ stops = null, gate204 = "before" } = {}) => [
  "```yaml",
  "afk:",
  "  version: 1",
  "  branch: feat/203-stripe-subscriptions",
  "  tasks:",
  "    204:",
  "      depends_on: []",
  ...(gate204 ? [`      gate: ${gate204}`] : []),
  "    205:",
  "      depends_on: [204]",
  "    206:",
  "      depends_on: []",
  "    207:",
  "      depends_on: [206]",
  "    208:",
  "      depends_on: [205]",
  "    209:",
  "      depends_on: [206]",
  "    210:",
  "      depends_on: [207]",
  "    211:",
  "      depends_on: [209]",
  "      gate: after",
  ...(stops ? ["  stops:", ...Object.entries(stops).map(([id, value]) => `    ${id}: ${value}`)] : []),
  "```",
].join("\n");

const IDS = ["204", "205", "206", "207", "208", "209", "210", "211"];
const CHILDREN = IDS.map((id) => ({
  number: Number(id),
  title: `Task ${id}`,
  state: "OPEN",
  body: `## Acceptance criteria\n\n- \`file-${id}.txt\` exists.\n`,
}));
const epicOf = (body) => ({ number: 203, title: "Stripe subscriptions", body, children: CHILDREN });
const noBranch = () => ({ exists: false });
const CONFIG = { maxParallel: 2, defaultChecks: ["true"], launchStatus: "pre-launch", roles: { implementer: { always: [] } } };

const specOf = (options) => parseEpicBlock(blockFor(options));

// ---------------------------------------------------------------------------
// The pure forecast
// ---------------------------------------------------------------------------

test("an 8-task epic with a before root and an after leaf forecasts two stops, 3 of 8 parked", () => {
  const forecast = buildForecast({ spec: specOf(), config: CONFIG });
  assert.deepEqual(forecast.launchStatus, { value: "pre-launch", declared: true });
  assert.equal(forecast.stops.length, 2);
  const [before, after] = forecast.stops;
  assert.deepEqual(before, {
    task: "204",
    kind: "gate_before",
    blocks: ["204", "205", "208"],
    share: 0.375,
    note: "needs two launches: --task=204, then a plain relaunch",
    answer: null,
  });
  assert.deepEqual(after, {
    task: "211",
    kind: "gate_after",
    blocks: [],
    share: 0,
    note: "the epic cannot close until #211 is accepted",
    answer: null,
  });
  assert.deepEqual(forecast.parked, { tasks: 3, total: 8, share: 0.375 });
  assert.equal(forecast.unanswered, 2);
});

test("two before stops whose dependants overlap count each shared task once", () => {
  const spec = {
    tasks: {
      1: { gate: "before" },
      2: { gate: "before" },
      3: { depends_on: ["1", "2"] },
      4: { depends_on: ["3"] },
      5: {},
    },
  };
  const forecast = buildForecast({ spec, config: CONFIG });
  assert.deepEqual(forecast.stops.map((stop) => stop.blocks), [["1", "3", "4"], ["2", "3", "4"]]);
  assert.deepEqual(forecast.parked, { tasks: 4, total: 5, share: 0.8 });
});

test("the gate computation reads a DAG and a spec the same way", () => {
  const dag = {
    tasks: [
      { id: "1", dependsOn: [] },
      { id: "2", dependsOn: ["1"], humanGated: true },
      { id: "3", dependsOn: ["2"] },
      { id: "4", dependsOn: ["3"], gateAfter: true },
    ],
  };
  const spec = { tasks: { 1: {}, 2: { depends_on: ["1"], gate: "before" }, 3: { depends_on: ["2"] }, 4: { depends_on: ["3"], gate: "after" } } };
  const expected = [
    { taskId: "2", gate: "before", blocked: ["2", "3", "4"] },
    { taskId: "4", gate: "after", blocked: [] },
  ];
  assert.deepEqual(declaredGates(dag), expected);
  assert.deepEqual(declaredGates(spec), expected);
});

// ---------------------------------------------------------------------------
// `stops:` answers
// ---------------------------------------------------------------------------

test("park and delegate answers are accepted and appear on their stops", () => {
  const spec = specOf({ stops: { 204: "park", 211: '"delegate: zero must-fix left after the fixer"' } });
  const result = validateEpicSpec(spec);
  assert.deepEqual(result.errors, []);
  const forecast = buildForecast({ spec, config: CONFIG });
  assert.deepEqual(forecast.stops[0].answer, { kind: "park" });
  assert.deepEqual(forecast.stops[1].answer, { kind: "delegate", condition: "zero must-fix left after the fixer" });
  assert.equal(forecast.unanswered, 0);
});

test("an unknown value, a short delegate condition and a key that is not a task are each refused by task", () => {
  const cases = [
    [{ 204: "later" }, "204", /"later" is not an answer/],
    [{ 211: '"delegate: ok"' }, "211", /shorter than 10 characters/],
    [{ 999: "park" }, "999", /`999` is not a task in this block/],
  ];
  for (const [stops, taskId, message] of cases) {
    const { errors } = validateEpicSpec(specOf({ stops }));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].code, "stops");
    assert.equal(errors[0].taskId, taskId);
    assert.match(errors[0].message, new RegExp(taskId));
    assert.match(errors[0].message, message);
  }
});

test("`last` on a stop with an ungated dependant is refused; on a leaf gate it passes", () => {
  const refused = validateEpicSpec(specOf({ stops: { 204: "last" } }));
  assert.equal(refused.errors.length, 1);
  assert.equal(refused.errors[0].taskId, "204");
  assert.match(refused.errors[0].message, /#205, #208 have no stop of their own/);
  const passed = validateEpicSpec(specOf({ stops: { 211: "last" } }));
  assert.deepEqual(passed.errors, []);
});

test("`last` on a needs_human stop with an ungated dependant is refused and left unanswered; on a leaf it holds", () => {
  const raise = (task) => ({ kind: "needs_human", tasks: [task], evidence: "the client signs the DPA" });
  const spec = specOf({ stops: { 206: "last", 210: "last" } });
  const forecast = withReviewStops(buildForecast({ spec, config: CONFIG }), { spec, findings: [raise("206"), raise("210")] });
  const byTask = new Map(forecast.stops.map((stop) => [stop.task, stop]));
  assert.equal(byTask.get("206").answer, null, "#207 and #209 wait behind #206 with no stop of their own");
  assert.match(byTask.get("206").note, /`last` refused: #207, #209 wait behind it with no stop of their own/);
  assert.deepEqual(byTask.get("210").answer, { kind: "last" });
  assert.equal(unattendedVerdict({ report: { ok: true, forecast }, review: { ok: true } }).ok, false);
});

test("an answer on a task with no declared stop is a warning, not an error", () => {
  const result = validateEpicSpec(specOf({ stops: { 206: "park" } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map((warning) => [warning.code, warning.taskId]), [["stop_without_gate", "206"]]);
});

test("two epic bodies that differ only in stops: hash to the same graph shape", () => {
  const plain = validateEpic({ epic: epicOf(blockFor()), config: CONFIG, branchStatus: noBranch });
  const answered = validateEpic({ epic: epicOf(blockFor({ stops: { 204: "park", 211: "last" } })), config: CONFIG, branchStatus: noBranch });
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
  assert.equal(answered.ok, true, JSON.stringify(answered.errors));
  assert.ok(plain.graphShapeHash);
  assert.equal(answered.graphShapeHash, plain.graphShapeHash);
});

// ---------------------------------------------------------------------------
// Launch status
// ---------------------------------------------------------------------------

test("launchStatus: pre-launch heads the forecast; a missing key warns; beta is refused", () => {
  const declared = validateEpic({ epic: epicOf(blockFor()), config: CONFIG, branchStatus: noBranch });
  assert.match(renderValidation(declared), /^Stop forecast \(launch status: pre-launch\):$/m);
  assert.ok(!declared.warnings.some((warning) => warning.code === "no_launch_status"));

  const { launchStatus: _, ...undeclaredConfig } = CONFIG;
  const missing = validateEpic({ epic: epicOf(blockFor()), config: undeclaredConfig, branchStatus: noBranch });
  assert.equal(missing.ok, true);
  assert.match(renderValidation(missing), /^Stop forecast \(launch status: not declared, treated as launched\):$/m);
  const warning = missing.warnings.find((entry) => entry.code === "no_launch_status");
  assert.ok(warning, "no_launch_status warning");
  assert.match(warning.message, /launch status: not declared, treated as launched/);

  const beta = validateEpic({ epic: epicOf(blockFor()), config: { ...CONFIG, launchStatus: "beta" }, branchStatus: noBranch });
  assert.equal(beta.ok, false);
  assert.ok(beta.errors.some((error) => error.code === "launch_status" && /"beta"/.test(error.message)));
});

test("an epic with no gate prints `no declared stop` and the UNATTENDED line", () => {
  const report = validateEpic({ epic: epicOf(blockFor({ gate204: null }).replace("      gate: after\n", "")), config: CONFIG, branchStatus: noBranch });
  const text = renderValidation(report);
  assert.match(text, /^Stop forecast: no declared stop\.$/m);
  assert.match(text, /^UNATTENDED: not checked\. Run `afk validate 203 --unattended` before saying nobody will be needed\.$/m);
});

// ---------------------------------------------------------------------------
// The CLI, spawned
// ---------------------------------------------------------------------------

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.AFK_TEST_AGENT_LOG, 'ran\\n');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const fence = String.fromCharCode(96, 96, 96);
  const report = fence + 'json\\n' + JSON.stringify({ findings: [] }) + '\\n' + fence;
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: report }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: report }) + '\\n');
});
`;

const cliFixture = (t, { body, config = CONFIG }) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-forecast-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "work");
  const bin = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const payload = join(dir, "epic.json");
  writeFileSync(payload, JSON.stringify({
    data: { repository: { issue: {
      number: 203, title: "Stripe subscriptions", state: "OPEN", body,
      subIssues: { totalCount: CHILDREN.length, nodes: CHILDREN },
    } } },
  }));
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    `  "api graphql") cat ${JSON.stringify(payload)} ;;`,
    '  "repo view") echo "owner/forecast" ;;',
    '  "pr list") echo "[]" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "runner@example.test");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, ".gitignore"), ".afk/\n");
  writeConfig(repo, { ...config, agent: { command: "claude", timeoutMs: 30_000 } });
  git("add", ".");
  git("commit", "-m", "base");
  const agentLog = join(dir, "agent.log");
  const afk = (...args) => {
    const result = spawnSync(process.execPath, [AFK, ...args, "--repo=owner/forecast"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        AFK_BACKEND: "claude",
        AFK_TEST_AGENT_LOG: agentLog,
        PATH: `${bin}:${process.env.PATH}`,
        AFK_WORKTREE_ROOT: join(dir, "worktrees"),
        AFK_EPIC_ROOT: join(dir, "epics"),
      },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, said: `${result.stdout}${result.stderr}` };
  };
  return { repo, git, afk, agentRan: () => existsSync(agentLog) };
};

test("plain afk validate prints the stop forecast and the UNATTENDED line, ends VALIDATE: ok, exits 0", (t) => {
  const fx = cliFixture(t, { body: blockFor({ stops: { 204: "park" } }) });
  const result = fx.afk("validate", "203");
  assert.equal(result.code, 0, result.said);
  const out = result.stdout;
  const section = out.slice(out.indexOf("Stop forecast"), out.indexOf("UNATTENDED"));
  assert.equal(section, [
    "Stop forecast (launch status: pre-launch):",
    "  #204 gate: before. Parks 3 of 8 tasks (#204, #205, #208). Needs two launches: --task=204, then a plain relaunch. Answer: park.",
    "  #211 gate: after. The epic cannot close until #211 is accepted. Answer: none.",
    "  3 of 8 tasks (38%) cannot start until a human acts. 1 stop unanswered.",
    "  Answer each stop in the afk: block's stops: key (park, last, delegate: <condition>). Deciding now is a plan edit: drop the gate or write the decision into the ticket, and the stop leaves the forecast.",
    "",
  ].join("\n"));
  assert.match(out, /^UNATTENDED: not checked\. Run `afk validate 203 --unattended` before saying nobody will be needed\.$/m);
  assert.equal(out.trim().split("\n").at(-1), "VALIDATE: ok. Nothing was created.");
  // Plain validate is offline and token-free: the plan reviewer never ran.
  assert.equal(fx.agentRan(), false);
  if (process.env.AFK_FORECAST_PRINT) console.log(out);
});

test("afk validate --unattended refuses an unanswered stop by name, and is ready once every stop is answered", (t) => {
  const open = cliFixture(t, { body: blockFor({ stops: { 204: "park" } }) });
  const refused = open.afk("validate", "203", "--unattended");
  assert.notEqual(refused.code, 0, refused.said);
  const last = refused.stdout.trim().split("\n").at(-1);
  assert.match(last, /^UNATTENDED: refused: 1 stop unanswered \(#211\)\. Nothing was created\.$/);
  assert.doesNotMatch(refused.stdout, /UNATTENDED: not checked/);

  const answered = cliFixture(t, { body: blockFor({ stops: { 204: "park", 211: '"delegate: zero must-fix left after the fixer"' } }) });
  const ready = answered.afk("validate", "203", "--unattended");
  assert.equal(ready.code, 0, ready.said);
  assert.equal(answered.agentRan(), true, "--unattended runs the plan review");
  assert.equal(ready.stdout.trim().split("\n").at(-1), "UNATTENDED: ready. 2 stops, all answered.");
  assert.match(ready.stdout, /Answer: delegate: zero must-fix left after the fixer \(delegated, parks until delegated acceptance ships\)\./);
});

test("afk epic --unattended with an unanswered stop refuses and leaves no epic branch", (t) => {
  const fx = cliFixture(t, { body: blockFor({ stops: { 204: "park" } }) });
  const result = fx.afk("epic", "203", "--unattended");
  assert.notEqual(result.code, 0, result.said);
  assert.match(result.said, /UNATTENDED: refused: 1 stop unanswered \(#211\)\. No branch, worktree or pull request was created\./);
  assert.doesNotMatch(fx.git("branch", "--list").stdout, /stripe-subscriptions/);
  assert.equal(existsSync(join(fx.repo, ".afk", "state.json")), false);
});

test("afk validate --json carries the forecast", (t) => {
  const fx = cliFixture(t, { body: blockFor({ stops: { 204: "park" } }) });
  const result = fx.afk("validate", "203", "--json");
  assert.equal(result.code, 0, result.said);
  const { forecast } = JSON.parse(result.stdout);
  assert.deepEqual(forecast.launchStatus, { value: "pre-launch", declared: true });
  assert.deepEqual(forecast.parked, { tasks: 3, total: 8, share: 0.375 });
  assert.equal(forecast.unanswered, 1);
  for (const stop of forecast.stops) {
    assert.deepEqual(Object.keys(stop).sort(), ["answer", "blocks", "kind", "note", "share", "task"]);
  }
  assert.deepEqual(forecast.stops.map((stop) => [stop.task, stop.kind, stop.answer]), [
    ["204", "gate_before", { kind: "park" }],
    ["211", "gate_after", null],
  ]);
  assert.equal(fx.agentRan(), false);
});
