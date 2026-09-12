import { Router } from "express";
import {
  getProducts,
  getProduct,
  getHomeProducts,
  getRecommendations,
} from "../controllers/productController.js";
import {
  getMyOrders,
  getOrder,
  getOrderSuccess,
  getOrderTracking,
  getOrderLiveTracking,
  getOrderHistory,
  createOrder as createOrderCheckout,
  updatePaymentStatus,
} from "../controllers/orderController.js";
import { validateCart } from "../controllers/cartController.js";
import {
  createOrder,
  verifyPayment,
  getShippingInfo,
  getPromotions,
  applyPromotions,
  handleWebhook,
  getPaymentStatus,
} from "../controllers/paymentController.js";
import {
  createSubscription,
  getMySubscriptions,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
} from "../controllers/subscriptionController.js";
import {
  getProfile,
  updateProfile,
  changePassword,
} from "../controllers/profileController.js";
import {
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefault,
} from "../controllers/addressController.js";
import { submitInquiry } from "../controllers/contactController.js";
import {
  getTestimonials,
  submitTestimonial,
} from "../controllers/testimonialController.js";
import shippingRouter from "./shippingRoutes.js";
import auth from "../middleware/auth.js";
import { optionalAuth } from "../middleware/auth.js";

// ── Products (public) ─────────────────────────────────────────────────────────
export const productRouter = Router();
productRouter.get("/", getProducts);
productRouter.get("/home", getHomeProducts);
productRouter.get("/:id/recommendations", getRecommendations);
productRouter.get("/:id", getProduct);

// ── Orders & Checkout (authenticated) ─────────────────────────────────────────
export const orderRouter = Router();
// Tracking and history endpoints must come before generic /:id route to avoid route conflicts
// FIX (public tracking): the customer tracking page (/order/:id/tracking) must
// load for LOGGED-OUT users — the tracking link in shipping emails is opened
// in incognito/new browsers where no session exists. The page previously
// fired this request with `auth`, got a hard 401, and the axios 401 handler
// classified it as session expiry → /api/auth/verify refresh → auth:expired
// → 429 storms. Switched to optionalAuth, exactly like GET /:id below: the
// SQL's `user_id = ? OR user_id IS NULL` clause is unchanged, so orders that
// belong to a real user are still only visible WITH that user's valid
// session — only guest orders (user_id IS NULL) and the requester's own
// orders resolve. No auth bypass for private data.
orderRouter.get("/:id/tracking", optionalAuth, getOrderTracking);
// FIX (public tracking): lightweight DB-snapshot live-tracking poll endpoint.
// Returns tracking_status/current_location/etc. straight from the orders row
// (kept fresh by the Delhivery tracking cron) instead of the admin-only
// /api/shipping/track/:awb (adminAuth) that the page used to poll every 30s —
// for a logged-out customer that endpoint 401'd on every poll.
orderRouter.get("/:id/live-tracking", optionalAuth, getOrderLiveTracking);
orderRouter.get("/:id/history", auth, getOrderHistory);
orderRouter.get("/", auth, getMyOrders);
orderRouter.get("/:id/success", auth, getOrderSuccess);
// FIX (audit Section 2 / Fix 1): switched from `auth` to `optionalAuth`.
// CheckoutSuccess.js calls this endpoint right after payment for BOTH
// logged-in users and guest checkouts, and Magic Checkout's popup can stay
// open up to `timeout: 900` (15 min), so a session cookie can legitimately
// expire mid-checkout. `auth` returned a hard 401 in both cases even though
// getOrder's own SQL (`user_id = ? OR user_id IS NULL`) already supports
// guest orders. optionalAuth populates req.user when a valid session exists
// and simply proceeds as unauthenticated otherwise — security is unchanged
// because the SQL's `user_id = ?` clause still only matches when the
// authenticated user owns the order; non-guest orders remain inaccessible
// without a valid session.
orderRouter.get("/:id", optionalAuth, getOrder);
// Checkout flow endpoints
orderRouter.post("/validate-cart", optionalAuth, validateCart);
orderRouter.post("/create", auth, createOrderCheckout);
orderRouter.put("/:id/payment-status", auth, updatePaymentStatus);

// ── Payment ───────────────────────────────────────────────────────────────────
export const paymentRouter = Router();
// Webhook must use raw body — mount before express.json() in app, handled here as JSON since we JSON.stringify in verify
paymentRouter.post("/webhook", handleWebhook);
paymentRouter.get("/status/:paymentId", optionalAuth, getPaymentStatus);
paymentRouter.post("/create-order", optionalAuth, createOrder);
paymentRouter.post("/shipping-info", optionalAuth, getShippingInfo);
paymentRouter.post("/promotions", optionalAuth, getPromotions);
paymentRouter.post("/apply-promotions", optionalAuth, applyPromotions);
paymentRouter.post("/verify", optionalAuth, verifyPayment);

// ── Subscriptions (authenticated) ──────────────────────────────────────────────
export const subscriptionRouter = Router();
subscriptionRouter.post("/create", auth, createSubscription);
subscriptionRouter.get("/my", auth, getMySubscriptions);
subscriptionRouter.post("/:id/cancel", auth, cancelSubscription);
subscriptionRouter.post("/:id/pause", auth, pauseSubscription);
subscriptionRouter.post("/:id/resume", auth, resumeSubscription);

// ── Profile (authenticated) ───────────────────────────────────────────────────
export const profileRouter = Router();
profileRouter.get("/", auth, getProfile);
profileRouter.put("/", auth, updateProfile);
profileRouter.put("/password", auth, changePassword);

// ── Addresses (authenticated) ─────────────────────────────────────────────────
export const addressRouter = Router();
addressRouter.get("/", auth, getAddresses);
addressRouter.post("/", auth, addAddress);
addressRouter.put("/:id", auth, updateAddress);
addressRouter.delete("/:id", auth, deleteAddress);
addressRouter.put("/:id/default", auth, setDefault);

// ── Contact (public) ──────────────────────────────────────────────────────────
export const contactRouter = Router();
contactRouter.post("/", submitInquiry);

// ── Testimonials (public get, auth optional for submit) ───────────────────────
export const testimonialRouter = Router();
testimonialRouter.get("/", getTestimonials);
testimonialRouter.post("/", optionalAuth, submitTestimonial);

// ── Shipping (authenticated) ──────────────────────────────────────────────────
export { shippingRouter };
