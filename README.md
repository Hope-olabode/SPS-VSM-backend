# sps-vms API (plain Node.js + Express + MySQL)

No ORM. Every database call is normal SQL in `src/routes/*.js`, so anyone who knows SQL can read and change it.
Needs Node 20.6 or newer.

## Setup
```bash
cd backend-node
npm install
cp .env.example .env      # fill in your MySQL details and JWT_SECRET
npm run migrate           # creates the sps_vms database and runs every migration
npm run seed              # Main Lobby + admin@example.com / ChangeMe123!
npm run dev               # http://localhost:4000
```

## Try it
```bash
curl -i -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMe123!"}' -c jar.txt
curl -b jar.txt localhost:4000/api/visitors
```

## Calling it from the Next.js frontend
The frontend never calls port 4000 directly. It calls `/backend/...` on its own site and
`Frontend/next.config.ts` forwards that to `API_URL/api/...` (set `API_URL` in `Frontend/.env.local`).
Same origin = no CORS problems, and the login cookie also reaches `Frontend/src/proxy.ts`, which sends
signed-out users to the login page. In frontend code use the helper: `api("/visitors")` from `src/lib/api.ts`.

Run both: `npm run dev` here (port 4000) and `npm run dev` in `Frontend` (port 3000), then open http://localhost:3000.

## Folder map
- `migrations/` – numbered SQL files that build and change the database
- `scripts/migrate.js` – the migration runner
- `src/routes/` – one file per feature (auth, visitors; add the rest the same way)
- `src/middleware/auth.js` – login cookie + `requireRole(...)`
- `src/middleware/kiosk-auth.js` – `requireKiosk`: the front-desk tablet token (header `x-kiosk-token`) plus the location's 6-digit kiosk code (header `x-kiosk-code`, 423 when missing or wrong) instead of a login
- `src/routes/kiosk.js` – what the tablet calls (`/api/kiosk/config`, `/check-in`, `/check-out`); admins get and regenerate the link at `/api/settings/kiosk`
- `src/utils/check-in.js` – the check-in rules, shared by staff check-in and the kiosk
- Host approval: with the setting on, a kiosk walk-in is saved as `PENDING_APPROVAL`; staff call `POST /api/visitors/:id/approve` or `/decline`, and the kiosk polls `GET /api/kiosk/visits/:id/status`. Pre-registered visitors skip approval.
- Clearance and evacuation: staff answer a kiosk check-out with `POST /api/visitors/:id/approve-clearance` or `/decline-clearance`; `POST /api/visitors/check-out-all` checks out everyone at the location in one transaction and writes one `EMERGENCY_EVACUATION` audit event.
- Reports: `GET /api/reports/:type?from=&to=&company=` (`overstay`, `occupancy`, `lobby`, `category`, `ledger`, `watchlist`) works the numbers out in SQL for the signed-in user's location; `company` is a tenant id, `none` or `all`. The ledger takes `limit` (default 500, max 20000) and always says its full `total`.
- Event registrations: `GET /api/events/:id`, `GET`/`POST /api/events/:id/registrations` and `DELETE /api/events/:id/registrations/:registrationId`. Capacity is checked while the event row is locked; a phone number registers once per event (409 when full, ended or a repeat).
- Event details: `PATCH /api/events/:id` edits an event (capacity can't drop below the places already taken, pending ones included). Each event has a secret registration link, `/register/<token>` on the frontend (`registrationToken` on the event; `POST /api/events/:id/registration-link/regenerate` replaces it). People use it without signing in through `GET /api/public/events/:token` and `POST /api/public/events/:token/registrations` (`routes/public-events.js`, rate limited per IP: 20 sign-ups per 15 minutes). With the event's approval flag on, link sign-ups are `PENDING` (they still hold a place) until staff call `POST /api/events/:id/registrations/:registrationId/approve` or `/decline`; staff-added registrations are approved straight away. Set `TRUST_PROXY` (default 1, the Next.js rewrite) to the number of proxies in front of the API so the limit counts real visitors.
- Location picker: a global admin chooses the location in the top bar with `POST /api/auth/location` `{ locationId }`. The server keeps the choice in a `vms_location` cookie and `requireAuth` swaps it into `req.user.locationId`, so every route (visitors, events, reports, settings, kiosk link and so on) works on that location without changes; the home location stays in `req.user.homeLocationId`. Other roles can't switch (the cookie is ignored), a deleted location falls back to home, and signing in or out resets it. `GET /api/auth/me` reports the location in use as `locationId` and `locationName`, plus `homeLocationId`.
- Visitor details: `GET /api/visitors/:id` (the visit id) returns what the drawer in the Visitor Log shows: contact details, host, purpose, notes, times, who let the visitor in, the documents they signed, and up to 5 earlier visits to the same location (`earlierVisits` is the full count). The photo and signature are not inside it: `hasPhoto` / `hasSignature` say whether `GET /api/visitors/:id/photo` and `/signature` have an image to open. Phone numbers are masked by the same rule as the list. Only visits at the signed-in user's location are found.
- Visitor passes (QR): a pre-registration's QR holds only its code (`PR-605309`); the frontend draws the image itself (`src/lib/qr.ts`), so nothing is stored or fetched for it. The scanner on the Check-In page calls `GET /api/pre-registrations/lookup?code=PR-605309` (this location only; any status comes back, plus `expectedToday`). When staff start a check-in from a scanned pass, `POST /api/visitors` also takes `preRegistrationId`: the pass must still be `EXPECTED` at this location (409 otherwise), it is marked `CHECKED_IN`, the visit keeps the link in `visits.pre_registration_id`, and a pass saved without a phone number takes the visitor's number so check-out finds it again. The kiosk ignores `preRegistrationId`.
- Phone-first kiosk: the kiosk's Check in starts with the visitor's number, sent to `POST /api/kiosk/lookup { phone }` (rate limited per IP: 60 per 10 minutes). The server answers before the form: 403 for a watchlist hit (audited as `WATCHLIST_MATCH`) or when walk-ins are off and the person wasn't pre-registered for today (the same words the check-in uses); `expected` (pre-registered today: name, company, type, resident company, host and purpose come back to fill the form), `returning` (visited this location before: name and company) or `new`; `requiresApproval` tells the screen whether staff will have to let them in. Whether a number is inside the building right now is never revealed, same as check-out. The check-in itself re-checks everything, so changing the number after the lookup gains nothing.
- Maintenance job (`src/utils/maintenance.js`): one job, run every 10 minutes by a timer inside the server (`startMaintenanceTimer()` in `server.js`), that does three things per location from its Control Panel settings. No email or SMS is involved.
  - **Auto check-out** (`autoCheckout`): `end_of_day` checks out anyone who arrived on an earlier day (check-out time 23:59:59 of their arrival day); `8` / `12` check out after that many hours (check-out time = arrival + N hours, not "now"). The visit gets `auto_checked_out = 1`, its pre-registration becomes `CHECKED_OUT`, and one `VISITOR_AUTO_CHECK_OUT` audit event is written per visitor. `never` switches it off. Note the default setting is `end_of_day`.
  - **Overstay flags** (`overstayHours`): a visit still inside after that many hours gets `overstay_flagged_at` once and a `VISITOR_OVERSTAY` audit event. `GET /api/visitors` also sends `overstay` (worked out live from the threshold) and `autoCheckedOut` on every visit, and the Visitor Log shows a red "Overstay" tag. The "alert the host" switches (`notifyOverstay` etc.) do nothing yet: they need an email or SMS sender.
  - **Data retention** (`retentionDays`), in two stages. Stage 1: visits that are over (left or declined), pre-registrations (by expected date) and event registrations (by event end) older than the setting are moved into the `old_records` table and deleted from the live tables (one transaction per batch; a visitor with no visits left is deleted too; photo and signature files stay on disk). They no longer appear in the Visitor Log, Pre-registration, Events, reports or analytics. Stage 2: records in `old_records` older than `ARCHIVE_ANONYMIZE_DAYS` (default 1095, about 3 years) lose name, phone, email, company, notes, job title, the signed-document list and their photo and signature files (`anonymized_at` is set). Global admins read the archive with `GET /api/old-records?source=visit|pre_registration|event_registration&q=&page=` and `/api/old-records/:id/photo` or `/signature`. The watchlist and audit trail are not touched. One `DATA_RETENTION_RUN` audit event per location when something moved. Test first with `npm run jobs -- --dry-run`, which only counts what would move, and back up the database and uploads folder before the first real run.
  - Run it by hand with `npm run jobs`, or from outside with `GET`/`POST /api/jobs/run` and the header `Authorization: Bearer <CRON_SECRET>` (switched off while `CRON_SECRET` is empty). If the API runs on several servers, or on a host that sleeps between requests (serverless), set `JOBS_ENABLED=false` and call that endpoint from a scheduler instead (cron-job.org, GitHub Actions, or Vercel Cron). A MySQL lock makes sure two runs never overlap. Run `npm run migrate` first (migration 011).
- Resident companies: `GET /api/tenants` lists them for the signed-in user's location; admins add, rename and remove them with `POST`, `PATCH /:id` and `DELETE /:id` (`{ name, floor? }`; a name is unique per location; a company with visits, pre-registrations or users can't be removed, only renamed). The check-in, pre-registration and kiosk forms use a type-to-search box over this list, and an admin can add a missing company straight from it.
- `src/db.js` – `query()` and `one()` helpers
- `src/utils/audit.js` – writes the audit trail

