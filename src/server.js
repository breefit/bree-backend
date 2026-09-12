import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import { startShippingTrackingCron } from "../cron/shippingTrackingCron.js";
import { startPackageFulfillmentCron } from "../cron/packageFulfillmentCron.js";
import { runDailyReminderScheduler } from "../cron/dailyReminderCron.js";
import { cleanupExpiredOtps } from "./services/otpCleanupJob.js";
import { getSafeRazorpayConfig } from "./config/razorpay.js";
import { validateWhatsAppConfiguration } from "./services/whatsappNotificationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const preloadedRazorpayEnv = {
  keyId: Boolean(process.env.RAZORPAY_KEY_ID),
  keySecret: Boolean(process.env.RAZORPAY_KEY_SECRET),
};
const dotenvResult = dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const razorpayEnvSource =
  preloadedRazorpayEnv.keyId && preloadedRazorpayEnv.keySecret
    ? "process environment (Hostinger/PM2)"
    : dotenvResult.parsed?.RAZORPAY_KEY_ID &&
        dotenvResult.parsed?.RAZORPAY_KEY_SECRET
      ? "backend .env fallback"
      : "mixed or missing sources";

console.info("[RAZORPAY] runtime configuration", {
  nodeEnv: process.env.NODE_ENV || "development",
  envSource: razorpayEnvSource,
  dotenvLoaded: Boolean(dotenvResult.parsed),
  ...getSafeRazorpayConfig(),
});

// FIX (Shipped/OFD/Delivered WhatsApp investigation): validateWhatsAppConfiguration()
// already existed (checks WAPLIFY_BASE_URL, WAPLIFY_API_KEY, and every
// WAPLIFY_TEMPLATE_* env var, including WAPLIFY_TEMPLATE_ORDER_STATUS — the
// exact template order-status WhatsApp notifications use) but was never
// called anywhere. A missing/misconfigured template previously failed
// silently at the first real send attempt, deep inside a try/catch, with
// no way to tell "misconfigured" apart from "provider outage" from the
// logs alone. Non-fatal by design — a WhatsApp config problem must never
// stop the API/payment/tracking server from starting.
try {
  validateWhatsAppConfiguration();
  console.info("[WAPLIFY] runtime configuration OK", {
    nodeEnv: process.env.NODE_ENV || "development",
  });
} catch (waplifyConfigError) {
  console.error(
    "[WAPLIFY] runtime configuration INVALID — WhatsApp sends will fail until this is fixed:",
    waplifyConfigError?.message || waplifyConfigError,
  );
}

// console.log("STEP 1 - Server file loaded");
// console.log("STEP 4 - Environment variables loaded");
// console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);
// console.log("FRONTEND_URL exists:", !!process.env.FRONTEND_URL);
// console.log("JWT_SECRET exists:", !!process.env.JWT_SECRET);

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const PORT = process.env.PORT || 4000;

const startServer = async () => {
  try {
    const { default: app } = await import("./app.js");
    const { query } = await import("./config/database.js");

    try {
      await query("SELECT 1");
      console.log("✅ Database connection verified");

      // Start Delhivery tracking cron
      startShippingTrackingCron();

      // Recurring package fulfillment cron (creates cycle 2+ orders)
      startPackageFulfillmentCron();

      // Daily wellness reminder cron (runs every minute to check for reminders)
      cron.schedule("* * * * *", () => {
        runDailyReminderScheduler().catch((err) => {
          console.error("[dailyReminderCron] Scheduler error:", err);
        });
      });
      console.log("💬 Daily reminder cron started (runs every minute)");

      // OTP cleanup cron (runs every hour)
      cron.schedule("0 * * * *", () => {
        cleanupExpiredOtps().catch((err) => {
          console.error("[otpCleanupJob] Failed to clean expired OTPs:", err);
        });
      });
      console.log("🧹 OTP cleanup cron started (runs every hour)");
    } catch (dbErr) {
      console.error(
        "⚠️ Database connection check failed; cron not started",
        dbErr,
      );
    }

    app.set("trust proxy", 1);
    const httpServer = createServer(app);

    const frontendUrls = (process.env.FRONTEND_URL || "http://localhost:3000")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);

    const allowedOrigins = [
      ...new Set([
        ...frontendUrls,
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
      ]),
    ].map((origin) => origin.replace(/\/$/, ""));

    const io = new Server(httpServer, {
      cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
      },
    });

    // Attach io to app for access in route handlers
    app.locals.io = io;

    // console.log("STEP 8 - Starting HTTP server");
    const server = httpServer.listen(PORT, () => {
      console.log("STEP 9 - Server listening");
      console.log("\n=======================================");
      console.log("🚀 BREE BACKEND SERVER RUNNING");
      console.log("=======================================\n");

      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`🌿 ENV: ${process.env.NODE_ENV || "development"}`);
      console.log(`💚 HEALTH: http://localhost:${PORT}/health`);
      console.log(`📡 Socket.IO: ws://localhost:${PORT}/socket.io`);

      console.log("\n=======================================\n");
    });

    server.on("error", (error) => {
      console.error("❌ SERVER ERROR:", error);
      process.exit(1);
    });

    io.on("connection", (socket) => {
      // console.log(`✅ Client connected: ${socket.id}`);
      socket.on("disconnect", () => {
        // console.log(`❌ Client disconnected: ${socket.id}`);
      });
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    // console.error(err.stack || err);
    process.exit(1);
  }
};

startServer();
