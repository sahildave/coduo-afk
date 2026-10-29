// scripts/report.mjs — a lane agent's explicit progress/completion signal.
// Writes .afk-report.json in the current directory (the lane's worktree).
// The herdr runtime polls this file; its mtime doubles as the freshness
// signal, replacing stream.jsonl for stall detection.
// Usage: node report.mjs --status working|done|failed [--phase <p>] [--reason <r>]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const status = flag('status');
if (!['working', 'done', 'failed'].includes(status)) {
  console.error('Usage: node report.mjs --status working|done|failed [--phase <p>] [--reason <r>]');
  process.exit(1);
}
const report = { status, updatedAt: new Date().toISOString() };
if (flag('phase')) report.phase = flag('phase');
if (flag('step')) report.step = Number(flag('step'));
if (flag('total')) report.total = Number(flag('total'));
if (flag('reason')) report.reason = flag('reason');
writeFileSync(resolve(process.cwd(), '.afk-report.json'), `${JSON.stringify(report, null, 2)}\n`);

// Inside a herdr pane, mirror the phase into the sidebar as the pane title
// (display-only; AFK reads the file above, never this).
if (process.env.HERDR_PANE_ID) {
  const title = status === 'done' ? 'done · awaiting integration'
    : status === 'failed' ? 'failed'
      : `${report.step && report.total ? `${report.step}/${report.total} · ` : ''}${report.phase ?? 'working'}`;
  spawnSync('herdr', ['pane', 'report-metadata', process.env.HERDR_PANE_ID,
    '--source', 'afk:progress', '--title', title, '--token', `progress=${title}`],
  { stdio: 'ignore' });
}
console.log(`afk report: ${status}${report.phase ? ` (${report.phase})` : ''}`);
