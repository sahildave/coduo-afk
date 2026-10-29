// scripts/cross-checkout.test.mjs — every assertion in this suite that reads a
// checkout OTHER than this repo's.
//
// They live together on purpose. Each one can only be right where the thing it
// reads exists, so each is guarded by a presence check and SKIPS OUT LOUD
// elsewhere — and a suite that reaches outside its own repo should be auditable
// in one place rather than through `existsSync` guards scattered across files.
//
// The rule for anything added here: assert where the fix is possible, print
// what was skipped everywhere else, and never fail a partner's machine for
// lacking a checkout they were never expected to have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerRoot } from "./lib.mjs";
import { buildSkillManifest, loadSkillManifest } from "./stack.mjs";

const MARKETPLACE = join(runnerRoot, "..", "coduo-agents-marketplace");
const skill = (name) => join(MARKETPLACE, "plugins", "authored", "skills", name, "SKILL.md");

test("the committed skill manifest is not stale", (t) => {
  // Regenerate and diff. Only meaningful where a plugin source exists; the
  // deterministic half of this check — every catalogue name is IN the manifest
  // — lives in stack.test.mjs and runs everywhere.
  const { manifest, unverified } = buildSkillManifest();
  const derivable = Object.keys(manifest.plugins).filter((p) => !unverified.includes(p));
  if (!derivable.length) {
    t.diagnostic("SKIPPED: no catalogue plugin is installed or checked out here.");
    return;
  }
  const committed = loadSkillManifest();
  for (const plugin of derivable) {
    assert.deepEqual(manifest.plugins[plugin].skills, committed.plugins?.[plugin]?.skills,
      `${plugin} has drifted — run \`afk stack manifest --write\``);
  }
});

test("no skill still routes setup through coduo-afk's deleted Phase S", (t) => {
  // The tripwire for a PARTIAL edit. coduo-afk Phase S.1 delegated to
  // `setup-coduo-agents`, which was slash-only, so the delegation could never
  // fire. Phase S is gone and the skill is model-invocable; a copy of either
  // that still names Phase S is half of that change, and half of it routes a
  // setup request at a phase that no longer exists.
  if (!existsSync(MARKETPLACE)) {
    t.diagnostic(`SKIPPED: no marketplace checkout at ${MARKETPLACE}.`);
    return;
  }
  for (const name of ["coduo-afk", "setup-coduo-agents"]) {
    const path = skill(name);
    if (!existsSync(path)) { t.diagnostic(`SKIPPED ${name}: not in this checkout.`); continue; }
    const text = readFileSync(path, "utf8");
    assert.ok(!/Phase S\b/.test(text), `${name} still names Phase S`);
  }
});

test("setup-coduo-agents is model-invocable, or nothing can delegate to it", (t) => {
  // The other half of the same change, and the one that failed silently for
  // months: a slash-only skill is absent from every agent's skill list, so a
  // pointer at it from anywhere resolves to nothing.
  const path = skill("setup-coduo-agents");
  if (!existsSync(path)) {
    t.diagnostic("SKIPPED: setup-coduo-agents is not in this checkout.");
    return;
  }
  const front = readFileSync(path, "utf8").split("\n").slice(0, 12).join("\n");
  assert.ok(!/^disable-model-invocation:\s*true\s*$/m.test(front),
    "setup-coduo-agents is slash-only again — nothing can delegate to it");
});
