import { getClient } from "../config/database.js";

export const CUSTOMER_NUMBER_PREFIX = "BREE-CUST-";

export const getNextCustomerNumber = async (client) => {
  await client.query(
    `UPDATE customer_number_counter
     SET current_value = LAST_INSERT_ID(current_value + 1)
     WHERE id = 1`,
  );

  const { rows } = await client.query("SELECT LAST_INSERT_ID() AS next_value");
  const nextValue = rows?.[0]?.next_value;

  if (!nextValue) {
    throw new Error("customer_number_counter row missing");
  }

  return `${CUSTOMER_NUMBER_PREFIX}${nextValue}`;
};

export const assignCustomerNumberToUser = async (client, userId) => {
  const { rows } = await client.query(
    "SELECT customer_number FROM users WHERE id = ? LIMIT 1",
    [userId],
  );

  if (rows?.[0]?.customer_number) {
    return rows[0].customer_number;
  }

  const customerNumber = await getNextCustomerNumber(client);

  await client.query(
    `UPDATE users
     SET customer_number = ?
     WHERE id = ? AND (customer_number IS NULL OR customer_number = '')`,
    [customerNumber, userId],
  );

  return customerNumber;
};

export const ensureUserCustomerNumber = async (userId) => {
  const client = await getClient();

  try {
    await client.beginTransaction();
    const customerNumber = await assignCustomerNumberToUser(client, userId);
    await client.commit();
    return customerNumber;
  } catch (error) {
    await client.rollback();
    throw error;
  } finally {
    client.release();
  }
};
