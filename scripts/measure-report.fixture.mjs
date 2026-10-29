// scripts/measure-report.fixture.mjs — a docs/measure folder whose numbers are
// known, for scripts/measure-report.test.mjs (#182).
//
// Dates are relative to `now`, so the two 7-day windows of `afk measure
// report` always hold the same epics:
//
//   earlier window  alpha #101 (10 days ago), alpha #102 (9 days ago)
//   latest window   beta #201 (3 days ago), alpha #202 (1 day ago, null fields)
//   outside both    alpha #50 (30 days ago)
//
// `node scripts/measure-report.fixture.mjs <dir>` writes it to <dir>, for a
// hand run with AFK_MEASURE_ROOT=<dir>.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./lib.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const task = (taskId, builderAttempts, lifecycle = "passed") => ({ taskId, builderAttempts, integrationAttempts: 1, lifecycle, agentDied: false });
const lane = (taskId, costUnits) => ({ taskId, kind: "builder", attempt: 1, efficiency: costUnits == null ? null : { costUnits } });

const close = (project, epicId, daysAgo, now, fields) => ({
  schema: 1,
  type: "close",
  project,
  epicId,
  at: new Date(now - daysAgo * DAY_MS).toISOString(),
  outcome: "complete",
  launches: fields.relaunches == null ? null : fields.relaunches + 1,
  gateRuns: { baseline: 1 },
  reds: [],
  integrationRetries: [],
  times: { launch: null, firstLaneStart: null, prOpened: null, closed: null },
  ...fields,
});

export const fixtureRows = (now) => ({
  alpha: [
    { schema: 1, type: "launch", project: "alpha", epicId: "101", at: new Date(now - 11 * DAY_MS).toISOString(), release: null },
    close("alpha", "50", 30, now, {
      relaunches: 9, gateReleases: 9, acceptances: 9, stops: [], falseReds: 9, repeats: 9,
      tasks: [task("1", 3)], closeout: { found: 9, fixed: 0, dropped: 0, left: 9 }, lanes: [lane("1", 9999)],
    }),
    // times 2+1+1 = 4, parked 3h, share 2/4, cleared 2+1 = 3, cost (100+300)/2
    close("alpha", "101", 10, now, {
      relaunches: 2, gateReleases: 1, acceptances: 1,
      stops: [{ kind: "human gate", at: null, parkedMs: 2 * HOUR_MS }, { kind: "fatal", at: null, parkedMs: HOUR_MS }],
      falseReds: 3, repeats: 2,
      tasks: [task("1", 1), task("2", 1), task("3", 2), task("4", 1, "failed")],
      closeout: { found: 4, fixed: 2, dropped: 1, left: 1 },
      lanes: [lane("1", 100), lane("2", 300)],
    }),
    // times 0, parked 0h, share 2/2, cleared 2, cost 400
    close("alpha", "102", 9, now, {
      relaunches: 0, gateReleases: 0, acceptances: 0, stops: [], falseReds: 1, repeats: 0,
      tasks: [task("1", 1), task("2", 1)],
      closeout: { found: 2, fixed: 2, dropped: 0, left: 0 },
      lanes: [lane("1", 400)],
    }),
    // Every field the rows may leave null, left null. Only the share is known.
    close("alpha", "202", 1, now, {
      relaunches: null, gateReleases: null, acceptances: 0, stops: null, falseReds: null, repeats: null,
      tasks: [task("1", 1), task("2", 1)],
      closeout: null,
      lanes: [lane("1", null)],
    }),
  ],
  beta: [
    // times 1, parked unknown (the still-parked null stop makes it a gap), share 1/4, cleared 1, cost 150
    close("beta", "201", 3, now, {
      relaunches: 1, gateReleases: 0, acceptances: 0,
      stops: [{ kind: "fatal", at: null, parkedMs: HOUR_MS }, { kind: "human gate", at: null, parkedMs: null }],
      falseReds: 0, repeats: 1,
      tasks: [task("1", 1), task("2", 2), task("3", 2), task("4", 3)],
      closeout: { found: 1, fixed: 1, dropped: 0, left: 0 },
      lanes: [lane("1", 150)],
    }),
  ],
});

export const FIXTURE_EPICS = ["50", "101", "102", "201", "202"];

/** The report on this fixture, number by number: [earlier, latest, change, direction]. */
export const FIXTURE_EXPECTED = {
  timesNeeded: [2, 1, -1, "improvement"],
  hoursParked: [1.5, null, null, "not comparable"],
  falseReds: [2, 0, -2, "improvement"],
  repeats: [1, 1, 0, "unchanged"],
  firstAttemptShare: [0.75, 0.625, -0.125, "degradation"],
  gateMinutes: [null, null, null, "not comparable"],
  laneMinutes: [null, null, null, "not comparable"],
  mustFixFound: [3, 1, -2, "improvement"],
  mustFixCleared: [2.5, 1, -1.5, "degradation"],
  costUnitsPerLane: [300, 150, -150, "improvement"],
};

export const writeFixture = (dir, now = Date.now()) => {
  mkdirSync(dir, { recursive: true });
  for (const [project, rows] of Object.entries(fixtureRows(now))) {
    writeFileSync(resolve(dir, `${project}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  }
  return dir;
};

if (isMainModule(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.log("usage: node scripts/measure-report.fixture.mjs <dir>");
    process.exitCode = 1;
  } else {
    console.log(`fixture written to ${writeFixture(resolve(dir))}`);
  }
}
