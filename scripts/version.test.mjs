// The version command exists to keep two clocks apart, so the test's job is to
// prove they ARE apart: a runner version that moved to 2.x and an `afk:` block
// spec version that did not. A test asserting only "prints something" would pass
// just as happily on the bug this guards — the two bumped together, refusing
// every version-1 epic in every consuming repo.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { RUNNER_VERSION } from "./lib.mjs";
import { SPEC_VERSION } from "./epic-spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const afk = resolve(here, "..", "afk.mjs");
const afkCodex = resolve(here, "..", "afk-codex.mjs");
// Drop any AFK_BACKEND the developer's shell exported: `afk` now honours it
// (that is what the inheritance test below proves), so these Claude-expecting
// assertions must pin the env rather than inherit it. Node stringifies an
// `undefined` env value, so the key is deleted, not set to "undefined".
const claudeEnv = (() => {
  const env = { ...process.env };
  delete env.AFK_BACKEND;
  return env;
})();
const cli = (arg) => execFileSync(process.execPath, [afk, arg], { encoding: "utf8", env: claudeEnv });

test("RUNNER_VERSION is 2.x and SPEC_VERSION is untouched by it", () => {
  assert.match(RUNNER_VERSION, /^2\.\d+\.\d+$/);
  // Not `!== RUNNER_VERSION`: the point is the exact value. The `afk:` block
  // schema did not change on the v2 branch, so an epic written for v1 must
  // still validate. See CHANGELOG.md, "The runner is v2; the epic spec is not".
  assert.equal(SPEC_VERSION, 1);
});

test("`afk version`, `--version` and `-v` all print both versions", () => {
  for (const arg of ["version", "--version", "-v"]) {
    const out = cli(arg);
    assert.match(out, new RegExp(`afk-claude ${RUNNER_VERSION.replace(/\./g, "\\.")}`), arg);
    assert.match(out, new RegExp(`epic spec version: ${SPEC_VERSION}\\b`), arg);
  }
});

test("`afk help` points at the version command and says the two differ", () => {
  const out = cli("help");
  assert.match(out, /^\s+version\s+Print this runner's version/m);
  assert.match(out, /the runner is 2\.x, the spec is still 1/);
});

// The second executable prints its own name and the same two clocks. Both
// versions are the runner's, not a backend's: `afk-codex` is this runner
// resolved against Codex, not a fork of it, and a divergent version number
// would be the first sign that it had become one.
test("`afk-codex --version` exits 0 and names the Codex executable", () => {
  for (const arg of ["version", "--version", "-v"]) {
    const out = execFileSync(process.execPath, [afkCodex, arg], { encoding: "utf8" });
    assert.match(out, new RegExp(`afk-codex ${RUNNER_VERSION.replace(/\./g, "\\.")}`), arg);
    assert.match(out, new RegExp(`epic spec version: ${SPEC_VERSION}\\b`), arg);
    assert.doesNotMatch(out, /afk-claude/, arg);
  }
});

// AFK_BACKEND is the single source of backend selection. A nested `afk.mjs`
// (a wave's `auto`, say) passes no backend to `main`, so it must inherit the
// parent's choice from the environment rather than resetting to Claude — this
// is the reset that made `afk-codex wave run` refuse a valid Codex login (#68).
// The version line names the resolved executable, so it reads that inheritance
// directly, and fails on the pre-fix hardcoded `backend = DEFAULT_BACKEND`.
test("`afk` with AFK_BACKEND=codex inherited resolves the Codex backend", () => {
  const out = execFileSync(process.execPath, [afk, "version"], {
    encoding: "utf8",
    env: { ...process.env, AFK_BACKEND: "codex" },
  });
  assert.match(out, new RegExp(`afk-codex ${RUNNER_VERSION.replace(/\./g, "\\.")}`));
  assert.doesNotMatch(out, /afk-claude/);
});
