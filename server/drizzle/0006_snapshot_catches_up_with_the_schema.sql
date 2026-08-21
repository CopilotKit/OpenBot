-- No-op DDL. This migration exists to bring `meta/0005_snapshot.json` back into agreement with
-- `core.ts`, not to change any database.
--
-- Two fields moved in #87 and the snapshot was not regenerated, so `drizzle-kit generate` kept
-- emitting these statements and the `migrations` drift probe kept failing on the dirty tree. The
-- snapshot describes a state no deployment is in:
--
--   * `accounts.issuer` is absent from `0000_schema.sql`, added nullable by `0002_sign_in.sql`, and
--     filled by `0003_backfill_account_issuer.sql`. `SET NOT NULL` was never applied, so dropping it
--     here drops a constraint that does not exist.
--   * `0004_identity_provider_outlives_its_registrar.sql` already dropped and re-added the
--     `sso_providers` foreign key with `ON DELETE set null`. Re-landing it here lands it on the
--     constraint it already has.
--
-- Nothing to look for behind these three lines: no schema change was intended and none happens.

ALTER TABLE "sso_providers" DROP CONSTRAINT "sso_providers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;