# Sajilo Yatra

Mobile-first Nepal vehicle booking application using Next.js App Router, TypeScript, PostgreSQL, Prisma 6, Tailwind 4, and locally owned shadcn-style Button/Sheet components built with Radix and class-variance-authority.

## Start locally

Requires Node.js 22+, PostgreSQL 17 (or Docker), and npm registry access.

```powershell
cd E:\Work\booking\sajilo-yatra
npm install
Copy-Item .env.example .env
# Edit .env: set your database URL, actual origin, unique admin credentials and cron secret.
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Next reads `.env` automatically. Prisma CLI also reads `.env`. For the seed command and tests, export variables into the shell or run with Node's env-file support:

```powershell
node --env-file=.env --import tsx prisma/seed.ts
node --env-file=.env --import tsx --test tests/integration.ts
```

Open http://localhost:3000. Staff login is `/staff/login`; use the credentials you supplied. The seed creates sample vehicles, routes, and seven days of trips. It never creates a fake payment QR and never overwrites an existing staff password. Add real QR images under Admin → Payment QR, then provision drivers and assign schedules.

With no `DATABASE_URL`, browsing uses explicitly marked sample rides. The payment and booking APIs return 503 and seat booking is disabled. A configured but unreachable database produces an error, never silently switches to sample inventory.

## What is implemented

- Customer homepage, filtered trip results, vehicle details, gallery, amenities, seat map, guest booking, QR selection/download, screenshot submission, status polling and printable confirmation.
- Admin session authentication, fleet activation, route creation, schedules, fare updates, QR upload/activation, driver provisioning and manual payment decisions.
- Driver manifest limited to assigned trips and confirmed bookings; passenger contact links work on phones.
- Integer NPR fares calculated server-side, Asia/Kathmandu display, 15-minute initial holds, bounded review holds, release on rejection/expiry, immutable confirmed seat claims.
- PostgreSQL unique `(tripId, seat)` primary key, serializable multi-record transactions with retry, and recorded payment decisions.
- Opaque guest and staff tokens stored as SHA-256 hashes, HttpOnly cookies, same-origin write checks, database-backed attempt limits, private receipt delivery, image signature and size validation.
- SQL migration, bootstrap seed, OpenAPI contract, validation tests and PostgreSQL integration test.

## Booking privacy and recovery

Booking URLs alone never grant private access. The browser receives an HttpOnly cookie for its specific booking and a private recovery code to copy. Retrieving on another device requires the booking reference, matching Nepal phone number and recovery code. This checks the entered phone against the booking; **SMS OTP verification is not implemented**. Connect an SMS provider before advertising phone ownership verification. No public customer signup or password recovery exists.

## Payment lifecycle

`HELD → REVIEW → CONFIRMED` or `REJECTED`. Expired HELD/REVIEW bookings become `EXPIRED`. Uploading an image never confirms payment. Review holds expire at departure or 24 hours from upload, whichever comes first. After expiry, approval fails, even if a customer transferred money; the operator must reconcile/refund that payment separately. Confirmed bookings retain their seats regardless of hold timestamp.

Run `POST /api/jobs/expire` every minute with `Authorization: Bearer <CRON_SECRET>`. The job also runs lazily during reservation, booking reads and payment review. Search treats elapsed holds as available, and reservation clears stale claims atomically before claiming them.

## Validation

```powershell
npm run typecheck
npm test
npm run build
# Use a dedicated disposable test database:
node --env-file=.env.test --import tsx --test tests/integration.ts
```

The integration test races two reservations for one seat, asserts only one succeeds, checks that receipt submission does not imply payment, rejects premature/double approval, releases expired and rejected seats, and retains confirmed seats. It creates and removes its own records. Do not point tests at customer data.

**Current verification:** All 33 TypeScript files passed a syntax pass using the globally available TypeScript compiler, and package/TypeScript JSON configs parsed successfully. This is not a full typecheck. Dependency installation failed with `ENOTCACHED`; a subsequent online attempt received `ECONNREFUSED` from the npm registry. Typecheck, build, behavioral tests, migration application and browser rendering have not run. Source and tests are delivered for verification in an environment with package and PostgreSQL access; this is not a verified production deployment. An independently present, incompatible migration referencing another schema is preserved under `docs/unapplied-migrations/` rather than applied to this database.

## Deployment

Deploy on a Node.js host with PostgreSQL connectivity. This source retains the requested Next.js/PostgreSQL architecture instead of converting it to Cloudflare Sites/D1. No hosting account or database has been provisioned.

1. Install and lock dependencies, then run all checks above against staging PostgreSQL. Review the included initial migration before applying it.
2. Set `DATABASE_URL`, `APP_ORIGIN`, and `CRON_SECRET` in the host secret store. The session mechanism uses random opaque tokens rather than JWTs; `SESSION_SECRET` is reserved and currently unused.
3. `npm run db:migrate`, seed only the initial operator account, then `npm run build` and `npm start`.
4. Serve HTTPS and preserve the external Origin. Configure the trusted reverse proxy to overwrite `x-real-ip`; the application falls back to a shared rate-limit bucket when it is absent. Never trust a client-supplied forwarding header.
5. Persist `UPLOAD_DIR` on a private durable volume with backups. This version supports one shared filesystem; use private object storage before deploying across independent application instances. Enforce a 6 MiB total request-body limit at the ingress proxy. Screenshots are size-checked after multipart parsing.
6. Schedule the expiry endpoint and clean old rate-limit/session records periodically. Monitor failed uploads, database errors and payment review time.
7. Upload real operator QR images, confirm payee details, replace sample photography with licensed vehicle/destination photos, and review receipts directly against actual bank/wallet records.

Additional launch work: SMS verification if required, staff credential rotation/revocation UI, refund handling, flexible seat aisle positions beyond the default three-column layout, and full lifecycle editing/cancellation of published schedules. Admin creates unlimited records; overview/search lists currently return at most 200 records. There is no cancellation/refund workflow, automatic bank reconciliation, or customer SMS notification. Guest access lasts 90 days on the booking device. Seed passwords must be changed by an operator using a controlled database/maintenance process.

API contract: [`docs/openapi.yaml`](docs/openapi.yaml). All protected API operations enforce authorization independently of page routing. API behavior should be exercised against the contract before launch.
