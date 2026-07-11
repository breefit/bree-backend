import axios from "axios";

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
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ===== Delhivery Pickup Integration =====
// Centralized request/response logging via axios interceptors.
// Applies to ALL existing methods on this client (serviceability, shipment,
// tracking, cancellation, label, pickup) so no per-method duplication is needed.
// NOTE: request payload (config.data) is intentionally NOT logged here, since
// it may contain customer PII (name, address, phone) for endpoints like
// createShipment(). Only method + URL are logged for traceability.
client.interceptors.request.use(
  (config) => {
    console.log(
      `[Delhivery] --> ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`,
    );
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
        error.response.data,
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
// ===== End Delhivery Pickup Integration =====

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
  // ===== Modified =====
  async createShipment(payload) {
    try {
      const response = await client.post("/api/cmu/create.json", payload);

      if (!response.data) {
        throw new Error("Empty response received from Delhivery.");
      }

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }
  // ===== End Modified =====

  /**
   * Track Shipment
   *
   * @param {string} awb - Waybill number to track.
   * @returns {Promise<Object>} Raw Delhivery response data.
   * @throws {Object} Formatted error via handleError() if the request fails or the response is empty.
   */
  // ===== Modified =====
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
  // ===== End Modified =====

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
  // ===== Modified =====
  async requestPickup(data) {
    // Safe logging: only non-sensitive scheduling metadata is logged.
    // Never log customer names, addresses, phone numbers, or other PII.
    console.log("[Delhivery] requestPickup() called with safe metadata:", {
      pickup_location: data?.pickup_location,
      expected_package_count: data?.expected_package_count,
      pickup_date: data?.pickup_date,
      pickup_time: data?.pickup_time,
    });

    const validationError = this.validatePickupPayload(data);
    if (validationError) {
      console.error(
        "[Delhivery] requestPickup() aborted due to validation errors.",
      );
      throw validationError;
    }

    try {
      const response = await client.post("/fm/request/new/", data);

      if (!response.data) {
        throw new Error("Empty response received from Delhivery.");
      }

      console.log("[Delhivery] requestPickup() succeeded:", response.data);

      return response.data;
    } catch (error) {
      const formattedError = this.handleError(error);
      console.error("[Delhivery] requestPickup() failed:", formattedError);
      throw formattedError;
    }
  }
  // ===== End Modified =====

  /**
   * Download Shipping Label
   */
  async getShippingLabel(waybill) {
    try {
      const response = await client.get(`/api/p/packing_slip?wbns=${waybill}`, {
        responseType: "arraybuffer",
      });

      return response.data;
    } catch (error) {
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
      const formatted = {
        success: false,
        status: error.response.status,
        message: error.response.data?.message || error.response.statusText,
        data: error.response.data,
      };
      console.error("[Delhivery] API error response:", formatted);
      return formatted;
    }

    if (error.request) {
      const formatted = {
        success: false,
        message: "No response received from Delhivery.",
      };
      console.error("[Delhivery] No response error:", formatted);
      return formatted;
    }

    const formatted = {
      success: false,
      message: error.message,
    };
    console.error("[Delhivery] Unexpected error:", formatted);
    return formatted;
  }
}

export default new DelhiveryService();
