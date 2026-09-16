DELETE FROM "plugin_grants" AS g
WHERE g."kind" = 'mcp'
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_servers" AS s WHERE s."id" = split_part(g."ref", '/', 1)
  );
