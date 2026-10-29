// scripts/merge.test.mjs — `afk merge`, the guarded merge (#189).
//
// No test here calls GitHub: `gh` is `fakeGh`, which answers only the calls
// the test scripted and throws on anything else, so a write nobody planned for
// — a `pr merge` in a refusal test, say — fails the test instead of reaching
// GitHub. `git` is real, against throwaway repositories with a local bare
// `origin`, so `trial-merge`, `pr-head` and the branch delete run for real but
// never anywhere that matters. The measure root, the merge lock and the
// acceptance root are all temp directories.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeVerb, verdictMarker } from "./merge.mjs";
import { closeoutGatePath, fixerReportPath } from "./fixer.mjs";
import { verifierReportPath } from "./verifier.mjs";
import { prMarker } from "./pr.mjs";

const EPIC = "186";
const REPO = "acme/app";
const PR = 42;
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "afk-merge-verb-")));
process.env.AFK_MEASURE_ROOT = join(SCRATCH, "measure");
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const WRITES = /^gh (pr (merge|ready|comment|close|edit)|issue (close|comment|edit)|api (?!graphql))/;
// The reads a dry run is allowed to make; anything else fails the test.
const READS = /^gh (issue view|pr list|pr view|pr checks|api graphql) /;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const writeFile = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const commit = (root, files, message) => {
  for (const [path, content] of Object.entries(files)) writeFile(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/**
 * A run root on branch `feat`, pushed to a bare `origin` that holds `main`,
 * with a closeout review, a fixer report and its gate at the head, and a run
 * state where every task passed and the one `gate: after` is accepted.
 */
const makeRun = ({
  headFiles = { "src/app.js": "export const app = 1;\n" },
  mainAfter = null,
  mustFix = ["src/app.js returns the wrong value"],
  left = [],
  state: stateEdit = (state) => state,
} = {}) => {
  const dir = mkdtempSync(join(SCRATCH, "run-"));
  const origin = join(dir, "origin.git");
  const root = join(dir, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "runner@example.test");
  git(root, "config", "user.name", "Runner Test");
  git(root, "remote", "add", "origin", origin);
  const base = commit(root, { ".gitignore": ".afk/\n", "README.md": "base\n", "shared.txt": "base\n" }, "base");
  git(root, "push", "-q", "origin", "main");
  if (mainAfter) {
    commit(root, mainAfter, "main moved");
    git(root, "push", "-q", "origin", "main");
    git(root, "reset", "-q", "--hard", base);
  }
  git(root, "checkout", "-q", "-b", "feat");
  const head = commit(root, headFiles, "feature");
  git(root, "push", "-q", "origin", "feat");

  writeFile(verifierReportPath(root, EPIC), {
    version: 1, status: "ok", head, ranAt: "2026-10-05T01:00:00.000Z", mustFix, findings: [], criteria: [],
  });
  const items = mustFix.map((title, index) => ({ id: `F${index + 1}`, source: "must-fix", title }));
  writeFile(fixerReportPath(root, EPIC), {
    version: 1, status: "ok", head, reviewHead: head, items,
    fixed: items.filter((item) => !left.includes(item.title)).map((item) => ({ id: item.id, title: item.title, detail: "fixed", files: ["src/app.js"] })),
    deferred: items.filter((item) => left.includes(item.title)).map((item) => ({ id: item.id, title: item.title, reason: "could not reproduce it", kind: "open" })),
  });
  writeFile(closeoutGatePath(root, EPIC), { status: "no_commit", head, headBefore: head, fixSha: null, checks: ["true"], ranAt: "2026-10-05T01:05:00.000Z" });

  const state = stateEdit({
    branch: "feat",
    epic: { id: EPIC },
    dag: {
      epic: { id: EPIC },
      branch: "feat",
      tasks: [
        { id: "190", title: "build it", dependsOn: [] },
        { id: "191", title: "accept it", dependsOn: ["190"], gateAfter: true },
      ],
    },
    tasks: { 190: { lifecycle: "passed" }, 191: { lifecycle: "passed" } },
    epicClose: {
      lifecycle: "closed",
      verifier: { head, ranAt: "2026-10-05T01:00:00.000Z", recommendation: "must-fix" },
      acceptances: { 191: { by: "human", at: "2026-10-05T02:00:00.000Z" } },
    },
  });
  writeFile(join(root, ".afk", "state.json"), state);
  return { dir, root, origin, head };
};

const CONFIG = { oneWayDoors: { migrations: ["migrations/**"] }, launchStatus: "pre-launch" };

/** A `gh` that answers only what the test scripted, and throws on anything else. */
const fakeGh = (script) => {
  const calls = [];
  const comments = [];
  const exec = (command) => {
    calls.push(command);
    const hit = script.find(([pattern]) => pattern.test(command));
    if (!hit) throw new Error(`unscripted gh call: ${command}`);
    if (/^gh pr comment /.test(command)) {
      const file = /--body-file '([^']+)'/.exec(command)?.[1];
      comments.push(readFileSync(file, "utf8"));
    }
    const answer = typeof hit[1] === "function" ? hit[1](command) : hit[1];
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { exec, calls, comments };
};

const prJson = (fx, extra = {}) => JSON.stringify({
  number: PR,
  url: `https://github.com/${REPO}/pull/${PR}`,
  state: "OPEN",
  isDraft: true,
  headRefOid: fx.head,
  baseRefName: "main",
  body: `${prMarker(EPIC)}\nThe epic's PR.`,
  ...extra,
});
const MERGED_PRS = JSON.stringify({ data: { repository: { pullRequests: { nodes: [
  { number: 40, mergeCommit: { messageHeadline: "Merge pull request #40 from x/y", parents: { totalCount: 2 } } },
  { number: 39, mergeCommit: { messageHeadline: "Merge pull request #39 from x/y", parents: { totalCount: 2 } } },
  { number: 38, mergeCommit: { messageHeadline: "Tidy (#38)", parents: { totalCount: 1 } } },
] } } } });
const MERGE_SHA = "feedfacefeedfacefeedfacefeedfacefeedface";

/** Every read and write a full merge makes. `overrides` replace by pattern source. */
const script = (fx, { checks = [{ name: "test", state: "SUCCESS" }], pr = {}, comments = [], omit = [] } = {}) => {
  const rows = [
    [/^gh pr list /, { stdout: JSON.stringify([{ number: PR, state: "OPEN", isDraft: true }]) }],
    [/^gh pr view 42 .*--json number,url/, { stdout: prJson(fx, pr) }],
    [/^gh pr view 42 .*--json comments/, { stdout: JSON.stringify({ comments }) }],
    [/^gh pr view 42 .*--json mergeCommit,mergedAt/, { stdout: JSON.stringify({ mergeCommit: { oid: MERGE_SHA }, mergedAt: "2026-10-06T03:00:00Z" }) }],
    [/^gh pr checks /, typeof checks === "function" ? checks : { stdout: JSON.stringify(checks) }],
    [/^gh api graphql /, { stdout: MERGED_PRS }],
    [/^gh pr comment /, {}],
    [/^gh pr ready /, {}],
    [/^gh pr merge /, {}],
    [/^gh issue close /, {}],
    [/^gh issue comment /, {}],
  ];
  return rows.filter(([pattern]) => !omit.some((prefix) => pattern.source.includes(prefix)));
};

const drive = async (fx, { gh, config = CONFIG, env = {}, lockPath = join(fx.dir, "merge.lock"), ...rest } = {}) => {
  const lines = [];
  const code = await mergeVerb({
    epic: EPIC, repo: REPO, root: fx.root, exec: gh.exec, env, config, lockPath,
    acceptanceRoot: join(fx.dir, "acceptance"), log: (line) => lines.push(line), ...rest,
  });
  return { code, out: lines.join("\n") };
};

const writes = (calls) => calls.filter((call) => WRITES.test(call));
const remoteHas = (fx, branch) => git(fx.root, "ls-remote", "origin", `refs/heads/${branch}`) !== "";
const measureRows = () => {
  const path = join(process.env.AFK_MEASURE_ROOT, "app.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
const cleanup = (fx) => rmSync(fx.dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

test("every guardrail passes: ready, one guarded merge, the issue closes, the branch delete and a merge row", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const before = measureRows().length;
    const { code, out } = await drive(fx, { gh });
    assert.equal(code, 0, out);
    for (const name of ["review-at-head", "must-fix-cleared", "must-fix-count", "must-fix-one-way", "ci-green", "trial-merge", "one-way-door-paths", "launch-status", "epic-closed", "pr-head"]) {
      assert.match(out, new RegExp(`^PASS ${name}: `, "m"), name);
    }
    const w = writes(gh.calls);
    const merges = w.filter((call) => call.startsWith("gh pr merge "));
    assert.equal(merges.length, 1, w.join("\n"));
    assert.ok(merges[0].includes(`--match-head-commit ${fx.head}`), merges[0]);
    assert.match(merges[0], / --merge /, "two of the last three merged PRs were merge commits");
    assert.doesNotMatch(merges[0], /--delete-branch|--admin|--auto/);
    const ready = w.findIndex((call) => call.startsWith("gh pr ready 42"));
    const merged = w.findIndex((call) => call.startsWith("gh pr merge "));
    assert.ok(ready !== -1 && ready < merged, `pr ready precedes pr merge:\n${w.join("\n")}`);
    const closes = w.filter((call) => call.startsWith("gh issue close "));
    assert.deepEqual(closes.map((call) => call.split(" ")[3]), [EPIC, "190", "191"]);
    assert.ok(w.indexOf(closes[0]) > merged);
    assert.match(closes[0], /Shipped in #42 \(feedfac\)\./);
    assert.equal(remoteHas(fx, "feat"), false, "the remote branch was deleted");
    const rows = measureRows().slice(before);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "merge");
    assert.equal(rows[0].mergeSha, MERGE_SHA);
    assert.equal(rows[0].by, "verb");
    assert.deepEqual(rows[0].probe, { exit: null, ms: null });
    assert.ok(rows[0].guards.every((guard) => guard.status === "pass"));
    const final = gh.comments.at(-1);
    assert.match(final, new RegExp(`merged\\*\\* as ${MERGE_SHA} with \`--merge\``));
    assert.match(final, /PASS pr-head: /);
    assert.match(final, /Issues closed: #186, #190, #191\./);
    assert.match(final, /Health probe: no probe declared\./);
    assert.equal(existsSync(join(fx.dir, "merge.lock")), false, "the lock was released");
  } finally {
    cleanup(fx);
  }
});

test("the merge verb's row carries the run's builder Opus share and first-attempt pass rate (#292)", async () => {
  const fx = makeRun({
    state: (state) => {
      state.tasks[190].builderRuns = [
        { attempt: 1, dispatch: 1, backend: "codex", model: "gpt-5.6-luna", outcome: "failed" },
        { attempt: 2, dispatch: 2, backend: "claude", model: "claude-opus-5-5", outcome: "ready_to_integrate" },
      ];
      state.tasks[191].builderRuns = [{ attempt: 1, dispatch: 1, backend: "claude", model: "claude-opus-5-5", outcome: "ready_to_integrate" }];
      return state;
    },
  });
  try {
    const gh = fakeGh(script(fx));
    const before = measureRows().length;
    const { code, out } = await drive(fx, { gh });
    assert.equal(code, 0, out);
    const [row] = measureRows().slice(before);
    assert.equal(row.builderOpusShare, 0.6667);
    assert.equal(row.firstAttemptPassRate, 0.5);
  } finally {
    cleanup(fx);
  }
});

test("the fake gh throws on a call nobody scripted, so reaching an unscripted merge fails the run", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx, { omit: ["pr merge"] }));
    const { code, out } = await drive(fx, { gh });
    assert.equal(code, 1);
    assert.match(out, /unscripted gh call: gh pr merge 42/);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh issue close")).length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Each guardrail failing in turn
// ---------------------------------------------------------------------------

const FAILURES = [
  ["review-at-head", { run: { state: (s) => ({ ...s, epicClose: { ...s.epicClose, verifier: { ...s.epicClose.verifier, skipped: "quota" } } }) } }],
  ["must-fix-cleared", { run: { left: ["src/app.js returns the wrong value"] } }],
  ["must-fix-count", { run: { mustFix: ["a in src/a.js", "b in src/b.js", "c in src/c.js", "d in src/d.js", "e in src/e.js"] } }],
  ["must-fix-one-way", { run: { mustFix: ["migrations/001.sql drops a column"] } }],
  ["ci-green", { gh: { checks: [{ name: "test", state: "FAILURE" }] } }],
  ["trial-merge", { run: { headFiles: { "shared.txt": "feat\n" }, mainAfter: { "shared.txt": "main\n" } } }],
  ["one-way-door-paths", { run: { headFiles: { "migrations/001.sql": "drop table x;\n" } } }],
  ["launch-status", { config: { oneWayDoors: CONFIG.oneWayDoors } }],
  ["walkthrough", {
    run: {
      state: (s) => ({
        ...s,
        delegations: { 191: { condition: "screens match", evidence: "walkthrough", at: "2026-10-05T00:00:00.000Z" } },
        epicClose: { ...s.epicClose, acceptances: { 191: { by: "delegate", at: "2026-10-05T02:00:00.000Z" } } },
      }),
    },
  }],
  ["epic-closed", { run: { state: (s) => ({ ...s, tasks: { ...s.tasks, 190: { lifecycle: "failed" } } }) } }],
  ["pr-head", { gh: { pr: { headRefOid: "0".repeat(40) } } }],
];

test("the table names all eleven guardrails", () => {
  assert.equal(new Set(FAILURES.map(([name]) => name)).size, 11);
});

for (const [name, setup] of FAILURES) {
  test(`${name} failing: no merge, one PR comment naming it, exit 1`, async () => {
    const fx = makeRun(setup.run ?? {});
    try {
      const gh = fakeGh(script(fx, setup.gh ?? {}));
      const { code, out } = await drive(fx, { gh, config: setup.config ?? CONFIG });
      assert.equal(code, 1, out);
      const failing = out.split("\n").filter((line) => line.startsWith("FAIL ")).map((line) => line.slice(5).split(":")[0]);
      assert.deepEqual(failing, [name], out);
      assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 0);
      assert.deepEqual(writes(gh.calls).map((call) => call.split(" ").slice(0, 4).join(" ")), ["gh pr comment 42"]);
      assert.equal(gh.comments.length, 1);
      assert.ok(gh.comments[0].startsWith(verdictMarker(EPIC)));
      assert.match(gh.comments[0], new RegExp(`failed: ${name}\\.`));
      assert.match(gh.comments[0], new RegExp(`^FAIL ${name}: `, "m"));
      assert.equal(remoteHas(fx, "feat"), true);
    } finally {
      cleanup(fx);
    }
  });
}

test("a refusal identical to the verb's last comment posts no second comment", async () => {
  const fx = makeRun();
  try {
    const failing = { checks: [{ name: "test", state: "FAILURE" }] };
    const first = fakeGh(script(fx, failing));
    assert.equal((await drive(fx, { gh: first })).code, 1);
    assert.equal(first.comments.length, 1);
    const earlier = [{ body: "a human's comment" }, { body: first.comments[0] }];
    const second = fakeGh(script(fx, { ...failing, comments: earlier }));
    const { code, out } = await drive(fx, { gh: second });
    assert.equal(code, 1);
    assert.equal(second.comments.length, 0, out);
    assert.match(out, /already says this; not posting it again/);
    // A different verdict is a new comment.
    const third = fakeGh(script(fx, { checks: [{ name: "test", state: "PENDING" }], comments: earlier }));
    assert.equal((await drive(fx, { gh: third })).code, 1);
    assert.equal(third.comments.length, 1);
    assert.match(third.comments[0], /waiting on ci-green\./);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

test("a merge lock held by a live pid refuses with no gh write; a dead holder is taken over", async () => {
  const fx = makeRun();
  try {
    const lockPath = join(fx.dir, "merge.lock");
    writeFile(lockPath, { pid: 4242, project: "other-app", epic: "7", since: "2026-10-06T00:00:00.000Z", token: "t" });
    const live = fakeGh(script(fx));
    const held = await drive(fx, { gh: live, lockPath, alive: (pid) => pid === 4242 });
    assert.equal(held.code, 1);
    assert.match(held.out, /^WAIT merge-lock: .*other-app epic #7 \(pid 4242/m);
    assert.deepEqual(live.calls, [], "nothing was called");
    assert.ok(existsSync(lockPath), "the live holder's lock is untouched");

    const dead = fakeGh(script(fx));
    const taken = await drive(fx, { gh: dead, lockPath, alive: () => false });
    assert.equal(taken.code, 0, taken.out);
    assert.equal(dead.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
    assert.equal(existsSync(lockPath), false, "released after the merge");
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// The health probe
// ---------------------------------------------------------------------------

test("a red probe exits 2, comments 'merged; health probe red', closes no issue and deletes no branch", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const config = { ...CONFIG, merge: { healthProbe: "echo probe-said-boom; exit 3" } };
    const { code, out } = await drive(fx, { gh, config });
    assert.equal(code, 2, out);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
    assert.equal(gh.comments.length, 1);
    assert.match(gh.comments[0], /merged; health probe red/);
    assert.match(gh.comments[0], /probe-said-boom/);
    assert.match(out, new RegExp(`git revert -m 1 ${MERGE_SHA}`));
    assert.equal(gh.calls.filter((call) => /^gh issue (close|comment)/.test(call)).length, 0);
    assert.equal(remoteHas(fx, "feat"), true);
    assert.equal(measureRows().at(-1).probe.exit, 3);
  } finally {
    cleanup(fx);
  }
});

test("a timed-out probe is red too", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const { code, out } = await drive(fx, { gh, config: { ...CONFIG, merge: { healthProbe: "sleep 5" } }, probeTimeoutMs: 200 });
    assert.equal(code, 2, out);
    assert.match(gh.comments[0], /timed out after 0.2s/);
  } finally {
    cleanup(fx);
  }
});

test("a launched project with no probe declared is refused before any merge", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const config = { ...CONFIG, launchStatus: "launched", merge: { userFacing: ["app/**"] } };
    const { code, out } = await drive(fx, { gh, config });
    assert.equal(code, 1);
    assert.match(out, /^FAIL launch-status: launched, and no `merge.healthProbe` is declared/m);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Dry run, --wait, lanes, run state
// ---------------------------------------------------------------------------

test("--dry-run prints every guardrail and the command, and records zero gh writes", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const { code, out } = await drive(fx, { gh, dryRun: true });
    assert.equal(code, 0, out);
    assert.match(out, /^PASS pr-head: /m);
    assert.ok(out.includes(`MERGE: PR #42 https://github.com/${REPO}/pull/42 (head ${fx.head.slice(0, 12)}, base main, draft)`), out);
    assert.ok(out.includes(`would run: gh pr ready 42 && gh pr merge 42 --merge --match-head-commit ${fx.head}`), out);
    assert.match(out, /MERGE: dry run, nothing merged\.$/);
    assert.deepEqual(writes(gh.calls), []);
    for (const call of gh.calls) assert.match(call, READS);
    assert.equal(remoteHas(fx, "feat"), true);
  } finally {
    cleanup(fx);
  }
});

test("--wait: a check pending on the first poll and green on the second merges once", async () => {
  const fx = makeRun();
  try {
    let polls = 0;
    const checks = () => {
      polls += 1;
      return { stdout: JSON.stringify([{ name: "test", state: polls === 1 ? "PENDING" : "SUCCESS" }]) };
    };
    const gh = fakeGh(script(fx, { checks }));
    let clock = Date.parse("2026-10-06T00:00:00Z");
    const slept = [];
    const sleep = async (ms) => { slept.push(ms); clock += ms; };
    const { code, out } = await drive(fx, { gh, wait: 8, sleep, now: () => clock });
    assert.equal(code, 0, out);
    assert.match(out, /^WAIT ci-green: test: pending/m);
    assert.deepEqual(slept, [5 * 60 * 1000]);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
    assert.equal(gh.comments.filter((body) => body.startsWith(verdictMarker(EPIC))).length, 0, "no refusal comment while waiting");
  } finally {
    cleanup(fx);
  }
});

test("--wait: a fail exits at once without polling", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx, { checks: [{ name: "test", state: "FAILURE" }] }));
    const slept = [];
    const { code, out } = await drive(fx, { gh, wait: 8, sleep: async (ms) => { slept.push(ms); } });
    assert.equal(code, 1);
    assert.match(out, /^FAIL ci-green: test: failure/m);
    assert.deepEqual(slept, []);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 0);
  } finally {
    cleanup(fx);
  }
});

