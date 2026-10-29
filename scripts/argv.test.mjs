// scripts/argv.test.mjs — the runner refuses a flag it does not know.
//
// `afk.mjs` used to split argv into a command and an opaque tail and hand the
// tail to the subcommand script verbatim, so `--worktreee`, `--bas=main` and
// `--jsonn` all ran happily with the operator's intent silently dropped. The
// parser lives in lib.mjs and the accepted-flag table beside the dispatch table
// in afk.mjs, so the enforcement point is one place for every subcommand.
//
// Nothing here reaches a model or the network: the end-to-end case dies in
// argv parsing, before afk.mjs spawns anything.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv } from "./lib.mjs";
import { COMMAND_FLAGS, HELP_SECTIONS, commands } from "../afk.mjs";
import { REPORT_LINE_BUDGET, truncateReport } from "./verifier.mjs";

const afk = fileURLToPath(new URL("../afk.mjs", import.meta.url));
const afkCodex = fileURLToPath(new URL("../afk-codex.mjs", import.meta.url));

// Transcribed by hand from afk.mjs's own help text, which is the contract this
// table is derived from: a flag in the table with no help text is a flag no
// operator can discover, and fails here.
//
// Hand transcription only ever catches drift between the table and this copy of
// it, which is why it covered three subcommands and missed `afk notify`, whose
// docs named a `--test` flag no script had ever read. `every accepted flag is
// discoverable` below reads HELP_SECTIONS itself and covers all of them.
const HELP_TEXT_FLAGS = {
  validate: ["repo", "base", "json", "epic-body", "plan-review", "unattended"],
  epic: ["repo", "base", "runtime", "worktree", "instructions", "task", "accept", "force", "delegate", "delegate-condition", "delegate-evidence", "delegated", "waive-user-facing", "epic-body", "unattended"],
  verify: ["repo", "base", "reuse", "json", "markdown", "full"],
  merge: ["repo", "root", "dry-run", "wait"],
  review: ["repo", "base"],
};

// The flags in HELP_SECTIONS[command], as an operator reading `afk <cmd> --help`
// would find them. Prose in one section can name another command's flag, so this
// is used in one direction only: table -> help text.
//
// The other direction is covered by `synopsisFlags` below, narrowly. Running it
// over the whole section would trip on those prose mentions; running it over the
// SYNOPSIS lines only — `  <command> <verb> [--flag]`, the left column an
// operator reads as "this is what I may type" — does not. `afk stack manifest
// --write` shipped documented and refused because nothing checked this way.
const documentedFlags = (command) =>
  new Set(
    [...(HELP_SECTIONS[command] ?? "").matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]),
  );

// The flags in a section's SYNOPSIS lines: those starting with two spaces and
// the command's own name, which is where this manual puts the usage line.
const synopsisFlags = (command) =>
  new Set(
    (HELP_SECTIONS[command] ?? "")
      .split("\n")
      .filter((line) => line.startsWith(`  ${command}`))
      .flatMap((line) => [...line.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1])),
  );

// `assert.throws` reports only that something threw, so the message — the whole
// point of failing loud — goes unread. Catch it instead.
const refusal = (argv, command) => {
  try {
    parseArgv(argv, COMMAND_FLAGS[command], { command });
  } catch (error) {
    return error.message;
  }
  return assert.fail(`afk ${command} ${argv.join(" ")} was accepted`);
};

test("an unknown flag is refused by name", () => {
  const message = refusal(["27", "--worktreee"], "epic");
  assert.match(message, /--worktreee/, "the offending flag must be named verbatim");
  // And the accepted set is printed, because "unknown flag" without the list is
  // a puzzle the operator has to leave the terminal to solve.
  assert.match(message, /--worktree\b/);
  // A value-form typo is the same mistake and gets the same treatment.
  assert.match(refusal(["--bas=main"], "epic"), /--bas\b/);
});

test("`afk epic --epic-body=` is accepted — cliEpic reads it, so the parser must not refuse it", () => {
  // Regression: epic.mjs's cliEpic reads flag("epic-body") (epic.mjs:1211) to run
  // an epic from a local body file, but the accepted-flag table omitted it, so the
  // new fail-loud parser refused a working command. The bug this epic shipped in
  // the very command that added the parser.
  assert.doesNotThrow(
    () => parseArgv(["27", "--epic-body=/tmp/body.md"], COMMAND_FLAGS.epic, { command: "epic" }),
    "afk epic --epic-body= is wired into cliEpic and must parse",
  );
});

test("an accepted flag survives the parser", () => {
  for (const [command, flags] of Object.entries(HELP_TEXT_FLAGS)) {
    assert.deepEqual(
      [...COMMAND_FLAGS[command]].sort(),
      [...flags].sort(),
      `afk ${command}'s accepted flags and its help text have drifted`,
    );
    for (const flag of flags) {
      assert.doesNotThrow(
        () => parseArgv([`--${flag}=x`], COMMAND_FLAGS[command], { command }),
        `afk ${command} --${flag}= is documented and must parse`,
      );
      assert.doesNotThrow(
        () => parseArgv([`--${flag}`], COMMAND_FLAGS[command], { command }),
        `afk ${command} --${flag} is documented and must parse`,
      );
    }
  }
});

