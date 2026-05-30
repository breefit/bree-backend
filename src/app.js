import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRouter from "./routes/auth.js";
import {
  productRouter,
  orderRouter,
  paymentRouter,
  profileRouter,
  addressRouter,
  contactRouter,
  testimonialRouter,
} from "./routes/index.js";
import adminRouter from "./routes/admin/index.js";
import errorHandler from "./middleware/errorHandler.js";

console.log("STEP 2 - App file loaded");

const app = express();

// Serve simple static images used as fallbacks by frontend (e.g. /images/default-product.png)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use("/images", express.static(path.join(__dirname, "../public/images")));

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const frontendUrls = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...new Set([
    ...frontendUrls,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]),
].map((origin) => origin.replace(/\/$/, ""));

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    const normalized = origin.replace(/\/$/, "");
    if (allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS policy: Origin not allowed - ${origin}`),
      false,
    );
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// ── Logging ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}

// ── Body parsers ──────────────────────────────────────────────────────────────
// Use raw body for Razorpay webhooks to allow signature verification against
// the original bytes. This must be mounted before the JSON body parser.
app.use(
  "/api/payment/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    // Preserve raw body for the webhook handler while allowing later
    // middleware to use parsed JSON for other routes.
    req.rawBody = req.body;
    next();
  },
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests. Please slow down." },
  }),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: "Too many auth attempts. Try again in 15 minutes." },
});
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/change-password", authLimiter);

// ── API Routes ────────────────────────────────────────────────────────────────
try {
  app.use("/api/auth", authRouter);
  app.use("/api/products", productRouter);
  app.use("/api/orders", orderRouter);
  app.use("/api/payment", paymentRouter);
  app.use("/api/profile", profileRouter);
  app.use("/api/addresses", addressRouter);
  app.use("/api/contact", contactRouter);
  app.use("/api/testimonials", testimonialRouter);
  app.use("/api/admin", adminRouter);

  console.log("STEP 7 - Routes loaded");
} catch (err) {
  console.error("❌ App route setup failed:", err);
  throw err;
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", env: process.env.NODE_ENV }),
);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) =>
  res
    .status(404)
    .json({ message: `Route ${req.method} ${req.originalUrl} not found` }),
);

// ── Global error handler (last!) ─────────────────────────────────────────────
app.use(errorHandler);

export default app;
