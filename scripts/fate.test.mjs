// `afk fate` and the reviewer's memory of it (#228).
//
// The ledger is driven through the `afk` CLI, in a throwaway checkout with a
// hand-written run state and closeout review. The reviewer is `runVerifier`
// with an injected agent, so the prompt it would have been handed is read off
// disk and no model runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerifier, verifierReportPath } from "./verifier.mjs";
import { fixerReportPath } from "./fixer.mjs";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));
const EPIC = "255";
const REVIEW_HEAD = "a".repeat(40);
const ACCEPTED = "src/keymap.js drops the chord timeout";
const OPEN = "README.md documents the old flag";

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

/** A checkout whose last closeout review raised two must-fix items. */
const checkout = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-fate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(join(root, ".afk", "state.json"), {
    epic: { id: EPIC },
    epicClose: { lifecycle: "closed", verifier: { head: REVIEW_HEAD, ranAt: "2026-10-12T01:00:00.000Z" } },
  });
  writeJson(verifierReportPath(root, EPIC), {
    version: 1, status: "ok", head: REVIEW_HEAD, ranAt: "2026-10-12T01:00:00.000Z", summary: "",
    criteria: [], mustFix: [ACCEPTED, OPEN],
    findings: [
      { axis: "spec", severity: "major", title: ACCEPTED, file: "src/keymap.js:40", detail: "", howToShowItFails: null },
      { axis: "standards", severity: "minor", title: "a helper is named badly", file: "src/util.js:3", detail: "", howToShowItFails: null },
    ],
  });
  // A fake `gh` that answers `gh api <path>` from api/<path with / as _>.json.
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  writeFileSync(join(root, "bin", "gh"), `#!/bin/sh
f="${root}/api/$(echo "$2" | tr '/' '_').json"
if [ "$1" = api ] && [ -f "$f" ]; then cat "$f"; else echo "gh: not found: $*" >&2; exit 1; fi
`, { mode: 0o755 });
  ownerSaid(root, 1, { user: { login: "owner" }, author_association: "OWNER", body: "Accept the chord timeout finding, it is the platform's." });
  writeJson(fixerReportPath(root, EPIC), {
    version: 1, status: "ok", reviewHead: REVIEW_HEAD,
    items: [{ id: "F1", source: "must-fix", title: ACCEPTED }, { id: "F2", source: "must-fix", title: OPEN }],
    fixed: [], deferred: [],
  });
  return root;
};

const fate = (root, ...args) => spawnSync(process.execPath, [afk, "fate", ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
});
/** Comment `id` on acme/app, as `gh api` returns it; its URL is what an owner fate cites. */
const ownerSaid = (root, id, comment) => writeJson(join(root, "api", `repos_acme_app_issues_comments_${id}.json`), comment);
const said = (id) => `https://github.com/acme/app/pull/260#issuecomment-${id}`;
const idOf = (listing, title) => listing.split("\n").find((row) => row.includes(title))?.match(/CF-[0-9a-f]{8}/)?.[0] ?? null;

