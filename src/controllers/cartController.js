import { query } from "../config/database.js";

// POST /api/orders/validate-cart
// Body: { items: [{ id, price, quantity }] }
//
// Product visibility: a product the admin hid (is_visible = 0) is reported
// exactly like a deactivated one — `available: false` — so the existing
// cart UI flags it "Unavailable" and checkout blocks it. The customer's
// cart item is NOT deleted server-side (the cart lives in the browser);
// the customer removes it. No field distinguishes hidden from deleted.
// `queryFn` injectable only for tests (default to the real pool).
export const validateCart = async (req, res, { queryFn = query } = {}) => {
  try {
    const items = req.body.items || req.body.cartItems || [];
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    const results = [];
    let anyChange = false;

    for (const it of items) {
      const productId = it.id || it.product_id;
      const requestedQty = Number(it.quantity || 0);
      const clientPrice = Number(it.price ?? it.unit_price ?? 0);

      const { rows } = await queryFn(
        `SELECT id, name, image, price AS price, is_active, is_visible,
                is_free_shipping, shipping_charge, estimated_delivery
         FROM products
         WHERE id = ?
         LIMIT 1`,
        [productId],
      );

      if (!rows.length) {
        results.push({
          id: productId,
          available: false,
          reason: "deleted",
        });
        anyChange = true;
        continue;
      }

      const p = rows[0];
      const available = !!p.is_active && !!p.is_visible;
      const currentPrice = Number(p.price ?? 0);
      const isFreeShipping =
        p.is_free_shipping === true ||
        p.is_free_shipping === 1 ||
        p.is_free_shipping === "true" ||
        p.is_free_shipping === "1";
      const parsedShippingCharge = Number(p.shipping_charge ?? 0);
      const shippingCharge = Number.isFinite(parsedShippingCharge)
        ? Math.max(0, parsedShippingCharge)
        : 0;
      const estimatedDelivery =
        String(p.estimated_delivery || "").trim() || null;

      const priceChanged = Math.abs(currentPrice - clientPrice) > 0.009;

      if (priceChanged) anyChange = true;

      results.push({
        id: productId,
        name: p.name,
        image: p.image || null,
        available,
        requestedQty,
        currentPrice,
        clientPrice,
        priceChanged,
        is_free_shipping: isFreeShipping,
        shipping_charge: shippingCharge,
        estimated_delivery: estimatedDelivery,
        isFreeShipping,
        shippingCharge,
        estimatedDelivery,
      });
    }

    return res.json({ success: true, anyChange, items: results });
  } catch (err) {
    console.error("Error validating cart:", err);
    return res.status(500).json({ message: "Failed to validate cart" });
  }
};

export default { validateCart };
