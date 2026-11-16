// scripts/quota-reset.test.mjs — a limit message with no machine-readable
// resetsAt still yields one, so a quota hours away fails the lane at once
// instead of retrying every 5 minutes for 12 hours (AGENTS.md A#4).
import test from "node:test";
import assert from "node:assert/strict";
import { parseResetTime, parseStream, quotaExhaustedUntil } from "./agent-stats.mjs";

const H = 3600_000;
// 2026-11-15 21:00 IST.
const now = Date.UTC(2026, 10, 15, 15, 30);

test("reads the reset from the message text, in its named zone", () => {
  // The real message that stopped two lanes on 2026-11-15.
  const at = parseResetTime("You've hit your weekly limit · resets 6:30am (Asia/Calcutta)", now);
  assert.equal(at * 1000, Date.UTC(2026, 10, 16, 1, 0));
});

test("reads month-day shapes and rolls a long-past time forward", () => {
  assert.equal(parseResetTime("try again at Oct 2nd, 2026 12:47 AM.", now) !== null, true);
  const aug = parseResetTime("try again at Aug 16th (UTC)", now);
  assert.equal(new Date(aug * 1000).getUTCFullYear(), 2027);
  assert.equal(parseResetTime("resets 9am (UTC)", now) * 1000, Date.UTC(2026, 10, 16, 9, 0));
  assert.equal(parseResetTime("rate limit exceeded", now), null);
});

test("a stream whose result names the reset carries resetsAt", () => {
  const line = JSON.stringify({ type: "result", is_error: true, result: "You've hit your weekly limit · resets 6:30am (Asia/Calcutta)" });
  const s = parseStream(`${line}\n`);
  assert.equal(typeof s.rateLimit?.resetsAt, "number");
});

test("a reset past the wait budget is exhausted; one inside it is not", () => {
  const far = { resetsAt: Math.floor((now + 13 * H) / 1000) };
  const near = { resetsAt: Math.floor((now + 2 * H) / 1000) };
  assert.equal(quotaExhaustedUntil(far, 0, 12 * H, now), far.resetsAt);
  assert.equal(quotaExhaustedUntil(near, 0, 12 * H, now), null);
  assert.equal(quotaExhaustedUntil(near, 11 * H, 12 * H, now), near.resetsAt);
  assert.equal(quotaExhaustedUntil({}, 0, 12 * H, now), null);
});

test("a reset that has just passed is today's, not tomorrow's or next year's", () => {
  const t = Date.UTC(2026, 10, 16, 17, 4, 20);
  assert.equal(parseResetTime("resets 5:04pm (UTC)", t) * 1000, Date.UTC(2026, 10, 16, 17, 4));
  assert.equal(new Date(parseResetTime("try again at Nov 16th (UTC)", t) * 1000).getUTCFullYear(), 2026);
});

test("three-segment zones, DST days, a later match and 13pm", () => {
  assert.equal(parseResetTime("resets 6:30am (America/Argentina/Buenos_Aires)", now) * 1000, Date.UTC(2026, 10, 16, 9, 30));
  // 2027-03-14 is the US spring-forward day: 3:30am EDT is 07:30Z.
  assert.equal(parseResetTime("try again at Mar 14th, 2027 3:30 AM (America/New_York)", now) * 1000, Date.UTC(2027, 2, 14, 7, 30));
  assert.equal(parseResetTime("Your limit resets soon. try again at 5pm (UTC)", now) * 1000, Date.UTC(2026, 10, 15, 17, 0));
  assert.equal(parseResetTime("resets 13pm (UTC)", now), null);
});