// The drift guard over ALL of COMMAND_FLAGS, not the three transcribed above.
// Two subcommands are exempt, and each says why in afk.mjs:
//   selftest forwards node's own --test arguments (`null`, not a list);
//   start forwards its tail to `afk epic` verbatim, so its contract is epic's
//   accepted set, not a list of its own — asserted as that below.
test("every accepted flag is discoverable in its subcommand's help text", () => {
  assert.deepEqual(
    [...COMMAND_FLAGS.start].sort(),
    [...COMMAND_FLAGS.epic].sort(),
    "`afk start` forwards its tail to `afk epic`; a flag epic accepts and start does not is refused after the detach",
  );
  for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
    if (flags === null || command === "start") continue;
    const documented = documentedFlags(command);
    for (const flag of flags) {
      assert.ok(
        documented.has(flag),
        `afk ${command} accepts --${flag} but its help text never names it`,
      );
      assert.doesNotThrow(
        () => parseArgv([`--${flag}=x`], flags, { command }),
        `afk ${command} --${flag}= is documented and must parse`,
      );
    }
  }
});

test("`--unattended` is accepted by validate, epic and start, and each help entry describes it", () => {
  for (const command of ["validate", "epic", "start"]) {
    assert.doesNotThrow(
      () => parseArgv(["203", "--unattended"], COMMAND_FLAGS[command], { command }),
      `afk ${command} --unattended must parse`,
    );
    assert.ok(documentedFlags(command).has("unattended"), `afk ${command}'s help never names --unattended`);
  }
});

test("positional arguments are not flags", () => {
  const epic = parseArgv(["27", "--base=main"], COMMAND_FLAGS.epic, { command: "epic" });
  assert.deepEqual(epic.positional, ["27"]);
  assert.equal(epic.flags.base, "main");
  // A task id reaches the script it was typed for, untouched.
  const run = parseArgv(["--task=33", "33.1"], COMMAND_FLAGS.run, { command: "run" });
  assert.deepEqual(run.positional, ["33.1"]);
  assert.equal(run.flags.task, "33");
});

test("`afk` with a misspelled flag exits non-zero and names it", () => {
  const result = spawnSync(process.execPath, [afk, "validate", "27", "--jsonn"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /--jsonn/);
  // It refused before spawning the subcommand, so nothing downstream ran.
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /VALIDATE:/);
});

// The cheapest possible invocation should answer the commonest question. Bare
// `afk` used to print the ~170-line manual; the question a supervising agent
// actually has is "what is happening in this run", and `status` answers it in a
// dozen lines.
const runAfkAt = (cwd, ...argv) =>
  spawnSync(process.execPath, [afk, ...argv], {
    cwd,
    encoding: "utf8",
  });
const runnerRoot = fileURLToPath(new URL("..", import.meta.url));
const runAfk = (...argv) => runAfkAt(runnerRoot, ...argv);

