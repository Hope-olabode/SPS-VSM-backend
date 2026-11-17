# SPS VMS API

REST API for the SPS Visitor Management System: visitor check-in and check-out, pre-registrations, events, a front-desk kiosk, a watchlist, reports, audit trail, SMS and data retention.

Built with plain **Node.js + Express 5 + MySQL**. There is no ORM: every database call is ordinary SQL inside `src/routes/*.js`, so anyone who knows SQL can read and change it.

The web app lives in the sibling `frontend/` folder (see its README).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [npm scripts](#npm-scripts)
- [Try it](#try-it)
- [How the frontend talks to this API](#how-the-frontend-talks-to-this-api)
- [Users and roles](#users-and-roles)
- [Project structure](#project-structure)
- [API overview](#api-overview)
- [Feature notes](#feature-notes)
- [Maintenance job](#maintenance-job)
- [Migrations](#migrations)
- [Adding a new feature](#adding-a-new-feature)
- [Deployment checklist](#deployment-checklist)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js **20.9 or newer** (the scripts use `node --env-file`, which needs 20.6+)
- A MySQL server that **already has an empty database** for this app, reachable over **TLS** (see the note below)

> **Database connection note.** `src/db.js` and `scripts/migrate.js` both connect with `ssl: { rejectUnauthorized: true }`, and the migration runner does **not** create the database. So:
> 1. Create the database yourself first (for example `CREATE DATABASE \`sps-vms\`;`).
> 2. Use a MySQL server with a valid TLS certificate, such as your hosting provider's managed MySQL.
> 3. For a local MySQL without TLS, temporarily remove the `ssl` option in those two files. Do not ship that change to production.

## Quick start

```bash
cd backend
npm install
cp .env.example .env      # then fill in DB_* and JWT_SECRET (see the table below)
npm run db:check          # confirms the database connection works
npm run migrate           # creates all tables
npm run seed              # Main Lobby, 4 sample resident companies, and the first admin
npm run dev               # http://localhost:4000 (auto-restarts on file changes)
```

The seed creates `admin@example.com` with the password `ChangeMe123!`. **Change it after your first login.** The sample resident companies are listed in `seed.js`; edit that list to match your building before seeding.

Check that the server is up: `GET http://localhost:4000/api/health` returns `{ "ok": true }`.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `PORT` | no | `4000` | Port the API listens on |
| `CLIENT_ORIGIN` | yes | – | URL of the frontend (CORS allow-list), e.g. `http://localhost:3000` |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | yes | – | MySQL connection. The database must already exist |
| `DB_PORT` | no | `3306` | MySQL port |
| `JWT_SECRET` | yes | – | Signs login cookies. Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `KIOSK_TOKEN_KEY` | no | `JWT_SECRET` | Encrypts the stored kiosk link so admins can view it again. Changing it means regenerating the kiosk link |
| `TRUST_PROXY` | no | `1` | How many proxies sit in front of the API. `1` suits the Next.js rewrite; use `0` if the API is exposed directly. Needed so rate limits count real visitors |
| `SMS_PROVIDER` | no | empty | Set to `termii` for real SMS. Empty means every send is a harmless dry run |
| `TERMII_API_KEY`, `SMS_SENDER_ID` | with Termii | – | Termii credentials and sender name |
| `TERMII_BASE_URL`, `TERMII_CHANNEL` | no | `https://api.ng.termii.com`, `generic` | Use the base URL shown in your Termii dashboard; channel is `generic` or `dnd` |
| `UPLOADS_DIR` | no | `./uploads` | Where visitor photos and signatures are saved. Keep it out of git and back it up |
| `JOBS_ENABLED` | no | `true` | Set `false` to turn off the built-in maintenance timer (see [Maintenance job](#maintenance-job)) |
| `JOBS_INTERVAL_MINUTES` | no | `10` | How often the built-in timer runs |
| `CRON_SECRET` | no | empty | Lets an outside scheduler call `/api/jobs/run`. Empty keeps that endpoint switched off |
| `ARCHIVE_ANONYMIZE_DAYS` | no | `1095` | Days before archived records lose their personal details (about 3 years) |

## npm scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with auto-restart on changes |
| `npm start` | Start normally (production) |
| `npm run db:check` | Test the database connection and print the MySQL version |
| `npm run migrate` | Apply all pending migrations |
| `npm run migrate:status` | List applied and pending migrations |
| `npm run migrate:rollback` | Undo only the most recent migration |
| `npm run migrate:make -- add_notes_to_visits` | Create the next numbered `.up.sql` / `.down.sql` pair |
| `npm run seed` | Create Main Lobby, sample resident companies and the first admin (safe to re-run) |
| `npm run jobs` | Run the maintenance job once by hand. Add `-- --dry-run` to only count what would change |

## Try it

```bash
# Log in and save the session cookie
curl -i -X POST localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMe123!"}' -c jar.txt

# Use the cookie
curl -b jar.txt localhost:4000/api/visitors
```

## How the frontend talks to this API

The browser never calls port 4000 directly. It calls `/backend/...` on the frontend's own origin, and `frontend/next.config.ts` forwards that to `API_URL/api/...`. Benefits:

- Same origin, so no CORS trouble.
- The httpOnly login cookie (`vms_session`) is also visible to `frontend/src/proxy.ts`, which sends signed-out users to the login page.

In frontend code use the helper `api("/visitors")` from `src/lib/api.ts`.

To run both: `npm run dev` in `backend/` (port 4000) and `npm run dev` in `frontend/` (port 3000), then open http://localhost:3000.

## Users and roles

Roles are stored on the user: `GLOBAL_ADMIN`, `LOCATION_ADMIN`, `MANAGER`, `TENANT_REP`, `USER`.

- Login uses an httpOnly cookie. `requireAuth` reads it; `requireRole(...)` limits a route to certain roles.
- **Location picker:** a `GLOBAL_ADMIN` can switch location from the top bar with `POST /api/auth/location { locationId }`. The server stores the choice in a `vms_location` cookie and swaps it into `req.user.locationId`, so every route works on the chosen location with no changes. The user's own location stays in `req.user.homeLocationId`. Other roles can't switch (the cookie is ignored), a deleted location falls back to home, and signing in or out resets the choice. `GET /api/auth/me` returns `locationId`, `locationName` and `homeLocationId`.

## Project structure

```
backend/
├── migrations/          numbered SQL files (NNN_name.up.sql / .down.sql)
├── scripts/
│   ├── migrate.js       migration runner
│   ├── run-jobs.js      run the maintenance job by hand
│   └── check-db.js      database connection test
├── seed.js              first location, resident companies and admin
└── src/
    ├── server.js        starts the server and the maintenance timer
    ├── app.js           middleware and route mounting
    ├── db.js            shared pool plus query() and one() helpers
    ├── middleware/
    │   ├── auth.js        login cookie + requireRole(...)
    │   └── kiosk-auth.js  kiosk token + unlock cookie (no login)
    ├── routes/          one file per feature
    └── utils/           shared logic (check-in rules, audit, SMS, uploads, maintenance...)
```

Always pass values to SQL as `?` parameters; never build SQL by joining strings.

## API overview

All routes are under `/api`. Unless noted, they need a login.

| Prefix | Purpose | Notes |
| --- | --- | --- |
| `/auth` | Login, logout, current user, location picker | |
| `/visitors` | Visitor log, check-in, check-out, approvals, photos, signatures | |
| `/pre-registrations` | Expected visitors and their QR codes | |
| `/events` | Events and their registrations | |
| `/public` | Public event sign-up | No login; the link's secret token is the key |
| `/kiosk` | Front-desk tablet | Kiosk token + access code, no login |
| `/tenants` | Resident companies | |
| `/watchlist` | Blocked or flagged people | |
| `/reports`, `/analytics` | Numbers worked out in SQL | |
| `/audit`, `/notifications` | Audit trail and the notification bell | Audit is admin-only |
| `/users`, `/locations`, `/settings` | Administration | Admin roles; saving settings and kiosk regeneration are global-admin only |
| `/documents` | Documents visitors sign | |
| `/sms` | Marketing SMS | Dry run unless `SMS_PROVIDER` is set |
| `/old-records` | Archive created by data retention | Global admins |
| `/jobs` | Trigger the maintenance job | `CRON_SECRET` bearer token, no login |
| `/health` | Health check | No login |

## Feature notes

### Check-in and visitors

- The check-in rules live in `src/utils/check-in.js` and are shared by staff check-in and the kiosk.
- **Visitor details:** `GET /api/visitors/:id` (the visit id) returns what the Visitor Log drawer shows: contact details, host, purpose, notes, times, who let the visitor in, signed documents, and up to 5 earlier visits (`earlierVisits` is the full count). Photo and signature are separate: `hasPhoto` / `hasSignature` say whether `GET /api/visitors/:id/photo` and `/signature` have an image. Phone numbers are masked by the same rule as the list. Only visits at the signed-in user's location are found.
- **Photo and signature** arrive as data URLs in the check-in request (JSON body limit 3 MB) and are saved to `UPLOADS_DIR`.

### Host approval, clearance and evacuation

- With the approval setting on, a kiosk walk-in is saved as `PENDING_APPROVAL`. Staff call `POST /api/visitors/:id/approve` or `/decline`, and the kiosk polls `GET /api/kiosk/visits/:id/status`. Pre-registered visitors skip approval.
- Staff answer a kiosk check-out with `POST /api/visitors/:id/approve-clearance` or `/decline-clearance`.
- `POST /api/visitors/check-out-all` checks out everyone at the location in one transaction and writes one `EMERGENCY_EVACUATION` audit event.

### Kiosk

- The tablet authenticates with the location's kiosk token (header `x-kiosk-token`) **and** by having been unlocked with the 6-digit access code. The code is sent **once**, to `POST /api/kiosk/unlock`. The server then gives the tablet an **httpOnly cookie** (`kiosk_<id>`) as proof, which page JavaScript can't read. The code itself is never stored on the tablet or sent again. The proof is tied to the link and the current code, so regenerating either one locks every tablet again (`423`). It calls `/api/kiosk/config`, `/lookup`, `/check-in` and `/check-out`.
- Admins (global and location) read the link at `GET /api/settings/kiosk`. The 6-digit access code is only included for **global admins**. Regenerating the link or the code (`POST /api/settings/kiosk/regenerate`, `/kiosk/code/regenerate`) and saving settings (`PUT /api/settings`) are global-admin only. Treat the link like a password: anyone with it can use the kiosk.
- **Phone-first check-in:** the visitor's number goes to `POST /api/kiosk/lookup { phone }` (rate limited: 60 per 10 minutes per IP). The server answers before the form is shown:
  - `403` for a watchlist hit (audited as `WATCHLIST_MATCH`), or when walk-ins are off and the person wasn't pre-registered for today.
  - `expected` (pre-registered today; name, company, type, host and purpose come back to fill the form), `returning` (visited before; name and company) or `new`.
  - `requiresApproval` tells the screen whether staff must let them in.
  - Whether a number is inside the building right now is never revealed, same as check-out. The check-in itself re-checks everything, so changing the number after lookup gains nothing.

### Pre-registration and QR passes

- A pre-registration's QR holds only its code (e.g. `PR-605309`). The frontend draws the image (`src/lib/qr.ts`), so nothing is stored for it.
- The Check-In page scanner calls `GET /api/pre-registrations/lookup?code=PR-605309` (this location only; any status comes back, plus `expectedToday`).
- When staff start a check-in from a scanned pass, `POST /api/visitors` also accepts `preRegistrationId`. The pass must still be `EXPECTED` at this location (`409` otherwise); it becomes `CHECKED_IN`, the visit keeps the link in `visits.pre_registration_id`, and a pass saved without a phone number takes the visitor's number so check-out can find it. The kiosk ignores `preRegistrationId`.

### Events

- Routes: `GET`/`PATCH /api/events/:id`, `GET`/`POST /api/events/:id/registrations`, `DELETE /api/events/:id/registrations/:registrationId`.
- Capacity is checked while the event row is locked. A phone number registers once per event (`409` when full, ended or a repeat). Capacity can't be lowered below the places already taken, pending ones included.
- Each event has a secret registration link, `/register/<token>` on the frontend (`registrationToken` on the event). `POST /api/events/:id/registration-link/regenerate` replaces it.
- People use the link without signing in via `GET /api/public/events/:token` and `POST /api/public/events/:token/registrations` (rate limited: 20 sign-ups per 15 minutes per IP).
- With the event's approval flag on, link sign-ups are `PENDING` (they still hold a place) until staff call `POST .../registrations/:registrationId/approve` or `/decline`. Staff-added registrations are approved straight away.

### Reports

`GET /api/reports/:type?from=&to=&company=` where `type` is `overstay`, `occupancy`, `lobby`, `category`, `ledger` or `watchlist`. Numbers are worked out in SQL for the signed-in user's location. `company` is a tenant id, `none` or `all`. The ledger takes `limit` (default 500, max 20000) and always reports its full `total`.

### Resident companies

`GET /api/tenants` lists them for the user's location. Admins add, rename and remove them with `POST`, `PATCH /:id` and `DELETE /:id` (`{ name, floor? }`). Names are unique per location. A company with visits, pre-registrations or users can't be removed, only renamed.

## Maintenance job

One job, in `src/utils/maintenance.js`, runs every 10 minutes from a timer inside the server (`startMaintenanceTimer()`). It does three things per location, driven by that location's Control Panel settings. No email or SMS is involved.

**1. Auto check-out** (`autoCheckout`)
- `end_of_day` checks out anyone who arrived on an earlier day (check-out time 23:59:59 of their arrival day). This is the default.
- `8` or `12` check out after that many hours (check-out time = arrival + N hours, not "now").
- `never` switches it off.
- The visit gets `auto_checked_out = 1`, its pre-registration becomes `CHECKED_OUT`, and one `VISITOR_AUTO_CHECK_OUT` audit event is written per visitor.

**2. Overstay flags** (`overstayHours`)
- A visit still inside after that many hours gets `overstay_flagged_at` once, plus a `VISITOR_OVERSTAY` audit event.
- `GET /api/visitors` also returns `overstay` (worked out live) and `autoCheckedOut`, and the Visitor Log shows a red "Overstay" tag.
- The "alert the host" switches (`notifyOverstay` etc.) do nothing yet; they need an email or SMS sender.

**3. Data retention** (`retentionDays`), in two stages
- *Stage 1:* finished visits (left or declined), pre-registrations (by expected date) and event registrations (by event end) older than the setting are moved to the `old_records` table and deleted from the live tables, one transaction per batch. A visitor with no visits left is deleted too. Photo and signature files stay on disk. These records vanish from the Visitor Log, Pre-registration, Events, reports and analytics.
- *Stage 2:* records in `old_records` older than `ARCHIVE_ANONYMIZE_DAYS` lose name, phone, email, company, notes, job title, signed-document list, and their photo and signature files (`anonymized_at` is set).
- Global admins read the archive with `GET /api/old-records?source=visit|pre_registration|event_registration&q=&page=` and `/api/old-records/:id/photo` or `/signature`.
- The watchlist and audit trail are never touched. One `DATA_RETENTION_RUN` audit event is written per location when something moved.
- **Test first** with `npm run jobs -- --dry-run`, and back up the database and uploads folder before the first real run.

**Running it from outside**
- Manually: `npm run jobs`.
- From a scheduler: `GET` or `POST /api/jobs/run` with header `Authorization: Bearer <CRON_SECRET>` (off while `CRON_SECRET` is empty).
- If the API runs on several servers, or on a host that sleeps between requests (serverless), set `JOBS_ENABLED=false` and call that endpoint from a scheduler instead (cron-job.org, GitHub Actions, Vercel Cron). A MySQL lock ensures two runs never overlap.

## Migrations

Tables are created by the numbered files in `migrations/`, not by hand. Each change has two files: `NNN_name.up.sql` (do it) and `NNN_name.down.sql` (undo it). The runner records what it has applied in the `schema_migrations` table.

Rules:
1. To change the database, make a **new** migration. Never edit one that has already been applied (the runner refuses and tells you, because other machines would end up different).
2. Keep each migration small. MySQL can't undo a half-finished table change, so if one fails midway, fix it by hand or with a new migration.
3. Commit migration files to git so everyone, and the live server, runs the same ones.
4. On the live server, run `npm run migrate` **before** starting the new version of the app.

Example: add a column
```bash
npm run migrate:make -- add_badge_number_to_visits
# up.sql:    ALTER TABLE visits ADD COLUMN badge_number VARCHAR(20) NULL;
# down.sql:  ALTER TABLE visits DROP COLUMN badge_number;
npm run migrate
```

## Adding a new feature

Example: a new `watchlist` route.

1. Create `src/routes/watchlist.js` (copy the shape of `visitors.js`).
2. In `src/app.js`, import it and add `app.use("/api/watchlist", watchlistRoutes);`.
3. Limit roles with `requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN")`.
4. Add a migration if it needs new tables or columns.
5. Write audit events with `src/utils/audit.js` for anything staff should be able to trace.

## Deployment checklist

- [ ] Strong, unique `JWT_SECRET`; `CLIENT_ORIGIN` set to the real frontend URL
- [ ] `ssl` verification stays on for the database connection
- [ ] Seeded admin password changed
- [ ] `TRUST_PROXY` matches the number of proxies in front of the API
- [ ] `npm run migrate` run before starting the new version
- [ ] `UPLOADS_DIR` on persistent storage and included in backups
- [ ] On serverless or multi-instance hosting: `JOBS_ENABLED=false` plus a scheduler calling `/api/jobs/run` with `CRON_SECRET`
- [ ] `SMS_PROVIDER=termii` and credentials set, only if you want real SMS
- [ ] Kiosk link and access code shared only with whoever sets up the tablet

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Missing environment variables: ...` when migrating | Fill `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `.env` |
| `Connection failed: ...` from `npm run db:check` | Wrong credentials, database doesn't exist yet, or the server doesn't offer TLS (see the database note above) |
| `cp .env.example .env` says the file is missing | `.env.example` must be committed. Make sure it is not listed in `.gitignore` |
| Frontend shows "The server isn't responding. Is the API running?" | Start the API (`npm run dev` here) and check `API_URL` in `frontend/.env.local` |
| Rate limits hit everyone at once | `TRUST_PROXY` is too low, so all visitors look like one IP |
| Kiosk link stopped working after a deploy | `KIOSK_TOKEN_KEY` (or `JWT_SECRET`) changed; regenerate the link in the Control Panel |
