import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ISSUE-025 — No graceful shutdown handling.
 *
 * server.js had no SIGTERM/SIGINT handler at all — every deploy/restart
 * (PM2 restart, container stop, platform redeploy) killed the process
 * outright, with no draining of in-flight requests, no cron stop, and no
 * DB pool close (pool.end() was never called anywhere in the repo).
 *
 * This is a REAL process-level integration test: it actually spawns
 * `node src/server.js` as a child process (NODE_ENV=test, so — per the
 * ISSUE-007 fix — DATABASE_URL/production is never touched; the DB
 * connectivity check fails fast against a poisoned local address, exactly
 * as verified manually during this fix), waits for it to report it's
 * listening, sends a real SIGTERM, and asserts the process actually exits
 * (not hangs) with the expected shutdown log sequence.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/server.js");

const waitForOutput = (child, pattern, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern} in output. Got:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(buffer);
      }
    };
    child.stdout.on("data", onData);
  });

test("ISSUE-025: the server responds to SIGTERM with a real graceful shutdown and exits cleanly, not hanging", async () => {
  const port = 45999;
  const child = spawn("node", [serverPath], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let combinedOutput = "";
  child.stdout.on("data", (c) => (combinedOutput += c.toString()));
  child.stderr.on("data", (c) => (combinedOutput += c.toString()));

  try {
    await waitForOutput(child, /BREE BACKEND SERVER RUNNING/);

    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const start = Date.now();
    child.kill("SIGTERM");

    const raceResult = await Promise.race([
      exitPromise.then((result) => ({ ...result, timedOut: false })),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 8000)),
    ]);

    assert.equal(raceResult.timedOut, false, "process must exit on SIGTERM, not hang indefinitely");
    assert.equal(raceResult.code, 0, "graceful shutdown must exit with code 0");

    const elapsedMs = Date.now() - start;
    assert.ok(
      elapsedMs < 8000,
      `shutdown took ${elapsedMs}ms — must complete well before the process's own 10s force-exit timeout`,
    );

    assert.match(combinedOutput, /SIGTERM received — starting graceful shutdown/);
    assert.match(combinedOutput, /Cron jobs stopped/);
    assert.match(combinedOutput, /HTTP server closed/);
    assert.match(combinedOutput, /Socket\.IO closed/);
    assert.match(combinedOutput, /Database pool closed/);
    assert.match(combinedOutput, /Graceful shutdown complete/);

    // ISSUE-007 regression, verified in the same real run: production is
    // never touched even when the real server boots end-to-end.
    assert.doesNotMatch(combinedOutput, /auth-db1639\.hstgr\.io/);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});

// Runtime audit finding: with a browser socket connected, server.close()
// waited on the open WebSocket while io.close() (which would close it) only
// ran afterwards — every restart/deploy hung for the full 10s and exited 1,
// and connected clients sat on the dying process missing realtime updates.
test("graceful shutdown still completes cleanly (exit 0, well under 10s) while a Socket.IO client is connected", async () => {
  const { io: ioClient } = await import("socket.io-client");
  const port = 45998;
  const child = spawn("node", [serverPath], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let combinedOutput = "";
  child.stdout.on("data", (c) => (combinedOutput += c.toString()));
  child.stderr.on("data", (c) => (combinedOutput += c.toString()));
  let client;
  try {
    await waitForOutput(child, /BREE BACKEND SERVER RUNNING/);
    // reconnection ON, exactly like the frontend (lib/socket.js).
    client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 200,
      forceNew: true,
    });
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    const disconnected = new Promise((resolve) => client.once("disconnect", (reason) => resolve(reason)));
    const reconnectAttempted = new Promise((resolve) => client.io.once("reconnect_attempt", () => resolve(true)));

    const exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const start = Date.now();
    child.kill("SIGTERM");
    const result = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r("timeout"), 9000))]);
    const elapsedMs = Date.now() - start;

    assert.notEqual(result, "timeout", "process must not hang");
    assert.equal(result, 0, `exit code must be 0, not a forced exit. Output:\n${combinedOutput.slice(-600)}`);
    assert.ok(elapsedMs < 5000, `shutdown took ${elapsedMs}ms with a client connected`);
    assert.doesNotMatch(combinedOutput, /did not complete in time/);
    // Must look like a transport loss, NOT "io server disconnect": after a
    // server-initiated disconnect Socket.IO clients never auto-reconnect,
    // so every open admin/customer tab would silently stop receiving
    // realtime updates after a deploy.
    assert.equal(await disconnected, "transport close");
    assert.equal(
      await Promise.race([reconnectAttempted, new Promise((r) => setTimeout(() => r(false), 3000))]),
      true,
      "the client automatically tries to reconnect (to the replacement process)",
    );
  } finally {
    client?.close();
    if (!child.killed) child.kill("SIGKILL");
  }
});

// Runtime audit finding: browsers open "preconnect" TCP connections that
// never send a request. Node's server.close() neither treats those as idle
// nor closes them, so shutdown hung until the 10s force-exit (exit code 1).
test("graceful shutdown completes (exit 0, bounded drain) while a browser-style preconnected socket is open", async () => {
  const net = await import("node:net");
  const port = 45996;
  const child = spawn("node", [serverPath], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let combinedOutput = "";
  child.stdout.on("data", (c) => (combinedOutput += c.toString()));
  child.stderr.on("data", (c) => (combinedOutput += c.toString()));
  let preconnect;
  try {
    await waitForOutput(child, /BREE BACKEND SERVER RUNNING/);
    preconnect = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(s));
    });
    preconnect.on("error", () => {});
    const exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const start = Date.now();
    child.kill("SIGTERM");
    const result = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r("timeout"), 9500))]);
    const elapsedMs = Date.now() - start;
    assert.notEqual(result, "timeout");
    assert.equal(result, 0, `forced exit instead of graceful. Output:\n${combinedOutput.slice(-500)}`);
    assert.ok(elapsedMs < 8000, `shutdown took ${elapsedMs}ms`);
    assert.match(combinedOutput, /Graceful shutdown complete/);
  } finally {
    preconnect?.destroy();
    if (!child.killed) child.kill("SIGKILL");
  }
});
