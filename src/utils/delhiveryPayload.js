// backend/src/utils/delhiveryPayload.js

import { resolveShipmentWeight } from "./shippingWeight.js";

export const buildDelhiveryShipmentPayload = ({
  order,
  customer,
  shippingAddress,
  items,
  warehouse,
  bottleWeightKg,
}) => {
  if (!order) throw new Error("Order is required");
  if (!shippingAddress) throw new Error("Shipping address is required");
  if (!items?.length) throw new Error("Order items are required");
  if (!warehouse?.pickupLocation?.trim()) {
    throw new Error(
      "DELHIVERY_PICKUP_LOCATION is missing. Configure the exact pickup location registered in Delhivery.",
    );
  }

  // ---------- Helpers ----------
  const cleanPhone = (phone = "") =>
    String(phone).replace(/^\+91/, "").replace(/^0/, "").replace(/\D/g, "");

  const getNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  // Delhivery expects shipment weight in grams. Bottle volume is fixed at
  // 50 ml, but it is not a weight measurement.
  const shippingWeight = resolveShipmentWeight({
    order,
    items,
    ...(bottleWeightKg === undefined ? {} : { bottleWeightKg }),
  });

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

  const orderDateBase = order.created_at
    ? new Date(order.created_at)
    : new Date();

  const orderDateObj = Number.isFinite(orderDateBase.getTime())
    ? orderDateBase
    : new Date();

  const orderDate = orderDateObj.toISOString().replace(/\.\d{3}Z$/, ".000000");

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

    waybill: "",

    payment_mode: order.payment_method === "COD" ? "COD" : "Prepaid",

    order_date: orderDate,

    total_amount: getNumber(order.total_amount, 0),

    cod_amount: String(
      order.payment_method === "COD" ? getNumber(order.total_amount, 0) : 0,
    ),

    quantity: String(shippingWeight.bottleCount),

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

    weight: shippingWeight.totalWeightGrams,

    shipping_mode: "Surface",

    address_type: "home",

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
    pickup_location: {
      name: warehouse.pickupLocation,
    },
  };

  // console.log(
  //   "\n========== DELHIVERY PAYLOAD ==========\n",
  //   JSON.stringify(payload, null, 2),
  // );

  return payload;
};

// ─────────────────────────────────────────────────────────────────────────────
// Reverse pickup (return) shipment — Delhivery "RVP"
// ─────────────────────────────────────────────────────────────────────────────
// FIX (return shipment was a BREE → BREE forward shipment): returns used to
// be built with buildDelhiveryShipmentPayload() plus swapped address roles —
// consignee = BREE warehouse, pickup_location = BREE's registered
// warehouse, payment_mode "Prepaid", customer only in seller_/return_
// fields. To Delhivery that is an ordinary forward parcel from BREE's
// warehouse to BREE's warehouse; no courier is ever sent to the customer.
//
// Delhivery's documented reverse-flow contract (Package Order Creation API,
// https://delhivery-express-api-doc.readme.io/reference/order-creation-api):
//   - "Order creation for reverse flow (customer to client warehouse)"
//   - "payment_mode= Pickup (whereas it is prepaid and COD for forwarding
//     shipment)"
//   - "If you are passing the return keys then shipment will be delivered
//     to return address. If you are not passing the return keys then
//     shipment will be delivered to the warehouse address."
//   - pickup_location "needs to be exactly the same as the name of the
//     warehouse registered"
//   - "Order ID should be unique for every new order manifested in our
//     system" (when Delhivery generates the waybill)
// and its FAQ: "Reverse shipment will be scheduled automatically so there
// is no requirement to create pickup requests for those."
//
// So: consignee fields (name/add/pin/city/state/phone) = the CUSTOMER (the
// pickup point, where the courier goes), payment_mode = "Pickup",
// cod_amount 0, pickup_location = BREE's registered warehouse and the
// return_* keys = BREE's warehouse (both resolve to BREE, the
// destination), and a reverse-specific order reference so it never
// collides with the forward shipment's order id.
//
// NEEDS SANDBOX/ACCOUNT CONFIRMATION (not stated verbatim in the docs):
// that the consignee fields are read as the pickup address for
// payment_mode "Pickup" (the docs imply it — "shipment needs to be pick
// from the customer" + consignee "name, phone and address" are mandatory),
// and that reverse pickups are enabled on BREE's Delhivery account.
export const REVERSE_SHIPMENT_REFERENCE_SUFFIX = "-RETURN";

export const buildReverseShipmentReference = (orderNumber) =>
  `${String(orderNumber || "").trim()}${REVERSE_SHIPMENT_REFERENCE_SUFFIX}`;

export const buildDelhiveryReverseShipmentPayload = ({
  order,
  customerAddress,
  items,
  warehouse,
  bottleWeightKg,
}) => {
  if (!order?.order_number) throw new Error("Order number is required");
  if (!customerAddress) throw new Error("Customer pickup address is required");

  const reference = buildReverseShipmentReference(order.order_number);

  // Reuse the forward builder for everything that is genuinely shared
  // (weight, dimensions, dates, invoice, validation, seller/return =
  // BREE warehouse, pickup_location = BREE's registered warehouse), with
  // the customer as the consignee.
  const payload = buildDelhiveryShipmentPayload({
    order: { ...order, payment_method: "Prepaid" },
    customer: {
      name: customerAddress.full_name,
      phone: customerAddress.mobile,
    },
    shippingAddress: customerAddress,
    items,
    warehouse,
    ...(bottleWeightKg === undefined ? {} : { bottleWeightKg }),
  });

  const [shipment] = payload.shipments;
  shipment.payment_mode = "Pickup";
  shipment.cod_amount = "0";
  shipment.order = reference;
  // A reverse pickup never carries a pre-assigned forward waybill.
  shipment.waybill = "";

  return { payload, reference };
};