test("bare afk prints status, not the manual", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-argv-status-"));
  try {
    const noRun = runAfkAt(dir);
    assert.equal(noRun.status, 0, `${noRun.stdout}\n${noRun.stderr}`);
    assert.doesNotMatch(noRun.stdout, /^Usage:$/m);
    assert.match(noRun.stdout, /No run in this project yet/);

    mkdirSync(join(dir, ".afk"));
    writeFileSync(
      join(dir, ".afk", "state.json"),
      JSON.stringify({
        dag: {
          epic: { id: "45" },
          branch: "smoke/codex-45",
          tasks: [{ id: "47", title: "Smoke", dependsOn: [] }],
        },
        tasks: { 47: { lifecycle: "pending" } },
      }),
    );
    const active = runAfkAt(dir);
    assert.equal(active.status, 0, `${active.stdout}\n${active.stderr}`);
    assert.doesNotMatch(active.stdout, /^Usage:$/m);
    assert.match(active.stdout, /epic 45 · smoke\/codex-45/);
    assert.match(active.stdout, /pending: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("afk help still prints the manual", () => {
  for (const flag of ["help", "--help", "-h"]) {
    const result = runAfk(flag);
    assert.equal(result.status, 0, `afk ${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^Usage:$/m, `afk ${flag} must print the manual`);
  }
});

// A supervising agent reads stdout. A refusal on stderr reads as a command that
// declined with no reason given.
test("a refused command explains itself on stdout", () => {
  const result = runAfk("nosuchcommand");
  assert.notEqual(result.status, 0, "an unknown command must still exit non-zero");
  assert.match(result.stdout, /Unknown command: nosuchcommand/);
  assert.equal(result.stderr, "", `the refusal must not go to stderr: ${result.stderr}`);
});

// Discovering one flag on `afk verify` used to cost the whole ~170-line manual,
// which a supervising agent pays for in context every time it asks.
test("a subcommand help prints only that subcommand", () => {
  const result = runAfk("verify", "--help");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /closeout review/, "verify's own text must be there");
  assert.doesNotMatch(
    result.stdout,
    /epic-ledger\.yaml/,
    "a sibling subcommand's section must not be printed",
  );
  const manual = runAfk("help").stdout.split("\n").length;
  const section = result.stdout.split("\n").length;
  assert.ok(
    section < manual / 4,
    `verify --help is ${section} lines against the manual's ${manual}; the point is that it is much smaller`,
  );
});

// A subcommand added to the dispatch table without usage text is one no
// operator can discover. `afk <command> --help` exits non-zero on it.
test("every dispatched subcommand has a help section", () => {
  for (const command of Object.keys(commands)) {
    const result = runAfk(command, "--help");
    assert.equal(
      result.status,
      0,
      `afk ${command} --help must print usage: ${result.stdout}${result.stderr}`,
    );
    assert.ok(result.stdout.trim().length > 0, `afk ${command} --help printed nothing`);
    assert.ok(HELP_SECTIONS[command], `no HELP_SECTIONS entry for ${command}`);
  }
});

// The same bound on `afk verify`, whose report is hundreds of lines and used to
// be pasted whole into the session that asked for one verdict.
test("verify report output truncates by default", () => {
  const report = Array.from({ length: REPORT_LINE_BUDGET * 2 }, (_, i) => `line ${i}`).join("\n");
  const truncated = truncateReport(report);
  assert.notEqual(truncated, report, "the default must not print the whole report");
  assert.match(truncated, /--full/, "the truncation line must name the flag that undoes it");
  assert.match(truncated, /\b60 more lines withheld\b/);
  assert.equal(truncateReport(report, { full: true }), report, "--full prints every line");
  // A report already inside the budget is passed through untouched.
  assert.equal(truncateReport("short\nreport"), "short\nreport");
});

// --- one dispatcher, two executables ----------------------------------------
// `afk-codex` selects the Codex backend by BEING a second executable, and does
// nothing else. If it ever grows a dispatch table of its own, the two drift:
// the copy stops gaining commands the day it is made, and the flag enforcement
// this whole file exists for covers only one of them.
const runCodex = (...argv) =>
  spawnSync(process.execPath, [afkCodex, ...argv], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });

test("afk-codex holds no dispatcher of its own — it imports afk.mjs's", () => {
  const source = readFileSync(afkCodex, "utf8");
  assert.match(source, /import \{ main \} from "\.\/afk\.mjs";/, "it must import the shared dispatcher");
  for (const copied of [/commands\s*=/, /COMMAND_FLAGS\s*=/, /HELP_SECTIONS\s*=/, /spawnSync/]) {
    assert.doesNotMatch(source, copied, `afk-codex re-implements ${copied}`);
  }
});

test("afk-codex dispatches the same commands, with the same help and the same refusals", () => {
  // Same manual, byte for byte: both executables read one HELP_SECTIONS.
  assert.equal(runCodex("help").stdout, runAfk("help").stdout);
  // `selftest` is dispatched — the subcommand `afk-codex selftest` would run.
  // Asserted through `--help`, which is answered by the shared dispatcher
  // before anything is spawned, so this costs no test run.
  const selftest = runCodex("selftest", "--help");
  assert.equal(selftest.status, 0, `${selftest.stdout}${selftest.stderr}`);
  assert.equal(selftest.stdout, HELP_SECTIONS.selftest + "\n");
  for (const command of Object.keys(commands)) {
    assert.equal(runCodex(command, "--help").status, 0, `afk-codex ${command} --help`);
  }
  // And the same flag enforcement, on stdout, for the same reason.
  const refused = runCodex("validate", "27", "--jsonn");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /--jsonn/);
  assert.match(runCodex("nosuchcommand").stdout, /Unknown command: nosuchcommand/);
});

test("every flag a command's usage line offers is a flag it accepts", () => {
  // The direction the older guard deliberately does not run, narrowed to the
  // synopsis so prose cannot trip it. `afk stack manifest --write` shipped
  // documented in the manual and REFUSED by the flag table, and the suite was
  // green: a verb that cannot be invoked is the exact failure this branch
  // exists to stop, arriving in the fix for it.
  for (const command of Object.keys(HELP_SECTIONS)) {
    const accepted = COMMAND_FLAGS[command];
    // `null` means "forward anything" — selftest's tail is node's own argv.
    if (accepted === null || accepted === undefined) continue;
    for (const flag of synopsisFlags(command)) {
      assert.ok(accepted.includes(flag),
        `afk ${command} offers --${flag} in its usage line but the flag table refuses it`);
    }
  }
});
