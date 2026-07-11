import { query, getClient } from "../config/database.js";
import delhiveryService from "../services/delhiveryService.js";
import {
  sendShipmentCreatedEmail,
  sendShipmentCancelledEmail,
} from "../services/orderEmailService.js";
import { buildDelhiveryShipmentPayload } from "../utils/delhiveryPayload.js";
import { appendStatusHistory } from "../models/Order.js";

// ─────────────────────────────────────────────────────────────────────────────
// Get warehouse configuration from environment variables
// ─────────────────────────────────────────────────────────────────────────────
const getWarehouseConfig = () => {
  return {
    name: process.env.WAREHOUSE_NAME || "BREE Warehouse",
    address: process.env.WAREHOUSE_ADDRESS || "",
    city: process.env.WAREHOUSE_CITY || "",
    state: process.env.WAREHOUSE_STATE || "",
    pincode: process.env.WAREHOUSE_PINCODE || "",
    country: process.env.WAREHOUSE_COUNTRY || "India",
    phone: process.env.WAREHOUSE_PHONE || "",
    gst: process.env.WAREHOUSE_GST || "",
  };
};

// ===== Delhivery Pickup Integration =====
// ─────────────────────────────────────────────────────────────────────────────
// Build the pickup request payload for delhiveryService.requestPickup().
// Uses the same warehouse config as shipment creation, plus sensible
// defaults for pickup scheduling fields, all overridable via req.body.
// ─────────────────────────────────────────────────────────────────────────────
const getDefaultPickupDate = () => {
  // Defaults to today's date (server local time) in YYYY-MM-DD format.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const buildPickupRequestPayload = (
  warehouse,
  overrides = {},
  expectedPackageCount = 1,
) => {
  return {
    pickup_location: warehouse.name,
    expected_package_count:
      overrides.expected_package_count || expectedPackageCount || 1,
    pickup_date: overrides.pickup_date || getDefaultPickupDate(),
    pickup_time:
      overrides.pickup_time || process.env.DELHIVERY_PICKUP_TIME || "14:00:00",
  };
};
// ===== End Delhivery Pickup Integration =====

// ===== Modified =====
// ─────────────────────────────────────────────────────────────────────────────
// Returns the base URL used to build Delhivery tracking links.
// Configurable via DELHIVERY_TRACKING_URL; falls back to the existing
// hardcoded URL if the env variable is missing, so behaviour is unchanged
// for deployments that don't set it.
// ─────────────────────────────────────────────────────────────────────────────
const getTrackingBaseUrl = () => {
  return (
    process.env.DELHIVERY_TRACKING_URL ||
    "https://tracking.delhivery.com/track/shipment/"
  );
};
// ===== End Modified =====

// ===== Modified =====
// ─────────────────────────────────────────────────────────────────────────────
// Robust Delhivery shipment-response parser.
// Delhivery's API is inconsistent across environments/versions — it may
// return shipments under `shipments[]`, `packages[]`, nested under
// `data.shipments[]` / `data.packages[]`, or occasionally as a bare object
// with `waybill`/`shipment_id`/`id` at the top level. This function checks
// every known shape safely, never assumes structure, and never throws —
// it returns a { success, message } error object instead of crashing.
// ─────────────────────────────────────────────────────────────────────────────
const extractDelhiveryShipmentDetails = (delhiveryResponse) => {
  if (!delhiveryResponse || typeof delhiveryResponse !== "object") {
    return {
      success: false,
      message: "Empty or invalid response received from Delhivery",
    };
  }

  const candidates = [];

  if (Array.isArray(delhiveryResponse.shipments)) {
    candidates.push(...delhiveryResponse.shipments);
  }

  if (Array.isArray(delhiveryResponse.packages)) {
    candidates.push(...delhiveryResponse.packages);
  }

  if (delhiveryResponse.data && typeof delhiveryResponse.data === "object") {
    if (Array.isArray(delhiveryResponse.data.shipments)) {
      candidates.push(...delhiveryResponse.data.shipments);
    }
    if (Array.isArray(delhiveryResponse.data.packages)) {
      candidates.push(...delhiveryResponse.data.packages);
    }
  }

  // Fallback: the response itself may be a bare shipment object
  // (no shipments[]/packages[] wrapper).
  if (
    !candidates.length &&
    (delhiveryResponse.waybill ||
      delhiveryResponse.shipment_id ||
      delhiveryResponse.id)
  ) {
    candidates.push(delhiveryResponse);
  }

  const shipmentData = candidates.find(
    (entry) => entry && typeof entry === "object",
  );

  if (!shipmentData) {
    return {
      success: false,
      message:
        "Could not locate shipment data in Delhivery response (checked shipments[], packages[], data.shipments[], data.packages[])",
    };
  }

  const awbNumber =
    shipmentData.waybill || shipmentData.awb || shipmentData.AWB || null;
  const shipmentId = shipmentData.shipment_id || shipmentData.id || null;
  const trackingNumber = awbNumber; // AWB doubles as tracking number
  const trackingUrl = awbNumber ? `${getTrackingBaseUrl()}${awbNumber}` : null;

  if (!awbNumber) {
    return {
      success: false,
      message: "Delhivery response did not include an AWB/waybill number",
    };
  }

  return {
    success: true,
    awbNumber,
    shipmentId,
    trackingNumber,
    trackingUrl,
  };
};
// ===== End Modified =====

