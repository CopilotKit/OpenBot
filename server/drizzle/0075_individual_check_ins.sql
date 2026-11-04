DROP INDEX "proactive_settings_owner_agent_idx";--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD COLUMN "subject" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD COLUMN "source_link" text;--> statement-breakpoint
CREATE INDEX "proactive_settings_owner_agent_idx" ON "proactive_settings" USING btree ("owner_user_id","agent_id");