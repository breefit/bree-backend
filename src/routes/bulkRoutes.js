import express from "express";
import { createBulkBooking } from "../controllers/bulkController.js";

const router = express.Router();

router.post("/", createBulkBooking);

export default router;