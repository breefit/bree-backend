import test from "node:test";
import assert from "node:assert/strict";
import { resolveShippingAddressForOrder } from "../src/controllers/shippingController.js";
import { resolveStructuredAddressFields } from "../src/controllers/paymentController.js";

/**
 * PHASE 3C — Step 4: ISSUE-M32 residual fix (the only Medium issue the
 * Phase 3 report classified as PARTIALLY FIXED).
 *
 * ORIGINAL RESIDUAL: address is stored by reference (order.address_id ->
 * addresses/user_addresses) rather than as an immutable per-order snapshot.
 * If a customer edits their saved address after checkout but before
 * shipment creation, Delhivery would get the CURRENT (edited) address, not
 * the one shown/confirmed at checkout.
 *
 * FIX: paymentController.js now writes the resolved structured address
 * (shipping_address_line1/2/city/state/pincode/country) onto the order row
 * itself at payment-confirmation time (both the client-verified and
 * webhook-confirmed paths), and shippingController.js's
 * resolveShippingAddressForOrder (extracted from createShipment, identical
 * logic) now prefers those columns over re-resolving address_id — so a
 * later edit to the saved address book entry can no longer change what an
 * already-paid order ships to.
 *
 * These tests drive the REAL resolution function directly with plain order
 * fixtures (it's now pure aside from the two address_id fallback lookups) —
 * not a regex over source, not an HTTP-level test.
 */

test("an order with a populated structured snapshot uses the snapshot, even when address_id points at a DIFFERENT (edited) address", async () => {
  const order = {
    address_id: "addr-live-edited",
    contact_name: "Jane Doe",
    contact_phone: "9999999999",
    shipping_address_line1: "12 MG Road", // snapshot taken AT CHECKOUT TIME
    shipping_address_line2: "Flat 3B",
    shipping_city: "Bengaluru",
    shipping_state: "Karnataka",
    shipping_pincode: "560001",
    shipping_country: "India",
  };

  // If this were ever consulted, it represents the customer's address book
  // entry AFTER they edited it post-checkout — proving the snapshot wins.
  const queryFn = async () => {
    throw new Error("must not be called — the snapshot columns must be preferred and no address_id lookup should ever run");
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.deepEqual(resolved, {
    full_name: "Jane Doe",
    mobile: "9999999999",
    address_line_1: "12 MG Road",
    address_line_2: "Flat 3B",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
    country: "India",
  });
});

test("a historical order with NO snapshot columns (pre-fix) still falls back to resolving address_id — backward compatible", async () => {
  const order = {
    address_id: "addr-historical",
    contact_name: "Old Customer",
    contact_phone: "8888888888",
    shipping_address_line1: null,
    shipping_city: null,
    shipping_pincode: null,
  };

  const queryFn = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id, full_name, phone") && params[0] === "addr-historical") {
      return {
        rows: [
          {
            full_name: "Old Customer",
            phone: "8888888888",
            address_line_1: "1 Old Street",
            address_line_2: null,
            city: "Mumbai",
            state: "Maharashtra",
            pincode: "400001",
            country: "India",
          },
        ],
      };
    }
    return { rows: [] };
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.equal(resolved.address_line_1, "1 Old Street");
  assert.equal(resolved.city, "Mumbai");
});

test("falls back to the legacy addresses table when user_addresses has no matching row", async () => {
  const order = {
    address_id: "addr-legacy-only",
    contact_name: "Legacy Customer",
    contact_phone: "7777777777",
  };

  const queryFn = async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id, full_name, phone")) {
      return { rows: [] }; // not in user_addresses
    }
    if (normalized.startsWith("SELECT id, label, address_line1")) {
      return {
        rows: [
          {
            label: "Home",
            address_line1: "9 Legacy Lane",
            address_line2: null,
            city: "Pune",
            state: "Maharashtra",
            pincode: "411001",
            country: "India",
          },
        ],
      };
    }
    return { rows: [] };
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.equal(resolved.address_line_1, "9 Legacy Lane");
  assert.equal(resolved.full_name, "Legacy Customer"); // contact_name preferred over the legacy label
});

