ALTER TABLE "work_items" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "last_error" text;