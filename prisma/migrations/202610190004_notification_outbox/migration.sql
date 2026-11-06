CREATE TYPE "NotificationStatus" AS ENUM ('PENDING','PROCESSING','SENT','CANCELLED');
CREATE TABLE "NotificationOutbox" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL REFERENCES "Booking"("id") ON DELETE RESTRICT,
 "dedupeKey" TEXT NOT NULL UNIQUE,
 "recipient" TEXT NOT NULL,
 "message" TEXT NOT NULL,
 "expectedStatus" "BookingStatus" NOT NULL,
 "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lockedUntil" TIMESTAMP(3),
 "sentAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "NotificationOutbox_status_nextAttemptAt_idx" ON "NotificationOutbox"("status","nextAttemptAt");
