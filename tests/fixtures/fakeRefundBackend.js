/**
 * In-memory orders / payments / order_status_history / webhook_events store
 * and a fake Razorpay, modelling every statement the refund paths issue
 * (Cancel Order & Refund, completeRefund, approveRefund, the refund.* webhooks
 * and the refund reconciliation cron). `SELECT … FOR UPDATE` takes a real
 * per-row async mutex, so concurrency tests are meaningful.
 *
 * Extracted unchanged from tests/cancelOrderRefund.test.js so the
 * return-refund flow can be tested against the same model.
 * Never touches a real database or Razorpay.
 */
export const createMutex = () => {
  let locked = false;
  const waiters = [];
  return {
    acquire() {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else locked = false;
    },
  };
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const norm = (sql) => sql.replace(/\s+/g, " ").trim();

export const createFakeDb = ({ order, payment }) => {
  const orders = new Map([[order.id, { ...order }]]);
  const payments = new Map(payment ? [[payment.order_id, { ...payment }]] : []);
  const history = [];
  const remindersStopped = [];
  const webhookEvents = new Map();
  const locks = new Map();
  const lockFor = (key) => {
    if (!locks.has(key)) locks.set(key, createMutex());
    return locks.get(key);
  };

  const makeClient = () => {
    const held = [];
    const releaseAll = () => {
      while (held.length) lockFor(held.pop()).release();
    };

    const run = async (sql, params = []) => {
      const q = norm(sql);

      if (q === "BEGIN") return { rows: [], rowCount: 0 };
      if (q === "COMMIT" || q === "ROLLBACK") {
        releaseAll();
        return { rows: [], rowCount: 0 };
      }

      // ── orders ────────────────────────────────────────────────────────
      if (q === "SELECT * FROM orders WHERE id = ? FOR UPDATE") {
        await lockFor(`orders:${params[0]}`).acquire();
        held.push(`orders:${params[0]}`);
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (
        q.startsWith(
          "SELECT id, order_number, order_status, tracking_status, awb_number, contact_name, contact_email FROM orders WHERE id = ?",
        )
      ) {
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (
        q.startsWith(
          "UPDATE orders SET order_status = 'cancelled', refund_status = 'approved', refund_amount = ?",
        )
      ) {
        const [amount, id] = params;
        const row = orders.get(id);
        Object.assign(row, {
          order_status: "cancelled",
          refund_status: "approved",
          refund_amount: amount,
          refund_approved_at: new Date(),
          updated_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      // Return refund: returnController.approveRefund.
      if (q.startsWith("UPDATE orders SET refund_status = 'approved', refund_amount = ?, refund_approved_at = NOW()")) {
        const [amount, id] = params;
        Object.assign(orders.get(id), {
          refund_status: "approved",
          refund_amount: amount,
          refund_approved_at: new Date(),
          updated_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q === "UPDATE orders SET refund_status = 'processing', updated_at = NOW() WHERE id = ?") {
        const row = orders.get(params[0]);
        row.refund_status = "processing";
        row.updated_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (
        q ===
        "UPDATE orders SET refund_status = 'approved', updated_at = NOW() WHERE id = ? AND refund_status = 'processing'"
      ) {
        const row = orders.get(params[0]);
        if (row?.refund_status !== "processing") return { rows: [], rowCount: 0 };
        row.refund_status = "approved";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET refund_status = ?, refund_reference = ?")) {
        const [nextStatus, reference, id] = params;
        const row = orders.get(id);
        row.refund_status = nextStatus;
        row.refund_reference = reference;
        if (nextStatus === "completed") {
          row.payment_status = "refunded";
          row.refund_completed_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }
      if (
        q.startsWith("UPDATE orders SET refund_status = 'failed', updated_at = NOW() WHERE id = ? AND refund_status = 'initiated'")
      ) {
        const [id, reference] = params;
        const row = orders.get(id);
        if (row?.refund_status !== "initiated" || row.refund_reference !== reference) {
          return { rows: [], rowCount: 0 };
        }
        row.refund_status = "failed";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET tracking_status = ?, order_status = ?")) {
        const [trackingStatus, orderStatus, , id] = params;
        Object.assign(orders.get(id), {
          tracking_status: trackingStatus,
          order_status: orderStatus,
        });
        return { rows: [], rowCount: 1 };
      }

      // ── payments ──────────────────────────────────────────────────────
      if (q === "SELECT * FROM payments WHERE order_id = ? FOR UPDATE") {
        await lockFor(`payments:${params[0]}`).acquire();
        held.push(`payments:${params[0]}`);
        const row = payments.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q === "SELECT * FROM payments WHERE order_id = ? LIMIT 1") {
        const row = payments.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = ?, refund_amount = ?, status = CASE WHEN ? = 1")) {
        // completeRefund Phase 3
        const [refundId, amount, processed, , orderId] = params;
        const row = payments.get(orderId);
        row.refund_id = refundId;
        row.refund_amount = amount;
        if (processed === 1 && amount >= row.amount) row.status = "refunded";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = ?, refund_amount = ?, status = CASE WHEN ? >= amount")) {
        // refund.processed webhook
        const [refundId, amount, , orderId] = params;
        const row = payments.get(orderId);
        row.refund_id = refundId;
        row.refund_amount = amount;
        if (amount >= row.amount) row.status = "refunded";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = NULL, refund_amount = NULL")) {
        const [orderId, refundId] = params;
        const row = payments.get(orderId);
        if (row?.refund_id !== refundId) return { rows: [], rowCount: 0 };
        row.refund_id = null;
        row.refund_amount = null;
        return { rows: [], rowCount: 1 };
      }

      // ── history ───────────────────────────────────────────────────────
      if (q.startsWith("INSERT INTO order_status_history")) {
        history.push(params);
        return { rows: [], rowCount: 1 };
      }

      // ── webhook ledger + refund webhook statements ────────────────────
      if (q.startsWith("INSERT INTO webhook_events")) {
        const [, provider, eventId] = params;
        const key = `${provider}:${eventId}`;
        if (webhookEvents.has(key)) {
          const dup = new Error("Duplicate entry");
          dup.code = "ER_DUP_ENTRY";
          throw dup;
        }
        webhookEvents.set(key, "processing");
        return { rows: [], rowCount: 1 };
      }
      if (q === "SELECT status FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1") {
        const status = webhookEvents.get(`${params[0]}:${params[1]}`);
        return { rows: status ? [{ status }] : [] };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'processing'")) {
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'completed'")) {
        webhookEvents.set(`${params[0]}:${params[1]}`, "completed");
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'failed'")) {
        webhookEvents.set(`${params[1]}:${params[2]}`, "failed");
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("SELECT * FROM orders WHERE refund_reference = ? OR (refund_reference IS NULL")) {
        const [reference, paymentId] = params;
        const rows = [...orders.values()].filter(
          (r) =>
            r.refund_reference === reference ||
            (r.refund_reference == null &&
              r.refund_status === "processing" &&
              r.razorpay_payment_id === paymentId),
        );
        return { rows: rows.map((r) => ({ ...r })) };
      }
      if (q.startsWith("UPDATE orders SET refund_status = 'completed'")) {
        const [reference, id, guard] = params;
        const row = orders.get(id);
        if (
          !row ||
          !["initiated", "processing"].includes(row.refund_status) ||
          !(row.refund_reference === guard || row.refund_reference == null)
        ) {
          return { rows: [], rowCount: 0 };
        }
        Object.assign(row, {
          refund_status: "completed",
          payment_status: "refunded",
          refund_reference: row.refund_reference ?? reference,
          refund_completed_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET refund_status = 'failed', refund_reference = COALESCE")) {
        const [reference, id, guard] = params;
        const row = orders.get(id);
        if (
          !row ||
          !["initiated", "processing"].includes(row.refund_status) ||
          !(row.refund_reference === guard || row.refund_reference == null)
        ) {
          return { rows: [], rowCount: 0 };
        }
        row.refund_status = "failed";
        row.refund_reference = row.refund_reference ?? reference;
        return { rows: [], rowCount: 1 };
      }

if (q.startsWith("UPDATE orders SET refund_gateway_status = COALESCE(?, refund_gateway_status)")) {
  const [gatewayStatus, rrn, id] = params;
  const row = orders.get(id);
  if (row) {
    if (gatewayStatus != null) row.refund_gateway_status = gatewayStatus;
    if (rrn != null) row.refund_rrn = rrn;
  }
  return { rows: [], rowCount: row ? 1 : 0 };
}

      // Refund reconciliation cron's candidate query.
      if (q.startsWith("SELECT id, refund_status FROM orders WHERE refund_status IN ('initiated', 'processing')")) {
        const rows = [...orders.values()]
          .filter((r) => ["initiated", "processing"].includes(r.refund_status))
          .map((r) => ({ id: r.id, refund_status: r.refund_status }));
        return { rows, rowCount: rows.length };
      }

      // Cancellation also locks the row (Cancel Shipment) and stops reminders.
      if (q === "SELECT id FROM orders WHERE id = ? FOR UPDATE") {
        await lockFor(`orders:${params[0]}`).acquire();
        held.push(`orders:${params[0]}`);
        return { rows: orders.has(params[0]) ? [{ id: params[0] }] : [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE daily_reminders SET reminder_enabled = 0, status = 'ended'")) {
        remindersStopped.push(params[0]);
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unhandled fake SQL in cancelOrderRefund test: ${q}`);
    };

    return { query: run, release: releaseAll };
  };

  return {
    getClientFn: async () => makeClient(),
    queryFn: (sql, params) => makeClient().query(sql, params),
    orders,
    payments,
    history,
    remindersStopped,
  };
};

export const createFakeRazorpay = ({
  payment = {},
  paymentFetchError = null,
  refundStatus = "pending",
  refundDelayMs = 15,
  // "accept_then_timeout": Razorpay creates the refund, response is lost.
  // "timeout": request never reached Razorpay.
  failFirstRefund = null,
  existingRefunds = [],
} = {}) => {
  const ledger = [...existingRefunds];
  const counts = { refund: 0, paymentFetch: 0, refundFetch: 0 };
  let seq = 0;

  const paymentEntity = () => {
    const refunded = ledger
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    const base = {
      id: "pay_1",
      order_id: "order_rzp_1",
      amount: 50000,
      currency: "INR",
      status: "captured",
      ...payment,
    };
    return {
      ...base,
      amount_refunded: refunded,
      status: refunded >= base.amount ? "refunded" : base.status,
    };
  };

  const getRazorpayFn = () => ({
    payments: {
      fetch: async (id) => {
        counts.paymentFetch += 1;
        if (paymentFetchError) throw paymentFetchError;
        return { ...paymentEntity(), id: payment.id ?? id };
      },
      refund: async (paymentId, params) => {
        counts.refund += 1;
        await sleep(refundDelayMs);
        const attempt = counts.refund;
        if (attempt === 1 && failFirstRefund === "timeout") {
          const err = new Error("timeout of 30000ms exceeded");
          err.code = "ECONNABORTED";
          throw err;
        }
        seq += 1;
        const created = {
          id: `rfnd_${seq}`,
          payment_id: paymentId,
          amount: params.amount,
          status: refundStatus,
          notes: params.notes,
        };
        ledger.push(created);
        if (attempt === 1 && failFirstRefund === "accept_then_timeout") {
          const err = new Error("timeout of 30000ms exceeded");
          err.code = "ECONNABORTED";
          throw err;
        }
        return { ...created };
      },
      fetchMultipleRefund: async () => ({
        entity: "collection",
        count: ledger.length,
        items: ledger.map((r) => ({ ...r })),
      }),
    },
    refunds: {
      fetch: async (id) => {
        counts.refundFetch += 1;
        const r = ledger.find((x) => x.id === id);
        return r ? { ...r } : { id, status: "pending" };
      },
    },
  });

  return { getRazorpayFn, counts, ledger };
};

