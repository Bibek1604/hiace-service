-- Owner-drivers: a driver who runs a private one-person operator, and the changes they send for admin approval.
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "Operator" ADD COLUMN "ownerOperated" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "DriverSubmission" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "driverId" TEXT NOT NULL,
 "operatorId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "targetId" TEXT,
 "payload" JSONB NOT NULL,
 "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
 "reviewNote" TEXT NOT NULL DEFAULT '',
 "reviewedById" TEXT,
 "reviewedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DriverSubmission_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DriverSubmission_kind_check" CHECK ("kind" IN ('vehicles', 'routes', 'payment-qr'))
);
CREATE INDEX "DriverSubmission_status_createdAt_idx" ON "DriverSubmission"("status", "createdAt");
CREATE INDEX "DriverSubmission_driverId_idx" ON "DriverSubmission"("driverId");
-- A record can have only one change waiting for review.
CREATE UNIQUE INDEX "DriverSubmission_one_pending_edit" ON "DriverSubmission"("kind", "targetId") WHERE "status" = 'PENDING' AND "targetId" IS NOT NULL;
