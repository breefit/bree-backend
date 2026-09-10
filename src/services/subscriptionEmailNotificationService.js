import { query } from "../config/database.js";

export const sendSubscriptionEmailOnce = async ({
  notificationKey,
  send,
  retryFailed = false,
}) => {
  if (!notificationKey || typeof send !== "function") {
    throw new Error("notificationKey and send are required");
  }

  await query(
    `INSERT IGNORE INTO subscription_email_notifications
       (notification_key, status)
     VALUES (?, 'pending')`,
    [notificationKey],
  );

  const claimResult = await query(
    `UPDATE subscription_email_notifications
     SET status = 'sending', attempts = attempts + 1, last_attempt_at = NOW()
     WHERE notification_key = ?
       AND (status = 'pending' OR (status = 'failed' AND ? = 1))`,
    [notificationKey, retryFailed ? 1 : 0],
  );

  if (!claimResult.rowCount) {
    return { sent: false, duplicate: true };
  }

  try {
    await send();
    await query(
      `UPDATE subscription_email_notifications
       SET status = 'sent', sent_at = NOW(), last_error = NULL
       WHERE notification_key = ? AND status = 'sending'`,
      [notificationKey],
    );
    return { sent: true, duplicate: false };
  } catch (error) {
    await query(
      `UPDATE subscription_email_notifications
       SET status = 'failed', last_error = ?
       WHERE notification_key = ? AND status = 'sending'`,
      [String(error?.message || error).slice(0, 1000), notificationKey],
    );
    throw error;
  }
};

export default sendSubscriptionEmailOnce;
