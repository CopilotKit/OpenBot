ALTER TABLE "proactive_settings" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ALTER COLUMN "thread_id" DROP NOT NULL;