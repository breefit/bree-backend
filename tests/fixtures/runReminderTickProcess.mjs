/**
 * Child-process fixture for tests/reminderTimingEndToEnd.test.js: one
 * separate OS process (its own PID, memory and DB pool — like a second
 * Hostinger/PM2 process) that runs exactly ONE daily-reminder scheduler tick.
 *
 * Env (set by the parent test, never production):
 *   TEST_DATABASE_URL, NODE_ENV=test, WAPLIFY_BASE_URL (fake 127.0.0.1 server),
 *   WAPLIFY_API_KEY (fake), WAPLIFY_TEMPLATE_DAILY_REMINDER
 *   TICK_AT_MS   — the (mocked) instant the tick believes it is
 *   START_AT_MS  — real epoch ms to wait for, so sibling processes tick together
 *
 * Prints one line: RESULT:{...runDailyReminderScheduler() result, pid}
 */
import { mock } from "node:test";

const realNow = () => performance.timeOrigin + performance.now();
const startAt = Number(process.env.START_AT_MS || 0);
if (!/^http:\/\/127\.0\.0\.1:/.test(process.env.WAPLIFY_BASE_URL || "")) {
  throw new Error("fixture refuses to run without a local fake WAPLIFY_BASE_URL");
}

const db = await import("../../src/config/database.js");
const cron = await import("../../cron/dailyReminderCron.js");

while (realNow() < startAt) {
  await new Promise((r) => setTimeout(r, 1));
}

mock.timers.enable({ apis: ["Date"], now: Number(process.env.TICK_AT_MS) });
try {
  const result = await cron.runDailyReminderScheduler();
  console.log(`RESULT:${JSON.stringify({ ...result, pid: process.pid })}`);
} finally {
  mock.timers.reset();
  await db.closePool();
}
