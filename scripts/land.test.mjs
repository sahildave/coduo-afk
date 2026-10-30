// `afk land <pr>` (#228): merge a non-epic PR only after its own checks.
//
// Driven through the `afk` CLI with a fake `gh` on PATH. The fake answers from
// JSON files the test writes and logs every call, so a test can tell a merge
// that ran from one that did not. Nothing reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));
const HEAD = "c".repeat(40);

const GREEN = [{ name: "test", state: "SUCCESS" }, { name: "lint", state: "SKIPPED" }];
const PR = {
  number: 42, state: "OPEN", isDraft: false, title: "Fix the keymap", body: "Fixes #41.",
  baseRefName: "main", headRefName: "fix/41-keymap", headRefOid: HEAD, isCrossRepository: false,
  author: { login: "owner" },
  reviews: [],
  comments: [{ author: { login: "owner" }, authorAssociation: "OWNER", body: "LGTM, land it.", createdAt: "2026-10-13T10:00:00Z" }],
};

const machine = (t, { pr = PR, checks = GREEN, checksExit = 0 } = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "afk-land-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "pr.json"), JSON.stringify(pr));
  writeFileSync(join(dir, "checks.json"), JSON.stringify(checks));
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh
echo "gh $*" >> "${dir}/calls.log"
case "$1 $2" in
  "pr view") cat "${dir}/pr.json" ;;
  "pr checks") cat "${dir}/checks.json"; exit ${checksExit} ;;
  "pr merge") echo "merged" ;;
  "pr comment") echo "commented" ;;
  "api graphql") echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' ;;
  *) echo "unscripted: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const land = (...args) => spawnSync(process.execPath, [afk, "land", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");
  return { land, calls, dir };
};

const merged = (calls) => /gh pr merge/.test(calls);

test("afk land merges a green, owner-approved PR that is not a push to its base", (t) => {
  const { land, calls } = machine(t);
  const result = land("42", "--repo=acme/app");
  assert.doesNotMatch(result.stdout, /not built yet/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS ci-green/);
  assert.match(result.stdout, /PASS not-a-base-push/);
  assert.match(result.stdout, /PASS owner-approval/);
  assert.match(calls(), new RegExp(`gh pr merge 42 --repo acme/app --merge --match-head-commit ${HEAD}`));
  assert.match(result.stdout, /LAND: merged #42/);
});

test("afk land refuses red CI, running CI and no CI, and merges nothing", (t) => {
  for (const [checks, exit, pattern] of [
    [[{ name: "test", state: "FAILURE" }], 1, /FAIL ci-green: test: failure/],
    [[{ name: "test", state: "IN_PROGRESS" }], 8, /WAIT ci-green/],
    [[], 0, /FAIL ci-green: .*zero checks/],
  ]) {
    const { land, calls } = machine(t, { checks, checksExit: exit });
    const result = land("42", "--repo=acme/app");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, pattern);
    assert.equal(merged(calls()), false);
  }
});

test("afk land refuses a PR whose head is its base branch", (t) => {
  const { land, calls } = machine(t, { pr: { ...PR, headRefName: "main" } });
  const result = land("42", "--repo=acme/app");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL not-a-base-push: .*main/);
  assert.equal(merged(calls()), false);
});

test("afk land refuses with no owner approval or comment; an agent's comment is not the owner's", (t) => {
  for (const pr of [
    { ...PR, comments: [] },
    { ...PR, comments: [{ author: { login: "someone" }, authorAssociation: "CONTRIBUTOR", body: "lgtm" }] },
    { ...PR, comments: [{ author: { login: "owner" }, authorAssociation: "OWNER", body: "Fixed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" }] },
    { ...PR, comments: [{ author: { login: "owner" }, authorAssociation: "OWNER", body: "<!-- afk:merge-verdict 41 -->\nverdict" }] },
  ]) {
    const { land, calls } = machine(t, { pr });
    const result = land("42", "--repo=acme/app");
    assert.equal(result.status, 1, JSON.stringify(pr.comments));
    assert.match(result.stdout, /FAIL owner-approval/);
    assert.equal(merged(calls()), false);
  }
  // An approving review by the owner is enough on its own.
  const { land } = machine(t, { pr: { ...PR, comments: [], reviews: [{ author: { login: "owner" }, authorAssociation: "OWNER", state: "APPROVED", submittedAt: "2026-10-13T10:00:00Z" }] } });
  assert.equal(land("42", "--repo=acme/app").status, 0);
});

