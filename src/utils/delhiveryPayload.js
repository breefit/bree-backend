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
    (sum, item) => sum + Number(item.weight || 0.5),
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

  return {
    shipments: [
      {
        name: shippingAddress.full_name,
        add: shippingAddress.address_line_1,
        add2: shippingAddress.address_line_2 || "",
        pin: shippingAddress.pincode,
        city: shippingAddress.city,
        state: shippingAddress.state,
        country: shippingAddress.country || "India",
        phone: shippingAddress.mobile,

        order: order.order_number,
        payment_mode: order.payment_method === "COD" ? "COD" : "Prepaid",

        return_pin: warehouse.pincode,
        return_city: warehouse.city,
        return_phone: warehouse.phone,
        return_add: warehouse.address,
        return_state: warehouse.state,
        return_country: warehouse.country || "India",

        products_desc: items.map((item) => item.product_name).join(", "),

        hsn_code: "",

        cod_amount:
          order.payment_method === "COD" ? Number(order.total_amount) : 0,

        order_date: new Date().toISOString(),

        total_amount: Number(order.total_amount),

        seller_add: warehouse.address,

        seller_name: warehouse.name,

        seller_inv: order.order_number,

        quantity: items.reduce((sum, item) => sum + Number(item.quantity), 0),

        waybill: "",

        shipment_width: totalBreadth,

        shipment_height: totalHeight,

        weight: totalWeight,

        seller_gst_tin: warehouse.gst || "",

        shipping_mode: "Surface",

        address_type: "home",

        shipment_length: totalLength,
      },
    ],
  };
};
