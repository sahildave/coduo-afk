#!/usr/bin/env node
// Live phase-DX demo: one real claude agent in a visible herdr pane, walking
// the 7-phase lane script and reporting each phase via scripts/report.mjs.
// Proves the sidebar row ("N/7 · Phase") updates while the agent works —
// no AFK scheduler, no worktree, no config.
//
//   node scripts/herdr-phase-demo.mjs [--model sonnet] [--keep]
//
// Costs real tokens (a tiny task). Workspace closes at the end unless --keep.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const KEEP = argv.includes('--keep');
const MODEL = flag('model', 'sonnet');
const SCRATCH = '/tmp/herdr-phase-demo';
const PHASES = ['Resolve', 'Context', 'Plan', 'Implement', 'Test', 'Self-check', 'Report'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const herdr = async (...args) => {
  const { stdout } = await exec('herdr', args.map(String));
  return stdout.trim() ? JSON.parse(stdout) : null;
};

const TASK = [
  'Task: in the current directory, create fizzbuzz.mjs exporting a function',
  'fizzbuzz(n) (classic rules), then run it with node to prove 1..15 is correct.',
  '',
  `Work through these phases in order: ${PHASES.join(' -> ')}.`,
  'Track them as your visible plan/task checklist and keep it updated.',
  `At the START of each phase run: node ${ROOT}/scripts/report.mjs --status working --phase <name> --step <n> --total ${PHASES.length}`,
  'Pause ~4 seconds at the start of each phase so the sidebar row is readable.',
  `When finished run: node ${ROOT}/scripts/report.mjs --status done  (or --status failed --reason "why"). Then stop.`,
].join('\n');

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  const ws = await herdr('workspace', 'create', '--cwd', SCRATCH,
    // Same shape a real lane gets from the DAG's epic: <epic>/#<ticket>.
    '--label', 'DEMO/#000 · fizzbuzz', '--no-focus');
  const workspaceId = ws.result.workspace.workspace_id;
  const paneId = ws.result.root_pane.pane_id;
  log(`workspace ${workspaceId} pane ${paneId} — watch the herdr agent sidebar`);

  // A fresh workspace's shell is not an interactive prompt yet; agent start
  // rejects instantly until it is (slice-1 lesson). Retry with backoff.
  // --strict-mcp-config with an empty config: outside a project the global
  // MCP servers load (and one needs auth), which pushes claude past herdr's
  // readiness timeout and the start silently retries forever. The demo needs
  // no MCP at all, so skip them and start in seconds.
  for (let wait = 2000; ; wait *= 2) {
    try {
      await herdr('agent', 'start', 'phase-demo', '--kind', 'claude', '--pane', paneId,
        '--timeout', 180000, '--', '--dangerously-skip-permissions', '--model', MODEL,
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
      break;
    } catch (err) {
      if (wait > 16000) throw err;
      log(`agent start not ready; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  await herdr('agent', 'prompt', 'phase-demo', TASK);
  log('agent prompted; polling .afk-report.json for phase changes');

  const reportPath = path.join(SCRATCH, '.afk-report.json');
  const deadline = Date.now() + 10 * 60_000;
  let last = '';
  let report = null;
  while (Date.now() < deadline) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch {}
    if (report) {
      const line = report.status === 'working'
        ? `${report.step}/${report.total} · ${report.phase}`
        : report.status;
      if (line !== last) { log(`sidebar: ${line}`); last = line; }
      if (report.status !== 'working') break;
    }
    await sleep(1000);
  }

  log(report?.status === 'done' ? 'lane reported done' : `lane ended: ${report?.status ?? 'no report'}`);
  if (KEEP) console.log(`\nLeft open. Close with:\n  herdr workspace close ${workspaceId}`);
  else await herdr('workspace', 'close', workspaceId);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
