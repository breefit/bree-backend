import test, { mock } from "node:test";
import assert from "node:assert/strict";
process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

const { isPdfBuffer, normalizeShippingLabelResponse } =
  await import("../src/services/delhiveryService.js");
const { default: delhiveryService } =
  await import("../src/services/delhiveryService.js");
const { downloadShippingLabel } =
  await import("../src/controllers/shippingController.js");

const pdfBuffer = () => Buffer.from("%PDF-1.7\nlabel bytes\n%%EOF\n");

const response = (data, contentType = "application/octet-stream") => ({
  status: 200,
  headers: { "content-type": contentType },
  data,
});

const fakeResponse = () => ({
  statusCode: null,
  headers: {},
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  setHeader(name, value) {
    this.headers[name] = value;
  },
  send(body) {
    this.body = body;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test("preserves a valid Delhivery PDF binary response", async () => {
  const result = await normalizeShippingLabelResponse(
    response(pdfBuffer(), "application/pdf"),
  );

  assert.ok(Buffer.isBuffer(result));
  assert.ok(isPdfBuffer(result));
});

test("decodes a base64 PDF returned inside JSON", async () => {
  const encoded = pdfBuffer().toString("base64");
  const result = await normalizeShippingLabelResponse(
    response(
      Buffer.from(JSON.stringify({ label: encoded })),
      "application/json",
    ),
  );

  assert.deepEqual(result, pdfBuffer());
});

test("renders Delhivery packing-slip JSON as a valid PDF", async () => {
  const result = await normalizeShippingLabelResponse(
    response(
      Buffer.from(
        JSON.stringify({
          packages: [
            { wbn: "58045510000022", oid: "BREE-100015", name: "Customer" },
          ],
        }),
      ),
      "application/json",
    ),
  );

  assert.ok(isPdfBuffer(result));
});

test("rejects JSON without a label payload", async () => {
  await assert.rejects(
    normalizeShippingLabelResponse(
      response(
        Buffer.from(JSON.stringify({ success: false, message: "not ready" })),
        "application/json",
      ),
    ),
    (error) => error.code === "DELHIVERY_LABEL_INVALID" && error.status === 502,
  );
});

test("rejects an empty Delhivery response", async () => {
  await assert.rejects(
    normalizeShippingLabelResponse(response(Buffer.alloc(0))),
    (error) => error.code === "DELHIVERY_LABEL_INVALID" && error.status === 502,
  );
});

test("serves a valid label with the required download headers", async () => {
  const restore = mock.method(delhiveryService, "getShippingLabel", async () =>
    pdfBuffer(),
  );
  try {
    const res = fakeResponse();
    await downloadShippingLabel({ params: { awb: "58045510000022" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "application/pdf");
    assert.equal(
      res.headers["Content-Disposition"],
      'attachment; filename="label-58045510000022.pdf"',
    );
    assert.ok(isPdfBuffer(res.body));
  } finally {
    restore.mock.restore();
  }
});

test("does not download an invalid label as a PDF", async () => {
  const restore = mock.method(delhiveryService, "getShippingLabel", async () =>
    Buffer.from("not a pdf"),
  );
  try {
    const res = fakeResponse();
    await downloadShippingLabel({ params: { awb: "58045510000022" } }, res);

    assert.equal(res.statusCode, 502);
    assert.equal(res.headers["Content-Type"], undefined);
    assert.equal(res.body.success, false);
  } finally {
    restore.mock.restore();
  }
});
