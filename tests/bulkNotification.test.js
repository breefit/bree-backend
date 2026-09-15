import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildBulkOrderQuoteReviewUrl,
  isBulkOrderInProgressTransition,
  notifyBulkOrderInProgress,
  notifyQuoteReady,
} from "../src/services/bulkNotificationService.js";
import { transporter } from "../src/services/email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bulkNotificationSource = fs.readFileSync(
  path.join(__dirname, "../src/services/bulkNotificationService.js"),
  "utf8",
);

/** Runs `notifyFn` with transporter.sendMail mocked, returning the captured mail. */
const captureEmail = async (notifyFn) => {
  const previousTemplate = process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;
  delete process.env.WAPLIFY_TEMPLATE_BULK_UPDATE; // no real WhatsApp send
  let captured = null;
  mock.method(transporter, "sendMail", async (mail) => {
    captured = mail;
    return { messageId: "test" };
  });

  try {
    await notifyFn();
  } finally {
    mock.restoreAll();
    if (previousTemplate === undefined) {
      delete process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;
    } else {
      process.env.WAPLIFY_TEMPLATE_BULK_UPDATE = previousTemplate;
    }
  }

  return captured;
};

test("bulk quote review URL is canonical and independent of frontend URL lists", () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://breefit.in,https://www.breefit.in";

  try {
    assert.equal(
      buildBulkOrderQuoteReviewUrl("3e6f3af5-6a2a-422d-8ac1-12c4909e935d"),
      "https://www.breefit.in/bulk-order/3e6f3af5-6a2a-422d-8ac1-12c4909e935d/",
    );
  } finally {
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});

test("bulk In Progress notification is transition-based", () => {
  assert.equal(isBulkOrderInProgressTransition("new", "in_progress"), true);
  assert.equal(
    isBulkOrderInProgressTransition("in_progress", "in_progress"),
    false,
  );
  assert.equal(isBulkOrderInProgressTransition("in_progress", "quoted"), false);
});

test("bulk In Progress notification safely handles missing contacts", async () => {
  const previousTemplate = process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;
  delete process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;

  try {
    await assert.doesNotReject(
      notifyBulkOrderInProgress({
        bookingId: "3e6f3af5-6a2a-422d-8ac1-12c4909e935d",
        bookingNumber: "BB-100001",
        contactPerson: "Customer",
      }),
    );
  } finally {
    if (previousTemplate === undefined) {
      delete process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;
    } else {
      process.env.WAPLIFY_TEMPLATE_BULK_UPDATE = previousTemplate;
    }
  }
});

const bookingId = "3e6f3af5-6a2a-422d-8ac1-12c4909e935d";
const expectedUrl = buildBulkOrderQuoteReviewUrl(bookingId);

test("In Progress email does NOT contain the bulk-order URL", async () => {
  const mail = await captureEmail(() =>
    notifyBulkOrderInProgress({
      email: "customer@example.com",
      bookingId,
      bookingNumber: "BB-100005",
      contactPerson: "Pavan Veguru",
      deliveryDate: "2026-09-20",
    }),
  );

  assert.ok(mail, "expected an email to be sent");
  assert.doesNotMatch(mail.html, /bulk-order\//);
  assert.doesNotMatch(mail.html, new RegExp(expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Unrelated content must be unchanged.
  assert.match(mail.html, /BB-100005/);
  assert.match(mail.html, /In Progress/);
});

test("In Progress WhatsApp notification does NOT pass the bulk-order URL", () => {
  // Real Waplify send isn't exercised in tests (see captureEmail / the
  // existing "safely handles missing contacts" test above) — this proves
  // the fix at the source: notifyBulkOrderInProgress must never pass
  // quoteReviewUrl (or any bulk-order/ URL) as the WhatsApp `details` param.
  const fnSource = bulkNotificationSource.slice(
    bulkNotificationSource.indexOf("export const notifyBulkOrderInProgress"),
    bulkNotificationSource.indexOf("export const notifyQuoteReady"),
  );
  assert.match(fnSource, /details:\s*""/);
  assert.doesNotMatch(fnSource, /details:\s*quoteReviewUrl/);
  assert.doesNotMatch(fnSource, /buildBulkOrderQuoteReviewUrl/);
});

test("Quote Ready email DOES contain the bulk-order URL, quote amount, and estimated delivery", async () => {
  const deliveryDate = "Thu Sep 17 2026 18:30:00 GMT+0000 (Coordinated Universal Time)";
  const mail = await captureEmail(() =>
    notifyQuoteReady({
      email: "customer@example.com",
      bookingId,
      contactPerson: "Pavan Veguru",
      quotePrice: 1,
      deliveryDate,
    }),
  );

  assert.ok(mail, "expected an email to be sent");
  assert.match(mail.html, new RegExp(expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(mail.html, /₹1/); // formatINR(1)
  assert.match(mail.html, new RegExp(deliveryDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Quote Ready WhatsApp notification DOES pass the bulk-order URL, with quote amount and delivery date in the message", () => {
  const fnSource = bulkNotificationSource.slice(
    bulkNotificationSource.indexOf("export const notifyQuoteReady"),
    bulkNotificationSource.indexOf("export const notifyBulkOrderConfirmation"),
  );
  assert.match(fnSource, /details:\s*quoteReviewUrl/);
  assert.match(fnSource, /Quote amount: \$\{formatINR\(quotePrice\)\}/);
  assert.match(fnSource, /Estimated delivery: \$\{deliveryDate\}/);
});

test("the bulk-order URL used everywhere is the correct one for the given booking id", () => {
  assert.equal(
    expectedUrl,
    `https://www.breefit.in/bulk-order/${bookingId}/`,
  );
});

test("other bulk-order notification statuses are unaffected by the In Progress URL fix", () => {
  // Confirmed, Dispatched, and Cancelled never included the quote review
  // URL before this change and must not gain it now — none of these
  // should reference buildBulkOrderQuoteReviewUrl or quoteReviewUrl.
  for (const [start, end] of [
    ["export const notifyBulkOrderConfirmation", "export const notifyBulkDispatch"],
    ["export const notifyBulkDispatch", "export const notifyBulkCancelled"],
    ["export const notifyBulkCancelled", undefined],
  ]) {
    const fnSource = end
      ? bulkNotificationSource.slice(
          bulkNotificationSource.indexOf(start),
          bulkNotificationSource.indexOf(end),
        )
      : bulkNotificationSource.slice(bulkNotificationSource.indexOf(start));
    assert.doesNotMatch(fnSource, /quoteReviewUrl/);
    assert.doesNotMatch(fnSource, /buildBulkOrderQuoteReviewUrl/);
  }
});
