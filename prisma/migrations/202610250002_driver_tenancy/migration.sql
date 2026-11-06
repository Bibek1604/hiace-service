-- Phase 2: drivers belong to one operator; a trip may only be driven by its operator's drivers.
ALTER TABLE "Driver" ADD COLUMN "operatorId" TEXT;
INSERT INTO "Operator" ("id", "name", "slug", "status")
SELECT 'legacy-operator', 'Legacy operator (migrated data)', 'legacy-operator', 'ACTIVE'
WHERE EXISTS (SELECT 1 FROM "Driver")
  AND NOT EXISTS (SELECT 1 FROM "Operator" WHERE "id" = 'legacy-operator');
UPDATE "Driver" SET "operatorId" = 'legacy-operator';
ALTER TABLE "Driver" ALTER COLUMN "operatorId" SET NOT NULL,
  ADD FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT;
CREATE INDEX "Driver_operatorId_idx" ON "Driver"("operatorId");

CREATE FUNCTION enforce_assignment_tenant() RETURNS trigger AS $$
BEGIN
  IF (SELECT "operatorId" FROM "Driver" WHERE id = NEW."driverId")
     IS DISTINCT FROM (SELECT "operatorId" FROM "Trip" WHERE id = NEW."tripId") THEN
    RAISE EXCEPTION 'tenant_mismatch: driver and trip must belong to the same operator';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assignment_tenant BEFORE INSERT OR UPDATE OF "driverId", "tripId" ON "TripDriverAssignment"
  FOR EACH ROW EXECUTE FUNCTION enforce_assignment_tenant();
