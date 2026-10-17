CREATE TABLE "demonstration_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"demonstration_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"chunk_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "demonstration_media_kind_check" CHECK ("demonstration_media"."kind" IN ('screen', 'audio', 'network'))
);
--> statement-breakpoint
CREATE TABLE "demonstration_media_chunks" (
	"media_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demonstration_media_chunks_media_id_index_pk" PRIMARY KEY("media_id","index")
);
--> statement-breakpoint
CREATE TABLE "demonstration_steps" (
	"demonstration_id" text NOT NULL,
	"index" integer NOT NULL,
	"action" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demonstration_steps_demonstration_id_index_pk" PRIMARY KEY("demonstration_id","index")
);
--> statement-breakpoint
CREATE TABLE "demonstration_trajectories" (
	"trajectory_id" uuid PRIMARY KEY NOT NULL,
	"demonstration_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"learning_container_id" text,
	"learning_state" text,
	CONSTRAINT "demonstration_trajectories_learning_state_check" CHECK ("demonstration_trajectories"."learning_state" IS NULL OR "demonstration_trajectories"."learning_state" IN ('assigned', 'unassigned', 'missing', 'learning-off', 'unverified', 'unjoined'))
);
--> statement-breakpoint
CREATE TABLE "recorder_connect_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"via" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recorder_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"via" text NOT NULL,
	"extension_id" text NOT NULL,
	"install_id" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "recorder_connections_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "skill_share_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"skill_slug" text NOT NULL,
	"requested_by" text NOT NULL,
	"bot_name" text,
	"bot_title" text,
	"bot_role_description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_share_requests_kind_check" CHECK ("skill_share_requests"."kind" IN ('share', 'make_bot')),
	CONSTRAINT "skill_share_requests_status_check" CHECK ("skill_share_requests"."status" IN ('pending', 'approved', 'declined', 'superseded')),
	CONSTRAINT "skill_share_requests_bot_check" CHECK (("skill_share_requests"."kind" = 'make_bot') = ("skill_share_requests"."bot_name" IS NOT NULL AND "skill_share_requests"."bot_title" IS NOT NULL AND "skill_share_requests"."bot_role_description" IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "demonstrations_active_bot_idx";--> statement-breakpoint
ALTER TABLE "demonstrations" ADD COLUMN "source" text DEFAULT 'computer' NOT NULL;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD COLUMN "step_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "demonstration_media" ADD CONSTRAINT "demonstration_media_demonstration_id_demonstrations_id_fk" FOREIGN KEY ("demonstration_id") REFERENCES "public"."demonstrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstration_media" ADD CONSTRAINT "demonstration_media_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstration_media_chunks" ADD CONSTRAINT "demonstration_media_chunks_media_id_demonstration_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."demonstration_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstration_steps" ADD CONSTRAINT "demonstration_steps_demonstration_id_demonstrations_id_fk" FOREIGN KEY ("demonstration_id") REFERENCES "public"."demonstrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstration_trajectories" ADD CONSTRAINT "demonstration_trajectories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstration_trajectories" ADD CONSTRAINT "demonstration_trajectories_demonstration_fk" FOREIGN KEY ("demonstration_id") REFERENCES "public"."demonstrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_connect_codes" ADD CONSTRAINT "recorder_connect_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_connections" ADD CONSTRAINT "recorder_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_requests" ADD CONSTRAINT "skill_share_requests_skill_slug_skills_slug_fk" FOREIGN KEY ("skill_slug") REFERENCES "public"."skills"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_requests" ADD CONSTRAINT "skill_share_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_requests" ADD CONSTRAINT "skill_share_requests_created_bot_id_agents_id_fk" FOREIGN KEY ("created_bot_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demonstration_media_demonstration_idx" ON "demonstration_media" USING btree ("demonstration_id");--> statement-breakpoint
CREATE INDEX "demonstration_trajectories_demonstration_idx" ON "demonstration_trajectories" USING btree ("demonstration_id");--> statement-breakpoint
CREATE INDEX "recorder_connect_codes_user_idx" ON "recorder_connect_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recorder_connections_user_idx" ON "recorder_connections" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recorder_connections_live_install_idx" ON "recorder_connections" USING btree ("user_id","install_id") WHERE "recorder_connections"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_share_requests_pending_idx" ON "skill_share_requests" USING btree ("kind","skill_slug") WHERE "skill_share_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "skill_share_requests_status_idx" ON "skill_share_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "skill_share_requests_requested_by_idx" ON "skill_share_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "demonstrations_active_extension_idx" ON "demonstrations" USING btree ("owner_user_id","bot_id") WHERE "demonstrations"."status" = 'recording' and "demonstrations"."source" = 'extension';--> statement-breakpoint
CREATE UNIQUE INDEX "demonstrations_active_bot_idx" ON "demonstrations" USING btree ("bot_id") WHERE "demonstrations"."status" = 'recording' and "demonstrations"."source" = 'computer';