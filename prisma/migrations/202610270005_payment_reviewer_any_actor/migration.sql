-- A payment is reviewed either by the platform admin or by operator staff. The reviewer is recorded by id
-- here and in the immutable audit log, so the column must not be a foreign key into one account table.
-- Before this change every operator-side verification and cash walk-in failed with a foreign-key violation.
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_reviewedById_fkey";
