import axios from "axios";
import PDFDocument from "pdfkit";

const BASE_URL = process.env.DELHIVERY_BASE_URL;
const API_TOKEN = process.env.DELHIVERY_API_TOKEN;

if (!BASE_URL) {
  throw new Error("DELHIVERY_BASE_URL is missing in .env");
}

if (!API_TOKEN) {
  throw new Error("DELHIVERY_API_TOKEN is missing in .env");
}

const client = axios.create({
  baseURL: BASE_URL,
  timeout: Number(process.env.DELHIVERY_TIMEOUT || 30000),
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    Accept: "application/json",
  },
});

// Centralized request/response logging via axios interceptors.
// Applies to ALL existing methods on this client (serviceability, shipment,
// tracking, cancellation, label, pickup) so no per-method duplication is needed.
// NOTE: request payload (config.data) is intentionally NOT logged here, since
// it may contain customer PII (name, address, phone) for endpoints like
// createShipment(). Only method + URL are logged for traceability.
client.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    console.error("[Delhivery] Request setup error:", error.message);
    return Promise.reject(error);
  },
);

client.interceptors.response.use(
  (response) => {
    console.log(
      `[Delhivery] <-- ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`,
    );
    return response;
  },
  (error) => {
    if (error.response) {
      console.error(
        `[Delhivery] <-- ${error.response.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
      );
    } else if (error.request) {
      console.error(
        `[Delhivery] <-- No response received for ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
      );
    } else {
      console.error("[Delhivery] Request error:", error.message);
    }
    return Promise.reject(error);
  },
);

