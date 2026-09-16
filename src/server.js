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

    // FIX (ISSUE-025 — no graceful shutdown): these cron handles used to be
    // discarded (cron.schedule()'s return value was never kept), so there
    // was no way to stop them cleanly on shutdown — collected here so the
    // shutdown handler below can call .stop() on each.
    const cronTasks = [];

    try {
      await query("SELECT 1");
      console.log("✅ Database connection verified");

      // Start Delhivery tracking cron
      cronTasks.push(startShippingTrackingCron());

      // Recurring package fulfillment cron (creates cycle 2+ orders)
      cronTasks.push(startPackageFulfillmentCron());

      // Daily wellness reminder cron (runs every minute to check for reminders)
      cronTasks.push(
        cron.schedule("* * * * *", () => {
          runDailyReminderScheduler().catch((err) => {
            console.error("[dailyReminderCron] Scheduler error:", err);
          });
        }),
      );
      console.log("💬 Daily reminder cron started (runs every minute)");

      // OTP cleanup cron (runs every hour)
      cronTasks.push(
        cron.schedule("0 * * * *", () => {
          cleanupExpiredOtps().catch((err) => {
            console.error("[otpCleanupJob] Failed to clean expired OTPs:", err);
          });
        }),
      );
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

    // FIX (ISSUE-025 — no graceful shutdown): every deploy/restart (PM2
    // restart, container stop, platform redeploy) used to kill the
    // process outright — no draining of in-flight HTTP requests, no DB
    // pool close, no cron stop — a request or transaction could be cut
    // mid-write during any routine deploy. Sequence: stop accepting new
    // HTTP connections (server.close() itself waits for in-flight
    // requests/keep-alive connections to finish before its callback
    // fires) -> stop cron jobs so no new background work starts -> close
    // Socket.IO -> close the DB pool -> exit. A hard timeout forces exit
    // if any step hangs (e.g. a client holding a keep-alive connection
    // open forever), so shutdown can never hang indefinitely.
    const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;
    let shuttingDown = false;

    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} received — starting graceful shutdown...`);

      const forceExitTimer = setTimeout(() => {
        console.error(
          "⚠️ Graceful shutdown did not complete in time — forcing exit",
        );
        process.exit(1);
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      forceExitTimer.unref();

      for (const task of cronTasks) {
        try {
          task?.stop();
        } catch (err) {
          console.error("Error stopping a cron task:", err);
        }
      }
      console.log("✅ Cron jobs stopped");

      await new Promise((resolve) => {
        server.close((err) => {
          if (err) console.error("Error closing HTTP server:", err);
          else console.log("✅ HTTP server closed (no new connections accepted)");
          resolve();
        });
      });

      await new Promise((resolve) => {
        io.close(() => {
          console.log("✅ Socket.IO closed");
          resolve();
        });
      });

      try {
        const { closePool } = await import("./config/database.js");
        await closePool();
        console.log("✅ Database pool closed");
      } catch (err) {
        console.error("Error closing database pool:", err);
      }

      console.log("👋 Graceful shutdown complete");
      clearTimeout(forceExitTimer);
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("❌ Startup failed:", err);
    // console.error(err.stack || err);
    process.exit(1);
  }
};

startServer();
