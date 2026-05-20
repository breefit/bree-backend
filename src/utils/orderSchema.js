import { query } from '../config/database.js';

export const getOrderSchemaInfo = async (clientOrPool = query) => {
  const runner = typeof clientOrPool.query === 'function' ? clientOrPool : { query: clientOrPool };
  const { rows } = await runner.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('orders', 'order_items')`
  );

  const orderColumns = new Set(rows.filter((row) => row.table_name === 'orders').map((row) => row.column_name));
  const orderItemColumns = new Set(rows.filter((row) => row.table_name === 'order_items').map((row) => row.column_name));

  return {
    orders: orderColumns,
    orderItems: orderItemColumns,
    isNewOrderSchema: orderColumns.has('contact_email') && orderColumns.has('subtotal') && orderColumns.has('total'),
    isLegacyOrderSchema: orderColumns.has('customer_name') && orderColumns.has('amount'),
    hasOrderNotes: orderColumns.has('notes'),
    hasLegacyOrderItems: orderItemColumns.has('name') && orderItemColumns.has('price'),
    hasNewOrderItems: orderItemColumns.has('product_name') && orderItemColumns.has('product_price'),
  };
};

export const formatAddressSnapshot = (address) => {
  if (!address) return '';

  const parts = [];
  if (address.label) parts.push(address.label);
  if (address.full_name) parts.push(address.full_name);
  if (address.address_line_1) parts.push(address.address_line_1);
  if (address.line1) parts.push(address.line1);
  if (address.address_line_2) parts.push(address.address_line_2);
  if (address.line2) parts.push(address.line2);

  const location = [address.city, address.state, address.pincode].filter(Boolean).join(', ');
  if (location) parts.push(location);
  if (address.country) parts.push(address.country);

  return parts.filter(Boolean).join(', ');
};
