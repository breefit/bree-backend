import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import nodemailer from "nodemailer";
import { sendOrderStatusUpdateEmail } from "../src/services/orderEmailService.js";

test("order status email uses one normalized absolute tracking URL", async () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousSmtpUser = process.env.SMTP_USER;
  const previousSmtpPass = process.env.SMTP_PASS;
  let message;

  process.env.FRONTEND_URL = "https://breefit.in/https://www.breefit.in/";
  process.env.SMTP_USER = "test@example.com";
  process.env.SMTP_PASS = "test-password";
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (mail) => {
      message = mail;
    },
  }));

  try {
    await sendOrderStatusUpdateEmail({
      to: "customer@example.com",
      name: "Customer",
      orderId: "order-123",
      status: "shipped",
    });
  } finally {
    mock.restoreAll();
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
    if (previousSmtpUser === undefined) {
      delete process.env.SMTP_USER;
    } else {
      process.env.SMTP_USER = previousSmtpUser;
    }
    if (previousSmtpPass === undefined) {
      delete process.env.SMTP_PASS;
    } else {
      process.env.SMTP_PASS = previousSmtpPass;
    }
  }

  const expectedUrl = "https://www.breefit.in/order/order-123/tracking";
  assert.match(message.html, new RegExp(`href="${expectedUrl}"`));
  assert.match(message.html, new RegExp(`>${expectedUrl}<`));
  assert.doesNotMatch(message.html, /breefit\.in\.https:\/\//);
  assert.doesNotMatch(message.html, /breefit\.in\/https:\/\//);
  assert.doesNotMatch(message.html, /https:\/\/[^\s"<]+https:\/\//);
  assert.doesNotMatch(
    message.html,
    /https:\/\/breefit\.in\.https:\/\/www\.breefit\.in/,
  );
});
