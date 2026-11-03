CREATE TABLE "product_telemetry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"properties" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_telemetry_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"context" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	"outcome" text,
	"failure_category" text,
	"result_message_ids" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_telemetry_events_pending_idx" ON "product_telemetry_events" USING btree ("attempted_at","created_at");--> statement-breakpoint
CREATE INDEX "product_telemetry_runs_actor_thread_idx" ON "product_telemetry_runs" USING btree ("actor_user_id","thread_id");--> statement-breakpoint
CREATE INDEX "product_telemetry_runs_accepted_idx" ON "product_telemetry_runs" USING btree ("accepted_at");