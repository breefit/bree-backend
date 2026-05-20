// migrations/seed.js
// Run AFTER migrate: node migrations/seed.js
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Create admin user ─────────────────────────────────────────────────────────
const email    = process.env.ADMIN_EMAIL    || 'admin@bree.fit';
const password = process.env.ADMIN_PASSWORD || 'Change_Me_Strong_Password_123!';
const hashed   = await bcrypt.hash(password, 12);

await pool.query(
  `INSERT INTO admins (email, password, name)
   VALUES ($1, $2, 'Admin')
   ON CONFLICT (email) DO UPDATE SET password = $2`,
  [email, hashed]
);
console.log(`✅ Admin created: ${email}`);

// ── Seed products ─────────────────────────────────────────────────────────────
const products = [
  {
    name: '7-Pack Trial', slug: '7-pack-trial',
    category: 'Wellness Shot', description: 'Perfect starter pack to experience BREE Amla shots.',
    price: 299, mrp: 499, quantity: 7, stock_qty: 100,
    image: '', features: ['7 × 50ml bottles', 'Try before committing', 'Free shipping'],
    popular: false, status: 'In Stock',
  },
  {
    name: '30-Pack Monthly Box', slug: '30-pack-monthly',
    category: 'Wellness Shot', description: 'A full month of daily BREE wellness shots.',
    price: 999, mrp: 1499, quantity: 30, stock_qty: 80,
    image: '', features: ['30 × 50ml bottles', 'Best daily routine', '33% off MRP', 'Free shipping'],
    popular: true, status: 'In Stock',
  },
  {
    name: '6-Month Supply', slug: '6-month-supply',
    category: 'Wellness Shot', description: 'Commit to 6 months of daily wellness with maximum savings.',
    price: 4999, mrp: 8994, quantity: 180, stock_qty: 30,
    image: '', features: ['180 × 50ml bottles', '44% off MRP', 'Priority shipping', 'Dedicated support'],
    popular: false, status: 'In Stock',
  },
  {
    name: '1-Year Pack', slug: '1-year-pack',
    category: 'Wellness Shot', description: 'Full year of BREE — the best value for committed wellness.',
    price: 8999, mrp: 17988, quantity: 365, stock_qty: 15,
    image: '', features: ['365 × 50ml bottles', '50% off MRP', 'Free express delivery', 'Monthly check-in call'],
    popular: false, status: 'In Stock',
  },
];

for (const p of products) {
  await pool.query(
    `INSERT INTO products
       (name, slug, category, description, price, mrp, quantity, stock_qty,
        image, features, popular, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug) DO NOTHING`,
    [p.name, p.slug, p.category, p.description, p.price, p.mrp,
     p.quantity, p.stock_qty, p.image, p.features, p.popular, p.status]
  );
}
console.log(`✅ ${products.length} products seeded`);

// ── Testimonials seed cleanup and idempotent sample data ───────────────────
await pool.query(`ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
await pool.query(`ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false`);
await pool.query(`ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
await pool.query(`ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

// Seed testimonials without removing existing data and avoid duplicates by checking text+name
const testimonials = [
  {
    name: 'Priya Sharma',
    role: 'Yoga Instructor',
    avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?q=80&w=200',
    text: 'BREE has become an essential part of my morning routine. The energy boost is incredible!',
    rating: 5,
    status: 'approved',
  },
  {
    name: 'Rahul Mehta',
    role: 'Fitness Enthusiast',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=200',
    text: 'Finally, a wellness shot that actually works. My skin has never looked better.',
    rating: 5,
    status: 'approved',
  },
  {
    name: 'Ananya Patel',
    role: 'Working Professional',
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?q=80&w=200',
    text: 'Love the pure taste and the fact that it has no preservatives. Highly recommend!',
    rating: 5,
    status: 'approved',
  },
];

for (const t of testimonials) {
  // Skip if a testimonial with same name+text already exists (idempotent)
  const exists = await pool.query(
    `SELECT id FROM testimonials WHERE name = $1 AND text = $2 LIMIT 1`,
    [t.name, t.text]
  );
  if (exists.rows.length) {
    console.log(`- Skipping existing testimonial for ${t.name}`);
    continue;
  }

  await pool.query(
    `INSERT INTO testimonials (name, role, avatar, text, rating, approved, status)
     VALUES ($1,$2,$3,$4,$5,true,$6)`,
    [t.name, t.role, t.avatar, t.text, t.rating, t.status]
  );
  console.log(`+ Inserted testimonial for ${t.name}`);
}
console.log(`✅ Testimonials seed complete`);

await pool.end();
console.log('\n🎉 Seed complete! You can now start the server.\n');
