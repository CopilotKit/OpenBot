CREATE TYPE "public"."handoff_attachment_state" AS ENUM('copied', 'transferred', 'failed', 'rejected', 'expired', 'deleted');--> statement-breakpoint
CREATE TABLE "handoff_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"handoff_id" text NOT NULL,
	"from_bot_id" text NOT NULL,
	"recipient_bot_id" text NOT NULL,
	"path" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"state" "handoff_attachment_state" DEFAULT 'copied' NOT NULL,
	"external_transfer_id" text,
	"result_reference" text,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoff_attachments" ADD CONSTRAINT "handoff_attachments_from_bot_id_agents_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_attachments" ADD CONSTRAINT "handoff_attachments_recipient_bot_id_agents_id_fk" FOREIGN KEY ("recipient_bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_attachments_handoff_hash_recipient_uidx" ON "handoff_attachments" USING btree ("handoff_id","sha256","recipient_bot_id");--> statement-breakpoint
CREATE INDEX "handoff_attachments_state_expiry_idx" ON "handoff_attachments" USING btree ("state","expires_at");
