import { query } from "../config/database.js";

// POST /api/cart/validate
// Body: { items: [{ id, price, quantity }] }
export const validateCart = async (req, res) => {
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

      const { rows } = await query(
        `SELECT id, name, image, price AS price, stock_qty, is_active, status,
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
      const available = !!p.is_active && p.status === "In Stock";
      const stock = Number(p.stock_qty ?? 0);
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
      const outOfStock = !available;
      const insufficientStock = stock < requestedQty;

      if (priceChanged || outOfStock || insufficientStock) anyChange = true;

      results.push({
        id: productId,
        name: p.name,
        image: p.image || null,
        available,
        stock,
        requestedQty,
        currentPrice,
        clientPrice,
        priceChanged,
        outOfStock,
        insufficientStock,
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
