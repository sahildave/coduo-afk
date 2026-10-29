// scripts/review.mjs — the plan reviewer and the ticket reviewer as verbs of
// their own, runnable at any time and not only inside `afk validate`/`afk epic`.
//
//   afk review plan <epic> [--repo=] [--base=]  the whole plan review, all five questions
//   afk review ticket <issue> [--repo=]  only the fifth: does this issue contradict itself
//
// Why these exist: on 2026-10-13 the chief of staff edited one ruling line of
// atlas#1237 mid-run. Two acceptance criteria still required the old behaviour,
// and the plan review passed the ticket twice, because nothing re-asked anything
// after an edit and no question compared a ticket with itself. `review ticket`
// is the cheap check to run right after such an edit; `review plan` is the full
// one, without a branch, a worktree or `afk epic`.
//
// Both are read-only towards the repository: the transcript goes to a throwaway
// directory under $TMPDIR, as `afk validate --plan-review`'s does. `review plan`
// shares the carry-forward store under ~/.afk-claude/plan-review with
// `afk validate --plan-review` and `afk epic`, so a refusal found here is still
// raised by the next launch. `review ticket` keeps no store: it names no epic,
// and its whole purpose is to be rerun after the next edit.
//
// Exit status: 0 when nothing refuses, 1 on a refusing finding, an unusable
// review, a dead login, or a plan whose deterministic tier fails.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, currentRepo, isMainModule, loadConfig, normalizeId } from './lib.mjs';
import { fetchEpic, loadReport, planReview, renderValidation } from './epic.mjs';
import { runPlanReview } from './plan-review.mjs';
import { modelSwitchLine } from './model-check.mjs';

export const usage = `Usage:
  afk review plan <epic> [--repo=<owner/name>] [--base=<branch>]
  afk review ticket <issue> [--repo=<owner/name>]`;

const TICKET_KINDS = new Set(['inconsistent_ticket']);

/**
 * The rendering for `review ticket`. Not `renderPlanReview`: that one ends a
 * refusal with "No branch, worktree or pull request was created", which reads
 * as though a launch had been attempted.
 */
export const renderTicketReview = (outcome, issue) => {
  const lines = ['', `Ticket review of #${issue}:`];
  const pair = (finding) => `${finding.message}\n      "${finding.evidence}"\n      vs "${finding.contradicts}"`;
  for (const finding of outcome.contradictions ?? []) lines.push(`  ✗ inconsistent_ticket: ${pair(finding)}`);
  for (const finding of outcome.warnings ?? []) lines.push(`  - warning: inconsistent_ticket: ${pair(finding)}`);
  for (const entry of outcome.dropped ?? []) lines.push(`  · dropped ${entry.finding.kind}: ${entry.reason}`);
  const switched = modelSwitchLine('the ticket reviewer', outcome.modelCheck);
  if (switched) lines.push(`  ! ${switched}`);
  if (outcome.status === 'auth_failure' || outcome.status === 'unusable') {
    lines.push(`  ✗ ${outcome.message}`);
  } else if (outcome.status === 'contradiction') {
    lines.push('', `TICKET REVIEW: #${issue} contradicts itself. Edit it so the passages agree, then rerun.`);
  } else if ((outcome.warnings ?? []).length === 0) {
    lines.push(`  ✓ #${issue} does not contradict itself.`);
  }
  return lines.join('\n');
};

// A ticket can be reviewed from any checkout; with no .afk-setup/config.yaml
// the reviewer runs on the agent defaults, as `afk validate` does.
const readConfig = (root) => (existsSync(configPath(root)) ? loadConfig(root) : {});

/**
 * `afk review ticket <issue>`: one issue, one question. The issue is fetched
 * with the same read-only GraphQL query `afk validate` uses for an epic; its
 * sub-issues, if any, are ignored.
 */
