// ─────────────────────────────────────────────────────────────────────────────
// packageFulfillmentService.js
//
// Recurring 30-day (or any configured interval) multi-cycle package
// fulfillment. A "package" is paid ONCE at checkout; BREE then ships one
// normal `orders` row per cycle automatically over time.
//
// DESIGN PRINCIPLES
// ─────────────────
// 1. Zero impact on normal products/orders: every function here is a no-op
//    unless the order actually contains a product with is_recurring_package
//    = 1. Nothing here runs in the hot path of a normal checkout.
//
// 2. Cycle 1 = the origin checkout order itself. It is tagged with
//    parent_package_id / fulfillment_cycle = 1, never duplicated — the
//    customer already has box #1 the moment payment clears, no 30-day wait.
//
// 3. Cycles 2..N are brand-new, completely ordinary `orders` rows (same
//    order_number sequence, status machine, Delhivery flow, tracking,
//    notifications, admin/customer Orders UI, and Task C's 48-hour return
//    window computed from THAT row's own delivered_at) — created by the
//    fulfillment cron, never by any customer-facing endpoint.
//
// 4. No re-charging: cycles 2..N never touch Razorpay. There is exactly one
//    real payment for the whole package (the origin order's), which is why
//    fulfillment orders never get a `payments` row of their own — the link
//    back to that one payment is package_purchases.origin_order_id.
//
// 5. Idempotent by construction: origin_order_id is UNIQUE on
//    package_purchases (a retried/duplicate verifyPayment call can never
//    create two packages for one order), and (parent_package_id,
//    fulfillment_cycle) is UNIQUE on orders (a retried/concurrent cron tick
//    can never create two orders for the same cycle). Both are enforced at
//    the DB layer, not just in application logic.
//
// 6. Fail-safe cycle advancement: cycles_created / next_fulfillment_date on
//    package_purchases are only updated AFTER the new order is committed.
//    If order creation fails (e.g. stock exhausted) the transaction rolls
//    back and package_purchases is left untouched — the next cron run will
//    simply retry, no cycle is silently skipped or double-counted.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { getClient, query } from "../config/database.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";
import { getNextPackageNumber } from "../utils/packageNumber.js";
import { sendOrderConfirmationEmail } from "./orderEmailService.js";
import {
  safelySendWhatsApp,
  sendOrderConfirmationWhatsApp,
} from "./whatsappNotificationService.js";

const isDuplicateKeyError = (err) =>
  err?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(err?.message || "");

/**
 * Called once, right after a checkout order is finalised (paymentController's
 * verifyPayment, post-commit). Detects whether the order contains a
 * recurring-package product and, if so, creates the parent package_purchases
 * record and tags the origin order as cycle 1.
 *
 * Deliberately fire-and-forget from the caller's perspective: any failure
 * here must never affect the customer's already-successful payment response.
 * Idempotent — safe to call more than once for the same order.
 *
 * @param {string} orderId
 * @returns {{ packageId: string, packageNumber: string, totalCycles: number } | null}
 */
