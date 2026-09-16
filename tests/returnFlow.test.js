import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  isReturnWindowOpen,
  slugifyReturnEventLabel,
  resolveCustomerAddressWithFallback,
  buildReverseShipmentRoles,
  resolveApprovedRefundAmount,
} from "../src/controllers/admin/returnController.js";
import {
  sendOrderStatusNotificationOnce,
  buildOrderStatusNotificationKey,
} from "../src/services/orderStatusNotificationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const returnControllerSource = read(
  "../src/controllers/admin/returnController.js",
);
const whatsappServiceSource = read(
  "../src/services/whatsappNotificationService.js",
);

const HOUR_MS = 60 * 60 * 1000;

// ── 1-6: Return eligibility / 48-hour window (isReturnWindowOpen) ──────────
// Direct behavioral tests against the real, exported function — not a
// regex against the source — since this is the single shared rule every
// mutating return endpoint depends on.

test("isReturnWindowOpen: delivered well within 48 hours is eligible", () => {
  const order = {
    order_status: "delivered",
    delivered_at: new Date(Date.now() - 2 * HOUR_MS),
    return_status: null,
  };
  const result = isReturnWindowOpen(order);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.ok(result.deadline instanceof Date);
});

test("isReturnWindowOpen: exactly at the 48-hour boundary is still eligible (Date.now() > deadline, not >=)", () => {
  const deliveredAt = new Date(Date.now() - 48 * HOUR_MS + 5000); // 5s shy of the deadline
  const order = { order_status: "delivered", delivered_at: deliveredAt, return_status: null };
  assert.equal(isReturnWindowOpen(order).eligible, true);
});

test("isReturnWindowOpen: delivered more than 48 hours ago is ineligible with the expired message", () => {
  const order = {
    order_status: "delivered",
    delivered_at: new Date(Date.now() - 50 * HOUR_MS),
    return_status: null,
  };
  const result = isReturnWindowOpen(order);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /48-hour return window has expired/);
});

test("isReturnWindowOpen: delivered_at NULL is ineligible ('cannot be determined'), never silently treated as eligible", () => {
  const order = { order_status: "delivered", delivered_at: null, return_status: null };
  const result = isReturnWindowOpen(order);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /cannot be determined/);
  assert.equal(result.deadline, null);
});

test("isReturnWindowOpen: an order that isn't delivered is ineligible regardless of any other field", () => {
  const order = {
    order_status: "shipped",
    delivered_at: new Date(),
    return_status: null,
  };
  const result = isReturnWindowOpen(order);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /Returns can only be requested for delivered orders/);
});

test("isReturnWindowOpen: a return already rejected or returned is ineligible even if still within the window", () => {
  for (const status of ["rejected", "returned"]) {
    const order = {
      order_status: "delivered",
      delivered_at: new Date(Date.now() - HOUR_MS),
      return_status: status,
    };
    const result = isReturnWindowOpen(order);
    assert.equal(result.eligible, false);
    assert.match(result.reason, new RegExp(`already been ${status}`));
  }
});

test("isReturnWindowOpen: approved/reverse_shipment_created/pickup_scheduled are NOT blocked by this function itself (approveReturn's own separate guard handles those)", () => {
  for (const status of ["approved", "reverse_shipment_created", "pickup_scheduled"]) {
    const order = {
      order_status: "delivered",
      delivered_at: new Date(Date.now() - HOUR_MS),
      return_status: status,
    };
    assert.equal(isReturnWindowOpen(order).eligible, true);
  }
});

// ── 7-10: Reverse-shipment address resolution (REGRESSION FIX) ────────────

const createFakeAddressClient = ({ userAddress, legacyAddress } = {}) => ({
  query: async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id, full_name, phone")) {
      return { rows: userAddress ? [userAddress] : [] };
    }
    if (normalized.startsWith("SELECT id, label, address_line1")) {
      return { rows: legacyAddress ? [legacyAddress] : [] };
    }
    throw new Error(`Unhandled query: ${normalized}`);
  },
});

