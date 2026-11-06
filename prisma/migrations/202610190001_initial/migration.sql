CREATE TYPE "BookingStatus" AS ENUM ('HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PAYMENT_RECONCILIATION_REQUIRED');
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONVERTED');
CREATE TYPE "TripStatus" AS ENUM ('SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TicketStatus" AS ENUM ('EXPECTED', 'CHECKED_IN', 'BOARDED');
CREATE TABLE "AdminUser" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "email" TEXT NOT NULL UNIQUE,
 "name" TEXT NOT NULL,
 "passwordHash" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "Driver" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "email" TEXT NOT NULL UNIQUE,
 "name" TEXT NOT NULL,
 "passwordHash" TEXT NOT NULL,
 "photoKey" TEXT,
 "mobile" TEXT NOT NULL,
 "licenseNumber" TEXT NOT NULL UNIQUE,
 "licenseExpiry" TIMESTAMP(3) NOT NULL,
 "address" TEXT,
 "emergencyContact" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "Session" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "adminId" TEXT,
 "driverId" TEXT,
 "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Vehicle" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "registration" TEXT NOT NULL UNIQUE,
 "name" TEXT NOT NULL,
 "type" TEXT NOT NULL,
 "operator" TEXT NOT NULL,
 "operatorContact" TEXT NOT NULL,
 "description" TEXT NOT NULL DEFAULT '',
 "emergencyContact" TEXT NOT NULL,
 "amenities" TEXT[] NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "maintenanceNote" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "VehicleImage" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "vehicleId" TEXT NOT NULL,
 "key" TEXT NOT NULL,
 "position" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "VehicleSeat" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "vehicleId" TEXT NOT NULL,
 "label" TEXT NOT NULL,
 "row" INTEGER NOT NULL,
 "column" INTEGER NOT NULL
);

CREATE TABLE "Location" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "name" TEXT NOT NULL UNIQUE
);

CREATE TABLE "Route" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "originId" TEXT NOT NULL,
 "destinationId" TEXT NOT NULL,
 "distanceKm" INTEGER NOT NULL,
 "durationMinutes" INTEGER NOT NULL,
 "baseFare" INTEGER NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "RouteStop" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "routeId" TEXT NOT NULL,
 "locationId" TEXT NOT NULL,
 "position" INTEGER NOT NULL
);

CREATE TABLE "RouteFare" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "routeId" TEXT NOT NULL,
 "vehicleType" TEXT NOT NULL,
 "fare" INTEGER NOT NULL
);

CREATE TABLE "Trip" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "vehicleId" TEXT NOT NULL,
 "routeId" TEXT NOT NULL,
 "departure" TIMESTAMP(3) NOT NULL,
 "arrival" TIMESTAMP(3) NOT NULL,
 "boardingPoint" TEXT NOT NULL,
 "dropPoint" TEXT NOT NULL,
 "fare" INTEGER NOT NULL,
 "paymentQRId" TEXT NOT NULL,
 "status" "TripStatus" NOT NULL DEFAULT 'SCHEDULED',
 "bookingOpen" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "TripDriverAssignment" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tripId" TEXT NOT NULL,
 "driverId" TEXT NOT NULL,
 "startsAt" TIMESTAMP(3) NOT NULL,
 "endsAt" TIMESTAMP(3) NOT NULL,
 "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "endedAt" TIMESTAMP(3)
);

CREATE TABLE "TripSeat" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tripId" TEXT NOT NULL,
 "vehicleSeatId" TEXT NOT NULL,
 "blocked" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "GuestCustomer" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "name" TEXT NOT NULL,
 "phone" TEXT NOT NULL
);

CREATE TABLE "Booking" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "reference" TEXT NOT NULL UNIQUE,
 "accessHash" TEXT NOT NULL,
 "idempotencyKey" TEXT NOT NULL UNIQUE,
 "requestHash" TEXT NOT NULL,
 "tripId" TEXT NOT NULL,
 "customerId" TEXT NOT NULL,
 "amount" INTEGER NOT NULL,
 "fareSnapshot" INTEGER NOT NULL,
 "qrSnapshot" JSONB NOT NULL,
 "status" "BookingStatus" NOT NULL DEFAULT 'HELD',
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BookingSeat" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL,
 "tripSeatId" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "Passenger" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "phone" TEXT NOT NULL,
 "seatLabel" TEXT NOT NULL,
 "boardingPoint" TEXT NOT NULL,
 "destination" TEXT NOT NULL
);

CREATE TABLE "PaymentQR" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "label" TEXT NOT NULL,
 "imageKey" TEXT NOT NULL,
 "accountName" TEXT NOT NULL,
 "accountNumber" TEXT,
 "operator" TEXT,
 "instructions" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "Payment" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL UNIQUE,
 "paymentQRId" TEXT NOT NULL,
 "status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
 "claimedAmount" INTEGER,
 "method" TEXT NOT NULL DEFAULT 'QR',
 "transactionRef" TEXT,
 "duplicateReference" BOOLEAN NOT NULL DEFAULT false,
 "reviewedById" TEXT,
 "reviewedAt" TIMESTAMP(3),
 "note" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "PaymentProof" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "paymentId" TEXT NOT NULL,
 "imageKey" TEXT NOT NULL,
 "mime" TEXT NOT NULL,
 "bytes" INTEGER NOT NULL,
 "remarks" TEXT NOT NULL DEFAULT '',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "SeatHold" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bookingId" TEXT NOT NULL UNIQUE,
 "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
 "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "DriverCheckIn" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "passengerId" TEXT NOT NULL UNIQUE,
 "driverId" TEXT NOT NULL,
 "status" "TicketStatus" NOT NULL DEFAULT 'CHECKED_IN',
 "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AuditLog" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "actorId" TEXT NOT NULL,
 "action" TEXT NOT NULL,
 "targetId" TEXT NOT NULL,
 "details" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Settings" (
 "id" TEXT NOT NULL DEFAULT 'global' PRIMARY KEY,
 "holdMinutes" INTEGER NOT NULL DEFAULT 10,
 "reviewMinutes" INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE "RateLimit" (
 "key" TEXT NOT NULL PRIMARY KEY,
 "count" INTEGER NOT NULL DEFAULT 1,
 "resetAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "PhoneChallenge" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "reference" TEXT NOT NULL,
 "phoneHash" TEXT NOT NULL,
 "codeHash" TEXT NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "usedAt" TIMESTAMP(3)
);

