// ─────────────────────────────────────────────────────────────────────────────
// renewalService.js
//
// Creates a new, independent fulfillment order whenever a Razorpay
// subscription.charged webhook fires.
//
// DESIGN PRINCIPLES
// ─────────────────
// 1. Product-agnostic: all product data is copied dynamically from the
//    original subscription order's order_items rows. No product IDs, plan
//    names, or amounts are hard-coded.
//
// 2. One renewal order per charge: the webhook handler calls
//    createRenewalOrder(rzpSubscriptionId, paymentEntity) once per
//    subscription.charged event. The function itself is idempotent — if a
//    renewal order already exists for the same razorpay_payment_id it returns
//    the existing row rather than inserting a duplicate.
//
// 3. Fulfillment-first: the renewal order starts at
//    order_status   = 'confirmed'   (payment already received)
//    payment_status = 'paid'
//    is_subscription = 1            (so admin sub views link it correctly)
//    subscription_status = 'active' (billing state)
//
// 4. Independent order number: each renewal gets its own BREE-XXXXXX number
//    from the same order_number_counter as every other order.
//
// 5. Separate payment row: a payment record is inserted referencing both the
//    new renewal order ID and the original razorpay_subscription_id so that
//    admin billing-history queries (WHERE razorpay_subscription_id = ?) return
//    the full payment chain.
//
// 6. Stock is NOT deducted for renewal orders. Subscription renewals represent
//    a commitment to deliver — stock deduction happens when the admin marks
//    the order as 'processing' (or via a future pick-list flow). This avoids
//    over-deducting stock for orders that have not yet been pulled from shelves.
//
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { getClient, query } from "../config/database.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";

/**
 * Creates a new fulfillment order for a recurring subscription charge.
 *
 * @param {string}  rzpSubscriptionId  Razorpay subscription ID
 *                                     (subscriptionEntity.id or
 *                                      paymentEntity.subscription_id)
 * @param {object}  paymentEntity      Razorpay payment entity from the webhook
 *                                     payload.payment.entity
 * @param {object}  [subscriptionEntity] Optional Razorpay subscription entity
 *                                     from payload.subscription.entity — used
 *                                     to capture next_billing_date (charge_at).
 * @returns {{ renewalOrderId: string, renewalOrderNumber: string }}
 */
