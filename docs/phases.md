# Build log against the master specification

Approach: evolve the existing single-tenant app (holds, payment review, uploads, outbox, idempotency and
PostgreSQL constraints are kept) rather than rewrite. Each phase is an additive migration.

## Phase 1 â€“ tenancy and auth foundation (done, verified in-process)

Added
- Migration `202610250001_multi_tenancy`: `Operator`, `OperatorSettings`, `OperatorStaff`; `operatorId` on
  Vehicle, Route, PaymentQR, Trip, Booking and AuditLog; legacy data is attached to one `legacy-operator` only
  when rows already exist (nothing is created on an empty database).
- DB triggers `tenant_mismatch`: a trip's vehicle, route and payment QR must share its operator; a booking must
  share its trip's operator.
- `src/lib/permissions.ts`: server-side permission catalog, six staff role presets, `can`, `canGrant`
  (no privilege escalation; `staff.manage` is owner-only), `scopeOperatorId` (forged operator ids rejected).
- `src/lib/password.ts`: Argon2id (`@node-rs/argon2`); legacy bcrypt hashes still verify and are re-hashed on login.
- `src/lib/auth.ts`: login for ADMIN, DRIVER and OPERATOR with per-account lockout and exponential back-off,
  uniform error messages, timing equalisation for unknown accounts, suspended operators cannot sign in.
- `staff()` returns operator/permission context; suspending an operator invalidates its sessions at once.
- `admin.ts` CRUD is tenant-scoped: create needs an explicit operator, updates and lists are filtered by scope,
  other tenants' ids return 404.

Verification run in this workspace: `tsc --noEmit` 0 errors, `eslint .` 0 problems, `npm test` 14/14
(includes PostgreSQL-WASM tenant trigger checks and Argon2id/permission unit tests).

Deviations from the spec
- Roles/permissions are a code-level catalog plus `OperatorStaff.permissions text[]` instead of Role,
  Permission, UserRole and RolePermission tables. Unknown permission strings are rejected.
- Redis/BullMQ not yet introduced (Phase 10). Existing Postgres-backed worker remains.

Not yet verified (needs the database that will be provided)
- `prisma migrate deploy` against native PostgreSQL, and `RUN_DB_TESTS=1 npm run test:integration`.

## Phase 2 – operator management and operator-scoped API (done, verified in-process)

Added
- Migration `202610250002_driver_tenancy`: drivers belong to an operator; a DB trigger rejects assigning a driver
  to another operator's trip.
- `src/lib/operators.ts`: create operator + owner in one transaction, approve / suspend / reinstate with explicit
  transitions (suspend needs a reason, ends staff sessions, closes sales on scheduled trips), owner password
  reset, staff create/update with escalation limits. Every action writes an audit row carrying `operatorId`.
- API: `/api/super-admin/operators` (list, create, patch, staff list, reset-owner-password);
  `/api/operator/*` reuses the admin handlers behind a tenant scope and `requiredPermissions()` (default-deny,
  GET/POST/PATCH only); `/api/operator/staff` for sub-admins.
- Ownership checks on every ID-addressed route (trip seats, payment review, reconciliation, manual bookings,
  vehicle profile, audit, reports, payment-proof images). Foreign ids answer 404.
- UI: operator sign-in role, `/admin/operators`, `/operator/*` workspace (navigation follows permissions),
  staff and permission manager, operator picker when the platform admin creates tenant records.

Verification run in this workspace: `tsc` 0 errors, `eslint` 0 problems, `npm test` 19/19, `next build` succeeds.
Found and fixed by tests: DELETE and other verbs were being mapped to write permissions.

Decisions to confirm
- Locations stay platform-managed (operators can read them, not create). Say if operators should add stops.
- Drivers are now per operator.

Not yet verified (waiting for the database)
- Both new migrations against native PostgreSQL, and `RUN_DB_TESTS=1 npm run test:integration`
  (`tests/tenancy.ts` covers isolation, forged ids, staff escalation, lockout, suspension and audit rows).
- Browser rendering of the new screens at mobile widths; they use the existing responsive table and sheet styles.

## Phase 3 - seat layouts and timed routes (done, verified in-process)

Added
- Migration `202610250003_layouts_route_points`: `SeatLayout` / `SeatLayoutVersion` (draft -> published -> archived, one
  draft per layout, published grids immutable by trigger), `VehicleSeat.deck/category`, `Vehicle.layoutVersionId`
  (same operator, published only, fixed after registration), timed `RouteStop` (minutes, km, board/drop flags;
  legacy rows are spread evenly), `BoardingPoint` with a trigger that keeps points on valid stops.
- `src/lib/seat-layout.ts`: pure grid validation (bounds, overlaps, labels, one driver, door, seat cap), compile to seats
  (upper deck rows offset so positions stay unique), auto-label, diff, four templates.
- `src/lib/route-stops.ts`: ordered stop sequence rules, journey -> segment resolution and overlap test (the base for
  Phase 4 inventory), point validation.
- `src/lib/layouts.ts`, `src/lib/route-points.ts` and API `seat-layouts` / `route-points` (tenant-scoped, permissioned,
  audited). Vehicles are created from a published layout; legacy plain seat labels still work.
- UI: `/admin|operator/seat-layouts` grid editor (tap or drag, decks, categories, live checks, save draft, publish),
  `/admin|operator/routes/:id` stop timing and point manager, layout picker on the vehicle form.

Verification run in this workspace: `tsc` 0 errors, `eslint` 0 problems, `npm test` 30/30 (includes PGlite checks of the
new triggers), `next build` succeeds.

