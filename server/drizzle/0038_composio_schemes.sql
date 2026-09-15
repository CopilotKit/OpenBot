ALTER TABLE "mcp_servers" ADD COLUMN "auth_scheme" text;--> statement-breakpoint
UPDATE "mcp_servers" SET "auth_scheme" = 'OAUTH2' WHERE "provenance" = 'composio' AND "auth_scheme" IS NULL;--> statement-breakpoint
ALTER TABLE "composio_connections" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "composio_connections" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "composio_connections" SET "verified" = true, "verified_at" = "connected_at";
