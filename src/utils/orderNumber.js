// Generates sequential, human-friendly order numbers in the format
// BREE-100001, BREE-100002, ... backed by a single-row counter table
// (order_number_counter) so it's safe under concurrent order creation.
//
// Uses the classic MySQL atomic-counter idiom:
//   UPDATE order_number_counter SET current_value = LAST_INSERT_ID(current_value + 1)
//   SELECT LAST_INSERT_ID()
// `LAST_INSERT_ID(expr)` sets the *connection's* last-insert-id to `expr`'s
// value as a side effect of the UPDATE. The UPDATE statement itself takes a
// row lock for its duration, so concurrent calls are naturally serialized —
// no separate SELECT ... FOR UPDATE or app-level locking is required, and
// there's no risk of two orders getting the same number.
//
// Numbers are NEVER reused: a rolled-back order "wastes" a number (a gap),
// which is explicitly allowed by the requirements ("never reused" — gaps
// are fine, duplicates are not).

export const ORDER_NUMBER_PREFIX = "BREE-";

export const getNextOrderNumber = async (client) => {
  await client.query(
    `UPDATE order_number_counter
     SET current_value = LAST_INSERT_ID(current_value + 1)
     WHERE id = 1`,
  );

  // BUG FIX: client.query() (the wrapped connection from getClient()) resolves
  // to a plain object { rows, rowCount, insertId } — NOT a raw mysql2 array
  // [rows, fields]. Destructuring it as `const [rows] = await client.query(...)`
  // throws "TypeError: ... is not iterable" because plain objects aren't
  // iterable. That throw propagates out of this function, into the calling
  // transaction's try/catch, triggers a ROLLBACK, and aborts order creation
  // entirely — this is why order_number stayed NULL / orders silently failed
  // to be created via this path. Must use object destructuring here.
  const { rows } = await client.query("SELECT LAST_INSERT_ID() AS next_value");

  const nextValue = rows?.[0]?.next_value;

  console.log("[ORDER_NUMBER] Counter row fetched:", rows?.[0]);

  if (!nextValue) {
    throw new Error("order_number_counter row missing");
  }

  return `${ORDER_NUMBER_PREFIX}${nextValue}`;
};
