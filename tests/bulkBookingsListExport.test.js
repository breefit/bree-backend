import test from "node:test";
import assert from "node:assert/strict";
import { getBulkBookings } from "../src/controllers/bulkController.js";

/**
 * ISSUE-020 — Bulk-order CSV export truncated to 50 rows, and
 * ISSUE-021 — Bulk-order status/date filters ignored by the backend.
 *
 * BulkOrders.js's CSV export (client-side CSV building) requests
 * limit=5000 from this exact endpoint to fetch "the complete filtered
 * dataset", and both the list view and export send status/date filters —
 * neither was ever honored: limit was hard-capped at 50 (silently
 * truncating any export beyond that), and status/date were read by the
 * frontend but never referenced in the backend WHERE clause at all.
 *
 * This drives the REAL getBulkBookings handler against a fake queryFn
 * that models a bookings table with real WHERE-clause filtering and real
 * LIMIT/OFFSET pagination, so the fix is proven behaviorally: filters
 * actually narrow the result set, and a large limit is satisfied via a
 * bounded multi-round-trip loop rather than a single unbounded query.
 */

const makeReqRes = (query) => {
  const req = { query };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
};

const makeBooking = (i, overrides = {}) => ({
  id: `booking-${i}`,
  bulk_booking_number: `BULK-${1000 + i}`,
  company_name: `Company ${i}`,
  contact_person: `Contact ${i}`,
  email: `contact${i}@example.com`,
  mobile_number: "9876543210",
  status: "new",
  created_at: new Date(Date.UTC(2026, 0, 1 + (i % 5))),
  ...overrides,
});

/**
 * A real in-memory filter+paginate implementation, driven through the
 * exact SQL statement shapes getBulkBookings issues — a faithful enough
 * model of MySQL's WHERE/LIMIT/OFFSET behavior to prove the fix, without
 * touching a real database (see ISSUE-007 — no test DB is configured).
 */
const createFakeBulkBookingsQueryFn = (allBookings) => async (sql, params = []) => {
  const normalized = sql.replace(/\s+/g, " ").trim();

  // Reconstruct which filters are active from the parameter count/shape —
  // simpler and just as faithful here as re-parsing the WHERE clause: the
  // handler always builds params in the same order (search x6, then
  // status, then date, then LIMIT/OFFSET or COUNT-only).
  const hasSearch = normalized.includes("bulk_booking_number LIKE ?");
  const hasStatus = normalized.includes("AND status = ?");
  const hasDate = normalized.includes("AND DATE(created_at) = ?");

  let cursor = 0;
  let searchTerm = null;
  if (hasSearch) {
    searchTerm = params[cursor].replace(/%/g, "");
    cursor += 6;
  }
  let statusValue = null;
  if (hasStatus) {
    statusValue = params[cursor];
    cursor += 1;
  }
  let dateValue = null;
  if (hasDate) {
    dateValue = params[cursor];
    cursor += 1;
  }

  let filtered = allBookings.filter((b) => {
    if (searchTerm) {
      const haystack = [
        b.bulk_booking_number,
        b.id,
        b.company_name,
        b.contact_person,
        b.email,
        b.mobile_number,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm.toLowerCase())) return false;
    }
    if (statusValue && b.status !== statusValue) return false;
    if (dateValue && b.created_at.toISOString().slice(0, 10) !== dateValue) return false;
    return true;
  });

  filtered = [...filtered].sort((a, b) => b.created_at - a.created_at);

  if (normalized.startsWith("SELECT COUNT(*)")) {
    return { rows: [{ total: filtered.length }] };
  }

  // LIMIT ? OFFSET ? are always the last two params.
  const limitValue = params[params.length - 2];
  const offsetValue = params[params.length - 1];
  return { rows: filtered.slice(offsetValue, offsetValue + limitValue) };
};

test("ISSUE-021: the status filter narrows results server-side (previously a silent no-op)", async () => {
  const bookings = [
    makeBooking(1, { status: "new" }),
    makeBooking(2, { status: "quoted" }),
    makeBooking(3, { status: "new" }),
  ];
  const { req, res } = makeReqRes({ status: "quoted", limit: 10, page: 1 });
  await getBulkBookings(req, res, { queryFn: createFakeBulkBookingsQueryFn(bookings) });

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].id, "booking-2");
  assert.equal(res.body.pagination.total, 1);
});

