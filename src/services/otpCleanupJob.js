// services/otpCleanupJob.js
import { query } from "../config/database.js";

// Deletes expired OTP records so the otp_verifications table doesn't
// grow unbounded. Safe to run repeatedly; only touches rows that have
// already expired.
export const cleanupExpiredOtps = async () => {
  const result = await query(
    "DELETE FROM otp_verifications WHERE expires_at < NOW()",
  );
  const deletedCount = result?.rowCount ?? result?.affectedRows ?? 0;
  if (deletedCount > 0) {
    console.log(
      `[otpCleanupJob] Removed ${deletedCount} expired OTP record(s).`,
    );
  }
  return deletedCount;
};
