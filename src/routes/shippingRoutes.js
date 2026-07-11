import { Router } from "express";
import {
  createShipment,
  schedulePickup,
  trackShipment,
  cancelShipment,
  downloadShippingLabel,
} from "../controllers/shippingController.js";
import adminAuth from "../middleware/adminAuth.js";

const shippingRouter = Router();

// ── POST /api/shipping/create-shipment/:orderId
// Creates a new Delhivery shipment for an order in "ready_to_ship" status
shippingRouter.post("/create-shipment/:orderId", adminAuth, createShipment);

// ── POST /api/shipping/pickup/:orderId
// Request a pickup from Delhivery for a shipment already created for this order
shippingRouter.post("/pickup/:orderId", adminAuth, schedulePickup);

// ── GET /api/shipping/track/:awb
// Track shipment by AWB number
// NOTE: trackShipment() in shippingController.js does not perform its own
// authentication, so adminAuth is applied here.
shippingRouter.get("/track/:awb", adminAuth, trackShipment);

// ── POST /api/shipping/cancel/:orderId
// Cancel a shipment
shippingRouter.post("/cancel/:orderId", adminAuth, cancelShipment);

// ── GET /api/shipping/label/:awb
// Download shipping label for a shipment
shippingRouter.get("/label/:awb", adminAuth, downloadShippingLabel);

export default shippingRouter;
