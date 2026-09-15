import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  mapTrackingStatusToOrderStatus,
  isForwardOrderStatusTransition,
  normalizeTrackingStatus,
  shouldSendBreeStatusWhatsApp,
} from "../src/controllers/shippingController.js";
import {
  buildOrderStatusNotificationKey,
  sendOrderStatusNotificationOnce,
} from "../src/services/orderStatusNotificationService.js";
import { sendOrderStatusUpdateEmail } from "../src/services/orderEmailService.js";
import {
  validateWhatsAppConfiguration,
  buildOrderDeliveredThankYouMessage,
} from "../src/services/whatsappNotificationService.js";

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
const whatsappServiceSource = read(
  "../src/services/whatsappNotificationService.js",
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

test("REGRESSION FIX: createShipment does NOT send a BREE WhatsApp for 'shipped' — Delhivery already notifies the customer — but the Shipped email is unchanged", () => {
  // Previously this called sendOrderStatusUpdateWhatsApp(status:"shipped")
  // directly here (createShipment is the ONLY place order_status ever
  // becomes "shipped", set directly rather than detected via a transition
  // diff, so neither the cron nor trackShipment() could ever have sent it
  // instead). Delhivery already sends its own shipping WhatsApp the
  // moment the shipment is created with them, so this was a genuine
  // duplicate customer-facing message, not a second useful one.
  const createShipmentSource = shippingControllerSource.slice(
    shippingControllerSource.indexOf("export const createShipment"),
    shippingControllerSource.indexOf("export const reconcileShipment"),
  );
  assert.doesNotMatch(createShipmentSource, /sendOrderStatusUpdateWhatsApp\(/);
  // The Shipped email must be completely unaffected by this change.
  assert.match(createShipmentSource, /sendShipmentCreatedEmail\(/);
  assert.match(createShipmentSource, /channel:\s*"email"/);
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

test("Out for Delivery transitions still send sendOutForDeliveryEmail (email unchanged)", () => {
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.match(source, /out for delivery["']?\s*\)\s*\{[\s\S]*?sendOutForDeliveryEmail\(/);
  }
});

test("REGRESSION FIX: Out for Delivery does NOT send a BREE WhatsApp — Delhivery already notifies the customer", () => {
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.match(source, /shouldSendBreeStatusWhatsApp\(mappedOrderStatus\)/);
  }
  // shouldSendBreeStatusWhatsApp itself is the single source of truth —
  // verified directly against shippingController.js's own definition.
  assert.match(
    shippingControllerSource,
    /DELHIVERY_ALREADY_NOTIFIES_STATUSES = new Set\(\[\s*"shipped",\s*"out_for_delivery",\s*\]\)/,
  );
  assert.equal(shouldSendBreeStatusWhatsApp("out_for_delivery"), false);
  assert.equal(shouldSendBreeStatusWhatsApp("shipped"), false);
});

test("Delivered transitions still send sendShipmentDeliveredEmail (email unchanged) and now send the BREE thank-you WhatsApp instead of the generic status message", () => {
  for (const source of [shippingCronSource, shippingControllerSource]) {
    assert.match(source, /delivered["']?\s*\)\s*\{[\s\S]*?sendShipmentDeliveredEmail\(/);
    assert.match(source, /sendOrderStatusUpdateWhatsApp\(/);
  }
  assert.equal(shouldSendBreeStatusWhatsApp("delivered"), true);
});

test("REGRESSION FIX: 'delivered' status routes to the dedicated thank-you message, not the generic order-status line, inside sendOrderStatusUpdateWhatsApp itself", () => {
  const fnSource = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const sendOrderStatusUpdateWhatsApp"),
  );
  assert.match(fnSource, /status === "delivered"/);
  assert.match(fnSource, /buildOrderDeliveredThankYouMessage\(customerName\)/);
});

test("the delivered thank-you message matches the exact requested content", () => {
  const message = buildOrderDeliveredThankYouMessage("Asha");
  assert.match(message, /^BREE Wellness 💚/);
  assert.match(message, /Hi Asha 👋/);
  assert.match(message, /Your order has been successfully delivered\./);
  assert.match(
    message,
    /Thank you for choosing BREE Wellness! We hope you enjoy your order\. 🌿/,
  );
  assert.match(message, /We appreciate your trust in BREE\. 💚$/);
});

test("the delivered thank-you message falls back gracefully when customerName is missing (never crashes, never says 'Hi undefined')", () => {
  const message = buildOrderDeliveredThankYouMessage(undefined);
  assert.doesNotMatch(message, /undefined/);
  assert.match(message, /Hi there 👋/);
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

// ── Delivered thank-you WhatsApp: idempotency across every real trigger
//    path (cron tick, manual trackShipment refresh, and a retried call to
//    either) — all share this exact notification key ────────────────────

test("REGRESSION: Delivered thank-you WhatsApp — cron and manual tracking refresh racing on the same order send exactly once, not twice", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-delivered-1",
    status: "delivered",
    channel: "whatsapp",
  });
  let sendCalls = 0;
  // Simulates what the real send() callback does: build the thank-you
  // message and hand it to the (mocked) WhatsApp provider.
  const send = async () => {
    sendCalls += 1;
    return buildOrderDeliveredThankYouMessage("Customer");
  };

  // cron/shippingTrackingCron.js and shippingController.js's
  // trackShipment() both observe the same "delivered" transition at
  // roughly the same time — e.g. an admin manually refreshes tracking
  // moments before the cron's own poll would have caught it.
  const [cronResult, manualResult] = await Promise.all([
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
  ]);

  const sentCount = [cronResult, manualResult].filter((r) => r.sent).length;
  assert.equal(sentCount, 1, "only one of cron/manual may actually send the thank-you message");
  assert.equal(sendCalls, 1);
});

test("REGRESSION: Delivered thank-you WhatsApp — a retried call for an order already marked delivered sends 0 additional messages", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-delivered-2",
    status: "delivered",
    channel: "whatsapp",
  });
  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };

  const first = await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
  assert.equal(first.sent, true);

  // Repeated "delivered" status observations (another cron tick, a
  // retried webhook-style redelivery, an admin re-refreshing tracking on
  // an already-delivered order) must never re-send.
  for (let i = 0; i < 3; i++) {
    const retry = await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
    assert.equal(retry.sent, false);
    assert.equal(retry.duplicate, true);
  }
  assert.equal(sendCalls, 1, "exactly one thank-you message total, no matter how many repeated observations follow");
});

test("REGRESSION: simulated end-to-end trigger-path decision — shipped/out_for_delivery send 0 WhatsApp, delivered sends exactly 1 thank-you message", async () => {
  // Simulates the exact `if (!shouldSendBreeStatusWhatsApp(status)) skip
  // else send` decision every real trigger path (createShipment,
  // trackShipment, the cron) now makes, end to end through the real
  // idempotency mechanism — not just a regex match against the source.
  const runTriggerPath = async (status, queryExecutor) => {
    let sendAttempted = false;
    if (!shouldSendBreeStatusWhatsApp(status)) {
      return { sendAttempted, action: "skipped_delhivery_duplicate" };
    }
    const key = buildOrderStatusNotificationKey({
      orderId: "order-e2e",
      status,
      channel: "whatsapp",
    });
    const result = await sendOrderStatusNotificationOnce({
      notificationKey: key,
      send: async () => {
        sendAttempted = true;
      },
      queryExecutor,
    });
    return { sendAttempted, ...result };
  };

  for (const status of ["shipped", "out_for_delivery"]) {
    const { queryExecutor } = createFakeNotificationsTable();
    const outcome = await runTriggerPath(status, queryExecutor);
    assert.equal(
      outcome.sendAttempted,
      false,
      `${status} must never attempt a WhatsApp provider call`,
    );
    assert.equal(outcome.action, "skipped_delhivery_duplicate");
  }

  const { queryExecutor } = createFakeNotificationsTable();
  const delivered = await runTriggerPath("delivered", queryExecutor);
  assert.equal(delivered.sendAttempted, true);
  assert.equal(delivered.sent, true);
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

// ── Trigger-path audit: admin/orderController.js's generic order-status
//    endpoints (single + bulk) are a SEPARATE path from the Delhivery-
//    driven createShipment/trackShipment/cron flow, and can just as
//    easily set status to "shipped"/"out_for_delivery"/"delivered" (e.g.
//    correcting a status, or a manual/COD order with no real Delhivery
//    shipment). Found via a full-repo grep for every
//    sendOrderStatusUpdateWhatsApp call site — this task's requirement 7
//    ("check ALL trigger paths... any other order-status notification
//    caller") is not satisfied by only fixing the shipping-specific
//    files. These previously had NO suppression AND no idempotency of
//    any kind (a bare fire-and-forget .catch(), not
//    sendOrderStatusNotificationOnce) — both are fixed here. ───────────

const adminOrderControllerSource = read(
  "../src/controllers/admin/orderController.js",
);

test("REGRESSION FIX: admin updateOrderStatus (single order) suppresses BREE WhatsApp for shipped/out_for_delivery and is now idempotent", () => {
  const fnSource = adminOrderControllerSource.slice(
    adminOrderControllerSource.indexOf("export const updateOrderStatus"),
    adminOrderControllerSource.indexOf("export const bulkUpdateStatus"),
  );
  assert.match(fnSource, /shouldSendBreeStatusWhatsApp\(status\)/);
  assert.match(fnSource, /sendOrderStatusNotificationOnce\(/);
  assert.match(fnSource, /buildOrderStatusNotificationKey\(/);
  // Must share the exact same key shape as every other trigger path, so
  // an order reaching "delivered" here can't be double-notified if
  // Delhivery's own tracking sync already sent the thank-you (or the
  // reverse order).
  assert.match(
    fnSource,
    /buildOrderStatusNotificationKey\(\{\s*orderId:\s*updated\.id,\s*status,\s*channel:\s*"whatsapp",/,
  );
  // Email behavior must be completely untouched by this fix.
  assert.match(fnSource, /sendOrderDeliveredEmail\(/);
  assert.match(fnSource, /sendOrderCancelledEmail\(/);
  assert.match(fnSource, /sendOrderStatusUpdateEmail\(/);
});

test("REGRESSION FIX: admin bulkUpdateStatus suppresses BREE WhatsApp for shipped/out_for_delivery (per order) and is now idempotent", () => {
  const fnSource = adminOrderControllerSource.slice(
    adminOrderControllerSource.indexOf("export const bulkUpdateStatus"),
  );
  assert.match(fnSource, /shouldSendBreeStatusWhatsApp\(status\)/);
  assert.match(fnSource, /sendOrderStatusNotificationOnce\(/);
  assert.match(fnSource, /buildOrderStatusNotificationKey\(/);
});

test("no remaining bare/unguarded sendOrderStatusUpdateWhatsApp call exists anywhere in admin/orderController.js", () => {
  // Every call site must go through sendOrderStatusNotificationOnce now —
  // a bare `sendOrderStatusUpdateWhatsApp({` not preceded by `send: () =>`
  // would mean an unguarded, non-idempotent, unsuppressed call slipped
  // back in.
  const bareCalls = adminOrderControllerSource.match(
    /(?<!send:\s*\(\)\s*=>\s*\n?\s*)sendOrderStatusUpdateWhatsApp\(\{/g,
  );
  // The only acceptable "bare-looking" match is the one immediately
  // preceded by `send: () =>` on the line above, which the negative
  // lookbehind already excludes — so nothing should remain.
  assert.equal(bareCalls, null);
});

test("a full-repo audit of every sendOrderStatusUpdateWhatsApp call site accounts for each one: 4 guarded (createShipment removed, trackShipment/cron/admin-single/admin-bulk guarded), 2 correctly unaffected (paid, return/refund labels)", () => {
  const paymentControllerSource = read("../src/controllers/paymentController.js");
  const returnControllerSource = read("../src/controllers/admin/returnController.js");
  const createShipmentSource = shippingControllerSource.slice(
    shippingControllerSource.indexOf("export const createShipment"),
    shippingControllerSource.indexOf("export const reconcileShipment"),
  );

  // Removed entirely from createShipment.
  assert.doesNotMatch(createShipmentSource, /sendOrderStatusUpdateWhatsApp\(/);
  // Guarded in trackShipment/cron/admin (single + bulk).
  for (const source of [shippingControllerSource, shippingCronSource, adminOrderControllerSource]) {
    assert.match(source, /shouldSendBreeStatusWhatsApp/);
  }
  // Unaffected: paymentController's "paid" status notification.
  assert.match(paymentControllerSource, /status:\s*"paid",/);
  assert.match(paymentControllerSource, /sendOrderStatusUpdateWhatsApp\(/);
  // Unaffected: returnController's return/refund event labels (never
  // literally "shipped"/"out_for_delivery"/"delivered").
  assert.match(returnControllerSource, /sendOrderStatusUpdateWhatsApp\(/);
  assert.doesNotMatch(returnControllerSource, /status:\s*"shipped"/);
  assert.doesNotMatch(returnControllerSource, /status:\s*"out_for_delivery"/);
});

// ── Consolidated checks the task explicitly asked for ──────────────────

test("email behavior is completely unchanged: every email sender/template call site is untouched by this change", () => {
  // The exact same email functions, called the exact same way, for the
  // exact same statuses as before — only the WhatsApp side changed.
  assert.match(shippingControllerSource, /sendShipmentCreatedEmail\(/);
  assert.match(shippingControllerSource, /sendOutForDeliveryEmail\(/);
  assert.match(shippingControllerSource, /sendShipmentDeliveredEmail\(/);
  assert.match(shippingCronSource, /sendOutForDeliveryEmail\(/);
  assert.match(shippingCronSource, /sendShipmentDeliveredEmail\(/);
});

test("UI-facing order statuses, order_status_history recording, and the Delhivery tracking-status mapping are all untouched", () => {
  // The 7 UI statuses and their mapping from raw Delhivery statuses are
  // unchanged — this task only touches which channel/message a status
  // transition notifies through, never the statuses or history
  // themselves.
  assert.deepEqual(mapTrackingStatusToOrderStatus("delivered"), "delivered");
  assert.deepEqual(mapTrackingStatusToOrderStatus("out for delivery"), "out_for_delivery");
  assert.deepEqual(mapTrackingStatusToOrderStatus("dispatched"), "shipped");
  assert.match(shippingControllerSource, /appendStatusHistory\(/);
  assert.match(shippingCronSource, /appendStatusHistory\(/);
  // Delhivery integration itself (shipment creation, tracking fetch) is
  // untouched — this task never modifies delhiveryService.js.
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(__dirname, "../src/services/delhiveryService.js"),
      "utf8",
    ),
    /shouldSendBreeStatusWhatsApp|buildOrderDeliveredThankYouMessage/,
  );
});
