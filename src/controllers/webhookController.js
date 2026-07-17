/**
 * Meta WhatsApp Cloud API webhook controller.
 *
 * This controller only handles the webhook verification handshake and the
 * incoming payload from Meta. It intentionally does not change existing auth,
 * OTP, order, subscription, or WhatsApp notification flows.
 */

/**
 * GET /api/webhooks/meta
 * Verify the Meta webhook subscription using hub.mode, hub.verify_token, and
 * hub.challenge. If verification succeeds, return the challenge string.
 */
export const verifyMetaWebhook = async (req, res) => {
  try {
    const mode = String(req.query["hub.mode"] || "").trim();
    const token = String(req.query["hub.verify_token"] || "").trim();
    const challenge = String(req.query["hub.challenge"] || "").trim();

    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
      console.info("[META WEBHOOK] Verification succeeded");
      return res.status(200).send(challenge);
    }

    console.warn("[META WEBHOOK] Verification failed", {
      mode,
      tokenProvided: Boolean(token),
    });

    return res.status(403).json({ message: "Forbidden" });
  } catch (error) {
    console.error("[META WEBHOOK] Verification error", error);
    return res.status(500).json({ message: "Webhook verification failed" });
  }
};

/**
 * Log a delivery/read/failure status update from Meta.
 * Supports future mapping of message IDs to orders or subscriptions.
 */
const logStatusUpdate = async (status) => {
  const statusType = String(status.status || "").toLowerCase();
  const messageId = status.id || status.message_id || "unknown";
  const recipientId =
    status.recipient_id || status.recipient_phone_number || "unknown";
  const timestamp = status.timestamp || "unknown";

  switch (statusType) {
    case "sent":
      console.info("[META WEBHOOK] Message sent", {
        messageId,
        recipientId,
        timestamp,
      });
      break;
    case "delivered":
      console.info("[META WEBHOOK] Message delivered", {
        messageId,
        recipientId,
        timestamp,
      });
      break;
    case "read":
      console.info("[META WEBHOOK] Message read", {
        messageId,
        recipientId,
        timestamp,
      });
      break;
    case "failed":
      console.warn("[META WEBHOOK] Message failed", {
        messageId,
        recipientId,
        timestamp,
        error: status.error_message || status.error_code || "unknown",
      });
      break;
    default:
      console.info("[META WEBHOOK] Ignored status update", {
        statusType,
        messageId,
        recipientId,
        timestamp,
      });
  }
};

/**
 * Log an incoming message event from Meta WhatsApp.
 */
const logIncomingMessage = async (message, metadata) => {
  const messageId = message.id || "unknown";
  const from = message.from || metadata?.from || "unknown";
  const type = message.type || "unknown";

  console.info("[META WEBHOOK] Incoming message received", {
    messageId,
    from,
    type,
    metadata,
    message,
  });
};

/**
 * POST /api/webhooks/meta
 * Accept incoming Meta webhook payloads. Log the payload and safely ignore
 * unknown or changed payload structures without crashing.
 */
export const handleMetaWebhook = async (req, res) => {
  try {
    const payload = req.body;

    console.info("[META WEBHOOK] Payload received", {
      payload,
      bodyType: typeof payload,
    });

    if (!payload || typeof payload !== "object") {
      console.warn("[META WEBHOOK] Invalid payload format — ignoring");
      return res.sendStatus(200);
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change.value || {};
        const metadata = value.metadata || {};
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const eventField = String(change.field || "").toLowerCase();

        console.info("[META WEBHOOK] Processing change", {
          eventField,
          metadata,
          statusesCount: statuses.length,
          messagesCount: messages.length,
        });

        for (const status of statuses) {
          await logStatusUpdate(status);
        }

        for (const message of messages) {
          await logIncomingMessage(message, metadata);
        }

        if (statuses.length === 0 && messages.length === 0) {
          console.info("[META WEBHOOK] Unsupported change ignored", {
            eventField,
            change,
          });
        }
      }
    }
  } catch (error) {
    console.error("[META WEBHOOK] Processing error", error, {
      body: req.body,
    });
  }

  return res.sendStatus(200);
};
