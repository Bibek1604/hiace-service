-- Phase 3: versioned seat layouts, seat metadata, timed route stops and boarding / drop-off points.
CREATE TYPE "LayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "PointKind" AS ENUM ('BOARDING', 'DROPOFF');

CREATE TABLE "SeatLayout" (
  "id" TEXT PRIMARY KEY,
  "operatorId" TEXT NOT NULL REFERENCES "Operator"("id") ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "vehicleType" TEXT NOT NULL,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seat_layout_name_len" CHECK (char_length("name") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "SeatLayout_operator_name" ON "SeatLayout"("operatorId", lower("name"));

CREATE TABLE "SeatLayoutVersion" (
  "id" TEXT PRIMARY KEY,
  "layoutId" TEXT NOT NULL REFERENCES "SeatLayout"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL,
  "status" "LayoutStatus" NOT NULL DEFAULT 'DRAFT',
  "rows" INTEGER NOT NULL,
  "cols" INTEGER NOT NULL,
  "decks" INTEGER NOT NULL DEFAULT 1,
  "cells" JSONB NOT NULL,
  "seatCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "layout_version_positive" CHECK ("version" > 0),
  CONSTRAINT "layout_grid_bounds" CHECK ("rows" BETWEEN 1 AND 20 AND "cols" BETWEEN 1 AND 8 AND "decks" BETWEEN 1 AND 2),
  CONSTRAINT "layout_seat_count" CHECK ("seatCount" BETWEEN 0 AND 60),
  CONSTRAINT "layout_published_has_seats" CHECK ("status" = 'DRAFT' OR ("seatCount" > 0 AND "publishedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "SeatLayoutVersion_layout_version" ON "SeatLayoutVersion"("layoutId", "version");
-- At most one editable draft per layout.
CREATE UNIQUE INDEX "SeatLayoutVersion_one_draft" ON "SeatLayoutVersion"("layoutId") WHERE "status" = 'DRAFT';

-- A published version is history: its grid can never change, and it can only move on to ARCHIVED.
CREATE FUNCTION protect_published_layout() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'layout_immutable: published layout versions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."rows" <> OLD."rows" OR NEW."cols" <> OLD."cols" OR NEW."decks" <> OLD."decks"
       OR NEW."cells" <> OLD."cells" OR NEW."seatCount" <> OLD."seatCount" OR NEW."version" <> OLD."version"
       OR NEW."layoutId" <> OLD."layoutId" THEN
      RAISE EXCEPTION 'layout_immutable: published layout versions cannot be edited; create a new version';
    END IF;
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'layout_immutable: a published version cannot return to draft';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER layout_version_protect BEFORE UPDATE OR DELETE ON "SeatLayoutVersion"
  FOR EACH ROW EXECUTE FUNCTION protect_published_layout();

ALTER TABLE "VehicleSeat" ADD COLUMN "deck" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VehicleSeat" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "VehicleSeat" ADD CONSTRAINT "vehicle_seat_category" CHECK (
  "category" IN ('STANDARD','WINDOW','FRONT','SLEEPER','ACCESSIBLE','PREMIUM'));
ALTER TABLE "Vehicle" ADD COLUMN "layoutVersionId" TEXT REFERENCES "SeatLayoutVersion"("id") ON DELETE RESTRICT;
CREATE INDEX "Vehicle_layoutVersionId_idx" ON "Vehicle"("layoutVersionId");

-- A vehicle may only use a published layout of its own operator, and cannot switch layout afterwards:
-- existing TripSeat rows point at VehicleSeat rows generated from the original grid.
CREATE FUNCTION enforce_vehicle_layout() RETURNS trigger AS $$
DECLARE v RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."layoutVersionId" IS NOT NULL
     AND NEW."layoutVersionId" IS DISTINCT FROM OLD."layoutVersionId" THEN
    RAISE EXCEPTION 'layout_immutable: a vehicle keeps the layout version it was registered with';
  END IF;
  IF NEW."layoutVersionId" IS NOT NULL THEN
    SELECT lv."status", l."operatorId" INTO v FROM "SeatLayoutVersion" lv
      JOIN "SeatLayout" l ON l."id" = lv."layoutId" WHERE lv."id" = NEW."layoutVersionId";
    IF v."operatorId" IS DISTINCT FROM NEW."operatorId" THEN
      RAISE EXCEPTION 'tenant_mismatch: vehicle layout must belong to the vehicle operator';
    END IF;
    IF v."status" <> 'PUBLISHED' AND (TG_OP = 'INSERT' OR NEW."layoutVersionId" IS DISTINCT FROM OLD."layoutVersionId") THEN
      RAISE EXCEPTION 'layout_not_published: only a published layout version can be assigned to a vehicle';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER vehicle_layout BEFORE INSERT OR UPDATE OF "layoutVersionId" ON "Vehicle"
  FOR EACH ROW EXECUTE FUNCTION enforce_vehicle_layout();

-- Timed route stops. Existing rows get evenly spread estimates so legacy routes stay valid.
ALTER TABLE "RouteStop" ADD COLUMN "offsetMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RouteStop" ADD COLUMN "kmFromOrigin" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RouteStop" ADD COLUMN "allowBoarding" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RouteStop" ADD COLUMN "allowDropoff" BOOLEAN NOT NULL DEFAULT true;
UPDATE "RouteStop" rs SET
  "offsetMinutes" = GREATEST(1, (r."durationMinutes" * (rs."position" + 1)) / (c.n + 1)),
  "kmFromOrigin" = GREATEST(1, (r."distanceKm" * (rs."position" + 1)) / (c.n + 1))
FROM "Route" r, (SELECT "routeId", count(*) AS n FROM "RouteStop" GROUP BY "routeId") c
WHERE r."id" = rs."routeId" AND c."routeId" = rs."routeId";

CREATE TABLE "BoardingPoint" (
  "id" TEXT PRIMARY KEY,
  "routeId" TEXT NOT NULL REFERENCES "Route"("id") ON DELETE CASCADE,
  "locationId" TEXT NOT NULL REFERENCES "Location"("id") ON DELETE RESTRICT,
  "kind" "PointKind" NOT NULL,
  "name" TEXT NOT NULL,
  "landmark" TEXT NOT NULL DEFAULT '',
  "extraMinutes" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "boarding_point_name_len" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "boarding_point_extra" CHECK ("extraMinutes" BETWEEN -60 AND 120)
);
CREATE UNIQUE INDEX "BoardingPoint_unique" ON "BoardingPoint"("routeId", "locationId", "kind", lower("name"));
CREATE INDEX "BoardingPoint_route_idx" ON "BoardingPoint"("routeId", "kind");

-- Points must sit on a place of their route that allows that movement (origin cannot be a drop-off,
-- destination cannot be a boarding point, intermediate stops follow their flags).
CREATE FUNCTION enforce_boarding_point() RETURNS trigger AS $$
DECLARE r RECORD; s RECORD;
BEGIN
  SELECT "originId", "destinationId" INTO r FROM "Route" WHERE "id" = NEW."routeId";
  IF NEW."locationId" = r."originId" THEN
    IF NEW."kind" = 'DROPOFF' THEN RAISE EXCEPTION 'invalid_point: the origin cannot be a drop-off point'; END IF;
  ELSIF NEW."locationId" = r."destinationId" THEN
    IF NEW."kind" = 'BOARDING' THEN RAISE EXCEPTION 'invalid_point: the destination cannot be a boarding point'; END IF;
  ELSE
    SELECT "allowBoarding", "allowDropoff" INTO s FROM "RouteStop"
      WHERE "routeId" = NEW."routeId" AND "locationId" = NEW."locationId";
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_point: the location is not on this route'; END IF;
    IF (NEW."kind" = 'BOARDING' AND NOT s."allowBoarding") OR (NEW."kind" = 'DROPOFF' AND NOT s."allowDropoff") THEN
      RAISE EXCEPTION 'invalid_point: this stop does not allow that movement';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER boarding_point_check BEFORE INSERT OR UPDATE ON "BoardingPoint"
  FOR EACH ROW EXECUTE FUNCTION enforce_boarding_point();
