# Sajilo Yatra

A Next.js 16 / React 19 / TypeScript application for vehicle seat booking in Nepal. PostgreSQL 15+ with
Prisma 6, Tailwind 4, Radix/shadcn-style components and TanStack Query. There are two sign-ins: the admin
creates drivers and approves their changes; each driver runs their own vehicles, routes, prices and
trips. Passengers book without an account and pay by QR.

## Quick start (local development)

Requires Node.js 22+ and a PostgreSQL 15+ server that allows `CREATE EXTENSION btree_gist`.

1. `npm install` (also generates the Prisma client).
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `APP_ORIGIN`, `SESSION_SECRET` (32+ characters) and `CRON_SECRET`.
   - No local PostgreSQL required: `npm run db:local` creates and starts a private, password-free cluster in `.localdb/` (git-ignored) on port 54329 and prints the `DATABASE_URL` to paste; `npm run db:local:stop` stops it.
   - Hosted database (Supabase, OVH, Railway, …): use the provider's connection string **and allow this machine's IP in the provider's firewall**. A `PrismaClientInitializationError` after ~5 seconds on every request means the host cannot be reached at all; run `npm run db:check` to see the reason.
3. `npm run db:setup` applies all migrations and seeds the admin and a demo driver. The seed prints the sign-in details; placeholder values in `.env` mean the development defaults are used, and production refuses to seed without explicit `ADMIN_EMAIL`/`ADMIN_PASSWORD` (plus `DRIVER_*`).
4. `npm run dev`, and in a second terminal `npm run worker` (releases expired holds and sends queued emails).
5. Open http://localhost:3000. Sign in at `/staff/sign-in` (links in the footer). As the driver: add a vehicle with its seats, a route with stops and prices, and a payment QR, then schedule a trip once the admin has approved them. As the admin: create drivers, review *Driver requests*, add locations and edit the website text under *Website*.

`npm run db:check` prints whether the configured database is reachable, the server version and how many migrations are applied.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Add `connect_timeout=5` so an unreachable host fails fast. |
| `APP_ORIGIN` | Exact public origin (scheme + host + port). Every write must carry it as the `Origin` header (CSRF guard). |
| `SESSION_SECRET` | 32+ random characters; signs sessions, booking links and tickets. The server refuses to start in production without it. |
| `CRON_SECRET` | 32+ random characters for `POST /api/jobs/expire`; optional when `npm run worker` runs. |
| `RATE_LIMITS` | `on` enables request throttling (15-minute windows per IP/account). **Off by default: repeated attempts are never blocked and accounts are never locked.** |
| `TRUST_PROXY` | `true` only behind a proxy that overwrites `x-real-ip`. |
| `STORAGE_DIR` / `S3_*` | Uploads go to a private S3 bucket when `S3_BUCKET` is set, otherwise to `STORAGE_DIR` (default `./storage`) on the local disk. |
| `SMTP_*`, `MAIL_FROM` | Ticket confirmation emails and booking-tracking codes. `SMTP_REQUIRE_TLS=false` allows plaintext relays. |
| `SMS_HTTP_URL`, `SMS_HTTP_TOKEN` | Optional HTTPS SMS gateway (`POST {to,message}` with a bearer token). |
| `OTP_CONSOLE` | Development prints tracking codes to the server console when no channel is configured; `on` allows that in production (not recommended). |

Configuration is validated at startup (`src/instrumentation.ts`): errors stop a production server with a clear message, warnings are printed, and the database reachability is logged.

## Drivers

The admin creates each driver under *Drivers → Add*. Every driver gets a private internal `Operator` record that owns their vehicles, routes and bookings and keeps one driver's data apart from another's. Nobody signs in to it, and it is shown as the driver's name.

- **Live at once:** the driver's name, phone numbers, address, photo and password (`/driver/profile`). Email and licence details stay with the admin.
- **Automatically active, with admin control:** vehicles and seat plans, routes with stops and prices, and payment QR accounts are validated and made active as soon as the driver posts them. Each is recorded under *Driver requests*, where an admin can reject or deactivate it and later activate it again. Places a driver types are added when the route is posted.
- **Driver-created trips:** `/driver/schedule` takes the arrival from the route. Publishing is all-or-nothing: every departure is checked against the driver's and the vehicle's other trips first, and a failure leaves nothing behind. One-off departures use the route price; a long-term schedule may set its own full-route fare. Existing trips keep the fares and stops they were opened with. Changing one trip, or pausing and resuming a schedule, never touches another trip or a trip the driver closed themselves.
- **Fixed after registration:** a vehicle's seat plan, as for every vehicle.
- **Payments and cancellations:** the driver reviews payment proofs and cancels bookings on their own trips; the admin sees everything and can do the same. Any verified money on a cancelled booking becomes a refund record that the admin settles. A trip that still has bookings is cancelled by the admin, or by the driver once its bookings are cancelled.
- **Seats:** a driver can block a free seat for one departure; sold or held seats cannot be blocked.
- **Deactivating a driver** signs them out and closes booking on their scheduled trips.

## Sign-in and throttling policy

- Admins and drivers have separate records and opaque 12-hour database sessions.
- **No account lockout.** Any number of wrong passwords is refused one at a time; the next correct password signs in. Failed attempts are only counted for reporting.
- **No request limits by default.** Set `RATE_LIMITS=on` to re-enable the per-IP and per-account 15-minute buckets on sign-in, bookings, uploads and tracking.
- Booking-tracking codes are 6 digits, expire in 5 minutes, are single use and allow 5 guesses each; a new code can be requested at any time.

## Booking and payment rules

