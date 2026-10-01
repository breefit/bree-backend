/**
 * Customer notifications for return / refund / cancel-and-refund events —
 * the single delivery path behind returnController.notifyReturnEvent.
 *
 * FIX (notification privacy audit — finding 1): callers used to pass free
 * text (admin verification notes, rejection notes, QC notes) that was then
 * emailed to the customer. Now:
 *   - a caller names an event from services/customerOrderEvents.js and
 *     nothing else; every customer-visible string comes from there;
 *   - buildCustomerEventPayload() is the only place that reads the order
 *     row, and it reads only the fields listed in CUSTOMER_PAYLOAD_FIELDS
 *     (contact details, order id/number, refund amount). Notes, reasons,
 *     Razorpay refund ids, RRNs and Delhivery data are never read.
 *
 * Each (order, event, channel) is still sent at most once through the
 * order_status_notifications claim (key order:{id}:status:{slug}:channel:*),
 * with reconcilable: true so a provably-unaccepted failure is retried by
 * services/notificationReconciliation.js.
 */
import {
  sendOrderStatusNotificationOnce,
  buildOrderStatusNotificationKey,
} from "./orderStatusNotificationService.js";
import { sendCustomerEventEmail } from "./orderEmailService.js";
import { sendCustomerEventWhatsApp } from "./whatsappNotificationService.js";
import { resolveCustomerOrderEvent } from "./customerOrderEvents.js";

export const CUSTOMER_NOTIFICATION_CHANNELS = Object.freeze(["email", "whatsapp"]);

// The only order columns a customer notification may read.
export const CUSTOMER_PAYLOAD_FIELDS = Object.freeze([
  "id",
  "order_number",
  "contact_name",
  "customer_name",
  "contact_email",
  "email",
  "contact_phone",
  "mobile_number",
  "refund_amount",
]);

const log = (level, event, meta = {}) => {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const pickCustomerFields = (order) => {
  const safe = {};
  for (const field of CUSTOMER_PAYLOAD_FIELDS) safe[field] = order?.[field] ?? null;
  return safe;
};

/**
 * The complete, whitelisted content of one customer notification.
 * Exported so tests can prove nothing outside it reaches a provider.
 */
export const buildCustomerEventPayload = (order, event) => {
  const o = pickCustomerFields(order);
  const orderNumber = o.order_number || o.id;
  return {
    orderId: o.id,
    orderNumber,
    name: o.contact_name || o.customer_name || "Customer",
    email: o.contact_email || o.email || null,
    phone: o.contact_phone || o.mobile_number || null,
    label: event.label,
    whatsappMessage: event.message,
    emailMessage: event.emailMessage ? event.emailMessage(o) : event.message,
    emailSubject: event.emailSubject ? event.emailSubject(orderNumber) : undefined,
  };
};

/**
 * Sends one event on one channel, at most once per notification key.
 * Never throws — resolves to the claim result, or { sent: false, error }.
 */
export const deliverCustomerEvent = async (
  order,
  event,
  channel,
  {
    sendOnce = sendOrderStatusNotificationOnce,
    sendEmail = sendCustomerEventEmail,
    sendWhatsApp = sendCustomerEventWhatsApp,
    queryExecutor,
  } = {},
) => {
  const payload = buildCustomerEventPayload(order, event);
  const recipient = channel === "email" ? payload.email : payload.phone;
  if (!payload.orderId || !recipient) {
    return { sent: false, skipped: "no_recipient" };
  }

  const send =
    channel === "email"
      ? () =>
          sendEmail({
            to: payload.email,
            name: payload.name,
            orderId: payload.orderId,
            orderNumber: payload.orderNumber,
            label: payload.label,
            message: payload.emailMessage,
            subject: payload.emailSubject,
          })
      : () =>
          sendWhatsApp({
            mobile: payload.phone,
            customerName: payload.name,
            orderNumber: payload.orderNumber,
            orderUuid: payload.orderId,
            label: payload.label,
            message: payload.whatsappMessage,
          });

  try {
    return await sendOnce({
      notificationKey: buildOrderStatusNotificationKey({
        orderId: payload.orderId,
        status: event.slug,
        channel,
      }),
      orderId: payload.orderId,
      status: event.slug,
      channel,
      reconcilable: true,
      reclaimStaleSending: false,
      ...(queryExecutor ? { queryExecutor } : {}),
      send,
    });
  } catch (error) {
    // Already recorded on the notification row by the claim layer.
    log("error", `return.${channel}_failed`, {
      orderId: payload.orderId,
      event: event.slug,
      error: error?.message || String(error),
    });
    return { sent: false, error };
  }
};

// Test seam only: lets the test suite route the claim layer to an in-memory
// table (there is no test database). Refuses to run outside NODE_ENV=test.
let testDefaultDeps = {};
export const setCustomerNotificationDepsForTests = (deps = {}) => {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setCustomerNotificationDepsForTests is test-only");
  }
  testDefaultDeps = { ...deps };
};

/**
 * Notifies the customer of one named event on every channel they have.
 * `eventName` must be a key of CUSTOMER_ORDER_EVENTS (or its slug). There
 * is deliberately no text parameter: a third argument that is not an
 * options object (e.g. a legacy `notes` string) is ignored.
 * Fire-and-forget safe: the returned promise never rejects.
 */
export const notifyCustomerOrderEvent = async (order, eventName, deps = {}) => {
  const event = resolveCustomerOrderEvent(eventName);
  if (!event) {
    log("error", "customer_notification.unknown_event", {
      orderId: order?.id || null,
      event: String(eventName),
    });
    return [];
  }
  if (deps !== undefined && (deps === null || typeof deps !== "object")) {
    log("warn", "customer_notification.ignored_free_text", {
      orderId: order?.id || null,
      event: event.slug,
    });
    deps = {};
  }
  return Promise.all(
    CUSTOMER_NOTIFICATION_CHANNELS.map((channel) =>
      deliverCustomerEvent(order, event, channel, { ...testDefaultDeps, ...deps }),
    ),
  );
};

export default notifyCustomerOrderEvent;
