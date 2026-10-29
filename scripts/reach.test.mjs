// scripts/reach.test.mjs — the four Reach lists, against real artifacts.
//
// Every case below is built from output a real tool produced against a real
// repository, for the reason scripts/fixtures/README.md gives: an invented
// fixture agrees with whoever invented it. The two `git log` transcripts and
// the two `knip` payloads under `scripts/fixtures/atlas-workspace/` were
// captured byte-for-byte on 2026-09-19 from `owner/atlas-workspace`.
//
// The one exception is the positive case for `undeclaredWrites`, and it is
// flagged where it appears: no AFK run has ever recorded a non-empty
// `keptOutsideDeclaredPaths`, which is itself the finding this list exists for.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  filesByTask,
  newUnusedExports,
  parseKnipReport,
  seamFiles,
  undeclaredWrites,
  untouchedAllowed,
} from "./reach.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...parts) =>
  readFileSync(resolve(here, "fixtures", "atlas-workspace", ...parts), "utf8");
const json = (...parts) => JSON.parse(fixture(...parts));

// ---------------------------------------------------------------------------
// seamFiles
// ---------------------------------------------------------------------------

test("seamFiles finds the five files two lanes of epic #654 both wrote", () => {
  const seams = seamFiles(fixture("epic-654", "git-log-name-only.txt"));
  assert.deepEqual(
    seams.map((entry) => entry.file).sort(),
    [
      "src/features/filters/components/FilterBar.test.tsx",
      "src/features/filters/components/FilterBar.tsx",
      "src/features/filters/components/FilterMenuGroups.test.tsx",
      "src/features/filters/components/FilterMenuPicker.tsx",
      "src/features/filters/components/FilterScopeSection.tsx",
    ],
  );
  for (const entry of seams) assert.deepEqual([...entry.tasks].sort(), ["657", "661"]);
});

test("seamFiles reports nothing for an epic whose two lanes shared no file", () => {
  // Epic #625: task 626 owns `scripts/release/**`, task 627 owns the docs and
  // `scripts/prepare-release.js`. Disjoint, and the axis must say so.
  assert.deepEqual(seamFiles(fixture("epic-625", "git-log-name-only.txt")), []);
});

test("seamFiles attributes nothing to a non-task commit", () => {
  // `fix(654): close the epic's three pending closeout items` is the first
  // commit in the #654 transcript and touches `locales/en.json`, which no lane
  // wrote. A parser that let a file block leak across its subject would put it
  // under whichever task came next.
  const attributed = seamFiles(
    `${fixture("epic-654", "git-log-name-only.txt")}\ntask 657: second write\n\nlocales/en.json\n`,
  );
  const locales = attributed.find((entry) => entry.file === "locales/en.json");
  assert.equal(locales, undefined, "a closeout commit's file must not be charged to a lane");
  // Positive half, so this case cannot pass over a function that returns
  // nothing: the appended second write by 657 makes a real seam of a file that
  // 661 wrote, and it has to appear.
  assert.deepEqual(
    attributed.find((entry) => entry.file === "src/domain/filter.ts"),
    undefined,
  );
  assert.ok(
    attributed.some((entry) => entry.file === "src/features/filters/components/FilterBar.tsx"),
  );
});

test("seamFiles reads a merge subject that follows a file block as a subject", () => {
  // The hard line in the real transcript: `Merge task 626: …` sits directly
  // under the last file of task 627's block, with no blank line between them,
  // because `--name-only` prints no file list for a merge.
  const log = [
    "task 627: The release runbook describes the path that actually runs",
    "",
    "scripts/prepare-release.js",
    "Merge task 626: Release scripts refuse what they cannot verify",
    "task 626: Release scripts refuse what they cannot verify",
    "",
    "scripts/prepare-release.js",
  ].join("\n");
  assert.deepEqual(seamFiles(log), [
    { file: "scripts/prepare-release.js", tasks: ["627", "626"] },
  ]);
});

