-- Phase 4: trips carry a frozen stop timeline, seats are claimed per journey segment, fares are snapshotted per trip.

-- The ordered stop timeline of a route as jsonb: origin, intermediate stops, destination.
CREATE FUNCTION route_snapshot(rid TEXT) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(jsonb_build_object('locationId', r."originId", 'name', lo."name", 'offsetMinutes', 0,
           'kmFromOrigin', 0, 'allowBoarding', true, 'allowDropoff', false))
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('locationId', rs."locationId", 'name', l."name",
           'offsetMinutes', rs."offsetMinutes", 'kmFromOrigin', rs."kmFromOrigin",
           'allowBoarding', rs."allowBoarding", 'allowDropoff', rs."allowDropoff") ORDER BY rs."position")
         FROM "RouteStop" rs JOIN "Location" l ON l."id" = rs."locationId" WHERE rs."routeId" = r."id"), '[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('locationId', r."destinationId", 'name', ld."name",
           'offsetMinutes', r."durationMinutes", 'kmFromOrigin', r."distanceKm", 'allowBoarding', false, 'allowDropoff', true))
  FROM "Route" r JOIN "Location" lo ON lo."id" = r."originId" JOIN "Location" ld ON ld."id" = r."destinationId"
  WHERE r."id" = rid
$$;

ALTER TABLE "Trip" ADD COLUMN "stopSnapshot" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Trip" ADD COLUMN "segmentCount" INTEGER NOT NULL DEFAULT 1;
UPDATE "Trip" SET "stopSnapshot" = route_snapshot("routeId");
UPDATE "Trip" SET "segmentCount" = jsonb_array_length("stopSnapshot") - 1;
ALTER TABLE "Trip" ADD CONSTRAINT "trip_segments_match" CHECK (jsonb_array_length("stopSnapshot") = "segmentCount" + 1 AND "segmentCount" >= 1);

-- Trips created without an explicit snapshot (older code paths, fixtures) take the route's current timeline.
CREATE FUNCTION trip_snapshot_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."stopSnapshot" = '[]'::jsonb THEN
    NEW."stopSnapshot" := route_snapshot(NEW."routeId");
    NEW."segmentCount" := jsonb_array_length(NEW."stopSnapshot") - 1;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."stopSnapshot" <> OLD."stopSnapshot" OR NEW."segmentCount" <> OLD."segmentCount") THEN
    RAISE EXCEPTION 'trip_timeline_immutable: the stop timeline of a trip is fixed when it is created';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trip_snapshot_default BEFORE INSERT OR UPDATE ON "Trip" FOR EACH ROW EXECUTE FUNCTION trip_snapshot_default();

-- Journeys: [fromIdx, toIdx) over the trip's segments. Legacy bookings span the whole route.
ALTER TABLE "Booking" ADD COLUMN "fromIdx" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "toIdx" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "BookingSeat" ADD COLUMN "fromIdx" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingSeat" ADD COLUMN "toIdx" INTEGER NOT NULL DEFAULT 1;
UPDATE "Booking" b SET "toIdx" = t."segmentCount" FROM "Trip" t WHERE t."id" = b."tripId";
UPDATE "BookingSeat" s SET "toIdx" = b."toIdx" FROM "Booking" b WHERE b."id" = s."bookingId";
ALTER TABLE "Booking" ADD CONSTRAINT "booking_journey_order" CHECK ("fromIdx" >= 0 AND "toIdx" > "fromIdx");
ALTER TABLE "BookingSeat" ADD CONSTRAINT "booking_seat_journey_order" CHECK ("fromIdx" >= 0 AND "toIdx" > "fromIdx");
ALTER TABLE "Booking" ADD COLUMN "boardingPointId" TEXT REFERENCES "BoardingPoint"("id") ON DELETE SET NULL;
ALTER TABLE "Booking" ADD COLUMN "dropPointId" TEXT REFERENCES "BoardingPoint"("id") ON DELETE SET NULL;

CREATE FUNCTION booking_journey_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  SELECT "segmentCount" INTO n FROM "Trip" WHERE "id" = NEW."tripId";
  IF NEW."toIdx" > n THEN RAISE EXCEPTION 'invalid_journey: the journey extends beyond the trip route'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_journey_guard BEFORE INSERT OR UPDATE OF "fromIdx", "toIdx", "tripId" ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION booking_journey_guard();

