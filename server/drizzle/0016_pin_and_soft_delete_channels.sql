ALTER TABLE "channel_memberships" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "deleted_at" timestamp with time zone;