test("filesByTask gives epic #625's two lanes the exact surface the log shows", () => {
  // The whole branch, attributed. Task 626 owns the release scripts, 627 the
  // docs and the workflow — and `docs/progress.md`, written by three `afk:
  // update task status` commits, belongs to neither.
  const byTask = filesByTask(fixture("epic-625", "git-log-name-only.txt"));
  assert.deepEqual([...byTask.keys()], ["627", "626"]);
  assert.deepEqual(byTask.get("626"), [
    "scripts/release/macos-signing-cert.sh",
    "scripts/release/release-local.sh",
    "scripts/release/updater-asset-name.mjs",
    "scripts/release/updater-asset-name.test.mjs",
  ]);
  assert.deepEqual(byTask.get("627"), [
    ".github/workflows/release.yml",
    "docs/developer/desktop-updates.md",
    "docs/developer/macos-signing.md",
    "docs/developer/releases.md",
    "scripts/prepare-release.js",
  ]);
  for (const files of byTask.values()) {
    assert.ok(!files.includes("docs/progress.md"), "runner bookkeeping charged to a lane");
  }
});

test("seamFiles is total on empty and on garbage", () => {
  assert.deepEqual(seamFiles(""), []);
  assert.deepEqual(seamFiles(null), []);
  assert.deepEqual(seamFiles("no commits here at all"), []);
});

// ---------------------------------------------------------------------------
// undeclaredWrites
// ---------------------------------------------------------------------------

test("undeclaredWrites reports nothing for a real lane that stayed in scope", () => {
  // The committed gitproj-demo artifact, unedited: `keptOutsideDeclaredPaths`
  // is `[]`, which means nothing was reverted.
  const verification = JSON.parse(
    readFileSync(
      resolve(here, "fixtures", "gitproj-demo", "epic-50", "runs", "45", "builder-1", "verification.json"),
      "utf8",
    ),
  );
  assert.deepEqual(verification.keptOutsideDeclaredPaths, [], "fixture drifted");
  assert.deepEqual(undeclaredWrites({ 45: verification }), []);
});

test("undeclaredWrites collects the lanes that kept an out-of-scope edit", () => {
  // CONSTRUCTED, and deliberately so: across every run artifact on this machine
  // — 69 `verification.json` files and the live git notes on atlas-workspace —
  // not one records a non-empty `keptOutsideDeclaredPaths`. The field's shape is
  // taken from scripts/worker.mjs:600, where it is `changed.filter(...)`, a
  // plain array of repository-relative paths; the paths below are real files
  // from epic #654's own transcript.
  const verifications = {
    657: { keptOutsideDeclaredPaths: ["src/components/ui/dropdown-menu.tsx"] },
    658: { keptOutsideDeclaredPaths: [] },
    661: { keptOutsideDeclaredPaths: ["src/domain/filter.ts", "locales/en.json"] },
  };
  assert.deepEqual(undeclaredWrites(verifications), [
    { taskId: "657", paths: ["src/components/ui/dropdown-menu.tsx"] },
    { taskId: "661", paths: ["src/domain/filter.ts", "locales/en.json"] },
  ]);
});

test("undeclaredWrites is total on a missing field and a missing map", () => {
  assert.deepEqual(undeclaredWrites({ 12: {} }), []);
  assert.deepEqual(undeclaredWrites(null), []);
});

// ---------------------------------------------------------------------------
// untouchedAllowed
// ---------------------------------------------------------------------------

test("untouchedAllowed names the declared glob epic #654's lanes never used", () => {
  // Task 661's real changed-file list, read off the fixture transcript.
  const changed = [
    "src/components/ui/dropdown-menu.tsx",
    "src/domain/filter.test.ts",
    "src/domain/filter.ts",
    "src/features/filters/components/ConceptIcon.tsx",
    "src/features/filters/components/FilterBar.tsx",
  ];
  assert.deepEqual(
    untouchedAllowed(
      ["src/features/filters/**", "src/domain/filter.ts", "src/features/board/**"],
      changed,
    ),
    ["src/features/board/**"],
  );
});

test("untouchedAllowed uses the runner's own glob semantics", () => {
  // `*` does not cross a separator and `**` does — the property scripts/lib.mjs
  // `globToRegExp` exists to hold. A second matcher here would let the verifier
  // and the worker disagree about what "in scope" means.
  assert.deepEqual(untouchedAllowed(["src/*.ts"], ["src/features/a.ts"]), ["src/*.ts"]);
  assert.deepEqual(untouchedAllowed(["src/**"], ["src/features/a.ts"]), []);
});

