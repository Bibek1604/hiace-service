-- Driver-controlled operations. Existing records remain valid and existing QR/payment snapshots stay immutable.
CREATE TYPE "DriverStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'SUSPENDED');
ALTER TABLE "Driver" ADD COLUMN "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Driver" ADD COLUMN "suspendedReason" TEXT;
UPDATE "Driver" SET "status" = 'DEACTIVATED' WHERE NOT "active";

ALTER TABLE "PaymentQR" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "PaymentQR_operatorId_isDefault_idx" ON "PaymentQR"("operatorId", "isDefault");
CREATE UNIQUE INDEX "one_default_payment_qr_per_operator" ON "PaymentQR"("operatorId") WHERE "isDefault" AND "active";

ALTER TABLE "Trip" ADD COLUMN "bookingOpensAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "bookingClosesAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "recurringRule" TEXT;
ALTER TABLE "Trip" ADD CONSTRAINT "trip_booking_window_order"
  CHECK ("bookingOpensAt" IS NULL OR "bookingClosesAt" IS NULL OR "bookingOpensAt" < "bookingClosesAt");
CREATE INDEX "Trip_operatorId_bookingOpensAt_bookingClosesAt_idx"
  ON "Trip"("operatorId", "bookingOpensAt", "bookingClosesAt");
