// backend/src/utils/delhiveryPayload.js

export const buildDelhiveryShipmentPayload = ({
  order,
  customer,
  shippingAddress,
  items,
  warehouse,
}) => {
  if (!order) throw new Error("Order is required");
  if (!shippingAddress) throw new Error("Shipping address is required");
  if (!items?.length) throw new Error("Order items are required");

  // ---------- Helpers ----------
  const cleanPhone = (phone = "") =>
    String(phone).replace(/^\+91/, "").replace(/^0/, "").replace(/\D/g, "");

  const getNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  // ---------- Package ----------
  const totalWeight = items.reduce(
    (sum, item) => sum + getNumber(item.weight, 0.5),
    0,
  );

  const totalLength = Math.max(
    ...items.map((item) => getNumber(item.length, 10)),
  );

  const totalBreadth = Math.max(
    ...items.map((item) => getNumber(item.breadth, 10)),
  );

  const totalHeight = items.reduce(
    (sum, item) => sum + getNumber(item.height, 5),
    0,
  );

  const totalQuantity = items.reduce(
    (sum, item) => sum + getNumber(item.quantity, 1),
    0,
  );

  const orderDate = order.created_at
    ? new Date(order.created_at).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  const shipment = {
    // -----------------------------
    // Customer
    // -----------------------------
    name: shippingAddress.full_name || customer?.name || "",

    add: shippingAddress.address_line_1 || "",

    add2: shippingAddress.address_line_2 || "",

    pin: String(shippingAddress.pincode || ""),

    city: shippingAddress.city || "",

    state: shippingAddress.state || "",

    country:
      shippingAddress.country === "IN"
        ? "India"
        : shippingAddress.country || "India",

    phone: cleanPhone(shippingAddress.mobile),

    // -----------------------------
    // Order
    // -----------------------------
    order: order.order_number,

    payment_mode: order.payment_method === "COD" ? "COD" : "Prepaid",

    order_date: orderDate,

    total_amount: getNumber(order.total_amount, 0),

    cod_amount:
      order.payment_method === "COD" ? getNumber(order.total_amount, 0) : 0,

    quantity: totalQuantity,

    products_desc: items.map((item) => item.product_name).join(", "),

    // -----------------------------
    // Seller
    // -----------------------------
    seller_name: warehouse.name,

    seller_add: warehouse.address,

    seller_inv: order.order_number,

    seller_gst_tin: warehouse.gst || "",

    // -----------------------------
    // Return
    // -----------------------------
    return_add: warehouse.address,

    return_city: warehouse.city,

    return_state: warehouse.state,

    return_pin: String(warehouse.pincode),

    return_country:
      warehouse.country === "IN" ? "India" : warehouse.country || "India",

    return_phone: cleanPhone(warehouse.phone),

    // -----------------------------
    // Package
    // -----------------------------
    shipment_length: totalLength,

    shipment_width: totalBreadth,

    shipment_height: totalHeight,

    weight: Number(totalWeight.toFixed(2)),

    shipping_mode: "Surface",

    address_type: "home",

    pickup_location: "BREE FIT",

    // -----------------------------
    // Invoice (recommended)
    // -----------------------------
    invoice_number: order.order_number,

    invoice_date: orderDate,

    invoice_amount: getNumber(order.total_amount, 0),

    declared_value: getNumber(order.total_amount, 0),
  };

  // Optional
  if (order.hsn_code?.trim()) {
    shipment.hsn_code = order.hsn_code;
  }

  if (order.waybill?.trim()) {
    shipment.waybill = order.waybill;
  }

  // ---------- Validation ----------
  const requiredFields = [
    "name",
    "add",
    "pin",
    "city",
    "state",
    "country",
    "phone",
    "order",
    "payment_mode",
    "order_date",
    "total_amount",
    "quantity",
    "seller_name",
    "seller_add",
    "return_add",
    "return_city",
    "return_state",
    "return_pin",
    "shipment_length",
    "shipment_width",
    "shipment_height",
    "weight",
    "pickup_location",
  ];

  for (const field of requiredFields) {
    const value = shipment[field];

    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value === "number" && Number.isNaN(value))
    ) {
      throw new Error(
        `Invalid Delhivery payload. Missing or invalid field: ${field}`,
      );
    }
  }

  const payload = {
    shipments: [shipment],
  };

  console.log(
    "\n========== DELHIVERY PAYLOAD ==========\n",
    JSON.stringify(payload, null, 2),
  );

  return payload;
};