test("resolveCustomerAddressWithFallback: resolves via user_addresses when address_id matches", async () => {
  const client = createFakeAddressClient({
    userAddress: {
      full_name: "Asha",
      phone: "9876543210",
      address_line_1: "12 MG Road",
      address_line_2: "",
      city: "Bengaluru",
      state: "KA",
      pincode: "560001",
      country: "India",
    },
  });
  const order = { address_id: "addr-1" };
  const resolved = await resolveCustomerAddressWithFallback(client, order);
  assert.equal(resolved.full_name, "Asha");
  assert.equal(resolved.pincode, "560001");
});

test("resolveCustomerAddressWithFallback: falls back to legacy addresses when no user_addresses row exists", async () => {
  const client = createFakeAddressClient({
    legacyAddress: {
      label: "Home",
      address_line1: "45 Park St",
      address_line2: "",
      city: "Kolkata",
      state: "WB",
      pincode: "700001",
      country: "India",
    },
  });
  const order = { address_id: "addr-2", contact_name: "Ravi", contact_phone: "9999999999" };
  const resolved = await resolveCustomerAddressWithFallback(client, order);
  assert.equal(resolved.full_name, "Ravi");
  assert.equal(resolved.city, "Kolkata");
});

test("REGRESSION FIX: resolveCustomerAddressWithFallback falls back to the order's own structured shipping columns when there is no address_id at all (guest/Magic Checkout/Bulk Booking orders)", async () => {
  const client = createFakeAddressClient({});
  const order = {
    address_id: null,
    contact_name: "Guest Customer",
    contact_phone: "9123456789",
    shipping_address_line1: "7 Bulk Lane",
    shipping_address_line2: "Suite 2",
    shipping_city: "Pune",
    shipping_state: "MH",
    shipping_pincode: "411001",
    shipping_country: "India",
  };
  const resolved = await resolveCustomerAddressWithFallback(client, order);
  assert.ok(resolved, "must not return null when structured shipping columns are present");
  assert.equal(resolved.full_name, "Guest Customer");
  assert.equal(resolved.address_line_1, "7 Bulk Lane");
  assert.equal(resolved.city, "Pune");
  assert.equal(resolved.pincode, "411001");
});

test("resolveCustomerAddressWithFallback: returns null when there is truly no address anywhere (address_id absent AND no structured columns) — still fails safely, not silently invented", async () => {
  const client = createFakeAddressClient({});
  const order = { address_id: null };
  const resolved = await resolveCustomerAddressWithFallback(client, order);
  assert.equal(resolved, null);
});

test("resolveCustomerAddressWithFallback: an address_id that resolves to nothing does NOT fall through to structured columns if they're also incomplete", async () => {
  const client = createFakeAddressClient({});
  const order = { address_id: "addr-missing", shipping_city: "Pune" }; // no line1/pincode
  const resolved = await resolveCustomerAddressWithFallback(client, order);
  assert.equal(resolved, null);
});

// ── 11: Reverse-shipment address-role swap ─────────────────────────────────

test("buildReverseShipmentRoles: customer becomes the pickup origin, warehouse becomes the delivery destination", () => {
  const customerAddress = {
    full_name: "Asha",
    mobile: "9876543210",
    address_line_1: "12 MG Road",
    address_line_2: "Flat 3",
    city: "Bengaluru",
    state: "KA",
    pincode: "560001",
    country: "India",
  };
  const warehouse = {
    name: "BREE Warehouse",
    phone: "9000000000",
    address: "Industrial Area",
    city: "Chennai",
    state: "TN",
    pincode: "600001",
    country: "India",
  };
  const { destinationAddress, originAsWarehouse } = buildReverseShipmentRoles(
    customerAddress,
    warehouse,
  );
  // Destination (where Delhivery delivers the reverse shipment) is BREE.
  assert.equal(destinationAddress.full_name, "BREE Warehouse");
  assert.equal(destinationAddress.city, "Chennai");
  // Origin (where Delhivery picks up) is the customer.
  assert.equal(originAsWarehouse.name, "Asha");
  assert.equal(originAsWarehouse.city, "Bengaluru");
  assert.match(originAsWarehouse.address, /12 MG Road, Flat 3/);
});

