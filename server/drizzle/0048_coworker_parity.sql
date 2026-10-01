CREATE TYPE "public"."responsibility_run_status" AS ENUM('queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."responsibility_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
ALTER TYPE "public"."routine_run_status" ADD VALUE 'waiting';--> statement-breakpoint
CREATE TABLE "responsibilities" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"success_criteria" text NOT NULL,
	"status" "responsibility_status" DEFAULT 'active' NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"last_result" text,
	"subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"responsibility_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" "responsibility_run_status" DEFAULT 'queued' NOT NULL,
	"reply_text" text,
	"error" text,
	"waiting" jsonb,
	"continuation" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_source_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source" text NOT NULL,
	"repository" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_preferences" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"action_digest" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_status_check" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'denied', 'consumed', 'completed')),
	CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_always', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"title" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_id" text,
	"external_id" text,
	"import_digest" text,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demonstrations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb,
	"skill_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delivery_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"transport" text NOT NULL,
	"identity" text NOT NULL,
	"realm" text NOT NULL,
	"address" text NOT NULL,
	"mention_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"transport" text NOT NULL,
	"address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"binding_id" text,
	"source" text NOT NULL,
	"realm" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"binding_id" text,
	"device_id" text,
	"transport" text NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"token" text NOT NULL,
	"project_id" text NOT NULL,
	"platform" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "group_bot_threads" (
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_bot_threads_owner_user_id_channel_id_agent_id_pk" PRIMARY KEY("owner_user_id","channel_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "group_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text,
	"thread_id" text,
	"text" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_messages_status_check" CHECK ("group_messages"."status" IN ('queued', 'running', 'waiting', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "waiting" jsonb;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_events" ADD CONSTRAINT "responsibility_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_event_id_responsibility_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."responsibility_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD CONSTRAINT "approval_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibilities_owner_status_idx" ON "responsibilities" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_events_source_id_idx" ON "responsibility_events" USING btree ("owner_user_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_runs_event_idx" ON "responsibility_runs" USING btree ("responsibility_id","event_id");--> statement-breakpoint
CREATE INDEX "responsibility_runs_status_idx" ON "responsibility_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "responsibility_source_bindings_owner_idx" ON "responsibility_source_bindings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_action_idx" ON "approval_requests" USING btree ("owner_user_id","run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "approval_requests_inbox_idx" ON "approval_requests" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "approval_rules_owner_idx" ON "approval_rules" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "memory_sources_owner_idx" ON "memory_sources" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "memory_sources_due_idx" ON "memory_sources" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "personal_memories_owner_idx" ON "personal_memories" USING btree ("owner_user_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_memories_import_idx" ON "personal_memories" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "demonstrations_owner_idx" ON "demonstrations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demonstrations_active_bot_idx" ON "demonstrations" USING btree ("bot_id") WHERE "demonstrations"."status" = 'recording';--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_binding_identity_idx" ON "delivery_bindings" USING btree ("transport","realm","identity");--> statement-breakpoint
CREATE INDEX "delivery_bindings_owner_idx" ON "delivery_bindings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_inbox_dedupe_idx" ON "delivery_inbox" USING btree ("source","realm","external_id");--> statement-breakpoint
CREATE INDEX "delivery_inbox_owner_idx" ON "delivery_inbox" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_owner_idx" ON "delivery_outbox" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_provider_idx" ON "delivery_outbox" USING btree ("transport","provider_id");--> statement-breakpoint
CREATE INDEX "push_devices_owner_idx" ON "push_devices" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_bot_threads_thread_idx" ON "group_bot_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "group_messages_channel_idx" ON "group_messages" USING btree ("channel_id","created_at","id");