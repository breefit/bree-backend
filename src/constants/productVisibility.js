// Product visibility ("Show in User UI").
//
// Two independent product flags gate what a customer can see or buy:
//
//   is_active  — soft-delete. DELETE /api/admin/products/:id sets it to 0
//                ("Product deactivated"). A deleted product is gone for
//                everyone except historical orders.
//   is_visible — admin's "Show in User UI" toggle. 0 hides a product from
//                every customer-facing listing/detail/recommendation and
//                blocks NEW purchases, but it stays fully manageable in
//                Admin. Not related to stock/featured/popular/subscription.
//
// Every customer-facing product query must use customerVisibleWhere() so
// the rule lives in one place and is greppable during audits. Admin
// queries and post-purchase flows (order history, renewals, package
// fulfillment, already-paid reminders) deliberately do NOT use it.

/**
 * SQL predicate for "a customer may see / newly purchase this product".
 * @param {string} [alias] - table alias, e.g. "p" → "p.is_active = 1 AND p.is_visible = 1"
 */
export const customerVisibleWhere = (alias) => {
  const a = alias ? `${alias}.` : "";
  return `${a}is_active = 1 AND ${a}is_visible = 1`;
};
