-- Give every account that already exists the issuer Better Auth 1.7 now requires.
--
-- Written rather than generated, through `drizzle-kit generate --custom`, which is Drizzle's own
-- mechanism for exactly this. A generator diffs schema against schema, and "the rows whose provider
-- is Google get Google's issuer" is not in the schema, so no diff can produce it. The two steps
-- either side of this one are generated and their snapshots track real states.
--
-- The generatable alternative is a column default, and it is wrong: every existing Google account
-- would take the placeholder, stop matching `https://accounts.google.com` at that person's next
-- sign-in, and Better Auth would create a second account for the same person. A tidier file is not
-- worth that.
--
-- Anything that is not Google or a local credential gets the synthetic form Better Auth mints for a
-- provider with no issuer of its own, which is the same string it would have written itself.
UPDATE "accounts"
SET "issuer" = CASE
  WHEN "provider_id" = 'google' THEN 'https://accounts.google.com'
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;
