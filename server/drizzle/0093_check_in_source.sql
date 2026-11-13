ALTER TABLE "proactive_settings" ADD COLUMN "source_kind" text DEFAULT 'apps' NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD COLUMN "source_server_id" text;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_source_kind_check" CHECK ("proactive_settings"."source_kind" IN ('apps', 'app', 'page'));