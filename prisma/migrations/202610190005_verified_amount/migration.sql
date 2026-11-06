ALTER TABLE "Payment" ADD COLUMN "verifiedAmount" INTEGER;
ALTER TABLE "Payment" ADD CONSTRAINT "verified_payment_has_evidence" CHECK (status <> 'VERIFIED' OR ("verifiedAmount" IS NOT NULL AND "verifiedAmount" > 0 AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL));
