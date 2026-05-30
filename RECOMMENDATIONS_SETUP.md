# Product Recommendations Database Setup

## Overview

This document explains how to set up the product recommendations feature using MySQL JSON arrays for product relationships.

## Problem Fixed

**Before:** Recommendation logic relied on quantity values (30, 180, 365) and earlier PostgreSQL assumptions.

**After:** Uses `recommended_product_ids` stored as a MySQL `JSON` array of product IDs, matching the current backend SQL implementation.

## Database Changes Required

### 1. Add Migration

Run the migration to add the `recommended_product_ids` column:

```bash
mysql -u root -p bree < backend/migrations/003_add_product_recommendations.sql
```

This creates:

- `recommended_product_ids` column: MySQL `JSON` array to store product IDs

### 2. Populate Recommendations

Populate the recommendations based on product quantities:

```bash
mysql -u root -p bree < backend/migrations/populate_recommendations.sql
```

This populates recommendation arrays for 7-pack, 30-pack, and 180-day products using MySQL JSON functions.

This sets up the upgrade paths:

- **7-Pack** → 30-Pack Monthly
- **30-Pack** → 6-Month (180) + 1-Year (365)
- **6-Month** → 1-Year (365)
- **1-Year** → No recommendations

### 3. Verify Setup

Check that recommendations are populated:

```sql
SELECT id, name, quantity, recommended_product_ids
FROM products
WHERE recommended_product_ids IS NOT NULL
AND JSON_LENGTH(recommended_product_ids) > 0;
```

## How It Works

### Frontend

1. User adds 7-Pack product to cart
2. Cart calls GET `/api/products/{id}/recommendations`
3. Backend fetches product and reads `recommended_product_ids` array
4. Backend fetches those specific products by UUID
5. Recommendation card displays in cart drawer
6. User clicks upgrade → product is replaced

### Backend

```javascript
// Before (causes error):
WHERE quantity IN (30, 180, 365)  ❌ text = integer error

// After (works correctly):
WHERE JSON_CONTAINS(recommended_product_ids, JSON_QUOTE(id))  ✅ ID exists in JSON array
```

## Example Product Setup

For a 7-Pack trial product with UUID `a1b2c3d4-e5f6-4g7h-8i9j-0k1i2j3k4l5m`:

```sql
UPDATE products
SET recommended_product_ids = JSON_ARRAY('x1y2z3a4-b5c6-4d7e-8f9g-0h1i2j3k4l5m')
WHERE id = 'a1b2c3d4-e5f6-4g7h-8i9j-0k1i2j3k4l5m';
```

Where `x1y2z3a4-b5c6-4d7e-8f9g-0h1i2j3k4l5m` is the UUID of the 30-Pack product.

## Testing

### 1. Test API Response

```bash
curl http://localhost:3000/api/products/your-product-id/recommendations
```

Expected response (200 OK):

```json
[
  {
    "id": "uuid-of-30-pack",
    "name": "30-Pack Monthly",
    "price": 999,
    "mrp": 1200,
    "quantity": 30,
    "image": "...",
    "category": "wellness"
  }
]
```

### 2. Test Frontend

1. Add product to cart
2. Verify recommendation card appears
3. Click recommendation
4. Verify product is replaced (not duplicated)
5. Check cart subtotal updates

## Troubleshooting

### Error: "column 'recommended_product_ids' does not exist"

→ Run the migration: `003_add_product_recommendations.sql`

### Error: "operator does not exist: text = integer"

→ This was the original Postgres-specific problem. If still occurring, ensure you're using the updated MySQL recommendation logic in `productController.js`.

### Recommendations not showing

→ Check that `recommended_product_ids` is populated for your products:

```sql
SELECT recommended_product_ids FROM products WHERE id = 'your-product-id';
```

### Wrong recommendations showing

→ Check the `populate_recommendations.sql` script populated correctly and matched products in same category

## Future Enhancements

To add custom recommendations for a product:

```sql
UPDATE products
SET recommended_product_ids = JSON_ARRAY('uuid1', 'uuid2', 'uuid3')
WHERE id = 'target-product-id';
```

This approach is flexible and doesn't require quantity value assumptions.
