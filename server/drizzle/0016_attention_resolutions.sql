CREATE TABLE "attention_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_event_id" uuid NOT NULL,
	"resolved_by" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attention_resolutions_event_idx" ON "attention_resolutions" USING btree ("audit_event_id");