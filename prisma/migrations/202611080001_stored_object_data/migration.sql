-- Uploaded images kept in the database when no S3 bucket is configured.
-- Serverless hosts (Vercel) wipe their local disk, which made QR codes and photos disappear.
CREATE TABLE "StoredObjectData" (
  "id" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  CONSTRAINT "StoredObjectData_pkey" PRIMARY KEY ("id")
);