// ===== Modified =====
// ─────────────────────────────────────────────────────────────────────────────
// Delhivery tracking-status → internal order_status mapping.
// Expanded to cover the common Delhivery lifecycle statuses. Keys are
// lowercase since lookups go through normalizeTrackingStatus() first, so
// matching is case-insensitive and whitespace-safe.
//
// Mapping rationale for non-obvious cases:
//  - "pending", "pickup scheduled", "not picked", "pickup pending",
//    "manifested", "bagged", "dispatched", "in transit",
//    "reached destination hub", "undelivered" all keep the order at
//    "shipped" — these are pre-delivery/in-progress states, not final.
//  - "lost" maps to "cancelled" — the shipment will never be delivered and
//    there is no dedicated "lost" order_status in the current schema.
//  - "damaged" maps to "returned" — damaged shipments are typically routed
//    back to origin, consistent with RTO handling.
// Unknown/unrecognized statuses simply return null (no transition), so the
// application never crashes on an unexpected Delhivery status string.
// ─────────────────────────────────────────────────────────────────────────────
const DELHIVERY_STATUS_TO_ORDER_STATUS = {
  pending: "shipped",
  "pickup scheduled": "shipped",
  "not picked": "shipped",
  "pickup pending": "shipped",
  manifested: "shipped",
  bagged: "shipped",
  dispatched: "shipped",
  "in transit": "shipped",
  "reached destination hub": "shipped",
  undelivered: "shipped",
  "out for delivery": "out_for_delivery",
  delivered: "delivered",
  cancelled: "cancelled",
  "shipment cancelled": "cancelled",
  lost: "cancelled",
  returned: "returned",
  rto: "returned",
  damaged: "returned",
};

// Normalizes a raw Delhivery status string for safe, case-insensitive,
// whitespace-tolerant lookups.
export const normalizeTrackingStatus = (status) => {
  if (!status || typeof status !== "string") return "";
  return status.trim().toLowerCase();
};

export const mapTrackingStatusToOrderStatus = (trackingStatus) => {
  const normalized = normalizeTrackingStatus(trackingStatus);
  if (!normalized) return null;
  return DELHIVERY_STATUS_TO_ORDER_STATUS[normalized] || null;
};
// ===== End Modified =====

