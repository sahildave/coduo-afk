// Explicit one-task entry point, including human-gated tasks. It deliberately
// uses the same worktree → builder → integration pipeline as auto.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeId } from './lib.mjs';
import { normalizeDag } from './auto.mjs';
import { taskBranch, taskWorktree } from './worktree.mjs';

const runnerDir = dirname(fileURLToPath(import.meta.url));

const taskArg = process.argv.slice(2).find((arg) => arg.startsWith('--task='));
const dagArg = process.argv.slice(2).find((arg) => arg.startsWith('--dag='));
if (!taskArg) {
  console.error('Usage: node scripts/run.mjs --task=<id> --dag=<path>');
  process.exit(1);
}
if (process.argv.includes('--dry-run')) {
  const id = normalizeId(taskArg.slice(7));
  if (!dagArg) { console.error('--dry-run needs --dag=<path> to describe the task.'); process.exit(1); }
  // Route the file through the same DAG boundary the run itself uses. Reading it
  // raw was a bug: `checks` and `allowedPaths` are legally absent on a task, so
  // `task.allowedPaths.join(' ')` died with a TypeError on exactly the DAG shape
  // the `afk:` block produces. normalizeDag resolves both and refuses an
  // ungateable task by id, so --dry-run now predicts what the run would do.
  let dag;
  try {
    dag = normalizeDag(
      JSON.parse(readFileSync(resolve(process.cwd(), dagArg.slice(6)), 'utf8')),
      loadConfig(process.cwd()),
    );
  } catch (error) { console.error(`RUN: ${error.message}`); process.exit(1); }
  const task = dag.tasks.find((candidate) => candidate.id === id);
  if (!task) { console.error(`Unknown task: ${id}`); process.exit(1); }
  console.table([{ id, title: task.title, branch: taskBranch(id), worktree: taskWorktree(process.cwd(), id), paths: task.allowedPaths.join(' '), checks: task.checks.length }]);
  process.exit(0);
}
const forwarded = process.argv.slice(2).filter((arg) => arg.startsWith('--task=') || arg.startsWith('--base=') || arg.startsWith('--runtime=') || arg.startsWith('--dag='));
const result = spawnSync(process.execPath, [resolve(runnerDir, 'auto.mjs'), ...forwarded], {
  cwd: process.cwd(), stdio: 'inherit', env: process.env,
});
process.exit(result.status ?? 1);
