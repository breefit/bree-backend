import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createDailyReminder } from "../src/services/dailyReminderService.js";
import {
  claimReminderSendSlot,
  resolveReminderSendSuccess,
  resolveReminderSendFailure,
  isWithinReminderTimeWindow,
} from "../cron/dailyReminderCron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const paymentControllerSource = read("../src/controllers/paymentController.js");
const subscriptionControllerSource = read(
  "../src/controllers/subscriptionController.js",
);
const dailyReminderCronSource = read("../cron/dailyReminderCron.js");
const dailyReminderServiceSource = read(
  "../src/services/dailyReminderService.js",
);
const databaseSource = read("../src/config/database.js");

/**
 * In-memory stand-in for the `daily_reminders` table, driven through the
 * exact INSERT createDailyReminder() issues. Simulates the
 * (order_id, product_id) UNIQUE constraint added by
 * ensureDailyReminderOrderProductUnique() in database.js.
 */
const createFakeRemindersTable = () => {
  const rows = [];

  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO daily_reminders")) {
      const [
        id,
        userId,
        orderId,
        orderItemId,
        productId,
        reminderEnabled,
        reminderTime,
        reminderChannel,
        whatsappNumber,
        phoneSource,
        pricePaid,
        originalPrice,
        packageDurationDays,
        status,
      ] = params;

      if (rows.some((r) => r.order_id === orderId && r.product_id === productId)) {
        const err = new Error(
          "Duplicate entry for key 'uq_daily_reminders_order_product'",
        );
        err.code = "ER_DUP_ENTRY";
        throw err;
      }

      rows.push({
        id,
        user_id: userId,
        order_id: orderId,
        order_item_id: orderItemId,
        product_id: productId,
        reminder_enabled: reminderEnabled,
        reminder_time: reminderTime,
        reminder_channel: reminderChannel,
        reminder_whatsapp_number: whatsappNumber,
        reminder_phone_source: phoneSource,
        reminder_price_paid: pricePaid,
        reminder_original_price: originalPrice,
        package_duration_days: packageDurationDays,
        status,
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake daily_reminders query: ${normalized}`);
  };

  return { queryExecutor, rows };
};

// ── 1-8: purchase → persistence (createDailyReminder) ──────────────────────

test("createDailyReminder: a valid purchased reminder creates exactly one row with all required fields", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  const result = await createDailyReminder({
    userId: "user-1",
    orderId: "order-1",
    orderItemId: "item-1",
    productId: "product-1",
    reminderTime: "05:30",
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    packageDurationDays: 30,
    reminderWhatsappNumber: "9876543210",
    reminderPhoneSource: "custom",
    queryExecutor,
  });

  assert.equal(result.success, true);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.order_id, "order-1");
  assert.equal(row.order_item_id, "item-1");
  assert.equal(row.product_id, "product-1");
  assert.equal(row.reminder_time, "05:30");
  assert.equal(row.reminder_channel, "whatsapp");
  assert.equal(row.reminder_whatsapp_number, "919876543210"); // normalized
  assert.equal(row.reminder_phone_source, "custom");
  assert.equal(row.reminder_price_paid, 49);
  assert.equal(row.reminder_original_price, 99);
  assert.equal(row.package_duration_days, 30);
  assert.equal(row.reminder_enabled, 1);
  assert.equal(row.status, "active");
});

test("createDailyReminder: invalid/missing reminder time is rejected, no row is created", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  const result = await createDailyReminder({
    orderId: "order-2",
    productId: "product-1",
    reminderTime: "09:00", // not one of the allowed slots
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    queryExecutor,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Invalid reminder time/);
  assert.equal(rows.length, 0);
});

test("createDailyReminder: negative reminder price is rejected", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  await assert.rejects(() =>
    createDailyReminder({
      orderId: "order-3",
      productId: "product-1",
      reminderTime: "05:30",
      reminderPricePaid: -10,
      reminderOriginalPrice: 99,
      queryExecutor,
    }),
  );
  assert.equal(rows.length, 0);
});

test("createDailyReminder: guest checkout (no user_id) is supported", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  const result = await createDailyReminder({
    userId: null,
    orderId: "order-4",
    orderItemId: "item-4",
    productId: "product-1",
    reminderTime: "05:30",
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    reminderWhatsappNumber: "9876543210",
    reminderPhoneSource: "custom",
    queryExecutor,
  });

  assert.equal(result.success, true);
  assert.equal(rows[0].user_id, null);
});

test("createDailyReminder: WhatsApp number is normalized (bare 10-digit and 91-prefixed both work; missing falls back to null for send-time resolution)", async () => {
  const { queryExecutor: qe1, rows: rows1 } = createFakeRemindersTable();
  await createDailyReminder({
    orderId: "order-5a",
    productId: "product-1",
    reminderTime: "05:30",
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    reminderWhatsappNumber: "919876543210",
    queryExecutor: qe1,
  });
  assert.equal(rows1[0].reminder_whatsapp_number, "919876543210");

  const { queryExecutor: qe2, rows: rows2 } = createFakeRemindersTable();
  await createDailyReminder({
    orderId: "order-5b",
    productId: "product-1",
    reminderTime: "05:30",
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    reminderWhatsappNumber: null,
    reminderPhoneSource: "profile",
    queryExecutor: qe2,
  });
  // No number stored here — the scheduler falls back to the customer's
  // order/profile phone at send time (see getEligibleReminders below).
  assert.equal(rows2[0].reminder_whatsapp_number, null);
});

test("createDailyReminder: invalid WhatsApp number throws rather than silently storing garbage", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  await assert.rejects(() =>
    createDailyReminder({
      orderId: "order-6",
      productId: "product-1",
      reminderTime: "05:30",
      reminderPricePaid: 49,
      reminderOriginalPrice: 99,
      reminderWhatsappNumber: "12345", // too short, invalid
      queryExecutor,
    }),
  );
  assert.equal(rows.length, 0);
});

test("createDailyReminder: exactly one row per (order_id, product_id) — a second attempt for the same pair fails loudly, not silently", async () => {
  const { queryExecutor, rows } = createFakeRemindersTable();

  await createDailyReminder({
    orderId: "order-7",
    productId: "product-1",
    reminderTime: "05:30",
    reminderPricePaid: 49,
    reminderOriginalPrice: 99,
    queryExecutor,
  });
  assert.equal(rows.length, 1);

  await assert.rejects(
    () =>
      createDailyReminder({
        orderId: "order-7",
        productId: "product-1",
        reminderTime: "06:00",
        reminderPricePaid: 49,
        reminderOriginalPrice: 99,
        queryExecutor,
      }),
    /Duplicate entry/,
  );
  assert.equal(rows.length, 1, "must not create a second row for the same order+product");
});

// ── 9-12: the actual regression — createOrder now persists the reminder
//    itself, instead of depending on verifyPayment reconstructing it from
//    whatever the client resends in the payment-verify callback ─────────────

test("ROOT CAUSE FIX: createOrder creates daily_reminders transactionally, in the same request as order_items, before any payment happens", () => {
  // This is the actual regression fix. Previously daily_reminders was only
  // ever created inside verifyPayment, reconstructed from req.body.reminders
  // — a payload the client has to correctly resend after Razorpay Magic
  // Checkout completes. A page reload / app-switch during mobile payment
  // (very plausible: WhatsApp in-app browser, UPI app switch) can wipe that
  // client-side state, and verifyPayment had no fallback: the order still
  // finalized as paid, but daily_reminders silently ended up empty even
  // though the reminder charge was already collected. Moving creation into
  // createOrder — which already inserts order_items in the same transaction
  // — means the row exists from trusted server-side data before the
  // customer ever opens the Razorpay checkout, matching the pattern
  // subscriptionController.createSubscription already used correctly.
  const createOrderSource = paymentControllerSource.slice(
    paymentControllerSource.indexOf("export const createOrder"),
    paymentControllerSource.indexOf("export const formatRazorpayShippingAddress"),
  );

  assert.match(createOrderSource, /INSERT INTO order_items/);
  const afterOrderItems = createOrderSource.slice(
    createOrderSource.indexOf("INSERT INTO order_items"),
  );
  assert.match(afterOrderItems, /for \(const reminder of validatedReminders\)/);
  assert.match(afterOrderItems, /createDailyReminder\(/);
  assert.match(afterOrderItems, /queryExecutor: client\.query\.bind\(client\)/);
  // Payment hasn't happened yet at this point — safe (and correct) to fail
  // the whole request if a purchased reminder can't be persisted.
  assert.match(afterOrderItems, /throw new Error\(\s*\n?\s*reminderResult\?\.error/);
});

test("verifyPayment skips reminder re-creation when createOrder already created it, and does not roll back an already-paid order on failure", () => {
  const verifyPaymentSource = paymentControllerSource.slice(
    paymentControllerSource.indexOf("export const verifyPayment"),
  );
  const reminderBlockStart = verifyPaymentSource.indexOf(
    "Create daily reminders if provided",
  );
  const reminderBlock = verifyPaymentSource.slice(
    reminderBlockStart,
    verifyPaymentSource.indexOf(
      'await client.query("COMMIT")',
      reminderBlockStart,
    ),
  );

  // Checks for an existing row before attempting anything.
  assert.match(
    reminderBlock,
    /SELECT id FROM daily_reminders WHERE order_id = \? AND product_id = \?/,
  );
  assert.match(reminderBlock, /\[DAILY_REMINDER\] SKIPPED/);

  // Payment has already been captured by this point — a reminder failure
  // must not roll back the order. The per-reminder failure must NOT be
  // rethrown.
  const catchBlock = reminderBlock.slice(
    reminderBlock.indexOf("} catch (reminderErr) {"),
    reminderBlock.indexOf("} catch (remindersErr) {"),
  );
  assert.doesNotMatch(catchBlock, /throw reminderErr/);
});

test("subscriptionController already uses the same eager, transactional reminder-creation pattern (consistency check across entry points)", () => {
  const createSubSource = subscriptionControllerSource.slice(
    subscriptionControllerSource.indexOf("export const createSubscription"),
  );
  assert.match(createSubSource, /INSERT INTO order_items/);
  const afterOrderItems = createSubSource.slice(
    createSubSource.indexOf("INSERT INTO order_items"),
  );
  assert.match(afterOrderItems, /createDailyReminder\(/);
  assert.match(afterOrderItems, /queryExecutor: client\.query\.bind\(client\)/);
});

test("the daily_reminders (order_id, product_id) unique constraint is self-provisioned, matching the database's own auto-provisioning pattern", () => {
  assert.match(
    databaseSource,
    /ADD UNIQUE INDEX uq_daily_reminders_order_product \(order_id, product_id\)/,
  );
  assert.match(
    databaseSource,
    /await ensureDailyReminderOrderProductUnique\(\)/,
  );
});

// ── 13-15 continued: reminder log line never leaks a raw phone number ──────

test("daily reminder creation log is masked, not raw", () => {
  assert.doesNotMatch(
    dailyReminderServiceSource,
    /Phone: \$\{normalizedWhatsappNumber/,
  );
  assert.match(dailyReminderServiceSource, /maskMobile\(/);
});

// ── 16-22: scheduler — claim-before-send, duplicate prevention, retry ──────

/**
 * In-memory stand-in for `daily_reminder_sends`, driven through the exact
 * SQL claimReminderSendSlot/resolveReminderSendSuccess/Failure issue.
 */
const createFakeSendsTable = () => {
  const rows = new Map(); // `${reminderId}:${sendDate}` -> row

  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT IGNORE INTO daily_reminder_sends")) {
      const [id, reminderId, sendDate] = params;
      const key = `${reminderId}:${sendDate}`;
      if (!rows.has(key)) {
        rows.set(key, {
          id,
          reminder_id: reminderId,
          send_date: sendDate,
          status: "pending",
          sent_at: null,
          waplify_message_id: null,
          error_message: null,
        });
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes("SET status = 'sending'")) {
      const [reminderId, sendDate, staleMinutes] = params;
      const row = rows.get(`${reminderId}:${sendDate}`);
      if (!row) return { rows: [], rowCount: 0 };
      const isStaleSending =
        row.status === "sending" &&
        row.sent_at &&
        Date.now() - row.sent_at.getTime() > staleMinutes * 60 * 1000;
      const claimable =
        row.status === "pending" || row.status === "failed" || isStaleSending;
      if (!claimable) return { rows: [], rowCount: 0 };
      row.status = "sending";
      row.sent_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'success'")) {
      const [messageId, reminderId, sendDate] = params;
      const row = rows.get(`${reminderId}:${sendDate}`);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "success";
      row.waplify_message_id = messageId;
      row.error_message = null;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'failed'")) {
      const [errorMessage, reminderId, sendDate] = params;
      const row = rows.get(`${reminderId}:${sendDate}`);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "failed";
      row.error_message = errorMessage;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake daily_reminder_sends query: ${normalized}`);
  };

  return { queryExecutor, rows };
};