// ===== Modified =====
// ─────────────────────────────────────────────────────────────────────────────
// Robust Delhivery tracking-response parser.
// Supports ShipmentData[0].Shipment, Shipment, data.ShipmentData,
// packages[], data.packages[] shapes via optional chaining, and now also
// extracts scanHistory, lastScan, remarks, statusCode, and shipmentId when
// available, checking multiple known field-name variants for each. Never
// throws.
// ─────────────────────────────────────────────────────────────────────────────
export const extractDelhiveryTrackingDetails = (trackingResponse) => {
  if (!trackingResponse || typeof trackingResponse !== "object") {
    return {
      success: false,
      message: "Empty or invalid tracking response received from Delhivery",
    };
  }

  const shipment =
    trackingResponse?.ShipmentData?.[0]?.Shipment ||
    trackingResponse?.Shipment ||
    trackingResponse?.data?.ShipmentData?.[0]?.Shipment ||
    trackingResponse?.data?.Shipment ||
    trackingResponse?.packages?.[0] ||
    trackingResponse?.data?.packages?.[0] ||
    null;

  if (!shipment || typeof shipment !== "object") {
    return {
      success: false,
      message:
        "Could not locate shipment data in Delhivery tracking response (checked ShipmentData[0].Shipment, Shipment, data.ShipmentData, packages[], data.packages[])",
    };
  }

  const rawStatus =
    shipment?.Status?.Status ||
    shipment?.status?.status ||
    shipment?.status ||
    null;

  if (!rawStatus) {
    return {
      success: false,
      message: "Delhivery tracking response did not include a status",
    };
  }

  const currentLocation =
    shipment?.Status?.StatusLocation || shipment?.status?.location || null;
  const lastUpdate =
    shipment?.Status?.StatusDateTime || shipment?.status?.date || null;
  const expectedDelivery =
    shipment?.ExpectedDeliveryDate || shipment?.expected_delivery_date || null;

  // ── Scan history, last scan, remarks, status code ──────────────────────
  const scanHistory =
    shipment?.Scans ||
    shipment?.ScanDetail ||
    shipment?.scan_detail ||
    shipment?.scans ||
    null;

  const lastScan =
    Array.isArray(scanHistory) && scanHistory.length
      ? scanHistory[scanHistory.length - 1]
      : null;

  const remarks =
    shipment?.Status?.Instructions ||
    shipment?.status?.instructions ||
    shipment?.remarks ||
    shipment?.Remark ||
    null;

  const statusCode =
    shipment?.Status?.StatusCode ||
    shipment?.status?.status_code ||
    shipment?.StatusCode ||
    null;

  // shipmentId, checking multiple known field-name variants. Never throws
  // if none are present — returns null like every other field here.
  const shipmentId =
    shipment?.ShipmentId ||
    shipment?.shipment_id ||
    shipment?.ShipmentID ||
    shipment?.Id ||
    shipment?.id ||
    null;

  return {
    success: true,
    trackingStatus: String(rawStatus).trim(),
    currentLocation: currentLocation || null,
    lastUpdate: lastUpdate || null,
    expectedDelivery: expectedDelivery || null,
    scanHistory: scanHistory || null,
    lastScan: lastScan || null,
    remarks: remarks || null,
    statusCode: statusCode || null,
    shipmentId: shipmentId || null,
  };
};
// ===== End Modified =====

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/create-shipment/:orderId
//
// Creates a Delhivery shipment for an order in "ready_to_ship" status.
// Extracts AWB, shipment ID, tracking number, and tracking URL from the
// Delhivery API response and updates the order with these values.
// Transitions order status from "ready_to_ship" → "shipped".
// ─────────────────────────────────────────────────────────────────────────────
export const createShipment = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      message: "Order ID is required",
    });
  }

  const client = await getClient();

  try {
    await client.query("BEGIN");

    // ── 1. Fetch the order ───────────────────────────────────────────────────
    const { rows: orderRows } = await client.query(
      `SELECT id, user_id, address_id, order_number, order_status, payment_status,
              contact_name, contact_email, contact_phone, shipping_address,
              subtotal, total, payment_method
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [orderId],
    );

    if (!orderRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = orderRows[0];

    // ── 2. Validate order status is "ready_to_ship" ──────────────────────────
    if (order.order_status !== "ready_to_ship") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Order cannot be shipped. Current status is "${order.order_status}". Expected "ready_to_ship".`,
      });
    }

    // ── 3. Fetch shipping address ────────────────────────────────────────────
    let shippingAddress = null;

    // Try fetching from user_addresses first
    if (order.address_id) {
      const { rows: userAddressRows } = await client.query(
        `SELECT id, full_name, phone, address_line_1, address_line_2, city, state, pincode, country
         FROM user_addresses
         WHERE id = ?
         LIMIT 1`,
        [order.address_id],
      );

      if (userAddressRows.length) {
        shippingAddress = {
          full_name: userAddressRows[0].full_name,
          mobile: userAddressRows[0].phone,
          address_line_1: userAddressRows[0].address_line_1,
          address_line_2: userAddressRows[0].address_line_2,
          city: userAddressRows[0].city,
          state: userAddressRows[0].state,
          pincode: userAddressRows[0].pincode,
          country: userAddressRows[0].country || "India",
        };
      } else {
        // Fall back to legacy addresses table
        const { rows: legacyAddressRows } = await client.query(
          `SELECT id, label, address_line1, address_line2, city, state, pincode, country
           FROM addresses
           WHERE id = ?
           LIMIT 1`,
          [order.address_id],
        );

        if (legacyAddressRows.length) {
          shippingAddress = {
            full_name: legacyAddressRows[0].label,
            mobile: order.contact_phone || "",
            address_line_1: legacyAddressRows[0].address_line1,
            address_line_2: legacyAddressRows[0].address_line2,
            city: legacyAddressRows[0].city,
            state: legacyAddressRows[0].state,
            pincode: legacyAddressRows[0].pincode,
            country: legacyAddressRows[0].country || "India",
          };
        }
      }
    }

    // Fall back to stored shipping_address snapshot if address lookup fails
    if (!shippingAddress && order.shipping_address) {
      // Parse the snapshot format (comma-separated values)
      // This is a last resort — the snapshot doesn't have pincode/city/state separately
      shippingAddress = {
        full_name: order.contact_name || "",
        mobile: order.contact_phone || "",
        address_line_1: order.shipping_address,
        address_line_2: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      };
    }

    if (!shippingAddress) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Shipping address not found for this order",
      });
    }

    // ── 4. Fetch order items ─────────────────────────────────────────────────
    const { rows: items } = await client.query(
      `SELECT id, product_id, product_name, product_price, quantity
       FROM order_items
       WHERE order_id = ?`,
      [orderId],
    );

    if (!items.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "No items found for this order",
      });
    }

    // ── 5. Build Delhivery shipment payload ──────────────────────────────────
    const warehouse = getWarehouseConfig();
    const customer = {
      name: order.contact_name || "",
      email: order.contact_email || "",
      phone: order.contact_phone || "",
    };

    let payload;
    try {
      payload = buildDelhiveryShipmentPayload({
        order,
        customer,
        shippingAddress,
        items,
        warehouse,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Failed to build shipment payload: ${error.message}`,
      });
    }

    // ── 6. Call Delhivery API to create shipment ─────────────────────────────
    let delhiveryResponse;
    try {
      delhiveryResponse = await delhiveryService.createShipment(payload);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[CREATE_SHIPMENT] Delhivery API error", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create shipment with Delhivery",
        error: error.message || error,
      });
    }

    // Check if Delhivery response indicates success
    if (!delhiveryResponse || delhiveryResponse.success === false) {
      await client.query("ROLLBACK");
      console.warn(
        "[CREATE_SHIPMENT] Delhivery returned error",
        delhiveryResponse,
      );
      return res.status(400).json({
        success: false,
        message:
          delhiveryResponse?.message || "Delhivery API returned an error",
        delhiveryError: delhiveryResponse,
      });
    }

    // ── 7. Extract tracking information from response ────────────────────────
    const parsedShipment = extractDelhiveryShipmentDetails(delhiveryResponse);

    if (!parsedShipment.success) {
      await client.query("ROLLBACK");
      console.warn(
        "[CREATE_SHIPMENT] Failed to parse Delhivery shipment response",
        { message: parsedShipment.message, delhiveryResponse },
      );
      return res.status(400).json({
        success: false,
        message: parsedShipment.message,
        delhiveryResponse,
      });
    }

    const { awbNumber, shipmentId, trackingNumber, trackingUrl } =
      parsedShipment;

    // ── 8. Update orders table with shipment tracking data ────────────────────
    const updateColumns = ["order_status = ?"];
    const updateParams = ["shipped"];

    if (awbNumber) {
      updateColumns.push("awb_number = ?");
      updateParams.push(awbNumber);
    }

    if (shipmentId) {
      updateColumns.push("shipment_id = ?");
      updateParams.push(shipmentId);
    }

    if (trackingNumber) {
      updateColumns.push("tracking_number = ?");
      updateParams.push(trackingNumber);
    }

    if (trackingUrl) {
      updateColumns.push("tracking_url = ?");
      updateParams.push(trackingUrl);
    }

    updateColumns.push("tracking_status = ?");
    updateParams.push("Manifested");

    updateColumns.push("courier_name = ?");
    updateParams.push("Delhivery");

    updateColumns.push("shipment_created_at = NOW()");

    updateColumns.push("delhivery_response = ?");
    updateParams.push(JSON.stringify(delhiveryResponse));

    updateColumns.push("updated_at = NOW()");
    updateParams.push(orderId);

    await client.query(
      `UPDATE orders SET ${updateColumns.join(", ")} WHERE id = ?`,
      updateParams,
    );

    // ── 9. Record status transition in order_status_history ──────────────────
    await appendStatusHistory({
      orderId,
      previousStatus: "ready_to_ship",
      newStatus: "shipped",
      changedBy: null,
      notes: `Shipment created with Delhivery. AWB: ${awbNumber}`,
    });

    // ── 10. Fetch updated order ──────────────────────────────────────────────
    const { rows: updatedOrderRows } = await client.query(
      `SELECT id, order_number, order_status, tracking_status,
              awb_number, tracking_number, tracking_url,
              contact_name, contact_email
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [orderId],
    );

    await client.query("COMMIT");

    const updatedOrder = updatedOrderRows[0];

    try {
      await sendShipmentCreatedEmail({
        to: updatedOrder?.contact_email,
        name: updatedOrder?.contact_name,
        orderId: updatedOrder?.id,
        awbNumber,
        trackingUrl: updatedOrder?.tracking_url || trackingUrl,
        courier: "Delhivery",
      });
    } catch (emailError) {
      console.error(
        "[CREATE_SHIPMENT] Failed to send shipment created email",
        emailError,
      );
    }

    // ── 11. Return success response ──────────────────────────────────────────
    res.status(200).json({
      success: true,
      message: "Shipment created successfully",
      order: {
        id: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        status: updatedOrder.order_status,
        trackingStatus: updatedOrder.tracking_status,
        awbNumber: updatedOrder.awb_number,
        trackingNumber: updatedOrder.tracking_number,
        trackingUrl: updatedOrder.tracking_url,
      },
      delhivery: {
        awb: awbNumber,
        shipmentId,
        trackingUrl,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE_SHIPMENT] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.message || error,
    });
  } finally {
    client.release();
  }
};

