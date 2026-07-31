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

  const totalWeight = items.reduce(
    (sum, item) => sum + Number(item.weight || 1),
    0,
  );

  const totalLength = Math.max(
    ...items.map((item) => Number(item.length || 10)),
  );

  const totalBreadth = Math.max(
    ...items.map((item) => Number(item.breadth || 10)),
  );

  const totalHeight = items.reduce(
    (sum, item) => sum + Number(item.height || 5),
    0,
  );

  const shipment = {
    // Customer Details
    name: shippingAddress.full_name || customer?.name || "",
    add: shippingAddress.address_line_1,
    add2: shippingAddress.address_line_2 || "",
    pin: String(shippingAddress.pincode),
    city: shippingAddress.city,
    state: shippingAddress.state,
    country:
      shippingAddress.country === "IN"
        ? "India"
        : shippingAddress.country || "India",

    phone: String(shippingAddress.mobile || "")
      .replace(/^\+91/, "")
      .replace(/\s+/g, ""),

    // Order Details
    order: order.order_number,
    payment_mode: order.payment_method === "COD" ? "COD" : "Prepaid",

    order_date: new Date().toISOString().split("T")[0],

    total_amount: Number(order.total_amount),

    cod_amount: order.payment_method === "COD" ? Number(order.total_amount) : 0,

    quantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),

    products_desc: items.map((item) => item.product_name).join(", "),

    // Warehouse / Return Address
    seller_name: warehouse.name,
    seller_add: warehouse.address,
    seller_inv: order.order_number,

    return_add: warehouse.address,
    return_city: warehouse.city,
    return_state: warehouse.state,
    return_pin: String(warehouse.pincode),
    return_country:
      warehouse.country === "IN" ? "India" : warehouse.country || "India",

    return_phone: String(warehouse.phone || "")
      .replace(/^\+91/, "")
      .replace(/\s+/g, ""),

    // Package Dimensions
    shipment_length: Number(totalLength),
    shipment_width: Number(totalBreadth),
    shipment_height: Number(totalHeight),
    weight: Number(totalWeight),

    shipping_mode: "Surface",
    address_type: "home",
  };

  // Optional fields (only send if available)
  if (warehouse.gst?.trim()) {
    shipment.seller_gst_tin = warehouse.gst;
  }

  if (order.hsn_code?.trim()) {
    shipment.hsn_code = order.hsn_code;
  }

  if (order.waybill?.trim()) {
    shipment.waybill = order.waybill;
  }

  return {
    shipments: [shipment],
  };
};
