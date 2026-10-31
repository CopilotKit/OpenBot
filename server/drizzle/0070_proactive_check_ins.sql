CREATE TABLE "proactive_people" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"last_pinged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_pings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"item_count" integer NOT NULL,
	"text" text NOT NULL,
	"push_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offered_at" timestamp with time zone,
	CONSTRAINT "proactive_pings_item_count_check" CHECK ("proactive_pings"."item_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "proactive_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"setting_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"trigger" text NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"skip_reason" text,
	"items_raised" integer DEFAULT 0 NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "proactive_runs_trigger_check" CHECK ("proactive_runs"."trigger" IN ('schedule', 'run_now')),
	CONSTRAINT "proactive_runs_outcome_check" CHECK ("proactive_runs"."outcome" IN ('running', 'quiet', 'raised', 'failed', 'skipped')),
	CONSTRAINT "proactive_runs_skip_reason_check" CHECK (("proactive_runs"."outcome" = 'skipped' AND "proactive_runs"."skip_reason" IS NOT NULL AND "proactive_runs"."skip_reason" IN ('off_admin', 'off_person', 'paused', 'capped', 'unreachable', 'no_sources', 'busy')) OR ("proactive_runs"."outcome" <> 'skipped' AND "proactive_runs"."skip_reason" IS NULL)),
	CONSTRAINT "proactive_runs_finished_check" CHECK (("proactive_runs"."outcome" = 'running') = ("proactive_runs"."finished_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "bot_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"suggestion_id" text,
	"title" text NOT NULL,
	"why" text,
	"source_app" text,
	"source_link" text,
	"origin" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_tasks_origin_check" CHECK ("bot_tasks"."origin" IN ('check_in'))
);
--> statement-breakpoint
ALTER TABLE "proactive_settings" ALTER COLUMN "interval_minutes" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "ping_id" text;--> statement-breakpoint
ALTER TABLE "proactive_people" ADD CONSTRAINT "proactive_people_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_pings" ADD CONSTRAINT "proactive_pings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_runs" ADD CONSTRAINT "proactive_runs_setting_id_proactive_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."proactive_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_runs" ADD CONSTRAINT "proactive_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_runs" ADD CONSTRAINT "proactive_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_suggestion_id_proactive_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."proactive_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proactive_pings_owner_created_idx" ON "proactive_pings" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "proactive_pings_unoffered_idx" ON "proactive_pings" USING btree ("created_at") WHERE "proactive_pings"."offered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "proactive_runs_setting_started_idx" ON "proactive_runs" USING btree ("setting_id","started_at");--> statement-breakpoint
CREATE INDEX "proactive_runs_owner_started_idx" ON "proactive_runs" USING btree ("owner_user_id","started_at");--> statement-breakpoint
CREATE INDEX "proactive_runs_agent_started_idx" ON "proactive_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_runs_one_running_idx" ON "proactive_runs" USING btree ("setting_id") WHERE "proactive_runs"."outcome" = 'running';--> statement-breakpoint
CREATE INDEX "bot_tasks_owner_created_idx" ON "bot_tasks" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_channel_idx" ON "bot_tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_suggestion_idx" ON "bot_tasks" USING btree ("suggestion_id");--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_ping_id_proactive_pings_id_fk" FOREIGN KEY ("ping_id") REFERENCES "public"."proactive_pings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_suggestions_open_dedupe_idx" ON "proactive_suggestions" USING btree ("owner_user_id","agent_id","dedupe_key") WHERE "proactive_suggestions"."status" = 'open' AND "proactive_suggestions"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proactive_suggestions_unpinged_idx" ON "proactive_suggestions" USING btree ("owner_user_id") WHERE "proactive_suggestions"."status" = 'open' AND "proactive_suggestions"."ping_id" IS NULL;