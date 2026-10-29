// scripts/herdr-launch-length.test.mjs — what a herdr lane types into its pane
// (#161).
//
// `herdr agent start --kind claude -- <argv>` types `claude <argv>` into the
// pane's shell. Once the standing instruction rode `--append-system-prompt`,
// that line was ~4,800 characters; the pane cut it at ~3,150, mid single-quote,
// zsh sat in its continuation prompt, and `claude` never started. Every lane
// failed with 0 tokens. So the payloads (settings JSON, the standing
// instruction, the broker's MCP config) go into files in the lane's run dir and
// the pane only ever sees their paths.
//
// Nothing here talks to herdr or a model: the typed line is reconstructed from
// the argv exactly as herdr quotes it, and a real `sh` runs it against a fake
// `claude` that prints its argv.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, withTimeBudget } from "./lib.mjs";
import { roleAgent, roleFor } from "./roles.mjs";
import { permissionBrokerArgs } from "./permission-broker.mjs";
import { laneAgentStartArgs } from "./runtime-herdr.mjs";

// Well under the ~3,150 characters the pane was seen to keep.
const SAFE_LINE = 1024;
// Every shell-hostile character a system prompt could carry.
const HOSTILE = `Don't stop. "Quoted" and 'single', a $HOME, a \`tick\`, a \\ backslash,\nand a second line; & | > < * ? ! ~ #end`;

const setup = (role) => {
  const dir = mkdtempSync(join(tmpdir(), "afk-herdr-launch-"));
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "task\n");
  const agent = withTimeBudget(roleAgent(roleFor(role), {}, "claude"), dir);
  const broker = permissionBrokerArgs({ promptPath, taskId: 940, runnerDir: "/runner" });
  return { dir, agent, broker };
};

// The words after `--` are what herdr hands to the pane's shell.
const typedLine = (argv) => `claude ${argv.slice(argv.indexOf("--") + 1).map(shellQuote).join(" ")}`;

for (const role of ["implementer", "integrator"]) {
  test(`a ${role} lane types a short line holding no payload`, () => {
    const { dir, agent, broker } = setup(role);
    try {
      const line = typedLine(laneAgentStartArgs({ name: "afk-940-1", pane: "p", agent, broker, launchDir: dir }));
      assert.ok(line.length < SAFE_LINE, `typed line is ${line.length} chars:\n${line}`);
      assert.ok(!line.includes(agent.appendSystemPrompt.slice(0, 40)), "raw standing instruction reached the pane");
      assert.ok(!line.includes("{"), "raw JSON reached the pane");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a real shell running the typed line hands claude every payload byte for byte", () => {
  const { dir, agent: base, broker } = setup("implementer");
  const agent = { ...base, appendSystemPrompt: HOSTILE };
  try {
    const fake = join(dir, "claude");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const line = typedLine(laneAgentStartArgs({ name: "afk-940-1", pane: "p", agent, broker, launchDir: dir }));
    assert.equal(spawnSync("sh", ["-n", "-c", line]).status, 0, "typed line does not parse");
    const ran = spawnSync("sh", ["-c", line], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(ran.status, 0, ran.stderr);
    const argv = JSON.parse(ran.stdout);
    const after = (flag) => argv[argv.indexOf(flag) + 1];
    assert.equal(readFileSync(after("--append-system-prompt-file"), "utf8"), HOSTILE);
    assert.ok(!argv.includes("--append-system-prompt"));
    assert.equal(readFileSync(after("--settings"), "utf8"), agent.settings);
    assert.deepEqual(
      JSON.parse(readFileSync(after("--mcp-config"), "utf8")),
      JSON.parse(broker[broker.indexOf("--mcp-config") + 1]),
    );
    // The short flags are untouched.
    assert.equal(after("--model"), agent.model);
    assert.equal(after("--permission-prompt-tool"), broker[1]);
    assert.ok(argv.includes("--dangerously-skip-permissions"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
