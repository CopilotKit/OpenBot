-- Better Auth 1.7 requires an issuer on every account: `providerId` alone stopped being enough once
-- a deployment can register more than one OIDC provider, because two companies' Okta tenants are
-- both "okta" and are not the same directory.
--
-- Three statements rather than the one Drizzle generates. `ADD COLUMN ... NOT NULL` with no default
-- fails outright on a table that already has rows, and every deployment that has ever signed
-- somebody in has rows here.
ALTER TABLE "accounts" ADD COLUMN "issuer" text;--> statement-breakpoint

-- What each existing account's provider calls itself. Google's real issuer, because a row backfilled
-- with anything else stops matching at the next sign-in and Better Auth creates a second account for
-- the same person. Anything else gets the synthetic form Better Auth mints for a provider with no
-- issuer of its own, which is the same string it would have written itself.
UPDATE "accounts"
SET "issuer" = CASE
  WHEN "provider_id" = 'google' THEN 'https://accounts.google.com'
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;