Each reservation holds 1–8 seats for 10 minutes by default (admin setting). The server calculates the fare from the trip's frozen fare matrix; a passenger may ride any leg between two allowed stops, and a seat can be sold again on the legs left over. An unguessable capability in an HttpOnly cookie protects booking details; a reference alone gives no access. A client idempotency key makes reservation retries safe: the same key replays the same booking, a changed request under the same key is refused.

Uploading a payment screenshot moves the booking to `PAYMENT_REVIEW` and extends the hold once by the review window. Staff must confirm against real bank/wallet evidence and record the independently verified amount, which must cover the full fare, before a booking becomes `CONFIRMED`; a confirmation email with the ticket is queued inside the same transaction and delivered by the worker. Expired reviews release the seats but keep the evidence (`PAYMENT_RECONCILIATION_REQUIRED`); a late verification re-acquires the seats only when all are still free. Rejection releases the seats. Duplicate transaction references are flagged on all affected payments and must be acknowledged explicitly. Confirmed seats are never released automatically; database triggers block it, and refunds are an operator process recorded in the audit log.

Trips snapshot their stop timeline, fares and the payment QR when created; later route or fare edits never touch trips already on sale. Vehicles keep the seat layout version they were registered with. Suspending an operator signs its staff out, closes sales on its scheduled trips and hides them from search; reinstating restores sign-in, and staff reopen trips deliberately.

## CRUD and deletion rules

Every admin module supports create, read, update and delete through `GET/POST/PATCH/DELETE /api/admin/:resource[/:id]`. Deletion is guarded so history stays intact:

| Record | Can be deleted when | Otherwise |
| --- | --- | --- |
| Location | no route uses it as origin, destination, stop or point | 409 |
| Route, vehicle, payment QR | no trip references it | 409: mark inactive |
| Driver | never assigned to a trip | 409: mark inactive |
| Trip | it has no bookings at all | 409: cancel it (needs no active bookings) |
| Fare, boarding/drop-off point | always | – |
| Seat layout | never published and not used by a vehicle | 409: archive it |
| Bookings, payments, audit rows | never (audit rows are immutable at the database level) | – |

Foreign tenants' records look like missing ones (404). Every deletion writes an audit row.

## Uploads

JPEG, PNG and WebP up to 5 MiB. The request stream is capped before parsing; Sharp decodes the real content, rejects type mismatches and multi-page images, strips metadata and re-encodes a WebP object under a random id. Payment proofs are private (booking owner, platform admin or the operator with `payments.read`); QR, vehicle and driver images are public by random id. Objects live in S3 when configured, otherwise in `STORAGE_DIR` (mount a persistent volume; the Docker image uses `/data/storage`).

## Tests

| Command | What it covers |
| --- | --- |
| `npm run check` | Prisma schema validation, TypeScript, ESLint. |
| `npm test` | Unit tests: policies, permissions, seat layouts, segment inventory, image decoding, mail rendering, SMTP delivery, site content, storage driver, configuration checks, and all migrations/triggers in an in-process PostgreSQL (PGlite). |
| `RUN_DB_TESTS=1 npm run test:integration` | Against `DATABASE_URL`: booking concurrency and lifecycle, segment resale races, tenant isolation, staff permission bounds, no-lockout sign-in, suspension, seat layout versioning, and full CRUD + guarded delete for every module. Uses a disposable database; fixtures remain for debugging. |
| `npm run build && npm run test:api` | Black-box HTTP end-to-end: boots `next start` on port 3100 with a local SMTP sink and disk storage, then exercises health, CSRF, sign-in without lockout, operators/staff, every catalog module including deletes, search, seat holds, idempotent retries, proof upload, verification, tickets, driver manifest and check-in, the emailed tracking code, website content, the expiry job and operator suspension. Set `E2E_BASE_URL` to target a running server instead. |
| `npm run test:e2e` | Playwright at 320/390/430 px and desktop against `E2E_BASE_URL` (default http://localhost:3000): access control, the passenger booking flow, staff sign-in, table deletes, and repeated wrong passwords. Seeds its own data through the API with the seeded admin account (`E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` override). |
| `npm run test:all` | Everything above in order. |

## Production deployment

**Plain Node.js host:** `npm ci`, `npm run build`, `npm run db:migrate`, `npm run db:seed` (first time), then `npm start` for the web process and `npm run worker` under a supervisor that restarts it. Serve HTTPS through a reverse proxy, set `APP_ORIGIN` to the exact public origin, allow 6 MiB request bodies and streaming responses, and set `TRUST_PROXY=true` only when the proxy sets `x-real-ip`.

**Vercel + Supabase:** set Vercel's `DATABASE_URL` to the Supabase Transaction Pooler (port 6543) with `pgbouncer=true`, `connection_limit=1`, and `connect_timeout=5`. From a trusted terminal, temporarily use the Direct connection or Session Pooler (port 5432) as `DATABASE_URL` when running `npx prisma migrate deploy`; never run `prisma migrate reset` against production. For durable uploads, create a private Supabase Storage bucket and set `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3`, `S3_FORCE_PATH_STYLE=true`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Keep the S3 access keys server-only; the application serves authorized images through its API.

Checklist before go-live: the database host is reachable from the app host (`npm run db:check`), `SESSION_SECRET`/`CRON_SECRET` are unique, SMTP (or SMS) is configured so passengers receive tickets and tracking codes, uploads use S3 or a persistent volume, backups and a tested restore exist, and `npm run test:all` is green against a staging database. Monitor `GET /api/health` (200 `{status:"ready",database:"up"}`, 503 when the database is down) and the worker.

When the database is unavailable, pages still render with default website content and data endpoints answer 503 with a retry hint; nothing is ever answered with a bare 500.

## API

See `docs/api-contract.md` for the endpoint contract and `docs/openapi.json` for the schema. All errors are JSON `{error, requestId}`.
#   h i a c e - s e r v i c e  
 
