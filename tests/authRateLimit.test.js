import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableWhatsAppStatus } from "../src/services/whatsappService.js";

test("does not retry an upstream 429 during OTP delivery", () => {
  assert.equal(isRetryableWhatsAppStatus(429), false);
});

test("still retries transient upstream server failures", () => {
  assert.equal(isRetryableWhatsAppStatus(503), true);
});
