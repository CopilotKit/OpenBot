ALTER TABLE "mcp_servers" ADD COLUMN "owner_grants" text;--> statement-breakpoint
ALTER TABLE "plugin_grants" ADD COLUMN "granted_as" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_grants_check" CHECK ("mcp_servers"."owner_grants" IS NULL OR "mcp_servers"."owner_grants" IN ('any', 'admin'));--> statement-breakpoint
ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_granted_as_check" CHECK ("plugin_grants"."granted_as" IS NULL OR "plugin_grants"."granted_as" IN ('admin', 'owner'));