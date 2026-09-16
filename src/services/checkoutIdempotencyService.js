import { randomUUID } from "crypto";
import { query } from "../config/database.js";

// FIX (Phase 3B — Medium #6): checkout double-submit / duplicate-order
// protection.
//
// IDEMPOTENCY KEY: no client-generated idempotency key, cart/session id, or
// request id existed anywhere in the current checkout architecture before
// this fix (confirmed via full-repo grep) — so per the task's explicit
// instruction, the smallest appropriate mechanism is introduced here
// rather than repurposing something that already exists for a different
// purpose. A single client-generated UUID (`idempotency_key`), sent once
// per checkout attempt (see bree-frontend/src/pages/Checkout.js — the key
// is generated once per mount of the Checkout page and reused for every
// real order-creation network call within that mount, so a double-click or
// an automatic network retry of the exact same attempt shares it; a
// genuinely new checkout — a fresh page load — gets a fresh key).
// Deliberately NOT the customer's user_id (a customer must be able to
// place multiple separate orders) and NOT a hash of cart contents (two
// genuinely separate orders for the identical cart must both succeed).
//
// This field is OPTIONAL for backward compatibility with any caller this
// audit didn't find: if absent, createOrder proceeds exactly as before
// (unprotected) rather than rejecting the request — every caller this
// codebase actually ships (bree-frontend's Checkout.js) always sends one,
// so real production traffic is fully protected.
//
// STATE MACHINE: same processing/completed/failed shape as
// webhookIdempotencyService.js, with the same staleness-reclaim pattern
// already established in admin/returnController.js
// (PROCESSING_CLAIM_STALE_MINUTES) — a request that crashes after claiming
// but before finishing does not permanently block retries of the same key.

const PROCESSING_CLAIM_STALE_MINUTES = 2;

const isDuplicateKeyError = (err) =>
  err?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(err?.message || "");

/**
 * Atomically claims a checkout idempotency key.
 *
 * @returns {{ claimed: boolean, status: 'completed'|'processing'|'unknown', orderId?: string }}
 */
export const claimCheckoutIdempotencyKey = async ({
  idempotencyKey,
  userId = null,
  queryFn = query,
}) => {
  try {
    await queryFn(
      `INSERT INTO checkout_idempotency (id, idempotency_key, user_id, status)
       VALUES (?, ?, ?, 'processing')`,
      [randomUUID(), idempotencyKey, userId],
    );
    return { claimed: true, status: "processing" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;

    const { rows } = await queryFn(
      `SELECT status, order_id, updated_at FROM checkout_idempotency WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
    );
    const existing = rows[0];

    if (!existing) {
      // Vanishingly unlikely (row removed between the failed INSERT and
      // this SELECT) — fail safe by not claiming.
      return { claimed: false, status: "unknown" };
    }

    if (existing.status === "completed") {
      return { claimed: false, status: "completed", orderId: existing.order_id };
    }

    // A 'failed' claim, or a 'processing' claim stale enough to indicate
    // the original request crashed/died, is retryable. The staleness
    // condition is evaluated INSIDE the UPDATE's WHERE clause (not
    // pre-checked in JS) so two concurrent reclaim attempts can't both
    // "win" — only one UPDATE actually matches before the first winner's
    // own write moves updated_at forward.
    const retryClaim = await queryFn(
      `UPDATE checkout_idempotency
       SET status = 'processing', error_message = NULL, updated_at = NOW()
       WHERE idempotency_key = ?
         AND (status = 'failed' OR (status = 'processing' AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))`,
      [idempotencyKey, PROCESSING_CLAIM_STALE_MINUTES],
    );

    return { claimed: Boolean(retryClaim.rowCount), status: "processing" };
  }
};

export const markCheckoutIdempotencyCompleted = async ({
  idempotencyKey,
  orderId,
  razorpayOrderId,
  queryFn = query,
}) => {
  await queryFn(
    `UPDATE checkout_idempotency
     SET status = 'completed', order_id = ?, razorpay_order_id = ?, updated_at = NOW()
     WHERE idempotency_key = ?`,
    [orderId, razorpayOrderId, idempotencyKey],
  );
};

export const markCheckoutIdempotencyFailed = async ({
  idempotencyKey,
  errorMessage,
  queryFn = query,
}) => {
  await queryFn(
    `UPDATE checkout_idempotency SET status = 'failed', error_message = ?, updated_at = NOW() WHERE idempotency_key = ?`,
    [errorMessage ? String(errorMessage).slice(0, 1000) : null, idempotencyKey],
  );
};
