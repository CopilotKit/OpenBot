CREATE TYPE "public"."routine_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'missed');--> statement-breakpoint
CREATE TYPE "public"."routine_trigger" AS ENUM('schedule', 'manual', 'webhook');--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger" "routine_trigger" NOT NULL,
	"status" "routine_run_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" text,
	"error" text,
	"thread_id" text
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"routine_id" uuid,
	"agent_id" text,
	"prompt" text,
	"secret_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"verification_pending" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"sample" jsonb,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"delivery_count" integer DEFAULT 0 NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_triggers_endpoint_id_unique" UNIQUE("endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_runs_routine_started_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_one_active_idx" ON "routine_runs" USING btree ("routine_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "routines_enabled_idx" ON "routines" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "routines_owner_idx" ON "routines" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "webhook_triggers_owner_idx" ON "webhook_triggers" USING btree ("owner_user_id");