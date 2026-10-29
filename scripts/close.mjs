// scripts/close.mjs — `afk close --redo <epic>` (#213).
//
// A closed epic's closeout review and fix pass are read by `afk merge`
// (`review-at-head`, `must-fix-cleared`), and a relaunch leaves a closed
// closeout untouched, so one later commit on the branch made the merge
// unpassable for good. This re-runs the closeout through `runAuto`'s own
// close path (`redoClose`), so the verifier, the fix pass and its gate are the
// ones a close runs, at the branch's current head. The earlier records are
// kept in `state.epicClose.redos` (#140). Refused by `redoCloseRefusal`.
//
// One fix pass per epic (#228): once a pass has run, a redo re-reviews the head
// and runs no fixer (#235 S7). What that review still raises gets a fate with
// `afk fate`, and `must-fix-cleared` judges the re-review against the fates.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWrite, configPath, currentRepo, ensureDir, isMainModule, loadConfig, normalizeId } from "./lib.mjs";
import { redoCloseRefusal, runAuto as runAutoDefault } from "./auto.mjs";

/**
 * The fix pass this closeout already had, or null. A pass counts when the
 * fixer had items to work on, whatever its outcome; `nothing_to_do` spawned no
 * agent. Earlier redos count too: their records are in `epicClose.redos`.
 */
export const fixPassRan = (close) =>
  [close?.fixer, ...(close?.redos ?? []).map((redo) => redo?.fixer)]
    .find((fixer) => fixer && fixer.status !== "nothing_to_do" && Number(fixer.items) > 0) ?? null;

const usage = "Usage: afk close --redo <issue> [--repo=<owner/name>] [--base=<branch>]";

/** The epic and its DAG from GitHub, as `afk epic` reads them. */
const loadEpicDefault = async ({ repo, number, config }) => {
  const { fetchEpic, epicToDag } = await import("./epic.mjs");
  const { parseEpicBlock } = await import("./epic-spec.mjs");
  const fetched = fetchEpic({ repo, number });
  const dag = epicToDag(parseEpicBlock(fetched.body ?? ""), fetched.children ?? [], config, fetched);
  return { dag, epicBody: fetched.body ?? null, title: fetched.title ?? dag.epic?.title ?? null };
};

/**
 * The redo after the one fix pass: the closeout review again, at the current
 * head, and no fixer. The superseded review goes onto `epicClose.redos` with its
 * report copied beside it, as `runAuto`'s own redo does; the fixer's record and
 * report stay as the pass left them, so the next redo is review-only too.
 */
const reviewOnly = async ({ root, state, config, dag, epicBody, epicBase, number, verify }) => {
  const { verifierDecision, verifierReportPath } = await import("./verifier.mjs");
  const close = state.epicClose;
  const stamp = new Date().toISOString();
  const keptDir = resolve(root, ".afk", "epic-close", number, "redo", stamp.replace(/[:.]/g, "-"));
  const reports = [];
  if (existsSync(verifierReportPath(root, number))) {
    ensureDir(keptDir);
    atomicWrite(resolve(keptDir, "verifier-report.json"), readFileSync(verifierReportPath(root, number), "utf8"));
    reports.push(resolve(keptDir, "verifier-report.json"));
  }
  close.redos ??= [];
  close.redos.push({ verifier: close.verifier ?? null, fixer: close.fixer ?? null, fixGate: close.fixGate ?? null, reports, supersededAt: stamp, reviewOnly: true });
  const statePath = resolve(root, ".afk", "state.json");
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const report = await verify({ root, config, dag, epicBody, branch: dag.branch ?? null, baseBranch: epicBase, outstanding: [], reuse: true });
  const decision = report ? verifierDecision(report) : null;
  close.verifier = report && report.status !== "failed"
    ? {
        recommendation: decision.recommendation,
        blocking: decision.blocking,
        notes: decision.notes,
        ranAt: report.ranAt ?? null,
        head: report.head ?? null,
        reportPath: report.artifacts?.report ?? null,
        outstanding: [],
        // Read by `must-fix-cleared`: no fixer answers this review.
        afterFixPass: true,
      }
    : { recommendation: null, skipped: `the re-review did not complete (${report?.problems?.[0] ?? report?.status ?? "no report"})`, outstanding: [] };
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  if (!close.verifier.head) {
    console.log(`CLOSE: ${close.verifier.skipped}; the earlier review is kept in state.epicClose.redos.`);
    return 1;
  }
  const mustFix = (report.mustFix ?? []).length;
  console.log(`CLOSE: re-reviewed ${String(close.verifier.head).slice(0, 12)}: ${mustFix} must-fix, recommends \`${close.verifier.recommendation}\`. No fix pass ran.`);
  if (mustFix) console.log(`CLOSE: \`afk fate ${number}\` lists them; give each one still open a fate, or fix it and redo the review.`);
  return 0;
};

