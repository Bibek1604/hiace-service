CREATE FUNCTION driver_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Trip" WHERE id=NEW."tripId" AND departure=NEW."startsAt" AND arrival=NEW."endsAt") THEN RAISE EXCEPTION 'Driver assignment must match trip times'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_assignment_guard BEFORE INSERT OR UPDATE ON "TripDriverAssignment" FOR EACH ROW EXECUTE FUNCTION driver_assignment_guard();