test("scheduler: claiming a send slot succeeds once; a second claim the same day is refused (duplicate scheduler execution cannot send twice)", async () => {
  const { queryExecutor } = createFakeSendsTable();

  const first = await claimReminderSendSlot("reminder-1", "2026-09-12", queryExecutor);
  const second = await claimReminderSendSlot("reminder-1", "2026-09-12", queryExecutor);

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
});

test("scheduler: concurrent claims for the same reminder+day — only one caller ever wins (multiple concurrent workers cannot send twice)", async () => {
  const { queryExecutor } = createFakeSendsTable();

  const [a, b] = await Promise.all([
    claimReminderSendSlot("reminder-2", "2026-09-12", queryExecutor),
    claimReminderSendSlot("reminder-2", "2026-09-12", queryExecutor),
  ]);

  const claimedCount = [a, b].filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1);
});

test("scheduler: a successful send is recorded as success with the provider message id, and can never be re-claimed", async () => {
  const { queryExecutor, rows } = createFakeSendsTable();

  const claim = await claimReminderSendSlot("reminder-3", "2026-09-12", queryExecutor);
  assert.equal(claim.claimed, true);

  await resolveReminderSendSuccess(
    "reminder-3",
    "2026-09-12",
    "wamid.abc123",
    queryExecutor,
  );
  assert.equal(rows.get("reminder-3:2026-09-12").status, "success");
  assert.equal(rows.get("reminder-3:2026-09-12").waplify_message_id, "wamid.abc123");

  const reclaim = await claimReminderSendSlot("reminder-3", "2026-09-12", queryExecutor);
  assert.equal(reclaim.claimed, false, "a successful send must never be re-sent");
});