test("untouchedAllowed is total on empty inputs", () => {
  assert.deepEqual(untouchedAllowed([], ["a.ts"]), []);
  assert.deepEqual(untouchedAllowed(null, null), []);
  assert.deepEqual(untouchedAllowed(["a.ts"], []), ["a.ts"]);
});

// ---------------------------------------------------------------------------
// newUnusedExports
// ---------------------------------------------------------------------------

test("newUnusedExports finds the one export epic #654 added and nothing calls", () => {
  // Both payloads are `knip --reporter json --include exports,types`, run on
  // 2026-09-19: base at `2ac213f2` (the commit #654 was cut from) and head at
  // `7c3d048b` (the branch tip). 495 unused exports at base, 496 at head — the
  // ratchet is the whole point, an absolute count says nothing.
  //
  // `FieldKindIcon` is real and is exactly the #365 shape: `grep -rn
  // FieldKindIcon src/` on that tree returns its own `export function` line and
  // nothing else.
  assert.deepEqual(
    newUnusedExports(json("epic-654", "knip-base.json"), json("epic-654", "knip-head.json")),
    [{ file: "src/features/shared/components/FieldGlyph.tsx", symbol: "FieldKindIcon" }],
  );
});

test("newUnusedExports is a ratchet, not a count", () => {
  const base = json("epic-654", "knip-base.json");
  // Head equal to base: 495 pre-existing unused exports, none of them this
  // epic's business. A gate on the absolute number would be red forever.
  assert.deepEqual(newUnusedExports(base, base), []);
  // And a branch that DELETED unused exports reports nothing either — this list
  // only ever names what head added.
  assert.deepEqual(newUnusedExports(base, { issues: [] }), []);
});

test("newUnusedExports counts an unused exported type beside an unused export", () => {
  // knip splits the two into `exports` and `types`; both are an export nothing
  // imports, and the real payload carries 24 of the second kind.
  const base = { issues: [] };
  const head = {
    issues: [
      {
        file: "src/features/billing/billing-view.ts",
        exports: [{ name: "NO_BILLING_VIEW", line: 115, col: 14, pos: 4763 }],
        types: [{ name: "BillingInterval", line: 106, col: 13, pos: 4216 }],
      },
    ],
  };
  assert.deepEqual(newUnusedExports(base, head), [
    { file: "src/features/billing/billing-view.ts", symbol: "BillingInterval" },
    { file: "src/features/billing/billing-view.ts", symbol: "NO_BILLING_VIEW" },
  ]);
});

test("newUnusedExports is total on absent payloads", () => {
  assert.deepEqual(newUnusedExports(null, null), []);
  assert.deepEqual(newUnusedExports(undefined, { issues: [{ file: "a.ts", exports: [{ name: "x" }] }] }), [
    { file: "a.ts", symbol: "x" },
  ]);
});

// ---------------------------------------------------------------------------
// parseKnipReport
// ---------------------------------------------------------------------------

test("parseKnipReport skips the noise knip prints ahead of its report", () => {
  // Not hypothetical. knip loads this repo's configs in-process and `landing`'s
  // Stripe catalogue logs while it does, so the `--reporter json` stream starts
  // with six of these lines — scripts/fixtures/README.md records them as the
  // only thing removed from the two committed payloads. `JSON.parse` on the raw
  // stdout throws, which would silently cost the runner the whole list.
  const noisy = `[stripe-catalog] No Stripe credentials\n${fixture("epic-654", "knip-head.json")}`;
  assert.deepEqual(
    newUnusedExports(json("epic-654", "knip-base.json"), parseKnipReport(noisy)),
    [{ file: "src/features/shared/components/FieldGlyph.tsx", symbol: "FieldKindIcon" }],
  );
});

test("parseKnipReport answers null rather than throwing", () => {
  // The caller is `collectReach`, whose contract is that a closeout must not die
  // because a list could not be computed. A command that printed a stack trace,
  // or nothing at all, is an ABSENT list — never an exception, and never `{}`,
  // which would read as "knip found nothing" and turn every pre-existing unused
  // export on the branch into a new finding.
  assert.equal(parseKnipReport("Error: Cannot find module 'knip'"), null);
  assert.equal(parseKnipReport(""), null);
  assert.equal(parseKnipReport("noise {not json at all"), null);
  assert.equal(parseKnipReport(null), null);
});
