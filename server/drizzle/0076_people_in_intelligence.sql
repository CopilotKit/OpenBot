-- People move into Intelligence's organization directory (server/src/people/directory). `users` stays,
-- as this deployment's projection of it: about 56 tables keep their foreign key to it, and the guard
-- reads a person's role from it on every request.
--
-- `role` takes over from `user_roles`, which is no longer written and is kept for one release.
-- `directory_version` is the directory version a row reflects; null marks a row the directory has not
-- acknowledged, which is every existing row: the boot-time copy (people/directory/upgrade.ts) pushes
-- them all, with the role copied here. `revoked_access`, `identity_links` and the descriptions in
-- `sso_providers` are copied by the same step and are no longer written (an identity provider's secret
-- stays in `sso_providers`).
ALTER TABLE "users" ADD COLUMN "role" role;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_version" integer;--> statement-breakpoint
-- `admin` wins, as the request guard always read the set.
UPDATE "users" AS u
   SET "role" = CASE
     WHEN EXISTS (SELECT 1 FROM "user_roles" r WHERE r."user_id" = u."id" AND r."role" = 'admin') THEN 'admin'::"role"
     WHEN EXISTS (SELECT 1 FROM "user_roles" r WHERE r."user_id" = u."id" AND r."role" = 'user') THEN 'user'::"role"
   END
 WHERE u."role" IS NULL;
