CREATE TABLE "app_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"agent_id" text,
	"app_key" text NOT NULL,
	"app_title" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "app_access_requests_kind_check" CHECK ("app_access_requests"."kind" IN ('enable', 'grant', 'connect_shared')),
	CONSTRAINT "app_access_requests_status_check" CHECK ("app_access_requests"."status" IN ('pending', 'approved', 'dismissed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_requests_pending_idx" ON "app_access_requests" USING btree ("requested_by","app_key",coalesce("agent_id", ''),"kind") WHERE "app_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "app_access_requests_status_idx" ON "app_access_requests" USING btree ("status","app_key");