test("afk fate lists the closeout's findings with ids, and records a fate per finding", (t) => {
  const root = checkout(t);
  const listed = fate(root, EPIC);
  assert.doesNotMatch(listed.stdout, /not built yet/);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const id = idOf(listed.stdout, ACCEPTED);
  assert.ok(id, listed.stdout);
  assert.ok(idOf(listed.stdout, OPEN), "every must-fix line is listed");

  // The flag forms the dispatcher registered, and the fixer's own item id.
  const byFlags = fate(root, `--epic=${EPIC}`, "--finding=F1", "--accepted", "--reason", `by design until v3, ${said(1)}`, "--by", "owner");
  assert.equal(byFlags.status, 0, byFlags.stdout + byFlags.stderr);
  assert.match(byFlags.stdout, new RegExp(`FATE: epic ${EPIC} ${id} accepted by owner`));
  const ledger = readFileSync(join(root, ".afk", "fates", `${EPIC}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].finding, id);
  assert.equal(ledger[0].title, ACCEPTED);
  assert.equal(ledger[0].fate, "accepted");
  assert.equal(ledger[0].by, "owner");
  assert.equal(ledger[0].reason, `by design until v3, ${said(1)}`);
  assert.deepEqual(ledger[0].evidence, { url: said(1), login: "owner" });
  assert.equal(ledger[0].reviewHead, REVIEW_HEAD);
  assert.ok(ledger[0].ts);
  assert.match(fate(root, EPIC).stdout, new RegExp(`${id}\\s+accepted by owner`));
});

test("afk fate refuses an unknown finding, no reason, two fates, a wrong --by, and another epic's checkout", (t) => {
  const root = checkout(t);
  const id = idOf(fate(root, EPIC).stdout, OPEN);
  const cases = [
    [[EPIC, "CF-00000000", "--fixed", "--reason=x"], /no finding CF-00000000/],
    [[EPIC, id, "--fixed"], /--reason/],
    [[EPIC, id, "--fixed", "--dropped", "--reason=x"], /exactly one of --accepted, --fixed, --dropped/],
    [[EPIC, id, "--fixed", "--reason=x", "--by=someone"], /--by is owner or cos/],
    [["999", id, "--fixed", "--reason=x"], /belongs to epic 255/],
  ];
  for (const [args, message] of cases) {
    const result = fate(root, ...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stdout, message, args.join(" "));
  }
  // Nothing was written by any refusal.
  assert.throws(() => readFileSync(join(root, ".afk", "fates", `${EPIC}.jsonl`)));
  // Unattributed is the chief of staff's, never the owner's.
  assert.equal(fate(root, EPIC, id, "--fixed", "--reason=fixed in 1a2b3c").status, 0);
  assert.match(readFileSync(join(root, ".afk", "fates", `${EPIC}.jsonl`), "utf8"), /"by":"cos"/);
});

test("the reviewer prompt carries the previous findings and their fates", async (t) => {
  const root = checkout(t);
  const id = idOf(fate(root, EPIC).stdout, ACCEPTED);
  assert.ok(id);
  assert.equal(fate(root, EPIC, id, "--accepted", `--reason=the timeout is the platform's ${said(1)}`, "--by=owner").status, 0);
  const openId = idOf(fate(root, EPIC).stdout, OPEN);

  let promptPath = null;
  await runVerifier({
    root,
    config: {},
    dag: { epic: { id: EPIC, title: "Keymap" }, branch: "feat/255-keymap", tasks: [] },
    branch: "feat/255-keymap",
    baseBranch: "main",
    runAgent: async (args) => {
      promptPath = args.promptPath;
      writeFileSync(args.streamPath, `${JSON.stringify({ type: "result", result: "```json\n{}\n```" })}\n`);
      return { status: 0, timedOut: false };
    },
  });
  const prompt = readFileSync(promptPath, "utf8");
  assert.equal(promptPath, resolve(root, ".afk", "verifier", EPIC, "prompt.md"));
  assert.ok(prompt.includes(id), "the fated finding's id");
  assert.ok(prompt.includes(ACCEPTED), "its text");
  assert.match(prompt, new RegExp(`${id}.*accepted by owner`));
  assert.ok(prompt.includes("the timeout is the platform's"), "the reason");
  assert.ok(prompt.includes(REVIEW_HEAD.slice(0, 12)), "the review it was fated at, to diff its lines against");
  assert.match(prompt, new RegExp(`${openId}.*no fate`), "an unfated finding is listed as such");
  assert.match(prompt, /must not raise a fated finding again unless the lines it names changed/i);
  assert.match(prompt, /whole branch/i);
  assert.doesNotMatch(prompt, /@@[A-Z_]+@@/);
});

// ---------------------------------------------------------------------------
// Fix pass (#235 review S3): an owner fate cites the owner's own words
// ---------------------------------------------------------------------------

test("S3: --by=owner needs a link to a comment the owner wrote, which gh confirms; an agent's comment does not do", (t) => {
  const root = checkout(t);
  const id = idOf(fate(root, EPIC).stdout, OPEN);
  ownerSaid(root, 2, { user: { login: "owner" }, author_association: "OWNER", body: "Drop it.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_" });
  ownerSaid(root, 3, { user: { login: "someone" }, author_association: "CONTRIBUTOR", body: "Drop it." });
  for (const [reason, message] of [
    ["The owner said so", /--by=owner needs a link to the owner's comment/],
    [`see ${said(2)}`, /carries an agent's mark/],
    [`see ${said(3)}`, /was written by someone, not the owner/],
    [`see ${said(99)}`, /gh could not read/],
  ]) {
    const result = fate(root, EPIC, id, "--dropped", `--reason=${reason}`, "--by=owner");
    assert.equal(result.status, 1, reason);
    assert.match(result.stdout, message, reason);
  }
  assert.throws(() => readFileSync(join(root, ".afk", "fates", `${EPIC}.jsonl`)), "no refusal wrote a fate");
});
