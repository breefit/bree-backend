import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPaymentState,
  getMissingContactUpdates,
  formatRazorpayShippingAddress,
  shouldRecordPaymentHistory,
  getOrderConfirmationRecipients,
  notifyInitialOrderConfirmation,
  notifyPaidStatusUpdate,
} from "../src/controllers/paymentController.js";
import { buildOrderStatusNotificationKey } from "../src/services/orderStatusNotificationService.js";

test("processes an unpaid order", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "pending",
      storedPaymentId: null,
      incomingPaymentId: "pay_A",
    }),
    "process",
  );
});

test("reconciles a paid order whose order payment ID is missing", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: null,
      incomingPaymentId: "pay_A",
    }),
    "reconcile",
  );
});

test("accepts duplicate verification or webhook for the same payment", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: "pay_A",
      incomingPaymentId: "pay_A",
    }),
    "already_paid",
  );
});

test("preserves conflict protection for a different payment", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: "pay_A",
      incomingPaymentId: "pay_B",
    }),
    "conflict",
  );
});

test("formats the authoritative Magic Checkout shipping address", () => {
  assert.equal(
    formatRazorpayShippingAddress({
      name: "Customer",
      line1: "1 Main Street",
      line2: "Apt 2",
      city: "Pune",
      state: "MH",
      zipcode: "411001",
      country: "India",
    }),
    "Customer, 1 Main Street, Apt 2, Pune, MH, 411001, India",
  );
});

test("fills a missing phone from verified Razorpay contact data", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "user@example.com",
      currentPhone: "",
      verifiedEmail: "user@example.com",
      verifiedPhone: "+919876543210",
    }),
    { email: null, phone: "+919876543210" },
  );
});

test("fills a missing email from verified Razorpay customer data", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "",
      currentPhone: "9876543210",
      verifiedEmail: "USER@EXAMPLE.COM",
      verifiedPhone: "+919876543210",
    }),
    { email: "user@example.com", phone: null },
  );
});

test("does not overwrite existing contact fields or invent an email", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "existing@example.com",
      currentPhone: "9876543210",
      verifiedEmail: "",
      verifiedPhone: "+919999999999",
    }),
    { email: null, phone: null },
  );
});

test("does not add payment history for a duplicate webhook", () => {
  assert.equal(shouldRecordPaymentHistory("paid"), false);
  assert.equal(shouldRecordPaymentHistory("pending"), true);
});

test("resolves guest checkout contacts from the order record", () => {
  assert.deepEqual(
    getOrderConfirmationRecipients({
      email: "guest@example.com",
      mobile_number: "+919876543210",
    }),
    { email: "guest@example.com", phone: "+919876543210" },
  );
});