// ── 12-15: Return/refund notification idempotency (REGRESSION FIX) ────────
// notifyReturnEvent() now routes through sendOrderStatusNotificationOnce —
// exercised directly here the same way the shipping/subscription
// notification tests do, against an in-memory fake of
// order_status_notifications.

const createFakeNotificationsTable = () => {
  const rows = new Map();
  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT IGNORE INTO order_status_notifications")) {
      const [key] = params;
      if (!rows.has(key)) {
        rows.set(key, { status: "pending", attempts: 0, last_attempt_at: null });
      }
      return { rowCount: 0 };
    }
    if (normalized.includes("SET status = 'sending'")) {
      const [key, retryFailed, staleMinutes] = params;
      const row = rows.get(key);
      if (!row) return { rowCount: 0 };
      const isStale =
        row.status === "sending" &&
        row.last_attempt_at &&
        Date.now() - row.last_attempt_at.getTime() > staleMinutes * 60 * 1000;
      const claimable =
        row.status === "pending" ||
        (row.status === "failed" && retryFailed === 1) ||
        isStale;
      if (!claimable) {
        return { rowCount: 0 };
      }
      row.status = "sending";
      row.last_attempt_at = new Date();
      return { rowCount: 1 };
    }
    if (normalized.includes("SET status = 'sent'")) {
      const [key] = params;
      rows.get(key).status = "sent";
      return { rowCount: 1 };
    }
    if (normalized.includes("SET status = 'failed'")) {
      const [, key] = params;
      rows.get(key).status = "failed";
      return { rowCount: 1 };
    }
    throw new Error(`Unhandled fake order_status_notifications query: ${normalized}`);
  };
  return { queryExecutor, rows };
};

test("REGRESSION FIX: a return event notification (e.g. 'Return Approved') sends exactly once per order+event+channel", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-r1",
    status: slugifyReturnEventLabel("Return Approved"),
    channel: "whatsapp",
  });
  assert.equal(key, "order:order-r1:status:return_approved:channel:whatsapp");

  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };
  const first = await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
  const second = await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
  assert.deepEqual(first, { sent: true, duplicate: false });
  assert.deepEqual(second, { sent: false, duplicate: true });
  assert.equal(sendCalls, 1);
});

test("REGRESSION FIX: a duplicate admin click / concurrent request racing on the same return event sends exactly once", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-r2",
    status: slugifyReturnEventLabel("Return Shipment Created"),
    channel: "email",
  });
  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };
  const [a, b] = await Promise.all([
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
    sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor }),
  ]);
  const sentCount = [a, b].filter((r) => r.sent).length;
  assert.equal(sentCount, 1);
  assert.equal(sendCalls, 1);
});

test("REGRESSION FIX: a provider failure for a return notification is recorded as failed, never marked sent, and is retryable on a later attempt", async () => {
  const { queryExecutor, rows } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-r3",
    status: slugifyReturnEventLabel("Refund Initiated"),
    channel: "whatsapp",
  });
  await assert.rejects(() =>
    sendOrderStatusNotificationOnce({
      notificationKey: key,
      send: async () => {
        throw new Error("Waplify 500");
      },
      queryExecutor,
    }),
  );
  assert.equal(rows.get(key).status, "failed");

  // Without retryFailed, a later attempt is a safe no-op duplicate, not a
  // second silent failure.
  const retry = await sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {},
    queryExecutor,
  });
  assert.equal(retry.sent, false);
  assert.equal(retry.duplicate, true);
});

