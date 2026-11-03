CREATE TABLE "intelligence_copy_progress" (
	"name" text PRIMARY KEY NOT NULL,
	"after_created_at" timestamp with time zone,
	"after_id" uuid,
	"copied" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record" jsonb NOT NULL,
	"refused_at" timestamp with time zone,
	"refusal" text,
	CONSTRAINT "audit_outbox_kind_check" CHECK ("audit_outbox"."kind" IN ('event', 'action', 'usage'))
);
--> statement-breakpoint
CREATE TABLE "computer_activity" (
	"computer" text PRIMARY KEY NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_outbox_pending_idx" ON "audit_outbox" USING btree ("seq") WHERE "audit_outbox"."refused_at" IS NULL;--> statement-breakpoint
-- Seed the culler's bookmark from the trail it used to read, once, so a computer somebody used an hour
-- before the upgrade is not read as idle since it started. The trail is append-only and keeps being
-- read by the copy into Intelligence; this only reads it.
INSERT INTO "computer_activity" ("computer", "last_active_at")
SELECT coalesce("payload"->>'computer', 'bot:' || ("payload"->>'bot')) AS "computer", max("created_at")
FROM "audit_events"
WHERE "event_type" LIKE 'computer.%'
  AND coalesce("payload"->>'computer', 'bot:' || ("payload"->>'bot')) IS NOT NULL
GROUP BY 1
ON CONFLICT ("computer") DO NOTHING;
