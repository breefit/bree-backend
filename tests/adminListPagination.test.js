import test from "node:test";
import assert from "node:assert/strict";
import { getInquiries } from "../src/controllers/admin/adminMiscController.js";
import { getAdminTestimonials } from "../src/services/testimonialService.js";

/**
 * ISSUE-022 — Admin Contact Inquiries search was a no-op, and
 * ISSUE-023 — Admin Customers/Contact Inquiries/Testimonials capped at 20
 * records with no real pagination.
 *
 * getCustomers already supported real server-side search + pagination +
 * total (only the frontend never used them — a frontend-only fix, not
 * covered here). getInquiries read `contacted` but never `search` at all;
 * getAdminTestimonials (the service) never returned a total count, so no
 * real pagination could ever be built from its response.
 *
 * These drive the REAL exported functions against a fake in-memory table,
 * matching real WHERE-clause filtering and LIMIT/OFFSET behavior.
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

// ── ISSUE-022: getInquiries ────────────────────────────────────────────────

const makeInquiry = (i, overrides = {}) => ({
  id: `inquiry-${i}`,
  name: `Person ${i}`,
  email: `person${i}@example.com`,
  phone: "9876543210",
  message: "General question",
  contacted: 0,
  created_at: new Date(Date.UTC(2026, 0, 1 + i)),
  ...overrides,
});

const createFakeInquiriesQueryFn = (allInquiries) => async (sql, params = []) => {
  const normalized = sql.replace(/\s+/g, " ").trim();

  const hasContacted = normalized.includes("contacted = ?");
  const hasSearch = normalized.includes("name LIKE ?");

  let cursor = 0;
  let contactedValue = null;
  if (hasContacted) {
    contactedValue = params[cursor];
    cursor += 1;
  }
  let searchTerm = null;
  if (hasSearch) {
    searchTerm = params[cursor].replace(/%/g, "").toLowerCase();
    cursor += 4;
  }

  let filtered = allInquiries.filter((inq) => {
    if (contactedValue !== null && inq.contacted !== contactedValue) return false;
    if (searchTerm) {
      const haystack = [inq.name, inq.email, inq.phone, inq.message].join(" ").toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => b.created_at - a.created_at);

  if (normalized.startsWith("SELECT COUNT(*)")) {
    return { rows: [{ total: filtered.length }] };
  }

  const limitValue = params[params.length - 2];
  const offsetValue = params[params.length - 1];
  return { rows: filtered.slice(offsetValue, offsetValue + limitValue) };
};

test("ISSUE-022: the search param now actually narrows contact inquiries (previously a silent no-op)", async () => {
  const inquiries = [
    makeInquiry(1, { name: "Alice Smith" }),
    makeInquiry(2, { name: "Bob Jones" }),
  ];
  const { req, res } = makeReqRes({ search: "Alice", page: 1, limit: 20 });
  await getInquiries(req, res, { queryFn: createFakeInquiriesQueryFn(inquiries) });

  assert.equal(res.body.inquiries.length, 1);
  assert.equal(res.body.inquiries[0].name, "Alice Smith");
  assert.equal(res.body.total, 1);
});

test("ISSUE-022: search matches email, phone, and message too, not just name", async () => {
  const inquiries = [
    makeInquiry(1, { name: "X", email: "findme@example.com" }),
    makeInquiry(2, { name: "Y", phone: "9999999999" }),
    makeInquiry(3, { name: "Z", message: "special-keyword-here" }),
    makeInquiry(4, { name: "W" }),
  ];
  const byEmail = makeReqRes({ search: "findme", page: 1, limit: 20 });
  await getInquiries(byEmail.req, byEmail.res, { queryFn: createFakeInquiriesQueryFn(inquiries) });
  assert.equal(byEmail.res.body.total, 1);

  const byMessage = makeReqRes({ search: "special-keyword", page: 1, limit: 20 });
  await getInquiries(byMessage.req, byMessage.res, { queryFn: createFakeInquiriesQueryFn(inquiries) });
  assert.equal(byMessage.res.body.total, 1);
});

test("ISSUE-022 regression: the contacted filter still works, combined with search", async () => {
  const inquiries = [
    makeInquiry(1, { name: "Alice", contacted: 1 }),
    makeInquiry(2, { name: "Alice", contacted: 0 }),
  ];
  const { req, res } = makeReqRes({ search: "Alice", contacted: "true", page: 1, limit: 20 });
  await getInquiries(req, res, { queryFn: createFakeInquiriesQueryFn(inquiries) });

  assert.equal(res.body.total, 1);
  assert.equal(res.body.inquiries[0].contacted, 1);
});

test("ISSUE-023: getInquiries pagination total reflects the full filtered count, and paginates correctly across pages", async () => {
  const inquiries = Array.from({ length: 45 }, (_, i) => makeInquiry(i));
  const page1 = makeReqRes({ page: 1, limit: 20 });
  await getInquiries(page1.req, page1.res, { queryFn: createFakeInquiriesQueryFn(inquiries) });
  assert.equal(page1.res.body.inquiries.length, 20);
  assert.equal(page1.res.body.total, 45);

  const page3 = makeReqRes({ page: 3, limit: 20 });
  await getInquiries(page3.req, page3.res, { queryFn: createFakeInquiriesQueryFn(inquiries) });
  assert.equal(page3.res.body.inquiries.length, 5, "the last partial page must still be reachable");
});

// ── ISSUE-023: getAdminTestimonials (service) now returns a total ─────────

const makeTestimonial = (i, overrides = {}) => ({
  id: `testimonial-${i}`,
  name: `Reviewer ${i}`,
  role: "Customer",
  text: "Great product",
  status: "approved",
  created_at: new Date(Date.UTC(2026, 0, 1 + i)),
  ...overrides,
});

const createFakeTestimonialsQueryFn = (all) => async (sql, params = []) => {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const hasStatus = normalized.includes("status = ?");
  const hasSearch = normalized.includes("name LIKE ?");

  let cursor = 0;
  let statusValue = null;
  if (hasStatus) {
    statusValue = params[cursor];
    cursor += 1;
  }
  let searchTerm = null;
  if (hasSearch) {
    searchTerm = params[cursor].replace(/%/g, "").toLowerCase();
    cursor += 3;
  }

  let filtered = all.filter((t) => {
    if (statusValue && t.status !== statusValue) return false;
    if (searchTerm) {
      const haystack = [t.name, t.role, t.text].join(" ").toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });
  filtered = [...filtered].sort((a, b) => b.created_at - a.created_at);

  if (normalized.startsWith("SELECT COUNT(*)")) {
    return { rows: [{ total: filtered.length }] };
  }

  const limitValue = params[params.length - 2];
  const offsetValue = params[params.length - 1];
  return { rows: filtered.slice(offsetValue, offsetValue + limitValue) };
};

test("ISSUE-023: getAdminTestimonials now returns a total count alongside rows (previously a bare array with no way to paginate)", async () => {
  const testimonials = Array.from({ length: 37 }, (_, i) => makeTestimonial(i));
  const result = await getAdminTestimonials({
    limit: 20,
    offset: 0,
    queryFn: createFakeTestimonialsQueryFn(testimonials),
  });

  assert.equal(result.rows.length, 20);
  assert.equal(result.total, 37);
});

test("ISSUE-023: getAdminTestimonials search narrows by name/role/text", async () => {
  const testimonials = [
    makeTestimonial(1, { name: "Priya", text: "Loved it" }),
    makeTestimonial(2, { name: "Rahul", text: "Not for me" }),
  ];
  const result = await getAdminTestimonials({
    limit: 20,
    offset: 0,
    search: "Loved",
    queryFn: createFakeTestimonialsQueryFn(testimonials),
  });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].name, "Priya");
});

test("ISSUE-023 regression: getAdminTestimonials status filter still works", async () => {
  const testimonials = [
    makeTestimonial(1, { status: "pending" }),
    makeTestimonial(2, { status: "approved" }),
  ];
  const result = await getAdminTestimonials({
    status: "pending",
    limit: 20,
    offset: 0,
    queryFn: createFakeTestimonialsQueryFn(testimonials),
  });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].status, "pending");
});
