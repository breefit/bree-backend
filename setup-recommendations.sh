#!/bin/bash
# Quick setup script for product recommendations

echo "================================================"
echo "BREE Product Recommendations - Database Setup"
echo "================================================"
echo ""

# Check if database credentials are available
if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  DATABASE_URL not set. Please set it before running this script."
    echo "   Export: export DATABASE_URL='postgresql://user:pass@localhost:5432/bree'"
    exit 1
fi

echo "📦 Running migrations..."
echo ""

# Run the migration to add recommended_product_ids column
echo "1️⃣  Adding recommended_product_ids column..."
psql "$DATABASE_URL" -f migrations/003_add_product_recommendations.sql
if [ $? -eq 0 ]; then
    echo "✅ Column added successfully"
else
    echo "❌ Failed to add column"
    exit 1
fi

echo ""

# Populate recommendations
echo "2️⃣  Populating product recommendations..."
psql "$DATABASE_URL" -f migrations/populate_recommendations.sql
if [ $? -eq 0 ]; then
    echo "✅ Recommendations populated successfully"
else
    echo "❌ Failed to populate recommendations"
    exit 1
fi

echo ""
echo "================================================"
echo "✅ Setup Complete!"
echo "================================================"
echo ""
echo "📋 Next steps:"
echo "1. Verify data: psql \$DATABASE_URL -c \"SELECT id, quantity, recommended_product_ids FROM products;\""
echo "2. Start backend: npm start"
echo "3. Test API: curl http://localhost:3000/api/products/your-product-id/recommendations"
echo ""
echo "For more info, see: RECOMMENDATIONS_SETUP.md"
