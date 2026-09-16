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
  // FIX (ISSUE-028): this used to also assert the URL appears a second
  // time as separate, visible, copyable plain text (`>${expectedUrl}<`).
  // Inspected the actual template (orderEmailService.js's
  // buildPrimaryButton/buildActionSection): the tracking link has only
  // ever been rendered as a single styled CTA button
  // (`<a href="...">TRACK YOUR ORDER →</a>`) — every other link in every
  // other email template in this file (order confirmation, shipped,
  // delivered, subscription emails, etc.) follows the exact same
  // button-only pattern via the shared buildPrimaryButton/
  // buildSecondaryButton helpers, with no plain-text URL fallback
  // anywhere in the system. That's a deliberate, consistently-applied
  // design, not a regression — so the stale assertion is removed rather
  // than adding a plain-text URL line nothing else in the app has.
  //
  // What actually matters (and is still fully covered below): the button
  // links to the ONE correct, normalized tracking URL — not a malformed
  // one with FRONTEND_URL's own scheme+host duplicated into the path,
  // which is the exact bug this test was originally written to catch.
  assert.doesNotMatch(message.html, /breefit\.in\.https:\/\//);
  assert.doesNotMatch(message.html, /breefit\.in\/https:\/\//);
  assert.doesNotMatch(message.html, /https:\/\/[^\s"<]+https:\/\//);
  assert.doesNotMatch(
    message.html,
    /https:\/\/breefit\.in\.https:\/\/www\.breefit\.in/,
  );
  // Exactly one occurrence of the tracking URL in the whole email — never
  // duplicated across two different (and potentially inconsistent) spots.
  const occurrences = message.html.split(expectedUrl).length - 1;
  assert.equal(occurrences, 1);
});
