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
--> statement-breakpoint
-- A record waiting in the outbox is the audit trail, not yet sent: it can be sent and then deleted,
-- or set aside as refused, but never rewritten. The same rule `audit_events` has always had, on the
-- row before it reaches Intelligence (whose own trail refuses every change).
CREATE OR REPLACE FUNCTION prevent_audit_outbox_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Answered first: a statement trigger has no OLD row to compare.
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Audit records are append-only: the outbox cannot be emptied, only drained';
  END IF;
  IF NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.record IS DISTINCT FROM OLD.record THEN
    RAISE EXCEPTION 'Audit records are append-only: a record waiting to be sent cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_outbox_append_only ON audit_outbox;
--> statement-breakpoint
CREATE TRIGGER audit_outbox_append_only
BEFORE UPDATE ON audit_outbox
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_outbox_rewrite();
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_outbox_no_truncate ON audit_outbox;
--> statement-breakpoint
CREATE TRIGGER audit_outbox_no_truncate
BEFORE TRUNCATE ON audit_outbox
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_outbox_rewrite();
