CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"why" text,
	"origin" text NOT NULL,
	"suggestion_id" text,
	"source_app" text,
	"source_link" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_origin_check" CHECK ("tasks"."origin" IN ('asked', 'suggestion'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_suggestion_id_proactive_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."proactive_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_owner_created_idx" ON "tasks" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_channel_idx" ON "tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_suggestion_idx" ON "tasks" USING btree ("suggestion_id");