test("afk land refuses an epic PR, a draft and a closed PR", (t) => {
  for (const [pr, pattern] of [
    [{ ...PR, body: "<!-- afk:epic-pr 226 -->\nbody" }, /epic PR.*afk merge/],
    [{ ...PR, isDraft: true }, /draft/],
    [{ ...PR, state: "MERGED" }, /MERGED/],
  ]) {
    const { land, calls } = machine(t, { pr });
    const result = land("42", "--repo=acme/app");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, pattern);
    assert.equal(merged(calls()), false);
  }
});

test("afk land --dry-run prints the checks and changes nothing", (t) => {
  const { land, calls } = machine(t);
  const result = land("42", "--repo=acme/app", "--dry-run");
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /PASS ci-green/);
  assert.match(result.stdout, /would run: gh pr merge 42/);
  assert.equal(merged(calls()), false);
});

// ---------------------------------------------------------------------------
// Fix pass (#235 review S1, S2, S8)
// ---------------------------------------------------------------------------

const owner = (extra) => ({ author: { login: "owner" }, authorAssociation: "OWNER", ...extra });

test("S1: an owner-authored comment with an agent footer, or with no approval in it, is not approval", (t) => {
  for (const comments of [
    // The footer this epic's reviewer and coordinator post under the owner's login.
    [owner({ body: "LGTM\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_", createdAt: "2026-10-13T10:00:00Z" })],
    [owner({ body: "LGTM\nhttps://claude.ai/code/session_011", createdAt: "2026-10-13T10:00:00Z" })],
    // A comment from the owner that approves nothing: a review listing a MUST-FIX finding.
    [owner({ body: "S1 (MUST-FIX): land.mjs counts an agent's comment as approval.", createdAt: "2026-10-13T10:00:00Z" })],
  ]) {
    const { land, calls } = machine(t, { pr: { ...PR, comments } });
    const result = land("42", "--repo=acme/app");
    assert.equal(result.status, 1, comments[0].body);
    assert.match(result.stdout, /FAIL owner-approval/);
    assert.equal(merged(calls()), false);
  }
});

test("S2: an owner's request for changes, or any later review that is not an approval, blocks the merge", (t) => {
  const bot = { author: { login: "dependabot" } };
  for (const [pr, pattern] of [
    // The owner's request for changes on a PR someone else opened.
    [{ ...PR, ...bot, comments: [], reviews: [owner({ state: "CHANGES_REQUESTED", body: "Do not merge this, it breaks billing.", submittedAt: "2026-10-13T11:00:00Z" })] }, /requested changes/],
    // Approved, then the owner requested changes.
    [{ ...PR, ...bot, comments: [], reviews: [
      owner({ state: "APPROVED", body: "", submittedAt: "2026-10-13T10:00:00Z" }),
      owner({ state: "CHANGES_REQUESTED", body: "wait", submittedAt: "2026-10-13T11:00:00Z" }),
    ] }, /requested changes/],
    // Approved by comment, then someone else's review that is not an approval.
    [{ ...PR, reviews: [{ author: { login: "reviewer" }, authorAssociation: "COLLABORATOR", state: "COMMENTED", body: "this leaks a token", submittedAt: "2026-10-13T11:00:00Z" }] }, /COMMENTED review by reviewer .*after/],
  ]) {
    const { land, calls } = machine(t, { pr });
    const result = land("42", "--repo=acme/app");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /FAIL owner-approval/);
    assert.match(result.stdout, pattern);
    assert.equal(merged(calls()), false);
  }
  // An approval after the later review stands.
  const { land } = machine(t, { pr: { ...PR, comments: [], reviews: [
    { author: { login: "reviewer" }, authorAssociation: "COLLABORATOR", state: "COMMENTED", body: "nit", submittedAt: "2026-10-13T09:00:00Z" },
    owner({ state: "APPROVED", body: "", submittedAt: "2026-10-13T10:00:00Z" }),
  ] } });
  assert.equal(land("42", "--repo=acme/app").status, 0);
});