test("resolves logged-in contact fields without inventing missing email", () => {
  assert.deepEqual(
    getOrderConfirmationRecipients({
      contact_email: null,
      contact_phone: "9876543210",
      email: null,
      mobile_number: "9876543210",
    }),
    { email: null, phone: "9876543210" },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ISSUE-003 / ISSUE-004 — Order Confirmation & Payment Received notification
// races. Both notifyInitialOrderConfirmation and notifyPaidStatusUpdate now
// route every send through the same atomic order_status_notifications
// claim (sendOrderStatusNotificationOnce) already proven correct for
// shipping/return/subscription notifications. These tests drive the real
// controller functions end-to-end (real claim state machine, real key
// building) against an in-memory fake for both the `orders`/`order_items`
// lookups and the order_status_notifications table — mirroring the
// queryExecutor-injection pattern already used in
// shippingNotifications.test.js — with the network-calling email/WhatsApp
// senders swapped for counters via the same injection pattern, since this
// repo has no separate test database and must never touch production.
// ─────────────────────────────────────────────────────────────────────────

const createFakeOrderDb = ({ order, items = [] }) => {
  const notifRows = new Map();
  const STALE_CLAIM_MINUTES = 5;

  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.includes("FROM orders WHERE id = ?")) {
      return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
    }

    if (normalized.includes("FROM order_items WHERE order_id = ?")) {
      return { rows: items, rowCount: items.length };
    }

    if (normalized.startsWith("INSERT IGNORE INTO order_status_notifications")) {
      const [key] = params;
      if (!notifRows.has(key)) {
        notifRows.set(key, {
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
      const row = notifRows.get(key);
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
      const row = notifRows.get(key);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "sent";
      row.sent_at = new Date();
      row.last_error = null;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("SET status = 'failed'")) {
      const [errorMessage, key] = params;
      const row = notifRows.get(key);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "failed";
      row.last_error = errorMessage;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake query in paymentIdempotency test: ${normalized}`);
  };

  return { queryExecutor, notifRows };
};

const paidOrder = {
  id: "order-conf-1",
  order_number: "BRE-1001",
  customer_name: "Test Customer",
  contact_name: "Test Customer",
  email: "customer@example.com",
  contact_email: "customer@example.com",
  mobile_number: "9876543210",
  contact_phone: "9876543210",
  total: 999,
  amount: 999,
  shipping_address: "1 Main Street",
  paid_at: new Date(),
  payment_status: "paid",
};

test("ISSUE-003: concurrent order-confirmation triggers (verify racing a redelivered webhook) send exactly one email and one WhatsApp", async () => {
  const { queryExecutor } = createFakeOrderDb({
    order: paidOrder,
    items: [{ name: "Bree Fit", quantity: 1, price: 999, subtotal: 999 }],
  });
  let emailCalls = 0;
  let whatsappCalls = 0;
  const sendConfirmationEmail = async () => {
    emailCalls += 1;
  };
  const sendConfirmationWhatsApp = async () => {
    whatsappCalls += 1;
    return { success: true };
  };

  await Promise.all([
    notifyInitialOrderConfirmation(paidOrder.id, {
      queryExecutor,
      sendConfirmationEmail,
      sendConfirmationWhatsApp,
    }),
    notifyInitialOrderConfirmation(paidOrder.id, {
      queryExecutor,
      sendConfirmationEmail,
      sendConfirmationWhatsApp,
    }),
  ]);

  assert.equal(emailCalls, 1, "order confirmation email must be sent exactly once");
  assert.equal(whatsappCalls, 1, "order confirmation WhatsApp must be sent exactly once");
});

test("ISSUE-003: a later duplicate call (e.g. a retried webhook) after the first send completed sends nothing more", async () => {
  const { queryExecutor } = createFakeOrderDb({ order: paidOrder });
  let emailCalls = 0;
  const sendConfirmationEmail = async () => {
    emailCalls += 1;
  };
  const sendConfirmationWhatsApp = async () => ({ success: true });

  await notifyInitialOrderConfirmation(paidOrder.id, {
    queryExecutor,
    sendConfirmationEmail,
    sendConfirmationWhatsApp,
  });
  await notifyInitialOrderConfirmation(paidOrder.id, {
    queryExecutor,
    sendConfirmationEmail,
    sendConfirmationWhatsApp,
  });

  assert.equal(emailCalls, 1);
});

test("ISSUE-003: an order that is not yet paid never claims or sends a confirmation", async () => {
  const { queryExecutor } = createFakeOrderDb({
    order: { ...paidOrder, payment_status: "pending" },
  });
  let emailCalls = 0;
  await notifyInitialOrderConfirmation(paidOrder.id, {
    queryExecutor,
    sendConfirmationEmail: async () => {
      emailCalls += 1;
    },
    sendConfirmationWhatsApp: async () => ({ success: true }),
  });
  assert.equal(emailCalls, 0);
});

test("ISSUE-004: concurrent payment-received triggers (verifyPayment racing payment.captured webhook) send exactly one email and one WhatsApp", async () => {
  const { queryExecutor } = createFakeOrderDb({ order: paidOrder });
  let emailCalls = 0;
  let whatsappCalls = 0;
  const sendPaidEmail = async () => {
    emailCalls += 1;
  };
  const sendPaidWhatsApp = async () => {
    whatsappCalls += 1;
  };

  await Promise.all([
    notifyPaidStatusUpdate(paidOrder.id, { queryExecutor, sendPaidEmail, sendPaidWhatsApp }),
    notifyPaidStatusUpdate(paidOrder.id, { queryExecutor, sendPaidEmail, sendPaidWhatsApp }),
  ]);

  assert.equal(emailCalls, 1, "payment received email must be sent exactly once");
  assert.equal(whatsappCalls, 1, "payment received WhatsApp must be sent exactly once");
});

test("ISSUE-003/ISSUE-004: order-confirmation and payment-received notifications use distinct keys and never share a claim", () => {
  const confirmationKey = buildOrderStatusNotificationKey({
    orderId: paidOrder.id,
    status: "confirmed",
    channel: "email",
  });
  const paidKey = buildOrderStatusNotificationKey({
    orderId: paidOrder.id,
    status: "paid",
    channel: "email",
  });
  assert.notEqual(confirmationKey, paidKey);
});
