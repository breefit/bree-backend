#!/bin/bash
# Quick setup script for product recommendations

echo "================================================"
echo "BREE Product Recommendations - Database Setup"
echo "================================================"
echo ""

# Check if database credentials are available
if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  DATABASE_URL not set. Please set it before running this script."
    echo "   Export: export DATABASE_URL='mysql://user:pass@127.0.0.1:3306/bree'"
    exit 1
fi

parsed=$(node - <<'NODE'
const url = new URL(process.env.DATABASE_URL);
if (!['mysql:', 'mysql2:'].includes(url.protocol)) {
  console.error('DATABASE_URL must use mysql:// or mysql2://');
  process.exit(1);
}
const user = decodeURIComponent(url.username);
const pass = decodeURIComponent(url.password);
const host = url.hostname || '127.0.0.1';
const port = url.port || '3306';
const db = url.pathname.replace(/^\//, '');
if (!db) {
  console.error('DATABASE_URL must include a database name');
  process.exit(1);
}
console.log(`${user}\t${pass}\t${host}\t${port}\t${db}`);
NODE
)

IFS=$'\t' read -r db_user db_pass db_host db_port db_name <<< "$parsed"
if [ -z "$db_user" ] || [ -z "$db_name" ]; then
    echo "⚠️  Failed to parse DATABASE_URL"
    exit 1
fi

export MYSQL_PWD="$db_pass"

echo "📦 Running recommendations SQL against $db_name@$db_host:$db_port"
echo ""

echo "1️⃣  Adding recommended_product_ids column..."
mysql -h "$db_host" -P "$db_port" -u "$db_user" "$db_name" < migrations/003_add_product_recommendations.sql
if [ $? -eq 0 ]; then
    echo "✅ Column added successfully"
else
    echo "❌ Failed to add column"
    unset MYSQL_PWD
    exit 1
fi

echo ""

echo "2️⃣  Populating product recommendations..."
mysql -h "$db_host" -P "$db_port" -u "$db_user" "$db_name" < migrations/populate_recommendations.sql
if [ $? -eq 0 ]; then
    echo "✅ Recommendations populated successfully"
else
    echo "❌ Failed to populate recommendations"
    unset MYSQL_PWD
    exit 1
fi

unset MYSQL_PWD

echo ""
echo "================================================"
echo "✅ Setup Complete!"
echo "================================================"
echo ""
echo "📋 Next steps:"
echo "1. Verify data: mysql -h $db_host -P $db_port -u $db_user -p[password] $db_name -e \"SELECT id, quantity, recommended_product_ids FROM products;\""
echo "2. Start backend: npm start"
echo "3. Test API: curl http://localhost:3000/api/products/your-product-id/recommendations"
echo ""
echo "For more info, see: RECOMMENDATIONS_SETUP.md"
