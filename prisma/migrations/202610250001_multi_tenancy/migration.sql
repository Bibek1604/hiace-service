-- Phase 1: operator tenancy, operator staff and login throttling.
CREATE TYPE "OperatorStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

CREATE TABLE "Operator" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "contactName" TEXT NOT NULL DEFAULT '',
  "contactPhone" TEXT NOT NULL DEFAULT '',
  "contactEmail" TEXT,
  "status" "OperatorStatus" NOT NULL DEFAULT 'PENDING',
  "commissionBps" INTEGER NOT NULL DEFAULT 0,
  "suspendedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "operator_commission_range" CHECK ("commissionBps" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "Operator_slug_key" ON "Operator"("slug");
CREATE INDEX "Operator_status_idx" ON "Operator"("status");

CREATE TABLE "OperatorSettings" (
  "operatorId" TEXT PRIMARY KEY REFERENCES "Operator"("id") ON DELETE CASCADE,
  "holdMinutes" INTEGER,
  "reviewMinutes" INTEGER,
  "allowSegmentResale" BOOLEAN NOT NULL DEFAULT true,
  "cancellationPolicy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "operator_settings_minutes" CHECK (
    ("holdMinutes" IS NULL OR "holdMinutes" BETWEEN 1 AND 120)
    AND ("reviewMinutes" IS NULL OR "reviewMinutes" BETWEEN 1 AND 1440))
);

-- permissions are validated against the server-side catalog in src/lib/permissions.ts
CREATE TABLE "OperatorStaff" (
  "id" TEXT PRIMARY KEY,
  "operatorId" TEXT NOT NULL REFERENCES "Operator"("id") ON DELETE RESTRICT,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "isOwner" BOOLEAN NOT NULL DEFAULT false,
  "permissions" TEXT[] NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "failedLogins" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OperatorStaff_email_key" ON "OperatorStaff"(lower("email"));
CREATE INDEX "OperatorStaff_operatorId_idx" ON "OperatorStaff"("operatorId");
CREATE UNIQUE INDEX "OperatorStaff_one_owner" ON "OperatorStaff"("operatorId") WHERE "isOwner";

ALTER TABLE "AdminUser" ADD COLUMN "failedLogins" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "staffId" TEXT REFERENCES "OperatorStaff"("id") ON DELETE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "session_single_principal"
  CHECK ((("adminId" IS NOT NULL)::int + ("driverId" IS NOT NULL)::int + ("staffId" IS NOT NULL)::int) = 1);
ALTER TABLE "AuditLog" ADD COLUMN "operatorId" TEXT;
CREATE INDEX "AuditLog_operatorId_createdAt_idx" ON "AuditLog"("operatorId", "createdAt");

-- tenant ownership
ALTER TABLE "Vehicle" ADD COLUMN "operatorId" TEXT;
ALTER TABLE "Route" ADD COLUMN "operatorId" TEXT;
ALTER TABLE "PaymentQR" ADD COLUMN "operatorId" TEXT;
ALTER TABLE "Trip" ADD COLUMN "operatorId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "operatorId" TEXT;

-- Existing single-tenant data is attached to one clearly named operator. Nothing is created on an empty database.
INSERT INTO "Operator" ("id", "name", "slug", "status")
SELECT 'legacy-operator', 'Legacy operator (migrated data)', 'legacy-operator', 'ACTIVE'
WHERE EXISTS (SELECT 1 FROM "Vehicle") OR EXISTS (SELECT 1 FROM "Route") OR EXISTS (SELECT 1 FROM "PaymentQR")
   OR EXISTS (SELECT 1 FROM "Trip") OR EXISTS (SELECT 1 FROM "Booking");
UPDATE "Vehicle" SET "operatorId" = 'legacy-operator';
UPDATE "Route" SET "operatorId" = 'legacy-operator';
UPDATE "PaymentQR" SET "operatorId" = 'legacy-operator';
UPDATE "Trip" SET "operatorId" = 'legacy-operator';
UPDATE "Booking" SET "operatorId" = 'legacy-operator';

ALTER TABLE "Vehicle" ALTER COLUMN "operatorId" SET NOT NULL, ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
ALTER TABLE "Route" ALTER COLUMN "operatorId" SET NOT NULL, ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
ALTER TABLE "PaymentQR" ALTER COLUMN "operatorId" SET NOT NULL, ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
ALTER TABLE "Trip" ALTER COLUMN "operatorId" SET NOT NULL, ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
ALTER TABLE "Booking" ALTER COLUMN "operatorId" SET NOT NULL, ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
CREATE INDEX "Vehicle_operatorId_idx" ON "Vehicle"("operatorId");
CREATE INDEX "Route_operatorId_idx" ON "Route"("operatorId");
CREATE INDEX "PaymentQR_operatorId_idx" ON "PaymentQR"("operatorId");
CREATE INDEX "Trip_operatorId_departure_idx" ON "Trip"("operatorId", "departure");
CREATE INDEX "Booking_operatorId_createdAt_idx" ON "Booking"("operatorId", "createdAt");

-- A trip, its vehicle, route and payment QR must all belong to one operator; a booking inherits its trip's operator.
CREATE FUNCTION enforce_trip_tenant() RETURNS trigger AS $$
BEGIN
  IF (SELECT "operatorId" FROM "Vehicle" WHERE id = NEW."vehicleId") IS DISTINCT FROM NEW."operatorId"
     OR (SELECT "operatorId" FROM "Route" WHERE id = NEW."routeId") IS DISTINCT FROM NEW."operatorId"
     OR (SELECT "operatorId" FROM "PaymentQR" WHERE id = NEW."paymentQRId") IS DISTINCT FROM NEW."operatorId" THEN
    RAISE EXCEPTION 'tenant_mismatch: trip vehicle, route and payment QR must belong to the trip operator';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trip_tenant BEFORE INSERT OR UPDATE ON "Trip" FOR EACH ROW EXECUTE FUNCTION enforce_trip_tenant();

CREATE FUNCTION enforce_booking_tenant() RETURNS trigger AS $$
BEGIN
  IF (SELECT "operatorId" FROM "Trip" WHERE id = NEW."tripId") IS DISTINCT FROM NEW."operatorId" THEN
    RAISE EXCEPTION 'tenant_mismatch: booking operator must equal its trip operator';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER booking_tenant BEFORE INSERT OR UPDATE OF "operatorId", "tripId" ON "Booking" FOR EACH ROW EXECUTE FUNCTION enforce_booking_tenant();
