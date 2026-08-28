-- One live credential per (kind, provider, key_id).
--
-- A database that ran the rotation this repository shipped before may already
-- hold more than one, because that rotation inserted the new credential and
-- then revoked the previous one as two separate statements: when the revoke
-- failed the caller saw an error and wrote nothing further, so the new row was
-- left live and nothing was repointed at it. CREATE UNIQUE INDEX would fail
-- outright on those rows, so they are reconciled first.
--
-- Which duplicate survives matters, and the newest is the wrong answer. In the
-- failure above it is the new row that nothing references, while the older one
-- is still named by the MCP server, the connection or the agent that was using
-- it. Keeping the newest would revoke the credential actually in use and leave
-- the deployment authenticating with nothing. So a referenced row wins, and
-- only where nothing is referenced does the newest win.
--
-- The three tables below are every one that names a credential: `mcp_servers`
-- for a server's own token and OAuth client, `mcp_user_credentials` for one
-- person's connection to a server, and an agent's `configuration`. The old
-- connector tables named one too and were dropped in `0011`.
--
-- On a database with no duplicates this rewrites no rows.
WITH referenced AS (
  SELECT "credential_id"::text AS "id"
    FROM "mcp_servers"
   WHERE "credential_id" IS NOT NULL
   UNION
  SELECT "credential_id"::text
    FROM "mcp_user_credentials"
   WHERE "credential_id" IS NOT NULL
   UNION
  SELECT "configuration" -> 'auth' ->> 'credentialId'
    FROM "agents"
   WHERE "configuration" -> 'auth' ->> 'credentialId' IS NOT NULL
),
ranked AS (
  SELECT c."id",
         row_number() OVER (
           PARTITION BY c."kind", c."provider", c."key_id"
           ORDER BY (r."id" IS NOT NULL) DESC, c."created_at" DESC, c."id" DESC
         ) AS "rank"
    FROM "credentials" c
    LEFT JOIN referenced r ON r."id" = c."id"::text
   WHERE c."revoked_at" IS NULL
)
UPDATE "credentials" AS c
   SET "revoked_at" = now(),
       "updated_at" = now()
  FROM ranked
 WHERE ranked."id" = c."id"
   AND ranked."rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_active_key_idx" ON "credentials" USING btree ("kind","provider","key_id") WHERE "credentials"."revoked_at" IS NULL;
