CREATE TYPE "TripScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'CANCELLED', 'COMPLETED');

CREATE TABLE "TripSchedule" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "routeId" TEXT NOT NULL,
  "paymentQRId" TEXT NOT NULL,
  "fare" INTEGER NOT NULL,
  "departureMinutes" INTEGER NOT NULL,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE NOT NULL,
  "boardingPoint" TEXT NOT NULL,
  "dropPoint" TEXT NOT NULL,
  "status" "TripScheduleStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TripSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TripSchedule_dates" CHECK ("endsOn" >= "startsOn"),
  CONSTRAINT "TripSchedule_departure_minutes" CHECK ("departureMinutes" >= 0 AND "departureMinutes" < 1440),
  CONSTRAINT "TripSchedule_fare" CHECK ("fare" > 0)
);

ALTER TABLE "Trip" ADD COLUMN "scheduleId" TEXT;
CREATE UNIQUE INDEX "Trip_scheduleId_departure_key" ON "Trip"("scheduleId", "departure");
CREATE INDEX "Trip_scheduleId_departure_idx" ON "Trip"("scheduleId", "departure");
CREATE INDEX "TripSchedule_driverId_status_startsOn_idx" ON "TripSchedule"("driverId", "status", "startsOn");
CREATE INDEX "TripSchedule_operatorId_status_startsOn_idx" ON "TripSchedule"("operatorId", "status", "startsOn");
CREATE INDEX "TripSchedule_batchId_idx" ON "TripSchedule"("batchId");

ALTER TABLE "Trip" ADD CONSTRAINT "Trip_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TripSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TripSchedule" ADD CONSTRAINT "TripSchedule_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripSchedule" ADD CONSTRAINT "TripSchedule_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripSchedule" ADD CONSTRAINT "TripSchedule_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripSchedule" ADD CONSTRAINT "TripSchedule_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripSchedule" ADD CONSTRAINT "TripSchedule_paymentQRId_fkey" FOREIGN KEY ("paymentQRId") REFERENCES "PaymentQR"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