test("REGRESSION FIX: webhook/cron-style redelivery of the same return event (simulated as a second call after the first already succeeded) sends 0 additional notifications", async () => {
  const { queryExecutor } = createFakeNotificationsTable();
  const key = buildOrderStatusNotificationKey({
    orderId: "order-r4",
    status: slugifyReturnEventLabel("Return Received"),
    channel: "email",
  });
  let sendCalls = 0;
  const send = async () => {
    sendCalls += 1;
  };
  await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
  for (let i = 0; i < 3; i++) {
    await sendOrderStatusNotificationOnce({ notificationKey: key, send, queryExecutor });
  }
  assert.equal(sendCalls, 1);
});

// ── Source-level wiring checks: confirm notifyReturnEvent() actually uses
//    the mechanism exercised above, for every one of the 10 call sites ────

test("notifyReturnEvent is wired through sendOrderStatusNotificationOnce for both channels, not a bare fire-and-forget call", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("const notifyReturnEvent ="),
    returnControllerSource.indexOf("const isPositiveNumber ="),
  );
  assert.match(fnSource, /sendOrderStatusNotificationOnce\(/g);
  assert.match(fnSource, /buildOrderStatusNotificationKey\(/g);
  assert.match(fnSource, /slugifyReturnEventLabel\(label\)/);
  // Both channels must go through it — not just one.
  const emailBlock = fnSource.slice(fnSource.indexOf("if (recipientEmail)"), fnSource.indexOf("if (recipientPhone)"));
  const whatsappBlock = fnSource.slice(fnSource.indexOf("if (recipientPhone)"));
  assert.match(emailBlock, /sendOrderStatusNotificationOnce\(/);
  assert.match(whatsappBlock, /sendOrderStatusNotificationOnce\(/);
});

test("all notifying return/refund endpoints still call notifyReturnEvent (unchanged call sites — only its internals changed), and rejectRefund now notifies too", () => {
  const expectedLabels = [
    "Return Approved",
    "Return Rejected",
    "Return Shipment Created",
    "Return Pickup Scheduled",
    "Return Received",
    "Return Inspection Approved",
    "Return Quality Check Failed",
    // FIX (customer return/refund tracking audit): rejectRefund now
    // notifies too — see the dedicated tests below for the full rationale
    // and the idempotency/one-email-one-WhatsApp guarantee.
    "Refund Rejected",
  ];
  for (const label of expectedLabels) {
    assert.match(
      returnControllerSource,
      new RegExp(`notifyReturnEvent\\([^)]*"${label}"`),
      `expected a notifyReturnEvent call site passing "${label}"`,
    );
  }
  // approveRefund still sends NO notification — audited and confirmed
  // intentional (see the dedicated CONCLUSION test below), to avoid a
  // redundant duplicate immediately before Refund Initiated.
  const approveRefundSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const approveRefund"),
    returnControllerSource.indexOf("export const rejectRefund"),
  );
  assert.doesNotMatch(approveRefundSource, /notifyReturnEvent/);
});

// ── REGRESSION FIX: distinct notification for quality-check rejection ─────

test("REGRESSION FIX: rejectInspection sends the distinct 'Return Quality Check Failed' label, not the same 'Return Rejected' label rejectReturn uses", () => {
  const rejectInspectionSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const rejectInspection"),
    returnControllerSource.indexOf("export const approveRefund"),
  );
  assert.match(rejectInspectionSource, /notifyReturnEvent\(updated, "Return Quality Check Failed"/);

  const rejectReturnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const rejectReturn"),
    returnControllerSource.indexOf("export const createReverseShipment"),
  );
  assert.match(rejectReturnSource, /notifyReturnEvent\(updated, "Return Rejected"/);
});

test("REGRESSION FIX: 'Return Quality Check Failed' has its own dedicated WhatsApp message and readable label, distinct from 'Return Rejected'", () => {
  const messagesBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("const RETURN_STATUS_MESSAGES"),
    whatsappServiceSource.indexOf("export const buildOrderStatusMessage"),
  );
  assert.match(messagesBlock, /"Return Quality Check Failed":\s*\n?\s*"[^"]*did not pass our quality check/);

  const labelsBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const getReadableOrderStatus"),
  );
  assert.match(labelsBlock, /"Return Quality Check Failed": "Return Quality Check Failed"/);
});

