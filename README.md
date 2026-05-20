# Backend Setup Guide

Express.js REST API for BREE e-commerce platform with PostgreSQL and Prisma ORM.

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup Instructions](#setup-instructions)
- [API Endpoints](#api-endpoints)
- [Database](#database)
- [Authentication](#authentication)
- [Configuration](#configuration)
- [Available Scripts](#available-scripts)

---

## Overview

The BREE backend provides:

- **RESTful API** for customer and admin operations
- **JWT Authentication** for secure access
- **Database Management** with Prisma ORM
- **Payment Processing** via Razorpay
- **Image Management** via Cloudinary
- **Email Services** for notifications
- **Rate Limiting** and security middleware

---

## Tech Stack

| Tool | Purpose |
|------|---------|
| Node.js | Runtime |
| Express.js | Web framework |
| Prisma | ORM |
| PostgreSQL | Database |
| JWT | Authentication |
| bcryptjs | Password hashing |
| Cloudinary | Image hosting |
| Razorpay | Payment gateway |

---

## Project Structure

```
backend/
├── src/
│   ├── config/              # Configuration
│   │   ├── database.js      # Prisma client
│   │   ├── cloudinary.js    # Cloudinary setup
│   │   ├── razorpay.js      # Razorpay config
│   │   └── firebaseAdmin.js # Firebase config
│   ├── controllers/         # Business logic
│   │   ├── authController.js
│   │   ├── productController.js
│   │   ├── orderController.js
│   │   ├── paymentController.js
│   │   └── admin/
│   ├── middleware/          # Express middleware
│   │   ├── auth.js          # JWT auth
│   │   ├── adminAuth.js     # Admin auth
│   │   └── errorHandler.js  # Error handling
│   ├── routes/              # API routes
│   │   ├── auth.js
│   │   ├── products.js
│   │   ├── orders.js
│   │   └── admin/
│   ├── services/            # External services
│   │   └── authService.js
│   ├── utils/               # Utilities
│   │   ├── jwt.js           # JWT helpers
│   │   └── cache.js         # Caching logic
│   ├── app.js               # Express app setup
│   └── server.js            # Server entry point
├── prisma/
│   ├── schema.prisma        # Database schema
│   └── migrations/          # Database migrations
└── package.json
```

---

## Setup Instructions

### Prerequisites

- Node.js 18+
- npm or yarn
- PostgreSQL account (Neon recommended)
- Razorpay account
- Cloudinary account

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Environment Configuration

Create `.env` file:

```env
# Server
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://user:password@host:port/database

# JWT
JWT_SECRET=your_super_secret_key_minimum_32_chars
JWT_EXPIRE=7d

# Razorpay
RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=your_key_secret

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Email (Optional)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password
```

### 3. Initialize Database

```bash
# Run migrations
npx prisma migrate dev

# Optional: Seed data
npx prisma db seed
```

### 4. Start Server

```bash
npm start
```

Server runs at: `http://localhost:5000`

---

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Email login
- `POST /api/auth/google` - Google OAuth
- `GET /api/auth/verify` - Verify token
- `POST /api/auth/logout` - Logout

### Products
- `GET /api/products` - List products
- `GET /api/products/:id` - Product details

### Orders (Protected)
- `GET /api/orders` - User orders
- `POST /api/orders` - Create order
- `POST /api/payment/razorpay` - Process payment

### Admin (Protected + Admin Role)
- `GET /api/admin/dashboard` - Analytics
- `GET /api/admin/products` - All products
- `POST /api/admin/products` - Create product
- `PUT /api/admin/products/:id` - Update product
- `DELETE /api/admin/products/:id` - Delete product
- `GET /api/admin/orders` - All orders
- `PATCH /api/admin/orders/:id/status` - Update status
- `PATCH /api/admin/orders/bulk-status` - Bulk update

See [API Reference](../docs/API.md) for complete documentation.

---

## Database

### Schema Tables

- **users** - Customer and admin accounts
- **products** - Product catalog
- **orders** - Customer orders
- **order_items** - Order line items
- **payments** - Payment transactions
- **addresses** - Shipping addresses
- **testimonials** - Customer reviews
- **contact_inquiries** - Contact form submissions

See [Database Schema](../docs/DATABASE.md) for details.

### Running Migrations

```bash
# Create new migration
npx prisma migrate dev --name add_feature

# Deploy to production
npx prisma migrate deploy

# View migration status
npx prisma migrate status

# Open Prisma Studio
npx prisma studio
```

---

## Authentication

### JWT Tokens

1. User logs in with email/password or Google OAuth
2. Backend generates JWT token (valid 7 days)
3. Token sent to frontend via response + HTTP-only cookie
4. Frontend includes token in Authorization header

### Token Verification

All protected routes check JWT token:

```javascript
// middleware/auth.js
const auth = (req, res, next) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  
  const decoded = verifyUserToken(token);
  req.user = decoded;
  next();
};
```

---

## Configuration

### Razorpay Setup

1. Create account at razorpay.com
2. Get test/live keys
3. Add to `.env`
4. Payment verification in backend:

```javascript
// Verify payment signature
const signature = generateSignature(order_id, payment_id, secret);
if (signature !== razorpay_signature) throw Error('Invalid');
```

### Cloudinary Setup

1. Create account at cloudinary.com
2. Get cloud name and API keys
3. Add to `.env`
4. Upload via multer integration

---

## Caching

Backend implements TTL-based caching:

- **Products**: 5 minutes
- **Testimonials**: 10 minutes
- **Dashboard**: 2 minutes

Cache invalidated on updates.

---

## Security Features

- JWT authentication
- Password hashing (bcryptjs)
- Rate limiting on auth routes
- CORS configuration
- Helmet.js security headers
- Input validation
- SQL injection prevention (Prisma)

---

## Available Scripts

```bash
npm start              # Start server
npm run dev           # Dev with nodemon
npm run migrate       # Run migrations
npm run seed          # Seed database
npm run lint          # Lint code
npm run build         # Build (if applicable)
```

---

## Troubleshooting

**Database connection fails:**
- Verify DATABASE_URL is correct
- Check PostgreSQL is running
- Test connection locally

**Payment processing fails:**
- Verify Razorpay keys (live vs test)
- Check signature verification
- Review Razorpay logs

**Image upload fails:**
- Verify Cloudinary credentials
- Check file size limits
- Review upload permissions

---

## Environment Variables

### Development
```env
NODE_ENV=development
JWT_SECRET=dev_secret_minimum_32_characters
RAZORPAY_KEY_ID=rzp_test_xxxxx
```

### Production
```env
NODE_ENV=production
JWT_SECRET=use_strong_random_string_minimum_32_chars
RAZORPAY_KEY_ID=rzp_live_xxxxx
SENTRY_DSN=your_sentry_key
```

---

## Related Documentation

- [Root README](../README.md) - Project overview
- [Frontend README](../frontend/README.md) - Frontend setup
- [API Reference](../docs/API.md) - Complete endpoints
- [Database Schema](../docs/DATABASE.md) - Database tables
- [Deployment Guide](../docs/DEPLOYMENT.md) - Production deployment

---

**Last Updated:** May 2026