test("a bulk order with structured columns but no address_id resolves from the snapshot (unchanged bulk-order behavior)", async () => {
  const order = {
    address_id: null,
    contact_name: "Bulk Buyer",
    contact_phone: "6666666666",
    shipping_address_line1: "Warehouse Rd",
    shipping_city: "Chennai",
    shipping_state: "Tamil Nadu",
    shipping_pincode: "600001",
    shipping_country: "India",
  };

  const queryFn = async () => {
    throw new Error("must not be called — structured columns already resolve the address");
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.equal(resolved.city, "Chennai");
});

test("an order with neither a snapshot nor an address_id resolves to null — caller must refuse, not parse free-text shipping_address", async () => {
  const order = {
    address_id: null,
    shipping_address_line1: null,
    shipping_city: null,
    shipping_pincode: null,
    shipping_address: "123 Some Street, Somewhere, SW, 500001", // deliberately never consulted
  };

  const queryFn = async () => {
    throw new Error("must not be called — there is no address_id to resolve");
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.equal(resolved, null);
});

test("a partial structured snapshot (missing pincode) does not count as present — falls back to address_id", async () => {
  const order = {
    address_id: "addr-fallback",
    shipping_address_line1: "Incomplete Row",
    shipping_city: "Delhi",
    shipping_pincode: null, // incomplete — must not be treated as a usable snapshot
  };

  const queryFn = async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id, full_name, phone")) {
      return {
        rows: [
          {
            full_name: "Fallback Customer",
            phone: "5555555555",
            address_line_1: "Complete Address",
            address_line_2: null,
            city: "Delhi",
            state: "Delhi",
            pincode: "110001",
            country: "India",
          },
        ],
      };
    }
    return { rows: [] };
  };

  const resolved = await resolveShippingAddressForOrder(order, { queryFn });

  assert.equal(resolved.address_line_1, "Complete Address", "an incomplete snapshot must not shadow a resolvable address_id");
});

// ── resolveStructuredAddressFields — the write-side merge used by both
// verifyPayment and handleWebhook to populate the snapshot columns ─────────

test("resolveStructuredAddressFields prefers the freshly-confirmed Razorpay shipping_address over the order's prior snapshot", () => {
  const fresh = { line1: "New Line 1", line2: "New Line 2", city: "New City", state: "New State", zipcode: "111111", country: "India" };
  const existingOrder = {
    shipping_address_line1: "Old Line 1",
    shipping_city: "Old City",
    shipping_pincode: "000000",
  };

  const resolved = resolveStructuredAddressFields(fresh, existingOrder);

  assert.deepEqual(resolved, {
    line1: "New Line 1",
    line2: "New Line 2",
    city: "New City",
    state: "New State",
    pincode: "111111",
    country: "India",
  });
});

test("resolveStructuredAddressFields falls back to the order's existing snapshot when Razorpay reports no shipping_address (e.g. a subscription renewal charge)", () => {
  const existingOrder = {
    shipping_address_line1: "Kept Line 1",
    shipping_address_line2: "Kept Line 2",
    shipping_city: "Kept City",
    shipping_state: "Kept State",
    shipping_pincode: "222222",
    shipping_country: "India",
  };

  const resolved = resolveStructuredAddressFields(null, existingOrder);

  assert.deepEqual(resolved, {
    line1: "Kept Line 1",
    line2: "Kept Line 2",
    city: "Kept City",
    state: "Kept State",
    pincode: "222222",
    country: "India",
  });
});

test("resolveStructuredAddressFields returns all nulls (never throws) when there is neither a fresh address nor an existing snapshot", () => {
  const resolved = resolveStructuredAddressFields(null, {});

  assert.deepEqual(resolved, {
    line1: null,
    line2: null,
    city: null,
    state: null,
    pincode: null,
    country: null,
  });
});