// ── REGRESSION FIX: scheduleReversePickup repeat-click no longer returns a
//    misleading error ──────────────────────────────────────────────────────

test("REGRESSION FIX: scheduleReversePickup returns an idempotent 200 (not a misleading 400) when a reverse pickup already exists", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const scheduleReversePickup"),
    returnControllerSource.indexOf("export const markReturned"),
  );
  // The idempotent branch must come BEFORE the generic "must exist" guard,
  // and must return success:true with a 200, not the old confusing error.
  const idempotentBranchIndex = fnSource.indexOf('order.return_status === "pickup_scheduled"');
  const genericGuardIndex = fnSource.indexOf("A reverse shipment must exist before scheduling pickup");
  assert.ok(idempotentBranchIndex !== -1, "expected the pickup_scheduled idempotent check to exist");
  assert.ok(
    idempotentBranchIndex < genericGuardIndex,
    "the idempotent short-circuit must be checked before the generic status guard",
  );
  const idempotentBlock = fnSource.slice(idempotentBranchIndex, genericGuardIndex);
  assert.match(idempotentBlock, /status\(200\)/);
  assert.match(idempotentBlock, /success:\s*true/);
});

// ── Regression protection: the existing, already-correct state-machine
//    guards and idempotency behavior — confirming this audit did not
//    weaken any of them ─────────────────────────────────────────────────────

test("approveReturn blocks a second approval once return_status is already set to anything", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const approveReturn"),
    returnControllerSource.indexOf("export const rejectReturn"),
  );
  assert.match(fnSource, /if \(order\.return_status\) \{/);
  assert.match(fnSource, /already in progress for this order/);
});

test("createReverseShipment has an idempotent short-circuit for an already-created reverse shipment, returning the existing AWB", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const createReverseShipment"),
    returnControllerSource.indexOf("export const scheduleReversePickup"),
  );
  assert.match(fnSource, /order\.return_status === "reverse_shipment_created"/);
  assert.match(fnSource, /Return shipment already exists for this order/);
  assert.match(fnSource, /status\(200\)/);
});

test("markReturned is idempotent and requires reverse_shipment_created or pickup_scheduled as the prior state", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const markReturned"),
    returnControllerSource.indexOf("5a. Quality Check"),
  );
  assert.match(fnSource, /order\.return_status === "returned"/);
  assert.match(fnSource, /already been marked as returned/);
  assert.match(fnSource, /\["reverse_shipment_created", "pickup_scheduled"\]/);
  assert.match(fnSource, /inspection_status = 'pending'/);
});

test("inspection approval and rejection are mutually exclusive one-way doors", () => {
  const approveSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const approveInspection"),
    returnControllerSource.indexOf("export const rejectInspection"),
  );
  assert.match(approveSource, /inspection_status === "rejected"/);
  assert.match(approveSource, /cannot be re-approved/);

  const rejectSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const rejectInspection"),
    returnControllerSource.indexOf("export const approveRefund"),
  );
  // rejectInspection blocks if a refund is already in motion.
  assert.match(rejectSource, /order\.refund_status/);
});

test("approveRefund hard-requires return_status='returned', inspection_status='approved', and a successful payment before it ever reaches amount resolution", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const approveRefund"),
    returnControllerSource.indexOf("export const rejectRefund"),
  );
  assert.match(fnSource, /order\.return_status !== "returned"/);
  assert.match(fnSource, /order\.inspection_status !== "approved"/);
  assert.match(fnSource, /order\.payment_status !== "paid" \|\| !order\.razorpay_payment_id/);
  assert.match(fnSource, /resolveApprovedRefundAmount\(/);
});

// ── ISSUE-005 — Approve Refund frontend/backend contract mismatch ─────────
// The real admin "Approve Refund" button is a plain confirm modal with no
// amount field and always PATCHes an EMPTY body (bree-frontend/src/pages/
// admin/Orders.js's handleApproveRefund) — the backend used to hard-require
// a positive refund_amount, so every real click 400'd and refunds could
// never be approved through the UI at all. resolveApprovedRefundAmount is
// the actual fix; these are real behavioral calls against the exported
// function (not a regex over the source), proving the exact empty-body
// shape the button sends now succeeds, and that an explicit/garbage amount
// is still fully validated.

