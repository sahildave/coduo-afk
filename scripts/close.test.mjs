// `afk close --redo`: one closeout fix pass per epic, enforced in code (#228).
//
// Driven through the `afk` CLI in a throwaway checkout. A fake `gh` on PATH
// fails every call, so a redo that gets past the refusals stops at the epic
// fetch and never reaches GitHub or an agent.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { writeConfig } from "./test-helpers.mjs";
import { cli } from "./close.mjs";
import { fixerReportPath } from "./fixer.mjs";
import { verifierReportPath } from "./verifier.mjs";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

const closedCheckout = (t, epicClose) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "afk-close-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeConfig(root, { defaultChecks: ["true"] });
  mkdirSync(join(root, ".afk"), { recursive: true });
  writeFileSync(join(root, ".afk", "state.json"), JSON.stringify({ epic: { id: "545" }, tasks: {}, epicClose: { lifecycle: "closed", ...epicClose } }));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "gh"), "#!/bin/sh\necho 'gh: offline in this test' >&2\nexit 1\n", { mode: 0o755 });
  return root;
};
const redo = (root) => spawnSync(process.execPath, [afk, "close", "--redo", "545", "--repo=acme/app"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
});

const pass = (extra = {}) => ({ status: "ok", items: 3, distinct: 1, restating: 0, open: 2, noOp: 0, notQueued: 0, unknownNotQueued: 0, ranAt: "2026-10-12T02:00:00.000Z", ...extra });

test("a second closeout fix pass is refused, pointing at afk fate", (t) => {
  const root = closedCheckout(t, { verifier: { head: "a".repeat(40) }, fixer: pass() });
  const result = redo(root);
  assert.match(result.stdout, /CLOSE: epic 545 already had its closeout fix pass/);
  assert.match(result.stdout, /no second fix pass/);
  assert.match(result.stdout, /afk fate 545 <finding> --accepted\|--fixed\|--dropped/);
});

test("a fix pass recorded on an earlier redo counts too", (t) => {
  const root = closedCheckout(t, { fixer: null, redos: [{ fixer: pass({ ranAt: "2026-10-11T02:00:00.000Z" }) }] });
  const result = redo(root);
  assert.match(result.stdout, /already had its closeout fix pass .*2026-10-11/);
});

test("a closeout whose fixer had nothing to do has not had its fix pass", (t) => {
  const root = closedCheckout(t, { fixer: { status: "nothing_to_do", items: 0 } });
  const result = redo(root);
  // Past the one-pass rule: it stops at the (offline) epic fetch instead.
  assert.doesNotMatch(result.stdout, /fix pass/);
  assert.match(result.stdout + result.stderr, /gh: offline in this test|CLOSE:/);
});

// ---------------------------------------------------------------------------
// Fix pass (#235 review S7): the re-review still runs, the fixer does not
// ---------------------------------------------------------------------------

test("S7: a redo after the fix pass re-reviews the head and runs no fixer", async (t) => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const fixer = pass();
  const root = closedCheckout(t, { verifier: { head: first, ranAt: "2026-10-12T01:00:00.000Z" }, fixer });
  mkdirSync(join(root, ".afk", "verifier", "545"), { recursive: true });
  writeFileSync(verifierReportPath(root, "545"), JSON.stringify({ version: 1, status: "ok", head: first, mustFix: ["old"], findings: [], criteria: [] }));
  mkdirSync(join(root, ".afk", "fixer", "545"), { recursive: true });
  writeFileSync(fixerReportPath(root, "545"), JSON.stringify({ version: 1, status: "ok", reviewHead: first, items: [] }));
  const fixerBefore = readFileSync(fixerReportPath(root, "545"), "utf8");
  const reviews = [];
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  let code;
  try {
    code = await cli(["--redo", "545", "--repo=acme/app"], root, {
      loadEpic: async () => ({ dag: { epic: { id: "545", title: "x" }, branch: "feat/545", tasks: [] }, epicBody: "body", epicBase: "main" }),
      verify: async (args) => {
        reviews.push(args);
        const report = { version: 1, status: "ok", head: second, ranAt: "2026-10-13T01:00:00.000Z", summary: "", mustFix: ["new"], findings: [], criteria: [], skipped: [], seams: [], unwired: [] };
        writeFileSync(verifierReportPath(root, "545"), JSON.stringify(report));
        return report;
      },
      runAuto: async () => { throw new Error("a redo after the fix pass must not run the close, whose fixer would run"); },
    });
  } finally {
    console.log = log;
  }
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(reviews.length, 1, "one review ran");
  assert.equal(reviews[0].baseBranch, "main");
  const close = JSON.parse(readFileSync(join(root, ".afk", "state.json"), "utf8")).epicClose;
  assert.equal(close.verifier.head, second);
  assert.equal(close.verifier.afterFixPass, true);
  assert.equal(close.redos.length, 1);
  assert.equal(close.redos[0].verifier.head, first, "the earlier review is kept");
  assert.equal(close.redos[0].reviewOnly, true);
  assert.deepEqual(close.fixer, fixer, "the pass's record stays, so the next redo is review-only too");
  assert.equal(readFileSync(fixerReportPath(root, "545"), "utf8"), fixerBefore, "no fixer ran");
  assert.match(lines.join("\n"), /re-reviewed .* 1 must-fix/);
});