export const createRenewalOrder = async (
  rzpSubscriptionId,
  paymentEntity,
  subscriptionEntity = null,
) => {
  // ── 0. Idempotency guard ──────────────────────────────────────────────────
  // If we already created a renewal order for this exact Razorpay payment ID
  // (e.g. webhook retried), return the existing row rather than duplicating.
  const rzpPaymentId = paymentEntity?.id || null;

  if (rzpPaymentId) {
    const { rows: existing } = await query(
      `SELECT id, order_number FROM orders
       WHERE razorpay_payment_id = ?
         AND is_subscription = 1
         AND is_renewal_order = 1
       LIMIT 1`,
      [rzpPaymentId],
    );
    if (existing.length) {
      console.info(
        "[RENEWAL] Idempotency: renewal order already exists for payment_id",
        {
          rzpPaymentId,
          existingOrderId: existing[0].id,
          existingOrderNumber: existing[0].order_number,
        },
      );
      return {
        renewalOrderId: existing[0].id,
        renewalOrderNumber: existing[0].order_number,
      };
    }
  }

  // ── 1. Load the original (first-cycle) subscription order ────────────────
  // We look up by razorpay_subscription_id and is_renewal_order = 0 so that
  // we always copy from the original order, not from a previous renewal.
  const { rows: originRows } = await query(
    `SELECT *
     FROM orders
     WHERE razorpay_subscription_id = ?
       AND is_subscription = 1
       AND is_renewal_order = 0
     ORDER BY created_at ASC
     LIMIT 1`,
    [rzpSubscriptionId],
  );

  if (!originRows.length) {
    throw new Error(
      `[RENEWAL] Cannot find original subscription order for subscription ${rzpSubscriptionId}`,
    );
  }

  const origin = originRows[0];

  // ── 2. Load original order_items ─────────────────────────────────────────
  // These are dynamically fetched from the DB — no product IDs are
  // hard-coded. Any product stored in the original order is copied exactly.
  const { rows: originItems } = await query(
    `SELECT product_id, product_name, product_image, product_price, quantity, subtotal
     FROM order_items
     WHERE order_id = ?`,
    [origin.id],
  );

  if (!originItems.length) {
    throw new Error(
      `[RENEWAL] Original subscription order ${origin.id} has no items — cannot create renewal`,
    );
  }

  // ── 3. Calculate totals from original items ───────────────────────────────
  // We use the DB-stored prices from the original order, not the Razorpay
  // charge amount, so even if Razorpay rounds differently the line-item maths
  // is always consistent.
  const renewalSubtotal = originItems.reduce(
    (sum, item) =>
      sum + Number(item.subtotal ?? item.product_price * item.quantity),
    0,
  );

  // ── 4. Derive next_billing_date from the subscription entity ─────────────
  const chargeAt = subscriptionEntity?.charge_at;
  const nextBillingDate = chargeAt
    ? new Date(chargeAt * 1000).toLocaleString("sv-SE", {
        timeZone: "Asia/Kolkata",
      })
    : null;

  // ── 5. Write renewal order in a transaction ───────────────────────────────
  const client = await getClient();
  let renewalOrderId;
  let renewalOrderNumber;

  try {
    await client.query("BEGIN");

    renewalOrderId = randomUUID();
    renewalOrderNumber = await getNextOrderNumber(client);

    console.info("[RENEWAL] Creating renewal order", {
      renewalOrderId,
      renewalOrderNumber,
      originOrderId: origin.id,
      originOrderNumber: origin.order_number,
      rzpSubscriptionId,
      rzpPaymentId,
    });

    // ── 5a. Insert the new order row ────────────────────────────────────────
    // Copies: user_id, address_id, customer details, shipping address,
    //         razorpay_subscription_id, razorpay_plan_id from the original.
    // New:    order_number, id, order_status='confirmed', payment_status='paid',
    //         is_renewal_order=1, razorpay_payment_id, parent_order_id.
    await client.query(
      `INSERT INTO orders (
         id,
         order_number,
         user_id,
         address_id,
         customer_name,
         email,
         mobile_number,
         shipping_address,
         contact_name,
         contact_email,
         contact_phone,
         subtotal,
         total,
         order_status,
         payment_status,
         subscription_status,
         is_subscription,
         is_renewal_order,
         parent_order_id,
         razorpay_plan_id,
         razorpay_subscription_id,
         razorpay_payment_id,
         transaction_id,
         next_billing_date,
         paid_at,
         created_at,
         updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, 'confirmed', 'paid', 'active',
         1, 1, ?, ?, ?, ?, ?,
         ?, NOW(), NOW(), NOW()
       )`,
      [
        renewalOrderId,
        renewalOrderNumber,
        origin.user_id,
        origin.address_id || null,
        origin.customer_name || origin.contact_name || null,
        origin.email || origin.contact_email || null,
        origin.mobile_number || origin.contact_phone || null,
        origin.shipping_address || null,
        origin.contact_name || origin.customer_name || null,
        origin.contact_email || origin.email || null,
        origin.contact_phone || origin.mobile_number || null,
        renewalSubtotal,
        renewalSubtotal,
        // parent_order_id — links renewal to its origin for admin queries
        origin.id,
        origin.razorpay_plan_id || null,
        rzpSubscriptionId,
        rzpPaymentId || null,
        rzpPaymentId || null, // transaction_id mirrors razorpay_payment_id
        nextBillingDate,
      ],
    );

    // ── 5b. Insert order_items (copied from original) ────────────────────────
    for (const item of originItems) {
      await client.query(
        `INSERT INTO order_items (
           id, order_id, product_id, product_name, product_image,
           product_price, quantity, subtotal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          renewalOrderId,
          item.product_id,
          item.product_name,
          item.product_image || null,
          Number(item.product_price),
          Number(item.quantity),
          Number(item.subtotal ?? item.product_price * item.quantity),
        ],
      );
    }

    // ── 5c. Insert payment record ─────────────────────────────────────────────
    // razorpay_subscription_id is stored here so admin billing-history queries
    // (WHERE razorpay_subscription_id = ?) return every charge in the chain.
    await client.query(
      `INSERT INTO payments (
         id,
         order_id,
         razorpay_subscription_id,
         razorpay_payment_id,
         amount,
         currency,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, 'INR', 'captured', NOW(), NOW())`,
      [
        randomUUID(),
        renewalOrderId,
        rzpSubscriptionId,
        rzpPaymentId || null,
        renewalSubtotal,
      ],
    );

    // ── 5d. Order status history ────────────────────────────────────────────
    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, NULL, 'confirmed', NULL, ?)`,
      [
        renewalOrderId,
        `Renewal order created from subscription.charged webhook (sub: ${rzpSubscriptionId})`,
      ],
    );

    // ── 5e. Update the ORIGINAL subscription order's next_billing_date ───────
    // The original order row is what the admin subscription-details page reads
    // for next billing info. Keep it in sync after each successful renewal.
    if (nextBillingDate) {
      await client.query(
        `UPDATE orders
         SET next_billing_date = ?,
             subscription_status = 'active',
             updated_at = NOW()
         WHERE id = ?`,
        [nextBillingDate, origin.id],
      );
    } else {
      await client.query(
        `UPDATE orders
         SET subscription_status = 'active',
             updated_at = NOW()
         WHERE id = ?`,
        [origin.id],
      );
    }

    await client.query("COMMIT");

    console.info("[RENEWAL] Renewal order committed", {
      renewalOrderId,
      renewalOrderNumber,
      originId: origin.id,
      originNumber: origin.order_number,
    });

    return { renewalOrderId, renewalOrderNumber };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[RENEWAL] Transaction rolled back", {
      rzpSubscriptionId,
      rzpPaymentId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    throw err;
  } finally {
    client.release();
  }
};