export const createPackagePurchaseFromOrder = async (orderId) => {
  const { rows: existing } = await query(
    `SELECT id, package_number, total_cycles FROM package_purchases
     WHERE origin_order_id = ? LIMIT 1`,
    [orderId],
  );
  if (existing.length) {
    return {
      packageId: existing[0].id,
      packageNumber: existing[0].package_number,
      totalCycles: existing[0].total_cycles,
    };
  }

  const { rows: packageItems } = await query(
    `SELECT oi.product_id, oi.quantity,
            p.package_duration_months, p.package_fulfillment_interval_days
     FROM order_items oi
     INNER JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ? AND p.is_recurring_package = 1
     LIMIT 1`,
    [orderId],
  );

  if (!packageItems.length) return null;

  const item = packageItems[0];
  const totalCycles = Number(item.package_duration_months);
  const intervalDays = Number(item.package_fulfillment_interval_days) || 30;

  if (!Number.isInteger(totalCycles) || totalCycles < 1) {
    console.error(
      "[PACKAGE] Order contains a recurring-package product with an invalid duration — skipping package creation",
      { orderId, productId: item.product_id, totalCycles: item.package_duration_months },
    );
    return null;
  }

  if (item.quantity > 1) {
    console.warn(
      "[PACKAGE] Order line item quantity > 1 for a recurring-package product — package terms apply once per order, extra quantity is not decomposed into separate packages",
      { orderId, productId: item.product_id, quantity: item.quantity },
    );
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const packageId = randomUUID();
    const packageNumber = await getNextPackageNumber(client);
    const isSingleCycle = totalCycles <= 1;

    await client.query(
      `INSERT INTO package_purchases (
         id, package_number, user_id, product_id, origin_order_id,
         total_cycles, fulfillment_interval_days, cycles_created,
         next_fulfillment_date, status, created_at, updated_at
       ) VALUES (?, ?, (SELECT user_id FROM orders WHERE id = ?), ?, ?,
                 ?, ?, 1,
                 ${isSingleCycle ? "NULL" : "DATE_ADD(NOW(), INTERVAL ? DAY)"},
                 ?, NOW(), NOW())`,
      isSingleCycle
        ? [
            packageId,
            packageNumber,
            orderId,
            item.product_id,
            orderId,
            totalCycles,
            intervalDays,
            "completed",
          ]
        : [
            packageId,
            packageNumber,
            orderId,
            item.product_id,
            orderId,
            totalCycles,
            intervalDays,
            intervalDays,
            "active",
          ],
    );

    await client.query(
      `UPDATE orders SET parent_package_id = ?, fulfillment_cycle = 1, updated_at = NOW()
       WHERE id = ?`,
      [packageId, orderId],
    );

    await client.query("COMMIT");

    console.info("[PACKAGE] Package purchase created", {
      packageId,
      packageNumber,
      orderId,
      totalCycles,
      intervalDays,
    });

    return { packageId, packageNumber, totalCycles };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isDuplicateKeyError(err)) {
      const { rows: raced } = await query(
        `SELECT id, package_number, total_cycles FROM package_purchases
         WHERE origin_order_id = ? LIMIT 1`,
        [orderId],
      );
      if (raced.length) {
        return {
          packageId: raced[0].id,
          packageNumber: raced[0].package_number,
          totalCycles: raced[0].total_cycles,
        };
      }
    }
    console.error("[PACKAGE] Could not create package purchase", {
      orderId,
      message: err?.message || String(err),
    });
    return null;
  } finally {
    client.release();
  }
};

/**
 * Returns ids of active packages whose next cycle is due. Cheap, unlocked
 * scan — the actual creation below re-checks and locks per-package, so a
 * stale read here is harmless.
 */
const findDuePackageIds = async () => {
  const { rows } = await query(
    `SELECT id FROM package_purchases
     WHERE status = 'active'
       AND next_fulfillment_date IS NOT NULL
       AND next_fulfillment_date <= NOW()`,
  );
  return rows.map((r) => r.id);
};

/**
 * Creates the next fulfillment cycle order for one package, inside a locked
 * transaction. Safe against restarts, double-runs, and concurrent execution:
 * the row lock serializes concurrent attempts on the SAME package, and the
 * (parent_package_id, fulfillment_cycle) unique index on `orders` is the
 * hard backstop if two processes somehow race past the lock.
 *
 * @param {string} packageId
 */