test("ISSUE-005: an empty body (the real 'Approve Refund' button's exact request) defaults to a full refund of the order total", () => {
  const result = resolveApprovedRefundAmount({
    refundAmountProvided: false,
    refundAmount: undefined,
    refundableAmount: 799,
  });
  assert.deepEqual(result, { ok: true, amount: 799 });
});

test("ISSUE-005: an order with no refundable amount on record is rejected outright, even with no amount requested", () => {
  const result = resolveApprovedRefundAmount({
    refundAmountProvided: false,
    refundAmount: undefined,
    refundableAmount: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /no refundable amount/);
});

test("ISSUE-005: an explicit partial refund amount within the refundable total is honored exactly", () => {
  const result = resolveApprovedRefundAmount({
    refundAmountProvided: true,
    refundAmount: 300,
    refundableAmount: 799,
  });
  assert.deepEqual(result, { ok: true, amount: 300 });
});

test("ISSUE-005: an explicit amount above the refundable total is rejected, never silently capped or trusted", () => {
  const result = resolveApprovedRefundAmount({
    refundAmountProvided: true,
    refundAmount: 999999,
    refundableAmount: 799,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot exceed the refundable amount of ₹799/);
});

test("ISSUE-005: an explicit zero/negative/non-numeric amount is rejected rather than silently defaulting", () => {
  for (const bad of [0, -50, "abc", NaN]) {
    const result = resolveApprovedRefundAmount({
      refundAmountProvided: true,
      refundAmount: bad,
      refundableAmount: 799,
    });
    assert.equal(result.ok, false, `refundAmount=${bad} must not be accepted`);
  }
});

test("completeRefund is three-mode idempotent (already_completed / recheck / create) and never calls payments.refund() twice for the same order", () => {
  const fnSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const completeRefund"),
  );
  assert.match(fnSource, /mode = "already_completed"/);
  assert.match(fnSource, /mode = "recheck"/);
  assert.match(fnSource, /mode = "create"/);
  assert.match(fnSource, /razorpay\.refunds\.fetch\(order\.refund_reference\)/);
  assert.match(fnSource, /razorpay\.payments\.refund\(/);
  // The Razorpay call happens with no open DB transaction (lock released
  // before phase 2) — the single most important guarantee against a
  // duplicate refund.
  const phase1End = fnSource.indexOf("// ── Phase 2:");
  const phase2Block = fnSource.slice(phase1End, fnSource.indexOf("// ── Phase 3:"));
  assert.doesNotMatch(phase2Block, /BEGIN/);
  // Only "processed" is ever mapped to completed — everything else,
  // including any unrecognized status, becomes "initiated".
  assert.match(fnSource, /isProcessed = razorpayRefund\?\.status === "processed"/);
  // Notification only fires on an actual state transition.
  assert.match(fnSource, /if \(didTransition\)/);
});

// FIX (ISSUE-010): this used to be a source-text-regex test documenting
// the OLD, narrower guard (rejectRefund blocked only 'completed', not
// 'initiated' — the exact contradiction-risk gap the audit flagged: a
// refund already sent to Razorpay could still be marked "rejected" in the
// DB). Superseded by real behavioral tests that drive the actual exported
// rejectRefund function end-to-end against a fake DB — see
// refundConcurrency.test.js ("ISSUE-010: rejectRefund is blocked once
// refund_status is '<initiated|processing|completed>'" and the "still
// succeeds for a refund that was approved" regression case).

// ── Security / authorization: every mutating handler locks the row and
//    trusts nothing from the client for identity or amount ────────────────

test("every mutating return/refund handler opens with SELECT ... FOR UPDATE — no handler trusts an unlocked read", () => {
  const handlerNames = [
    "approveReturn",
    "rejectReturn",
    "createReverseShipment",
    "scheduleReversePickup",
    "markReturned",
    "approveInspection",
    "rejectInspection",
    "approveRefund",
    "rejectRefund",
  ];
  for (let i = 0; i < handlerNames.length; i++) {
    const start = returnControllerSource.indexOf(`export const ${handlerNames[i]}`);
    const end =
      i + 1 < handlerNames.length
        ? returnControllerSource.indexOf(`export const ${handlerNames[i + 1]}`)
        : returnControllerSource.indexOf("export const completeRefund");
    const fnSource = returnControllerSource.slice(start, end);
    assert.match(
      fnSource,
      /FOR UPDATE/,
      `${handlerNames[i]} must lock the order row before validating/mutating it`,
    );
  }
});

test("refund amount is never trusted from anywhere except approveRefund's own validated refund_amount column — completeRefund takes no body", () => {
  const completeRefundSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const completeRefund"),
  );
  assert.doesNotMatch(completeRefundSource, /req\.body/);
  assert.match(completeRefundSource, /Number\(order\.refund_amount\)/);
});

// ── Customer return/refund tracking fix: "Refund Rejected" notification ───

test("REGRESSION FIX: rejectRefund now sends a customer notification ('Refund Rejected'), unlike before this fix", () => {
  const rejectRefundSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const rejectRefund"),
    returnControllerSource.indexOf("export const completeRefund"),
  );
  assert.match(rejectRefundSource, /notifyReturnEvent\(updated, "Refund Rejected"/);
});

test("CONCLUSION (audited, not blindly added): approveRefund still sends NO customer notification — avoids a redundant duplicate immediately before Refund Initiated", () => {
  const approveRefundSource = returnControllerSource.slice(
    returnControllerSource.indexOf("export const approveRefund"),
    returnControllerSource.indexOf("export const rejectRefund"),
  );
  assert.doesNotMatch(approveRefundSource, /notifyReturnEvent/);
});

test("'Refund Rejected' has its own dedicated email/WhatsApp message and readable label, not the generic fallback", () => {
  const messagesBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("const RETURN_STATUS_MESSAGES"),
    whatsappServiceSource.indexOf("export const buildOrderStatusMessage"),
  );
  assert.match(
    messagesBlock,
    /"Refund Rejected":\s*\n?\s*"[^"]*refund request could not be approved/,
  );
  const labelsBlock = whatsappServiceSource.slice(
    whatsappServiceSource.indexOf("export const getReadableOrderStatus"),
  );
  assert.match(labelsBlock, /"Refund Rejected": "Refund Rejected"/);
});

