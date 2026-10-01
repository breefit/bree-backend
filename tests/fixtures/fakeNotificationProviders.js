/**
 * Fake WAPLIFY (local HTTP server on 127.0.0.1) + mocked nodemailer, so the
 * REAL senders (sendTemplateMessage / sendEmail) run end to end without any
 * real message leaving the machine.
 *
 * MUST be started before the WhatsApp service is imported: that module reads
 * WAPLIFY_BASE_URL / template names at load time. Import application modules
 * dynamically after `await startFakeProviders()`.
 *
 * WAPLIFY modes (queue; the last one repeats): ok | 400 | 429 | 500_after
 * SMTP modes: ok | fail_4xx | fail_5xx | timeout
 */
import http from "node:http";
import { mock } from "node:test";
import nodemailer from "nodemailer";

export const startFakeProviders = async () => {
  const providers = {
    whatsapp: [], // accepted WAPLIFY payloads (what the customer receives)
    whatsappRequests: 0,
    whatsappModes: ["ok"],
    emails: [], // accepted nodemailer messages
    emailModes: ["ok"],
  };
  const next = (modes) => (modes.length > 1 ? modes.shift() : modes[0]);

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      providers.whatsappRequests += 1;
      const mode = next(providers.whatsappModes);
      const reply = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (mode === "ok") {
        providers.whatsapp.push(JSON.parse(body || "{}"));
        return reply(200, { status: "success", message_id: `wamid.${providers.whatsapp.length}` });
      }
      if (mode === "400") return reply(400, { message: "Template not approved" });
      if (mode === "429") return reply(429, { message: "Rate limit" });
      if (mode === "500_after") {
        providers.whatsapp.push(JSON.parse(body || "{}"));
        return reply(502, { message: "bad gateway" });
      }
      return reply(500, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  Object.assign(process.env, {
    WAPLIFY_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    WAPLIFY_API_KEY: "wapl_test_only_key",
    WAPLIFY_REQUEST_TIMEOUT_MS: "500",
    WAPLIFY_TEMPLATE_ORDER_STATUS: "order_status_test",
    WAPLIFY_TEMPLATE_ORDER_CONFIRMED: "order_confirmed_test",
    SMTP_USER: "test-sender@example.com",
    SMTP_PASSWORD: "test-only",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
    FRONTEND_URL: "https://www.breefit.in",
  });

  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (mail) => {
      const mode = next(providers.emailModes);
      if (mode === "fail_4xx") {
        throw Object.assign(new Error("451 Temporary local problem"), { responseCode: 451 });
      }
      if (mode === "fail_5xx") {
        throw Object.assign(new Error("550 Mailbox unavailable"), { responseCode: 550 });
      }
      if (mode === "timeout") {
        throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
      }
      providers.emails.push(mail);
      return { messageId: `email.${providers.emails.length}` };
    },
  }));

  providers.reset = () => {
    providers.whatsapp = [];
    providers.whatsappRequests = 0;
    providers.whatsappModes = ["ok"];
    providers.emails = [];
    providers.emailModes = ["ok"];
  };
  providers.stop = async () => {
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
  };
  // Everything a customer received, as one string — for "never contains" checks.
  providers.allCustomerContent = () =>
    JSON.stringify(providers.whatsapp) +
    providers.emails.map((m) => `${m.subject}\n${m.html}`).join("\n");
  return providers;
};
