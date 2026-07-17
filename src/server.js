import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import { startShippingTrackingCron } from "../cron/shippingTrackingCron.js";
import { cleanupExpiredOtps } from "./services/otpCleanupJob.js";

dotenv.config();

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
