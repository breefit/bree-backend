import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  sendSubscriptionEmailOnce,
  sendSubscriptionNotificationOnce,
} from "../src/services/subscriptionEmailNotificationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const subscriptionControllerSource = read(
  "../src/controllers/subscriptionController.js",
);
const subscriptionAdminControllerSource = read(
  "../src/controllers/admin/subscriptionAdminController.js",
);
const whatsappServiceSource = read(
  "../src/services/whatsappNotificationService.js",
);
const paymentControllerSource = read(
  "../src/controllers/paymentController.js",
);
const orderEmailServiceSource = read("../src/services/orderEmailService.js");

// ── sendSubscriptionEmailOnce: claim/send/resolve state machine ────────────

/**
 * In-memory stand-in for `subscription_email_notifications`, driven
 * through the exact SQL sendSubscriptionEmailOnce issues.
 */
const createFakeNotificationsTable = () => {
  const rows = new Map(); // notificationKey -> row

  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT IGNORE INTO subscription_email_notifications")) {
      const [notificationKey] = params;
      if (!rows.has(notificationKey)) {
        rows.set(notificationKey, {
          notification_key: notificationKey,
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
      const [notificationKey, retryFailed, staleMinutes] = params;
      const row = rows.get(notificationKey);
      if (!row) return { rows: [], rowCount: 0 };
      const isStaleSending =
        row.status === "sending" &&
        row.last_attempt_at &&
        Date.now() - row.last_attempt_at.getTime() > staleMinutes * 60 * 1000;
      const claimable =
        row.status === "pending" ||
        (row.status === "failed" && retryFailed === 1) ||
        isStaleSending;
      if (!claimable) return { rows: [], rowCount: 0 };
      row.status = "sending";
      row.attempts += 1;
      row.last_attempt_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'sent'")) {
      const [notificationKey] = params;
      const row = rows.get(notificationKey);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "sent";
      row.sent_at = new Date();
      row.last_error = null;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'failed'")) {
      const [errorMessage, notificationKey] = params;
      const row = rows.get(notificationKey);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "failed";
      row.last_error = errorMessage;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake subscription_email_notifications query: ${normalized}`);
  };

  return { queryExecutor, rows };
};

test("sendSubscriptionEmailOnce: sends exactly once per key, second call is a duplicate no-op", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  let sendCount = 0;

  const first = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_1:created",
    send: async () => {
      sendCount++;
    },
    queryExecutor,
  });
  const second = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_1:created",
    send: async () => {
      sendCount++;
    },
    queryExecutor,
  });

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.duplicate, true);
  assert.equal(sendCount, 1, "the underlying email send must only fire once");
});

test("sendSubscriptionEmailOnce: a failed send is recorded as failed, not silently 'sent', and blocks a non-retry re-attempt", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();

  await assert.rejects(() =>
    sendSubscriptionEmailOnce({
      notificationKey: "subscription:sub_2:cancelled",
      send: async () => {
        throw new Error("SMTP timeout");
      },
      queryExecutor,
    }),
  );
  assert.equal(rows.get("subscription:sub_2:cancelled").status, "failed");

  const retry = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_2:cancelled",
    send: async () => {},
    queryExecutor,
  });
  assert.equal(retry.sent, false);
  assert.equal(retry.duplicate, true, "a failed send must not be retried without retryFailed:true");
});

test("sendSubscriptionEmailOnce: a failed send CAN be retried explicitly via retryFailed", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();

  await assert.rejects(() =>
    sendSubscriptionEmailOnce({
      notificationKey: "subscription:sub_3:paused",
      send: async () => {
        throw new Error("SMTP timeout");
      },
      queryExecutor,
    }),
  );

  const retried = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_3:paused",
    send: async () => {},
    retryFailed: true,
    queryExecutor,
  });
  assert.equal(retried.sent, true);
  assert.equal(rows.get("subscription:sub_3:paused").status, "sent");
});

test("REGRESSION FIX: a claim stuck in 'sending' (crash between claim and resolve) is reclaimable after the staleness window, not a permanent false duplicate", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  rows.set("subscription:sub_4:resumed", {
    notification_key: "subscription:sub_4:resumed",
    status: "sending",
    attempts: 1,
    last_attempt_at: new Date(Date.now() - 10 * 60 * 1000), // claimed 10 min ago, process died
    sent_at: null,
    last_error: null,
  });

  const result = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_4:resumed",
    send: async () => {},
    queryExecutor,
  });

  assert.equal(
    result.sent,
    true,
    "an abandoned 'sending' claim must eventually be reclaimed, or this notification is lost forever",
  );
  assert.equal(rows.get("subscription:sub_4:resumed").status, "sent");
});

test("a claim still fresh (well within the staleness window) is NOT reclaimed by a concurrent caller", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  rows.set("subscription:sub_5:created", {
    notification_key: "subscription:sub_5:created",
    status: "sending",
    attempts: 1,
    last_attempt_at: new Date(), // just claimed by another in-flight request
    sent_at: null,
    last_error: null,
  });

  const result = await sendSubscriptionEmailOnce({
    notificationKey: "subscription:sub_5:created",
    send: async () => {},
    queryExecutor,
  });

  assert.equal(result.sent, false);
  assert.equal(result.duplicate, true);
});

test("concurrent callers on the same key never both send (only one wins the claim)", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  let sendCount = 0;

  const [a, b] = await Promise.all([
    sendSubscriptionEmailOnce({
      notificationKey: "subscription:sub_6:cancelled",
      send: async () => {
        sendCount++;
      },
      queryExecutor,
    }),
    sendSubscriptionEmailOnce({
      notificationKey: "subscription:sub_6:cancelled",
      send: async () => {
        sendCount++;
      },
      queryExecutor,
    }),
  ]);

  const sentCount = [a, b].filter((r) => r.sent).length;
  assert.equal(sentCount, 1);
  assert.equal(sendCount, 1);
});

// ── REGRESSION FIX: resumeSubscription's WhatsApp status must be the
//    literal event name "resumed", not Razorpay's raw billing status ──────

test("REGRESSION FIX: resumeSubscription passes the literal event \"resumed\" to the idempotent WhatsApp helper, not Razorpay's raw response.status", () => {
  // Previously this passed `response.status || SUBSCRIPTION_STATUS.ACTIVE`
  // — Razorpay's resume response.status is typically the literal string
  // "active", which is not a key in whatsappNotificationService.js's
  // message maps, so the customer silently got the generic fallback text
  // ("Your subscription status has been updated.") instead of the
  // dedicated resume copy. Every other event (created/paused/cancelled)
  // already passes its own literal event name. Now wrapped in
  // sendSubscriptionStatusWhatsAppOnce for idempotency (see the dedicated
  // idempotency regression test above) — this test only checks the event
  // label is correct.
  const resumeSource = subscriptionControllerSource.slice(
    subscriptionControllerSource.indexOf("export const resumeSubscription"),
  );
  const whatsAppCallStart = resumeSource.indexOf("sendSubscriptionStatusWhatsAppOnce");
  const whatsAppCallBlock = resumeSource.slice(
    whatsAppCallStart,
    resumeSource.indexOf("});", whatsAppCallStart),
  );

  assert.match(whatsAppCallBlock, /event:\s*"resumed"/);
  assert.doesNotMatch(whatsAppCallBlock, /response\.status/);

  // The DB write (a separate call, earlier in the same function) must
  // still reflect Razorpay's actual billing status — only the
  // notification's event label changes.
  const dbUpdateBlock = resumeSource.slice(
    resumeSource.indexOf("updateSubscriptionOrder"),
    whatsAppCallStart,
  );
  assert.match(
    dbUpdateBlock,
    /subscriptionStatus:\s*response\.status\s*\|\|\s*SUBSCRIPTION_STATUS\.ACTIVE/,
  );
});

test("the \"resumed\" status maps to its own dedicated WhatsApp copy, not the generic fallback", () => {
  const messagesBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const buildSubscriptionStatusMessage"),
    whatsappServiceSource.indexOf("export const getReadableSubscriptionStatus"),
  );
  assert.match(
    messagesBlock,
    /resumed:\s*"Your subscription has been resumed successfully\."/,
  );
});

// ── REGRESSION FIX: admin pause/resume/cancel must not bypass the same
//    customer-notification logic (email + WhatsApp) the customer-facing
//    actions already use for the identical state transition ────────────────

test("REGRESSION FIX: admin pauseSubscription sends WhatsApp in addition to email, not email only", () => {
  const fnSource = subscriptionAdminControllerSource.slice(
    subscriptionAdminControllerSource.indexOf("export const pauseSubscription"),
    subscriptionAdminControllerSource.indexOf("export const resumeSubscription"),
  );
  assert.match(fnSource, /sendSubscriptionEmailOnce\(/);
  assert.match(fnSource, /sendWhatsAppOnce\(/);
  assert.match(fnSource, /event:\s*"paused"/);
  // Needs contact_phone and a product name to actually send WhatsApp.
  assert.match(fnSource, /o\.contact_phone/);
  assert.match(fnSource, /p\.name AS product_name/);
});

test("REGRESSION FIX: admin resumeSubscription sends WhatsApp with the literal \"resumed\" event, not Razorpay's raw status", () => {
  const fnSource = subscriptionAdminControllerSource.slice(
    subscriptionAdminControllerSource.indexOf("export const resumeSubscription"),
    subscriptionAdminControllerSource.indexOf("export const cancelSubscription"),
  );
  assert.match(fnSource, /sendWhatsAppOnce\(/);

  // Scope to just the WhatsApp call's payload — the DB write earlier in
  // this same function legitimately uses response.status (Razorpay's
  // actual billing status) and must NOT be disturbed by this assertion.
  const whatsAppCallStart = fnSource.indexOf("sendWhatsAppOnce(");
  const whatsAppCallBlock = fnSource.slice(
    whatsAppCallStart,
    fnSource.indexOf("res.json(", whatsAppCallStart),
  );
  assert.match(whatsAppCallBlock, /event:\s*"resumed"/);
  assert.doesNotMatch(whatsAppCallBlock, /response\.status/);
});

test("REGRESSION FIX: admin cancelSubscription sends WhatsApp in addition to email", () => {
  const fnSource = subscriptionAdminControllerSource.slice(
    subscriptionAdminControllerSource.indexOf("export const cancelSubscription"),
    subscriptionAdminControllerSource.indexOf("export const getSubscriptionAnalytics"),
  );
  assert.match(fnSource, /sendSubscriptionEmailOnce\(/);
  assert.match(fnSource, /sendWhatsAppOnce\(/);
  assert.match(fnSource, /event:\s*"cancelled"/);
});

test("admin WhatsApp sends are fire-and-forget (never awaited, never able to fail the admin API response)", () => {
  const fnSource = subscriptionAdminControllerSource.slice(
    subscriptionAdminControllerSource.indexOf("export const pauseSubscription"),
    subscriptionAdminControllerSource.indexOf("export const getSubscriptionAnalytics"),
  );
  // sendWhatsAppOnce itself swallows/logs internally — none of the three
  // call sites should `await` it directly.
  assert.doesNotMatch(fnSource, /await sendWhatsAppOnce/);
  assert.match(fnSource, /sendWhatsAppOnce\(/);
});

// ── REGRESSION FIX: subscription WhatsApp sends now go through the same
//    idempotent claim/send/resolve mechanism as email, closing a gap where
//    WhatsApp had ZERO duplicate protection of any kind ───────────────────

test("sendSubscriptionNotificationOnce is channel-agnostic: two different notification keys for the 'same' conceptual event (email vs whatsapp) are independent claims", async () => {
  const rows = new Map();
  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT IGNORE")) {
      const [key] = params;
      if (!rows.has(key)) rows.set(key, { status: "pending" });
      return { rowCount: 0 };
    }
    if (normalized.includes("SET status = 'sending'")) {
      const [key] = params;
      const row = rows.get(key);
      if (!row || row.status !== "pending") return { rowCount: 0 };
      row.status = "sending";
      return { rowCount: 1 };
    }
    if (normalized.includes("SET status = 'sent'")) {
      const [key] = params;
      rows.get(key).status = "sent";
      return { rowCount: 1 };
    }
    throw new Error(`unhandled: ${normalized}`);
  };

  const emailResult = await sendSubscriptionNotificationOnce({
    notificationKey: "subscription:sub_9:activated",
    send: async () => {},
    queryExecutor,
  });
  const whatsappResult = await sendSubscriptionNotificationOnce({
    notificationKey: "subscription:sub_9:activated:whatsapp",
    send: async () => {},
    queryExecutor,
  });

  assert.equal(emailResult.sent, true);
  assert.equal(
    whatsappResult.sent,
    true,
    "the whatsapp-suffixed key must be a distinct claim from the email key, not blocked by it",
  );
});

test("REGRESSION FIX: customer pause/resume/cancel WhatsApp sends are now idempotent (previously had zero duplicate protection)", () => {
  const fnSource = subscriptionControllerSource;
  assert.match(fnSource, /sendSubscriptionStatusWhatsAppOnce\(/);
  assert.match(
    fnSource,
    /const notificationKey = `subscription:\$\{subscriptionId\}:\$\{event\}:whatsapp`/,
  );
  // The old unguarded direct-call helper must be gone entirely, not just
  // unused (dead code left behind would be misleading about what's safe).
  assert.doesNotMatch(fnSource, /const sendWhatsAppSafe = /);
});

// ── REGRESSION FIX (severe, pre-existing, unrelated to subscriptions but
//    directly blocking any notification placed after it in verifyPayment):
//    `paidStatusTransition` was declared with `const` inside the payment
//    transaction's try block and read again after that block closed — a
//    genuine out-of-scope reference that threw ReferenceError on every
//    successful, non-duplicate /api/payment/verify call. ───────────────────

test("REGRESSION FIX: paidStatusTransition is declared in verifyPayment's outer scope, not re-declared with const inside the transaction", () => {
  const verifyPaymentSource = paymentControllerSource.slice(
    paymentControllerSource.indexOf("export const verifyPayment"),
    paymentControllerSource.indexOf("export const getShippingInfo"),
  );

  assert.match(
    verifyPaymentSource,
    /let paidStatusTransition = false;/,
    "must be declared with `let` before the transaction's try block",
  );
  assert.doesNotMatch(
    verifyPaymentSource,
    /const paidStatusTransition/,
    "re-declaring it with const inside the try block shadows the outer one and reproduces the ReferenceError",
  );
  // The assignment inside the transaction must be a plain reassignment.
  assert.match(
    verifyPaymentSource,
    /\n\s*paidStatusTransition = shouldRecordPaymentHistory\(/,
  );
});

test("this exact declared-in-try/read-outside-try pattern actually throws ReferenceError (proves the bug was real, not a false positive)", async () => {
  const reproduceBug = async () => {
    try {
      const x = true;
      if (x) {
        /* no-op */
      }
    } finally {
      /* no-op */
    }
    // eslint-disable-next-line no-undef
    if (x) {
      /* unreachable */
    }
  };
  await assert.rejects(reproduceBug, ReferenceError);
});

// ── REGRESSION FIX: the premature pre-payment "activated" WhatsApp is gone,
//    and the real activation notification now fires from all three places
//    that can genuinely first-activate a subscription, sharing one key ───

test("REGRESSION FIX: createSubscription no longer sends a WhatsApp notification before payment has happened", () => {
  const createSubSource = subscriptionControllerSource.slice(
    subscriptionControllerSource.indexOf("export const createSubscription"),
    subscriptionControllerSource.indexOf("export const getMySubscriptions"),
  );
  // The order is committed (order_status = pending) well before the
  // customer ever opens Razorpay Checkout — no WhatsApp send may appear
  // anywhere after that commit within this function.
  const afterCommit = createSubSource.slice(createSubSource.indexOf('await client.query("COMMIT")'));
  assert.doesNotMatch(afterCommit, /sendSubscriptionStatusWhatsApp/);
  assert.doesNotMatch(afterCommit, /sendWhatsAppSafe/);
});

test("REGRESSION FIX: verifyPayment sends the dedicated subscription-activated email + WhatsApp exactly when it performs the real first activation", () => {
  const verifyPaymentSource = paymentControllerSource.slice(
    paymentControllerSource.indexOf("export const verifyPayment"),
    paymentControllerSource.indexOf("export const getShippingInfo"),
  );

  assert.match(verifyPaymentSource, /let subscriptionJustActivated = false;/);
  assert.match(
    verifyPaymentSource,
    /lockedOrder\.subscription_status !== "active"/,
  );
  assert.match(verifyPaymentSource, /subscriptionJustActivated = true;/);

  const notifyBlock = verifyPaymentSource.slice(
    verifyPaymentSource.indexOf("if (subscriptionJustActivated) {"),
  );
  assert.match(notifyBlock, /sendSubscriptionActivationEmail/);
  assert.match(notifyBlock, /sendSubscriptionWhatsAppOnce/);
  assert.match(
    notifyBlock,
    /const activationKey = `subscription:\$\{razorpay_subscription_id\}:activated`/,
  );
});

test("REGRESSION FIX: verifyPayment, subscription.activated, and payment.captured all share the exact same activation notification key", () => {
  const activatedKeyPattern = /subscription:\$\{rzpSubscriptionId\}:activated/;
  const verifyPaymentKeyPattern =
    /subscription:\$\{razorpay_subscription_id\}:activated/;

  const activatedCase = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "subscription.activated"'),
    paymentControllerSource.indexOf('case "subscription.created"'),
  );
  const capturedCase = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "payment.captured"'),
    paymentControllerSource.indexOf('case "payment.failed"'),
  );
  const verifyPaymentSource = paymentControllerSource.slice(
    paymentControllerSource.indexOf("export const verifyPayment"),
    paymentControllerSource.indexOf("export const getShippingInfo"),
  );

  assert.match(activatedCase, activatedKeyPattern);
  assert.match(capturedCase, activatedKeyPattern);
  assert.match(verifyPaymentSource, verifyPaymentKeyPattern);
});

// ── REGRESSION FIX: payment.captured's subscription branch previously had
//    NO transition guard at all — a webhook retry duplicated the
//    order_status_history row on every redelivery, silently, forever ─────

test("REGRESSION FIX: payment.captured's subscription branch guards its UPDATE and only records history/notifies on a genuine transition", () => {
  const capturedCase = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "payment.captured"'),
    paymentControllerSource.indexOf('case "payment.failed"'),
  );
  assert.match(
    capturedCase,
    /WHERE id = \? AND COALESCE\(subscription_status, ''\) <> 'active'/,
  );
  assert.match(capturedCase, /if \(captureActivation\.rowCount\)/);
});

// ── REGRESSION FIX: webhook-only events (renewal, halt, payment failure,
//    and the webhook's own confirmation of pause/resume/cancel) previously
//    sent email but never WhatsApp, with no stated business reason ───────

test("REGRESSION FIX: every webhook subscription event that sends email now also sends WhatsApp", () => {
  const cases = [
    ["subscription.paused", "subscription.resumed"],
    ["subscription.resumed", "subscription.halted"],
    ["subscription.halted", "subscription.cancelled"],
    ["subscription.cancelled", "subscription.completed"],
  ];
  for (const [start, end] of cases) {
    const block = paymentControllerSource.slice(
      paymentControllerSource.indexOf(`case "${start}"`),
      paymentControllerSource.indexOf(`case "${end}"`),
    );
    assert.match(
      block,
      /sendSubscriptionWhatsAppOnce/,
      `${start} must send WhatsApp`,
    );
  }

  const chargedBlock = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "subscription.charged"'),
    paymentControllerSource.indexOf('case "subscription.paused"'),
  );
  assert.match(chargedBlock, /sendSubscriptionWhatsAppOnce/);
  assert.match(chargedBlock, /event: "renewed"/);

  const failedBlock = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "payment.failed"'),
    paymentControllerSource.indexOf('case "subscription.activated"'),
  );
  assert.match(failedBlock, /sendSubscriptionWhatsAppOnce/);
  assert.match(failedBlock, /event: "payment_failed"/);
});

test("webhook-sourced pause/resume/cancel WhatsApp shares its key with the customer/admin-triggered send for the same event (no double-send)", () => {
  const pausedWebhook = paymentControllerSource.slice(
    paymentControllerSource.indexOf('case "subscription.paused"'),
    paymentControllerSource.indexOf('case "subscription.resumed"'),
  );
  assert.match(
    pausedWebhook,
    /`subscription:\$\{rzpSubscriptionId\}:paused:whatsapp`/,
  );
  // Customer-facing helper builds the identical shape:
  // `subscription:${subscriptionId}:${event}:whatsapp` with event="paused".
  assert.match(
    subscriptionControllerSource,
    /const notificationKey = `subscription:\$\{subscriptionId\}:\$\{event\}:whatsapp`/,
  );
});

// ── NEW: "Expired" — previously had zero handling anywhere in the codebase

test("NEW: subscription.completed sets subscription_status='expired' (guarded) and sends both email and WhatsApp", () => {
  const completedCaseStart = paymentControllerSource.indexOf(
    'case "subscription.completed"',
  );
  const completedCase = paymentControllerSource.slice(
    completedCaseStart,
    // Plain indexOf("default:") would false-match the earlier
    // "is_default:" comment (contains "default:" as a substring) —
    // search from this case's own start instead.
    paymentControllerSource.indexOf("default:", completedCaseStart),
  );
  assert.match(completedCase, /subscription_status = 'expired'/);
  assert.match(
    completedCase,
    /WHERE id = \? AND COALESCE\(subscription_status, ''\) <> 'expired'/,
  );
  assert.match(completedCase, /if \(expiredUpdate\.rowCount\)/);
  assert.match(completedCase, /sendSubscriptionExpiredEmail/);
  assert.match(completedCase, /sendSubscriptionWhatsAppOnce/);
  assert.match(completedCase, /event: "expired"/);
});

test("NEW: 'expired' has its own dedicated WhatsApp message copy and readable label, not the generic fallback", () => {
  const messagesBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const buildSubscriptionStatusMessage"),
    whatsappServiceSource.indexOf("export const getReadableSubscriptionStatus"),
  );
  assert.match(
    messagesBlock,
    /expired:\s*"Your subscription has completed its billing cycles/,
  );
  const labelsBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const getReadableSubscriptionStatus"),
  );
  assert.match(labelsBlock, /expired:\s*"Expired"/);
});

test("NEW: sendSubscriptionExpiredEmail exists and is exported from orderEmailService", () => {
  assert.match(
    orderEmailServiceSource,
    /export const sendSubscriptionExpiredEmail = async/,
  );
});

test("'halted' also has its own dedicated WhatsApp message copy now (previously fell through to the generic fallback)", () => {
  const messagesBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const buildSubscriptionStatusMessage"),
    whatsappServiceSource.indexOf("export const getReadableSubscriptionStatus"),
  );
  assert.match(
    messagesBlock,
    /halted:\s*"Your subscription has been halted/,
  );
});
