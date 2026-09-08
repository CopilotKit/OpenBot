ALTER TABLE "handoff_attachments" ADD COLUMN "transfer_lease_id" text;--> statement-breakpoint
ALTER TABLE "handoff_attachments" ADD COLUMN "transfer_lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "handoff_attachments"
SET "external_transfer_id" = NULL, "updated_at" = now()
WHERE "state" = 'copied' AND "external_transfer_id" IS NOT NULL;
