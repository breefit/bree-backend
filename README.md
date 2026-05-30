# Backend Setup Guide

Express.js REST API for the BREE Wellness E-Commerce Platform with MySQL, Razorpay, and Cloudinary.

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup](#setup)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [Database](#database)
- [Authentication](#authentication)
- [Available Scripts](#available-scripts)

---

## Overview

The backend powers BREE with:

- RESTful API for customer and admin workflows
- JWT authentication and authorization
- MySQL data persistence for users, products, orders, and recommendations
- Razorpay order creation and payment verification
- Cloudinary image upload and management
- Order tracking and status updates
- Recommendation endpoint for smart cart suggestions

---

## Tech Stack

| Tool           | Purpose             |
| -------------- | ------------------- |
| Node.js        | Runtime             |
| Express.js     | Web framework       |
| MySQL          | Database            |
| mysql2         | MySQL driver        |
| JWT            | Authentication      |
| bcryptjs       | Password hashing    |
| Razorpay SDK   | Payment gateway     |
| Cloudinary     | Image hosting       |
| Firebase Admin | Google auth support |

---

## Project Structure

```
backend/
├── src/
│   ├── config/              # Database, Razorpay, Cloudinary, Firebase configuration
│   │   ├── database.js
│   │   ├── cloudinary.js
│   │   ├── razorpay.js
│   │   └── firebaseAdmin.js
│   ├── controllers/         # Business logic layer
│   │   ├── admin/           # Admin-specific controllers
│   │   ├── authController.js
│   │   ├── productController.js
│   │   ├── orderController.js
│   │   ├── paymentController.js
│   │   └── profileController.js
│   ├── middleware/          # Express middleware
│   │   ├── auth.js
│   │   ├── adminAuth.js
│   │   └── errorHandler.js
│   ├── routes/              # API routes
│   │   ├── admin/
│   │   ├── auth.js
│   │   ├── products.js
│   │   ├── orders.js
│   │   └── webhookRoutes.js
│   ├── services/            # External service integrations
│   │   └── authService.js
│   ├── utils/               # Helpers and utilities
│   │   ├── jwt.js
│   │   └── cache.js
│   ├── app.js               # Express application setup
│   └── server.js            # HTTP server and Socket.IO
├── migrations/              # MySQL migration and seed scripts
├── mysql-schema.sql         # Database schema definition
├── package.json
└── README.md
```

---

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- MySQL 8+
- Cloudinary account
- Razorpay account

### Install Dependencies

```bash
cd backend
npm install
```

### Environment Configuration

Create a `.env` file in `backend/`:

```env
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
SMTP_FROM="BREE Wellness <no-reply@breewellness.com>"
DATABASE_URL=mysql://user:password@host:3306/database
JWT_SECRET=your_super_secret_key
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
```

### Database Setup

Run migration and optional seed scripts:

```bash
npm run migrate
npm run seed
```

### Start the Backend

```bash
npm start
```

The backend listens on `http://localhost:4000` by default.

---

## Environment Variables

Required backend variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Additional / optional variables:

- `PORT`
- `NODE_ENV`
- `FRONTEND_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `RAZORPAY_WEBHOOK_SECRET`

---

## API Endpoints

### Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `GET /api/auth/verify`
- `POST /api/auth/logout`

### Products

- `GET /api/products`
- `GET /api/products/:id`
- `GET /api/products/:id/recommendations`

### Cart and Orders

- `POST /api/orders`
- `GET /api/orders`
- `GET /api/orders/:id`
- `GET /api/orders/:id/history`

### Payments

- `POST /api/payment/razorpay`
- `POST /api/webhooks/razorpay`

### Admin

- `GET /api/admin/dashboard`
- `GET /api/admin/products`
- `POST /api/admin/products`
- `PUT /api/admin/products/:id`
- `DELETE /api/admin/products/:id`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:id/status`
- `PATCH /api/admin/orders/bulk-status`

For complete API details, see [../docs/API.md](../docs/API.md).

---

## Database

Supported tables and data relationships include:

- `users`
- `products`
- `orders`
- `order_items`
- `payments`
- `addresses`
- `testimonials`
- `contact_inquiries`

Recommendation data is stored in `recommended_product_ids` as a JSON field.

---

## Authentication

The backend uses JWT tokens for protected routes and admin authorization. Tokens are issued after login and validated for every secure endpoint.

---

## Available Scripts

```bash
npm start
npm run dev
npm run migrate
npm run seed
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
- SQL injection prevention (parameterized mysql2 queries)

---

## Available Scripts

```bash
npm start              # Start server
npm run dev            # Dev with nodemon
npm run migrate        # Run migrations
npm run seed           # Seed database
```

---

## Troubleshooting

**Database connection fails:**

- Verify DATABASE_URL is correct
- Check MySQL is running
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
