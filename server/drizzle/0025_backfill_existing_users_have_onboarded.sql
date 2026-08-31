-- Everybody who exists before this migration has already been using the product, and the wizard
-- behind the new gate teaches nothing they need. A null completion is what sends a person to
-- /onboarding, so anyone here when the column arrives is stamped as done and only people who sign
-- in for the first time from now on see it.
--
-- Written through `drizzle-kit generate --custom`, like 0003: "the people who already exist have
-- onboarded" is a fact about rows, not about the schema, so no diff can produce it.
UPDATE "users"
SET "onboarding_completed_at" = now()
WHERE "onboarding_completed_at" IS NULL;
