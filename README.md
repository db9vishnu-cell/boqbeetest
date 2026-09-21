# BOQBEE v2 — Cloud / Central Database Edition

This package converts the current BOQBEE browser application from browser-local data storage to a shared central PostgreSQL database with server-side authentication and permissions.

## What is included

- `public/` — current BOQBEE interface and bundled BOQBEE logo
- `server/server.js` — Express API, authentication, permissions, state synchronization, user management, and backup endpoints
- `db/schema.sql` — PostgreSQL schema
- `scripts/backup.sh` — `pg_dump` backup helper
- `Dockerfile` and `docker-compose.yml` — local/server deployment template

## Initial accounts

Super Admin: `superadmin` / `Admin@123`

Normal users: `user1` / `User1@123`, `user2` / `User2@123`, `user3` / `User3@123`

Change these immediately after first login.

## Local deployment

Requirements: Node.js 20+, PostgreSQL 16+.

1. Create a PostgreSQL database and set `DATABASE_URL`.
2. Set a long random `JWT_SECRET`.
3. Run `cd server && npm install`.
4. Start with `node server/server.js`.
5. Open `http://localhost:3000`.

Or use Docker Compose after changing the example database password and JWT secret.

## Data storage

BOQ, clients, projects, accounts/payments, masters, company settings, quotation settings, and approval state are stored centrally in PostgreSQL. Users and password hashes are stored server-side. The browser no longer needs to be the primary data store.

## Backups

Use `scripts/backup.sh` with `DATABASE_URL` set. Recommended server scheduling is once per day via cron or the hosting provider's scheduled job system, with at least 30 days of retention.

The API also keeps state snapshots in the `state_backups` table before every accepted state update and exposes Super Admin backup endpoints.

## Multi-user behavior

Each save uses an optimistic version number. If another user has saved newer data, the API returns HTTP 409 instead of silently overwriting it. The frontend displays a conflict notice and can reload the latest server state.

## Production hosting

Deploy the Node app behind HTTPS and put PostgreSQL on a managed/private network. Keep `DATABASE_URL` and `JWT_SECRET` as server environment variables; do not put them in the frontend. Configure automated PostgreSQL backups in addition to the application snapshots.
