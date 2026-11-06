ALTER TABLE "GuestCustomer" ADD COLUMN "email" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'SMS';
ALTER TABLE "NotificationOutbox" ADD COLUMN "subject" TEXT;
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_channel_check" CHECK ("channel" IN ('SMS','EMAIL'));
