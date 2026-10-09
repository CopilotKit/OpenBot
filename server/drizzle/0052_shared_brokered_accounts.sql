CREATE TABLE "brokered_connections" (
	"provider" text NOT NULL,
	"app" text NOT NULL,
	"holder" text NOT NULL,
	"user_id" text,
	"vendor_user_id" text NOT NULL,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"probe_action" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokered_connections_holder_check" CHECK (("brokered_connections"."holder" = 'person' AND "brokered_connections"."user_id" IS NOT NULL) OR ("brokered_connections"."holder" = 'deployment' AND "brokered_connections"."user_id" IS NULL)),
	CONSTRAINT "brokered_connections_provider_check" CHECK ("brokered_connections"."provider" IN ('composio'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_approval_members" (
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "shared_use_approval_members_agent_id_server_id_kind_value_pk" PRIMARY KEY("agent_id","server_id","kind","value"),
	CONSTRAINT "shared_use_approval_members_kind_check" CHECK ("shared_use_approval_members"."kind" IN ('user', 'group'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_approvals" (
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"audience" text NOT NULL,
	"outside_input" boolean NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_use_approvals_agent_id_server_id_pk" PRIMARY KEY("agent_id","server_id"),
	CONSTRAINT "shared_use_approvals_audience_check" CHECK ("shared_use_approvals"."audience" IN ('owner', 'people', 'team'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"proposed_audience" text NOT NULL,
	"proposed_outside_input" boolean NOT NULL,
	"proposed_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_use_requests_audience_check" CHECK ("shared_use_requests"."proposed_audience" IN ('owner', 'people', 'team')),
	CONSTRAINT "shared_use_requests_reason_check" CHECK ("shared_use_requests"."reason" IN ('publish', 'trigger', 'grant', 'refused_call')),
	CONSTRAINT "shared_use_requests_status_check" CHECK ("shared_use_requests"."status" IN ('pending', 'approved', 'declined', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "account_mode" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "shared_vendor_user_id" text;--> statement-breakpoint
ALTER TABLE "shared_use_approval_members" ADD CONSTRAINT "shared_use_approval_members_approval_fk" FOREIGN KEY ("agent_id","server_id") REFERENCES "public"."shared_use_approvals"("agent_id","server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_connections_person_idx" ON "brokered_connections" USING btree ("provider","app","user_id") WHERE "brokered_connections"."holder" = 'person';--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_connections_deployment_idx" ON "brokered_connections" USING btree ("provider","app") WHERE "brokered_connections"."holder" = 'deployment';--> statement-breakpoint
CREATE INDEX "brokered_connections_user_idx" ON "brokered_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_use_requests_pending_idx" ON "shared_use_requests" USING btree ("agent_id","server_id") WHERE "shared_use_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "shared_use_requests_status_idx" ON "shared_use_requests" USING btree ("status");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_account_mode_check" CHECK ("mcp_servers"."account_mode" IS NULL OR "mcp_servers"."account_mode" IN ('personal', 'shared'));
--> statement-breakpoint
INSERT INTO "brokered_connections" ("provider", "app", "holder", "user_id", "vendor_user_id", "connected_at", "verified", "verified_at", "probe_action", "updated_at")
SELECT 'composio', "toolkit", 'person', "user_id", "user_id", "connected_at", "verified", "verified_at", "probe_action", "updated_at"
FROM "composio_connections";--> statement-breakpoint
UPDATE "mcp_servers" SET "account_mode" = 'personal'
WHERE "provenance" = 'composio' AND ("auth_scheme" IS NULL OR "auth_scheme" <> 'NO_AUTH');
