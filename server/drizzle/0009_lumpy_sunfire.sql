-- A pointer to a credential that does not exist is cleared before the key is added.
--
-- Hand-written, because a generator cannot know this. `credential_id` was `text` against a `uuid`
-- primary key with no foreign key, so a deployment is allowed to be holding a pointer to a row that
-- was deleted underneath it — which is the bug this migration exists to make impossible, and which
-- has happened. Adding the constraint on top of one of those rows fails, so the deployment that most
-- needs this migration would be the one that could not run it.
--
-- Cleared rather than repaired: there is nothing to repair to. A pointer to nothing is not a
-- credential, and null is what this column already means by "this server has none" — so the
-- connector correctly reports that no credential is registered, instead of looking configured and
-- failing at the vendor. An administrator registers it again, which is the only way back anyway.
--
-- Anything that is not a uuid at all is cleared too. The old type permitted it, so no deployment can
-- promise otherwise, and the cast below would fail on it.
UPDATE "mcp_servers" SET "credential_id" = NULL
WHERE "credential_id" IS NOT NULL
  AND (
    "credential_id" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR NOT EXISTS (
      SELECT 1 FROM "credentials" WHERE "credentials"."id" = "mcp_servers"."credential_id"::uuid
    )
  );--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "credential_id" SET DATA TYPE uuid USING "credential_id"::uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
