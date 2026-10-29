// The calibration command (#294), run offline: a faked `gh` and a faked Jev.
// The real run happens at the acceptance gate, because lanes have no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./jev-calibrate.mjs";

const ISSUES = [
  { repo: "owner/afk-claude", number: 501, outcome: "first_try" },
  { repo: "owner/afk-claude", number: 502, outcome: "needed_human" },
];

const fakeGh = () => {
  const commands = [];
  const exec = (command) => {
    commands.push(command);
    const number = /issue view '?(\d+)'?/.exec(command)?.[1];
    return { status: 0, stdout: JSON.stringify({ title: `ticket ${number}`, body: `body of ${number}` }), stderr: "" };
  };
  return { commands, exec };
};

// 501 is a small, well-specified ticket whose scope Jev reads by MEANING: it
// picks "one file and its test" wherever that level sits. 502's answer follows
// the POSITION instead: it always picks the first level, so reversing the list
// flips it from scope 0 to scope 2 — exactly what the diff is there to show.
const fakeJev = () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const ticket = body.state.ticket.title;
    const levels = body.questions.scope.criteria;
    const meaning = Object.keys(levels).find((key) => /One file/.test(levels[key]));
    const score = ticket === "ticket 501" ? Number(meaning) : 0;
    const noul = (value) => ({ noul: value });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.14.2",
        answers: {
          sensitive: noul(0.05), format: noul(0.1), shared_interface: noul(0.1), unknown_cause: noul(0.05),
          pattern_named: noul(0.9), concrete_criteria: noul(0.8),
          scope: { score, confidence: 0.85 },
        },
      }),
    };
  };
  return { requests, fetchImpl };
};

test("the calibration command writes the table, the reversed run, and the tickets whose tier changed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-jev-calibrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issuesPath = join(dir, "issues.json");
  const outPath = join(dir, "report.md");
  writeFileSync(issuesPath, JSON.stringify(ISSUES));
  const gh = fakeGh();
  const jev = fakeJev();
  const code = await main(["--issues", issuesPath, "--out", outPath], {
    exec: gh.exec, fetchImpl: jev.fetchImpl, env: { TYPESAFE_API_KEY: "k" }, error: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(gh.commands, [
    "gh issue view '501' --repo 'owner/afk-claude' --json title,body",
    "gh issue view '502' --repo 'owner/afk-claude' --json title,body",
  ]);
  assert.equal(jev.requests.length, 4, "each ticket asked twice: levels in order, then reversed");
  assert.equal(jev.requests[0].state.ticket.body, "body of 501");
  const report = readFileSync(outPath, "utf8");
  assert.match(report, /reported: `jev-1\.14\.2` — pin `JEV_MODEL`/);
  const [inOrder, reversed, changed] = report.split(/^## /m).slice(1);
  assert.match(inOrder, /^Score levels in order/);
  assert.match(inOrder, /\| Ticket \| Answers \| Tier \| Outcome \|/);
  assert.match(inOrder, /\| owner\/afk-claude#501 \| sensitive 0\.05, format 0\.10, shared_interface 0\.10, pattern_named 0\.90, concrete_criteria 0\.80, unknown_cause 0\.05, scope 0 \(confidence 0\.85\) \| routine \| first_try \|/);
  assert.match(inOrder, /\| owner\/afk-claude#502 \| .*scope 0 \(confidence 0\.85\) \| routine \| needed_human \|/);
  assert.match(reversed, /^Score levels reversed/);
  assert.match(reversed, /\| owner\/afk-claude#501 \| .*scope 0 \(confidence 0\.85\) \| routine \| first_try \|/);
  assert.match(reversed, /\| owner\/afk-claude#502 \| .*scope 2 \(confidence 0\.85\) \| critical \| needed_human \|/);
  assert.match(changed, /^Tier changed when the levels were reversed/);
  assert.match(changed, /\| owner\/afk-claude#502 \| routine \| critical \|/);
  assert.doesNotMatch(changed, /#501/);
});

test("the calibration command needs a key and a valid issue list", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-jev-calibrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issuesPath = join(dir, "issues.json");
  writeFileSync(issuesPath, JSON.stringify([{ repo: "a/b", number: 1, outcome: "maybe" }]));
  const errors = [];
  const error = (line) => errors.push(line);
  assert.equal(await main([], { env: { TYPESAFE_API_KEY: "k" }, error }), 2);
  assert.equal(await main(["--issues", issuesPath], { env: {}, error }), 1);
  assert.equal(await main(["--issues", issuesPath], { env: { TYPESAFE_API_KEY: "k" }, exec: fakeGh().exec, fetchImpl: fakeJev().fetchImpl, error }), 1);
  assert.match(errors.join("\n"), /TYPESAFE_API_KEY is not set/);
  assert.match(errors.join("\n"), /outcome "maybe"/);
});

test("the calibration command asks at most four tickets at once, and a 429 row reads as skipped, not as a verdict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-jev-calibrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issuesPath = join(dir, "issues.json");
  const outPath = join(dir, "report.md");
  writeFileSync(issuesPath, JSON.stringify(Array.from({ length: 12 }, (_, index) => (
    { repo: "owner/afk-claude", number: 600 + index, outcome: "first_try" }))));
  const jev = fakeJev();
  let inFlight = 0;
  let most = 0;
  const fetchImpl = async (url, init) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (JSON.parse(init.body).state.ticket.title === "ticket 603") return { ok: false, status: 429, json: async () => ({}) };
    return jev.fetchImpl(url, init);
  };
  const code = await main(["--issues", issuesPath, "--out", outPath], {
    exec: fakeGh().exec, fetchImpl, env: { TYPESAFE_API_KEY: "k" }, error: () => {},
  });
  assert.equal(code, 0);
  assert.equal(jev.requests.length, 22, "every other ticket asked twice");
  assert.ok(most <= 4, `at most four Jev requests in flight, saw ${most}`);
  const report = readFileSync(outPath, "utf8");
  assert.match(report, /\| owner\/afk-claude#603 \| router skipped: Jev answered 429 \(rate limited\) \| skipped \| first_try \|/);
  assert.doesNotMatch(report, /#603 \|[^\n]*\| critical \|/);
});
