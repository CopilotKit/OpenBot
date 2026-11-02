CREATE TABLE "pending_authorizations" (
	"actor_id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"action" text NOT NULL,
	"holder" text NOT NULL,
	"user_id" text,
	"vendor_user_id" text NOT NULL,
	"auth_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "pending_authorizations_holder_check" CHECK (("pending_authorizations"."holder" = 'person' AND "pending_authorizations"."user_id" IS NOT NULL) OR ("pending_authorizations"."holder" = 'deployment' AND "pending_authorizations"."user_id" IS NULL)),
	CONSTRAINT "pending_authorizations_outcome_check" CHECK ("pending_authorizations"."outcome" IS NULL OR "pending_authorizations"."outcome" IN ('completed', 'failed', 'unreconciled', 'withdrawn')),
	CONSTRAINT "pending_authorizations_completion_check" CHECK (("pending_authorizations"."completed_at" IS NULL) = ("pending_authorizations"."outcome" IS NULL)),
	CONSTRAINT "pending_authorizations_user_is_actor_check" CHECK ("pending_authorizations"."user_id" IS NULL OR "pending_authorizations"."user_id" = "pending_authorizations"."actor_id")
);
--> statement-breakpoint
ALTER TABLE "brokered_connections" DROP CONSTRAINT "brokered_connections_provider_check";--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "vendor_name" text;--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_authorizations_server_idx" ON "pending_authorizations" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "brokered_connections" ADD CONSTRAINT "brokered_connections_provider_check" CHECK ("brokered_connections"."provider" IN ('composio', 'arcade'));