class DelhiveryService {
  /**
   * Check whether a pincode is serviceable
   */
  async checkServiceability(pincode) {
    try {
      const response = await client.get(
        `/c/api/pin-codes/json/?filter_codes=${pincode}`,
      );

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Create Shipment
   *
   * @param {Object} payload - Shipment creation payload as expected by Delhivery's /api/cmu/create.json.
   * @returns {Promise<Object>} Raw Delhivery response data.
   * @throws {Object} Formatted error via handleError() if the request fails or the response is empty.
   */
  async createShipment(payload) {
    try {
      const formData = new URLSearchParams();

      formData.append("format", "json");
      formData.append("data", JSON.stringify(payload));

      const response = await client.post(
        "/api/cmu/create.json",
        formData.toString(),
        {
          headers: {
            Authorization: `Token ${API_TOKEN}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      if (!response.data) {
        throw new Error("Empty response received from Delhivery.");
      }

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Track Shipment
   *
   * @param {string} awb - Waybill number to track.
   * @returns {Promise<Object>} Raw Delhivery response data.
   * @throws {Object} Formatted error via handleError() if the request fails or the response is empty.
   */
  async trackShipment(awb) {
    try {
      const response = await client.get(
        `/api/v1/packages/json/?waybill=${awb}`,
      );

      if (!response.data) {
        throw new Error("Empty response received from Delhivery.");
      }

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Cancel Shipment
   */
  async cancelShipment(waybill) {
    try {
      const response = await client.post("/api/p/edit", {
        waybill,
        cancellation: true,
      });

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  // ===== Delhivery Pickup Integration =====
  /**
   * Validate the pickup request payload before hitting the Delhivery API.
   * Delhivery's /fm/request/new/ endpoint requires:
   *  - pickup_location (registered warehouse/client name string)
   *  - expected_package_count (integer > 0)
   *  - pickup_date (YYYY-MM-DD)
   *  - pickup_time (HH:mm:ss, 24hr)
   * Throws a formatted error object (same shape as handleError) so callers
   * can handle validation failures the same way they handle API failures.
   */
  validatePickupPayload(data) {
    const errors = [];

    if (!data || typeof data !== "object") {
      errors.push("Pickup payload must be an object.");
      return this.buildValidationError(errors);
    }

    if (
      !data.pickup_location ||
      typeof data.pickup_location !== "string" ||
      !data.pickup_location.trim()
    ) {
      errors.push(
        "pickup_location is required and must be a non-empty string.",
      );
    }

    if (
      data.expected_package_count === undefined ||
      data.expected_package_count === null ||
      isNaN(Number(data.expected_package_count)) ||
      Number(data.expected_package_count) <= 0
    ) {
      errors.push(
        "expected_package_count is required and must be a positive number.",
      );
    }

    if (!data.pickup_date || !/^\d{4}-\d{2}-\d{2}$/.test(data.pickup_date)) {
      errors.push("pickup_date is required and must be in YYYY-MM-DD format.");
    }

    if (!data.pickup_time || !/^\d{2}:\d{2}(:\d{2})?$/.test(data.pickup_time)) {
      errors.push(
        "pickup_time is required and must be in HH:mm or HH:mm:ss format.",
      );
    }

    if (errors.length > 0) {
      return this.buildValidationError(errors);
    }

    return null;
  }

  /**
   * Builds a standardized validation error object, consistent with handleError's shape.
   */
  buildValidationError(errors) {
    console.error("[Delhivery] Pickup payload validation failed:", errors);
    return {
      success: false,
      status: 400,
      message: "Invalid pickup request payload.",
      errors,
    };
  }
  // ===== End Delhivery Pickup Integration =====

  /**
   * Request Pickup
   *
   * @param {Object} data - Pickup request payload (pickup_location, expected_package_count, pickup_date, pickup_time).
   * @returns {Promise<Object>} Raw Delhivery response data.
   * @throws {Object} Formatted error via handleError()/buildValidationError() if validation fails,
   *                   the request fails, or the response is empty.
   */
  async requestPickup(data) {
    // Safe logging: only non-sensitive scheduling metadata is logged.
    // Never log customer names, addresses, phone numbers, or other PII.
    // console.log("[Delhivery] requestPickup() called with safe metadata:", {
    //   pickup_location: data?.pickup_location,
    //   expected_package_count: data?.expected_package_count,
    //   pickup_date: data?.pickup_date,
    //   pickup_time: data?.pickup_time,
    // });

    const validationError = this.validatePickupPayload(data);
    if (validationError) {
      console.error(
        "[Delhivery] requestPickup() aborted due to validation errors.",
      );
      throw validationError;
    }

    try {
      const response = await client.post("/fm/request/new/", data, {
        headers: {
          Authorization: `Token ${API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.data) {
        throw new Error("Empty response received from Delhivery.");
      }

      // console.log("[Delhivery] requestPickup() succeeded:", response.data);

      return response.data;
    } catch (error) {
      const formattedError = this.handleError(error);
      console.error("[Delhivery] requestPickup() failed:", formattedError);
      throw formattedError;
    }
  }

  /**
   * Download Shipping Label
   */
  async getShippingLabel(waybill) {
    try {
      const response = await client.get(`/api/p/packing_slip?wbns=${waybill}`, {
        responseType: "arraybuffer",
        headers: {
          Accept: "application/pdf, application/json",
        },
      });

      console.log("[Delhivery] Shipping label response:", {
        status: response.status,
        contentType: response.headers?.["content-type"] || "unknown",
        dataType: describeResponseData(response.data),
        format: classifyLabelData(response.data),
      });

      return await normalizeShippingLabelResponse(response);
    } catch (error) {
      if (error.code === "DELHIVERY_LABEL_INVALID") {
        throw error;
      }
      throw this.handleError(error);
    }
  }

  /**
   * Health Check
   */
  async healthCheck() {
    try {
      const response = await client.get(
        "/c/api/pin-codes/json/?filter_codes=110001",
      );

      return {
        success: true,
        status: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: this.handleError(error),
      };
    }
  }

  /**
   * Error Formatter
   */
  handleError(error) {
    if (error.response) {
      const responseData = error.response.data;

      const formatted = {
        success: false,
        status: error.response.status,
        message:
          responseData?.message ||
          responseData?.rmk ||
          responseData?.error ||
          error.response.statusText ||
          "Unknown Delhivery API error",
        data: responseData,
      };

      console.error("[Delhivery] API error response:", formatted);

      return formatted;
    }

    if (error.request) {
      return {
        success: false,
        message: "No response received from Delhivery.",
      };
    }

    return {
      success: false,
      message: error.message,
    };
  }
}

const PDF_SIGNATURE = Buffer.from("%PDF-");

export const isPdfBuffer = (value) => {
  if (value instanceof ArrayBuffer) value = Buffer.from(value);
  if (!Buffer.isBuffer(value)) return false;
  const buffer = value;
  return (
    buffer.length >= PDF_SIGNATURE.length &&
    buffer.subarray(0, 5).equals(PDF_SIGNATURE)
  );
};

const describeResponseData = (data) => {
  if (Buffer.isBuffer(data)) return "Buffer";
  if (data instanceof ArrayBuffer) return "ArrayBuffer";
  if (typeof data === "string") return "string";
  if (data === null) return "null";
  return typeof data;
};

const classifyLabelData = (data) => {
  if (!data || (Buffer.isBuffer(data) && data.length === 0)) return "empty";
  if (isPdfBuffer(data)) return "pdf-binary";
  if (typeof data === "object" && !Buffer.isBuffer(data)) return "json";

  const text = Buffer.isBuffer(data)
    ? data.toString("utf8").trim()
    : String(data).trim();
  if (!text) return "empty";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "base64-or-invalid-text";
  }
};

const invalidLabelError = (message) => {
  const error = new Error(message);
  error.code = "DELHIVERY_LABEL_INVALID";
  error.status = 502;
  return error;
};

const findEncodedLabel = (value) => {
  if (!value || typeof value !== "object") return null;

  const preferredKeys = [
    "label_url",
    "labelUrl",
    "url",
    "pdf_url",
    "pdfUrl",
    "label",
    "pdf",
    "pdf_base64",
    "base64",
    "encoded_label",
    "encodedLabel",
    "packing_slip",
  ];

  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return { key, value: candidate.trim() };
    }
  }

  for (const child of Object.values(value)) {
    const found = findEncodedLabel(child);
    if (found) return found;
  }

  return null;
};

const addPackingSlipField = (document, label, value) => {
  if (value === undefined || value === null || value === "") return;
  document.fontSize(8).fillColor("#444444").text(`${label}: ${value}`);
};

const renderPackingSlipJson = (data) => {
  if (!Array.isArray(data?.packages) || data.packages.length === 0) {
    throw invalidLabelError(
      "Delhivery returned an empty packing-slip package list.",
    );
  }

  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: [288, 432], margin: 18 });
    const chunks = [];

    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    data.packages.forEach((shipment, index) => {
      if (index > 0) document.addPage();

      document
        .fontSize(15)
        .fillColor("#111111")
        .text("DELHIVERY", { align: "center" });
      document.moveDown(0.5);
      document
        .fontSize(11)
        .text(`Shipping Label${shipment.wbn ? ` - ${shipment.wbn}` : ""}`, {
          align: "center",
        });
      document.moveDown(0.75);

      addPackingSlipField(document, "Order", shipment.oid);
      addPackingSlipField(document, "Consignee", shipment.name);
      addPackingSlipField(document, "Address", shipment.address);
      addPackingSlipField(document, "City", shipment.destination_city);
      addPackingSlipField(document, "State", shipment.st);
      addPackingSlipField(document, "PIN", shipment.pin);
      addPackingSlipField(document, "Product", shipment.prd);
      addPackingSlipField(document, "Payment", shipment.pt);
      addPackingSlipField(document, "Weight", shipment.weight);
      addPackingSlipField(document, "Sort Code", shipment.sort_code);

      for (const barcodeKey of ["barcode", "oid_barcode"]) {
        const barcode = shipment[barcodeKey];
        if (!barcode?.startsWith("data:image/")) continue;
        const encoded = barcode.split(",", 2)[1];
        if (!encoded) continue;
        try {
          document.moveDown(0.5).image(Buffer.from(encoded, "base64"), {
            fit: [230, 70],
            align: "center",
          });
        } catch {
          // Barcode rendering is optional; the shipment details remain usable.
        }
      }

      document
        .moveDown(0.5)
        .fontSize(7)
        .fillColor("#666666")
        .text("Generated from Delhivery packing-slip response", {
          align: "center",
        });
    });

