/**
 * Audit finding 5 — the order-status WAPLIFY template name differed between
 * the local .env (order_status_v2) and .env.example / docs
 * (order_status_update). order_status_v2 is the name evidenced as accepted
 * by WAPLIFY (docs/DAILY_REMINDER_END_TO_END_DEBUG_REPORT.md); the example,
 * docs and comments now agree. Production's value is NOT verified by this
 * test — it can only be checked in Hostinger hPanel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test(".env.example documents order_status_v2 as the order-status template", () => {
  const example = read("../.env.example");
  assert.match(example, /^WAPLIFY_TEMPLATE_ORDER_STATUS=order_status_v2$/m);
});

test("README, return-flow docs and the WhatsApp service no longer name order_status_update as the configured template", () => {
  for (const rel of ["../../README.md", "../../docs/Return_Order_Flow.md", "../src/services/whatsappNotificationService.js"]) {
    assert.doesNotMatch(read(rel), /order_status_update/, rel);
  }
});

test("the order-status template is a required, validated setting (startup fails fast when it is missing)", async () => {
  process.env.WAPLIFY_BASE_URL = "http://127.0.0.1:1";
  process.env.WAPLIFY_API_KEY = "wapl_test_only_key";
  const keys = [
    "WAPLIFY_TEMPLATE_ORDER_CONFIRMED",
    "WAPLIFY_TEMPLATE_ORDER_STATUS",
    "WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS",
    "WAPLIFY_TEMPLATE_PAYMENT_STATUS",
    "WAPLIFY_TEMPLATE_DAILY_REMINDER",
  ];
  for (const key of keys) process.env[key] = `${key.toLowerCase()}_test`;
  delete process.env.WAPLIFY_TEMPLATE_ORDER_STATUS;
  const { validateWhatsAppConfiguration } = await import(
    `../src/services/whatsappNotificationService.js?config-check=${Date.now()}`
  );
  assert.throws(() => validateWhatsAppConfiguration(), /WAPLIFY_TEMPLATE_ORDER_STATUS/);
});
