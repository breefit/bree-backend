# MySQL Migration Guide

This guide explains how to migrate the BREE backend from Neon PostgreSQL to MySQL while preserving application behavior.

## What changed

- Switched backend database connector from `pg` to `mysql2`
- Replaced PostgreSQL-specific SQL with MySQL-compatible syntax
- Added a production-ready MySQL schema file: `backend/mysql-schema.sql`
- Added a MySQL migration runner: `backend/migrations/mysql-migrate.js`
- Updated database config and error handling for MySQL
- Preserved foreign keys, cascade delete behavior, payment flow, and timestamp automation

## How to migrate

1. Update `DATABASE_URL` to a MySQL connection URI, for example:

```env
DATABASE_URL=mysql://user:password@host:3306/database_name
```

If your MySQL instance requires SSL, set the corresponding `ssl` connection options in `backend/src/config/database.js`.

2. Install dependencies:

```bash
cd backend
npm install
```

3. Run the MySQL schema migration:

```bash
cd backend
npm run migrate
```

This executes `backend/migrations/mysql-migrate.js` and creates the schema from `backend/mysql-schema.sql`.

4. Seed the database if needed:

```bash
npm run seed
```

5. Start the backend server:

```bash
npm run dev
```

## Notes

- The new schema stores UUID primary keys as `CHAR(36)` using `UUID()` defaults.
- `created_at` and `updated_at` are handled by MySQL `CURRENT_TIMESTAMP` and `ON UPDATE CURRENT_TIMESTAMP`.
- Product features and recommendations use MySQL `JSON` columns.
- The Razorpay payment flow, order creation, and stock updates remain unchanged.

## Production readiness

- `backend/src/config/database.js` now normalizes `mysql2` query results into a `rows` structure compatible with the existing backend.
- Transactions continue to use `BEGIN`, `COMMIT`, and `ROLLBACK`.
- Unique constraint violations and foreign key errors are mapped to MySQL error codes.