export const reviewTicket = async ({ root, repo, number, exec, fetch = fetchEpic, config = readConfig(root) }) => {
  const issue = fetch({ repo, number });
  const id = normalizeId(issue.number);
  const dag = { tasks: [{ id, title: issue.title ?? '', body: issue.body ?? '', dependsOn: [] }] };
  const outcome = await runPlanReview({
    root,
    config,
    epic: { id: `ticket-${id}`, title: issue.title ?? '', body: '' },
    dag,
    metrics: { rows: [] },
    runDir: mkdtempSync(join(tmpdir(), `afk-ticket-review-${id}-`)),
    storePath: null,
    template: 'ticket-reviewer',
    onlyKinds: TICKET_KINDS,
    ...(exec ? { exec } : {}),
  });
  console.log(renderTicketReview(outcome, id));
  return outcome.ok ? 0 : 1;
};

// The base the epic recorded at launch (`afk epic` writes `epicBase` into
// .afk/state.json), when this checkout's run state is this epic's; else `main`.
export const recordedBase = (root, number) => {
  try {
    const state = JSON.parse(readFileSync(join(root, '.afk', 'state.json'), 'utf8'));
    const id = normalizeId(state?.epic?.id ?? state?.dag?.epic?.id ?? null);
    if (id === normalizeId(number) && typeof state.epicBase === 'string' && state.epicBase) return state.epicBase;
  } catch {}
  return 'main';
};

/**
 * `afk review plan <epic>`: the deterministic tier (the plan review needs the
 * DAG it builds), then the full plan review. The deterministic report prints
 * only when it fails, since then it is the reason no review ran.
 *
 * `branch_divergent` is a launch refusal: it protects a branch from being
 * resumed as if it were this epic's. A review launches nothing, and mid-run the
 * base moves under every epic as the others merge, so here it is a warning.
 */
export const reviewPlan = async ({ root, repo, number, baseBranch = recordedBase(root, number) }) => {
  const { epic, config, report } = loadReport({ root, repo, number, baseBranch, bodyPath: null });
  const divergent = report.errors.filter((entry) => entry.code === 'branch_divergent');
  if (divergent.length) {
    report.errors = report.errors.filter((entry) => entry.code !== 'branch_divergent');
    report.warnings.push(...divergent);
    report.ok = report.errors.length === 0;
    for (const entry of divergent) {
      console.log(`  - warning: branch_divergent (against \`${baseBranch}\`): ${entry.message} A review creates no branch, so it runs anyway.`);
    }
  }
  if (!report.ok) {
    console.log(renderValidation(report));
    console.log('\nREVIEW: the deterministic tier refused, so the plan review did not run.');
    return 1;
  }
  const outcome = await planReview({
    root,
    config,
    epic,
    report,
    quiet: false,
    runDir: mkdtempSync(join(tmpdir(), `afk-plan-review-${number}-`)),
    repo,
  });
  return outcome.ok ? 0 : 1;
};

const main = async () => {
  const args = process.argv.slice(2);
  // Both `--repo=o/n` and `--repo o/n`, as scripts/epic.mjs reads it.
  const at = args.indexOf('--repo');
  const spaced = at !== -1 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
  const flagged = args.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length) ?? spaced;
  const baseAt = args.indexOf('--base');
  const baseSpaced = baseAt !== -1 && args[baseAt + 1] && !args[baseAt + 1].startsWith('--') ? args[baseAt + 1] : null;
  const base = args.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) || baseSpaced;
  const positional = args.filter(
    (arg, index) => !arg.startsWith('--') && !(spaced && index === at + 1) && !(baseSpaced && index === baseAt + 1),
  );
  const [verb, raw] = positional;
  const number = normalizeId(String(raw ?? '').replace(/^#/, ''));
  if (!['plan', 'ticket'].includes(verb) || !/^\d+$/.test(number ?? '')) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const repo = flagged || currentRepo(root);
  if (!repo) {
    console.log('REVIEW: cannot tell which repository this is. Pass --repo=<owner/name>.');
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = verb === 'plan'
      ? await reviewPlan({ root, repo, number, ...(base ? { baseBranch: base } : {}) })
      : await reviewTicket({ root, repo, number });
  } catch (error) {
    console.log(`REVIEW: ${error.message}`);
    process.exitCode = 1;
  }
};

if (isMainModule(import.meta.url)) main();
