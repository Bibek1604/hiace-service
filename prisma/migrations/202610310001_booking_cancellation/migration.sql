-- Audited booking cancellation with a refund workflow kept separate from the cancellation itself.
CREATE TYPE "RefundStatus" AS ENUM ('NOT_REQUIRED', 'REVIEW_REQUIRED', 'PENDING', 'APPROVED', 'COMPLETED', 'DECLINED');
CREATE TABLE "BookingCancellation" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL,
 "operatorId" TEXT NOT NULL,
 "actorId" TEXT NOT NULL,
 "reason" TEXT NOT NULL,
 "previousStatus" "BookingStatus" NOT NULL,
 "paidAmount" INTEGER NOT NULL DEFAULT 0,
 "refundStatus" "RefundStatus" NOT NULL,
 "refundAmount" INTEGER,
 "refundReference" TEXT,
 "refundNote" TEXT NOT NULL DEFAULT '',
 "refundUpdatedById" TEXT,
 "refundUpdatedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BookingCancellation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "refund_within_paid" CHECK ("paidAmount" >= 0 AND ("refundAmount" IS NULL OR ("refundAmount" > 0 AND "refundAmount" <= "paidAmount")))
);
CREATE UNIQUE INDEX "BookingCancellation_bookingId_key" ON "BookingCancellation"("bookingId");
CREATE INDEX "BookingCancellation_operatorId_refundStatus_idx" ON "BookingCancellation"("operatorId", "refundStatus");

-- A confirmed booking may now leave CONFIRMED only to become CANCELLED, and only with a cancellation record.
CREATE OR REPLACE FUNCTION confirmed_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status = 'CONFIRMED' AND NEW.status <> 'CONFIRMED' AND NOT (
   NEW.status = 'CANCELLED' AND EXISTS (SELECT 1 FROM "BookingCancellation" WHERE "bookingId" = NEW.id)
 ) THEN RAISE EXCEPTION 'Use a separate audited refund workflow for confirmed bookings'; END IF;
 RETURN NEW;
END $$;
