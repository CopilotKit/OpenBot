DELETE FROM "plugin_grants" AS g
WHERE g."kind" = 'skill'
  AND NOT EXISTS (
    SELECT 1 FROM "skills" AS s WHERE s."slug" = g."ref"
  );
