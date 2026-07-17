import { Router } from "express";
import {
  verifyMetaWebhook,
  handleMetaWebhook,
} from "../controllers/webhookController.js";

const router = Router();

// GET /api/webhooks/meta — verify Meta WhatsApp Cloud webhook.
router.get("/meta", verifyMetaWebhook);

// POST /api/webhooks/meta — receive Meta WhatsApp Cloud webhook events.
router.post("/meta", handleMetaWebhook);

export default router;
