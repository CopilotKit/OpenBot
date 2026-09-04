ALTER TABLE "channels" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "channels_awaiting_summary_idx" ON "channels" USING btree ("id") WHERE "channels"."summary" is null and "channels"."deleted_at" is null;