test("scheduler: a failed send is recorded as failed (not success), and CAN be retried on a later tick the same day", async () => {
  const { queryExecutor, rows } = createFakeSendsTable();

  const claim = await claimReminderSendSlot("reminder-4", "2026-09-12", queryExecutor);
  assert.equal(claim.claimed, true);

  await resolveReminderSendFailure(
    "reminder-4",
    "2026-09-12",
    "Waplify 500: provider unavailable",
    queryExecutor,
  );
  assert.equal(rows.get("reminder-4:2026-09-12").status, "failed");

  // Simulates the next minute's cron tick re-evaluating the same reminder.
  const retryClaim = await claimReminderSendSlot(
    "reminder-4",
    "2026-09-12",
    queryExecutor,
  );
  assert.equal(retryClaim.claimed, true, "a failed send must be retryable");

  await resolveReminderSendSuccess("reminder-4", "2026-09-12", "wamid.retry", queryExecutor);
  assert.equal(rows.get("reminder-4:2026-09-12").status, "success");
});

test("scheduler: a claim abandoned mid-send (process crash) is reclaimed after the staleness window, not lost forever", async () => {
  const { queryExecutor, rows } = createFakeSendsTable();
  rows.set("reminder-5:2026-09-12", {
    id: "x",
    reminder_id: "reminder-5",
    send_date: "2026-09-12",
    status: "sending",
    sent_at: new Date(Date.now() - 10 * 60 * 1000), // claimed 10 min ago, never resolved
    waplify_message_id: null,
    error_message: null,
  });

  const claim = await claimReminderSendSlot("reminder-5", "2026-09-12", queryExecutor);
  assert.equal(claim.claimed, true);
});