export const cli = async (args = process.argv.slice(2), root = process.cwd(), {
  loadEpic = loadEpicDefault,
  verify = null,
  runAuto = runAutoDefault,
} = {}) => {
  const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const number = normalizeId(String(args.find((arg) => !arg.startsWith("--")) ?? "").replace(/^#/, ""));
  if (!args.includes("--redo") || !/^\d+$/.test(number ?? "")) {
    console.log(usage);
    return 1;
  }
  if (!existsSync(configPath(root))) {
    console.log(`CLOSE: no .afk-setup/config.yaml at ${configPath(root)}.`);
    return 1;
  }
  let state = null;
  try { state = JSON.parse(readFileSync(resolve(root, ".afk", "state.json"), "utf8")); } catch {}
  const stateEpic = normalizeId(state?.epic?.id ?? state?.dag?.epic?.id ?? null);
  if (stateEpic && stateEpic !== number) {
    console.log(`CLOSE: this checkout's run state belongs to epic ${stateEpic}, not ${number}.`);
    return 1;
  }
  // Before the GitHub fetch: a refusal should cost nothing. STDOUT, like every
  // refusal a supervising agent has to read.
  const why = redoCloseRefusal({ root, state });
  if (why) {
    console.log(`CLOSE: cannot redo the closeout: ${why}`);
    return 1;
  }
  // One closeout fix pass per epic (#228). On #545 "one last pass" ran four
  // times and each re-review raised findings already decided; what is left
  // after the first pass gets a fate, not another pass.
  const pass = fixPassRan(state?.epicClose);
  if (pass) {
    console.log(`CLOSE: epic ${number} already had its closeout fix pass (${pass.ranAt ?? "time unknown"}, ${pass.items} item(s), ${pass.open ?? "?"} left open); re-reviewing the head with no second fix pass.`);
    console.log(`CLOSE: record a fate for each finding still open: \`afk fate ${number}\` lists them, then \`afk fate ${number} <finding> --accepted|--fixed|--dropped --reason="<why, with the link to your comment>" --by=owner\`.`);
  }
  const config = loadConfig(root);
  const repo = flag("repo") ?? currentRepo(root) ?? "";
  if (!repo) {
    console.log("CLOSE: cannot tell which repository this is. Pass --repo=<owner/name>.");
    return 1;
  }
  const { dag, epicBody, title } = await loadEpic({ repo, number, config });
  const epicBase = flag("base") || state?.epicBase || "main";
  if (pass) {
    const review = verify ?? (await import("./verifier.mjs")).runVerifier;
    return reviewOnly({ root, state, config, dag, epicBody, epicBase, number, verify: review });
  }
  return runAuto({
    config,
    dag,
    root,
    baseBranch: dag.branch,
    epic: { id: number, title },
    epicBase,
    redoClose: true,
  });
};

if (isMainModule(import.meta.url)) {
  cli()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.log(`CLOSE: ${error.message}`);
      process.exitCode = 1;
    });
}