test("with no PR for the branch it exits 1, says so, and makes only reads", async () => {
  const fx = makeRun();
  try {
    for (const dryRun of [false, true]) {
      const gh = fakeGh([[/^gh pr list /, { stdout: "[]" }]]);
      const { code, out } = await drive(fx, { gh, dryRun });
      assert.equal(code, 1, out);
      assert.match(out, /no PR exists for feat in acme\/app\. Nothing to merge\./);
      assert.doesNotMatch(out, /gh pr merge/);
      assert.deepEqual(writes(gh.calls), []);
      for (const call of gh.calls) assert.match(call, READS);
    }
  } finally {
    cleanup(fx);
  }
});

test("inside a lane it refuses and calls nothing", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh(script(fx));
    const { code, out } = await drive(fx, { gh, env: { RUNNER_TASK_ID: "189" } });
    assert.equal(code, 1);
    assert.match(out, /refusing inside task 189/);
    assert.deepEqual(gh.calls, []);
  } finally {
    cleanup(fx);
  }
});

test("a root with no run state for this epic is refused before any call", async () => {
  const fx = makeRun({ state: (s) => ({ ...s, dag: { ...s.dag, epic: { id: "7" } } }) });
  try {
    const gh = fakeGh(script(fx));
    const { code, out } = await drive(fx, { gh });
    assert.equal(code, 1);
    assert.match(out, /holds no run state for epic 186 \(its run is epic 7\)/);
    assert.deepEqual(gh.calls, []);
    rmSync(join(fx.root, ".afk"), { recursive: true, force: true });
    const none = await drive(fx, { gh });
    assert.match(none.out, /holds no run state for epic 186\. Pass --root=/);
    assert.deepEqual(gh.calls, []);
  } finally {
    cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Merging as a configured author (#212)
// ---------------------------------------------------------------------------

const AUTHORED = {
  ...CONFIG,
  merge: { author: { name: "Deploy Owner", email: "owner@example.test" }, coAuthors: ["Pair Person <pair@example.test>"] },
};
const headRow = (answer) => [/^gh pr view 42 .*--json headRefOid$/, answer];
const originLog = (fx, format, ref = "main") => git(fx.origin, "log", "-1", `--format=${format}`, ref);

test("merge.author: a local --no-ff merge of the guarded head, as that author with the trailer, pushed to the base; no gh pr merge", async () => {
  const fx = makeRun();
  try {
    const gh = fakeGh([headRow({ stdout: JSON.stringify({ headRefOid: fx.head }) }), ...script(fx, { omit: ["pr merge"] })]);
    const { code, out } = await drive(fx, { gh, config: AUTHORED });
    assert.equal(code, 0, out);
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr merge")).length, 0, "no gh pr merge on the configured path");
    assert.equal(gh.calls.filter((call) => call.startsWith("gh pr ready 42")).length, 1);
    assert.equal(originLog(fx, "%an <%ae>"), "Deploy Owner <owner@example.test>");
    assert.equal(originLog(fx, "%cn <%ce>"), "Deploy Owner <owner@example.test>");
    assert.match(originLog(fx, "%B"), /^Merge pull request #42 from feat\n[\s\S]*\nCo-Authored-By: Pair Person <pair@example\.test>$/);
    const parents = originLog(fx, "%P").split(" ");
    assert.equal(parents.length, 2, "a merge commit, not a fast-forward");
    assert.equal(parents[1], fx.head, "the head the guardrails ran on is the head merged");
    const mergeSha = git(fx.origin, "rev-parse", "main");
    assert.match(out, new RegExp(`merged PR #42 as ${mergeSha.slice(0, 12)} \\(merge\\)`));
    assert.match(gh.comments.at(-1), new RegExp(`merged\\*\\* as ${mergeSha} with \`--merge\` \\(local merge commit as Deploy Owner`));
    assert.equal(remoteHas(fx, "feat"), false, "landed as before");
    assert.equal(git(fx.root, "worktree", "list").split("\n").length, 1, "the merge worktree is gone");
  } finally {
    cleanup(fx);
  }
});

test("merge.author: a head that moved between the guardrails and the merge refuses and pushes nothing", async () => {
  const fx = makeRun();
  try {
    const before = git(fx.origin, "rev-parse", "main");
    let moved = null;
    const gh = fakeGh([headRow(() => {
      moved = commit(fx.root, { "src/late.js": "late\n" }, "late push");
      git(fx.root, "push", "-q", "origin", "feat");
      return { stdout: JSON.stringify({ headRefOid: moved }) };
    }), ...script(fx, { omit: ["pr merge"] })]);
    const { code, out } = await drive(fx, { gh, config: AUTHORED });
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`the head moved after the guardrails ran on ${fx.head.slice(0, 12)} \\(PR now ${moved.slice(0, 12)}`));
    assert.equal(git(fx.origin, "rev-parse", "main"), before, "the base was not pushed");
    assert.equal(gh.calls.filter((call) => /^gh (pr merge|issue close)/.test(call)).length, 0);
    assert.equal(remoteHas(fx, "feat"), true);
  } finally {
    cleanup(fx);
  }
});

test("--dry-run names the path and the author it would use, on both paths", async () => {
  const fx = makeRun();
  try {
    const authored = fakeGh(script(fx));
    const local = await drive(fx, { gh: authored, dryRun: true, config: AUTHORED });
    assert.equal(local.code, 0, local.out);
    assert.match(local.out, /path: local merge as Deploy Owner <owner@example\.test> \(merge\.author\); Co-Authored-By: Pair Person <pair@example\.test>/);
    assert.ok(local.out.includes(`git merge --no-ff ${fx.head} into origin/main`), local.out);
    assert.doesNotMatch(local.out, /gh pr merge/);
    assert.deepEqual(writes(authored.calls), []);
    const plain = fakeGh(script(fx));
    const viaGh = await drive(fx, { gh: plain, dryRun: true });
    assert.match(viaGh.out, /path: gh pr merge \(no merge\.author configured/);
    assert.deepEqual(writes(plain.calls), []);
  } finally {
    cleanup(fx);
  }
});

test("merge.author and merge.coAuthors are validated: a mapping of name and email, `Name <email>` trailers, and no co-authors without an author", async () => {
  const { validateMergeConfig } = await import("./lib.mjs");
  validateMergeConfig(AUTHORED);
  for (const [merge, message] of [
    [{ author: { name: "A" } }, /`merge\.author` must be a mapping of `name` and `email`/],
    [{ author: { name: "A", email: "not-an-email" } }, /`merge\.author` must be/],
    [{ author: AUTHORED.merge.author, coAuthors: ["no email"] }, /`merge\.coAuthors` must be a list of `Name <email>`/],
    [{ coAuthors: ["B <b@example.test>"] }, /`merge\.coAuthors` needs `merge\.author`/],
  ]) {
    assert.throws(() => validateMergeConfig({ merge }), message);
  }
});