// ===== Delhivery Pickup Integration =====
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/pickup/:orderId
//
// Schedules a Delhivery pickup for an order that already has a shipment
// created (AWB present) but no pickup request yet. Uses the configured
// warehouse as the pickup location. Optional overrides for
// expected_package_count, pickup_date, pickup_time can be passed in req.body.
// ─────────────────────────────────────────────────────────────────────────────
export const schedulePickup = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      message: "Order ID is required",
    });
  }

  const client = await getClient();

  try {
    await client.query("BEGIN");

    // ── 1. Fetch the order ───────────────────────────────────────────────────
    const { rows: orderRows } = await client.query(
      `SELECT id, order_number, order_status, tracking_status,
              awb_number, shipment_id, pickup_request_id, shipment_created_at
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [orderId],
    );

    if (!orderRows.length) {
      await client.query("ROLLBACK");
      console.warn(`[SCHEDULE_PICKUP] Order not found: ${orderId}`);
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = orderRows[0];

    // ── 2. Validate AWB exists (shipment already created) ───────────────────
    if (!order.awb_number || !order.shipment_id) {
      await client.query("ROLLBACK");
      console.warn(
        `[SCHEDULE_PICKUP] No AWB/shipment found for order ${orderId}`,
      );
      return res.status(400).json({
        success: false,
        message: "Shipment has not been created for this order yet",
      });
    }

    // ── 3. Validate pickup_request_id is empty ───────────────────────────────
    if (order.pickup_request_id) {
      await client.query("ROLLBACK");
      console.warn(
        `[SCHEDULE_PICKUP] Pickup already scheduled for order ${orderId}: ${order.pickup_request_id}`,
      );
      return res.status(400).json({
        success: false,
        message: "Pickup has already been scheduled for this order",
        pickupRequestId: order.pickup_request_id,
      });
    }

    // ── 4. Validate order status is "shipped" ────────────────────────────────
    if (order.order_status !== "shipped") {
      await client.query("ROLLBACK");
      console.warn(
        `[SCHEDULE_PICKUP] Invalid order status for pickup: ${order.order_status}`,
      );
      return res.status(400).json({
        success: false,
        message: `Pickup cannot be scheduled. Current status is "${order.order_status}". Expected "shipped".`,
      });
    }

    // ── 5. Determine expected package count ───────────────────────────────────
    // No dedicated package-count/box-count table or column exists in the
    // current schema (order_items only tracks product quantity). Reusing
    // SUM(quantity) remains the correct source of truth.
    const { rows: itemCountRows } = await client.query(
      `SELECT COALESCE(SUM(quantity), 1) AS total_quantity
       FROM order_items
       WHERE order_id = ?`,
      [orderId],
    );
    const expectedPackageCount = Number(itemCountRows[0]?.total_quantity) || 1;

    // ── 6. Build pickup payload using warehouse config ───────────────────────
    const warehouse = getWarehouseConfig();
    const pickupPayload = buildPickupRequestPayload(
      warehouse,
      {
        expected_package_count: req.body?.expected_package_count,
        pickup_date: req.body?.pickup_date,
        pickup_time: req.body?.pickup_time,
      },
      expectedPackageCount,
    );

    console.log(
      `[SCHEDULE_PICKUP] Requesting pickup for order ${orderId} with metadata:`,
      {
        pickup_location: pickupPayload.pickup_location,
        expected_package_count: pickupPayload.expected_package_count,
        pickup_date: pickupPayload.pickup_date,
        pickup_time: pickupPayload.pickup_time,
      },
    );

    // ── 7. Call Delhivery API to request pickup ──────────────────────────────
    let pickupResponse;
    try {
      pickupResponse = await delhiveryService.requestPickup(pickupPayload);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[SCHEDULE_PICKUP] Delhivery API error", error);
      return res.status(500).json({
        success: false,
        message: "Failed to schedule pickup with Delhivery",
        error: error.message || error,
      });
    }

    if (!pickupResponse || pickupResponse.success === false) {
      await client.query("ROLLBACK");
      console.warn(
        "[SCHEDULE_PICKUP] Delhivery returned error",
        pickupResponse,
      );
      return res.status(400).json({
        success: false,
        message: pickupResponse?.message || "Delhivery API returned an error",
        delhiveryError: pickupResponse,
      });
    }

    // ── 8. Extract pickup_request_id from response ───────────────────────────
    // Checks request_id, pickup_request_ids[], and their data.-nested
    // variants, in addition to the previously supported keys.
    // First valid (truthy) value found wins.
    const pickupRequestId =
      pickupResponse.pickup_id ||
      pickupResponse.request_id ||
      pickupResponse.pickup_request_id ||
      pickupResponse.pickup_request_ids?.[0] ||
      pickupResponse.data?.pickup_id ||
      pickupResponse.data?.request_id ||
      pickupResponse.data?.pickup_request_id ||
      pickupResponse.data?.pickup_request_ids?.[0] ||
      null;

    if (!pickupRequestId) {
      await client.query("ROLLBACK");
      console.warn(
        "[SCHEDULE_PICKUP] No pickup_request_id returned from Delhivery",
        pickupResponse,
      );
      return res.status(400).json({
        success: false,
        message: "Delhivery response did not include a pickup request ID",
        delhiveryResponse: pickupResponse,
      });
    }

    // ── 9. Update orders table ────────────────────────────────────────────────
    const updateColumns = [
      "pickup_request_id = ?",
      "tracking_status = ?",
      "delhivery_response = ?",
      "updated_at = NOW()",
    ];
    const updateParams = [
      pickupRequestId,
      "Pickup Scheduled",
      JSON.stringify(pickupResponse),
    ];

    if (!order.shipment_created_at) {
      updateColumns.splice(3, 0, "shipment_created_at = NOW()");
    }

    updateParams.push(orderId);

    await client.query(
      `UPDATE orders SET ${updateColumns.join(", ")} WHERE id = ?`,
      updateParams,
    );

    // ── 10. Record status transition ─────────────────────────────────────────
    await appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: null,
      notes: `Pickup scheduled with Delhivery. Pickup Request ID: ${pickupRequestId}`,
    });

    await client.query("COMMIT");

    // ── 11. Return success response ──────────────────────────────────────────
    console.log(
      `[SCHEDULE_PICKUP] Pickup scheduled successfully for order ${orderId}: ${pickupRequestId}`,
    );

    res.status(200).json({
      success: true,
      message: "Pickup scheduled successfully",
      order: {
        id: order.id,
        orderNumber: order.order_number,
        pickupRequestId,
        trackingStatus: "Pickup Scheduled",
      },
      delhivery: {
        pickupRequestId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[SCHEDULE_PICKUP] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Failed to schedule pickup",
      error: error.message || error,
    });
  } finally {
    client.release();
  }
};
// ===== End Delhivery Pickup Integration =====

// ===== Modified =====
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/track/:awb
//
// Fetches live tracking data from Delhivery for the given AWB and syncs
// tracking_status back onto the corresponding order.
//
// DB writes are gated strictly on tracking_status having changed
// (case/whitespace-insensitive compare) — if Delhivery returns the same
// status as last time, no UPDATE runs and no status-history row is
// created. When tracking_status *has* changed, order_status is
// transitioned too if the new tracking status maps to a different
// internal status, and that transition is what gets recorded in
// order_status_history.
//
// current_location / last_tracking_update / expected_delivery_date have
// no corresponding columns in the current schema, so they are returned in
// the response only and never persisted. Add those columns first if you
// want them written to the DB.
// ─────────────────────────────────────────────────────────────────────────────
export const trackShipment = async (req, res) => {
  const { awb } = req.params;

  if (!awb) {
    return res.status(400).json({
      success: false,
      message: "AWB is required",
    });
  }

  const startTime = Date.now();
  const client = await getClient();

  try {
    await client.query("BEGIN");

    // ── 1. Fetch the order by AWB ────────────────────────────────────────────
    const { rows: orderRows } = await client.query(
      `SELECT id, order_number, order_status, awb_number, tracking_status,
              tracking_url, courier_name, shipment_id
       FROM orders
       WHERE awb_number = ?
       LIMIT 1`,
      [awb],
    );

    if (!orderRows.length) {
      await client.query("ROLLBACK");
      console.warn(`[TRACK_SHIPMENT] AWB: ${awb} | Not Found`);
      return res.status(404).json({
        success: false,
        message: "No order found for this AWB",
      });
    }

    const order = orderRows[0];

    // ── 2. Call Delhivery tracking API ───────────────────────────────────────
    let trackingResponse;
    try {
      trackingResponse = await delhiveryService.trackShipment(awb);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(
        `[TRACK_SHIPMENT] AWB: ${awb} | Delhivery API Error`,
        error,
      );
      return res.status(502).json({
        success: false,
        message: "Failed to fetch tracking data from Delhivery",
        error: error.message || error,
      });
    }

    // ── 3. Parse tracking response safely (never throws) ─────────────────────
    const parsedTracking = extractDelhiveryTrackingDetails(trackingResponse);

    if (!parsedTracking.success) {
      await client.query("ROLLBACK");
      console.warn(
        `[TRACK_SHIPMENT] AWB: ${awb} | Unparseable Delhivery Response | ${parsedTracking.message}`,
      );
      return res.status(502).json({
        success: false,
        message: parsedTracking.message,
      });
    }

    // Normalize status (already trimmed by the parser); fall back to the
    // existing DB value if Delhivery somehow returns an empty string.
    const trackingStatus =
      parsedTracking.trackingStatus || order.tracking_status;
    const {
      currentLocation,
      lastUpdate,
      expectedDelivery,
      scanHistory,
      lastScan,
      remarks,
      statusCode,
      shipmentId,
    } = parsedTracking;

    // ── 4. Only touch the DB if tracking_status actually changed ─────────────
    // Comparison is normalized (case/whitespace-insensitive) so re-fetching
    // an identical status in a different casing doesn't trigger a write.
    const trackingStatusChanged =
      normalizeTrackingStatus(trackingStatus) !==
      normalizeTrackingStatus(order.tracking_status);

    let mappedOrderStatus = null;
    let shouldTransitionOrderStatus = false;

    if (trackingStatusChanged) {
      mappedOrderStatus = mapTrackingStatusToOrderStatus(trackingStatus);
      shouldTransitionOrderStatus =
        Boolean(mappedOrderStatus) && mappedOrderStatus !== order.order_status;

      const updateColumns = [
        "tracking_status = ?",
        "delhivery_response = ?",
        "updated_at = NOW()",
      ];
      const updateParams = [trackingStatus, JSON.stringify(trackingResponse)];

      if (shouldTransitionOrderStatus) {
        updateColumns.push("order_status = ?");
        updateParams.push(mappedOrderStatus);
      }

      updateParams.push(order.id);

      await client.query(
        `UPDATE orders SET ${updateColumns.join(", ")} WHERE id = ?`,
        updateParams,
      );

      // ── 5. Append status history only when order_status actually changed ──
      if (shouldTransitionOrderStatus) {
        await appendStatusHistory({
          orderId: order.id,
          previousStatus: order.order_status,
          newStatus: mappedOrderStatus,
          changedBy: null,
          notes: `Order status auto-synced from Delhivery tracking status "${trackingStatus}" for AWB ${awb}`,
        });
      }
    }

    await client.query("COMMIT");

    // ── 6. Logging — AWB, tracking status, location, execution time, and
    //      whether anything changed. No customer PII is ever logged here. ──
    const executionTimeMs = Date.now() - startTime;
    console.log(
      `[TRACK_SHIPMENT] AWB: ${awb} | Tracking Status: ${trackingStatus} | Current Location: ${
        currentLocation || "-"
      } | ${trackingStatusChanged ? "Status Changed" : "No Status Change"} | Execution Time (ms): ${executionTimeMs}`,
    );

    // ── 7. Return tracking response ───────────────────────────────────────────
    res.status(200).json({
      success: true,
      message: "Tracking data fetched successfully",
      order: {
        id: order.id,
        orderNumber: order.order_number,
        awbNumber: order.awb_number,
        status: shouldTransitionOrderStatus
          ? mappedOrderStatus
          : order.order_status,
      },
      tracking: {
        trackingStatus,
        currentLocation: currentLocation || null,
        lastUpdate: lastUpdate || null,
        expectedDelivery: expectedDelivery || null,
        awbNumber: order.awb_number || null,
        courierName: order.courier_name || "Delhivery",
        trackingUrl:
          order.tracking_url ||
          (order.awb_number
            ? `${getTrackingBaseUrl()}${order.awb_number}`
            : null),
        shipmentId: shipmentId || order.shipment_id || null,
        scanHistory: scanHistory || null,
        lastScan: lastScan || null,
        remarks: remarks || null,
        statusCode: statusCode || null,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`[TRACK_SHIPMENT] AWB: ${awb} | Unexpected error`, error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tracking data",
      error: error.message || error,
    });
  } finally {
    client.release();
  }
};
// ===== End Modified =====

// ===== Delhivery Pickup Integration =====
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/cancel/:orderId
//
// Cancels a Delhivery shipment for an order, provided it has an AWB and
// has not already been delivered.
// ─────────────────────────────────────────────────────────────────────────────
export const cancelShipment = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      message: "Order ID is required",
    });
  }

  const client = await getClient();

  try {
    await client.query("BEGIN");

    // ── 1. Fetch the order ───────────────────────────────────────────────────
    const { rows: orderRows } = await client.query(
      `SELECT id, order_number, order_status, tracking_status, awb_number,
              contact_name, contact_email
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [orderId],
    );

    if (!orderRows.length) {
      await client.query("ROLLBACK");
      console.warn(`[CANCEL_SHIPMENT] Order not found: ${orderId}`);
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = orderRows[0];

    // ── 2. Validate AWB exists ────────────────────────────────────────────────
    if (!order.awb_number) {
      await client.query("ROLLBACK");
      console.warn(`[CANCEL_SHIPMENT] No AWB found for order ${orderId}`);
      return res.status(400).json({
        success: false,
        message: "No shipment exists for this order to cancel",
      });
    }

    // ── 3. Validate shipment not already delivered ────────────────────────────
    if (order.tracking_status === "Delivered") {
      await client.query("ROLLBACK");
      console.warn(
        `[CANCEL_SHIPMENT] Cannot cancel delivered shipment for order ${orderId}`,
      );
      return res.status(400).json({
        success: false,
        message: "Shipment has already been delivered and cannot be cancelled",
      });
    }

    if (order.tracking_status === "Cancelled") {
      await client.query("ROLLBACK");
      console.warn(
        `[CANCEL_SHIPMENT] Shipment already cancelled for order ${orderId}`,
      );
      return res.status(400).json({
        success: false,
        message: "Shipment has already been cancelled",
      });
    }

    // ── 4. Call Delhivery API to cancel shipment ──────────────────────────────
    let cancelResponse;
    try {
      cancelResponse = await delhiveryService.cancelShipment(order.awb_number);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[CANCEL_SHIPMENT] Delhivery API error", error);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel shipment with Delhivery",
        error: error.message || error,
      });
    }

    if (!cancelResponse || cancelResponse.success === false) {
      await client.query("ROLLBACK");
      console.warn(
        "[CANCEL_SHIPMENT] Delhivery returned error",
        cancelResponse,
      );
      return res.status(400).json({
        success: false,
        message: cancelResponse?.message || "Delhivery API returned an error",
        delhiveryError: cancelResponse,
      });
    }

    // ── 5. Update orders table ────────────────────────────────────────────────
    await client.query(
      `UPDATE orders
       SET tracking_status = ?,
           delhivery_response = ?,
           updated_at = NOW()
       WHERE id = ?`,
      ["Cancelled", JSON.stringify(cancelResponse), orderId],
    );

    // ── 6. Record status transition ──────────────────────────────────────────
    await appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: null,
      notes: `Shipment cancelled with Delhivery. AWB: ${order.awb_number}`,
    });

    await client.query("COMMIT");

    try {
      await sendShipmentCancelledEmail({
        to: order.contact_email,
        name: order.contact_name,
        orderId: order.id,
      });
    } catch (emailError) {
      console.error(
        "[CANCEL_SHIPMENT] Failed to send shipment cancelled email",
        emailError,
      );
    }

    // ── 7. Return success response ───────────────────────────────────────────
    console.log(
      `[CANCEL_SHIPMENT] Shipment cancelled successfully for order ${orderId}`,
    );

    res.status(200).json({
      success: true,
      message: "Shipment cancelled successfully",
      order: {
        id: order.id,
        orderNumber: order.order_number,
        awbNumber: order.awb_number,
        trackingStatus: "Cancelled",
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CANCEL_SHIPMENT] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Failed to cancel shipment",
      error: error.message || error,
    });
  } finally {
    client.release();
  }
};
// ===== End Delhivery Pickup Integration =====

