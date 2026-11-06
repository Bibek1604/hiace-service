-- The product now has two sign-ins, admin and driver. Operator staff accounts are removed for good.
-- The "Operator" table stays as the private internal owner of each driver's vehicles, routes and bookings.
DELETE FROM "Session" WHERE "staffId" IS NOT NULL;
ALTER TABLE "Session" DROP CONSTRAINT "session_single_principal";
ALTER TABLE "Session" DROP COLUMN "staffId";
ALTER TABLE "Session" ADD CONSTRAINT "session_single_principal"
  CHECK ((("adminId" IS NOT NULL)::int + ("driverId" IS NOT NULL)::int) = 1);
DROP TABLE "OperatorStaff";
ALTER TABLE "Operator" DROP COLUMN "ownerOperated";
