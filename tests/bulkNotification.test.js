import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBulkOrderQuoteReviewUrl,
  isBulkOrderInProgressTransition,
  notifyBulkOrderInProgress,
} from "../src/services/bulkNotificationService.js";

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