// ===== Delhivery Pickup Integration =====
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/label/:awb
//
// Streams the Delhivery shipping label (PDF) for the given AWB back to
// the client with the correct download headers.
// ─────────────────────────────────────────────────────────────────────────────
export const downloadShippingLabel = async (req, res) => {
  const { awb } = req.params;

  if (!awb) {
    return res.status(400).json({
      success: false,
      message: "AWB is required",
    });
  }

  try {
    console.log(`[DOWNLOAD_LABEL] Fetching shipping label for AWB ${awb}`);

    let labelBuffer;
    try {
      labelBuffer = await delhiveryService.getShippingLabel(awb);
    } catch (error) {
      console.error("[DOWNLOAD_LABEL] Delhivery API error", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch shipping label from Delhivery",
        error: error.message || error,
      });
    }

    if (!labelBuffer) {
      console.warn(`[DOWNLOAD_LABEL] Empty label response for AWB ${awb}`);
      return res.status(404).json({
        success: false,
        message: "Shipping label not found for this AWB",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="label-${awb}.pdf"`,
    );

    console.log(`[DOWNLOAD_LABEL] Label served successfully for AWB ${awb}`);

    return res.status(200).send(Buffer.from(labelBuffer));
  } catch (error) {
    console.error("[DOWNLOAD_LABEL] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Failed to download shipping label",
      error: error.message || error,
    });
  }
};
// ===== End Delhivery Pickup Integration =====

export default {
  createShipment,
  schedulePickup,
  trackShipment,
  cancelShipment,
  downloadShippingLabel,
};
