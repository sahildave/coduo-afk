/**
 * Fixture helpers shared by the test files. Test-only: nothing in the runner
 * imports this.
 *
 * `writeConfig` exists because the project config moved to
 * `.afk-setup/config.yaml`, and a test that hand-writes YAML would drift from
 * the parser it must satisfy. Round-tripping through `toYamlSubset` means a
 * fixture is wrong the same way production is wrong, or not at all.
 *
 * Deliberately NOT in `lib.mjs`: the runner has no config writer and must not
 * grow one — a runner that rewrites its own config is how a failed run used to
 * leave the tree dirty (see the note above `loadConfig`).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toYamlSubset, parseYamlSubset } from "./epic-spec.mjs";

/**
 * Absolute path to a committed run artifact under `scripts/fixtures/gitproj-demo/`.
 *
 * These used to be read out of the playground repo's live `.afk/` tree, which
 * meant `afk archive` silently turned the tests that read them into skips. They
 * are committed now; see scripts/fixtures/README.md for each file's provenance.
 * There is no existence guard on purpose — a missing fixture must fail loudly.
 */
export const fixture = (relative) =>
  join(fileURLToPath(new URL("./fixtures/gitproj-demo/", import.meta.url)), relative);

export const configFile = (repo) => join(repo, ".afk-setup", "config.yaml");

export const writeConfig = (repo, config) => {
  const path = configFile(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toYamlSubset(config));
  return path;
};

export const readConfig = (repo) => parseYamlSubset(readFileSync(configFile(repo), "utf8"));

/**
 * Points the lanes readers at `dir` for one test: `AFK_TRANSCRIPTS_ROOT` and
 * `AFK_LANES_CACHE` become paths under it, then `overrides` apply (`undefined`
 * deletes a variable). Every variable touched is restored in `t.after`. A
 * dashboard spawned with `...process.env` otherwise reads this machine's real
 * transcripts and rewrites its real `~/.cache/afk/lanes-cache.json`.
 */
export const isolateEnv = (t, dir, overrides = {}) => {
  const values = { AFK_TRANSCRIPTS_ROOT: join(dir, "transcripts"), AFK_LANES_CACHE: join(dir, "lanes-cache.json"), ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const set = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(values);
  t.after(() => set(previous));
  return values;
};

/**
 * Another epic's full gate, in its own process, holding the machine-wide gate
 * lock (#178) at `path` for `ms` (until SIGTERM when null). A separate process because
 * a holder with the waiter's own pid is never waited on.
 * `held` resolves once the lock is taken; `exited` when the process ends.
 */
export const holdGateLock = (path, { ms = null, holder = { project: "other-repo", epic: "928", kind: "baseline" } } = {}) => {
  const moduleUrl = new URL("./gate-lock.mjs", import.meta.url).href;
  const code = `import(${JSON.stringify(moduleUrl)}).then(async ({ acquireGateLock }) => {
    const lock = await acquireGateLock({ path: ${JSON.stringify(path)}, holder: ${JSON.stringify(holder)}, pollMs: 20 });
    process.stdout.write("held\\n");
    // SIGTERM is a clean release; SIGKILL is a crash that leaves the file.
    process.on("SIGTERM", () => { lock.release(); process.exit(0); });
    ${ms === null ? "setInterval(() => {}, 60_000);" : `setTimeout(() => { lock.release(); process.exit(0); }, ${ms});`}
  });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise((done, fail) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("held")) done(); });
    child.on("exit", (code) => fail(new Error(`the lock holder exited (${code}) before taking the lock`)));
  });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  // `stop` belongs in every test's `finally`: a holder left alive holds the
  // test (and the suite) open, so a red would read as a hang.
  const stop = async () => { child.kill("SIGKILL"); await exited; };
  return { pid: child.pid, held, exited, kill: (signal = "SIGKILL") => child.kill(signal), stop };
};
