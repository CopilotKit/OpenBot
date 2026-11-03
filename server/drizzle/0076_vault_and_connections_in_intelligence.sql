CREATE TABLE "secret_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" text,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_lists" (
	"server_id" text PRIMARY KEY NOT NULL,
	"refreshed_at" timestamp with time zone,
	"last_error" text,
	"skipped_tools" text[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tools" DROP CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_authorizations" DROP CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" DROP CONSTRAINT "responsibility_source_bindings_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "responsibility_triggers" DROP CONSTRAINT "responsibility_triggers_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_approvals" DROP CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_requests" DROP CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "identity_links" DROP CONSTRAINT "identity_links_credential_id_credentials_id_fk";
--> statement-breakpoint
-- The tool list status that lived on mcp_servers carries over: apps move to Intelligence, and
-- mcp_servers is no longer written, but what this deployment's cache last saw stays here with mcp_tools.
INSERT INTO "mcp_tool_lists" ("server_id", "refreshed_at", "last_error", "skipped_tools")
SELECT "id", "tools_refreshed_at", "last_error", "skipped_tools" FROM "mcp_servers"
ON CONFLICT ("server_id") DO NOTHING;
