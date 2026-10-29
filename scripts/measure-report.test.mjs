// scripts/measure-report.test.mjs — `afk measure dashboard` and `afk measure
// report` over the docs/measure rows (#182).
//
// Every test writes its fixture to its own temp directory and points
// AFK_MEASURE_ROOT there: nothing here reads or writes the real docs/measure.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_FILE, GRAPHS, NUMBERS, buildDashboard, buildReport, epicPoints, readRows } from "./measure-report.mjs";
import { FIXTURE_EPICS, FIXTURE_EXPECTED, fixtureRows, writeFixture } from "./measure-report.fixture.mjs";

const AFK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "afk.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;

const tempRoot = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-measure-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const afk = (root, ...args) => spawnSync(process.execPath, [AFK, ...args], {
  encoding: "utf8",
  env: { ...process.env, AFK_MEASURE_ROOT: root },
});

test("report --json gives both values, the change and the direction for every number", (t) => {
  const root = writeFixture(tempRoot(t));
  const result = afk(root, "measure", "report", "--json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.days, 7);
  assert.equal(report.comparable, true);
  assert.deepEqual(report.windows.previous.epics, ["101", "102"]);
  assert.deepEqual(report.windows.current.epics, ["201", "202"]);
  assert.deepEqual(report.numbers.map((number) => number.key), NUMBERS.map((number) => number.key));
  for (const number of report.numbers) {
    const [previous, current, change, direction] = FIXTURE_EXPECTED[number.key];
    assert.deepEqual(
      [number.previous, number.current, number.change, number.direction],
      [previous, current, change, direction],
      number.key,
    );
  }
});

test("lower-is-better going down is an improvement; higher-is-better going down is a degradation", (t) => {
  const report = buildReport(readRows(writeFixture(tempRoot(t))));
  const falseReds = report.numbers.find((number) => number.key === "falseReds");
  const share = report.numbers.find((number) => number.key === "firstAttemptShare");
  assert.equal(falseReds.better, "lower");
  assert.ok(falseReds.change < 0);
  assert.equal(falseReds.direction, "improvement");
  assert.equal(share.better, "higher");
  assert.ok(share.change < 0);
  assert.equal(share.direction, "degradation");
});

test("an empty earlier window says there is nothing to compare and divides by nothing", (t) => {
  const now = Date.now();
  const rows = Object.values(fixtureRows(now)).flat().filter((row) => row.type === "close" && Date.parse(row.at) > now - 7 * DAY_MS);
  const report = buildReport(rows, { now });
  assert.equal(report.comparable, false);
  assert.deepEqual(report.windows.previous.epics, []);
  assert.match(report.note, /earlier window has no close rows, so there is nothing to compare/);
  for (const number of report.numbers) {
    assert.equal(number.previous, null, number.key);
    assert.equal(number.change, null, number.key);
    assert.equal(number.direction, "not comparable", number.key);
  }
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(report)));

  const root = tempRoot(t);
  writeFileSync(join(root, "alpha.jsonl"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const text = afk(root, "measure", "report");
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /Nothing to compare: the earlier window has no close rows/);
  assert.ok(!/NaN|Infinity/.test(text.stdout), text.stdout);
});

test("dashboard writes one svg per graph and names every fixture epic", (t) => {
  const root = writeFixture(tempRoot(t));
  const result = afk(root, "measure", "dashboard");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const path = join(root, DASHBOARD_FILE);
  assert.ok(existsSync(path), result.stdout);
  const html = readFileSync(path, "utf8");
  assert.equal(html.match(/<svg/g).length, GRAPHS.length);
  assert.equal(GRAPHS.length, 6);
  // In the order the ticket lists them.
  const order = GRAPHS.map((graph) => html.indexOf(`id="graph-${graph.id}"`));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), String(order));
  for (const epic of FIXTURE_EPICS) assert.ok(html.includes(`#${epic}`), `epic #${epic} missing`);
  for (const project of ["alpha", "beta"]) assert.ok(html.includes(`<option value="${project}">`), project);
  // No network from the page: no external script, stylesheet or image.
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")));
});

test("a close row with a null field does not throw and is not plotted as zero", (t) => {
  const rows = readRows(writeFixture(tempRoot(t)));
  const point = epicPoints(rows).find((entry) => entry.epicId === "202");
  assert.equal(point.values.falseReds, null);
  assert.equal(point.values.timesNeeded, null);
  assert.equal(point.values.hoursParked, null);
  assert.equal(point.values.mustFixFound, null);
  assert.equal(point.values.costUnitsPerLane, null);
  assert.equal(point.values.firstAttemptShare, 1);
  const html = buildDashboard(rows);
  const plotted = [...html.matchAll(/<title>([^<]*#202[^<]*)<\/title>/g)].map((match) => match[1]);
  assert.deepEqual(plotted.map((title) => title.replace(/^.*: /, "")), ["first-attempt pass share 1"]);
  assert.ok(!plotted.some((title) => /false reds/.test(title)));
});

test("a stop still parked makes hours parked unknown, not zero", () => {
  const hoursParked = NUMBERS.find((number) => number.key === "hoursParked");
  assert.equal(hoursParked.of({ stops: [{ kind: "unknown", parkedMs: null }] }), null);
  assert.equal(hoursParked.of({ stops: [{ parkedMs: 3_600_000 }, { parkedMs: null }] }), null);
  assert.equal(hoursParked.of({ stops: [{ parkedMs: 3_600_000 }] }), 1);
  assert.equal(hoursParked.of({ stops: [] }), 0);
});

test("gate and lane minutes read the close row's durations, and a row without them is a gap", () => {
  const of = (key, row) => NUMBERS.find((number) => number.key === key).of(row);
  assert.equal(of("gateMinutes", { gateMs: 120_000 }), 2);
  assert.equal(of("laneMinutes", { lanes: [{ durationMs: 60_000 }, { durationMs: 120_000 }] }), 3);
  assert.equal(of("gateMinutes", { gateRuns: { baseline: 1 } }), null);
  assert.equal(of("laneMinutes", { lanes: [{ durationMs: 60_000 }, { durationMs: null }] }), null);
});

test("afk --help and afk measure --help list both verbs", () => {
  for (const args of [["--help"], ["measure", "--help"]]) {
    const result = spawnSync(process.execPath, [AFK, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /measure dashboard/);
    assert.match(result.stdout, /measure report \[--days=N\] \[--json\]/);
  }
});

test("report refuses a --days that is not a whole number of days", (t) => {
  const result = afk(writeFixture(tempRoot(t)), "measure", "report", "--days=0");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /--days takes a whole number/);
});
