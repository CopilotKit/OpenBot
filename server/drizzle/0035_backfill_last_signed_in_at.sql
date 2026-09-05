UPDATE "users" AS u
SET "last_signed_in_at" = s."last_created"
FROM (
  SELECT "user_id", max("created_at") AS "last_created"
  FROM "sessions"
  GROUP BY "user_id"
) AS s
WHERE s."user_id" = u."id"
  AND u."last_signed_in_at" IS NULL;