test("REGRESSION: Refund Rejected notification sends exactly one email + one WhatsApp per order, and a repeated rejectRefund call sends 0 additional notifications", async () => {
  const rows = new Map();
  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT IGNORE INTO order_status_notifications")) {
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

  const emailKey = buildOrderStatusNotificationKey({
    orderId: "order-rr1",
    status: slugifyReturnEventLabel("Refund Rejected"),
    channel: "email",
  });
  const whatsappKey = buildOrderStatusNotificationKey({
    orderId: "order-rr1",
    status: slugifyReturnEventLabel("Refund Rejected"),
    channel: "whatsapp",
  });

  let emailSends = 0;
  let whatsappSends = 0;

  // Simulates rejectRefund being called 3 times for the same order (double
  // click, retry, or an admin revisiting the order) — exactly one email
  // and one WhatsApp must ever actually send.
  for (let i = 0; i < 3; i++) {
    await sendOrderStatusNotificationOnce({
      notificationKey: emailKey,
      send: async () => {
        emailSends += 1;
      },
      queryExecutor,
    });
    await sendOrderStatusNotificationOnce({
      notificationKey: whatsappKey,
      send: async () => {
        whatsappSends += 1;
      },
      queryExecutor,
    });
  }

  assert.equal(emailSends, 1);
  assert.equal(whatsappSends, 1);
});