## Adding a new feature (example: watchlist)
1. Make `src/routes/watchlist.js` (copy the shape of `visitors.js`).
2. In `src/app.js` add `app.use("/api/watchlist", watchlistRoutes);`
3. Put role limits on routes with `requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN")`.

## Migrations (how the tables are created and changed)
Tables are created by the numbered files in `migrations/`, not by hand.
Each change has two files: `NNN_name.up.sql` (do it) and `NNN_name.down.sql` (undo it).
The runner remembers what it already applied in a table called `schema_migrations`.

| Command | What it does |
| --- | --- |
| `npm run migrate` | Applies every pending migration (also creates the database if missing) |
| `npm run migrate:status` | Lists applied and pending migrations |
| `npm run migrate:rollback` | Undoes only the most recent migration |
| `npm run migrate:make -- add_notes_to_visits` | Creates the next `NNN_...up.sql` / `.down.sql` pair |

Rules:
1. To change the database, make a **new** migration. Never edit one that has already been applied
   (the runner refuses and tells you, because other machines would end up different).
2. Keep each migration small. MySQL can't undo a half-finished table change, so if one fails
   midway, fix the problem by hand or with a new migration.
3. Commit migration files to git so everyone (and the live server) runs the same ones.
4. On the live server run `npm run migrate` before starting the new version of the app.

Example: add a column
```bash
npm run migrate:make -- add_badge_number_to_visits
# up.sql:    ALTER TABLE visits ADD COLUMN badge_number VARCHAR(20) NULL;
# down.sql:  ALTER TABLE visits DROP COLUMN badge_number;
npm run migrate
```
