// scripts/root-flag.test.mjs — `afk reset|salvage --root=<epic checkout>` runs
// against that checkout, so an Orchestrator never needs `cd <epic> && afk ...`.
// A `cd` outside its working directories sends the whole command to the
// auto-mode classifier, which refused `afk salvage 548` on 2026-10-12; a bare
// `afk ... --root=` matches the Orchestrator profile's `Bash(afk:*)`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));

test("afk reset --root= resets the task in that checkout, not in the current directory", () => {
  const epic = mkdtempSync(join(tmpdir(), "afk-root-epic-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "afk-root-cwd-"));
  mkdirSync(join(epic, ".afk"));
  writeFileSync(join(epic, ".afk", "state.json"), JSON.stringify({ tasks: { "548": { lifecycle: "failed" } } }));
  const r = spawnSync(process.execPath, [afk, "reset", "548", `--root=${epic}`], { cwd: elsewhere, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Reset 548 to pending/);
  assert.equal(JSON.parse(readFileSync(join(epic, ".afk", "state.json"), "utf8")).tasks["548"].lifecycle, "pending");
});

test("afk salvage --root= reads that checkout's state", () => {
  const epic = mkdtempSync(join(tmpdir(), "afk-root-epic-"));
  mkdirSync(join(epic, ".afk"));
  writeFileSync(join(epic, ".afk", "state.json"), JSON.stringify({ tasks: { "548": { lifecycle: "passed" } } }));
  const r = spawnSync(process.execPath, [afk, "salvage", "548", "--lesson=none:x", `--root=${epic}`], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(r.status, 1);
  // Only the state under --root knows task 548; the current directory has none.
  assert.match(r.stdout, /task 548 is passed; there is nothing to salvage/, r.stdout + r.stderr);
});

test("a --root= that is not a directory is refused by name", () => {
  const r = spawnSync(process.execPath, [afk, "reset", "548", "--root=/nonexistent/afk-root"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /--root=\/nonexistent\/afk-root is not a directory/);
});