export const fulfillNextCycle = async (packageId) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows: pkgRows } = await client.query(
      `SELECT * FROM package_purchases WHERE id = ? FOR UPDATE`,
      [packageId],
    );
    if (!pkgRows.length) {
      await client.query("ROLLBACK");
      return { created: false, reason: "not_found" };
    }
    const pkg = pkgRows[0];

    const isDue =
      pkg.status === "active" &&
      pkg.next_fulfillment_date &&
      new Date(pkg.next_fulfillment_date).getTime() <= Date.now() &&
      pkg.cycles_created < pkg.total_cycles;

    if (!isDue) {
      await client.query("ROLLBACK");
      return { created: false, reason: "not_due_or_already_handled" };
    }

    const { rows: originRows } = await client.query(
      `SELECT * FROM orders WHERE id = ?`,
      [pkg.origin_order_id],
    );
    if (!originRows.length) {
      await client.query("ROLLBACK");
      console.error("[PACKAGE_CRON] Origin order missing for package", {
        packageId,
        originOrderId: pkg.origin_order_id,
      });
      return { created: false, reason: "origin_order_missing" };
    }
    const origin = originRows[0];

    const { rows: originItems } = await client.query(
      `SELECT product_id, product_name, product_image, product_price, quantity, subtotal
       FROM order_items WHERE order_id = ?`,
      [origin.id],
    );
    if (!originItems.length) {
      await client.query("ROLLBACK");
      console.error("[PACKAGE_CRON] Origin order has no items — cannot fulfil cycle", {
        packageId,
        originOrderId: origin.id,
      });
      return { created: false, reason: "origin_has_no_items" };
    }

    const cycleSubtotal = originItems.reduce(
      (sum, i) => sum + Number(i.subtotal ?? i.product_price * i.quantity),
      0,
    );

    const newCycle = pkg.cycles_created + 1;
    const newOrderId = randomUUID();
    const newOrderNumber = await getNextOrderNumber(client);

    await client.query(
      `INSERT INTO orders (
         id, order_number, user_id, address_id,
         customer_name, email, mobile_number, shipping_address,
         contact_name, contact_email, contact_phone,
         subtotal, total, order_status, payment_status,
         parent_package_id, fulfillment_cycle,
         is_free_shipping, shipping_charge, estimated_delivery,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, 'paid', 'paid',
         ?, ?,
         ?, ?, ?,
         NOW(), NOW()
       )`,
      [
        newOrderId,
        newOrderNumber,
        origin.user_id,
        origin.address_id || null,
        origin.customer_name || origin.contact_name || null,
        origin.email || origin.contact_email || null,
        origin.mobile_number || origin.contact_phone || null,
        origin.shipping_address || null,
        origin.contact_name || origin.customer_name || null,
        origin.contact_email || origin.email || null,
        origin.contact_phone || origin.mobile_number || null,
        cycleSubtotal,
        cycleSubtotal,
        pkg.id,
        newCycle,
        origin.is_free_shipping ?? 0,
        origin.shipping_charge ?? 0,
        origin.estimated_delivery || null,
      ],
    );

    for (const item of originItems) {
      await client.query(
        `INSERT INTO order_items (
           id, order_id, product_id, product_name, product_image,
           product_price, quantity, subtotal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          newOrderId,
          item.product_id,
          item.product_name,
          item.product_image || null,
          Number(item.product_price),
          Number(item.quantity),
          Number(item.subtotal ?? item.product_price * item.quantity),
        ],
      );
    }

    // Stock deduction: this cycle is about to actually ship, so it deducts
    // real inventory now (same guarded pattern as paymentController's
    // verifyPayment) — unlike unrelated one-time-charge renewal orders,
    // there is no later "processing" transition this depends on.
    for (const item of originItems) {
      const stockResult = await client.query(
        `UPDATE products SET stock_qty = GREATEST(stock_qty - ?, 0)
         WHERE id = ? AND stock_qty >= ?`,
        [item.quantity, item.product_id, item.quantity],
      );
      if (!stockResult.affectedRows && !stockResult.rowCount) {
        await client.query("ROLLBACK");
        console.warn(
          "[PACKAGE_CRON] Insufficient stock for fulfillment cycle — will retry next run",
          { packageId, productId: item.product_id, cycle: newCycle },
        );
        return { created: false, reason: "insufficient_stock" };
      }
    }
    await client.query(
      `UPDATE orders SET stock_deducted = 1 WHERE id = ?`,
      [newOrderId],
    );

    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, NULL, 'paid', NULL, ?)`,
      [
        newOrderId,
        `Package fulfillment cycle ${newCycle}/${pkg.total_cycles} created (package ${pkg.package_number})`,
      ],
    );

    const isCompleted = newCycle >= pkg.total_cycles;
    await client.query(
      `UPDATE package_purchases
       SET cycles_created = ?,
           next_fulfillment_date = ${isCompleted ? "NULL" : "DATE_ADD(NOW(), INTERVAL fulfillment_interval_days DAY)"},
           status = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [newCycle, isCompleted ? "completed" : "active", pkg.id],
    );

    await client.query("COMMIT");

    console.info("[PACKAGE_CRON] Fulfillment cycle order created", {
      packageId,
      newOrderId,
      newOrderNumber,
      cycle: newCycle,
      totalCycles: pkg.total_cycles,
      completed: isCompleted,
    });

    return {
      created: true,
      orderId: newOrderId,
      orderNumber: newOrderNumber,
      cycle: newCycle,
      totalCycles: pkg.total_cycles,
      resolvedEmail: origin.email || origin.contact_email || null,
      resolvedName: origin.customer_name || origin.contact_name || null,
      resolvedPhone: origin.mobile_number || origin.contact_phone || null,
      resolvedAddress: origin.shipping_address || null,
      amount: cycleSubtotal,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isDuplicateKeyError(err)) {
      console.info(
        "[PACKAGE_CRON] Duplicate cycle detected (concurrent run) — treating as already created",
        { packageId },
      );
      return { created: false, reason: "duplicate_concurrent" };
    }
    console.error("[PACKAGE_CRON] Fulfillment cycle transaction rolled back", {
      packageId,
      message: err?.message || String(err),
      stack: err?.stack,
    });
    return { created: false, reason: "error", error: err?.message || String(err) };
  } finally {
    client.release();
  }
};

/**
 * Sends the same order-confirmation notifications a normal checkout order
 * gets (reused, not reinvented) for a newly created fulfillment order.
 * Fire-and-forget — never throws.
 */
const notifyFulfillmentOrderCreated = async (result) => {
  const { orderId, orderNumber, resolvedEmail, resolvedName, resolvedPhone, resolvedAddress, amount } = result;

  const { rows: itemRows } = await query(
    `SELECT product_name AS name, quantity, product_price AS price, subtotal
     FROM order_items WHERE order_id = ?`,
    [orderId],
  );

  if (resolvedEmail) {
    sendOrderConfirmationEmail({
      to: resolvedEmail,
      name: resolvedName,
      orderId,
      amount,
      items: itemRows,
      shippingAddress: resolvedAddress,
    }).catch((err) => {
      console.error("[PACKAGE_CRON] Confirmation email failed", {
        orderId,
        message: err?.message || String(err),
      });
    });
  }

  if (resolvedPhone) {
    await safelySendWhatsApp("Order Confirmed (package cycle)", () =>
      sendOrderConfirmationWhatsApp({
        mobile: resolvedPhone,
        customerName: resolvedName,
        orderNumber: orderNumber || orderId,
        orderAmount: amount,
        orderDate: new Date().toLocaleDateString("en-IN"),
        orderUuid: orderId,
      }),
    );
  }
};

/**
 * Entry point for the daily cron: fulfils every package whose next cycle is
 * due. Each package is isolated — one failure never blocks the others.
 */
export const runDuePackageFulfillments = async () => {
  const dueIds = await findDuePackageIds();
  if (!dueIds.length) return { processed: 0, created: 0 };

  console.info(`[PACKAGE_CRON] ${dueIds.length} package(s) due for fulfillment`);

  let created = 0;
  for (const packageId of dueIds) {
    try {
      const result = await fulfillNextCycle(packageId);
      if (result.created) {
        created += 1;
        await notifyFulfillmentOrderCreated(result);
      }
    } catch (err) {
      console.error("[PACKAGE_CRON] Unexpected error fulfilling package", {
        packageId,
        message: err?.message || String(err),
      });
    }
  }

  return { processed: dueIds.length, created };
};
