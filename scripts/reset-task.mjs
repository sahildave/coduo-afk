// Reset a task's lifecycle. `.afk/state.json` is the sole owner of lifecycle,
// so this touches exactly one file — there is no longer a manifest status to
// keep in step with it.
import { readFileSync } from 'node:fs';
import { atomicWrite, existsSync, die, normalizeId } from './lib.mjs';
import { clearTaskRuntime } from './scheduler.mjs';

const ids = process.argv.slice(2).map(normalizeId);
if (!ids.length) die('Usage: afk reset <task-id> [<task-id>...]  (or `all`)');
if (existsSync('.afk/orchestrator.lock')) die('Cannot reset tasks while `afk auto` owns runtime state. Stop it first.');

let state = null;
try { state = JSON.parse(readFileSync('.afk/state.json', 'utf8')); } catch {}
if (!state?.tasks) die('No runtime state to reset (.afk/state.json is missing).');

const resetRuntime = (id) => {
  state.tasks[id].lifecycle = 'pending';
  clearTaskRuntime(state, id);
};

const targets = ids[0] === 'all' ? Object.keys(state.tasks) : ids;
for (const id of targets) {
  if (!state.tasks[id]) die(`Unknown task: ${id}`);
  resetRuntime(id);
  if (ids[0] !== 'all') console.log(`Reset ${id} to pending.`);
}
atomicWrite('.afk/state.json', `${JSON.stringify(state, null, 2)}\n`);
if (ids[0] === 'all') console.log(`Reset all ${targets.length} tasks to pending.`);
