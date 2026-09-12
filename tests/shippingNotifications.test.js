import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  mapTrackingStatusToOrderStatus,
  isForwardOrderStatusTransition,
  normalizeTrackingStatus,
} from "../src/controllers/shippingController.js";
import {
  buildOrderStatusNotificationKey,
  sendOrderStatusNotificationOnce,
} from "../src/services/orderStatusNotificationService.js";
import { sendOrderStatusUpdateEmail } from "../src/services/orderEmailService.js";
import { validateWhatsAppConfiguration } from "../src/services/whatsappNotificationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const shippingControllerSource = read(
  "../src/controllers/shippingController.js",
);
const shippingCronSource = read("../cron/shippingTrackingCron.js");
const databaseSource = read("../src/config/database.js");
const notificationServiceSource = read(
  "../src/services/orderStatusNotificationService.js",
);

test("Delhivery shipment statuses map to the tracking-timeline order statuses", () => {
  assert.equal(mapTrackingStatusToOrderStatus("Manifested"), "shipped");
  assert.equal(mapTrackingStatusToOrderStatus("In Transit"), "shipped");
  assert.equal(
    mapTrackingStatusToOrderStatus("Out for delivery"),
    "out_for_delivery",
  );
  assert.equal(mapTrackingStatusToOrderStatus("Delivered"), "delivered");
  // Case/whitespace-insensitive
  assert.equal(
    mapTrackingStatusToOrderStatus("  OUT FOR DELIVERY  "),
    "out_for_delivery",
  );
});

test("normalizeTrackingStatus is case/whitespace-insensitive", () => {
  assert.equal(normalizeTrackingStatus("  Delivered "), "delivered");
  assert.equal(normalizeTrackingStatus(null), "");
});

test("the full Ready to Ship -> Shipped -> Out for Delivery -> Delivered chain is forward-allowed, one step at a time", () => {
  assert.equal(
    isForwardOrderStatusTransition("ready_to_ship", "shipped"),
    true,
  );
  assert.equal(
    isForwardOrderStatusTransition("shipped", "out_for_delivery"),
    true,
  );
  assert.equal(
    isForwardOrderStatusTransition("out_for_delivery", "delivered"),
    true,
  );
});

test("a stale/repeated status can never regress or re-trigger a transition", () => {
  // Same status again — not forward progress, so no new transition/notification.
  assert.equal(isForwardOrderStatusTransition("delivered", "delivered"), false);
  assert.equal(
    isForwardOrderStatusTransition("out_for_delivery", "shipped"),
    false,
  );
  // Once terminal, never transitions again automatically.
  assert.equal(isForwardOrderStatusTransition("delivered", "shipped"), false);
  assert.equal(
    isForwardOrderStatusTransition("cancelled", "out_for_delivery"),
    false,
  );
});

test("notification keys are unique per order+status+channel and stable across calls", () => {
  const a = buildOrderStatusNotificationKey({
    orderId: "order-1",
    status: "shipped",
    channel: "email",
  });
  const b = buildOrderStatusNotificationKey({
    orderId: "order-1",
    status: "shipped",
    channel: "email",
  });
  const differentChannel = buildOrderStatusNotificationKey({
    orderId: "order-1",
    status: "shipped",
    channel: "whatsapp",
  });
  const differentStatus = buildOrderStatusNotificationKey({
    orderId: "order-1",
    status: "out_for_delivery",
    channel: "email",
  });
  const differentOrder = buildOrderStatusNotificationKey({
    orderId: "order-2",
    status: "shipped",
    channel: "email",
  });

  assert.equal(a, b);
  assert.notEqual(a, differentChannel);
  assert.notEqual(a, differentStatus);
  assert.notEqual(a, differentOrder);
});

