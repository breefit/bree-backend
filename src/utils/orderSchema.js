import { query } from "../config/database.js";

export const getOrderSchemaInfo = async (clientOrPool = query) => {
  const runner =
    typeof clientOrPool.query === "function"
      ? clientOrPool
      : { query: clientOrPool };

  const { rows: dbRows } = await runner.query(`SELECT DATABASE() AS db`);
  const currentDb = dbRows[0]?.db;
  if (!currentDb) {
    throw new Error("Unable to determine current database");
  }

  const { rows } = await runner.query(
  `SELECT
      LOWER(table_name) AS table_name,
      LOWER(column_name) AS column_name
   FROM information_schema.columns
   WHERE table_schema = ?
     AND table_name IN ('orders', 'order_items')`,
  [currentDb],
);



  const orderColumns = new Set(
    rows
      .filter((row) => (row.table_name || row.TABLE_NAME) === "orders")
      .map((row) => row.column_name || row.COLUMN_NAME),
  );

  const orderItemColumns = new Set(
    rows
      .filter((row) => (row.table_name || row.TABLE_NAME) === "order_items")
      .map((row) => row.column_name || row.COLUMN_NAME),
  );

  return {
    orders: orderColumns,
    orderItems: orderItemColumns,
    isNewOrderSchema:
      orderColumns.has("contact_email") &&
      orderColumns.has("subtotal") &&
      orderColumns.has("total"),
    isLegacyOrderSchema:
      orderColumns.has("customer_name") && orderColumns.has("amount"),
    hasOrderNotes: orderColumns.has("notes"),
    hasLegacyOrderItems:
      orderItemColumns.has("name") && orderItemColumns.has("price"),
    hasNewOrderItems:
      orderItemColumns.has("product_name") &&
      orderItemColumns.has("product_price"),
  };
};

export const formatAddressSnapshot = (address) => {
  if (!address) return "";

  const parts = [];
  if (address.label) parts.push(address.label);
  if (address.full_name) parts.push(address.full_name);
  if (address.address_line_1) parts.push(address.address_line_1);
  if (address.line1) parts.push(address.line1);
  if (address.address_line_2) parts.push(address.address_line_2);
  if (address.line2) parts.push(address.line2);

  const location = [address.city, address.state, address.pincode]
    .filter(Boolean)
    .join(", ");
  if (location) parts.push(location);
  if (address.country) parts.push(address.country);

  return parts.filter(Boolean).join(", ");
};
