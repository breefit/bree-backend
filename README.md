# BREE Wellness — Backend

Node.js/Express REST API for the BREE Wellness D2C e‑commerce platform, backed by MySQL.

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Technology Stack](#2-technology-stack)
- [3. Backend Project Structure](#3-backend-project-structure)
- [4. Server Architecture](#4-server-architecture)
- [5. Environment Variables](#5-environment-variables)
- [6. Database](#6-database)
- [7. Authentication](#7-authentication)
- [8. API Routes](#8-api-routes)
- [9. Product API](#9-product-api)
- [10. Normal Order Flow](#10-normal-order-flow)
- [11. Razorpay](#11-razorpay)
- [12. Bulk Order System](#12-bulk-order-system)
- [13. Bulk Order Address Model](#13-bulk-order-address-model)
- [14. Magic Checkout](#14-magic-checkout)
- [15. Subscription System](#15-subscription-system)
- [16. Recurring Package System](#16-recurring-package-system)
- [17. Package Fulfillment Cron](#17-package-fulfillment-cron)
- [18. Package Idempotency](#18-package-idempotency)
- [19. Shipping / Delhivery](#19-shipping--delhivery)
- [20. Order Status System](#20-order-status-system)
- [21. Return System](#21-return-system)
- [22. 48-Hour Return Window](#22-48-hour-return-window)
- [23. Return Inspection](#23-return-inspection)
- [24. Razorpay Refunds](#24-razorpay-refunds)
- [25. Notifications](#25-notifications)
- [26. Admin API](#26-admin-api)
- [27. Error Handling](#27-error-handling)
- [28. Transactions & Data Safety](#28-transactions--data-safety)
- [29. Cron Jobs](#29-cron-jobs)
- [30. Development Setup](#30-development-setup)
- [31. Database Initialization / Migrations](#31-database-initialization--migrations)
- [32. Third-Party Services](#32-third-party-services)
- [33. Security](#33-security)
- [34. Deployment](#34-deployment)
- [35. API Flow Diagrams](#35-api-flow-diagrams)
- [36. Troubleshooting](#36-troubleshooting)
- [37. Important Business Rules](#37-important-business-rules)
- [38. Current Project Status](#38-current-project-status)

---

## 1. Project Overview

This is the backend API/server for **BREE Wellness**, a Direct-to-Consumer wellness e-commerce platform. It is a single Express application (MySQL-backed) responsible for:

- Authentication (mobile OTP, Google/Firebase, admin email+password)
- Users, profiles, and addresses
- Products, including subscription and recurring-package product types
- Orders, cart validation, and checkout
- Payments via Razorpay (Standard Checkout, Magic Checkout, Subscriptions)
- Subscriptions (recurring billing, pause/resume/cancel)
- Recurring package fulfillment (one payment, multiple automatically-created shipping cycles)
- Bulk Orders — enquiry, admin quotation, quote approval, and Razorpay Magic Checkout payment
- Shipping via Delhivery — shipment creation, tracking, pickup, labels, cancellation
- Order tracking and status history
- Returns, reverse shipments, product inspection, and refunds
- Email notifications (Nodemailer/SMTP)
- WhatsApp notifications (Waplify)
- Admin APIs for orders, products, bulk bookings, customers, subscriptions, testimonials, and contact inquiries
- Idempotent database migrations that run automatically at startup
- Scheduled/cron jobs for shipment tracking sync, recurring package fulfillment, and OTP cleanup

---

## 2. Technology Stack

Versions below are taken directly from `package.json`. Node.js is an **ES Module** project (`"type": "module"`).

| Package | Version | Purpose |
|---|---|---|
| `express` | ^5.1.0 | HTTP server / routing |
| `mysql2` | ^3.4.4 | MySQL driver (`mysql2/promise`, connection pool) |
| `jsonwebtoken` | ^9.0.2 | Customer + admin JWT signing/verification |
| `bcryptjs` | ^3.0.3 | Password/OTP hashing |
| `razorpay` | ^2.9.6 | Razorpay Orders/Payments/Subscriptions/Refunds SDK |
| `firebase-admin` | ^11.11.1 | Verifying Google Sign-In ID tokens server-side |
| `cloudinary` + `multer-storage-cloudinary` + `multer` | ^1.41.3 / ^4.0.0 / ^2.0.0 | Product image upload and storage |
| `nodemailer` | ^6.9.9 | SMTP email sending |
| `axios` | ^1.6.2 | Outbound HTTP calls (Delhivery, Waplify WhatsApp API) |
| `node-cron` | ^4.6.0 | Scheduled jobs (package fulfillment, shipment tracking sync, OTP cleanup) |
| `socket.io` | ^4.8.3 | Real-time `order:updated` / `product:*` events to the frontend |
| `helmet` | ^7.1.0 | HTTP security headers |
| `cors` | ^2.8.5 | Cross-origin request handling |
| `cookie-parser` | ^1.4.7 | Reading/writing auth cookies |
| `express-rate-limit` | ^7.1.5 | Rate limiting (general API, auth, admin login, payment) |
| `express-validator` | ^7.0.1 | Request body validation (auth routes) |
| `morgan` | ^1.10.0 | HTTP request logging |
| `dotenv` | ^17.4.2 | `.env` loading |
| `nodemon` (dev) | ^3.1.10 | Auto-restart in development |

**WhatsApp**: there is no dedicated WhatsApp SDK — outbound messages are sent via `axios` HTTP calls to the **Waplify** API. A Meta WhatsApp Cloud API webhook receiver also exists (`/api/webhooks/meta`) for inbound Meta events, and a narrow Meta-based OTP sender (`whatsappService.js`) exists alongside it — see [§25](#25-notifications) for how these fit together.

**Delhivery**: no SDK — `axios` calls to the Delhivery HTTP API (base URL/token from environment).

Node engine (from `package.json` → `engines`): Node `20.x`, npm `>=10.0.0`.

---

## 3. Backend Project Structure

```
bree-backend/
├── src/
│   ├── config/
│   │   ├── database.js         # MySQL pool, query()/getClient() helpers, ALL startup migrations
│   │   ├── razorpay.js         # Singleton Razorpay client (getRazorpay())
│   │   ├── firebaseAdmin.js    # Firebase Admin SDK init (Google ID token verification)
│   │   └── cloudinary.js       # Cloudinary config + multer upload middleware
│   ├── constants/
│   │   └── orderStatus.js      # Canonical order status list, labels, email-subject map
│   ├── controllers/
│   │   ├── authController.js, profileController.js, addressController.js
│   │   ├── productController.js, cartController.js, orderController.js
│   │   ├── paymentController.js, subscriptionController.js
│   │   ├── bulkController.js, shippingController.js
│   │   ├── contactController.js, testimonialController.js, webhookController.js
│   │   └── admin/               # Admin-only controllers (see §26)
│   ├── middleware/
│   │   ├── auth.js              # Customer JWT middleware (`auth`, `optionalAuth`)
│   │   ├── adminAuth.js         # Admin JWT middleware
│   │   └── errorHandler.js      # Centralized error → HTTP response mapping
│   ├── models/
│   │   └── Order.js             # order_status_history read/write helpers
│   ├── routes/
│   │   ├── index.js             # Public/customer routers (products, orders, payment, subscriptions, profile, addresses, contact, testimonials)
│   │   ├── auth.js, bulkRoutes.js, shippingRoutes.js, webhookRoutes.js
│   │   └── admin/index.js       # All admin routes (orders, returns/refunds, products, bulk bookings, subscriptions, customers, inquiries, testimonials)
│   ├── services/
│   │   ├── authService.js       # Refresh-token persistence
│   │   ├── bulkOrderService.js, bulkNotificationService.js
│   │   ├── delhiveryService.js  # Delhivery API client
│   │   ├── email.js, orderEmailService.js       # Nodemailer senders
│   │   ├── whatsappService.js, whatsappNotificationService.js  # Waplify WhatsApp clients
│   │   ├── packageFulfillmentService.js  # Recurring package cycle creation
│   │   ├── renewalService.js    # Subscription renewal order creation
│   │   ├── testimonialService.js
│   │   └── otpCleanupJob.js
│   ├── utils/
│   │   ├── jwt.js               # Token sign/verify, cookie names/options
│   │   ├── razorpay.js          # Payment/webhook signature verification
│   │   ├── orderNumber.js, bulkBookingNumber.js, packageNumber.js  # Atomic counter-backed number generators
│   │   ├── customerNumber.js, bulkCommunicationLog.js, cache.js
│   │   ├── delhiveryPayload.js  # Delhivery shipment payload builder
│   │   └── orderSchema.js
│   ├── app.js                   # Express app: security, CORS, body parsing, rate limits, route mounting
│   └── server.js                # Entry point: loads env, starts HTTP+Socket.IO server, starts cron jobs
├── cron/
│   ├── packageFulfillmentCron.js   # Daily recurring-package cycle creation
│   └── shippingTrackingCron.js     # Periodic Delhivery tracking sync
├── migrations/
│   ├── mysql-migrate.js, migrate.js, seed.js, populate_recommendations.sql
├── tests/
│   └── orderStatus.test.js
├── loader.cjs                   # Thin CJS entry that dynamically imports src/server.js
├── mysql-schema.sql             # Reference schema dump
└── package.json
```

---

## 4. Server Architecture

Standard layered request flow:

```
Frontend
  → Express route (src/routes/*)
  → Middleware (rate limiter → auth/adminAuth → express-validator, where applicable)
  → Controller (src/controllers/*) — request/response shape, validation, orchestration
  → Service (src/services/*) — reusable business logic (email, WhatsApp, Delhivery, package fulfillment, etc.)
  → Database (src/config/database.js: query()/getClient()) and/or external API (Razorpay, Delhivery, Waplify, Firebase)
  → Response (JSON)
```

- **`app.js`** wires global concerns once: Helmet security headers, CORS (origin allow-list from `FRONTEND_URL` + localhost, with Razorpay origins always allowed for its checkout iframe/webhooks), raw-body parsing specifically for `/api/payment/webhook` (needed for signature verification), JSON/urlencoded body parsing for everything else, cookie parsing, a general 200 req/min rate limiter on all `/api` routes, a stricter 20/15min limiter on auth-sensitive routes and on the two mutating payment endpoints, then mounts every router, a `/health` endpoint, a 404 handler, and the global error handler last.
- **`server.js`** is the actual process entry point (`node src/server.js` / `nodemon src/server.js`): it loads `.env`, dynamically imports `app.js` and `database.js`, verifies the DB connection (`SELECT 1`) before starting any cron job, wraps the Express app in a raw `http.Server` (so Socket.IO can share the same port), creates the Socket.IO server (`app.locals.io`, used by controllers to emit `order:updated`/`product:*` events), and starts the shipment-tracking cron, package-fulfillment cron, and an hourly OTP-cleanup cron.
- **Routes vs. controllers vs. services**: routers only declare `METHOD path → middleware chain → controller function` (no business logic); controllers parse/validate the request and orchestrate a response; services hold logic reused across multiple controllers or triggered outside a request (crons, webhooks) — e.g. `orderEmailService`/`whatsappNotificationService` are called from both the customer payment flow and admin order-status updates, and `packageFulfillmentService` is called from both `paymentController` (after a normal checkout) and the daily cron.
- **Database access** always goes through `query()`/`getClient()` in `config/database.js` — no controller/service opens its own connection.

---

## 5. Environment Variables

Variable **names** only, confirmed by grepping actual `process.env.*` usage in `src/` and `cron/` plus `.env.example`. Set real values in `bree-backend/.env` — never commit them.

```env
# ── Server ───────────────────────────────────────────────────────────────
NODE_ENV=YOUR_VALUE_HERE
PORT=YOUR_VALUE_HERE
FRONTEND_URL=YOUR_VALUE_HERE   # comma-separated list allowed (CORS allow-list)

# ── Database (MySQL) ────────────────────────────────────────────────────
# Either a single pooled URL...
DATABASE_URL=YOUR_VALUE_HERE
# ...or discrete fields (fallback if DATABASE_URL is absent/invalid)
DB_HOST=YOUR_VALUE_HERE
DB_PORT=YOUR_VALUE_HERE
DB_USER=YOUR_VALUE_HERE
DB_PASSWORD=YOUR_VALUE_HERE
DB_NAME=YOUR_VALUE_HERE

# ── Auth / JWT ───────────────────────────────────────────────────────────
JWT_SECRET=YOUR_VALUE_HERE
JWT_EXPIRES_IN=YOUR_VALUE_HERE            # e.g. 7d (defaults to 7d)
ADMIN_JWT_SECRET=YOUR_VALUE_HERE
ADMIN_JWT_EXPIRES_IN=YOUR_VALUE_HERE      # e.g. 1d (defaults to 1d)
REFRESH_TOKEN_EXPIRES_IN_DAYS=YOUR_VALUE_HERE

# ── Firebase Admin (Google Sign-In verification) ────────────────────────
# The active code path loads a service-account JSON file — see §7/§32.
GOOGLE_APPLICATION_CREDENTIALS=YOUR_VALUE_HERE
# Present in .env.example for an alternate/legacy config path (not the
# active code path — see §7):
FIREBASE_PROJECT_ID=YOUR_VALUE_HERE
FIREBASE_CLIENT_EMAIL=YOUR_VALUE_HERE
FIREBASE_PRIVATE_KEY=YOUR_VALUE_HERE

# ── Razorpay ─────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=YOUR_VALUE_HERE
RAZORPAY_KEY_SECRET=YOUR_VALUE_HERE
RAZORPAY_WEBHOOK_SECRET=YOUR_VALUE_HERE

# ── Cloudinary ───────────────────────────────────────────────────────────
CLOUDINARY_CLOUD_NAME=YOUR_VALUE_HERE
CLOUDINARY_API_KEY=YOUR_VALUE_HERE
CLOUDINARY_API_SECRET=YOUR_VALUE_HERE
CLOUDINARY_UPLOAD_FOLDER=YOUR_VALUE_HERE  # defaults to "bree-products"

# ── SMTP (email) ─────────────────────────────────────────────────────────
SMTP_HOST=YOUR_VALUE_HERE                 # defaults to smtp.gmail.com
SMTP_PORT=YOUR_VALUE_HERE                 # defaults to 587
SMTP_USER=YOUR_VALUE_HERE
SMTP_PASS=YOUR_VALUE_HERE
SMTP_FROM=YOUR_VALUE_HERE                 # optional From-address override

# ── WhatsApp — Waplify (order/bulk/subscription/return notifications) ──
WAPLIFY_BASE_URL=YOUR_VALUE_HERE
WAPLIFY_API_KEY=YOUR_VALUE_HERE
WAPLIFY_OTP_TEMPLATE=YOUR_VALUE_HERE                 # defaults to "otp_login"
WAPLIFY_TEMPLATE_ORDER_CONFIRMED=YOUR_VALUE_HERE
WAPLIFY_TEMPLATE_ORDER_STATUS=YOUR_VALUE_HERE
WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS=YOUR_VALUE_HERE
WAPLIFY_TEMPLATE_PAYMENT_STATUS=YOUR_VALUE_HERE
WAPLIFY_TEMPLATE_BULK_UPDATE=YOUR_VALUE_HERE

# ── Meta WhatsApp Cloud API (webhook receiver only) ─────────────────────
META_VERIFY_TOKEN=YOUR_VALUE_HERE

# ── Delhivery ────────────────────────────────────────────────────────────
DELHIVERY_BASE_URL=YOUR_VALUE_HERE
DELHIVERY_API_TOKEN=YOUR_VALUE_HERE
DELHIVERY_TIMEOUT=YOUR_VALUE_HERE          # ms, optional (defaults to 30000)
DELHIVERY_TRACKING_URL=YOUR_VALUE_HERE     # optional, tracking link base
DELHIVERY_PICKUP_TIME=YOUR_VALUE_HERE      # optional, default pickup time

# ── Warehouse (pickup/origin address for Delhivery shipments) ──────────
WAREHOUSE_NAME=YOUR_VALUE_HERE
WAREHOUSE_ADDRESS=YOUR_VALUE_HERE
WAREHOUSE_CITY=YOUR_VALUE_HERE
WAREHOUSE_STATE=YOUR_VALUE_HERE
WAREHOUSE_PINCODE=YOUR_VALUE_HERE
WAREHOUSE_COUNTRY=YOUR_VALUE_HERE
WAREHOUSE_PHONE=YOUR_VALUE_HERE
WAREHOUSE_GST=YOUR_VALUE_HERE

# ── Admin seed (used only by `npm run seed`) ────────────────────────────
ADMIN_EMAIL=YOUR_VALUE_HERE
ADMIN_PASSWORD=YOUR_VALUE_HERE
```

> Never commit real values for any of the above. `.env.example` (placeholders only) is the file meant to be version-controlled.

---

## 6. Database

- **Technology**: MySQL, accessed via `mysql2/promise` (`src/config/database.js`), pooled (`connectionLimit: 10`), `timezone: "+05:30"`, `decimalNumbers: true`.
- **Connection configuration**: `DATABASE_URL` (a `mysql://` connection string) if present, otherwise falls back to `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`.
- **Query helper**: `query(text, params)` — a thin Postgres-style-compatible wrapper (translates `$1`-style placeholders to `?`, `ILIKE` to `LIKE`, strips `::type` casts, maps `true`/`false` literals to `1`/`0`) so call sites can use familiar parameterized SQL; normalizes the raw `mysql2` result into `{ rows, rowCount, insertId }`. `getClient()` returns a dedicated pooled connection for multi-statement transactions (`BEGIN`/`COMMIT`/`ROLLBACK`, `SELECT ... FOR UPDATE`).
- **Migration/ensure pattern**: there is **no separate migration-runner framework** for day-to-day schema evolution. Instead, `config/database.js` defines a series of idempotent `ensure*` functions (e.g. `ensureOrderNumberSchema`, `ensureBulkBookingWorkflowColumns`, `ensureOrderReturnColumns`, `ensurePackagePurchasesTable`, `ensurePackageNumberSchema`) that each check `information_schema.columns`/`information_schema.tables` and only run `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`-style statements for what's actually missing. All of them are awaited, in sequence, at the bottom of `database.js` — meaning **every app boot self-heals the schema** to the version the code expects, safely re-runnable with no destructive effect. `migrations/mysql-migrate.js` and `migrations/migrate.js` exist separately for initial/bulk schema setup (see [§31](#31-database-initialization--migrations)).
- **Key tables** (confirmed present in code):
  - `users` — customer accounts (`id`, `name`, `email`, `phone`, `picture`, `provider`, `role`, `customer_number`).
  - `otp_verifications` — mobile OTP records (`mobile`, `otp_hash`, `expires_at`, `attempts`, `verified`).
  - `refresh_tokens` — customer session refresh tokens (via `authService.js`).
  - `admins` — admin accounts (`id`, `email`, `name`, hashed password).
  - `products` — includes `is_subscription`, `razorpay_plan_id`, `is_recurring_package`, `package_duration_months`, `package_fulfillment_interval_days`, plus shipping/pricing/stock fields.
  - `orders` — the central order table; includes payment/Razorpay fields, `is_bulk_order`/`bulk_booking_id`, `is_subscription`/`is_renewal_order`/`parent_order_id`/`subscription_status`/`next_billing_date`, package-fulfillment fields (`parent_package_id`, `fulfillment_cycle`), shipping/Delhivery fields (`awb_number`, `tracking_status`, etc.), and the full return/refund column set (see [§21](#21-return-system)).
  - `order_items`, `order_status_history`, `payments` — order line items, status audit trail, and payment records.
  - `order_number_counter` — atomic counter backing human-readable order numbers (e.g. `#BREE-100001`).
  - `bulk_bookings` — Bulk Order enquiries/quotes; includes `enquiry_address`, legacy structured address columns, quote/approval/payment fields, `order_created`/`created_order_id`.
  - `bulk_booking_number_counter`, `bulk_booking_communications` — booking-number sequence and a communications audit log.
  - `package_purchases` — one row per recurring-package purchase (`origin_order_id` **unique**, `total_cycles`, `fulfillment_interval_days`, `cycles_created`, `next_fulfillment_date`, `status`).
  - `package_number_counter` — atomic counter backing package reference numbers.
  - `addresses` / `user_addresses` — saved customer addresses (both are read in different code paths; see order/shipping address resolution logic).
  - `products` relations table(s) for the admin "related products" feature.
- **Relationships/constraints actually enforced**: `orders.parent_package_id` + `orders.fulfillment_cycle` have a **unique index** (`uq_orders_package_cycle`) preventing duplicate fulfillment cycles; `package_purchases.origin_order_id` is **unique**; `order_number_counter`/`bulk_booking_number_counter`/`package_number_counter` are single-row atomic counter tables locked via `SELECT ... FOR UPDATE` when issuing the next number.

---

## 7. Authentication

Two entirely separate authentication systems — **customer** and **admin** — with different JWT secrets, cookies, and middleware.

### Customer authentication

```
Customer
  → POST /api/auth/send-otp  (mobile OTP, WhatsApp-delivered)
  → POST /api/auth/verify-otp
       existing user  → session established (cookie + accessToken)
       new user       → POST /api/auth/complete-profile → session established
  OR
  → POST /api/auth/google  (Firebase ID token verified server-side via firebase-admin)
  → session established
  → subsequent requests: auth_token cookie (httpOnly) or Authorization: Bearer <accessToken>
  → GET /api/auth/verify silently rotates the session via refresh_token when the access token has expired
```

- OTPs are stored hashed (`bcryptjs`) in `otp_verifications` with a 5-minute expiry, a 5-attempt cap, and a 30-second resend cooldown; WhatsApp delivery is via `sendWhatsAppOtp` (`services/whatsappService.js`, Waplify).
- A brand-new phone number never gets a user row from `verify-otp` alone — the OTP record is marked `verified` and `complete-profile` (which re-checks that verified/unexpired OTP record server-side, never trusting the mobile number on its own) is what actually creates the `users` row, inside a transaction with `ensureUserCustomerNumber`.
- Google Sign-In verifies the Firebase ID token via `firebase-admin`'s `verifyIdToken`, then upserts the user (`ON DUPLICATE KEY UPDATE`) by email.
- Sessions use a **short-lived access token** (`JWT_SECRET`, cookie `auth_token`) and a **longer-lived refresh token** (DB-backed, cookie `refresh_token`) — `GET /api/auth/verify` transparently rotates an expired access token using a valid, unrevoked refresh token.
- `middleware/auth.js` exports `auth` (hard requirement — 401 if no/invalid token or user not found) and `optionalAuth` (attaches `req.user` if a valid token is present, otherwise proceeds unauthenticated) — used for endpoints that behave differently for guests vs. logged-in users (e.g. cart validation, payment status).

### Admin authentication

```
Admin
  → POST /api/admin/login  (email + bcrypt-hashed password check against `admins` table)
  → admin_auth_token cookie (httpOnly) + token also returned in the JSON body
  → subsequent requests: adminAuth middleware (cookie or Authorization: Bearer)
  → GET /api/admin/me verifies the session
```

`middleware/adminAuth.js` is completely independent of customer `auth` — separate secret (`ADMIN_JWT_SECRET`), separate cookie (`admin_auth_token`), separate table (`admins`). It is applied to the entire admin router (`router.use(adminAuth)` in `routes/admin/index.js`) except `POST /login`.

### Backend protections for Subscribe / Bulk Order

Both of the following are enforced **server-side**, independent of any frontend gating:

- **`POST /api/subscriptions/create`** requires the `auth` middleware. `subscriptionController.createSubscription` reads the acting user from `req.user?.id` (populated by `auth` from the verified JWT) — it does **not** trust any user ID supplied in the request body.
- **`POST /api/bulk-bookings`** (Bulk Order enquiry creation) requires the `auth` middleware (`bulkRoutes.js`: `router.post("/", auth, createBulkBooking)`). Every other Bulk Order endpoint reached via the booking's own id — quote view, quote approval, payment details, payment verification — remains unauthenticated by design, since customers reach those via a link (e.g. an emailed quote-ready notification), not a login session.

---

## 8. API Routes

Grouped by area. **Auth** column reflects the actual middleware on each route. Only endpoints confirmed directly from route files are listed.

### Auth (`/api/auth`, `routes/auth.js`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/send-otp` | Public | Send a mobile OTP via WhatsApp |
| POST | `/api/auth/verify-otp` | Public | Verify OTP; logs in existing users, flags new users for profile completion |
| POST | `/api/auth/resend-otp` | Public | Resend OTP (rate-limited via cooldown) |
| POST | `/api/auth/complete-profile` | Public (requires a prior verified OTP record) | Create a new user after OTP verification |
| POST | `/api/auth/google` | Public | Google Sign-In via Firebase ID token |
| PATCH | `/api/auth/change-password` | Required | Change password (email/password accounts) |
| GET | `/api/auth/verify` | Public (cookie/token optional — returns 401 if session invalid) | Verify/refresh the current session |
| GET | `/api/auth/me` | Required | Get the current authenticated user |
| POST | `/api/auth/logout` | Public | Revoke refresh token(s) and clear auth cookies |

### Users / Profile / Addresses

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/profile` | Required | Get current user's profile |
| PUT | `/api/profile` | Required | Update profile |
| PUT | `/api/profile/password` | Required | Change password |
| GET | `/api/addresses` | Required | List saved addresses |
| POST | `/api/addresses` | Required | Add an address |
| PUT | `/api/addresses/:id` | Required | Update an address |
| DELETE | `/api/addresses/:id` | Required | Delete an address |
| PUT | `/api/addresses/:id/default` | Required | Set default address |

### Products

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/products` | Public | List products |
| GET | `/api/products/home` | Public | Home-page product selection |
| GET | `/api/products/:id` | Public | Product detail |
| GET | `/api/products/:id/recommendations` | Public | Related-product recommendations |

### Orders / Checkout

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/orders` | Required | List the current user's orders |
| GET | `/api/orders/:id` | Optional | Get an order (guest orders supported via `user_id IS NULL`) |
| GET | `/api/orders/:id/success` | Required | Post-payment order summary |
| GET | `/api/orders/:id/tracking` | Required | Order + shipment tracking detail |
| GET | `/api/orders/:id/history` | Required | Order status history |
| POST | `/api/orders/validate-cart` | Optional | Re-validate cart prices/stock/availability before checkout |
| POST | `/api/orders/create` | Required | (Order-creation entry used by `orderController`) |
| PUT | `/api/orders/:id/payment-status` | Required | Update payment status |

### Payments

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/payment/create-order` | Optional | Create a Razorpay Order (Standard or Magic Checkout, based on `line_items`) |
| POST | `/api/payment/verify` | Optional | Verify a completed Razorpay payment and finalize the order |
| POST | `/api/payment/webhook` | Public (Razorpay signature-verified) | Razorpay async event webhook (`payment.captured`, `subscription.charged`, etc.) |
| POST | `/api/payment/shipping-info` | Optional | Razorpay Magic Checkout's shipping-methods/serviceability callback |
| GET | `/api/payment/status/:paymentId` | Optional | Payment status lookup |
| POST | `/api/payment/promotions` | Optional | Available promotions for an order |
| POST | `/api/payment/apply-promotions` | Optional | Apply a promotion code |

### Subscriptions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/subscriptions/create` | **Required** | Create a subscription (Razorpay `subscription_id`) |
| GET | `/api/subscriptions/my` | Required | List the current user's subscriptions |
| POST | `/api/subscriptions/:id/pause` | Required | Pause a subscription |
| POST | `/api/subscriptions/:id/resume` | Required | Resume a subscription |
| POST | `/api/subscriptions/:id/cancel` | Required | Request cancellation (effective at cycle end) |

### Bulk Orders (`/api/bulk-bookings`, `routes/bulkRoutes.js`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/bulk-bookings` | **Required** | Submit a Bulk Order enquiry (Enquiry Address only) |
| GET | `/api/bulk-bookings/:id/quote` | Public | Fetch a shared quote for approval |
| POST | `/api/bulk-bookings/:id/approve-quote` | Public | Approve the quote |
| GET | `/api/bulk-bookings/:id/payment` | Public | Get/prepare Razorpay Magic Checkout payment details |
| POST | `/api/bulk-bookings/:id/verify-payment` | Public | Verify Bulk Order payment and trigger Order creation |

### Shipping / Tracking (`/api/shipping`, `routes/shippingRoutes.js`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/shipping/create-shipment/:orderId` | Admin | Create a Delhivery shipment (`ready_to_ship` → `shipped`) |
| POST | `/api/shipping/pickup/:orderId` | Admin | Schedule a Delhivery pickup |
| GET | `/api/shipping/track/:awb` | Admin | Fetch live tracking status by AWB |
| POST | `/api/shipping/cancel/:orderId` | Admin | Cancel a shipment |
| GET | `/api/shipping/label/:awb` | Admin | Download the shipping label (PDF) |

### Webhooks (`/api/webhooks`, `routes/webhookRoutes.js` — distinct from the Razorpay webhook above)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks/meta` | Public (verify-token challenge) | Meta WhatsApp Cloud API webhook verification handshake |
| POST | `/api/webhooks/meta` | Public (Meta-originated) | Receive Meta WhatsApp Cloud API events |

### Contact / Testimonials

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/contact` | Public | Submit a contact inquiry |
| GET | `/api/testimonials` | Public | List approved testimonials |
| POST | `/api/testimonials` | Optional | Submit a testimonial |

### Admin (`/api/admin`, all behind `adminAuth` except `/login`) — see full detail in [§26](#26-admin-api)

---

## 9. Product API

Public: `GET /api/products`, `GET /api/products/home`, `GET /api/products/:id`, `GET /api/products/:id/recommendations` — read-only, no authentication.

Admin (`productController.js` under `/api/admin/products`, all `adminAuth`):

- `GET /api/admin/products` — paginated/searchable listing.
- `POST /api/admin/products` (`multipart/form-data`, `upload.single("image")` → Cloudinary) — create; if `is_subscription` is set, also creates a Razorpay **monthly plan** (`razorpay.plans.create`) and stores `razorpay_plan_id`.
- `PUT /api/admin/products/:id` — update; recreates the Razorpay plan if subscription is newly enabled or its price changes.
- `DELETE /api/admin/products/:id` — **soft delete** (`is_active = 0`), with a best-effort Cloudinary image cleanup.
- `GET/POST /api/admin/products/:id/relations`, `DELETE /api/admin/products/:id/relations/:relId` — related-product management (recommend/upsell/alternative).

**Stock**: `stock_qty`, checked and decremented at payment verification/webhook time (row-locked, see [§28](#28-transactions--data-safety)).

**Pricing**: `price` (selling), `mrp`; discount is computed by the frontend, not stored server-side.

**Subscription fields**: `is_subscription` (boolean), `razorpay_plan_id`.

**Recurring package fields** (mutually exclusive with `is_subscription` — enforced in the admin product form):

- `is_recurring_package` — boolean flag.
- `package_duration_months` — number of fulfillment cycles.
- `package_fulfillment_interval_days` — days between shipments.

---

## 10. Normal Order Flow

```
Product → Cart (client-side) → validate-cart → Checkout
  → POST /api/payment/create-order   (Razorpay Order created; line_items present ⇒ Magic Checkout)
  → Razorpay Checkout (popup)
  → POST /api/payment/verify          (signature verified, payment fetched & amount-checked, order finalized)
       OR Razorpay webhook: POST /api/payment/webhook, event "payment.captured"
  → Order marked payment_status='paid', order_status='paid'; stock deducted (idempotent, guarded by a stock_deducted flag)
  → Admin transitions order_status forward (processing → ready_to_ship → shipped → ...)
  → Delhivery shipment created → tracked → delivered
```

- **Razorpay order creation** (`paymentController.createOrder`): validates cart items/stock/price server-side (never trusts the frontend total beyond a small tolerance check), reuses a still-valid pending Razorpay order for the same user/amount within the last 30 minutes instead of creating a duplicate, and includes `line_items`/`line_items_total` in the Razorpay Orders API call when the request supplies Magic-Checkout-style `line_items` — this is what makes Razorpay treat the order as Magic Checkout.
- **Payment verification** (`paymentController.verifyPayment`): HMAC signature check (`verifyPaymentSignature`) → fetches the payment from Razorpay directly (amount cross-check for non-subscription orders) → resolves the final address (Magic Checkout's `customer_details.shipping_address` when present, else the submitted `shippingAddress`) → finalizes the order and payment rows inside a row-locked transaction → deducts stock exactly once (guarded by a `stock_deducted` flag on the order) → fires order-confirmation email/WhatsApp and (fire-and-forget) recurring-package creation.
- **Webhook handling** (`paymentController.handleWebhook`, mounted at `POST /api/payment/webhook` with the **raw** request body preserved specifically for signature verification): verifies `verifyWebhookSignature` against `RAZORPAY_WEBHOOK_SECRET`, then handles `payment.captured` (row-locked, idempotent — returns `already_processed` if the order is already paid), `payment.failed`, and the subscription lifecycle events (`subscription.activated`, `subscription.charged`, `subscription.paused`, `subscription.resumed`, `subscription.halted`, `subscription.cancelled`).
- **Idempotency**: both the client-verify path and the webhook path check `payment_status`/`razorpay_payment_id` under a row lock before writing, so a payment can never be double-processed regardless of which path (or both, racing) reaches the server first.
- Payment success is **never** determined by the frontend alone — both `verifyPayment` and the webhook independently re-verify against Razorpay's own records before marking anything paid.

---

## 11. Razorpay

A **single shared Razorpay client** (`config/razorpay.js`, `getRazorpay()` — lazily instantiated singleton from `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`) is used everywhere Razorpay is called — there is no second client instantiated anywhere in the codebase.

| Concern | Where implemented |
|---|---|
| Order creation | `paymentController.createOrder` (normal/subscription-checkout cart) and `bulkController`'s `ensureBulkRazorpayOrder` (Bulk Orders) |
| Payment verification | `paymentController.verifyPayment` (normal/subscription) and `bulkController.verifyBulkPayment` (Bulk Orders) — both reuse `utils/razorpay.js`'s `verifyPaymentSignature` |
| Signature verification | `utils/razorpay.js` — `verifyPaymentSignature` (payment/order HMAC) and `verifyWebhookSignature` (webhook HMAC, raw body) |
| Webhook handling | `paymentController.handleWebhook`, `POST /api/payment/webhook` |
| Subscriptions | `subscriptionController.createSubscription` (creates the Razorpay subscription) and `admin/subscriptionAdminController.js` (pause/resume/cancel via `razorpay.subscriptions.*`) |
| Refunds | `admin/returnController.completeRefund` (`razorpay.payments.refund` / `razorpay.refunds.fetch`) — see [§24](#24-razorpay-refunds) |

Distinguishing the four payment surfaces in this codebase:

- **Normal Checkout** — a Razorpay Order, optionally carrying `line_items`/`line_items_total` for Magic Checkout when the cart flow requests it.
- **Bulk Order Magic Checkout** — always created with `line_items`/`line_items_total` (single synthetic line item for the bulk quote amount); see [§14](#14-magic-checkout).
- **Subscription payment** — a Razorpay Subscription (`subscription_id`), not a one-time Order; billed on Razorpay's own cycle, reconciled via `subscription.charged` webhooks → `renewalService.createRenewalOrder`.
- **Refund** — `razorpay.payments.refund()` against the original `razorpay_payment_id`, admin-triggered only, after inspection approval.

---

## 12. Bulk Order System

The complete, current Bulk Order backend flow:

```
Authenticated Customer
  → POST /api/bulk-bookings                      (Bulk Enquiry — Enquiry Address only)
  → Admin reviews & sets a quote (admin dashboard, PUT /api/admin/bulk-bookings/:id)
  → Customer views the quote — GET /api/bulk-bookings/:id/quote
  → Customer approves — POST /api/bulk-bookings/:id/approve-quote
  → Customer clicks "Make Payment" — GET /api/bulk-bookings/:id/payment
       (creates/reuses the Razorpay Order via ensureBulkRazorpayOrder, Magic-Checkout-configured)
  → Razorpay Magic Checkout opens — collects the customer's shipping address during payment
  → POST /api/bulk-bookings/:id/verify-payment
       → signature + Razorpay payment fetch (status/amount/currency) verified
       → the Magic Checkout shipping address is fetched from Razorpay and validated
       → createOrderFromBulkBooking() creates a normal Order, using that address
```

**There is no admin-side "Send Payment Link" workflow.** The customer proceeds directly from quote approval to payment themselves; no admin action creates or shares a payment link. Grepping the current codebase confirms no active references to a `sharePaymentLink`/`notifyPaymentLinkShared`/`share-payment-link` endpoint or a `WAPLIFY_TEMPLATE_BULK_PAYMENT_LINK` template — that flow does not exist in the current implementation.

`bulkController.js`'s `ensureBulkRazorpayOrder` (still present and required) is the single place a Bulk Order's Razorpay Order is created or reused — it is idempotent (a two-phase lock pattern: validate+lock, release, call Razorpay, re-lock to persist, tolerating a concurrent caller having already written the id) so a page refresh or duplicate call never creates a second Razorpay order.

---

## 13. Bulk Order Address Model

Two distinct addresses, never conflated:

**1. Enquiry Address** — collected once, at Bulk Request submission time, as a single free-text field: `bulk_bookings.enquiry_address`. It is reference-only, used for the initial enquiry/quote stage — never used as a shipping address for the resulting Order.

**2. Final Shipping Address** — collected by **Razorpay Magic Checkout** during payment. After payment verification, `bulkController.verifyBulkPayment` fetches the Razorpay Order's `customer_details.shipping_address`, validates it (line1/city/valid 6-digit pincode present), and passes it into `createOrderFromBulkBooking()` as `magicCheckoutAddress`. `bulkOrderService.resolveOrderAddress()` prefers this Magic Checkout address; only when it's absent/invalid does it fall back to a booking's **legacy** structured address columns (`address_line1`, `address_line2`, `city`, `state`, `pincode`, `country` — kept for bookings created before the single-field Enquiry Address migration). The resolved address is written onto the created Order's own `shipping_address_line1..country` columns — never back onto `bulk_bookings`.

**Backward compatibility**: `enquiry_address` was added as a new nullable column alongside the pre-existing structured columns (`ensureBulkBookingWorkflowColumns` in `database.js`) — older bookings that only ever populated the structured columns continue to read and resolve correctly through the legacy-fallback path described above; nothing was deleted or backfilled destructively.

---

## 14. Magic Checkout

Bulk Order payments use Razorpay **Magic Checkout**, configured as follows:

- **Razorpay order configuration** (`ensureBulkRazorpayOrder`): the Razorpay Order is created with `line_items` — a single synthetic item (`sku`/`variant_id` derived from the booking reference, `name`, `price`/`offer_price` = the quoted amount in paise, `quantity: 1`) — and `line_items_total` equal to that same amount. Setting these on the Order itself is what marks it as a Magic-Checkout-eligible order on Razorpay's side.
- **`one_click_checkout: true`** is set by the **frontend** when opening the Razorpay popup for this booking — it's the client-side flag that actually switches the popup UI into Magic Checkout mode (backend-side, the marker is the `line_items` on the Order).
- **Shipping Information callback**: `POST /api/payment/shipping-info` (`paymentController.getShippingInfo`) is the single, **account-wide** Magic Checkout shipping-info webhook — the same endpoint used for normal-cart Magic Checkout orders. It resolves the request's `order_id`/`razorpay_order_id` against the `orders` table first; if no match is found (true for a Bulk Order still awaiting payment, since its Order row doesn't exist yet), it falls back to matching against `bulk_bookings` by `razorpay_order_id`/`bulk_booking_number`, then returns shipping-method/serviceability info (Bulk Orders are treated as free-shipping, since the quoted amount is all-inclusive).
- **Customer shipping address retrieval**: after payment, `bulkController.verifyBulkPayment` calls `razorpay.orders.fetch(razorpay_order_id)` and reads `customer_details.shipping_address` — this is the authoritative source for the final address; it is never inferred from the client-side success callback alone.
- **Payment verification**: signature check (`verifyPaymentSignature`) + a direct `razorpay.payments.fetch()` (status `captured`, amount, currency all cross-checked against the quoted amount) before anything is written.
- **Final order address mapping**: see [§13](#13-bulk-order-address-model) — the fetched Magic Checkout address is what's written onto the created Order's shipping columns.

No Razorpay secrets are logged or exposed by any of the above — only the publishable `key_id` is ever returned to the frontend.

---

## 15. Subscription System

(`subscriptionController.js`, `routes/index.js` → `subscriptionRouter`)

- **Creation** (`POST /api/subscriptions/create`, **`auth` required**): validates the request shape (items, customer name/email/mobile, shipping address), row-locks and validates the referenced product(s) (`stock_qty`, `is_active`, `status = 'In Stock'`), computes the server-side total (never trusts a client-supplied price), and creates a Razorpay Subscription against the product's `razorpay_plan_id`.
- **Authentication requirement**: enforced by the `auth` middleware on the route; the controller reads the purchaser's identity from `req.user.id` — a client cannot create a subscription for another user by supplying a different id in the body.
- **Product validation**: subscription creation is rejected (400) for missing/invalid items, a product that's inactive/out of stock/not found, or insufficient stock.
- **Price / frequency**: price is the product's own price (server-fetched, not client-supplied); frequency is passed through to Razorpay's subscription/plan configuration.
- **Status values observed**: `pending`, `active`, `authenticated`, `paused`, `cancelled`, `cancellation_requested`, `created` (`SUBSCRIPTION_STATUS` constants in `subscriptionController.js`).
- **Cancellation**: modeled as `cancel_at_cycle_end` on Razorpay (`subscriptions.cancel({ cancel_at_cycle_end: 1 })`, admin-triggered from `admin/subscriptionAdminController.js`) — the local `subscription_status` is set to `cancellation_requested` immediately and only becomes `cancelled` once Razorpay's webhook confirms the cycle actually ended; `order_status` is never touched by this transition.
- **Pause/Resume**: `POST /api/subscriptions/:id/pause|resume` (customer-facing) and the equivalent admin endpoints both call the corresponding Razorpay Subscriptions API method.
- **Webhook handling**: `subscription.activated`, `subscription.charged` (→ `renewalService.createRenewalOrder`, which creates a new fulfillment order for that billing cycle, idempotent on `razorpay_payment_id`), `subscription.paused`, `subscription.resumed`, `subscription.halted`, `subscription.cancelled` — all handled in `paymentController.handleWebhook`.

---

## 16. Recurring Package System

A **Recurring Package** is a **separate, mutually-exclusive** product model from Subscriptions: the customer pays **once**, and BREE ships the product across multiple pre-scheduled cycles at no further charge.

```
3-month package  → 3 fulfillment cycles
6-month package  → 6 fulfillment cycles
12-month package → 12 fulfillment cycles
```

The number of cycles (`package_duration_months`) and the interval between shipments (`package_fulfillment_interval_days`) are both **admin-configurable per product** — the interval is **not** hardcoded to 30 days.

**Cycle 1 is the original paid order itself** — no separate row is created for it. When `createPackagePurchaseFromOrder(orderId)` (`services/packageFulfillmentService.js`) runs (fire-and-forget, called right after a normal payment verification or webhook `payment.captured` commits), it detects a recurring-package line item on that order and, in one transaction: inserts a `package_purchases` row (`origin_order_id` = that same order, `total_cycles`, `fulfillment_interval_days`, `cycles_created = 1`, `next_fulfillment_date` = now + interval, `status = 'active'`) **and** stamps the origin order itself with `parent_package_id` + `fulfillment_cycle = 1`. If `total_cycles <= 1`, the package is created already `status = 'completed'`.

**Cycle 2+ are automatically created fulfillment orders** — new `orders` rows, created by the daily cron (see [§17](#17-package-fulfillment-cron)), each carrying `parent_package_id` and an incrementing `fulfillment_cycle`, at `order_status = 'paid'` / `payment_status = 'paid'` — **no additional Razorpay payment is created or required** for these.

Key fields:

| Field | Location | Meaning |
|---|---|---|
| `origin_order_id` | `package_purchases` | The Cycle‑1 order (unique) |
| `total_cycles` | `package_purchases` | Total shipments owed |
| `fulfillment_interval_days` | `package_purchases` | Days between shipments |
| `cycles_created` | `package_purchases` | How many cycles exist so far (including Cycle 1) |
| `next_fulfillment_date` | `package_purchases` | When the next cycle is due; `NULL` once completed |
| `status` | `package_purchases` | `active` or `completed` |
| `parent_package_id` | `orders` | Links a fulfillment order back to its package |
| `fulfillment_cycle` | `orders` | Which cycle number this order represents |

---

## 17. Package Fulfillment Cron

`cron/packageFulfillmentCron.js`, started from `server.js` (`startPackageFulfillmentCron()`), after the DB connectivity check passes.

- **Schedule**: `0 3 * * *` (daily, 3:00 AM), pinned to `timezone: "Asia/Kolkata"`.
- **Due-package detection**: an unlocked scan —
  ```sql
  SELECT id FROM package_purchases
  WHERE status = 'active' AND next_fulfillment_date IS NOT NULL AND next_fulfillment_date <= NOW()
  ```
- **Cycle creation** (`fulfillNextCycle`, per package): row-locks the `package_purchases` row (`FOR UPDATE`), re-validates it's still due, copies the origin order's items into a brand-new `orders` row (`fulfillment_cycle = cycles_created + 1`), deducts stock (rolls back with `insufficient_stock` if unavailable), and advances `package_purchases` (`cycles_created`, `next_fulfillment_date`, and `status = 'completed'` once the final cycle is reached) — only after the new order commits successfully.
- **Notifications**: on success, fires an order-confirmation email and (best-effort) WhatsApp for the new cycle's order.
- **Retry behavior**: if creating a cycle fails for any reason (including insufficient stock), the transaction rolls back, `package_purchases` is left untouched, and the same package is simply picked up again on the **next day's** cron run — no cycle is silently skipped or double-counted.
- **Completion logic**: a package is complete once `cycles_created >= total_cycles`; `status` becomes `'completed'` and `next_fulfillment_date` is cleared, so it's permanently excluded from the due-package query.
- A separate cron, `cron/shippingTrackingCron.js`, runs **every 30 minutes** (`*/30 * * * *`) to sync live Delhivery tracking status for all orders with an AWB that aren't yet in a terminal tracking state — see [§19](#19-shipping--delhivery).
- An inline hourly cron (`0 * * * *`, defined directly in `server.js`) runs `cleanupExpiredOtps()` to delete expired `otp_verifications` rows.

---

## 18. Package Idempotency

- **Row locking**: every cycle-creation attempt locks its `package_purchases` row with `SELECT ... FOR UPDATE` inside a transaction before re-validating it's still due — two concurrent cron ticks (or a manual retrigger) can't both create a cycle for the same package.
- **Unique constraints**:
  - `package_purchases.origin_order_id` is **unique** — a given order can only ever originate one package.
  - `orders` has a **unique index** on `(parent_package_id, fulfillment_cycle)` (`uq_orders_package_cycle`) — a duplicate-cycle insert fails at the database level even if the application-level lock were somehow bypassed; the code catches this specific duplicate-key error and treats it as "already created by a concurrent run," not a failure.
- **Transaction handling**: the new order + its items + stock deduction + `package_purchases` advancement all happen inside one transaction; any failure rolls back the entire cycle attempt, leaving no partial state.
- **Cycle advancement only after success**: `cycles_created`/`next_fulfillment_date`/`status` on `package_purchases` are only updated **after** the new order's insert (and stock deduction) has committed — a failed attempt never advances the package state, so the exact same cycle is retried next run rather than being skipped.
- **On fulfillment failure**: the transaction rolls back completely (no order, no stock change, no package-state change); the error is logged; the package remains `active` with its `next_fulfillment_date` unchanged, so it's picked up again on the next scheduled run. One package's failure does not affect any other package in the same cron run — each is processed and error-handled independently.

---

## 19. Shipping / Delhivery

`services/delhiveryService.js` — a single Delhivery API client (base URL/token from `DELHIVERY_BASE_URL`/`DELHIVERY_API_TOKEN`, `Authorization: Token <token>` header), exposing: `checkServiceability(pincode)`, `createShipment(payload)`, `trackShipment(awb)`, `cancelShipment(waybill)`, `requestPickup(data)`, `getShippingLabel(waybill)`, `healthCheck()` (plus internal payload-validation helpers).

**Forward (normal) shipment flow** (`shippingController.js`, all routes `adminAuth`):

- `POST /api/shipping/create-shipment/:orderId` — only allowed when `order_status === 'ready_to_ship'`; resolves the structured shipping address (`user_addresses` → legacy `addresses` → the order's own `shipping_address_line1..country` columns, in that order), builds the Delhivery payload (`utils/delhiveryPayload.js`) using the configured `WAREHOUSE_*` origin, calls `createShipment`, and on success stores the AWB/tracking URL and transitions `order_status` to `'shipped'`.
- `POST /api/shipping/pickup/:orderId` — schedules a Delhivery pickup once a shipment/AWB exists (`order_status === 'shipped'`).
- `GET /api/shipping/track/:awb` — fetches live tracking; also used by the tracking-sync cron.
- `POST /api/shipping/cancel/:orderId` — cancels a shipment.
- `GET /api/shipping/label/:awb` — streams the shipping label PDF.

**Reverse shipment flow** (returns, admin-only — `admin/returnController.js`, see [§21](#21-return-system)): reuses the **same** `delhiveryService.createShipment()` call with the customer and warehouse roles swapped (customer becomes the pickup origin, BREE warehouse becomes the destination) — there is no separate Delhivery "reverse shipment" API method; the forward payload builder is reused with swapped addresses. Reverse pickup scheduling reuses `requestPickup()` the same way.

**Tracking sync cron** (`cron/shippingTrackingCron.js`, every 30 minutes): finds orders with a non-empty AWB whose `tracking_status` isn't yet `delivered`/`cancelled`/`returned`, calls Delhivery's tracking API per order, updates `tracking_status` (and, when available, current location/expected delivery), advances `order_status` when the mapped tracking status changes it, records the transition in `order_status_history`, and sends out-for-delivery/delivered emails.

**Recurring fulfillment orders use the exact same shipping pipeline** as normal orders — a cycle-2+ order created by the package cron is just another `orders` row that becomes `ready_to_ship` and follows the identical `create-shipment` → `pickup` → tracking-sync path; no separate shipping code exists for package orders.

---

## 20. Order Status System

The canonical status list (`src/constants/orderStatus.js`, `ORDER_STATUSES`) — only these values are recognized:

```
pending_payment → paid → processing → ready_to_ship → shipped → out_for_delivery → delivered
                                                                                        ↘ returned
(cancelled reachable from any non-terminal state)
```

- `pending_payment`, `paid`, `processing`, `ready_to_ship`, `shipped`, `out_for_delivery`, `delivered`, `cancelled`, `returned`.
- `normalizeOrderStatus()` maps a few legacy/alias inputs (`pending`→`pending_payment`, `confirmed`→`paid`, `dispatched`→`shipped`) onto this canonical set.
- `DISPATCH_STATUSES` = `processing`, `ready_to_ship`, `shipped`, `out_for_delivery` — the admin-manually-editable range before Delhivery tracking takes over automatic transitions.
- Once a shipment (AWB) exists, further manual status edits to Delhivery-controlled states are blocked in `admin/orderController.updateOrderStatus` — those transitions are then driven by the tracking-sync cron instead.
- Payment statuses (`VALID_PAYMENT_STATUSES`): `pending`, `paid`, `failed`, `refunded`.
- Return/refund state is modeled as a **separate side-channel** on the same `orders` row (`return_status`, `inspection_status`, `refund_status`) and deliberately never mutates `order_status` — see [§21](#21-return-system).

---

## 21. Return System

Fully admin-mediated — **there is no customer-facing "create a return" endpoint anywhere in the codebase.** Every return/refund route lives under `/api/admin/orders/:orderId/...` behind `adminAuth` (`admin/returnController.js`).

```
Order Delivered
  → 48-hour return window opens (delivered_at + 48h)
  → Customer contacts BREE Support (outside this API — phone/WhatsApp/email)
  → BREE team manually verifies the issue
  → Admin: PATCH /orders/:orderId/return/approve   (or /return/reject)
  → Admin: POST  /orders/:orderId/return/reverse-shipment   (Delhivery reverse shipment created)
  → Admin: PATCH /orders/:orderId/return/schedule-pickup
  → Admin: PATCH /orders/:orderId/return/mark-returned       (product physically back)
  → Admin: PATCH /orders/:orderId/return/inspection/approve  (or /inspection/reject)
  → Admin: PATCH /orders/:orderId/refund/approve
  → Admin: PATCH /orders/:orderId/refund/complete             (Razorpay refund created/rechecked)
```

**Return/refund columns on `orders`** (added by `ensureOrderReturnColumns()` in `database.js`; `delivered_at` is backfilled for pre-existing delivered orders by a companion `ensureDeliveredAtBackfill()` function):

`delivered_at`, `return_status`, `return_reason`, `return_notes`, `return_requested_at`, `return_approved_at`, `return_approved_by`, `reverse_awb`, `reverse_tracking_url`, `reverse_shipment_created_at`, `reverse_pickup_request_id`, `returned_at`, `inspection_status`, `refund_status`, `refund_amount`, `refund_reference`, `refund_completed_at`.

`order_status` itself is **never** modified by any return/refund action — this workflow is entirely a side-channel on the same row.

---

## 22. 48-Hour Return Window

Server-side eligibility (`isReturnWindowOpen`, `admin/returnController.js`) is the **final authority** — the frontend's own 48-hour display (Order Tracking page) is UX-only and is independently re-checked here on every return-approval and reverse-shipment action:

```js
const RETURN_WINDOW_HOURS = 48;
const deadline = new Date(delivered_at).getTime() + RETURN_WINDOW_HOURS * 60 * 60 * 1000;
```

A return is **not allowed** when:

1. `order_status !== 'delivered'` — not yet delivered.
2. `delivered_at` is missing — eligibility can't be determined.
3. `Date.now() > deadline` — the 48-hour window has expired.
4. `return_status` is already `'rejected'` or `'returned'` — a terminal state for this order's return.

---

## 23. Return Inspection

```
mark-returned (inspection_status = 'pending')
  → inspection/approve (inspection_status = 'approved')
  OR
  → inspection/reject  (inspection_status = 'rejected')
```

**Refund approval requires a successful inspection** — `approveRefund` is gated on `return_status === 'returned'`, `inspection_status === 'approved'`, `payment_status === 'paid'` (with a `razorpay_payment_id` on file), and a requested `refund_amount` that does not exceed the order's total. A rejected inspection blocks the refund path entirely.

---

## 24. Razorpay Refunds

`admin/returnController.completeRefund` — a three-phase design (lock/validate → call Razorpay outside any DB transaction → short transaction to persist the result), gated to only run from `refund_status = 'approved'` (first attempt) or `'initiated'` (recheck an in-flight refund); already-`'completed'` short-circuits with no Razorpay call.

- **Create**: `razorpay.payments.refund(razorpay_payment_id, { amount: <paise>, speed: "normal", notes: { order_id, order_number } })`.
- **Recheck / idempotency**: on a repeat call while `refund_status === 'initiated'`, it calls `razorpay.refunds.fetch(refund_reference)` instead of creating a second refund — **duplicate refunds are prevented** by never calling `payments.refund()` more than once for the same order.
- **Status mapping**: only a Razorpay refund `status === "processed"` is recorded as `refund_status = 'completed'` (with `refund_completed_at`); anything else (e.g. `"pending"`) is stored as `refund_status = 'initiated'`, requiring a later admin re-check (there is no refund-completion webhook in this codebase).
- **Persisted fields**: `refund_status`, `refund_reference` (the Razorpay refund id), `refund_completed_at`, `refund_amount` (set earlier at `approveRefund`).

---

## 25. Notifications

### Email

Nodemailer-based, via SMTP (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`). Two service files exist:

- `services/email.js` — a simpler general-purpose sender (`sendOrderConfirmation`, `sendContactAck`, `sendBulkBookingNotification`).
- `services/orderEmailService.js` — the one actually wired into order/admin/subscription/package flows, sharing one `sendEmail()` helper. Exports: `sendOrderConfirmationEmail`, `sendOrderStatusUpdateEmail`, `sendOrderDeliveredEmail`, `sendOrderCancelledEmail`, `sendShipmentCreatedEmail`, `sendOutForDeliveryEmail`, `sendShipmentDeliveredEmail`, `sendShipmentCancelledEmail`, `sendSubscriptionChargeReceiptEmail`, `sendSubscriptionFailedEmail`, `sendSubscriptionCancellationEmail`, `sendSubscriptionResumeEmail`.

Both silently no-op (with a log line) if SMTP isn't configured — a missing/broken email integration never fails the underlying order/payment operation.

### WhatsApp — Waplify

The active, general-purpose WhatsApp integration is **`services/whatsappNotificationService.js`** (Waplify HTTP API — `WAPLIFY_BASE_URL`/`WAPLIFY_API_KEY`), used by order-status updates, bulk order notifications, subscription status changes, payment status changes, and return/refund events. It exposes: `sendTemplateMessage`, `sendOrderConfirmationWhatsApp`, `sendOrderStatusUpdateWhatsApp`, `sendSubscriptionStatusWhatsApp`, `sendPaymentStatusWhatsApp`, `sendCustomWhatsAppNotification`, `sendBulkWhatsAppNotifications`, plus `safelySendWhatsApp` (a fire-and-forget wrapper that catches/logs failures so a WhatsApp outage never fails the underlying request).

A **second**, narrower file, `services/whatsappService.js`, is used **only** for OTP delivery (`sendWhatsAppOtp`, template `WAPLIFY_OTP_TEMPLATE`) — it is not involved in order/bulk/subscription/return notifications.

**Templates** (env var names only — actual Waplify template IDs, never credentials): `WAPLIFY_TEMPLATE_ORDER_CONFIRMED`, `WAPLIFY_TEMPLATE_ORDER_STATUS`, `WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS`, `WAPLIFY_TEMPLATE_PAYMENT_STATUS`, `WAPLIFY_TEMPLATE_BULK_UPDATE`, `WAPLIFY_OTP_TEMPLATE`.

**Return/refund events reuse the existing generic order-status template** — `whatsappNotificationService.js` maps return/refund milestones ("Return Approved", "Return Shipment Created", "Return Pickup Scheduled", "Return Received", "Return Inspection Approved", "Return Rejected", "Refund Initiated", "Refund Completed") through the same status-message builder used for normal order-status updates, which sends via `WAPLIFY_TEMPLATE_ORDER_STATUS` — **no separate return/refund template exists.**

A separate **Meta WhatsApp Cloud API** webhook receiver (`GET`/`POST /api/webhooks/meta`, `META_VERIFY_TOKEN`) exists for inbound Meta events; it does not send notifications itself.

---

## 26. Admin API

All routes below are mounted under `/api/admin` and require `adminAuth` (a valid `admin_auth_token` cookie or `Authorization: Bearer` token, verified against the `admins` table) except `POST /api/admin/login`.

**Authentication**: `POST /api/admin/login` (rate-limited, 10/15min) checks email + `bcrypt.compare()` against the `admins` table, issues a JWT (`ADMIN_JWT_SECRET`) as both the `admin_auth_token` cookie and the JSON response body, `GET /api/admin/me` verifies the session, `POST /api/admin/logout` clears the cookie.

| Area | Endpoints |
|---|---|
| **Dashboard** | `GET /dashboard` — cached aggregate stats (total orders/revenue/customers, pending orders, bulk booking count, this-month revenue, this-week orders, 5 most recent orders) |
| **Orders** | `GET /orders` (paginated/filterable/sortable), `GET /orders/:id`, `PATCH /orders/:id/status`, `PATCH /orders/bulk-status` — status-transition validated, Delhivery-locked statuses protected, triggers email/WhatsApp/socket notifications |
| **Returns / Inspection / Refunds** | `PATCH /orders/:orderId/return/approve|reject`, `POST /orders/:orderId/return/reverse-shipment`, `PATCH /orders/:orderId/return/schedule-pickup`, `PATCH /orders/:orderId/return/mark-returned`, `PATCH /orders/:orderId/return/inspection/approve|reject`, `PATCH /orders/:orderId/refund/approve|reject|complete` (see [§21](#21-return-system)–[§24](#24-razorpay-refunds)) |
| **Products** | `GET /products`, `POST /products` (image upload), `PUT /products/:id`, `DELETE /products/:id` (soft delete), `GET/POST /products/:id/relations`, `DELETE /products/:id/relations/:relId` |
| **Bulk Orders** | Registered via `controllers/admin/bulkRoutes.js` — bulk booking listing/detail/quote-setting/status management (booking creation itself is on the public/customer router, see [§12](#12-bulk-order-system)) |
| **Subscriptions** | `GET /subscriptions`, `GET /subscriptions/:id`, `PATCH /subscriptions/:id/pause|resume|cancel`, `GET /subscriptions/analytics`, `GET /subscriptions/upcoming-renewals`, `GET /subscriptions/failed-renewals` |
| **Customers** | `GET /customers` — paginated/searchable, with order count and total spend |
| **Inquiries** | `GET /inquiries`, `PATCH /inquiries/:id/contacted`, `PATCH /inquiries/:id`, `DELETE /inquiries/:id` |
| **Testimonials** | `GET /testimonials`, `PATCH /testimonials/:id/approve|reject`, `DELETE /testimonials/:id` |

Package/recurring-package information is exposed as part of the standard `GET /orders`/`GET /orders/:id` payload (`parent_package_id`, `fulfillment_cycle`, and the joined `package_purchases` fields) rather than as a separate admin endpoint.

---

## 27. Error Handling

Centralized in `middleware/errorHandler.js` (mounted last, after the 404 handler):

| Condition | Status | Response |
|---|---|---|
| Multer file too large | 400 | `File too large. Maximum 5 MB allowed.` |
| Multer invalid file type | 400 | The multer error message (JPEG/PNG/WebP only) |
| Body-parser payload too large | 413 | Guidance to use multipart under 5 MB |
| Invalid/expired JWT (`JsonWebTokenError`/`TokenExpiredError`) | 401 | `Invalid or expired token` |
| MySQL duplicate key (`ER_DUP_ENTRY` / errno 1062) | 409 | `Resource already exists (duplicate value)` |
| MySQL FK violation (`ER_NO_REFERENCED_ROW_2`/`ER_ROW_IS_REFERENCED_2` / errno 1452/1451) | 400 | `Referenced resource does not exist` |
| Everything else | `err.status`/`err.statusCode` or 500 | The error's own message, except in production where a 500 is always generalized to `Internal server error` (never leaks internals) |
| Unmatched route | 404 | `Route <METHOD> <path> not found` |

Controllers generally use explicit `try/catch` with their own status codes for expected validation/business-rule failures (400/401/404/409), and either `next(error)` or an uncaught throw for unexpected failures, which the global handler catches. Database transaction blocks (`getClient()`-based) always `ROLLBACK` in their `catch` before re-throwing or returning an error response — no code path commits a partial transaction.

---

## 28. Transactions & Data Safety

- **Database transactions**: every multi-statement write that must succeed or fail atomically (order finalization, subscription renewal, bulk-order-to-order conversion, package-cycle creation, return/refund state changes) uses `getClient()` + explicit `BEGIN`/`COMMIT`/`ROLLBACK`, never the pooled `query()` helper for multi-step writes.
- **Row locking**: `SELECT ... FOR UPDATE` is used consistently before a conditional write that must not race — order rows during payment verification/webhook, `package_purchases` rows during cycle creation, product rows during stock deduction, atomic counter rows when issuing the next order/bulk-booking/package number.
- **Idempotency**: enforced at multiple layers — application-level pre-checks (`payment_status`/`razorpay_payment_id` already set → short-circuit success), row locks to close the race window, and database-level unique constraints/indexes as a last-resort backstop (`package_purchases.origin_order_id`, `orders(parent_package_id, fulfillment_cycle)`).
- **Duplicate order prevention**: both the client-side `verify` call and the server-side webhook can race to finalize the same payment — both take the row lock and both check `payment_status === 'paid'` before writing, so whichever arrives second is a no-op success, not a duplicate write.
- **Duplicate fulfillment prevention**: see [§18](#18-package-idempotency) — the unique `(parent_package_id, fulfillment_cycle)` index is the hard backstop behind the row-lock/re-validate pattern.
- **Refund idempotency**: see [§24](#24-razorpay-refunds) — a refund is only ever created once per order; subsequent calls recheck the existing Razorpay refund instead.
- **Shipment creation rollback**: `admin/orderController` and `shippingController` wrap the DB-side status transition in the same transaction as the shipment-creation attempt where applicable, and never mark an order `shipped` if the Delhivery API call itself failed.

---

## 29. Cron Jobs

All started from `src/server.js`, only after the initial `SELECT 1` database connectivity check succeeds.

| File | Schedule | Purpose |
|---|---|---|
| `cron/packageFulfillmentCron.js` | `0 3 * * *` (daily, 3:00 AM, `Asia/Kolkata`) | Finds `package_purchases` rows due for their next cycle and creates the next fulfillment order for each (see [§17](#17-package-fulfillment-cron)) |
| `cron/shippingTrackingCron.js` | `*/30 * * * *` (every 30 minutes) | Syncs live Delhivery tracking status for every order with an AWB not yet in a terminal tracking state; updates `tracking_status`/`order_status`, appends `order_status_history`, sends out-for-delivery/delivered emails |
| Inline in `server.js` (`otpCleanupJob.js`) | `0 * * * *` (hourly, on the hour) | Deletes expired rows from `otp_verifications` |

No other cron/scheduled jobs exist in the codebase.

---

## 30. Development Setup

Commands below are exactly what's defined in `package.json` — no others exist.

```bash
# Install dependencies
npm install

# Development server (auto-restart via nodemon)
npm run dev

# Production start
npm start

# Run the MySQL schema migration
npm run migrate

# Seed initial data (admin account, etc.) — run AFTER migrate
npm run seed
```

There is no `npm run build` — this is a plain Node.js server with no compilation step.

**Setup steps:**

1. `cd bree-backend`
2. `npm install`
3. Copy `.env.example` to `.env` and fill in real values (see [§5](#5-environment-variables))
4. Provision a MySQL database and set `DATABASE_URL` (or the discrete `DB_*` vars)
5. Configure the required third-party services: Razorpay keys, a Firebase service-account JSON (see [§7](#7-authentication)/[§32](#32-third-party-services)), Cloudinary credentials, SMTP credentials, Waplify credentials, Delhivery credentials, and the `WAREHOUSE_*` pickup-address values
6. `npm run migrate` (initial schema), then `npm run seed` (admin account)
7. `npm run dev` (or `npm start` for production)

Node.js version is pinned in `package.json` → `engines`: Node `20.x`, npm `>=10.0.0`.

---

## 31. Database Initialization / Migrations

Two complementary mechanisms:

1. **Idempotent startup "ensure" migrations** (`src/config/database.js`) — a series of `ensure*` functions, each checking `information_schema` before adding only what's missing, executed in sequence every time the server boots. This is how schema changes (new columns/tables — Bulk Order address fields, return/refund columns, package-fulfillment tables, etc.) are rolled out: they simply ship in code and self-apply on the next deploy/restart. Never destructive — only `CREATE TABLE IF NOT EXISTS`/`ADD COLUMN IF (column missing)` style operations, no `DROP`s.
2. **One-time setup scripts** (`migrations/` directory): `mysql-migrate.js`/`migrate.js` for initial schema creation from scratch, and `seed.js` (run after migrate) to create the initial admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD`. `mysql-schema.sql` is a reference schema dump. `migrations/populate_recommendations.sql` seeds product-recommendation data.

There are no destructive migration commands documented or present — the only scripts available are additive (`npm run migrate`, `npm run seed`).

---

## 32. Third-Party Services

| Service | Purpose | Required Configuration |
|---|---|---|
| MySQL | Primary data store | `DATABASE_URL` or `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` |
| Razorpay | Payments — Orders, Magic Checkout, Subscriptions, Refunds, webhooks | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Firebase Admin SDK | Verifying Google Sign-In ID tokens | `GOOGLE_APPLICATION_CREDENTIALS` (path to a service-account JSON file — the active code path; see [§7](#7-authentication)) |
| Cloudinary | Product image storage/CDN | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_FOLDER` |
| SMTP (Nodemailer) | Transactional email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Waplify | WhatsApp notifications (order/bulk/subscription/return/OTP) | `WAPLIFY_BASE_URL`, `WAPLIFY_API_KEY`, `WAPLIFY_TEMPLATE_*`, `WAPLIFY_OTP_TEMPLATE` |
| Meta WhatsApp Cloud API | Inbound webhook receiver only | `META_VERIFY_TOKEN` |
| Delhivery | Shipping — shipment creation, tracking, pickup, labels, reverse shipments | `DELHIVERY_BASE_URL`, `DELHIVERY_API_TOKEN`, `DELHIVERY_TIMEOUT` (optional) |
| Warehouse config | Pickup/origin address for all Delhivery shipments | `WAREHOUSE_NAME`, `WAREHOUSE_ADDRESS`, `WAREHOUSE_CITY`, `WAREHOUSE_STATE`, `WAREHOUSE_PINCODE`, `WAREHOUSE_COUNTRY`, `WAREHOUSE_PHONE`, `WAREHOUSE_GST` |

No credentials are shown above — names only.

---

## 33. Security

Actual mechanisms present in this codebase:

- **Two independent JWT auth systems** — customer (`JWT_SECRET`, `auth`/`optionalAuth` middleware) and admin (`ADMIN_JWT_SECRET`, `adminAuth` middleware) — with separate cookies (`auth_token`/`refresh_token` vs `admin_auth_token`) and separate database tables (`users` vs `admins`).
- **Password hashing**: `bcryptjs` (12 salt rounds for OTPs; admin passwords hashed the same way, compared via `bcrypt.compare`).
- **CORS**: explicit origin allow-list built from `FRONTEND_URL` (comma-separated) plus localhost dev origins, with Razorpay's own domains additionally allowed (needed for its checkout/webhook origin); `credentials: true`.
- **Helmet**: security headers applied globally (`crossOriginResourcePolicy: cross-origin`, CSP disabled — no inline CSP policy is configured).
- **Rate limiting**: general `/api` limiter (200 req/min/IP), a stricter limiter on auth-sensitive routes (20 req/15min), a dedicated admin-login limiter (10 req/15min), and a dedicated payment-endpoint limiter (20 req/15min on `create-order`/`verify`, explicitly skipping Magic Checkout's preflight `OPTIONS` request).
- **Input validation**: `express-validator` on auth routes (mobile/OTP format, password rules); controllers additionally validate request shape/business rules inline (e.g. cart item shape, subscription item validation, return-window eligibility).
- **Authorization**: route-level middleware gates every mutating endpoint; several controllers additionally re-check resource ownership (e.g. `GET /api/orders/:id` only returns a match when `user_id = req.user.id OR user_id IS NULL`, so an authenticated user can never fetch another user's order by id).
- **Webhook verification**: the Razorpay webhook (`POST /api/payment/webhook`) verifies an HMAC signature (`verifyWebhookSignature`, `RAZORPAY_WEBHOOK_SECRET`) against the **raw** request body (specifically preserved via a dedicated `express.raw()` middleware mounted before the JSON parser) before processing any event.
- **Razorpay payment/order signature verification**: `verifyPaymentSignature` (`utils/razorpay.js`) validates every client-reported payment against Razorpay's own HMAC before the backend trusts it — used identically for normal checkout, subscriptions, and Bulk Orders.
- **Secret management**: all credentials are read from environment variables (or, for Firebase, a service-account JSON file path) — no secret is hardcoded in source; `.env.example` contains placeholders only.

---

## 34. Deployment

- **Runtime**: plain Node.js (`node src/server.js` / `npm start`) — no build step, no bundler. `engines.node = "20.x"` in `package.json` pins the expected Node version.
- **Trust proxy**: `app.set("trust proxy", 1)` is set (both in `app.js` and again in `server.js`) — required when running behind a load balancer/reverse proxy (the code comments explicitly reference Render/Railway/Heroku-style platforms) so `req.ip` and rate limiting resolve the real client IP correctly. There is no platform-specific config file (no `render.yaml`, `Procfile`, `Dockerfile`, etc.) present in this repository — deploy target is whatever Node.js host is configured to run `npm start` with the required environment variables set.
- **Environment variables**: all variables in [§5](#5-environment-variables) must be set on the hosting platform before start.
- **Start command**: `npm start` (production) or `npm run dev` (development, via `nodemon`).
- **Build command**: none — there is nothing to compile/bundle.
- **Cron configuration**: no external scheduler is required — `node-cron` jobs run in-process and start automatically inside `server.js` once the app boots and the database is reachable (see [§29](#29-cron-jobs)). This means the process must be a **long-running** service (not a serverless/on-demand function) for the cron jobs to fire.
- **API base URL / CORS**: the frontend's origin(s) must be listed in `FRONTEND_URL` (comma-separated for multiple environments) so CORS allows it; the frontend's own `REACT_APP_BACKEND_URL` must point at this server's public URL.

---

## 35. API Flow Diagrams

**Normal Payment**

```
Frontend → Backend (POST /api/payment/create-order)
        → Razorpay (Order created, Standard or Magic Checkout)
        → Frontend opens Razorpay Checkout, customer pays
        → Backend (POST /api/payment/verify) — signature + Razorpay payment fetch
             (also independently confirmed via POST /api/payment/webhook)
        → Order finalized (payment_status='paid', stock deducted)
        → Shipping (admin creates Delhivery shipment once ready_to_ship)
```

**Bulk Order**

```
Customer (authenticated) → POST /api/bulk-bookings (Enquiry Address)
        → Admin sets a Quote
        → Customer approves (POST .../approve-quote)
        → Magic Checkout opens (GET .../payment prepares the Razorpay Order)
        → Customer enters Shipping Address inside Magic Checkout
        → POST .../verify-payment — signature + payment fetch + Magic Checkout address fetch
        → Order created, using the Magic Checkout shipping address
```

**Recurring Package**

```
Initial Purchase (Cycle 1 = the origin order itself, payment verified)
        → Cron (daily, 3 AM IST) → Cycle 2 order created (no new payment)
        → Cron → Cycle 3 → ... → Final Cycle
        → package_purchases.status = 'completed'
```

**Return**

```
Delivered (delivered_at stamped)
        → 48-hour window
        → Admin: return/approve
        → Admin: return/reverse-shipment (Delhivery)
        → Admin: return/mark-returned
        → Admin: return/inspection/approve
        → Admin: refund/approve
        → Admin: refund/complete (Razorpay refund)
```

---

## 36. Troubleshooting

- **Server won't start**: check the console for `❌ Startup failed` / `❌ SERVER ERROR` — most often a missing/invalid `DATABASE_URL` or `DB_*` var (`config/database.js` throws synchronously if neither is configured), or a missing Firebase credential file (`config/firebaseAdmin.js` throws if no `GOOGLE_APPLICATION_CREDENTIALS`/`serviceAccountKey.json` is found).
- **Database connection errors**: `server.js` runs `SELECT 1` before starting any cron job and logs `⚠️ Database connection check failed; cron not started` if it fails — verify MySQL is reachable, credentials are correct, and the configured `DB_NAME` database actually exists.
- **Razorpay errors on checkout**: verify `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` match the same Razorpay account/mode (test vs. live) as the frontend's expectations; a 502 from `create-order`/`verify` usually means the Razorpay API call itself failed — check the logged `describeRazorpayError` details server-side.
- **Magic Checkout shipping-info callback failing**: `POST /api/payment/shipping-info` must be able to resolve the order — for Bulk Orders specifically, it falls back to matching `bulk_bookings` only when no `orders` row exists yet; confirm the Razorpay Order's `receipt`/id actually matches what was stored on the booking.
- **Webhook signature failures**: `RAZORPAY_WEBHOOK_SECRET` must exactly match what's configured in the Razorpay Dashboard for this endpoint; also confirm nothing upstream (a proxy, a body-parsing change) is mutating the raw request body before it reaches `express.raw()` — signature verification is computed against the exact raw bytes.
- **Delhivery shipment errors**: confirm `DELHIVERY_BASE_URL`/`DELHIVERY_API_TOKEN` are correct, and that all `WAREHOUSE_*` values are set — shipment creation validates the warehouse (pickup) address before calling Delhivery and fails fast with a clear message if it's incomplete.
- **WhatsApp notification failures**: these are always fire-and-forget/caught (`safelySendWhatsApp`) — a WhatsApp failure never fails the underlying request, but check `WAPLIFY_BASE_URL`/`WAPLIFY_API_KEY`/the relevant `WAPLIFY_TEMPLATE_*` var if messages simply aren't arriving.
- **SMTP errors**: email sends silently no-op with a console log if `SMTP_USER`/`SMTP_PASS` (or the recipient) are missing — check server logs for `"Skipping"`/send-failure lines rather than expecting a thrown error.
- **Cron not running**: crons only start after the initial DB check succeeds (see above); also confirm the process is a persistent long-running server, not a serverless/on-demand deployment, since `node-cron` requires the process to stay alive.
- **401 / authentication errors**: confirm the correct cookie/header is being sent — customer routes need `auth_token`/`Authorization: Bearer <accessToken>`; admin routes need `admin_auth_token`/`Authorization: Bearer <adminToken>` — the two are not interchangeable. A 401 on `/api/shipping/track/:awb` from a non-admin caller is expected: that route requires `adminAuth`.
- **CORS errors**: the calling origin must be present in `FRONTEND_URL` (or be a `*.razorpay.com`/`*.razorpay.in` origin, which is always allowed) — check the server log line `🚫 CORS blocked origin: ...` (non-production only) to see exactly what was rejected.
- **Environment variable changes not taking effect**: this app loads `.env` once at process start (`dotenv.config()` in both `server.js` and `config/database.js`) — restart the process after editing `.env`.

---

## 37. Important Business Rules

1. Subscription creation (`POST /api/subscriptions/create`) requires authentication; the purchaser is always the authenticated user, never a client-supplied id.
2. Bulk Order creation (`POST /api/bulk-bookings`) requires authentication.
3. The initial Bulk Order enquiry collects only one free-text address (`enquiry_address`) — no structured address fields are required at that stage.
4. Razorpay Magic Checkout collects the final shipping address for a Bulk Order, during payment.
5. Bulk Orders do not use an admin-generated payment link — the customer proceeds directly to payment after approving the quote.
6. One recurring-package payment covers all of that package's fulfillment cycles — no cycle after the first requires a new payment.
7. Cycle 1 of a recurring package is the original paid order itself, not a separately created order.
8. Later cycles (2+) are automatically created fulfillment orders, generated by the daily cron.
9. The recurring-package fulfillment interval is configurable per product (`package_fulfillment_interval_days`), not hardcoded.
10. The customer return window is 48 hours after delivery (`delivered_at + 48h`).
11. A reverse shipment is only created after admin approval of the return — no customer-facing endpoint creates one directly.
12. A refund can only be approved after the returned product passes inspection (`inspection_status = 'approved'`).
13. Refunds are processed through Razorpay's refund API (`payments.refund`), tied to the order's original `razorpay_payment_id`.
14. Return and refund operations are idempotent — re-approving, re-creating a reverse shipment, or re-completing a refund never duplicates the underlying action.
15. Payment verification always happens server-side (signature check + a direct fetch from Razorpay) — for normal checkout, subscriptions, and Bulk Orders alike; the frontend's own success callback is never trusted on its own.

Each rule above was verified directly against the current source code during this documentation pass.

---

## 38. Current Project Status

This backend currently implements, and has been verified (via direct source inspection) to implement:

- ✅ Dual authentication systems: customer (mobile OTP + Google/Firebase) and admin (email/password), both JWT + cookie based with refresh-token rotation for customers
- ✅ Full e-commerce order lifecycle: cart validation, checkout, payment verification, admin status management, Delhivery shipping, tracking sync
- ✅ Razorpay integration: Standard Checkout, Magic Checkout (cart and Bulk Order), Subscriptions, Refunds — all through one shared client
- ✅ Bulk Orders: authenticated enquiry → admin quote → customer approval → Razorpay Magic Checkout payment → automatic Order creation, with a single-field Enquiry Address distinct from the Magic-Checkout-collected final shipping address, and no admin payment-link step
- ✅ Subscriptions: authenticated creation, Razorpay-backed recurring billing, pause/resume/cancel, renewal-order creation via webhook
- ✅ Recurring Package fulfillment: one payment, admin-configurable cycle count/interval, cron-driven automatic creation of cycles 2+, with row-lock + unique-index-backed idempotency
- ✅ Delhivery shipping: forward shipment/pickup/tracking/label/cancel, and a reverse-shipment path reused for returns
- ✅ Order tracking with a 30-minute cron sync and full status history
- ✅ Returns/refunds: 48-hour server-enforced window, admin-only approval workflow, reverse shipment, inspection gate, Razorpay refund with idempotent recheck
- ✅ Email (Nodemailer/SMTP) and WhatsApp (Waplify) notifications across order, bulk, subscription, and return/refund events
- ✅ Admin API covering dashboard, orders, returns/refunds, products, bulk bookings, subscriptions + analytics, customers, inquiries, and testimonials
- ✅ Self-healing, idempotent database schema migrations that run automatically on every server start
- ✅ Three scheduled jobs: package fulfillment (daily), shipment tracking sync (every 30 min), OTP cleanup (hourly)

This section reflects the current implementation only, verified directly against the source code — it is not a historical changelog or QA audit log.