test("createShipment sends the Shipped WhatsApp notification (previously missing)", () => {
  // FIX: createShipment sets order_status = "shipped" directly, so it is the
  // only place that transition can ever be observed — neither the cron nor
  // trackShipment() can detect it afterwards (order_status already matches).
  // Before the fix, only sendShipmentCreatedEmail was called and no WhatsApp
  // was ever sent for "shipped".
  const createShipmentSource = shippingControllerSource.slice(
    shippingControllerSource.indexOf("export const createShipment"),
    shippingControllerSource.indexOf("export const reconcileShipment"),
  );
  assert.match(createShipmentSource, /sendOrderStatusUpdateWhatsApp\(/);
  assert.match(createShipmentSource, /status:\s*"shipped"/);
  assert.match(createShipmentSource, /sendShipmentCreatedEmail\(/);
});

test("shipment notifications are deduped through order_status_notifications, in both the cron and the manual track endpoint", () => {
  assert.match(shippingCronSource, /sendOrderStatusNotificationOnce\(/);
  assert.match(shippingCronSource, /buildOrderStatusNotificationKey\(/);
  assert.match(
    shippingControllerSource,
    /sendOrderStatusNotificationOnce\(/,
  );
  assert.match(
    shippingControllerSource,
    /buildOrderStatusNotificationKey\(/,
  );
});

test("the order_status_notifications dedupe table is provisioned at startup", () => {
  assert.match(
    databaseSource,
    /CREATE TABLE IF NOT EXISTS order_status_notifications/,
  );
  assert.match(databaseSource, /await ensureOrderStatusNotificationSchema\(\)/);
});

test("notification logging never includes raw recipient contact info, only orderId/status/channel", () => {
  // Logging is centralized inside sendOrderStatusNotificationOnce() —
  // callers pass orderId/status/channel, never recipientEmail/recipientPhone,
  // into a console.* call directly.
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.doesNotMatch(source, /console\.(info|log|warn|error)\([^)]*recipientEmail/);
    assert.doesNotMatch(source, /console\.(info|log|warn|error)\([^)]*recipientPhone/);
  }
});

test("[ORDER_STATUS_NOTIFICATION] log line uses the exact requested field shape", () => {
  assert.match(notificationServiceSource, /\[ORDER_STATUS_NOTIFICATION\]/);
  // action must cover the full attempted -> sent | duplicate_skipped | failed lifecycle.
  for (const action of ["attempted", "sent", "duplicate_skipped", "failed"]) {
    assert.match(notificationServiceSource, new RegExp(`"${action}"`));
  }
  assert.match(notificationServiceSource, /orderId/);
  assert.match(notificationServiceSource, /channel/);
  assert.match(notificationServiceSource, /result/);
  // Never logs the notificationKey's underlying send() args or raw error objects.
  assert.doesNotMatch(notificationServiceSource, /console\.\w+\([^)]*notificationKey/);
});

test("a claim stuck in 'sending' (e.g. a crash mid-send) is reclaimable, not a permanent false duplicate", () => {
  // FIX: without this, a process crash between claiming (status='sending')
  // and resolving to sent/failed would mark every future legitimate attempt
  // as "duplicate_skipped" forever, even though nothing was ever sent —
  // the idempotency table incorrectly "eating" a real notification.
  assert.match(
    notificationServiceSource,
    /status = 'sending'\s+AND\s+last_attempt_at < NOW\(\) - INTERVAL \? MINUTE/,
  );
  assert.match(notificationServiceSource, /STALE_CLAIM_MINUTES/);
});

test("Out for Delivery transitions send both sendOutForDeliveryEmail and sendOrderStatusUpdateWhatsApp with status out_for_delivery", () => {
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.match(source, /out for delivery["']?\s*\)\s*\{[\s\S]*?sendOutForDeliveryEmail\(/);
    assert.match(source, /status:\s*mappedOrderStatus,\s*\n\s*channel:\s*"whatsapp"/);
  }
});

test("Delivered transitions send both sendShipmentDeliveredEmail and sendOrderStatusUpdateWhatsApp", () => {
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.match(source, /delivered["']?\s*\)\s*\{[\s\S]*?sendShipmentDeliveredEmail\(/);
  }
});

test("createShipment sends the Shipped Email notification via the existing sendShipmentCreatedEmail template", () => {
  const createShipmentSource = shippingControllerSource.slice(
    shippingControllerSource.indexOf("export const createShipment"),
    shippingControllerSource.indexOf("export const reconcileShipment"),
  );
  // Both channels go through sendOrderStatusNotificationOnce with the same
  // status: "shipped" key, not a bespoke path — reuses the existing template
  // (sendShipmentCreatedEmail), doesn't invent a new one.
  assert.match(
    createShipmentSource,
    /channel:\s*"email"[\s\S]*?send:\s*\(\)\s*=>\s*\n\s*sendShipmentCreatedEmail\(/,
  );
});

/**
 * In-memory stand-in for the `order_status_notifications` table, driven
 * through the exact SQL statement shapes sendOrderStatusNotificationOnce()
 * issues. Lets the real claim/send/resolve state machine be exercised
 * without touching the production database (this repo has no separate
 * test DB — DATABASE_URL points at production, confirmed while tracing
 * this bug). Mirrors dailyReminderService.js's queryExecutor injection
 * pattern already used elsewhere in this codebase.
 */
const createFakeNotificationsTable = () => {
  const rows = new Map();

  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT IGNORE INTO order_status_notifications")) {
      const [key] = params;
      if (!rows.has(key)) {
        rows.set(key, {
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          sent_at: null,
          last_error: null,
        });
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes("SET status = 'sending'")) {
      const [key, retryFlag, staleMinutes] = params;
      const row = rows.get(key);
      if (!row) return { rows: [], rowCount: 0 };
      const isStaleSending =
        row.status === "sending" &&
        row.last_attempt_at &&
        Date.now() - row.last_attempt_at.getTime() > staleMinutes * 60 * 1000;
      const claimable =
        row.status === "pending" ||
        (row.status === "failed" && retryFlag === 1) ||
        isStaleSending;
      if (!claimable) return { rows: [], rowCount: 0 };
      row.status = "sending";
      row.attempts += 1;
      row.last_attempt_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'sent'")) {
      const [key] = params;
      const row = rows.get(key);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "sent";
      row.sent_at = new Date();
      row.last_error = null;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'failed'")) {
      const [errorMessage, key] = params;
      const row = rows.get(key);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "failed";
      row.last_error = errorMessage;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake order_status_notifications query: ${normalized}`);
  };

  return { queryExecutor, rows };
};

test("sendOrderStatusNotificationOnce: sends exactly once per key, second call is duplicate_skipped", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-1",
    status: "shipped",
    channel: "whatsapp",
  });
  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };

  const first = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send,
    queryExecutor,
  });
  const second = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send,
    queryExecutor,
  });

  assert.deepEqual(first, { sent: true, duplicate: false });
  assert.deepEqual(second, { sent: false, duplicate: true });
  assert.equal(sendCalls, 1, "send() must only ever be called once for this key");
});

test("sendOrderStatusNotificationOnce: concurrent callers on the same key never both send (order 123 + shipped + whatsapp = one notification)", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "123",
    status: "shipped",
    channel: "whatsapp",
  });
  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };

  const [a, b] = await Promise.all([
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
  ]);

  const results = [a, b];
  const sentCount = results.filter((r) => r.sent).length;
  const duplicateCount = results.filter((r) => r.duplicate).length;

  assert.equal(sentCount, 1, "exactly one of the two concurrent callers must win the claim");
  assert.equal(duplicateCount, 1);
  assert.equal(sendCalls, 1);
});

test("sendOrderStatusNotificationOnce: a failed send is recorded as failed, not silently marked sent, and blocks a non-retry re-attempt", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-2",
    status: "out_for_delivery",
    channel: "email",
  });
  const failingSend = async () => {
    throw new Error("Waplify 500: provider unavailable");
  };

  await assert.rejects(
    () => sendOrderStatusNotificationOnce({ notificationKey: key, send: failingSend, queryExecutor }),
    /provider unavailable/,
  );
  assert.equal(rows.get(key).status, "failed");
  assert.equal(rows.get(key).last_error, "Waplify 500: provider unavailable");

  // Without retryFailed, a second attempt must NOT re-send — it's a
  // duplicate_skipped, not a silent second failure or a crash.
  let sendCalls = 0;
  const result = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      sendCalls += 1;
    },
    queryExecutor,
  });
  assert.deepEqual(result, { sent: false, duplicate: true });
  assert.equal(sendCalls, 0);
});

test("sendOrderStatusNotificationOnce: a failed notification CAN be retried safely with retryFailed, exactly once", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-3",
    status: "delivered",
    channel: "email",
  });

  await assert.rejects(() =>
    sendOrderStatusNotificationOnce({
      notificationKey: key,
      send: async () => {
        throw new Error("SMTP timeout");
      },
      queryExecutor,
    }),
  );
  assert.equal(rows.get(key).status, "failed");

  let sendCalls = 0;
  const retryResult = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      sendCalls += 1;
    },
    retryFailed: true,
    queryExecutor,
  });

  assert.deepEqual(retryResult, { sent: true, duplicate: false });
  assert.equal(sendCalls, 1);
  assert.equal(rows.get(key).status, "sent");

  // And it stays sent — a THIRD attempt, even with retryFailed again, is a
  // duplicate (retry only ever reclaims 'failed', never 'sent').
  const thirdResult = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      sendCalls += 1;
    },
    retryFailed: true,
    queryExecutor,
  });
  assert.deepEqual(thirdResult, { sent: false, duplicate: true });
  assert.equal(sendCalls, 1);
});

test("sendOrderStatusNotificationOnce: a claim abandoned mid-send (process crash) is reclaimed after the staleness window instead of being lost forever", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-4",
    status: "shipped",
    channel: "email",
  });

  // Simulate a claim that was made 10 minutes ago and never resolved
  // (process died between claiming and marking sent/failed).
  rows.set(key, {
    status: "sending",
    attempts: 1,
    last_attempt_at: new Date(Date.now() - 10 * 60 * 1000),
    sent_at: null,
    last_error: null,
  });

  let sendCalls = 0;
  const result = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      sendCalls += 1;
    },
    queryExecutor,
  });

  assert.deepEqual(result, { sent: true, duplicate: false });
  assert.equal(sendCalls, 1);
  assert.equal(rows.get(key).status, "sent");
});

test("sendOrderStatusNotificationOnce: a claim still fresh (well within the staleness window) is NOT reclaimed by a second caller", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-5",
    status: "out_for_delivery",
    channel: "whatsapp",
  });

  rows.set(key, {
    status: "sending",
    attempts: 1,
    last_attempt_at: new Date(), // just claimed, presumably still in-flight
    sent_at: null,
    last_error: null,
  });

  let sendCalls = 0;
  const result = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      sendCalls += 1;
    },
    queryExecutor,
  });

  assert.deepEqual(result, { sent: false, duplicate: true });
  assert.equal(sendCalls, 0);
});

test("email provider misconfiguration (missing SMTP creds) throws instead of silently 'succeeding' — a real send failure can never be marked sent", async () => {
  // FIX: sendEmail() used to `return` silently when SMTP_USER/SMTP_PASS
  // were unset, so sendOrderStatusNotificationOnce's send() callback
  // resolved normally and the row was marked 'sent' even though no email
  // ever left the server. Missing recipient (`to`) is still a soft no-op
  // (a data condition, not a provider failure) — only missing credentials
  // must throw.
  const previousUser = process.env.SMTP_USER;
  const previousPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  try {
    await assert.rejects(
      () =>
        sendOrderStatusUpdateEmail({
          to: "customer@example.com",
          name: "Customer",
          orderId: "order-1",
          orderNumber: "BREE-100001",
          status: "shipped",
        }),
      /SMTP_USER\/SMTP_PASS not configured/,
    );
  } finally {
    if (previousUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousUser;
    if (previousPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = previousPass;
  }
});

test("sendOrderStatusNotificationOnce marks 'failed', not 'sent', when the underlying email send throws", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-6",
    status: "shipped",
    channel: "email",
  });
  const previousUser = process.env.SMTP_USER;
  const previousPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  try {
    await assert.rejects(() =>
      sendOrderStatusNotificationOnce({
        notificationKey: key,
        orderId: "order-6",
        status: "shipped",
        channel: "email",
        queryExecutor,
        send: () =>
          sendOrderStatusUpdateEmail({
            to: "customer@example.com",
            name: "Customer",
            orderId: "order-6",
            orderNumber: "BREE-100006",
            status: "shipped",
          }),
      }),
    );
  } finally {
    if (previousUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousUser;
    if (previousPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = previousPass;
  }

  assert.equal(rows.get(key).status, "failed");
  assert.match(rows.get(key).last_error, /SMTP_USER\/SMTP_PASS not configured/);
});

test("WhatsApp config validation (base URL, API key, every WAPLIFY_TEMPLATE_* including ORDER_STATUS) is wired into server startup, non-fatally", () => {
  const serverSource = read("../src/server.js");
  assert.match(serverSource, /validateWhatsAppConfiguration\(/);
  const callSite = serverSource.slice(
    serverSource.indexOf("try {\n  validateWhatsAppConfiguration"),
  );
  assert.match(callSite.slice(0, 400), /catch \(waplifyConfigError\)/);
  assert.doesNotThrow(() => {
    try {
      validateWhatsAppConfiguration();
    } catch (error) {
      assert.match(error.message, /WAPLIFY|Missing/);
    }
  });
});
