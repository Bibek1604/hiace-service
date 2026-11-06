-- Indexes for the hottest read paths (additive and idempotent; no data is changed).
CREATE INDEX IF NOT EXISTS "Booking_operatorId_createdAt_idx" ON "Booking"("operatorId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Booking_customerId_idx" ON "Booking"("customerId");
CREATE INDEX IF NOT EXISTS "Trip_operatorId_departure_idx" ON "Trip"("operatorId", "departure");
CREATE INDEX IF NOT EXISTS "RouteStop_locationId_idx" ON "RouteStop"("locationId");
CREATE INDEX IF NOT EXISTS "Route_originId_destinationId_idx" ON "Route"("originId", "destinationId");