Not yet verified (waiting for the database)
- Migration 3 on native PostgreSQL; the new layout case in `tests/tenancy.ts` (gated by RUN_DB_TESTS).
- The editor in a real browser on phone widths (tap/drag painting is untested on touch hardware).

Deviations
- Seat categories are a CHECK-constrained text column, not a separate table.
- Customers do not yet see boarding points or choose a segment; that arrives with Phase 4/5.

## Phase 4 - segment-aware trips, fare matrix and inventory (done, verified in-process)

Added
- Migration `202610250004_segment_inventory`: `Trip.stopSnapshot/segmentCount` (the route timeline frozen at creation,
  immutable; a trigger fills it for trips created without one); `Booking` and `BookingSeat` carry `fromIdx/toIdx`
  (a trigger keeps seat journey = booking journey and inside the trip); the old one-claim-per-seat unique index is
  replaced by an EXCLUDE constraint (same name) on `(tripSeatId, int4range(fromIdx,toIdx))` for active claims, so
  overlapping legs can never be double-booked even if application code is wrong; `TripFare` (immutable per-trip price
  of every legal boarding -> drop-off pair); `RouteSegmentFare` (operator overrides used when a trip is created);
  optional boarding/drop-off point on bookings. Existing data is backfilled as whole-route journeys with distance-based fares.
- `src/lib/inventory.ts` (pure): fare matrix, price lookup, per-journey seat state, stop times, search matching.
- Booking flow: `reserve()` takes optional from/to stops and boarding/drop-off points, prices from the trip snapshot, refuses
  a stop the vehicle has already left, and relies on the exclusion constraint for concurrency (mapped to a clean 409).
  Payment verification only treats overlapping claims as conflicts.
- API: trip detail takes `?from=&to=` and returns the stop timeline, fare for that leg, points and seat states for that leg;
  search matches places in travel order anywhere on a trip (Kathmandu -> Pokhara finds a Kathmandu -> Pokhara via Mugling trip
  when searching Mugling -> Pokhara) and returns the leg fare, boarding/drop times and free seats for that leg;
  `segment-fares` API and a fare table on the route page.

Verification run in this workspace: `tsc` 0 errors, `eslint` 0 problems, `npm test` 38/38 (the exclusion constraint,
snapshot trigger and fare immutability are exercised on PostgreSQL-WASM), `next build` succeeds.

Not yet verified (waiting for the database)
- Migration 4 on native PostgreSQL; `tests/segments.ts` (concurrent overlapping-leg bookings through real transactions).
- Prisma's mapping of an exclusion violation: the code matches the constraint name in the error message as well as P2002.

Deviations / limits
- Amounts stay whole NPR integers (not paisa); changing that touches every existing amount.
- Search pagination is applied before the in-memory journey match, so a page can hold fewer than 25 results.
- Changing a trip's fare rebuilds distance-based fares (overrides apply at creation only) and is refused once bookings exist.
- The customer screens still book the whole route; choosing a leg and boarding point is Phase 5.

## Next: Phase 5 - public search and booking UI (journey legs, boarding points, mobile seat map).

## Phase 5 - production hardening and end-to-end verification (2026-10-27)

Root cause of the 500/503 storm in development: the configured database host could not be reached at all
(TCP connect timed out), so every Prisma call failed after its 5 second connect timeout. The code was not
at fault; the fix is a reachable DATABASE_URL (see README, "Quick start" and `npm run db:check`).

Fixed
- Operator staff could never verify a payment or record a cash walk-in: `Payment.reviewedById` was a foreign
  key to `AdminUser`, so an operator id failed with a FK violation (migration `202610270005`).
- Operator audit history was empty for payment events: proof, clarification, verification, rejection, hold
  expiry and driver check-in rows now carry the booking's `operatorId`.
- Phone header overflow pushed the fixed "Continue" bar partly off-screen on 320-430 px; the header no longer
  exceeds the screen and the booking flow is verified by Playwright at every width.
- The sign-in form lost the email after a wrong password (React 19 form reset); the field is now controlled.
- Uploads required S3; without a bucket nothing could be created. Files fall back to `STORAGE_DIR` on disk.
- Booking-tracking codes needed SMTP or SMS even in development; they are printed to the console instead.
- Health endpoint reports `{status, database}` and 503 when the database is down; startup validates the
  configuration (`src/instrumentation.ts`) and refuses to start production with placeholder secrets.
- `.env` still carried the placeholder SESSION_SECRET and CRON_SECRET; both were replaced with random values.

Policy changes (requested)
- No account lockout after failed sign-ins; failed attempts are only counted.
- Request throttling is off unless `RATE_LIMITS=on`.

Added
- DELETE for every module with guards that protect history (see README "CRUD and deletion rules"), with UI
  buttons, operator permissions (`d` entries) and audit rows.
- Tests: configuration and storage units, `tests/crud.ts` (DB CRUD + guarded delete), `tests/api.e2e.ts`
  (black-box HTTP suite with an SMTP sink), Playwright booking flow, delete-from-table, no-lockout and
  console-error specs at four widths; mobile projects run in Chromium.
- `npm run db:check`, `npm run db:local`, Docker multi-stage image with migrations on boot, compose web+worker.

Verified in this workspace: `npm run check`, `npm test` (50), `RUN_DB_TESTS=1 npm run test:integration` (5),
`npm run build`, `npm run test:api` (10), `npm run test:e2e` (48 passed, 4 skipped without driver fixtures).