CREATE TABLE "StoredObject" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "mime" TEXT NOT NULL,
 "bytes" INTEGER NOT NULL,
 "purpose" TEXT NOT NULL,
 "ownerId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Session" ADD FOREIGN KEY ("adminId") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT;
ALTER TABLE "Session" ADD FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE RESTRICT;
ALTER TABLE "VehicleImage" ADD FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE RESTRICT;
ALTER TABLE "VehicleSeat" ADD FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE RESTRICT;
ALTER TABLE "Route" ADD FOREIGN KEY ("originId") REFERENCES "Location" ("id") ON DELETE RESTRICT;
ALTER TABLE "Route" ADD FOREIGN KEY ("destinationId") REFERENCES "Location" ("id") ON DELETE RESTRICT;
ALTER TABLE "RouteStop" ADD FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE RESTRICT;
ALTER TABLE "RouteStop" ADD FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE RESTRICT;
ALTER TABLE "RouteFare" ADD FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE RESTRICT;
ALTER TABLE "Trip" ADD FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE RESTRICT;
ALTER TABLE "Trip" ADD FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE RESTRICT;
ALTER TABLE "Trip" ADD FOREIGN KEY ("paymentQRId") REFERENCES "PaymentQR" ("id") ON DELETE RESTRICT;
ALTER TABLE "TripDriverAssignment" ADD FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT;
ALTER TABLE "TripDriverAssignment" ADD FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE RESTRICT;
ALTER TABLE "TripSeat" ADD FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT;
ALTER TABLE "TripSeat" ADD FOREIGN KEY ("vehicleSeatId") REFERENCES "VehicleSeat" ("id") ON DELETE RESTRICT;
ALTER TABLE "Booking" ADD FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT;
ALTER TABLE "Booking" ADD FOREIGN KEY ("customerId") REFERENCES "GuestCustomer" ("id") ON DELETE RESTRICT;
ALTER TABLE "BookingSeat" ADD FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT;
ALTER TABLE "BookingSeat" ADD FOREIGN KEY ("tripSeatId") REFERENCES "TripSeat" ("id") ON DELETE RESTRICT;
ALTER TABLE "Passenger" ADD FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT;
ALTER TABLE "Payment" ADD FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT;
ALTER TABLE "Payment" ADD FOREIGN KEY ("paymentQRId") REFERENCES "PaymentQR" ("id") ON DELETE RESTRICT;
ALTER TABLE "Payment" ADD FOREIGN KEY ("reviewedById") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT;
ALTER TABLE "PaymentProof" ADD FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT;
ALTER TABLE "SeatHold" ADD FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT;
ALTER TABLE "DriverCheckIn" ADD FOREIGN KEY ("passengerId") REFERENCES "Passenger" ("id") ON DELETE RESTRICT;
ALTER TABLE "DriverCheckIn" ADD FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE RESTRICT;
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
CREATE UNIQUE INDEX "VehicleSeat_vehicleId_label_idx" ON "VehicleSeat" ("vehicleId","label");
CREATE UNIQUE INDEX "VehicleSeat_vehicleId_row_column_idx" ON "VehicleSeat" ("vehicleId","row","column");
CREATE UNIQUE INDEX "RouteStop_routeId_position_idx" ON "RouteStop" ("routeId","position");
CREATE UNIQUE INDEX "RouteFare_routeId_vehicleType_idx" ON "RouteFare" ("routeId","vehicleType");
CREATE INDEX "Trip_departure_status_idx" ON "Trip" ("departure","status");
CREATE INDEX "TripDriverAssignment_driverId_startsAt_idx" ON "TripDriverAssignment" ("driverId","startsAt");
CREATE UNIQUE INDEX "TripSeat_tripId_vehicleSeatId_idx" ON "TripSeat" ("tripId","vehicleSeatId");
CREATE INDEX "Booking_status_expiresAt_idx" ON "Booking" ("status","expiresAt");
CREATE INDEX "Booking_tripId_createdAt_idx" ON "Booking" ("tripId","createdAt");
CREATE UNIQUE INDEX "BookingSeat_bookingId_tripSeatId_idx" ON "BookingSeat" ("bookingId","tripSeatId");
CREATE INDEX "BookingSeat_tripSeatId_active_idx" ON "BookingSeat" ("tripSeatId","active");
CREATE UNIQUE INDEX "Passenger_bookingId_seatLabel_idx" ON "Passenger" ("bookingId","seatLabel");
CREATE INDEX "Payment_transactionRef_idx" ON "Payment" ("transactionRef");
CREATE INDEX "Payment_status_idx" ON "Payment" ("status");
CREATE INDEX "SeatHold_status_expiresAt_idx" ON "SeatHold" ("status","expiresAt");
CREATE INDEX "AuditLog_targetId_createdAt_idx" ON "AuditLog" ("targetId","createdAt");