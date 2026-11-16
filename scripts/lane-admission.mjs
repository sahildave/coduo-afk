// scripts/lane-admission.mjs — a machine-wide cap on live lanes, across every epic.
//
// `maxParallel` caps lanes per epic; three epics on one Mac at 3 started 9 and
// nothing counted them or looked at memory. Each live lane writes one small file
// in `~/.afk-claude/lanes/` (pid, start time, project, epic, task). A runner
// counts the files of other runners whose pid is alive and not reused (the same
// check the gate lock uses), and removes the ones that are not.
//
// Admission also closes while macOS memory pressure is warn or critical, and
// reopens only after 3 clean readings in a row. Load average is not a signal:
// a busy desktop sits over the core count with no lanes running, and the gate
// has its own quiet-host wait (gate-lock.mjs).
//
// Fail direction: OPEN. An unreadable sysctl, an unwritable lanes directory or
// a non-darwin host admits lanes as before: a slow machine beats a stalled epic.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pidAlive } from './dashboard-data.mjs';
import { gateLockDir, pidReused, processStartedMs } from './gate-lock.mjs';

export const MAX_LANES_MACHINE = 8;
export const ADMISSION_REFRESH_MS = 5_000;
export const CLEAN_READINGS_TO_REOPEN = 3;

export const lanesDir = () => resolve(gateLockDir(), 'lanes');

/**
 * The machine lane cap, or null for no cap and no admission check at all.
 * `AFK_MAX_LANES_MACHINE` (a number, or `off`) wins over `maxLanesMachine` in
 * `.afk-setup/config.yaml` (a number, or `false`); the default is 8. `afk
 * selftest` sets it `off` so the suite never reads or writes the real machine.
 */
export const maxLanesMachine = (config, env = process.env) => {
  const raw = env.AFK_MAX_LANES_MACHINE ?? config?.maxLanesMachine;
  if (raw === undefined || raw === null || raw === '') return MAX_LANES_MACHINE;
  if (raw === false || /^(?:off|false|0)$/i.test(String(raw))) return null;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value > 0 ? value : MAX_LANES_MACHINE;
};

/** macOS memory pressure: 1 normal, 2 warn, 4 critical. null when unreadable. */
export const memoryPressureLevel = () => {
  if (platform() !== 'darwin') return null;
  const result = spawnSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' });
  const level = Number(String(result.stdout ?? '').trim());
  return Number.isFinite(level) && level > 0 ? level : null;
};

/** Write this runner's lane file; returns its path, or null if it cannot be written. */
export const registerLane = ({ dir = lanesDir(), project, epic = null, taskId }) => {
  const safe = (value) => String(value).replace(/\W/g, '_');
  const file = resolve(dir, `${process.pid}.${safe(project)}.${safe(epic)}.${safe(taskId)}.json`);
  const record = {
    pid: process.pid,
    pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    project,
    epic: epic == null ? null : String(epic),
    taskId,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    return file;
  } catch { return null; }
};

export const releaseLane = (file) => { if (file) rmSync(file, { force: true }); };

/** Lanes of OTHER live runners; files of dead or pid-reused runners are removed. */
export const countOtherLanes = ({ dir = lanesDir(), alive = pidAlive, startedAt = processStartedMs } = {}) => {
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return { lanes: 0, epics: 0 }; }
  const epics = new Set();
  let lanes = 0;
  for (const name of names) {
    const file = resolve(dir, name);
    let record = null;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt: stale */ }
    if (record && Number(record.pid) === process.pid) continue;
    if (!record || !alive(record.pid) || pidReused(record, startedAt)) { rmSync(file, { force: true }); continue; }
    lanes += 1;
    epics.add(`${record.project}#${record.epic}`);
  }
  return { lanes, epics: epics.size };
};

const PRESSURE_NAME = { 2: 'warn', 4: 'critical' };

/**
 * Admission for one runner. `machineSlots(ownLanes)` is how many more lanes the
 * machine will take now: Infinity when off, 0 while closed. Readings and the
 * lane count are refreshed at most every `refreshMs`.
 */
export const createLaneAdmission = ({
  config, env = process.env, dir = lanesDir(), say = console.log,
  pressure = memoryPressureLevel,
  alive = pidAlive, startedAt = processStartedMs, now = Date.now, refreshMs = ADMISSION_REFRESH_MS,
} = {}) => {
  const cap = maxLanesMachine(config, env);
  if (cap === null) return { enabled: false, machineSlots: () => Infinity };
  let closed = null;
  let clean = 0;
  let others = { lanes: 0, epics: 0 };
  let last = -Infinity;
  let atCap = false;
  const refresh = (own) => {
    if (now() - last < refreshMs) return;
    last = now();
    others = countOtherLanes({ dir, alive, startedAt });
    const level = Number(pressure());
    const reason = PRESSURE_NAME[level] ? `memory pressure ${PRESSURE_NAME[level]}` : null;
    const where = `(${others.epics + 1} epics, ${others.lanes + own} machine lanes)`;
    if (reason) {
      clean = 0;
      if (!closed) say(`AUTO: lane admission closed: ${reason} ${where}. Waiting.`);
      closed = reason;
    } else if (closed && (clean += 1) >= CLEAN_READINGS_TO_REOPEN) {
      say(`AUTO: lane admission reopened after ${CLEAN_READINGS_TO_REOPEN} clean readings ${where}.`);
      closed = null;
      clean = 0;
    }
  };
  return {
    enabled: true,
    machineSlots: (own = 0) => {
      refresh(own);
      if (closed) return 0;
      const free = Math.max(0, cap - others.lanes - own);
      if (!free && !atCap) say(`AUTO: lane admission at the machine cap: ${others.lanes + own} of ${cap} lanes across ${others.epics + 1} epics. Waiting.`);
      atCap = !free;
      return free;
    },
  };
};