-- A claimed seat always carries exactly the journey of its booking.
CREATE FUNCTION seat_journey_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b RECORD;
BEGIN
  SELECT "fromIdx", "toIdx" INTO b FROM "Booking" WHERE "id" = NEW."bookingId";
  IF NEW."fromIdx" <> b."fromIdx" OR NEW."toIdx" <> b."toIdx" THEN
    RAISE EXCEPTION 'invalid_journey: seat journey must equal the booking journey';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seat_journey_guard BEFORE INSERT OR UPDATE OF "fromIdx", "toIdx", "bookingId" ON "BookingSeat"
  FOR EACH ROW EXECUTE FUNCTION seat_journey_guard();

-- The heart of segment-aware inventory: two active claims on one seat may never share a segment.
-- The constraint keeps its old name so the earlier "one claim per seat" guarantee is still reported the same way.
DROP INDEX "one_active_claim_per_seat";
ALTER TABLE "BookingSeat" ADD CONSTRAINT "one_active_claim_per_seat"
  EXCLUDE USING gist ("tripSeatId" WITH =, int4range("fromIdx", "toIdx") WITH &&) WHERE ("active");

-- Pricing snapshot per trip: one immutable fare for every legal boarding -> drop-off pair.
CREATE TABLE "TripFare" (
  "tripId" TEXT NOT NULL REFERENCES "Trip"("id") ON DELETE CASCADE,
  "fromIdx" INTEGER NOT NULL,
  "toIdx" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  PRIMARY KEY ("tripId", "fromIdx", "toIdx"),
  CONSTRAINT "trip_fare_order" CHECK ("fromIdx" >= 0 AND "toIdx" > "fromIdx"),
  CONSTRAINT "trip_fare_positive" CHECK ("amount" > 0)
);
CREATE FUNCTION trip_fare_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'trip_fare_immutable: trip fares are a snapshot and cannot be changed'; END IF;
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM "Booking" WHERE "tripId" = OLD."tripId")
     AND EXISTS (SELECT 1 FROM "Trip" WHERE "id" = OLD."tripId") THEN
    RAISE EXCEPTION 'trip_fare_immutable: fares of a trip with bookings cannot be removed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trip_fare_guard BEFORE UPDATE OR DELETE ON "TripFare" FOR EACH ROW EXECUTE FUNCTION trip_fare_guard();

-- Existing trips: distance-proportional fares between every legal pair, the full route at the trip fare.
INSERT INTO "TripFare"("tripId", "fromIdx", "toIdx", "amount")
SELECT t."id", a.i, b.j,
  CASE WHEN a.i = 0 AND b.j = t."segmentCount" THEN t."fare"
       ELSE GREATEST(1, round(t."fare" * (((t."stopSnapshot"->b.j->>'kmFromOrigin')::int - (t."stopSnapshot"->a.i->>'kmFromOrigin')::int)::numeric
            / (t."stopSnapshot"->t."segmentCount"->>'kmFromOrigin')::int)))::int END
FROM "Trip" t
CROSS JOIN LATERAL generate_series(0, t."segmentCount" - 1) AS a(i)
CROSS JOIN LATERAL generate_series(a.i + 1, t."segmentCount") AS b(j)
WHERE (t."stopSnapshot"->a.i->>'allowBoarding')::boolean AND (t."stopSnapshot"->b.j->>'allowDropoff')::boolean;

-- Operator-defined fares for a leg, applied to trips created afterwards.
CREATE TABLE "RouteSegmentFare" (
  "id" TEXT PRIMARY KEY,
  "routeId" TEXT NOT NULL REFERENCES "Route"("id") ON DELETE CASCADE,
  "vehicleType" TEXT NOT NULL,
  "fromLocationId" TEXT NOT NULL REFERENCES "Location"("id") ON DELETE CASCADE,
  "toLocationId" TEXT NOT NULL REFERENCES "Location"("id") ON DELETE CASCADE,
  "amount" INTEGER NOT NULL,
  CONSTRAINT "segment_fare_positive" CHECK ("amount" > 0),
  CONSTRAINT "segment_fare_distinct" CHECK ("fromLocationId" <> "toLocationId")
);
CREATE UNIQUE INDEX "RouteSegmentFare_unique" ON "RouteSegmentFare"("routeId", "vehicleType", "fromLocationId", "toLocationId");
