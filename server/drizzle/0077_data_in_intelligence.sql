-- OpenBot's data moves into Intelligence, cluster by cluster: Bot configuration, organization policy,
-- secrets, apps and connections, files and memory, the audit trail and schedules, conversations and
-- delivery, and people. One migration for all of them; the parts drizzle-kit cannot write follow its
-- statements.
--
-- Foreign keys to tables whose rows now live in Intelligence (`channels`, `mcp_servers`,
-- `credentials`, `deployment_packages`, `proactive_suggestions`) are dropped: those tables are kept for
-- one release, written by nothing, so an upgrading deployment still has the rows to copy.
--
-- People: `users` stays as this deployment's projection of Intelligence's organization directory
-- (people/directory). `role` takes over from `user_roles`, which is no longer written;
-- `directory_version` is the directory version a row last reflected (null: never in Intelligence) and
-- `directory_pending` marks a change Intelligence has not acknowledged, which is every existing row: the
-- boot-time copy (people/directory/upgrade.ts) pushes them all, with the role copied below.
-- `directory_binding` records which Intelligence project the people belong to, and
-- `directory_removal_reactions` which SCIM deprovisions have been acted on.
--
-- Operational tables that stay here: `secret_leases` (who is spending a vault secret right now),
-- `mcp_tool_lists` (how an app's tool list last refreshed, beside `mcp_tools`), `audit_outbox` (audit
-- records waiting to be sent to Intelligence), `computer_activity` (the idle culler's bookmark),
-- `local_locks` (named leases across replicas) and `intelligence_copy_progress` (where a long upgrade
-- copy got to).
CREATE TABLE "directory_binding" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_binding_singleton" CHECK ("directory_binding"."singleton")
);
--> statement-breakpoint
CREATE TABLE "directory_removal_reactions" (
	"email" text PRIMARY KEY NOT NULL,
	"removed_at" timestamp with time zone NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" text,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer
);
--> statement-breakpoint
CREATE TABLE "intelligence_copy_progress" (
	"name" text PRIMARY KEY NOT NULL,
	"after_created_at" timestamp with time zone,
	"after_id" uuid,
	"copied" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "local_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_package_id_deployment_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_tools" DROP CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_authorizations" DROP CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" DROP CONSTRAINT "responsibility_source_bindings_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "responsibility_triggers" DROP CONSTRAINT "responsibility_triggers_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_tasks" DROP CONSTRAINT "bot_tasks_suggestion_id_proactive_suggestions_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_bindings" DROP CONSTRAINT "delivery_bindings_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_challenges" DROP CONSTRAINT "delivery_challenges_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_inbox" DROP CONSTRAINT "delivery_inbox_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_outbox" DROP CONSTRAINT "delivery_outbox_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_approvals" DROP CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_requests" DROP CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk";
--> statement-breakpoint
ALTER TABLE "identity_links" DROP CONSTRAINT "identity_links_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "role";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_pending" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_outbox_pending_idx" ON "audit_outbox" USING btree ("seq") WHERE "audit_outbox"."refused_at" IS NULL;

--> statement-breakpoint
-- `admin` wins, as the request guard always read the set.
UPDATE "users" AS u
   SET "role" = CASE
     WHEN EXISTS (SELECT 1 FROM "user_roles" r WHERE r."user_id" = u."id" AND r."role" = 'admin') THEN 'admin'::"role"
     WHEN EXISTS (SELECT 1 FROM "user_roles" r WHERE r."user_id" = u."id" AND r."role" = 'user') THEN 'user'::"role"
   END
 WHERE u."role" IS NULL;
--> statement-breakpoint
-- The tool list status that lived on mcp_servers carries over: apps move to Intelligence, and
-- mcp_servers is no longer written, but what this deployment's cache last saw stays here with mcp_tools.
INSERT INTO "mcp_tool_lists" ("server_id", "refreshed_at", "last_error", "skipped_tools")
SELECT "id", "tools_refreshed_at", "last_error", "skipped_tools" FROM "mcp_servers"
ON CONFLICT ("server_id") DO NOTHING;
--> statement-breakpoint
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
