import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isWithinReminderTimeWindow,
  getISTClock,
  startDailyReminderCron,
  stopDailyReminderCron,
} from "../cron/dailyReminderCron.js";

/**
 * Daily reminder timing: a 05:00 reminder must go out at 05:00 IST — not at
 * 04:55, the first tick of the old symmetric ±5-minute window — and the
 * scheduler must register once per process. Pure functions + an injected
 * fake cron library; no database, no WAPLIFY. The full tick → claim → HTTP
 * path (including two real OS processes) is in
 * tests/reminderTimingEndToEnd.test.js.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Tests 1–5: the due window ────────────────────────────────────────────────
test("1–3: reminder 05:00 is NOT due at 04:54, 04:55 or 04:59 (never early)", () => {
  for (const current of ["04:50", "04:54", "04:55", "04:56", "04:57", "04:58", "04:59"]) {
    assert.equal(isWithinReminderTimeWindow("05:00", current), false, current);
  }
});

test("4: reminder 05:00 IS due at 05:00 (the configured minute: any tick 05:00:00–05:00:59)", () => {
  assert.equal(isWithinReminderTimeWindow("05:00", "05:00"), true);
});

test("5: late-tick policy — still due 05:01–05:05 (delayed tick / late process start / same-day retry of a failed send), not after", () => {
  for (const current of ["05:01", "05:02", "05:03", "05:04", "05:05"]) {
    assert.equal(isWithinReminderTimeWindow("05:00", current), true, current);
  }
  for (const current of ["05:06", "05:30", "09:23"]) {
    assert.equal(isWithinReminderTimeWindow("05:00", current), false, current);
  }
});

test("every allowed reminder time (04:00–06:00) opens exactly at its own minute", () => {
  for (const scheduled of ["04:00", "04:30", "05:00", "05:30", "06:00"]) {
    const [h, m] = scheduled.split(":").map(Number);
    const minus1 = new Date(Date.UTC(2000, 0, 1, h, m - 1)).toISOString().slice(11, 16);
    assert.equal(isWithinReminderTimeWindow(scheduled, minus1), false, `${scheduled} @ ${minus1}`);
    assert.equal(isWithinReminderTimeWindow(scheduled, scheduled), true, scheduled);
  }
});

test("reminder_time stored as a MySQL TIME ('05:00:00') behaves the same as '05:00'", () => {
  assert.equal(isWithinReminderTimeWindow("05:00:00", "04:55"), false);
  assert.equal(isWithinReminderTimeWindow("05:00:00", "05:00"), true);
  assert.equal(isWithinReminderTimeWindow("05:00:00", "05:05"), true);
  assert.equal(isWithinReminderTimeWindow("05:00:00", "05:06"), false);
});

// ── Tests 7–8: IST date/time, timezone and midnight boundaries ──────────────
test("7: IST clock for instants whose UTC date differs from the IST date", () => {
  // 05:00 IST on Sep 25 is still Sep 24 in UTC.
  assert.deepEqual(getISTClock(new Date("2026-09-24T23:29:00Z")), { date: "2026-09-25", time: "04:59" });
  assert.deepEqual(getISTClock(new Date("2026-09-24T23:30:00Z")), { date: "2026-09-25", time: "05:00" });
  assert.deepEqual(getISTClock(new Date("2026-09-24T23:30:59.999Z")), { date: "2026-09-25", time: "05:00" });
  assert.deepEqual(getISTClock(new Date("2026-09-24T23:31:00Z")), { date: "2026-09-25", time: "05:01" });
});

test("8: IST midnight boundary — date and time come from one instant", () => {
  assert.deepEqual(getISTClock(new Date("2026-09-24T18:29:59Z")), { date: "2026-09-24", time: "23:59" });
  assert.deepEqual(getISTClock(new Date("2026-09-24T18:30:00Z")), { date: "2026-09-25", time: "00:00" });
  // Month/year rollover.
  assert.deepEqual(getISTClock(new Date("2026-12-31T18:30:00Z")), { date: "2027-01-01", time: "00:00" });
});

test("8: the window never wraps past midnight (a post-midnight tick belongs to the next IST day)", () => {
  assert.equal(isWithinReminderTimeWindow("23:58", "23:58"), true);
  assert.equal(isWithinReminderTimeWindow("23:58", "23:59"), true);
  assert.equal(isWithinReminderTimeWindow("23:58", "00:01"), false);
  assert.equal(isWithinReminderTimeWindow("00:00", "23:59"), false, "no early send across midnight either");
  assert.equal(isWithinReminderTimeWindow("00:00", "00:00"), true);
});

test("7: the IST clock is independent of the Node process TZ (UTC, Asia/Kolkata, America/Los_Angeles, Pacific/Chatham)", () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, "..", "cron", "dailyReminderCron.js")).href;
  const script = `
    const { getISTClock } = await import(${JSON.stringify(moduleUrl)});
    const instants = ["2026-09-24T23:29:00Z", "2026-09-24T23:30:00Z", "2026-09-24T18:30:00Z", "2026-03-08T21:30:00Z", "2026-11-01T20:30:00Z"];
    console.log("CLOCKS:" + JSON.stringify(instants.map((i) => getISTClock(new Date(i)))));
    process.exit(0);
  `;
  const expected = [
    { date: "2026-09-25", time: "04:59" },
    { date: "2026-09-25", time: "05:00" },
    { date: "2026-09-25", time: "00:00" },
    { date: "2026-03-09", time: "03:00" }, // LA spring-forward night (US DST switch at 10:00Z)
    { date: "2026-11-02", time: "02:00" }, // LA fall-back night
  ];
  for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Chatham"]) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: tz, NODE_ENV: "test", TEST_DATABASE_URL: "" },
      encoding: "utf8",
      timeout: 30000,
    });
    const line = run.stdout.split("\n").find((l) => l.startsWith("CLOCKS:"));
    assert.ok(line, `TZ=${tz} produced no output: ${run.stderr}`);
    assert.deepEqual(JSON.parse(line.slice("CLOCKS:".length)), expected, `TZ=${tz}`);
  }
});

// ── Tests 18–19: one registration per process ───────────────────────────────
const makeFakeCron = () => {
  const scheduled = [];
  return {
    scheduled,
    schedule(expression, fn) {
      const task = { expression, fn, stopped: false, stop() { this.stopped = true; } };
      scheduled.push(task);
      return task;
    },
  };
};

test("19: startDailyReminderCron called twice in one process registers ONE every-minute job", () => {
  const fakeCron = makeFakeCron();
  try {
    const first = startDailyReminderCron({ cronLib: fakeCron });
    const second = startDailyReminderCron({ cronLib: fakeCron });
    assert.equal(fakeCron.scheduled.length, 1);
    assert.equal(first, second);
    assert.equal(first.expression, "* * * * *");
  } finally {
    stopDailyReminderCron();
  }
});

test("18: stop → start re-registers exactly once more (shutdown clears the job; no leftover second job)", () => {
  const fakeCron = makeFakeCron();
  const first = startDailyReminderCron({ cronLib: fakeCron });
  stopDailyReminderCron();
  assert.equal(first.stopped, true);
  stopDailyReminderCron(); // idempotent
  const second = startDailyReminderCron({ cronLib: fakeCron });
  startDailyReminderCron({ cronLib: fakeCron });
  stopDailyReminderCron();
  assert.equal(fakeCron.scheduled.length, 2);
  assert.notEqual(first, second);
});

test("18: importing the scheduler module registers nothing (only server.js starts it)", async () => {
  const fakeCron = makeFakeCron();
  await import("../cron/dailyReminderCron.js?second-import");
  assert.equal(fakeCron.scheduled.length, 0);
  // A fresh start in this process still succeeds → nothing was registered at import time.
  const task = startDailyReminderCron({ cronLib: fakeCron });
  stopDailyReminderCron();
  assert.equal(fakeCron.scheduled.length, 1);
  assert.equal(task.stopped, true);
});
