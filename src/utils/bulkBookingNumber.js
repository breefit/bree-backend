// Generates sequential, human-friendly bulk booking references in the
// format BB-100001, BB-100002, ... backed by a single-row counter table
// (bulk_booking_number_counter), mirroring utils/orderNumber.js exactly —
// same atomic-counter idiom, same reasoning for why it's race-safe under
// concurrent booking creation.

export const BULK_BOOKING_NUMBER_PREFIX = "BB-";

export const getNextBulkBookingNumber = async (client) => {
  await client.query(
    `UPDATE bulk_booking_number_counter
     SET current_value = LAST_INSERT_ID(current_value + 1)
     WHERE id = 1`,
  );

  const { rows } = await client.query(
    "SELECT LAST_INSERT_ID() AS next_value",
  );

  const nextValue = rows?.[0]?.next_value;

  if (!nextValue) {
    throw new Error("bulk_booking_number_counter row missing");
  }

  return `${BULK_BOOKING_NUMBER_PREFIX}${nextValue}`;
};
