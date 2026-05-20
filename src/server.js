import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import app from "./app.js";

/* -------------------------------------------------------------------------- */
/*                              LOAD ENV FILE                                 */
/* -------------------------------------------------------------------------- */

dotenv.config();

/* -------------------------------------------------------------------------- */
/*                                  PORT                                      */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 4000;

/* -------------------------------------------------------------------------- */
/*                              START SERVER                                  */
/* -------------------------------------------------------------------------- */

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Attach io to app for access in route handlers
app.locals.io = io;

const server = httpServer.listen(PORT, () => {
  console.log("\n=======================================");
  console.log("🚀 BREE BACKEND SERVER RUNNING");
  console.log("=======================================\n");

  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`🌿 ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(`💚 HEALTH: http://localhost:${PORT}/health`);
  console.log(`📡 Socket.IO: ws://localhost:${PORT}/socket.io`);

  console.log("\n=======================================\n");
});

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

/* -------------------------------------------------------------------------- */
/*                           HANDLE SERVER ERRORS                             */
/* -------------------------------------------------------------------------- */

server.on("error", (error) => {
  console.error("❌ SERVER ERROR:", error);
});
