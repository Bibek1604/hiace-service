CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE UNIQUE INDEX "one_active_claim_per_seat" ON "BookingSeat" ("tripSeatId") WHERE active;
CREATE UNIQUE INDEX "one_current_driver_per_trip" ON "TripDriverAssignment" ("tripId") WHERE "endedAt" IS NULL;
ALTER TABLE "Trip" ADD CONSTRAINT "positive_trip_range" CHECK (arrival > departure AND fare > 0);
ALTER TABLE "Trip" ADD CONSTRAINT "vehicle_schedule_conflict" EXCLUDE USING gist ("vehicleId" WITH =, tsrange(departure, arrival, '[)') WITH &&) WHERE (status <> 'CANCELLED');
ALTER TABLE "TripDriverAssignment" ADD CONSTRAINT "driver_schedule_conflict" EXCLUDE USING gist ("driverId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("endedAt" IS NULL);
ALTER TABLE "TripDriverAssignment" ADD CHECK ("endsAt" > "startsAt");
ALTER TABLE "Session" ADD CHECK (("adminId" IS NULL) <> ("driverId" IS NULL));
ALTER TABLE "Settings" ADD CHECK ("holdMinutes" BETWEEN 1 AND 60 AND "reviewMinutes" BETWEEN 1 AND 120);
ALTER TABLE "Booking" ADD CHECK (amount > 0 AND "fareSnapshot" > 0);
ALTER TABLE "Route" ADD CHECK ("originId" <> "destinationId" AND "baseFare" > 0 AND "durationMinutes" > 0 AND "distanceKm" > 0);
ALTER TABLE "RouteFare" ADD CHECK (fare > 0);
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit history is immutable'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE FUNCTION seat_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b "Booking"; s "TripSeat";
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF EXISTS (SELECT 1 FROM "Booking" WHERE id = OLD."bookingId" AND status = 'CONFIRMED') THEN RAISE EXCEPTION 'Confirmed seats cannot be released'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.active AND (NOT NEW.active OR NEW."bookingId" <> OLD."bookingId" OR NEW."tripSeatId" <> OLD."tripSeatId") THEN
  IF EXISTS (SELECT 1 FROM "Booking" WHERE id = OLD."bookingId" AND status = 'CONFIRMED') THEN RAISE EXCEPTION 'Confirmed seats cannot be released'; END IF;
 END IF;
 SELECT * INTO b FROM "Booking" WHERE id = NEW."bookingId";
 SELECT * INTO s FROM "TripSeat" WHERE id = NEW."tripSeatId";
 IF b."tripId" <> s."tripId" OR (NEW.active AND s.blocked) THEN RAISE EXCEPTION 'Invalid seat ownership'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER seat_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON "BookingSeat" FOR EACH ROW EXECUTE FUNCTION seat_claim_guard();
CREATE FUNCTION inventory_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Trip" t JOIN "VehicleSeat" s ON s."vehicleId" = t."vehicleId" WHERE t.id = NEW."tripId" AND s.id = NEW."vehicleSeatId") THEN RAISE EXCEPTION 'Seat belongs to another vehicle'; END IF;
 IF NEW.blocked AND EXISTS (SELECT 1 FROM "BookingSeat" WHERE "tripSeatId" = NEW.id AND active) THEN RAISE EXCEPTION 'Seat is reserved'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_guard BEFORE INSERT OR UPDATE ON "TripSeat" FOR EACH ROW EXECUTE FUNCTION inventory_guard();
CREATE FUNCTION confirmed_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status = 'CONFIRMED' AND NEW.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'Use a separate audited refund workflow for confirmed bookings'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmed_booking_guard BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION confirmed_booking_guard();