test("ISSUE-021: the date filter narrows results server-side by created_at calendar date (previously a silent no-op)", async () => {
  const bookings = [
    makeBooking(1, { created_at: new Date("2026-01-01T10:00:00Z") }),
    makeBooking(2, { created_at: new Date("2026-01-02T10:00:00Z") }),
  ];
  const { req, res } = makeReqRes({ date: "2026-01-02", limit: 10, page: 1 });
  await getBulkBookings(req, res, { queryFn: createFakeBulkBookingsQueryFn(bookings) });

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].id, "booking-2");
});

test("ISSUE-021: status and date filters combine (AND), and pagination totals reflect the FILTERED count, not the full table", async () => {
  const bookings = [
    makeBooking(1, { status: "quoted", created_at: new Date("2026-01-02T10:00:00Z") }),
    makeBooking(2, { status: "quoted", created_at: new Date("2026-01-01T10:00:00Z") }),
    makeBooking(3, { status: "new", created_at: new Date("2026-01-02T10:00:00Z") }),
  ];
  const { req, res } = makeReqRes({ status: "quoted", date: "2026-01-02", limit: 10, page: 1 });
  await getBulkBookings(req, res, { queryFn: createFakeBulkBookingsQueryFn(bookings) });

  assert.equal(res.body.pagination.total, 1);
  assert.equal(res.body.data[0].id, "booking-1");
});

test("ISSUE-020: a large export request (limit=5000, matching BulkOrders.js's exportCSV) returns the full filtered dataset, not truncated to 50", async () => {
  const bookings = Array.from({ length: 733 }, (_, i) => makeBooking(i));
  const { req, res } = makeReqRes({ limit: 5000, page: 1 });
  await getBulkBookings(req, res, { queryFn: createFakeBulkBookingsQueryFn(bookings) });

  assert.equal(res.body.data.length, 733, "must return every matching row, not cap at 50");
  assert.equal(res.body.pagination.total, 733);
});

test("ISSUE-020: an export request is satisfied via bounded per-round-trip chunks, never a single unbounded query", async () => {
  const bookings = Array.from({ length: 1200 }, (_, i) => makeBooking(i));
  let maxSingleQueryLimit = 0;
  const baseQueryFn = createFakeBulkBookingsQueryFn(bookings);
  const spyQueryFn = async (sql, params = []) => {
    if (!sql.includes("COUNT(*)")) {
      const limitValue = params[params.length - 2];
      if (typeof limitValue === "number") {
        maxSingleQueryLimit = Math.max(maxSingleQueryLimit, limitValue);
      }
    }
    return baseQueryFn(sql, params);
  };

  const { req, res } = makeReqRes({ limit: 5000, page: 1 });
  await getBulkBookings(req, res, { queryFn: spyQueryFn });

  assert.equal(res.body.data.length, 1200);
  assert.ok(
    maxSingleQueryLimit <= 500,
    `no single query round trip should ever request more than the safe chunk size (saw ${maxSingleQueryLimit})`,
  );
});

test("ISSUE-020 regression: a normal small paginated list request still runs as a single query and behaves exactly as before", async () => {
  const bookings = Array.from({ length: 30 }, (_, i) => makeBooking(i));
  let queryCallCount = 0;
  const baseQueryFn = createFakeBulkBookingsQueryFn(bookings);
  const countingQueryFn = async (sql, params) => {
    queryCallCount += 1;
    return baseQueryFn(sql, params);
  };

  const { req, res } = makeReqRes({ limit: 10, page: 2 });
  await getBulkBookings(req, res, { queryFn: countingQueryFn });

  assert.equal(res.body.data.length, 10);
  assert.equal(res.body.pagination.page, 2);
  assert.equal(res.body.pagination.total, 30);
  // One COUNT query + one page query — unchanged from before this fix.
  assert.equal(queryCallCount, 2);
});

test("ISSUE-020 regression: search still works exactly as before, combined with the new filters", async () => {
  const bookings = [
    makeBooking(1, { company_name: "Acme Wellness", status: "new" }),
    makeBooking(2, { company_name: "Other Co", status: "new" }),
  ];
  const { req, res } = makeReqRes({ search: "Acme", limit: 10, page: 1 });
  await getBulkBookings(req, res, { queryFn: createFakeBulkBookingsQueryFn(bookings) });

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].company_name, "Acme Wellness");
});