    document.end();
  });
};

const decodeBase64Pdf = (value) => {
  const normalized = value
    .replace(/^data:application\/pdf;base64,/, "")
    .replace(/\s/g, "");
  if (
    !normalized ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1
  ) {
    throw invalidLabelError(
      "Delhivery returned an invalid base64 shipping label.",
    );
  }

  const buffer = Buffer.from(normalized, "base64");
  if (!isPdfBuffer(buffer)) {
    throw invalidLabelError("Decoded Delhivery shipping label is not a PDF.");
  }
  return buffer;
};

const normalizeShippingLabelResponse = async (response) => {
  const rawData = response?.data;
  if (rawData === undefined || rawData === null) {
    throw invalidLabelError(
      "Delhivery returned an empty shipping label response.",
    );
  }

  const rawBuffer = Buffer.isBuffer(rawData)
    ? rawData
    : rawData instanceof ArrayBuffer
      ? Buffer.from(rawData)
      : null;

  if (rawBuffer) {
    if (rawBuffer.length === 0) {
      throw invalidLabelError(
        "Delhivery returned an empty shipping label response.",
      );
    }
    if (isPdfBuffer(rawBuffer)) return rawBuffer;

    const text = rawBuffer.toString("utf8").trim();
    try {
      return await normalizeShippingLabelResponse({
        data: JSON.parse(text),
        headers: response.headers,
        status: response.status,
      });
    } catch (error) {
      if (error.code === "DELHIVERY_LABEL_INVALID" && !text) throw error;
      if (text) return decodeBase64Pdf(text);
      throw invalidLabelError(
        "Delhivery returned a non-PDF shipping label response.",
      );
    }
  }

  if (typeof rawData === "string") {
    if (rawData.trim().startsWith("%PDF-"))
      return Buffer.from(rawData, "binary");
    return decodeBase64Pdf(rawData);
  }

  if (Array.isArray(rawData?.packages)) {
    return renderPackingSlipJson(rawData);
  }

  const encodedLabel = findEncodedLabel(rawData);
  if (!encodedLabel) {
    throw invalidLabelError(
      "Delhivery response did not contain a PDF, base64 label, or label URL.",
    );
  }

  if (/^https?:\/\//i.test(encodedLabel.value)) {
    const labelResponse = await client.get(encodedLabel.value, {
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    });
    console.log("[Delhivery] Shipping label URL response:", {
      status: labelResponse.status,
      contentType: labelResponse.headers?.["content-type"] || "unknown",
      dataType: describeResponseData(labelResponse.data),
      format: classifyLabelData(labelResponse.data),
    });
    return normalizeShippingLabelResponse(labelResponse);
  }

  return decodeBase64Pdf(encodedLabel.value);
};

export { normalizeShippingLabelResponse };

export default new DelhiveryService();