test("scheduler: a claim still fresh (well within the staleness window) is NOT reclaimed by a second caller", async () => {
  const { queryExecutor } = createFakeSendsTable();
  const { rows } = createFakeSendsTable();
  const fake = createFakeSendsTable();
  fake.rows.set("reminder-6:2026-09-12", {
    id: "x",
    reminder_id: "reminder-6",
    send_date: "2026-09-12",
    status: "sending",
    sent_at: new Date(), // just claimed
    waplify_message_id: null,
    error_message: null,
  });

  const claim = await claimReminderSendSlot("reminder-6", "2026-09-12", fake.queryExecutor);
  assert.equal(claim.claimed, false);
});

test("isWithinReminderTimeWindow: matches within tolerance, rejects outside it", () => {
  assert.equal(isWithinReminderTimeWindow("05:30", "05:30"), true);
  assert.equal(isWithinReminderTimeWindow("05:30", "05:34"), true); // 4 min, within 5
  assert.equal(isWithinReminderTimeWindow("05:30", "05:26"), true); // 4 min early
  assert.equal(isWithinReminderTimeWindow("05:30", "05:36"), false); // 6 min, outside
  assert.equal(isWithinReminderTimeWindow("05:30", "05:24"), false);
});

test("no raw customer phone number is ever interpolated directly into a console.* call in the reminder cron", () => {
  assert.doesNotMatch(
    dailyReminderCronSource,
    /console\.(log|info|warn|error)\([^)]*\$\{sendMobile\}/,
  );
  assert.doesNotMatch(
    dailyReminderCronSource,
    /console\.(log|info|warn|error)\([^)]*\$\{customer_phone\}/,
  );
  assert.match(dailyReminderCronSource, /maskMobile\(sendMobile\)/);
});

test("the scheduler's WhatsApp phone-number resolution priority is reminder_whatsapp_number, falling back to the order/profile phone", () => {
  assert.match(
    dailyReminderCronSource,
    /const sendMobile = reminder_whatsapp_number \|\| customer_phone;/,
  );
  // customer_phone itself is resolved with COALESCE(profile, order contact, order mobile).
  assert.match(
    dailyReminderCronSource,
    /COALESCE\(u\.phone, o\.contact_phone, o\.mobile_number\) AS customer_phone/,
  );
});

test("disabled or expired reminders are excluded by the eligibility query itself", () => {
  const eligibleSource = dailyReminderCronSource.slice(
    dailyReminderCronSource.indexOf("const getEligibleReminders"),
    dailyReminderCronSource.indexOf("const claimReminderSendSlot") === -1
      ? undefined
      : dailyReminderCronSource.indexOf(
          "export const claimReminderSendSlot",
        ),
  );
  assert.match(eligibleSource, /dr\.reminder_enabled = 1/);
  assert.match(eligibleSource, /dr\.status = 'active'/);
  assert.match(eligibleSource, /dr\.reminder_start_date <= \?/);
  assert.match(eligibleSource, /dr\.reminder_end_date >= \?/);
});
