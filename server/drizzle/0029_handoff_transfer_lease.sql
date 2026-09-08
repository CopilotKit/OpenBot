ALTER TABLE "handoff_attachments" ADD COLUMN "transfer_lease_id" text;--> statement-breakpoint
ALTER TABLE "handoff_attachments" ADD COLUMN "transfer_lease_expires_at" timestamp with time zone;
