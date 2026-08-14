// Generates sequential, human-friendly package numbers in the format
// PKG-100001, PKG-100002, ... backed by a single-row counter table
// (package_number_counter). Same atomic-counter idiom as
// utils/orderNumber.js — see that file for the full mechanism explanation.

export const PACKAGE_NUMBER_PREFIX = "PKG-";

export const getNextPackageNumber = async (client) => {
  await client.query(
    `UPDATE package_number_counter
     SET current_value = LAST_INSERT_ID(current_value + 1)
     WHERE id = 1`,
  );

  const { rows } = await client.query(
    "SELECT LAST_INSERT_ID() AS next_value",
  );

  const nextValue = rows?.[0]?.next_value;

  if (!nextValue) {
    throw new Error("package_number_counter row missing");
  }

  return `${PACKAGE_NUMBER_PREFIX}${nextValue}`;
};