test("S8: the evidence names the login that matched, not the repository's owner segment", (t) => {
  const { land } = machine(t);
  const result = land("42", "--repo=acme/app");
  assert.match(result.stdout, /PASS owner-approval: owner /);
  assert.doesNotMatch(result.stdout, /owner-approval: acme /);
});

// ---------------------------------------------------------------------------
// Delegated landing: `land: { ownerApproval: delegated }` in the repo's config
// ---------------------------------------------------------------------------

test("with land.ownerApproval: delegated, a PR with no owner approval lands and the PR gets a comment saying why", (t) => {
  const { land, calls, dir } = machine(t, { pr: { ...PR, comments: [] } });
  mkdirSync(join(dir, ".afk-setup"));
  writeFileSync(join(dir, ".afk-setup", "config.yaml"), "land:\n  ownerApproval: delegated\n");
  const result = land("42", "--repo=acme/app");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS owner-approval: delegated/);
  assert.match(calls(), /gh pr merge 42/);
  assert.match(calls(), /gh pr comment 42 --repo acme\/app --body/);
  assert.match(calls(), /under the owner's delegation/);
});

test("with land.ownerApproval: delegated, the owner's request for changes still blocks; with no config the owner's approval is still required", (t) => {
  const changes = { ...PR, comments: [], reviews: [owner({ state: "CHANGES_REQUESTED", body: "no", submittedAt: "2026-10-13T11:00:00Z" })] };
  const blocked = machine(t, { pr: changes });
  mkdirSync(join(blocked.dir, ".afk-setup"));
  writeFileSync(join(blocked.dir, ".afk-setup", "config.yaml"), "land:\n  ownerApproval: delegated\n");
  const first = blocked.land("42", "--repo=acme/app");
  assert.equal(first.status, 1, first.stdout);
  assert.match(first.stdout, /FAIL owner-approval: .*requested changes/);
  assert.equal(merged(blocked.calls()), false);

  const plain = machine(t, { pr: { ...PR, comments: [] } });
  mkdirSync(join(plain.dir, ".afk-setup"));
  writeFileSync(join(plain.dir, ".afk-setup", "config.yaml"), "land:\n  ownerApproval: required\n");
  const second = plain.land("42", "--repo=acme/app");
  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stdout, /FAIL owner-approval/);
  assert.equal(merged(plain.calls()), false);
});

test("an unknown land.ownerApproval value is refused, and nothing merges", (t) => {
  const { land, calls, dir } = machine(t, { pr: { ...PR, comments: [] } });
  mkdirSync(join(dir, ".afk-setup"));
  writeFileSync(join(dir, ".afk-setup", "config.yaml"), "land:\n  ownerApproval: yes-please\n");
  const result = land("42", "--repo=acme/app");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /ownerApproval/);
  assert.equal(merged(calls()), false);
});

// `merge.ci: none` (the key `afk merge` reads) also covers `afk land`.
test("with merge.ci: none, a PR with zero checks passes ci-green naming the config; a red or pending check still blocks", (t) => {
  const withConfig = (opts) => {
    const m = machine(t, opts);
    mkdirSync(join(m.dir, ".afk-setup"));
    writeFileSync(join(m.dir, ".afk-setup", "config.yaml"), "merge:\n  ci: none\n");
    return m;
  };
  const none = withConfig({ checks: [] });
  const ok = none.land("42", "--repo=acme/app");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS ci-green: .*zero checks.*`merge\.ci: none` in \.afk-setup\/config\.yaml/);
  assert.match(none.calls(), /gh pr merge 42/);

  for (const [checks, exit, expected] of [
    [[{ name: "test", state: "FAILURE" }], 1, /FAIL ci-green: test: failure/],
    [[{ name: "test", state: "PENDING" }], 8, /WAIT ci-green: test: pending/],
  ]) {
    const m = withConfig({ checks, checksExit: exit });
    const result = m.land("42", "--repo=acme/app");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, expected);
    assert.equal(merged(m.calls()), false);
  }
});
