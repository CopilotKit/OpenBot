CREATE TABLE "composio_connections" (
	"toolkit" text NOT NULL,
	"user_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_connections_toolkit_user_id_pk" PRIMARY KEY("toolkit","user_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "effect" text;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "destructive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "version" text;--> statement-breakpoint
CREATE INDEX "composio_connections_user_idx" ON "composio_connections" USING btree ("user_id");